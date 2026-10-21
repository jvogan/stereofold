import { assistantStatus } from './assistant-status.mjs';
import { recordLoopStage } from './loop-timing.mjs';
/**
 * Stream the Quest microphone to the Mac while the grip is held.
 *
 * Version 2 of headset push-to-talk. Version 1 sent only a grip edge and the
 * Mac ran a shell command the user had exported, which meant the wearer had
 * to be within earshot of the Mac's own microphone. This module records the
 * headset microphone instead and posts it in one-second Opus chunks through
 * the same authenticated JSON `/tool` route every other companion action
 * uses, so the wearer can be anywhere on the network.
 *
 * Four properties are deliberate:
 *
 * - Recording starts from the grip's own user gesture and stops when the grip
 *   is released. There is no open microphone between presses; the MediaStream
 *   is kept, but no recorder runs on it.
 * - Chunks are bounded well below the 2 MiB transport cap. A one-second Opus
 *   chunk is a few kilobytes; the splitter exists for the pathological case,
 *   not the normal one.
 * - An utterance is capped at sixty seconds. A grip held by a controller that
 *   fell asleep cannot record indefinitely.
 * - Nothing here synthesizes a keystroke. The Mac transcribes locally and the
 *   text is delivered as text.
 *
 * State is published through a small emitter rather than written to the
 * toolbar, so another in-headset indicator can subscribe without this module
 * or the grip binding changing. `pushToTalkAudioEvents()` reaches the same
 * emitter from anywhere on the page.
 */

export const PUSH_TO_TALK_AUDIO_TOOL = 'push_to_talk_audio';
/** Opus in WebM: what Quest Browser records and what ffmpeg decodes on the Mac. */
export const PUSH_TO_TALK_AUDIO_MIME = 'audio/webm;codecs=opus';
export const PUSH_TO_TALK_AUDIO_FALLBACK_MIMES = Object.freeze([
  'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg',
]);
/** One chunk per second: small enough to upload as it is spoken, large enough not to thrash. */
export const PUSH_TO_TALK_AUDIO_TIMESLICE_MS = 1_000;
/** The widest utterance the transport will carry. A caller may ask for less, never more. */
export const PUSH_TO_TALK_AUDIO_MAX_DURATION_MS = 60_000;
/**
 * The cap an ordinary press runs under.
 *
 * Sixty seconds was a safety bound against a sleeping controller, not a
 * sentence length. A wearer says "show me the PAM site" in three seconds, and
 * a press that has to be held for a minute before it gives up reads as a
 * hang. Twenty seconds is long enough for any spoken instruction and short
 * enough that a stuck press recovers on its own.
 */
export const PUSH_TO_TALK_AUDIO_DEFAULT_MAX_DURATION_MS = 20_000;
/**
 * Shorter than this, with no speech on the meter, is a tapped grip.
 *
 * It changes no upload and no bound: the recording is still delivered and
 * still transcribed. It only decides which of two empty answers the wearer is
 * given, because "no speech was recognized" reads as a broken microphone when
 * the real problem is that the grip was let go after a third of a second.
 */
export const PUSH_TO_TALK_MIN_UTTERANCE_MS = 700;
/** Silence this long, after speech was actually heard, ends the utterance. */
export const PUSH_TO_TALK_SILENCE_HOLD_MS = 2_500;
/** How often the silence watch reads the meter. */
export const PUSH_TO_TALK_LEVEL_POLL_MS = 100;
/** Meter readings, 0–1, that count as speech and as silence. The gap is hysteresis. */
export const PUSH_TO_TALK_SPEECH_LEVEL = 0.08;
export const PUSH_TO_TALK_SILENCE_LEVEL = 0.04;
/**
 * How long a microphone request may hang before the press gives up.
 *
 * Meta Quest Browser cannot draw a permission prompt over an immersive
 * session, so a `getUserMedia` made from inside VR can sit unsettled forever.
 * Priming the microphone on the Enter VR gesture is the fix; this bound is
 * what turns the remaining case into a message on the menu rather than a row
 * that glows and never returns.
 */
export const PUSH_TO_TALK_MIC_TIMEOUT_MS = 10_000;
/** A recorder that has neither reported `recording` nor delivered a chunk by now never started. */
export const PUSH_TO_TALK_RECORDER_START_TIMEOUT_MS = 3_000;
/**
 * Raw bytes per posted chunk. Base64 costs a third more, so 192 KiB becomes
 * 256 KiB on the wire against a 2 MiB body cap. A one-second Opus chunk is
 * roughly 4 KiB, so this bound is never reached in normal speech.
 */
