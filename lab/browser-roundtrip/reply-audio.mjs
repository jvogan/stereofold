import { recordLoopStage } from './loop-timing.mjs';
import { createReplySegmentPlayer, replySegmentsOf } from './reply-segments.mjs';
/**
 * Make the agent's reply audible in a headset that has no voice.
 *
 * A real Quest 2 reports zero `speechSynthesis` voices, so the page's own
 * `speechSynthesis.speak` queues an utterance that never makes a sound. The Mac now
 * renders the same sentence with its own system voice and sends the clip
 * inline with the caption, on the heartbeat that already carries it. This
 * module is the other end of that: it listens for the reply event the panel
 * already dispatches, decodes the clip, and plays it through an AudioContext.
 *
 * It touches nothing else. The spatial toolbar is not imported, not edited
 * and not aware of it; the only coupling is the
 * `stereofold-headset-reply` event and the diagnostics buffer.
 *
 * Two browser rules shape the design:
 *
 * - Autoplay. An AudioContext created outside a user gesture starts suspended
 *   and stays silent. The context is therefore built on the first press
 *   anywhere on the page, which in practice is the Enter VR button, and
 *   resumed again before each clip.
 * - One voice at a time. The page speaks the caption synchronously inside the
 *   same event dispatch, so on a desktop browser that does have voices the
 *   wearer would hear the sentence twice. That utterance is captured for the
 *   length of the dispatch and either dropped, because the clip played, or
 *   handed back to the browser, because it did not.
 *
 * A long reply arrives as several clips on one caption. `reply-segments.mjs`
 * owns their order; this module plays one clip at a time and tells it when
 * that clip has finished, so nothing overlaps and the caption row keeps up.
 *
 * Every step records into `globalThis.__stereofoldDiagnostics`, so a silent
 * headset can be diagnosed from the Mac with `read_headset_log`.
 */

/** The event the panel dispatches for one caption. Must match the panel's. */
export const REPLY_AUDIO_EVENT = 'stereofold-headset-reply';
/** Presses that count as the gesture which unlocks audio. */
export const REPLY_AUDIO_GESTURES = Object.freeze(['pointerdown', 'mousedown', 'touchend', 'click', 'keydown']);
/** Largest clip this page will decode, so a malformed caption cannot exhaust memory. */
export const REPLY_AUDIO_MAX_BYTES = 2_000_000;
/** How many caption IDs are remembered, so a repeated heartbeat plays once. */
export const REPLY_AUDIO_SEEN_LIMIT = 64;
/** Margin past a clip's own length before its end is assumed. */
export const REPLY_AUDIO_END_GUARD_MS = 750;
/** Assumed length for a clip that names none, matching the encoder ceiling. */
export const REPLY_AUDIO_END_GUARD_SECONDS = 15;
/** No single segment holds the queue longer than this, whatever it claims. */
export const REPLY_AUDIO_MAX_END_WAIT_MS = 30_000;

function record(scope, kind, detail) {
  try { return scope?.__stereofoldDiagnostics?.record?.(kind, detail) ?? null; }
  catch { return null; }
}

function reasonOf(error) {
  const text = error?.name ? `${error.name}: ${error.message ?? ''}` : String(error?.message ?? error ?? 'unknown');
  return text.trim().slice(0, 120) || 'unknown';
}

const round = value => (Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined);

/** The clip on a caption, or undefined when the Mac could not render one. */
export function replyAudioClipFrom(caption) {
  const audio = caption?.audio;
  if (!audio || typeof audio !== 'object') return undefined;
  if (typeof audio.base64 !== 'string' || audio.base64.length < 4) return undefined;
  const mimeType = typeof audio.mimeType === 'string' && audio.mimeType ? audio.mimeType : 'audio/ogg';
  const bytes = Number.isFinite(audio.bytes) ? audio.bytes : Math.floor(audio.base64.length * 3 / 4);
  if (bytes > REPLY_AUDIO_MAX_BYTES) return undefined;
  return { base64: audio.base64, mimeType, bytes, format: typeof audio.format === 'string' ? audio.format : 'unknown' };
}

