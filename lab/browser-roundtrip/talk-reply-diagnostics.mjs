/**
 * Prove, in the headset's own log, what happened to an agent's reply.
 *
 * `say_to_headset` queues a caption, the companion heartbeat carries it, the
 * panel dispatches `stereofold-headset-reply`, the menu's status row draws it
 * and `speechSynthesis` is asked to read it out. Every step after the heartbeat used
 * to be invisible from the Mac: a wearer who heard nothing could not be told
 * whether the caption never arrived, arrived and was drawn silently, or was
 * spoken into a headset with no installed voice.
 *
 * This module records that path and nothing else. It draws nothing, changes
 * no state, and never fails a reply: every hook is wrapped, because a
 * diagnostic that throws would cost the wearer the answer it was watching.
 *
 * Speech is instrumented by wrapping `speechSynthesis.speak` on the page
 * rather than by editing the caption owner, so this stays a page-level
 * accessory that can be left out entirely.
 */

/** The event the panel dispatches for one caption. Must match the panel's. */
export const TALK_REPLY_EVENT = 'stereofold-headset-reply';
/** How many voice names one log entry carries. A Quest lists few; a Mac lists many. */
export const TALK_REPLY_MAX_VOICES = 6;

function record(scope, kind, detail) {
  try { return scope?.__stereofoldDiagnostics?.record?.(kind, detail) ?? null; }
  catch { return null; }
}

/** Voice names and languages, bounded, for a headset that speaks nothing. */
export function describeSpeechVoices(synth, max = TALK_REPLY_MAX_VOICES) {
  let voices;
  try { voices = synth?.getVoices?.(); }
  catch { return { voices: 0, names: '' }; }
  if (!Array.isArray(voices)) return { voices: 0, names: '' };
  const names = voices.slice(0, max)
    .map(voice => `${voice?.name ?? 'unnamed'}${voice?.lang ? ` (${voice.lang})` : ''}`)
    .join(', ');
  return { voices: voices.length, names };
}

/**
 * Record one caption the panel handed to the page.
 *
 * The panel calls this at the point it reads the caption off its heartbeat,
 * so a caption that arrives on a surface that draws none is still logged.
 * The text itself is the agent's own sentence, already logged elsewhere; a
 * length and the speak flag are enough to match one log line to one reply.
 */
export function recordTalkReplyDelivery(caption, { seatOutcome = 'pending', fallback, scope = globalThis } = {}) {
  if (!caption || typeof caption !== 'object') return null;
  const text = typeof caption.text === 'string' ? caption.text : '';
  return record(scope, 'reply-received', {
    // The queue's own id for this reply. A length alone credits any other
    // answer of the same length -- including the previous turn's -- to this
    // one, and a reader cannot tell the panel's delivery record apart from the
    // page event's record of the same caption without it.
    ...(typeof caption.id === 'string' && caption.id ? { captionId: caption.id } : {}),
    via: 'delivery',
    chars: text.length,
    speak: caption.speak !== false,
    ...(Number.isFinite(caption.holdSeconds) ? { holdSeconds: caption.holdSeconds } : {}),
    // A caption delivered to a surface that draws nothing is a real failure
    // mode, and the only way to tell it apart from one that was never sent.
    //
    // `unmeasured` is a seat solved where the page could give the layout
    // no eye transforms. It is not a draw, and the record says which of the
    // two it is, so a reader never has to infer a missing measurement from a
    // `drawn: false` that a blocked card would produce as well.
    drawn: seatOutcome === 'shown', seatOutcome,
    ...(seatOutcome === 'unmeasured' ? { measured: false, reason: 'no-eye-views' } : {}),
    ...(fallback ? { fallback } : {}),
  });
}

/** The caption owner calls this only after committing its plate and glyphs,
 * or when that request cannot draw. Refusal outcomes carry the same result.
 */