export const PUSH_TO_TALK_AUDIO_MAX_CHUNK_BYTES = 192 * 1024;
/** Sixty seconds of Opus is well under a megabyte; this is a wide safety bound. */
export const PUSH_TO_TALK_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
/** Chunk sequence numbers are bounded so a stuck recorder cannot walk forever. */
export const PUSH_TO_TALK_AUDIO_MAX_SEQ = 4_095;

const EMPTY = Object.freeze([]);
/**
 * Speech peaks well below full scale, so a raw RMS would leave the level meter
 * almost unlit. This is the gain that puts an ordinary speaking voice around
 * the middle of the meter; it is display only and touches no recorded sample.
 */
export const PUSH_TO_TALK_LEVEL_GAIN = 6;

/**
 * Report one transition or failure to the headset diagnostics overlay.
 *
 * The overlay is built in another module and may not be on the page at all,
 * so this is a probe, never an import. Nothing here may throw: a wearer with
 * no overlay must still be able to talk.
 */
export function recordVoiceDiagnostic(kind, detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.(kind, detail); }
  catch { /* A diagnostics sink that throws must not cost the press. */ }
}

/**
 * A read-only loudness tap on the live microphone stream.
 *
 * The recorded bytes are untouched: this reads the same track through an
 * analyser and reports a 0–1 number for a level meter. Every step is
 * guarded, because a browser without Web Audio, or one that refuses a second
 * consumer of the track, must still record.
 */
export function createLevelMeter(stream, AudioContextCtor) {
  const Ctor = AudioContextCtor ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Ctor || !stream) return undefined;
  let context, analyser, samples;
  try {
    context = new Ctor();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    context.createMediaStreamSource(stream).connect(analyser);
    samples = new Float32Array(analyser.fftSize);
  } catch {
    try { context?.close?.(); } catch { /* Nothing was opened. */ }
    return undefined;
  }
  return {
    read() {
      try {
        if (typeof analyser.getFloatTimeDomainData !== 'function') return undefined;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let index = 0; index < samples.length; index++) sum += samples[index] * samples[index];
        const rms = Math.sqrt(sum / samples.length) * PUSH_TO_TALK_LEVEL_GAIN;
        return Number.isFinite(rms) ? Math.max(0, Math.min(1, rms)) : undefined;
      } catch { return undefined; }
    },
    close() { try { context.close(); } catch { /* Already closed with the page. */ } },
  };
}

function encodeBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    text += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(text);
}

/**
 * A one-line emitter. Listeners never see each other's exceptions, because a
 * broken indicator must not stop the upload that is already in flight.
 */
export function createPushToTalkAudioEvents() {
  const listeners = new Set();
  let latest = { state: 'idle' };
  return {
    on(listener) {
      if (typeof listener !== 'function') throw new TypeError('A push-to-talk audio listener must be a function.');
      listeners.add(listener);
      try { listener(latest); } catch { /* A listener that throws on its first event is still subscribed. */ }
      return () => { listeners.delete(listener); };
    },
    off(listener) { listeners.delete(listener); },
    emit(event) {
      latest = event;
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* One bad subscriber must not silence the rest. */ }
      }
      return event;
    },
    latest() { return latest; },
    get size() { return listeners.size; },
  };
}

/** The page-wide emitter and sender, so the grip binding needs no new argument. */
const sharedEvents = createPushToTalkAudioEvents();
let registeredAudioSender;

export function pushToTalkAudioEvents() { return sharedEvents; }

/** Audio constraints, in one place, so a primed stream matches a pressed one. */
export const PUSH_TO_TALK_AUDIO_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
});

const liveStream = stream => Boolean(stream?.getTracks?.().some(track => track.readyState !== 'ended'));
/** Hold the grant without capturing. A disabled track delivers silence, not sound. */
function setStreamEnabled(stream, enabled) {
  for (const track of stream?.getTracks?.() ?? EMPTY) { try { track.enabled = enabled; } catch { /* Ended tracks refuse the write. */ } }
}

/**
 * The microphone grant, taken once and held for the session.
 *
 * Meta Quest Browser cannot show a permission prompt over an immersive
 * session. A `getUserMedia` first made from a talk press therefore happens
 * with the headset already in VR: the wearer sees nothing to answer, the
 * promise never settles, and the press hangs with the menu lit. So the grant is
 * taken in 2D, on the Enter VR gesture, and parked here with its tracks
 * disabled — the microphone light is off and no sample is read until a press
 * turns the tracks back on.
 */
let primedStream, primedRequest, primedState = 'idle', primedMessage;
let primedGeneration = 0, cancelPrimedRequest;