/** Base64 to bytes, without assuming a Buffer or a DOM. Undefined when it is not base64. */
export function decodeReplyAudioBase64(base64, scope = globalThis) {
  try {
    if (typeof scope?.atob === 'function') {
      const binary = scope.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    const buffer = scope?.Buffer ?? globalThis.Buffer;
    if (buffer) return new Uint8Array(buffer.from(base64, 'base64'));
  } catch { /* Falls through to undefined below. */ }
  return undefined;
}

/** `decodeAudioData` answers with a promise on modern builds and a callback on old ones. */
function decodeAudio(context, bytes) {
  return new Promise((resolve, reject) => {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const failed = error => { if (!settled) { settled = true; reject(error ?? Error('decode failed')); } };
    let pending;
    try { pending = context.decodeAudioData(arrayBuffer, done, failed); }
    catch (error) { failed(error); return; }
    if (pending && typeof pending.then === 'function') pending.then(done, failed);
  });
}

/**
 * The caption id on every record about one clip, or nothing when the reply
 * carried none.
 *
 * An empty object rather than `captionId: undefined` so a page on an older
 * queue writes the same record it always did, and a reader can tell "this
 * record predates ids" from "this record is about a different reply".
 */
function idOf(captionId) {
  return typeof captionId === 'string' && captionId ? { captionId } : {};
}

function defaultContextFactory(scope) {
  return () => {
    const Context = scope?.AudioContext ?? scope?.webkitAudioContext;
    if (typeof Context !== 'function') throw Error('This browser has no AudioContext.');
    return new Context();
  };
}

/**
 * Hold the page's utterance for the length of one event dispatch.
 *
 * The swap is synchronous and is undone on the next task, so nothing else on
 * the page can lose an utterance to it. `replay` hands the held utterance back
 * to the real `speak`, which is what happens when the clip fails to play.
 */
function captureSpeech(synth) {
  const inert = { held: false, replay: () => false, restore: () => {} };
  if (!synth || typeof synth.speak !== 'function') return inert;
  const original = synth.speak;
  let held;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { if (synth.speak === capture) synth.speak = original; }
    catch { /* A frozen speechSynthesis keeps the capture; the replay below still works. */ }
  };
  function capture(utterance) { held = utterance; }
  try { synth.speak = capture; }
  catch { return inert; }
  const timer = setTimeout(restore, 0);
  timer?.unref?.();
  return {
    get held() { return held !== undefined; },
    restore,
    replay() {
      restore();
      if (held === undefined) return false;
      const utterance = held;
      held = undefined;
      try { original.call(synth, utterance); return true; }
      catch { return false; }
    },
  };
}

/**
 * Listen for replies and play their audio. Returns a stop function.
 *
 * The controller is also published on `globalThis.__stereofoldReplyAudio`, so
 * a module that owns a button can call `unlock()` from its click handler
 * without importing anything.
 */
