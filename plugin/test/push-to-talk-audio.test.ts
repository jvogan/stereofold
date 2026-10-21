import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// @ts-ignore Shared JavaScript headset microphone streamer.
import { createPushToTalkAudio, createPushToTalkAudioEvents, pushToTalkAudioStream, setPushToTalkAudioSender, transcriptFromResult, PUSH_TO_TALK_AUDIO_MAX_CHUNK_BYTES, PUSH_TO_TALK_AUDIO_TIMESLICE_MS, PUSH_TO_TALK_AUDIO_DEFAULT_MAX_DURATION_MS, PUSH_TO_TALK_AUDIO_MAX_DURATION_MS, PUSH_TO_TALK_SILENCE_HOLD_MS, primePushToTalkMicrophone, pushToTalkMicrophoneState, releasePushToTalkMicrophone, primedPushToTalkStream } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';
// @ts-ignore Shared JavaScript grip binding, the same one the companion bundles.
import { attachGripPushToTalk } from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
import { TOOLS } from '../src/inspection-companion-http.js';
import { ALLOWED_TOOLS } from '../src/inspection-lan.js';

/** Minimal XRSession stand-in carrying a described input source list. */
function gripSession(sources: unknown[] = []) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    inputSources: sources as any[],
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) { listeners.get(type)?.delete(handler); },
    emit(type: string, event: unknown = {}) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

/** A MediaRecorder stand-in whose chunks a test hands over on demand. */
function fakeRecorder(record: { started: number[]; stopped: number }) {
  return class {
    static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
    state = 'inactive';
    ondataavailable: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { error?: unknown }) => void) | null = null;
    onstop: (() => void) | null = null;
    readonly mimeType: string;
    constructor(_stream: unknown, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? '';
      (globalThis as any).__recorder = this;
    }
    start(timeslice?: number) { this.state = 'recording'; record.started.push(timeslice ?? 0); }
    stop() { this.state = 'inactive'; record.stopped += 1; this.onstop?.(); }
    /** Deliver one timeslice the way the browser would. */
    emit(bytes: Uint8Array) { this.ondataavailable?.({ data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } }); }
  };
}

function harness(options: { sendResult?: any; getUserMedia?: () => Promise<any>; now?: () => number } = {}) {
  const record = { started: [] as number[], stopped: 0 };
  const Recorder = fakeRecorder(record);
  const sent: any[] = [];
  const tracks = [{ readyState: 'live', stop: vi.fn(() => { tracks[0]!.readyState = 'ended'; }) }];
  const media = {
    getUserMedia: options.getUserMedia ?? vi.fn(async () => ({ getTracks: () => tracks })),
  };
  const events = createPushToTalkAudioEvents();
  const seen: any[] = [];
  events.on((event: any) => { seen.push(event); });
  let id = 0;
  const audio = createPushToTalkAudio({
    send: async (args: any) => { sent.push(args); return args.final ? (options.sendResult ?? { structuredContent: { transcript: { text: 'open the microtubule lattice' } } }) : {}; },
    media, recorderFactory: Recorder, events,
    newId: () => `0000000${id++}-0000-4000-8000-000000000000`,
    setTimer: () => 0 as any, clearTimer: () => {},
    ...(options.now ? { now: options.now } : {}),
  });
  return { audio, sent, seen, record, media, tracks, recorder: () => (globalThis as any).__recorder as InstanceType<typeof Recorder> };
}

const state = (seen: any[]) => seen.map(event => event.state);

describe('an empty press', () => {
  /**
   * A press on a Quest 2 can end with nothing to act on. Telling a
   * wearer who tapped the grip that no speech was recognized reads as a broken
   * microphone, so the two cases are separated.
   */
  it('tells a wearer who tapped the grip to hold it', async () => {
    const { audio, seen, recorder } = harness({ sendResult: {} });
    await audio.start();
    recorder().emit(new Uint8Array([1, 2, 3]));
    await audio.stop();
    expect(seen.at(-1)).toMatchObject({ state: 'heard', text: '', message: 'Hold the grip while you speak.' });
  });

  it('still reports silence for a press long enough to hold a sentence', async () => {
    let clock = 0;
    const { audio, seen, recorder } = harness({ sendResult: {}, now: () => clock });
    await audio.start();
    recorder().emit(new Uint8Array([1, 2, 3]));
    clock += 5_000;
    await audio.stop();
    expect(seen.at(-1)).toMatchObject({ state: 'heard', text: '', message: "Didn't catch that. Please speak again." });
  });
});

