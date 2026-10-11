/**
 * The Quest 2 failure, driven through the production modules.
 *
 * On a real headset the wearer opened the microphone, the page showed
 * listening, a second press did nothing, and not one audio chunk reached the
 * Mac. The floating talk orb that used to show that state is gone and
 * push-to-talk now means holding A or X, so these tests wire the
 * real button reader to the real talk binding to the real microphone streamer,
 * with only the browser objects faked, and hold the same shape: a microphone
 * request that never returns must not look like listening, and letting go must
 * always end the press.
 *
 * What the wearer sees is the streamer's own state stream, which is what the
 * menu's status row is driven from now. Asserting on it rather than on any
 * drawn surface is why deleting the orb did not delete these cases.
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-ignore Shared JavaScript face-button reader.
import { createXrButtons, FACE_LOWER, TALK_MIN_HOLD_MS } from '../../lab/browser-roundtrip/xr-buttons.mjs';
// @ts-ignore Shared JavaScript talk binding.
import { attachGripPushToTalk } from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Shared JavaScript microphone streamer.
import { createPushToTalkAudio, pushToTalkAudioEvents, primePushToTalkMicrophone, primedPushToTalkStream, pushToTalkMicrophoneState, releasePushToTalkMicrophone, PUSH_TO_TALK_SILENCE_HOLD_MS } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';

/** A MediaRecorder stand-in. `live` false is a recorder that never starts. */
function recorderClass({ live = true }: { live?: boolean } = {}) {
  return class {
    static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
    state = 'inactive';
    mimeType = '';
    ondataavailable: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { error?: unknown }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_stream: unknown, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? '';
      (globalThis as any).__questRecorder = this;
    }
    start() { if (live) this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    emit(bytes: Uint8Array) {
      this.ondataavailable?.({ data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } });
    }
  };
}

/** An XRSession stand-in the talk binding can end. */
function fakeSession() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const source = { handedness: 'right', targetRaySpace: {}, hand: undefined };
  return {
    inputSources: [source] as any[],
    source,
    addEventListener(type: string, handler: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: any) => void) { listeners.get(type)?.delete(handler); },
    emit(type: string, event: any) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
  };
}

/**
 * The shipped talk path, end to end, with a clock the test drives.
 *
 * `talkDown` holds A past `TALK_MIN_HOLD_MS` and `talkUp` lets go, both through
 * the real `createXrButtons` reader, so the hold threshold and the one-mic
 * rule are exercised rather than described. `phase` is the last state the
 * streamer published, which is exactly what the menu's status row shows.
 */
function talkHarness({ getUserMedia, live = true, maxDurationMs }:
  { getUserMedia: () => Promise<any>; live?: boolean; maxDurationMs?: number }) {
  const session = fakeSession();
  // The streamer publishes on the page-wide emitter; clear it between cases.
  const events = pushToTalkAudioEvents();
  events.emit({ state: 'idle' });
  let last: any = { state: 'idle' };
  const off = events.on((event: any) => { if (event?.state) last = event; });
  const sent: any[] = [];
  // A case that names a cap also takes the streamer's timers, so the cap can
  // be fired on demand instead of the test waiting out twenty seconds.
  const timers: { id: number; handler: () => void; delay: number }[] = [];
  let nextTimerId = 1;
  const capped = maxDurationMs === undefined ? {} : {
    maxDurationMs,
    setTimer: (handler: () => void, delay: number) => { const id = nextTimerId++; timers.push({ id, handler, delay }); return id; },
    clearTimer: (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
  };
  const audio = createPushToTalkAudio({
    send: async (args: any) => { sent.push(args); return args.final ? { structuredContent: { transcript: { text: 'show tubulin' } } } : {}; },
    media: { getUserMedia }, recorderFactory: recorderClass({ live }), events,
    micTimeoutMs: 40, recorderStartTimeoutMs: 40, ...capped,
  });
  const talk = attachGripPushToTalk({ session: session as any, send: async () => ({}), audio });
  let clock = 0;
  const failures: string[] = [];
  const buttons = createXrButtons({
    run: (action: string, _binding: any, phase: string) => {
      if (action !== 'push-to-talk') return;
      return phase === 'up' ? talk.stop() : talk.start();
    },
    record: (_kind: string, detail: any) => { if (detail?.outcome === 'failed') failures.push(detail.error); },
    now: () => clock,
  });
  const frame = (down: boolean) => buttons.update([{ handedness: 'right', buttons: down ? FACE_LOWER : 0, axes: [0, 0, 0, 0] }]);
  return {
    session, talk, audio, sent, failures,
    phase: () => last.state,
    message: () => last.message ?? '',
    heard: () => last.text ?? '',
    /** Press A and hold it past the tap threshold: one `down` reaches the binding. */
    talkDown: () => { frame(true); clock += TALK_MIN_HOLD_MS + 1; frame(true); },
    /** Let A go: one `up` reaches the binding. */
    talkUp: () => { frame(false); },
    tick: (ms: number) => { clock += ms; },
    advance: (ms: number) => { clock += ms; },
    dispose: () => { off?.(); },
    recorder: () => (globalThis as any).__questRecorder,
    /** Fire the streamer's own timer of that delay: the duration cap is one. */
    fireTimer: (delay: number) => {
      const index = timers.findIndex(timer => timer.delay === delay);
      if (index < 0) throw Error(`No streamer timer is waiting ${delay} ms.`);
      const [timer] = timers.splice(index, 1);
      timer.handler();
    } };
}

const settle = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };

describe('a talk press on Quest 2', () => {
  it('opens no microphone for a thumb that only brushes the button', async () => {
    // A press too short to carry speech still transcribed the single word
    // "you". Below the hold threshold nothing is dispatched.
    const harness = talkHarness({ getUserMedia: async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] }) });
    harness.talkUp();
    harness.tick(1);
    harness.talkUp();
    await settle();
    expect(harness.phase()).toBe('idle');
    expect(harness.sent).toHaveLength(0);
    harness.dispose();
  });

  it('does not claim to be listening while the microphone request is unanswered', async () => {
    // This is the headset failure exactly: Quest cannot draw a permission
    // prompt over an immersive session, so the request never settles.
    const harness = talkHarness({ getUserMedia: () => new Promise(() => {}) });
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('requesting-microphone');
    expect(harness.phase()).not.toBe('recording');
    expect(harness.sent).toHaveLength(0);
    harness.dispose();
  });

  it('stops when the thumb comes off even though the microphone never opened', async () => {
    const harness = talkHarness({ getUserMedia: () => new Promise(() => {}) });
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('requesting-microphone');
    harness.talkUp();
    await settle();
    expect(harness.talk.listening()).toBe(false);
    // A press that recorded nothing must not post a final marker for an
    // utterance the Mac has never seen a byte of.
    expect(harness.sent).toHaveLength(0);
    // And the button is usable again rather than stuck.
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('requesting-microphone');
    harness.dispose();
  });

  it('gives up on an unanswered microphone with a message the menu can show', async () => {
    const harness = talkHarness({ getUserMedia: () => new Promise(() => {}) });
    harness.talkDown();
    await settle();
    await new Promise(done => setTimeout(done, 60));
    await settle();
    expect(harness.phase()).toBe('error');
    expect(harness.message()).toMatch(/microphone/i);
    harness.dispose();
  });

  it('reports a refused microphone rather than showing listening over it', async () => {
    const denied = Object.assign(Error('Permission denied'), { name: 'NotAllowedError' });
    const harness = talkHarness({ getUserMedia: async () => { throw denied; } });
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('error');
    expect(harness.message()).toMatch(/permission was declined/i);
    // The refusal gives the press back rather than ending voice for the session.
    expect(harness.talk.listening()).toBe(false);
    harness.dispose();
  });

  it('reports a recorder that never starts', async () => {
    const harness = talkHarness({ getUserMedia: async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] }), live: false });
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('requesting-microphone');
    await new Promise(done => setTimeout(done, 60));
    await settle();
    expect(harness.phase()).toBe('error');
    expect(harness.message()).toMatch(/did not start recording/i);
    harness.dispose();
  });

  it('keeps answering presses after the streamer ends an utterance by itself', async () => {
    // The Quest 2 second-press failure. The wearer talked past the duration
    // cap, so the streamer called its own stop and the binding never saw a
    // release. The hold it was still keeping made every later press a silent
    // no-op: nothing opened, and twelve seconds later the wearer was told to
    // leave VR and allow a microphone that was already granted.
    const tracks = [{ readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; } }];
    const harness = talkHarness({ getUserMedia: async () => ({ getTracks: () => tracks }), maxDurationMs: 5_000 });
    const utterances: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      harness.talkDown();
      await settle();
      expect(harness.phase()).toBe('recording');
      harness.recorder().emit(new Uint8Array([attempt + 1]));
      await settle();
      // The wearer keeps talking; the cap ends the utterance, not the wearer.
      harness.fireTimer(5_000);
      await settle();
      expect(harness.phase()).toBe('heard');
      expect(harness.talk.listening()).toBe(false);
      utterances.push(harness.sent.at(-1).utteranceId);
      harness.talkUp();
      await settle();
    }
    // Three presses, three utterances, each closed with its own final marker.
    expect(new Set(utterances).size).toBe(3);
    expect(harness.sent.filter((args: any) => args.final)).toHaveLength(3);
    // A fourth press still opens the microphone, and the grant was never
    // given up between them.
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('recording');
    expect(tracks[0].readyState).toBe('live');
    await harness.audio.stop();
    harness.dispose();
  });

  it('opens exactly one microphone for one hold, however many frames it spans', async () => {
    const harness = talkHarness({ getUserMedia: async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] }), maxDurationMs: 5_000 });
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('recording');
    harness.recorder().emit(new Uint8Array([7]));
    await settle();
    const opened = harness.sent[0].utteranceId;
    // More frames with the thumb still down add nothing.
    harness.talkDown();
    await settle();
    harness.talkUp();
    await settle();
    expect(harness.phase()).toBe('heard');
    expect(new Set(harness.sent.map((args: any) => args.utteranceId)).size).toBe(1);
    expect(harness.sent[0].utteranceId).toBe(opened);
    harness.dispose();
  });

  it('listens, records and hands the transcript back on a healthy hold', async () => {
    const harness = talkHarness({ getUserMedia: async () => ({ getTracks: () => [{ readyState: 'live', stop() {} }] }) });
    harness.talkDown();
    await settle();
    expect(harness.phase()).toBe('recording');
    harness.recorder().emit(new Uint8Array([1, 2, 3]));
    await settle();
    harness.talkUp();
    await settle();
    expect(harness.sent.map((args: any) => args.final)).toEqual([false, true]);
    expect(harness.sent[0].mime).toBe('audio/webm;codecs=opus');
    expect(harness.phase()).toBe('heard');
    expect(harness.heard()).toBe('show tubulin');
    expect(harness.failures).toEqual([]);
    harness.dispose();
  });
});