export function recordTalkReplySeat(caption, seat, { scope = globalThis } = {}) {
  const seatOutcome = seat?.outcome ?? 'unavailable';
  recordTalkReplyDelivery(caption, { scope, seatOutcome, fallback: seat?.fallback });
  // Host-side voice refusals never pass through the page's tool-call catch.
  // Credit a caption only when its plate owner reports a committed draw.
  if (caption?.refusal && caption?.utteranceId) record(scope, 'tool-refused', {
    ...caption.refusal, captionId: caption.id, utteranceId: caption.utteranceId,
    ...(caption.commandId ? { commandId: caption.commandId } : {}),
    captioned: seatOutcome === 'shown', drawn: seatOutcome === 'shown', seatOutcome,
  });
  if (caption?.refusal || caption?.refusalScope) record(scope, 'outcome', {
    status: 'refused', captionId: caption.id, seatOutcome, drawn: seatOutcome === 'shown',
    ...(caption.refusal ?? {}),
    ...(caption.commandId ? { commandId: caption.commandId } : {}),
    ...(caption.utteranceId ? { utteranceId: caption.utteranceId } : {}),
    ...(seat?.fallback ? { fallback: seat.fallback } : {}),
  });
}

/**
 * Watch replies and speech on this page.
 *
 * Returns a stop function. Calling it twice is safe, and so is installing
 * twice: the second install replaces the first wrapper rather than nesting
 * one inside it.
 */
export function installTalkReplyDiagnostics({ scope = globalThis, target, synth } = {}) {
  const events = target ?? scope;
  const speech = synth ?? scope?.speechSynthesis;
  const stops = [];

  const onReply = event => {
    const detail = event?.detail;
    if (!detail || typeof detail.text !== 'string' || !detail.text.trim()) {
      record(scope, 'reply-received', { chars: 0, empty: true, drawn: false, seatOutcome: 'unavailable' });
      return;
    }
    // The page-level record: what the caption owner did with it is its own entry.
    record(scope, 'reply-received', {
      ...(typeof detail.id === 'string' && detail.id ? { captionId: detail.id } : {}),
      via: 'event', chars: detail.text.length, speak: detail.speak !== false, delivered: 'event',
      drawn: false, seatOutcome: 'pending' });
  };
  try {
    events?.addEventListener?.(TALK_REPLY_EVENT, onReply);
    stops.push(() => { try { events.removeEventListener(TALK_REPLY_EVENT, onReply); } catch { /* Already detached. */ } });
  } catch { /* A page with no event target still gets the speech hooks. */ }

  if (speech && typeof speech.speak === 'function') {
    // The voices list answers the question a silent headset raises first: is
    // there a voice installed at all? It is logged now and again whenever the
    // browser finishes loading them, which Chromium does asynchronously.
    record(scope, 'speech-voices', describeSpeechVoices(speech));
    const onVoicesChanged = () => record(scope, 'speech-voices', { ...describeSpeechVoices(speech), changed: true });
    try {
      speech.addEventListener?.('voiceschanged', onVoicesChanged);
      stops.push(() => { try { speech.removeEventListener('voiceschanged', onVoicesChanged); } catch { /* Already detached. */ } });
    } catch { /* Not every build fires it. */ }

    const original = speech.__stereofoldOriginalSpeak ?? speech.speak;
    const wrapped = function speakWithDiagnostics(utterance) {
      let started = false;
      try {
        record(scope, 'speech-start', {
          chars: typeof utterance?.text === 'string' ? utterance.text.length : 0,
          ...describeSpeechVoices(speech),
          // Quest Browser reports these even when it produces no sound, so
          // they separate "refused to queue" from "queued and stayed quiet".
          speaking: Boolean(speech.speaking), pending: Boolean(speech.pending),
        });
        utterance?.addEventListener?.('start', () => { started = true; record(scope, 'speech-audible', {}); });
        utterance?.addEventListener?.('end', () => record(scope, 'speech-end', { audible: started }));
        utterance?.addEventListener?.('error', event => record(scope, 'speech-error', {
          reason: typeof event?.error === 'string' ? event.error : 'unknown' }));
      } catch { /* Instrumentation must never stop the utterance below. */ }
      return original.call(speech, utterance);
    };
    try {
      speech.__stereofoldOriginalSpeak = original;
      speech.speak = wrapped;
      stops.push(() => {
        try { speech.speak = original; delete speech.__stereofoldOriginalSpeak; }
        catch { /* A frozen speechSynthesis keeps the wrapper; it is harmless. */ }
      });
    } catch { /* Some builds refuse the assignment; the reply hook still stands. */ }
  } else {
    record(scope, 'speech-voices', { voices: 0, names: '', absent: true });
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops.reverse()) { try { stop(); } catch { /* Best effort at teardown. */ } }
  };
}
