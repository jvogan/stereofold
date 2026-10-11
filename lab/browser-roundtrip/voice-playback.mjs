import { recordLoopStage } from './loop-timing.mjs';
function decodeBase64Wav(wavBase64) {
  if (typeof wavBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(wavBase64) || wavBase64.length > 1_100_000) {
    throw Error('Voice acknowledgement audio is invalid.');
  }
  const raw = atob(wavBase64), bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  if (!bytes.byteLength) throw Error('Voice acknowledgement audio is empty.');
  return bytes;
}

function abortError() { return Object.assign(Error('Voice playback was cancelled.'), { name: 'AbortError' }); }
function timeoutError() { return Error('Voice playback timed out.'); }

// Resume/decode can both remain pending indefinitely in a suspended or
// partially implemented WebAudio context. Keep cancellation and the playback
// deadline active during preparation, before a BufferSource exists to stop.
function boundedPreparation(operation, { signal, timeoutMs }, setCancel) {
  if (signal?.aborted) return Promise.reject(abortError());
  let timer, rejectCancel;
  const cancel = () => rejectCancel?.(abortError());
  const cancellation = new Promise((_, reject) => {
    rejectCancel = reject;
    signal?.addEventListener?.('abort', cancel, { once: true });
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  setCancel(cancel);
  const work = Promise.resolve().then(operation);
  return Promise.race([work, cancellation]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', cancel);
    setCancel(undefined, cancel);
  });
}

/**
 * Keep one audio context alive for the companion session. `unlock` must be
 * called by the point/tap gesture; later OAuth playback happens after an
 * asynchronous network/tool round trip and may otherwise be blocked by the
 * browser autoplay policy.
 */
export function createVoicePlayback({ AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
  let context;
  let closed = false;
  let generation = 0;
  let cancelActive;
  let cancelPreparation;

  async function unlock() {
    if (closed) throw Error('Voice playback is closed.');
    if (!AudioContextClass) throw Error('Audio playback is unavailable in this browser.');
    context ??= new AudioContextClass();
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
    return context;
  }

  async function play(wavBase64, { signal, timing, timeoutMs = 30_000 } = {}) {
    const token = generation;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw RangeError('Voice playback timeout must be 1–60000 ms.');
    if (signal?.aborted) throw abortError();
    const bytes = decodeBase64Wav(wavBase64);
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw timeoutError();
      return value;
    };
    const audio = await boundedPreparation(() => {
      if (token !== generation) throw abortError();
      return unlock();
    }, { signal, timeoutMs: remaining() }, (cancel, previous) => {
      if (previous === undefined || cancel) cancelPreparation = cancel;
      else if (cancelPreparation === previous) cancelPreparation = undefined;
    });
    const buffer = await boundedPreparation(() => audio.decodeAudioData(bytes.buffer.slice(0)), { signal, timeoutMs: remaining() }, (cancel, previous) => {
      if (previous === undefined || cancel) cancelPreparation = cancel;
      else if (cancelPreparation === previous) cancelPreparation = undefined;
    });
    if (closed || token !== generation || signal?.aborted) throw abortError();
    // One context, one voice. Two callers that
    // both reached this point — an interrupt racing the line it replaces, or
    // any caller that passed no signal to abort — each connected a source to
    // the same destination and the wearer heard both at once. The line about to
    // start owns the speaker, so it stops whatever still holds it first.
    const previous = cancelActive; cancelActive = undefined; previous?.();
    const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
    let timer, settle;
    const ended = new Promise((resolve, reject) => {
      let finished = false;
      settle = (error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort);
        if (cancelActive === abort) cancelActive = undefined;
        if (error) reject(error); else resolve(undefined);
      };
      const abort = () => { try { source.stop(); } catch {} settle(abortError()); };
      source.onended = () => settle();
      cancelActive = abort;
      signal?.addEventListener?.('abort', abort, { once: true });
      timer = setTimeout(() => { try { source.stop(); } catch {} settle(timeoutError()); }, remaining());
      try { source.start(); if (audio.state === 'running') recordLoopStage('spoken-confirmation-started', timing); } catch (error) { settle(error); }
    });
    await ended;
  }

  async function release() {
    ++generation;
    cancelPreparation?.(); cancelPreparation = undefined;
    cancelActive?.(); cancelActive = undefined;
    const previous = context;
    context = undefined;
    if (previous) await previous.close().catch(() => {});
  }

  async function close() {
    closed = true;
    await release();
  }

  return Object.freeze({ unlock, play, release, close, unlocked: () => Boolean(context && !closed) });
}

/** Call from the original grip/tap gesture before any OAuth round trip. */
export function prepareVoicePlayback(playback) {
  if (!playback || typeof playback.unlock !== 'function') throw Error('Audio playback is unavailable in this browser.');
  return playback.unlock();
}

/** Play a one-shot OAuth-generated WAV acknowledgement after a rendered receipt. */
export async function playVoiceAcknowledgement(wavBase64, options = {}) {
  const playback = createVoicePlayback(options);
  try { await prepareVoicePlayback(playback); await playback.play(wavBase64, options); }
  finally { await playback.close(); }
}