export function pushToTalkMicrophoneState() {
  if (primedState === 'granted' && !liveStream(primedStream)) return 'idle';
  return primedState;
}
export function primedPushToTalkStream() { return liveStream(primedStream) ? primedStream : undefined; }
export function pushToTalkMicrophoneMessage() { return primedMessage; }

/**
 * Ask for the microphone now and keep it muted until a press.
 *
 * Safe to call on every Enter VR: an existing live grant is returned without a
 * second prompt, and an in-flight request is shared rather than duplicated.
 * It never rejects; the outcome is in the returned state, because the caller
 * is a click handler whose real job is entering immersion.
 */
export function primePushToTalkMicrophone({ media, timeoutMs = PUSH_TO_TALK_MIC_TIMEOUT_MS,
  setTimer = (handler, delay) => setTimeout(handler, delay), clearTimer = handle => clearTimeout(handle) } = {}) {
  if (liveStream(primedStream)) return Promise.resolve({ state: 'granted' });
  if (primedRequest) return primedRequest;
  const devices = media ?? globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    primedState = 'unavailable';
    primedMessage = 'This browser exposes no microphone.';
    recordVoiceDiagnostic('voice-mic-prime', { state: primedState });
    return Promise.resolve({ state: primedState, message: primedMessage });
  }
  primedState = 'requesting';
  const generation = ++primedGeneration;
  primedMessage = undefined;
  recordVoiceDiagnostic('voice-mic-prime', { state: 'requesting' });
  const granted = Promise.resolve(devices.getUserMedia(PUSH_TO_TALK_AUDIO_CONSTRAINTS));
  // A late grant is adopted rather than dropped: the wearer answered the
  // prompt, just after this call gave up waiting for them.
  granted.then(stream => {
    if (generation !== primedGeneration) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch {} }
      return;
    }
    primedStream = stream; setStreamEnabled(stream, false); primedState = 'granted';
  }, () => {});
  const request = new Promise(resolve => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      primedState = 'pending-prompt';
      primedMessage = 'The microphone prompt was not answered. Answer it before entering VR.';
      recordVoiceDiagnostic('voice-mic-prime', { state: primedState });
      resolve({ state: primedState, message: primedMessage });
    }, timeoutMs);
    cancelPrimedRequest = () => {
      if (settled) return;
      settled = true; clearTimer(timer); resolve({ state: 'idle' });
    };
    granted.then(() => {
      if (settled) return;
      settled = true; clearTimer(timer);
      recordVoiceDiagnostic('voice-mic-prime', { state: 'granted' });
      resolve({ state: 'granted' });
    }, error => {
      if (generation !== primedGeneration) return;
      if (!settled) { settled = true; clearTimer(timer); }
      primedState = error?.name === 'NotAllowedError' ? 'denied' : 'unavailable';
      primedMessage = error?.name === 'NotAllowedError'
        ? 'Microphone permission was declined. Allow it in the browser, then reload.'
        : error instanceof Error ? error.message : 'The headset microphone is unavailable.';
      recordVoiceDiagnostic('voice-mic-prime', { state: primedState, message: primedMessage });
      resolve({ state: primedState, message: primedMessage });
    });
  }).finally(() => {
    if (primedRequest === request) { primedRequest = undefined; cancelPrimedRequest = undefined; }
  });
  primedRequest = request;
  return primedRequest;
}

/** Drop the held grant. Called at teardown, and by tests between cases. */
export function releasePushToTalkMicrophone() {
  ++primedGeneration;
  cancelPrimedRequest?.(); cancelPrimedRequest = undefined; primedRequest = undefined;
  for (const track of primedStream?.getTracks?.() ?? EMPTY) { try { track.stop(); } catch { /* Already ended. */ } }
  primedStream = undefined; primedState = 'idle'; primedMessage = undefined;
}

/**
 * The companion page registers its authenticated tool caller once. Registering
 * it is also the opt-in: with no sender, the grip never opens a microphone.
 */
export function setPushToTalkAudioSender(send) {
  registeredAudioSender = typeof send === 'function' ? send : undefined;
}

export function pushToTalkAudioSender() { return registeredAudioSender; }

/**
 * The first container this browser will actually record.
 *
 * Quest Browser is Chromium and records WebM/Opus, but the probe is real
 * rather than assumed: a build that refuses every candidate gets `undefined`,
 * which constructs the recorder with the UA's own default instead of forcing
 * a type it has already said it cannot produce. The Mac reads the container
 * off the chunk's declared MIME type, so any of these decode there.
 */
