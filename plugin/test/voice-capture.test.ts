import { describe, expect, it, vi } from 'vitest';
// @ts-ignore Shared browser module is bundled by the roundtrip build.
import { createVoiceCapture, isEffectivelySilent, VOICE_RESUME_TIMEOUT_MS } from '../../lab/browser-roundtrip/voice-capture.mjs';

describe('browser voice capture lifecycle', () => {
  it('rejects room-level silence but preserves a quiet voiced signal', () => {
    const silence = new Int16Array(24_000);
    const roomNoise = new Int16Array(24_000); roomNoise.fill(32);
    const quietVoice = new Int16Array(24_000);
    for (let index = 0; index < quietVoice.length; index++) quietVoice[index] = Math.round(Math.sin(index / 5) * 360);
    expect(isEffectivelySilent(silence)).toBe(true);
    expect(isEffectivelySilent(roomNoise)).toBe(true);
    expect(isEffectivelySilent(quietVoice)).toBe(false);
  });

  it('cancels a never-resolving permission request immediately', async () => {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = createVoiceCapture();
    void capture.start();
    await Promise.resolve();

    const stopped = capture.stop();
    await expect(Promise.race([
      stopped,
      new Promise((_, reject) => setTimeout(() => reject(Error('permission cancellation timed out')), 50)),
    ])).resolves.toBeUndefined();
    expect(capture.active()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('stops a late stream from a cancelled permission request', async () => {
    let resolvePermission!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { resolvePermission = resolve; }));
    const tracks = [{ stop: vi.fn() }];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = createVoiceCapture();
    const starting = capture.start();
    await Promise.resolve();
    await capture.stop();
    resolvePermission(stream);

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(capture.active()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('cancels a hanging AudioContext resume without retaining the stream or blocking a new start', async () => {
    let resolveFirstPermission!: (stream: MediaStream) => void;
    let rejectFirstResume!: (error: Error) => void;
    let contextCount = 0;
    const contexts: Array<{ resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const tracks = [{ stop: vi.fn() }];
    const firstStream = { getTracks: () => tracks } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => contextCount === 0
      ? new Promise<MediaStream>(resolve => { resolveFirstPermission = resolve; })
      : Promise.resolve({ getTracks: () => [] } as unknown as MediaStream));
    class FakeAudioContext {
      sampleRate = 24_000;
      destination = {};
      readonly id: number;
      readonly resume = vi.fn(() => {
        if (this.id === 0) return new Promise<void>((_, reject) => { rejectFirstResume = reject; });
        return Promise.resolve();
      });
      readonly close = vi.fn(async () => {});
      constructor() {
        this.id = contextCount++;
        contexts.push(this as unknown as typeof contexts[number]);
      }
      createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
      createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: undefined }; }
      createGain() { return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }; }
    }
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = createVoiceCapture();
    const first = capture.start();
    await Promise.resolve();
    resolveFirstPermission(firstStream);
    await Promise.resolve();
    await Promise.resolve();

    const stopping = capture.stop();
    await expect(Promise.race([
      stopping,
      new Promise((_, reject) => setTimeout(() => reject(Error('resume cancellation timed out')), 50)),
    ])).resolves.toBeUndefined();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();

    const second = capture.start();
    await expect(second).resolves.toMatchObject({ sampleRate: 24_000 });
    expect(contexts).toHaveLength(2);
    await capture.stop();

    // The original resume can reject after cancellation; its rejection must
    // remain observed while the new capture is already usable.
    rejectFirstResume(Error('late resume rejection'));
    await Promise.resolve();
    expect(capture.active()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('bounds a direct capture startup when AudioContext resume never settles', async () => {
    const tracks = [{ stop: vi.fn() }];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    let closed = 0;
    class HangingAudioContext {
      sampleRate = 24_000;
      destination = {};
      async resume() { return new Promise<void>(() => {}); }
      async close() { closed += 1; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: undefined }; }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    }
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('AudioContext', HangingAudioContext);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = createVoiceCapture();
    const started = capture.start().then(() => undefined, (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, VOICE_RESUME_TIMEOUT_MS + 10));
    await expect(started).resolves.toMatchObject({ message: 'Voice capture audio startup timed out.' });
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(closed).toBe(1);
    vi.unstubAllGlobals();
  }, VOICE_RESUME_TIMEOUT_MS + 1_000);
});
