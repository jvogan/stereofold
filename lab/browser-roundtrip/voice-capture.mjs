/**
 * Short, press-to-talk microphone capture for the authenticated companion.
 *
 * It records no persistent file and returns raw 24 kHz mono PCM only after a
 * real media stream has been granted. The caller owns authenticated delivery.
 */
export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_MAX_DURATION_MS = 12_000;
export const VOICE_MIN_DURATION_MS = 180;
export const VOICE_RESUME_TIMEOUT_MS = 15_000;
export const VOICE_MAX_BYTES = VOICE_SAMPLE_RATE * 2 * VOICE_MAX_DURATION_MS / 1_000;
// Conservative PCM gate for an open mic pointed at room silence. A voiced
// signal can be quiet overall but still has a meaningful peak, so both tests
// must be below threshold before capture is discarded.
export const VOICE_SILENCE_RMS = 0.002;
export const VOICE_SILENCE_PEAK = 0.01;

function toBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}

function resample(chunks, sourceRate) {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!count || !Number.isFinite(sourceRate) || sourceRate <= 0) return new Int16Array();
  const source = new Float32Array(count); let offset = 0;
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length; }
  const length = Math.max(1, Math.round(source.length * VOICE_SAMPLE_RATE / sourceRate));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * sourceRate / VOICE_SAMPLE_RATE;
    const low = Math.min(source.length - 1, Math.floor(position)), high = Math.min(source.length - 1, low + 1), fraction = position - low;
    const sample = Math.max(-1, Math.min(1, source[low] + (source[high] - source[low]) * fraction));
    output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return output;
}

export function isEffectivelySilent(pcm) {
  if (!pcm?.length) return true;
  let energy = 0, peak = 0;
  for (const value of pcm) {
    const normalized = Math.abs(value) / 0x8000;
    energy += normalized * normalized;
    if (normalized > peak) peak = normalized;
  }
  return Math.sqrt(energy / pcm.length) < VOICE_SILENCE_RMS && peak < VOICE_SILENCE_PEAK;
}

function cancelError() { return Object.assign(Error('Voice capture was cancelled.'), { name: 'AbortError' }); }
function stopStream(stream) { for (const track of stream?.getTracks?.() ?? []) track.stop(); }
function closeWithoutWaiting(context) {
  try {
    const closing = context?.close?.();
    if (closing && typeof closing.catch === 'function') void closing.catch(() => {});
  } catch {}
}

async function disposeCapture(current) {
  if (!current) return;
  clearTimeout(current.timeout);
  try { current.processor?.disconnect(); } catch {}
  try { current.sink?.disconnect(); } catch {}
  try { current.source?.disconnect(); } catch {}
  stopStream(current.stream);
  await current.context?.close?.().catch?.(() => {});
}

/**
 * Capture exactly one press. `start` needs to run from the grip's user gesture.
 * It rejects rather than claiming that speech was heard when permission or the
 * microphone is unavailable.
 */
export function createVoiceCapture({ maxDurationMs = VOICE_MAX_DURATION_MS } = {}) {
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < VOICE_MIN_DURATION_MS || maxDurationMs > VOICE_MAX_DURATION_MS) {
    throw new RangeError(`Voice capture duration must be ${VOICE_MIN_DURATION_MS}–${VOICE_MAX_DURATION_MS} ms.`);
  }
  let active, retained;
  const pending = new Set();

  async function stop({ retain = false } = {}) {
    // Permission prompts can leave getUserMedia pending indefinitely. Mark
    // those requests cancelled and return immediately; a late stream is
    // stopped by start() before any AudioContext or processor is adopted.
    for (const request of pending) request.cancel?.();
    const current = active; active = undefined;
    if (!current) {
      const result = retained;
      retained = undefined;
      return result;
    }
    await disposeCapture(current);
    const pcm = resample(current.chunks, current.context.sampleRate);
    const durationMs = Math.round(pcm.length * 1_000 / VOICE_SAMPLE_RATE);
    if (durationMs < VOICE_MIN_DURATION_MS) return undefined;
    if (pcm.byteLength > VOICE_MAX_BYTES) throw Error('Voice capture exceeded its safety limit.');
    if (isEffectivelySilent(pcm)) return undefined;
    const result = Object.freeze({ pcm16leBase64: toBase64(new Uint8Array(pcm.buffer)), sampleRate: VOICE_SAMPLE_RATE, durationMs });
    if (retain) retained = result;
    return result;
  }

  async function start() {
    if (active || [...pending].some(request => !request.cancelled)) throw Error('Voice capture is already active.');
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) {
      throw Error('Microphone capture is unavailable in this browser.');
    }
    let resolveCancelled;
    const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
    const request = {
      cancelled: false,
      cancel() {
        if (request.cancelled) return;
        request.cancelled = true;
        resolveCancelled();
      },
    };
    pending.add(request);
    const begin = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (request.cancelled) { stopStream(stream); throw cancelError(); }
      let context, source, processor, sink;
      const chunks = [];
      try {
        context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
        source = context.createMediaStreamSource(stream);
        // ScriptProcessor is supported in the Quest Chromium path and keeps this
        // package free of a worklet asset or untrusted dynamic script.
        processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = event => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        // Keep ScriptProcessor active without routing live microphone audio to
        // the headset speakers. A direct destination connection produces an
        // audible feedback/echo loop while the wearer is speaking.
        sink = context.createGain(); sink.gain.value = 0;
        source.connect(processor); processor.connect(sink); sink.connect(context.destination);
      } catch (error) {
        stopStream(stream);
        await context?.close?.().catch?.(() => {});
        throw error;
      }
      // A suspended browser AudioContext can leave resume() pending forever.
      // Race it against press cancellation and a local deadline so direct
      // capture callers do not retain a stream/context after the interaction
      // wrapper has already returned.
      let resumeTimer;
      const resumed = Promise.resolve().then(() => context.resume());
      // Always observe a late rejection after cancellation or timeout.
      void resumed.catch(() => {});
      try {
        const outcome = await Promise.race([
          resumed.then(() => 'ready'),
          cancelled.then(() => 'cancelled'),
          new Promise(resolve => { resumeTimer = setTimeout(() => resolve('timeout'), VOICE_RESUME_TIMEOUT_MS); }),
        ]);
        clearTimeout(resumeTimer);
        if (outcome === 'cancelled') throw cancelError();
        if (outcome === 'timeout') {
          request.cancel();
          throw Error('Voice capture audio startup timed out.');
        }
      } catch (error) {
        clearTimeout(resumeTimer);
        stopStream(stream);
        try { processor?.disconnect(); } catch {}
        try { source?.disconnect(); } catch {}
        try { sink?.disconnect(); } catch {}
        closeWithoutWaiting(context);
        throw error;
      }
      const current = { stream, context, source, processor, sink, chunks, timeout: undefined };
      if (request.cancelled) { await disposeCapture(current); throw cancelError(); }
      active = current;
      current.timeout = setTimeout(() => { void stop({ retain: true }).catch(() => {}); }, maxDurationMs);
      return Object.freeze({ sampleRate: context.sampleRate });
    })();
    try { return await begin; }
    finally { pending.delete(request); }
  }

  return Object.freeze({ start, stop, active: () => Boolean(active || [...pending].some(request => !request.cancelled)) });
}