export function pickPushToTalkMime(recorderFactory, preferred) {
  const candidates = preferred ? [preferred, ...PUSH_TO_TALK_AUDIO_FALLBACK_MIMES] : PUSH_TO_TALK_AUDIO_FALLBACK_MIMES;
  const supported = recorderFactory?.isTypeSupported;
  if (typeof supported !== 'function') return candidates[0];
  for (const candidate of candidates) {
    try { if (supported.call(recorderFactory, candidate)) return candidate; }
    catch { /* A UA that throws on a probe simply does not support that type. */ }
  }
  return undefined;
}

function randomUtteranceId() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  // A UUID-shaped fallback for a UA without randomUUID. The Mac validates the
  // shape, not the entropy; collisions only matter within one live session.
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < 16; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function blobBytes(blob) {
  if (!blob) return new Uint8Array();
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  throw new TypeError('A recorder chunk must be a Blob.');
}

/**
 * Read one transcript out of whatever shape the tool result arrived in.
 * The companion transport returns the MCP result verbatim, so the text can
 * sit under `structuredContent` or at the top level depending on the host.
 */
export function transcriptFromResult(result) {
  const candidates = [result?.transcript, result?.structuredContent?.transcript,
    result?.structuredContent, result];
  for (const candidate of candidates) {
    const text = candidate?.text;
    if (typeof text === 'string' && text.trim()) {
      // The Mac's scene-checked proposal rides with the raw text.
      //
      // The recognizer wrote "Go to resident 141" for "go to residue 141" and
      // the page's own grammar has no shape for it, so the wearer's only
      // spoken route into the residue browser was lost to one letter
      // The Mac already corrects it,
      // records the correction as a rule, and hands both readings back; until
      // now the page kept only the raw one. The raw text is still what is
      // shown and still what the grammar is tried against first.
      const normalized = candidate.normalizedText;
      return { text: text.trim(), utteranceId: candidate.utteranceId, model: candidate.model, durationMs: candidate.durationMs,
        ...(candidate.headsetAction === true ? { headsetAction: true } : {}),
        ...(typeof candidate.pageDecision === 'string' ? { pageDecision: candidate.pageDecision } : {}),
        ...(typeof normalized === 'string' && normalized.trim() && normalized.trim() !== text.trim()
          ? { normalizedText: normalized.trim(),
              normalizationRules: Array.isArray(candidate.normalizationRules) ? candidate.normalizationRules : [] }
          : {}) };
    }
  }
  return undefined;
}

/**
 * Record one press at a time and post it as it is spoken.
 *
 * @param {object} options
 * @param {(args:object)=>Promise<any>} options.send authenticated `push_to_talk_audio` caller
 * @param {{getUserMedia:(constraints:object)=>Promise<MediaStream>}} [options.media] defaults to `navigator.mediaDevices`
 * @param {Function} [options.recorderFactory] defaults to `globalThis.MediaRecorder`
 * @param {object} [options.events] emitter to publish onto; defaults to the page-wide one
 */
