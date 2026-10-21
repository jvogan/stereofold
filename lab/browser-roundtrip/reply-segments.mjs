/**
 * Play a long reply as consecutive segments, one at a time.
 *
 * `say_to_headset` used to stop at the first thirty-six words. It no longer
 * does: the Mac splits a long answer at its own sentence boundaries, renders
 * each segment separately, and sends them all on one caption. This module is
 * the wearer's end of that. It owns the order, so that
 *
 * - the segments are played in the order the Mac produced them,
 * - no two segments are ever in the air at once, because the next one starts
 *   only when the previous one has finished, and
 * - the caption on the status row is the segment that is sounding, not the
 *   whole paragraph and not the one before it.
 *
 * A newer reply takes the row from an older one. Whatever of the older answer
 * had not started is dropped rather than queued behind the new one, and the
 * count is written to the diagnostics ring so a wearer who heard half an
 * answer can be told from the Mac which half it was.
 *
 * It knows nothing about audio. `play` is injected, returns a promise that
 * settles when that segment has finished sounding, and answers false when the
 * segment carried nothing to play — in which case the caption is held for the
 * segment's own length instead, so a reply with no clips still reads in order.
 */

/** Dispatched as each segment takes the caption row. The page draws its text. */
export const REPLY_SEGMENT_EVENT = 'stereofold-headset-reply-segment';
/** How long a segment with no sound holds the row when it names no length. */
export const REPLY_SEGMENT_SILENT_HOLD_SECONDS = 4;
/** No single segment may hold the row longer than this, whatever it claims. */
export const REPLY_SEGMENT_MAX_HOLD_SECONDS = 20;
/** More segments than one reply can carry; a caption past this is not trusted. */
export const REPLY_SEGMENT_LIMIT = 32;