describe('headset microphone streaming', () => {
  it('records with a one-second timeslice and posts each chunk in order', async () => {
    const { audio, sent, record, recorder } = harness();
    await audio.start();
    expect(record.started).toEqual([PUSH_TO_TALK_AUDIO_TIMESLICE_MS]);
    recorder().emit(new Uint8Array([1, 2, 3]));
    recorder().emit(new Uint8Array([4, 5, 6]));
    await audio.stop();
    expect(sent.map(args => args.seq)).toEqual([0, 1, 2]);
    expect(sent.every(args => args.mime === 'audio/webm;codecs=opus')).toBe(true);
    expect(sent.every(args => args.utteranceId === sent[0].utteranceId)).toBe(true);
    expect(sent.slice(0, 2).map(args => args.final)).toEqual([false, false]);
    expect(Buffer.from(sent[0].data, 'base64')).toEqual(Buffer.from([1, 2, 3]));
  });

  it('waits for a chunk still being read before sending the final marker', async () => {
    const { audio, sent, recorder } = harness();
    await audio.start();
    // A Blob whose read resolves two microtasks late, the way a real one does.
    let release: (() => void) | undefined;
    const slow = new Promise<void>(done => { release = done; });
    recorder().ondataavailable!({ data: { arrayBuffer: async () => { await slow; return new Uint8Array([7, 7]).buffer; } } });
    const stopping = audio.stop();
    release!();
    await stopping;
    expect(sent.map(args => [args.seq, args.final])).toEqual([[0, false], [1, true]]);
    expect(Buffer.from(sent[0].data, 'base64')).toEqual(Buffer.from([7, 7]));
  });

  it('closes the utterance with a data-free final marker', async () => {
    const { audio, sent, recorder } = harness();
    await audio.start();
    recorder().emit(new Uint8Array([9]));
    await audio.stop();
    const last = sent[sent.length - 1];
    expect(last.final).toBe(true);
    expect(last.data).toBeUndefined();
  });

  it('publishes recording, uploading, transcribing and heard through the emitter', async () => {
    const { audio, seen, recorder } = harness();
    await audio.start();
    recorder().emit(new Uint8Array([1]));
    const transcript = await audio.stop();
    expect(transcript?.text).toBe('open the microtubule lattice');
    expect(state(seen)).toEqual(['idle', 'requesting-microphone', 'recording', 'uploading', 'transcribing', 'heard']);
    expect(seen[seen.length - 1].text).toBe('open the microtubule lattice');
  });

  it('splits an oversized chunk instead of exceeding the transport cap', async () => {
    const { audio, sent, recorder } = harness();
    await audio.start();
    recorder().emit(new Uint8Array(PUSH_TO_TALK_AUDIO_MAX_CHUNK_BYTES + 32));
    await audio.stop();
    const carrying = sent.filter(args => args.data);
    expect(carrying).toHaveLength(2);
    expect(Buffer.from(carrying[0].data, 'base64').length).toBe(PUSH_TO_TALK_AUDIO_MAX_CHUNK_BYTES);
    expect(Buffer.from(carrying[1].data, 'base64').length).toBe(32);
    expect(carrying.map(args => args.seq)).toEqual([0, 1]);
  });

  it('stops an utterance that reaches the size cap', async () => {
    const record = { started: [] as number[], stopped: 0 };
    const Recorder = fakeRecorder(record);
    const audio = createPushToTalkAudio({
      send: async () => ({}), media: { getUserMedia: async () => ({ getTracks: () => [] }) },
      recorderFactory: Recorder, maxBytes: 64, setTimer: () => 0 as any, clearTimer: () => {},
    });
    await audio.start();
    (globalThis as any).__recorder.emit(new Uint8Array(128));
    await new Promise(done => setTimeout(done, 0));
    expect(record.stopped).toBeGreaterThan(0);
    await audio.stop();
  });

  it('caps an utterance at twenty seconds through its own timer', async () => {
    let fired: (() => void) | undefined;
    let delay = 0;
    const record = { started: [] as number[], stopped: 0 };
    const audio = createPushToTalkAudio({
      send: async () => ({}), media: { getUserMedia: async () => ({ getTracks: () => [] }) },
      recorderFactory: fakeRecorder(record),
      setTimer: (handler: () => void, ms: number) => { fired = handler; delay = ms; return 0 as any; },
      clearTimer: () => {},
    });
    await audio.start();
    expect(delay).toBe(PUSH_TO_TALK_AUDIO_DEFAULT_MAX_DURATION_MS);
    expect(delay).toBe(20_000);
    expect(audio.recording()).toBe(true);
    fired!();
    await new Promise(done => setTimeout(done, 0));
    expect(record.stopped).toBe(1);
  });

  it('refuses a cap wider than the transport will carry', () => {
    expect(() => createPushToTalkAudio({ send: async () => ({}), maxDurationMs: PUSH_TO_TALK_AUDIO_MAX_DURATION_MS + 1 }))
      .toThrow(RangeError);
    expect(PUSH_TO_TALK_AUDIO_DEFAULT_MAX_DURATION_MS).toBeLessThan(PUSH_TO_TALK_AUDIO_MAX_DURATION_MS);
  });

  it('reports a declined permission rather than claiming it is listening', async () => {
    const denied = Object.assign(Error('Permission denied'), { name: 'NotAllowedError' });
    const { audio, seen } = harness({ getUserMedia: async () => { throw denied; } });
    await expect(audio.start()).rejects.toThrow('Permission denied');
    expect(state(seen)).toEqual(['idle', 'requesting-microphone', 'error']);
    expect(seen[seen.length - 1].message).toMatch(/permission was declined/i);
    expect(audio.recording()).toBe(false);
  });

  it('asks for the microphone once and keeps the stream between presses', async () => {
    const { audio, media, recorder } = harness();
    await audio.start();
    recorder().emit(new Uint8Array([1]));
    await audio.stop();
    await audio.start();
    await audio.stop();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('stops the microphone track on dispose', async () => {
    const { audio, tracks } = harness();
    await audio.start();
    await audio.dispose();
    expect(tracks[0]!.stop).toHaveBeenCalled();
    await expect(audio.start()).rejects.toThrow(/disposed/);
  });

  it('says nothing was recognized when the Mac heard no speech', async () => {
    const { audio, seen, recorder } = harness({ sendResult: { structuredContent: { transcript: { text: '' } } } });
    await audio.start();
    recorder().emit(new Uint8Array([1]));
    expect(await audio.stop()).toBeUndefined();
    expect(seen[seen.length - 1]).toMatchObject({ state: 'heard', text: '' });
  });

  it('surfaces a failed upload as an error, not as silence', async () => {
    const record = { started: [] as number[], stopped: 0 };
    const events = createPushToTalkAudioEvents();
    const seen: any[] = [];
    events.on((event: any) => seen.push(event));
    const audio = createPushToTalkAudio({
      send: async () => { throw Error('the host went away'); },
      media: { getUserMedia: async () => ({ getTracks: () => [] }) },
      recorderFactory: fakeRecorder(record), events, setTimer: () => 0 as any, clearTimer: () => {},
    });
    await audio.start();
    await audio.stop();
    expect(seen[seen.length - 1]).toMatchObject({ state: 'error' });
  });

  it('reads a transcript out of either result shape', () => {
    expect(transcriptFromResult({ structuredContent: { transcript: { text: ' hello ' } } })?.text).toBe('hello');
    expect(transcriptFromResult({ transcript: { text: 'hi' } })?.text).toBe('hi');
    expect(transcriptFromResult({ text: 'top level' })?.text).toBe('top level');
    expect(transcriptFromResult({ structuredContent: { reason: 'failed' } })).toBeUndefined();
  });
});

describe('opt-in and event emitter', () => {
  it('builds no streamer until the page registers a sender', () => {
    setPushToTalkAudioSender(undefined);
    expect(pushToTalkAudioStream()).toBeUndefined();
    setPushToTalkAudioSender(async () => ({}));
    expect(pushToTalkAudioStream()).toBeDefined();
    setPushToTalkAudioSender(undefined);
  });

  it('replays the latest state to a new subscriber and survives a throwing one', () => {
    const events = createPushToTalkAudioEvents();
    events.emit({ state: 'recording' });
    const seen: any[] = [];
    events.on(() => { throw Error('bad subscriber'); });
    const off = events.on((event: any) => seen.push(event));
    expect(seen).toEqual([{ state: 'recording' }]);
    events.emit({ state: 'heard', text: 'x' });
    expect(seen).toHaveLength(2);
    off();
    events.emit({ state: 'idle' });
    expect(seen).toHaveLength(2);
  });
});

describe('transport registration', () => {
  it('is reachable through the loopback companion and the private Wi-Fi listener', () => {
    expect(TOOLS.has('push_to_talk_audio')).toBe(true);
    expect(ALLOWED_TOOLS.has('push_to_talk_audio')).toBe(true);
  });

  it('never exposes the transcript poll to the network', () => {
    expect(TOOLS.has('poll_voice_transcripts')).toBe(false);
    expect(ALLOWED_TOOLS.has('poll_voice_transcripts')).toBe(false);
  });

  it('never exposes the agent listener to the network either', () => {
    expect(TOOLS.has('listen_voice')).toBe(false);
    expect(ALLOWED_TOOLS.has('listen_voice')).toBe(false);
  });

  it('lets the headset receive an answer but never write one', () => {
    // A caption reaches the page on the heartbeat it already runs. A paired
    // device asking to speak as the agent gets a 400 instead.
    expect(TOOLS.has('say_to_headset')).toBe(false);
    expect(ALLOWED_TOOLS.has('say_to_headset')).toBe(false);
    expect(TOOLS.has('poll_inspection')).toBe(true);
    expect(ALLOWED_TOOLS.has('poll_inspection')).toBe(true);
  });

  it('registers both tools app-only on the MCP server', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/inspection-server.ts', import.meta.url)), 'utf8');
    for (const name of ['push_to_talk_audio', 'poll_voice_transcripts']) {
      const at = source.indexOf(`privateTool('stereo_structure.${name}'`);
      expect(at, `${name} must be registered`).toBeGreaterThan(-1);
      expect(source.slice(at, at + 1_400)).toContain('_meta:privateUi');
    }
  });

  it('starts recording when the held button opens and stops when it closes', async () => {
    const session = gripSession([{ handedness: 'left', targetRayMode: 'tracked-pointer', profiles: ['oculus-touch-v3', 'oculus-touch'] }]);
    const sent: string[] = [], recorder: string[] = [];
    const talk = attachGripPushToTalk({ session, send: async (state: string) => { sent.push(state); },
      audio: { start: async () => { recorder.push('start'); }, stop: async () => { recorder.push('stop'); }, dispose: async () => {} } });
    await talk.start();
    await talk.stop();
    await talk.dispose();
    expect(recorder).toEqual(['start', 'stop']);
    expect(sent).toEqual(['down', 'up']);
  });

  it('opens one microphone per press: version 2 shuts the version 1 capture off', async () => {
    const session = gripSession([{ handedness: 'left', targetRayMode: 'tracked-pointer', profiles: ['oculus-touch-v3', 'oculus-touch'] }]);
    const v1: string[] = [], v2: string[] = [];
    const talk = attachGripPushToTalk({ session, send: async () => {},
      interaction: { start: async () => { v1.push('start'); }, stop: async () => { v1.push('stop'); } },
      capture: { start: async () => { v1.push('capture'); }, stop: async () => undefined },
      audio: { start: async () => { v2.push('start'); }, stop: async () => { v2.push('stop'); }, dispose: async () => {} } });
    await talk.start();
    await talk.stop();
    await talk.dispose();
    expect(v2).toEqual(['start', 'stop']);
    expect(v1).toEqual([]);
  });

  it('reaches the standalone host agent route but not by any other name', async () => {
    const host = await readFile(fileURLToPath(new URL('../scripts/serve-inspection.ts', import.meta.url)), 'utf8');
    expect(host).toContain("'push_to_talk_audio','poll_voice_transcripts'");
    expect(host).toContain('STEREOFOLD_PTT_TRANSCRIBE');
  });
});

describe('who can press to talk', () => {
  const touch = (handedness: string) => ({ handedness, targetRayMode: 'tracked-pointer',
    profiles: ['oculus-touch-v3', 'oculus-touch', 'generic-trigger-squeeze-thumbstick'] });
  const hand = (handedness: string) => ({ handedness, targetRayMode: 'tracked-pointer',
    profiles: ['generic-hand-select-grasp', 'generic-hand'], hand: new Map([['wrist', {}]]) });
  const streamer = (log: string[]) => ({ start: async () => { log.push('start'); }, stop: async () => { log.push('stop'); }, dispose: async () => {} });

  it('binds no squeeze at all, whatever the wearer is holding', async () => {
    // Push-to-talk left the grips so both grips could grab the
    // structure. It is a held A or X now, and the menu's Talk row for a wearer
    // with no controller; neither reaches this module through a squeeze.
    for (const sources of [[hand('left'), hand('right')], [touch('left'), touch('right')]]) {
      const session = gripSession(sources);
      const log: string[] = [];
      const talk = attachGripPushToTalk({ session, send: async () => {}, audio: streamer(log) });
      expect(session.count('squeezestart')).toBe(0);
      expect(session.count('squeezeend')).toBe(0);
      expect(session.count('squeezecancel')).toBe(0);
      // The one press path still runs the whole version 2 path.
      await talk.start();
      await talk.stop();
      expect(log).toEqual(['start', 'stop']);
      await talk.dispose();
    }
  });

  it('does not care which controllers come and go mid-session', async () => {
    const session = gripSession([hand('left')]);
    const log: string[] = [];
    const talk = attachGripPushToTalk({ session, send: async () => {}, audio: streamer(log) });
    session.inputSources = [touch('left'), touch('right')];
    session.emit('inputsourceschange', { added: session.inputSources, removed: [] });
    await talk.start();
    await talk.stop();
    session.inputSources = [hand('left')];
    session.emit('inputsourceschange', { added: [], removed: [] });
    await talk.start();
    await talk.stop();
    expect(log).toEqual(['start', 'stop', 'start', 'stop']);
    await talk.dispose();
  });

  it('gives the menu a state stream and a level only while version 2 is running', async () => {
    const withV2 = gripSession([touch('left')]);
    const grip = attachGripPushToTalk({ session: withV2, send: async () => {},
      audio: { start: async () => {}, stop: async () => {}, dispose: async () => {}, level: () => 0.42 } });
    expect(typeof grip.subscribe).toBe('function');
    expect(grip.level()).toBe(0.42);
    await grip.dispose();

    const withoutV2 = gripSession([touch('left')]);
    const bare = attachGripPushToTalk({ session: withoutV2, send: async () => {}, audio: null });
    expect(bare.subscribe).toBeUndefined();
    expect(bare.level()).toBeUndefined();
    await bare.dispose();
  });
});


it('records release and transcript receipt for the same utterance',async()=>{
  const entries:any[]=[];
  vi.stubGlobal('__stereofoldDiagnostics',{record:(kind:string,detail:any)=>entries.push({kind,detail})});
  try {
    const {audio,recorder}=harness();
    const utteranceId=await audio.start();recorder().emit(new Uint8Array([1]));
    await audio.stop();
    expect(entries.filter(e=>e.kind==='voice-loop').map(e=>e.detail)).toEqual([
      {stage:'microphone-release',utteranceId},{stage:'transcript-received',utteranceId}]);
  } finally {vi.unstubAllGlobals();}
});