describe('the microphone grant taken on Enter VR', () => {
  it('asks once, keeps the stream, and hands it to the first press muted until then', async () => {
    releasePushToTalkMicrophone();
    const tracks = [{ readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; } }];
    const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
    const first = await primePushToTalkMicrophone({ media: { getUserMedia } });
    expect(first.state).toBe('granted');
    expect(pushToTalkMicrophoneState()).toBe('granted');
    // Held, not listening: the headset's recording indicator stays off.
    expect(tracks[0].enabled).toBe(false);
    const second = await primePushToTalkMicrophone({ media: { getUserMedia } });
    expect(second.state).toBe('granted');
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    const pressMedia = { getUserMedia: vi.fn(async () => { throw Error('A press must not prompt again.'); }) };
    const audio = createPushToTalkAudio({ send: async () => ({}), media: pressMedia, recorderFactory: recorderClass() });
    await audio.start();
    expect(pressMedia.getUserMedia).not.toHaveBeenCalled();
    expect(tracks[0].enabled).toBe(true);
    expect(primedPushToTalkStream()).toBeDefined();
    await audio.stop();
    // Between presses the microphone goes quiet again without being given up.
    expect(tracks[0].enabled).toBe(false);
    releasePushToTalkMicrophone();
  });

  it('reports a refusal instead of rejecting into the Enter VR handler', async () => {
    releasePushToTalkMicrophone();
    const denied = Object.assign(Error('Permission denied'), { name: 'NotAllowedError' });
    const outcome = await primePushToTalkMicrophone({ media: { getUserMedia: async () => { throw denied; } } });
    expect(outcome.state).toBe('denied');
    expect(outcome.message).toMatch(/allow it in the browser/i);
    expect(pushToTalkMicrophoneState()).toBe('denied');
    releasePushToTalkMicrophone();
  });

  it('stops waiting for a prompt nobody answered, and adopts a late grant', async () => {
    releasePushToTalkMicrophone();
    let grant: ((stream: unknown) => void) | undefined;
    const tracks = [{ readyState: 'live', enabled: true, stop() {} }];
    const outcome = await primePushToTalkMicrophone({
      media: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) }, timeoutMs: 5,
    });
    expect(outcome.state).toBe('pending-prompt');
    grant!({ getTracks: () => tracks });
    await settle();
    expect(pushToTalkMicrophoneState()).toBe('granted');
    expect(tracks[0].enabled).toBe(false);
    releasePushToTalkMicrophone();
  });
});

describe('a press that ends itself', () => {
  it('stops after silence once the wearer has actually spoken', async () => {
    const timers: { handler: () => void; delay: number }[] = [];
    let level = 0, clock = 0;
    const tracks = [{ readyState: 'live', enabled: true, stop() {} }];
    const audio = createPushToTalkAudio({
      send: async () => ({}), media: { getUserMedia: async () => ({ getTracks: () => tracks }) },
      recorderFactory: recorderClass(),
      // A stand-in analyser: `read` is the loudness the meter would report.
      audioContextFactory: class {
        createAnalyser() { return { fftSize: 1024, smoothingTimeConstant: 0, getFloatTimeDomainData(samples: Float32Array) { samples.fill(level); } }; }
        createMediaStreamSource() { return { connect() {} }; }
        close() {}
      } as any,
      now: () => clock,
      setTimer: (handler: () => void, delay: number) => { timers.push({ handler, delay }); return timers.length - 1; },
      clearTimer: () => {},
    });
    await audio.start();
    expect(audio.recording()).toBe(true);
    const run = (ms: number) => { clock += ms; const next = timers.pop(); next?.handler(); };
    // Silence before any speech must not take the press away.
    level = 0;
    for (let step = 0; step < 40; step++) run(100);
    expect(audio.recording()).toBe(true);
    // The wearer speaks, then stops.
    level = 0.5;
    for (let step = 0; step < 5; step++) run(100);
    expect(audio.recording()).toBe(true);
    level = 0;
    for (let step = 0; step < Math.ceil(PUSH_TO_TALK_SILENCE_HOLD_MS / 100) + 2; step++) run(100);
    await settle();
    expect(audio.recording()).toBe(false);
  });
});