export function installReplyAudio(options = {}) {
  const scope = options.scope ?? globalThis;
  const events = options.target ?? scope;
  const makeContext = options.contextFactory ?? defaultContextFactory(scope);
  const gestureTargets = options.gestureTargets
    ?? [scope, scope?.document].filter(target => typeof target?.addEventListener === 'function');
  const synthOf = () => options.synth ?? scope?.speechSynthesis;
  const stops = [];
  const seen = new Set();
  let context;
  let playing;
  let finishPlaying;
  let stopped = false;
  let generation = 0;
  let replyRoot;
  let nextOffset = 0;

  const ensureContext = () => {
    if (context) return context;
    try { context = makeContext(); }
    catch (error) { record(scope, 'reply-audio-error', { stage: 'context', reason: reasonOf(error) }); context = undefined; }
    return context;
  };

  /**
   * Build or resume the context. Creating it inside the gesture is what
   * actually lifts the autoplay block on Chromium; resuming afterwards covers
   * a context the browser suspended when the page lost focus.
   */
  const unlock = via => {
    if (stopped) return false;
    const audio = ensureContext();
    if (!audio) return false;
    const before = String(audio.state ?? 'unknown');
    try { audio.resume?.(); } catch { /* A running context rejects resume on some builds. */ }
    record(scope, 'reply-audio-unlock', { via: String(via ?? 'call').slice(0, 24), state: before });
    return true;
  };

  for (const target of gestureTargets) {
    for (const type of REPLY_AUDIO_GESTURES) {
      const handler = () => { unlock(type); };
      try {
        target.addEventListener(type, handler, { capture: true, passive: true });
        stops.push(() => { try { target.removeEventListener(type, handler, { capture: true }); } catch { /* Already detached. */ } });
      } catch { /* A target that refuses one event still gets the others. */ }
    }
  }

  const settlePlaying = () => {
    const settle = finishPlaying;
    finishPlaying = undefined;
    if (settle) { try { settle(); } catch { /* The waiter is already gone. */ } }
  };

  const stopPlaying = () => {
    const source = playing;
    playing = undefined;
    if (source) {
      try { source.stop?.(); } catch { /* A source that already ended throws. */ }
      try { source.pause?.(); } catch { /* The element fallback stops this way. */ }
    }
    // Whoever was waiting for this clip to finish is waiting for a clip that
    // no longer exists, and must not be left holding the rest of the answer.
    settlePlaying();
  };

  /**
   * One clip's end, with a guard.
   *
   * The next segment starts when the browser says this one finished. A build
   * that never fires `ended` would stall the rest of the answer, so the clip's
   * own length plus a margin ends the wait regardless.
   */
  const endWatch = seconds => {
    let settle;
    let guard;
    const ended = new Promise(resolve => { settle = resolve; });
    const finish = () => {
      if (!settle) return;
      const resolve = settle;
      settle = undefined;
      if (guard !== undefined) { try { clearTimeout(guard); } catch { /* Already fired. */ } guard = undefined; }
      resolve();
    };
    const length = Number.isFinite(seconds) && seconds > 0 ? seconds : REPLY_AUDIO_END_GUARD_SECONDS;
    guard = setTimeout(finish, Math.min(Math.round(length * 1000) + REPLY_AUDIO_END_GUARD_MS, REPLY_AUDIO_MAX_END_WAIT_MS));
    guard?.unref?.();
    return { ended, finish };
  };

  /** Last resort inside the page: an audio element on a blob, then the browser's own voice. */
  const playThroughElement = async (clip, bytes, captured, captionId, timing, first) => {
    const token = generation;
    const Blob = scope?.Blob, URL = scope?.URL, Audio = options.Audio ?? scope?.Audio;
    if (typeof Blob !== 'function' || typeof Audio !== 'function' || typeof URL?.createObjectURL !== 'function') return false;
    let url;
    const watch = endWatch(clip.seconds);
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: clip.mimeType.split(';')[0] }));
      const element = new Audio(url);
      element.preload = 'auto';
      const release = () => { try { URL.revokeObjectURL(url); } catch { /* Already revoked. */ } };
      element.addEventListener?.('ended', () => { release(); record(scope, 'reply-audio-end', { via: 'element', ...idOf(captionId) }); watch.finish(); });
      element.addEventListener?.('error', () => { release(); record(scope, 'reply-audio-error', { stage: 'element', reason: 'media error', ...idOf(captionId) }); watch.finish(); });
      stopPlaying();
      playing = element;
      finishPlaying = watch.finish;
      await element.play();
      if (stopped || token !== generation) {
        element.pause?.(); release(); captured.restore(); watch.finish(); return { started: true, ended: watch.ended };
      }
      // `play()` resolving is the browser's own statement that this element is
      // producing sound, which is what `contextState` says for the other route.
      if (first) recordLoopStage('spoken-confirmation-started', timing, scope);
      record(scope, 'reply-audio-play', { via: 'element', bytes: clip.bytes, suppressed: Boolean(captured.held),
        started: true, contextState: String(context?.state ?? 'absent'), ...idOf(captionId) });
      return { started: true, ended: watch.ended };
    } catch (error) {
      try { if (url) URL.revokeObjectURL(url); } catch { /* Already revoked. */ }
      watch.finish();
      if (stopped || token !== generation) { captured.restore(); return { started: true, ended: watch.ended }; }
      record(scope, 'reply-audio-error', { stage: 'element', reason: reasonOf(error), ...idOf(captionId) });
      return false;
    }
  };

  const play = async (clip, captured, captionId, timing, first) => {
    const token = generation;
    record(scope, 'reply-audio-fetch', { bytes: clip.bytes, format: clip.format, inline: true, ...idOf(captionId) });
    const bytes = decodeReplyAudioBase64(clip.base64, scope);
    if (!bytes || !bytes.byteLength) {
      record(scope, 'reply-audio-error', { stage: 'base64', reason: 'clip was not decodable base64', ...idOf(captionId) });
      captured.replay();
      return false;
    }
    const audio = ensureContext();
    if (!audio || typeof audio.decodeAudioData !== 'function') {
      record(scope, 'reply-audio-error', { stage: 'context', reason: 'no AudioContext for this reply', ...idOf(captionId) });
      const fallback = await playThroughElement(clip, bytes, captured, captionId, timing, first);
      if (fallback) return fallback;
      captured.replay();
      return false;
    }
    try { if (audio.state === 'suspended') await audio.resume?.(); }
    catch { /* A context the browser will not resume still fails loudly below. */ }
    if (stopped || token !== generation) { captured.restore(); return false; }
    let buffer;
    try { buffer = await decodeAudio(audio, bytes); }
    catch (error) {
      if (stopped || token !== generation) { captured.restore(); return false; }
      record(scope, 'reply-audio-error', { stage: 'decode', reason: reasonOf(error), format: clip.format, ...idOf(captionId) });
      const fallback = await playThroughElement(clip, bytes, captured, captionId, timing, first);
      if (fallback) return fallback;
      captured.replay();
      return false;
    }
    if (stopped || token !== generation) { captured.restore(); return false; }
    try {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      const seconds = round(buffer.duration);
      const watch = endWatch(buffer.duration ?? clip.seconds);
      const ended = () => { if (playing === source) playing = undefined; record(scope, 'reply-audio-end', { seconds, via: 'context', ...idOf(captionId) }); watch.finish(); };
      if (typeof source.addEventListener === 'function') source.addEventListener('ended', ended);
      else source.onended = ended;
      // A new answer replaces the previous one rather than talking over it.
      stopPlaying();
      source.start(0);
      if (audio.state === 'running' && first) recordLoopStage('spoken-confirmation-started', timing, scope);
      playing = source;
      finishPlaying = watch.finish;
      record(scope, 'reply-audio-play', {
        via: 'context', bytes: clip.bytes, seconds, format: clip.format,
        rate: buffer.sampleRate, state: String(audio.state ?? 'unknown'),
        // `state` above is the historical field name and stays for the log
        // readers. `contextState` is the same reading under the name the
        // driver asserts on: `start(0)` is recorded even on a context the
        // browser left `suspended`, which is a play record with no sound, and
        // that is exactly what "the wearer heard it" must not be built on.
        contextState: String(audio.state ?? 'unknown'), started: true,
        // True when the page's own utterance was dropped in favour of this clip.
        suppressed: Boolean(captured.held),
        // Which reply this clip was. Without it a record left over from the
        // previous answer is indistinguishable from this one's, and a silent
        // turn reads as a spoken one.
        ...idOf(captionId),
      });
      return { started: true, ended: watch.ended };
    } catch (error) {
      record(scope, 'reply-audio-error', { stage: 'play', reason: reasonOf(error), ...idOf(captionId) });
      captured.replay();
      return false;
    }
  };

  /**
   * One reply's segments, in order, never overlapping.
   *
   * The sequencer owns the order and the caption row; this play hook owns one
   * clip. It answers true only once that clip has actually finished sounding,
   * which is what keeps the next segment from starting on top of it.
   */
  const segmentPlayer = createReplySegmentPlayer({
    scope, target: events,
    play: async (segment, caption, captured, index) => {
      if (stopped) return false;
      const clip = replyAudioClipFrom(segment);
      // A segment the Mac could not render is silent; the sequencer holds its
      // caption for its own length and moves on.
      if (!clip) return false;
      const id = typeof caption?.id === 'string' ? caption.id : undefined;
      // The page's held utterance belongs to the dispatch the reply arrived
      // on, so only the opening segment can give it back or drop it.
      const outcome = await play(clip, index === 0 ? captured : captureSpeech(undefined), id, caption, index === 0);
      if (!outcome) return false;
      await outcome.ended;
      return true;
    },
  });

  const onReply = event => {
    if (stopped) return;
    const caption = event?.detail;
    const segments = replySegmentsOf(caption);
    if (!segments.length && !(typeof caption?.text === 'string' && caption.text.trim())) return;
    const id = typeof caption?.id === 'string' ? caption.id : undefined;
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > REPLY_AUDIO_SEEN_LIMIT) seen.delete(seen.values().next().value);
    }
    const sounding = segments.some(segment => replyAudioClipFrom(segment));
    if (Number.isSafeInteger(caption?.voiceOffset) && caption.voiceOffset > 0) {
      // A continuation belongs to exactly the prefix already accepted. An old
      // reply cannot resume after a newer caption, even when it has no sound.
      if (caption.voiceFor !== replyRoot || caption.voiceOffset !== nextOffset) return;
      nextOffset += segments.length;
      segmentPlayer.enqueue(caption, segments, captureSpeech(undefined));
      return;
    }
    replyRoot = caption?.voiceFor ?? id;
    nextOffset = sounding ? segments.length : 0;
    // Every new reply replaces the old one, including a silent caption. Drop
    // the queue before settling its current clip, and invalidate any decode
    // or media play promise that could otherwise start the old answer late.
    ++generation;
    segmentPlayer.drop('replaced');
    stopPlaying();
    // A silent or single-segment reply with no clip needs no sequencer. Its
    // caption is drawn by the page's reply listener, and any browser speech
    // fallback for this new reply is left alone.
    if (!sounding && segments.length < 2) return;
    // Synchronous, so it is in place before the page speaks in this same
    // dispatch, and taken only when this reply has sound to put in its place.
    const captured = captureSpeech(sounding ? synthOf() : undefined);
    // A newer answer takes the row: the older reply's remaining segments are
    // dropped rather than queued behind it, and the drop is recorded.
    segmentPlayer.start(caption, segments, captured);
  };

  try {
    events?.addEventListener?.(REPLY_AUDIO_EVENT, onReply);
    stops.push(() => { try { events.removeEventListener(REPLY_AUDIO_EVENT, onReply); } catch { /* Already detached. */ } });
  } catch { /* A page with no event target simply never plays a clip. */ }

  const release = async () => {
    replyRoot = undefined;
    nextOffset = 0;
    ++generation;
    segmentPlayer.drop('released');
    stopPlaying();
    const previous = context;
    context = undefined;
    try { await previous?.close?.(); } catch { /* Native audio may already be closed. */ }
  };

  const controller = {
    unlock,
    release,
    /** The context's own state, for a log line that has to explain silence. */
    state: () => String(context?.state ?? 'absent'),
    stop() {
      if (stopped) return;
      stopped = true;
      segmentPlayer.stop();
      stopPlaying();
      for (const undo of stops.reverse()) { try { undo(); } catch { /* Best effort at teardown. */ } }
      try { if (scope.__stereofoldReplyAudio === controller) delete scope.__stereofoldReplyAudio; }
      catch { /* A sealed global keeps the handle; it is inert once stopped. */ }
      return release();
    },
  };
  try { scope.__stereofoldReplyAudio = controller; }
  catch { /* The returned controller is enough. */ }
  return controller;
}

/** Unlock whichever reply audio this page installed, from any user gesture. */
export function unlockReplyAudio(scope = globalThis, via = 'call') {
  try { return scope?.__stereofoldReplyAudio?.unlock?.(via) ?? false; }
  catch { return false; }
}