function record(scope, kind, detail) {
  try { return scope?.__stereofoldDiagnostics?.record?.(kind, detail) ?? null; }
  catch { return null; }
}

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function secondsOf(value) {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * One reply as the ordered segments to play.
 *
 * A caption from a Mac that predates segments carries only `text` and `audio`,
 * and reads back as the single segment it always was, so the same player runs
 * both. A reply the agent asked to keep silent yields nothing.
 */
export function replySegmentsOf(caption) {
  if (!caption || typeof caption !== 'object' || caption.speak === false) return [];
  const listed = Array.isArray(caption.segments) ? caption.segments : undefined;
  if (listed && listed.length) {
    const segments = [];
    for (const entry of listed.slice(0, REPLY_SEGMENT_LIMIT)) {
      const text = textOf(entry?.text);
      if (!text) continue;
      segments.push({ index: segments.length, text,
        ...(entry?.audio ? { audio: entry.audio } : {}),
        ...(secondsOf(entry?.seconds) ? { seconds: entry.seconds } : {}) });
    }
    if (segments.length) return segments;
  }
  const text = textOf(caption.text);
  if (!text) return [];
  return [{ index: 0, text, ...(caption.audio ? { audio: caption.audio } : {}) }];
}

/** How long a segment that made no sound should hold the caption row. */
export function replySegmentHoldSeconds(segment, caption) {
  const named = secondsOf(segment?.seconds) ?? secondsOf(caption?.holdSeconds) ?? REPLY_SEGMENT_SILENT_HOLD_SECONDS;
  return Math.min(REPLY_SEGMENT_MAX_HOLD_SECONDS, Math.max(0, named));
}

/**
 * How long the wearer's plate must hold this segment, in milliseconds.
 *
 * Not the same question as `replySegmentHoldSeconds`, which decides when a
 * silent segment gives the row up to the next one. This is how long the words
 * have to stay readable, and a segment that is sounding has to satisfy both:
 * the length the Mac asked for on the caption (`holdSeconds`, 2-15, default 6)
 * and the length the clip actually runs. A reply sounded for
 * 7.05 s behind a plate that came down at 3.08 s.
 */
export function replyCaptionHoldMs(segment, caption) {
  const sounding = secondsOf(segment?.seconds) ?? 0;
  const asked = secondsOf(caption?.holdSeconds) ?? REPLY_SEGMENT_SILENT_HOLD_SECONDS;
  return Math.min(REPLY_SEGMENT_MAX_HOLD_SECONDS, Math.max(sounding, asked)) * 1000;
}

/**
 * The player. `start` drops whatever is running and begins the new reply.
 *
 * Every hook is optional and every hook is wrapped: a page that draws no
 * caption still hears the segments in order, and a `show` that throws costs
 * the wearer one caption rather than the rest of the answer.
 */
export function createReplySegmentPlayer(options = {}) {
  const scope = options.scope ?? globalThis;
  const events = options.target ?? scope;
  const play = typeof options.play === 'function' ? options.play : undefined;
  const show = typeof options.show === 'function' ? options.show : undefined;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (handle => clearTimeout(handle));
  let generation = 0;
  let active;
  let timer;
  let stopped = false;
  let pending = [];

  const clearHold = () => {
    if (timer === undefined) return;
    try { clearTimer(timer); } catch { /* A timer already fired cannot be cleared twice. */ }
    timer = undefined;
  };

  const hold = seconds => new Promise(resolve => {
    if (!(seconds > 0)) { resolve(); return; }
    // Declared first: an injected timer that fires straight away would reach
    // this callback before a `const` binding existed.
    let handle;
    handle = setTimer(() => { if (timer === handle) timer = undefined; resolve(); }, Math.round(seconds * 1000));
    timer = handle;
    handle?.unref?.();
  });

  const announce = (segment, caption, total) => {
    try { show?.(segment.text, segment, caption); }
    catch { /* One caption the page refused to draw must not stop the rest. */ }
    // `holdSeconds` rides with every segment, not just the first: the page
    // draws each one as it starts, and each has to stay readable for the
    // window the Mac asked for rather than for a control-feedback flash.
    const detail = { captionId: caption?.id, index: segment.index, total, text: segment.text,
      audible: Boolean(segment.audio), ...(secondsOf(segment.seconds) ? { seconds: segment.seconds } : {}),
      ...(secondsOf(caption?.holdSeconds) ? { holdSeconds: caption.holdSeconds } : {}) };
    try {
      const Event = scope?.CustomEvent ?? (typeof CustomEvent === 'function' ? CustomEvent : undefined);
      events?.dispatchEvent?.(Event ? new Event(REPLY_SEGMENT_EVENT, { detail })
        : { type: REPLY_SEGMENT_EVENT, detail });
    } catch { /* A page with no event target still gets the `show` hook above. */ }
  };

  /** Abandon the running reply. Returns how many of its segments never started. */
  const drop = reason => {
    const queued = pending.reduce((count, batch) => count + batch[1].length, 0);
    pending = [];
    clearHold();
    if (!active) return 0;
    const { captionId, index } = active;
    const total = active.total + queued;
    active = undefined;
    generation++;
    const dropped = Math.max(0, total - index - 1);
    if (total > 1) record(scope, 'reply-segments-dropped', {
      ...(captionId ? { captionId } : {}), stoppedAt: index, dropped, total,
      reason: String(reason ?? 'replaced').slice(0, 32),
    });
    return dropped;
  };

  const run = async (caption, segments, context) => {
    const token = ++generation;
    const total = segments.length;
    active = { captionId: typeof caption?.id === 'string' ? caption.id : undefined, index: 0, total };
    if (total > 1) record(scope, 'reply-segments-start',
      { ...(active.captionId ? { captionId: active.captionId } : {}), segments: total });
    for (let index = 0; index < total; index++) {
      if (stopped || token !== generation) return;
      active.index = index;
      const segment = segments[index];
      announce(segment, caption, total);
      let played = false;
      if (play) {
        try { played = (await play(segment, caption, context, index)) === true; }
        catch { played = false; }
      }
      if (stopped || token !== generation) return;
      // A segment that made no sound still has to hold the row long enough to
      // be read, or a paragraph would flash past in a single frame.
      const moreComing = (caption?.voiceOffset ?? 0) + index + 1 < caption?.speechTotal;
      if (!played && (index < total - 1 || moreComing)) {
        await hold(replySegmentHoldSeconds(segment, caption));
        if (stopped || token !== generation) return;
      }
    }
    if (token !== generation) return;
    if (total > 1) record(scope, 'reply-segments-end',
      { ...(active?.captionId ? { captionId: active.captionId } : {}), segments: total });
    active = undefined;
    const next = pending.shift();
    if (next) void run(...next);
  };

  return {
    /** Begin one reply, dropping the tail of whatever was still running. */
    start(caption, segments, context) {
      if (stopped || !Array.isArray(segments) || !segments.length) return 0;
      const dropped = drop('replaced');
      void run(caption, segments, context);
      return dropped;
    },
    /** Continue the same reply without cutting off its current clip. */
    enqueue(caption, segments, context) {
      if (stopped || !Array.isArray(segments) || !segments.length) return;
      if (active) pending.push([caption, segments, context]);
      else void run(caption, segments, context);
    },
    drop,
    running() { return active ? { ...active } : undefined; },
    stop() {
      if (stopped) return;
      stopped = true;
      drop('stopped');
    },
  };
}