export function createPushToTalkAudio({
  send,
  media,
  recorderFactory,
  events = sharedEvents,
  timesliceMs = PUSH_TO_TALK_AUDIO_TIMESLICE_MS,
  maxDurationMs = PUSH_TO_TALK_AUDIO_DEFAULT_MAX_DURATION_MS,
  maxChunkBytes = PUSH_TO_TALK_AUDIO_MAX_CHUNK_BYTES,
  maxBytes = PUSH_TO_TALK_AUDIO_MAX_BYTES,
  silenceHoldMs = PUSH_TO_TALK_SILENCE_HOLD_MS,
  levelPollMs = PUSH_TO_TALK_LEVEL_POLL_MS,
  speechLevel = PUSH_TO_TALK_SPEECH_LEVEL,
  silenceLevel = PUSH_TO_TALK_SILENCE_LEVEL,
  micTimeoutMs = PUSH_TO_TALK_MIC_TIMEOUT_MS,
  recorderStartTimeoutMs = PUSH_TO_TALK_RECORDER_START_TIMEOUT_MS,
  mimeType,
  now = () => Date.now(),
  audioContextFactory,
  newId = randomUtteranceId,
  setTimer = (handler, delay) => setTimeout(handler, delay),
  clearTimer = handle => clearTimeout(handle),
} = {}) {
  if (typeof send !== 'function') throw new TypeError('Push-to-talk audio needs an authenticated tool caller.');
  if (!Number.isFinite(timesliceMs) || timesliceMs < 100 || timesliceMs > 5_000) throw new RangeError('The push-to-talk timeslice must be 100–5000 ms.');
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > PUSH_TO_TALK_AUDIO_MAX_DURATION_MS) {
    throw new RangeError(`A push-to-talk utterance must be capped at 1000–${PUSH_TO_TALK_AUDIO_MAX_DURATION_MS} ms.`);
  }
  const devices = media ?? globalThis.navigator?.mediaDevices;
  const Recorder = recorderFactory ?? globalThis.MediaRecorder;

  let stream;
  let streamRequest;
  let active;
  let disposed = false;
  let uploads = Promise.resolve();
  const finishing = new Set();
  let meter;

  function emit(event) {
    if (disposed) return;
    assistantStatus.update(event.state === 'heard' ? {heard:event.text, microphone:'idle'} : {microphone:event.state==='uploading'?'recording':event.state});
    recordVoiceDiagnostic('voice-state', { state: event?.state, utteranceId: event?.utteranceId,
      ...(event?.message ? { message: event.message } : {}) });
    return events.emit(event);
  }

  /**
   * Ask once and keep it. A second prompt mid-session would cost a press.
   *
   * The grant the Enter VR gesture parked is preferred over a fresh request,
   * because a fresh one made from inside an immersive session cannot be
   * answered on Quest. When there is no primed grant the request is still
   * made, but under a deadline, so the press fails with a message the wearer
   * can read instead of hanging with the menu lit.
   */
  async function ensureStream() {
    // Which of the three branches a press took is the single most useful fact
    // in the log when voice fails on hardware: reusing the grant is the
    // healthy path, and a fresh request from inside an immersive session is
    // the one Quest Browser cannot answer.
    if (liveStream(stream)) { recordVoiceDiagnostic('voice-mic-source', { source: 'held' }); setStreamEnabled(stream, true); return stream; }
    const primed = primedPushToTalkStream();
    if (primed) { recordVoiceDiagnostic('voice-mic-source', { source: 'primed' }); stream = primed; setStreamEnabled(stream, true); return stream; }
    recordVoiceDiagnostic('voice-mic-source', { source: 'request', primedState: pushToTalkMicrophoneState() });
    if (!devices?.getUserMedia) throw Error('This browser exposes no microphone.');
    streamRequest ??= Promise.resolve(devices.getUserMedia(PUSH_TO_TALK_AUDIO_CONSTRAINTS))
      .finally(() => { streamRequest = undefined; });
    const request = streamRequest;
    // A late grant is still worth keeping: the next press uses it without
    // prompting again, even though this press gave up on it.
    request.then(granted => {
      if (disposed) {
        setStreamEnabled(granted, false);
        for (const track of granted?.getTracks?.() ?? EMPTY) { try { track.stop(); } catch {} }
      } else {
        stream ??= granted;
        // A timed-out or cancelled prompt may still be granted later. Keep
        // that permission for the next press without leaving the mic live.
        if (!active) setStreamEnabled(granted, false);
      }
    }, () => {});
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimer(() => reject(Object.assign(
        Error('The headset did not answer the microphone prompt. Leave VR, allow the microphone, then press talk again.'),
        { name: 'MicrophonePromptTimeout' })), micTimeoutMs);
    });
    let granted;
    try { granted = await Promise.race([request, deadline]); }
    finally { clearTimer(timer); }
    // The permission promise can outlive disposal. Its handler above owns
    // stopping that late grant; never revive it here.
    if (disposed) return granted;
    stream = granted;
    setStreamEnabled(stream, true);
    return stream;
  }

  /** Post one chunk, splitting only if a recorder handed back something huge. */
  function queueChunk(session, bytes, { final }) {
    const pieces = [];
    if (bytes.length) {
      for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
        pieces.push(bytes.subarray(offset, Math.min(offset + maxChunkBytes, bytes.length)));
      }
    }
    if (!pieces.length && !final) return uploads;
    const posts = pieces.map((piece, index) => ({
      data: encodeBase64(piece),
      final: final && index === pieces.length - 1,
    }));
    if (final && !pieces.length) posts.push({ final: true });
    // One chain, so sequence numbers reach the Mac in the order they were cut.
    const pending = uploads.then(async () => {
      if (disposed || session.cancelled) return;
      if (session.uploadError) throw session.uploadError;
      for (const post of posts) {
        if (disposed || session.cancelled) return;
        if (session.seq > PUSH_TO_TALK_AUDIO_MAX_SEQ) throw Error('That utterance produced too many chunks.');
        const args = {
          utteranceId: session.utteranceId,
          seq: session.seq++,
          mime: session.mimeType,
          final: Boolean(post.final),
          ...(post.data ? { data: post.data } : {}),
        };
        const result = await send(args);
        if (post.final) session.result = result;
      }
    }).catch(error => {
      session.uploadError ??= error;
      throw error;
    });
    // Keep transport ordering across presses, but a failed utterance must not
    // poison the next one. Its own error still rejects pending and blocks its
    // final marker, so a partial recording can never become a command.
    uploads = pending.catch(() => {});
    return pending;
  }

  function stopTracks() {
    const owned = stream && stream === primedPushToTalkStream();
    for (const track of stream?.getTracks?.() ?? EMPTY) { try { track.stop(); } catch { /* Already ended. */ } }
    if (owned) releasePushToTalkMicrophone();
    stream = undefined;
    try { meter?.close(); } catch { /* The audio context may already be closed. */ }
    meter = undefined;
  }

  /**
   * End the press when the wearer stops speaking.
   *
   * The watch arms only after real speech: a wearer who presses and thinks for
   * two seconds must not have the press taken away before they start. Once
   * speech has been heard, silence for `silenceHoldMs` ends the utterance,
   * which is what makes a press feel like a sentence rather than a button that
   * has to be pressed twice.
   */
  function watchSilence(session) {
    if (!meter || !Number.isFinite(silenceHoldMs) || silenceHoldMs <= 0) return;
    const tick = () => {
      if (active !== session || session.ended) return;
      const level = meter?.read();
      if (Number.isFinite(level)) {
        if (level >= speechLevel) { session.heardSpeech = true; session.quietSince = undefined; }
        else if (session.heardSpeech && level < silenceLevel) {
          session.quietSince ??= now();
          if (now() - session.quietSince >= silenceHoldMs) {
            recordVoiceDiagnostic('voice-auto-stop', { utteranceId: session.utteranceId, reason: 'silence' });
            void api.stop();
            return;
          }
        } else session.quietSince = undefined;
      }
      session.levelTimer = setTimer(tick, levelPollMs);
    };
    session.levelTimer = setTimer(tick, levelPollMs);
  }

  async function finish(session, { cancelled = false, silent = false } = {}) {
    finishing.add(session);
    session.cancelled ||= cancelled;
    try {
      session.ended = true;
      clearTimer(session.timer);
      if (session.levelTimer !== undefined) clearTimer(session.levelTimer);
      if (session.recorder?.state === 'recording' || session.recorder?.state === 'paused') {
        try { session.recorder.stop(); } catch { /* The UA may have stopped it already. */ }
      }
      // A press stopped while its microphone request is still outstanding has no
      // recorder and no `stopped` promise. Awaiting one threw a TypeError here,
      // which left the recorder running and the status row stuck: the stop it was given
      // never completed. Nothing to wait for is a valid state, not a fault.
      await (session.stopped ?? Promise.resolve()).catch(() => {});
      // Let go of the microphone between presses so the headset's recording
      // indicator goes out, while the grant itself is kept for the next press.
      if (!active) setStreamEnabled(stream, false);
      // A read can enqueue nothing new, but it can still be in flight, so drain
      // until the set is empty rather than snapshotting it once.
      while (session.reads.size) await Promise.allSettled([...session.reads]);
      if (disposed || session.cancelled) { if (!silent && !active) emit({ state: 'idle', utteranceId: session.utteranceId }); return undefined; }
      if (session.uploadError) {
        emit({ state: 'error', utteranceId: session.utteranceId, message: session.uploadError.message || 'The recording could not be delivered.', error: session.uploadError });
        return undefined;
      }
      // A press stopped before the recorder ever ran has nothing to send. The
      // Mac must not be handed a final marker for an utterance with no audio and
      // no container type, so this closes out on the page instead.
      if (!session.seq && !session.live) {
        emit({ state: 'idle', utteranceId: session.utteranceId, message: 'Nothing was recorded.' });
        return undefined;
      }
      emit({ state: 'transcribing', utteranceId: session.utteranceId });
      try {
        await queueChunk(session, new Uint8Array(), { final: true });
      } catch (error) {
        if (disposed || session.cancelled) return undefined;
        const message = error instanceof Error ? error.message : 'The recording could not be delivered.';
        emit({ state: 'error', utteranceId: session.utteranceId, message, error });
        return undefined;
      }
      if (disposed || session.cancelled) return undefined;
      const transcript = transcriptFromResult(session.result);
      if (!transcript) {
        // Separate the two ways a press comes back empty. A press too short to
        // hold a sentence is a grip that was tapped, and telling the wearer to
        // hold it is the only useful thing to say; anything longer really was
        // heard as silence. The meter's own answer outranks the clock, because a
        // wearer who spoke one word did speak.
        const durationMs = now() - session.startedAt;
        const tapped = !session.heardSpeech && durationMs < PUSH_TO_TALK_MIN_UTTERANCE_MS;
        if (tapped) recordVoiceDiagnostic('voice-too-short', { utteranceId: session.utteranceId, durationMs });
        emit({ state: 'heard', utteranceId: session.utteranceId, text: '',
          message: tapped ? 'Hold the grip while you speak.' : "Didn't catch that. Please speak again." });
        return undefined;
      }
      recordLoopStage('transcript-received', { utteranceId: session.utteranceId });
      let decision;
      const decide = transcript.pageDecision ? handled => {
        // One event may be replayed or observed twice; only its first handler decides.
        if (decision || disposed || session.cancelled) return Promise.resolve(false);
        const args = { utteranceId: session.utteranceId, seq: session.seq ?? 0,
          mime: session.mime || 'audio/webm', final: true,
          pageDecision: { token: transcript.pageDecision, handled } };
        decision = Promise.resolve().then(() => disposed || session.cancelled ? undefined : send(args))
          .catch(() => disposed || session.cancelled ? undefined : send(args))
          .then(answer => (answer?.structuredContent ?? answer)?.handled === true).catch(() => false);
        return decision;
      } : undefined;
      emit({ state: 'heard', utteranceId: session.utteranceId, text: transcript.text, transcript, decide,
        ...(transcript.normalizedText ? { normalizedText: transcript.normalizedText } : {}),
        message: `Heard: ${transcript.text}` });
      return transcript;
    } finally { finishing.delete(session); }
  }

  const api = {
    events,
    recording() { return Boolean(active?.live); },
    /** True from the press until the utterance closes, recorder or no recorder. */
    busy() { return Boolean(active); },
    utteranceId() { return active?.utteranceId; },

    /**
     * Current microphone loudness, 0–1, or `undefined` when no recording is
     * running or the browser exposes no Web Audio. The menu's status row reads this
     * every frame to draw its level ring, so it must never throw.
     */
    level() { return active?.live ? meter?.read() : undefined; },

    /** Begin one utterance. Safe to call from the grip's squeezestart handler. */
    async start() {
      if (disposed) throw Error('This push-to-talk recorder was disposed.');
      if (active) return active.utteranceId;
      const utteranceId = newId();
      const session = { utteranceId, seq: 0, bytes: 0, startedAt: now(), result: undefined, reads: new Set(), live: false };
      active = session;
      // `requesting-microphone` is not yet listening, and the menu draws it as
      // arming for exactly that reason: nothing has been recorded and the
      // wearer must not be told to speak.
      emit({ state: 'requesting-microphone', utteranceId });
      /** A press stopped mid-await leaves nothing running behind it. */
      const abandoned = () => active !== session;
      const failWith = (error, fallback) => {
        if (abandoned()) return;
        active = undefined;
        setStreamEnabled(stream, false);
        const message = error?.name === 'NotAllowedError'
          ? 'Microphone permission was declined in the headset.'
          : error instanceof Error && error.message ? error.message : fallback;
        emit({ state: 'error', utteranceId, message, error });
      };
      let source;
      try { source = await ensureStream(); }
      catch (error) { failWith(error, 'The headset microphone is unavailable.'); throw error; }
      if (abandoned()) { if (!active) setStreamEnabled(stream, false); return utteranceId; }
      // The meter is a display accessory: it is built after permission was
      // granted, shares the granted track, and its absence changes nothing
      // about what is recorded or uploaded.
      meter ??= createLevelMeter(source, audioContextFactory);
      if (!Recorder) {
        failWith(undefined, 'This browser cannot record audio.');
        throw Error('This browser cannot record audio.');
      }
      const chosen = pickPushToTalkMime(Recorder, mimeType);
      let recorder;
      try { recorder = new Recorder(source, chosen ? { mimeType: chosen } : {}); }
      catch (error) { failWith(error, 'The headset microphone could not be recorded.'); throw error; }
      // What the recorder says it is producing outranks what was asked for: a
      // UA may quietly substitute a container, and the Mac decodes by the type
      // each chunk declares.
      session.mimeType = (typeof recorder.mimeType === 'string' && recorder.mimeType.trim())
        ? recorder.mimeType.trim() : chosen ?? PUSH_TO_TALK_AUDIO_MIME;
      if (abandoned()) { try { recorder.stop(); } catch { /* Never started. */ } if (!active) setStreamEnabled(stream, false); return utteranceId; }
      session.recorder = recorder;
      session.stopped = new Promise(resolve => { session.settle = resolve; });
      /**
       * The menu may only claim to be listening once the recorder is really
       * running. Either the UA reports `recording`, or a chunk has arrived;
       * a recorder that does neither is a failure with a message, not a
       * lit status row over a dead microphone.
       */
      const markLive = () => {
        if (session.live || abandoned()) return;
        session.live = true;
        if (session.startTimer !== undefined) { clearTimer(session.startTimer); session.startTimer = undefined; }
        emit({ state: 'recording', utteranceId, maxDurationMs, mime: session.mimeType });
        watchSilence(session);
      };
      recorder.ondataavailable = event => {
        if (disposed || session.cancelled) return;
        markLive();
        // Read in recorder event order: independent Blob promises can resolve
        // in reverse order and corrupt the container before the upload queue
        // even sees it. Tracking this chain also keeps the final marker last.
        const blob = event?.data;
        const read = (session.reading ?? Promise.resolve()).then(() =>
          disposed || session.cancelled ? new Uint8Array() : blobBytes(blob)).then(bytes => {
          if (disposed || session.cancelled) return;
          if (!bytes.length) return;
          session.bytes += bytes.length;
          if (session.bytes > maxBytes) {
            session.uploadError ??= Error('That utterance exceeded the audio size cap.');
            try { recorder.stop(); } catch { /* Already stopping. */ }
            return;
          }
          emit({ state: 'uploading', utteranceId, seq: session.seq, bytes: session.bytes });
          void queueChunk(session, bytes, { final: false }).catch(() => {});
        }).catch(error => { session.uploadError ??= error; });
        session.reading = read;
        session.reads.add(read);
        void read.finally(() => session.reads.delete(read));
      };
      recorder.onerror = event => {
        if (disposed || session.cancelled) return;
        const failure = event?.error ?? Error('The headset recorder failed.');
        session.uploadError ??= failure;
        // Show it now. Waiting for the release edge would leave the menu lit
        // over a recorder that has already given up.
        emit({ state: 'error', utteranceId, message: failure.message || 'The headset recorder failed.', error: failure });
        try { recorder.stop(); } catch { /* Already stopping. */ }
        if (active === session) { active = undefined; void finish(session, { cancelled: true, silent: true }); }
      };
      recorder.onstop = () => session.settle?.();
      try { recorder.start(timesliceMs); }
      catch (error) {
        session.settle?.();
        failWith(error, 'The headset recorder could not start.');
        throw error;
      }
      // A controller that sleeps mid-press never sends squeezeend, so the cap
      // is enforced here rather than trusting the release edge to arrive.
      session.timer = setTimer(() => {
        recordVoiceDiagnostic('voice-auto-stop', { utteranceId, reason: 'duration-cap' });
        void api.stop();
      }, maxDurationMs);
      if (recorder.state === 'recording') markLive();
      else {
        // Neither `recording` nor a chunk: give the UA a moment, then say so.
        session.startTimer = setTimer(() => {
          if (session.live || abandoned()) return;
          const message = 'The headset microphone did not start recording.';
          active = undefined;
          emit({ state: 'error', utteranceId, message });
          try { recorder.stop(); } catch { /* Never started. */ }
          session.settle?.();
          setStreamEnabled(stream, false);
        }, recorderStartTimeoutMs);
      }
      return utteranceId;
    },

    /** End the utterance, upload the tail, and resolve with the transcript. */
    async stop() {
      const session = active;
      if (!session) return undefined;
      active = undefined;
      if (session.startTimer !== undefined) clearTimer(session.startTimer);
      session.durationMs = now() - session.startedAt;
      recordLoopStage('microphone-release', { utteranceId: session.utteranceId });
      recordVoiceDiagnostic('voice-stop', { utteranceId: session.utteranceId, recording: session.live });
      return finish(session);
    },

    /** Abandon the utterance without asking for a transcript. */
    async cancel() {
      // stop() releases active before it awaits transcription. That pending
      // answer still belongs to this page and must be retired on cancel/exit.
      for (const session of finishing) session.cancelled = true;
      const session = active;
      if (!session) { if (finishing.size) emit({ state: 'idle' }); return; }
      active = undefined;
      if (session.startTimer !== undefined) clearTimer(session.startTimer);
      await finish(session, { cancelled: true });
    },

    async dispose() {
      disposed = true;
      const cancelled = api.cancel();
      stopTracks();
      await cancelled;
      await uploads.catch(() => {});
    },
  };
  return api;
}

/**
 * Build the streamer the grip binding uses, or `undefined` when the page has
 * registered no sender. Returning `undefined` is the whole opt-in mechanism:
 * a companion that never calls `setPushToTalkAudioSender` never records.
 */
export function pushToTalkAudioStream(options = {}) {
  const send = options.send ?? registeredAudioSender;
  if (typeof send !== 'function') return undefined;
  try { return createPushToTalkAudio({ ...options, send }); }
  catch { return undefined; }
}
