import { expect, it, vi } from 'vitest';
// @ts-ignore The production headset recorder, with browser/transport adapters below.
import { createPushToTalkAudio, createPushToTalkAudioEvents } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(options: { send?: (args: any) => Promise<any>; grant?: Promise<any>; maxBytes?: number; setTimer?: (handler: () => void, delay: number) => number } = {}) {
  const track = { readyState: 'live', enabled: false, stop: vi.fn(() => { track.readyState = 'ended'; }) };
  const stream = { getTracks: () => [track] };
  const recorders: Recorder[] = [], sent: any[] = [], seen: any[] = [];
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    ondataavailable?: (event: any) => void; onstop?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    emit(bytes: number[]) { this.ondataavailable?.({ data: { arrayBuffer: async () => Uint8Array.from(bytes).buffer } }); }
  }
  const events = createPushToTalkAudioEvents(); events.on((event: any) => seen.push(event));
  let nextId = 0;
  const audio = createPushToTalkAudio({ events, recorderFactory: Recorder,
    media: { getUserMedia: async () => options.grant ? options.grant : stream },
    send: async (args: any) => { sent.push(args); return options.send ? options.send(args) : args.final ? { transcript: { text: 'next' } } : {}; },
    newId: () => `press-${++nextId}`, setTimer: options.setTimer ?? (() => 0), clearTimer() {},
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return { audio, track, stream, recorders, sent, seen };
}

it('a failed upload refuses that recording, then a fresh press reaches the recovered host', async () => {
  let fail = true;
  const f = fixture({ send: async args => { if (fail) throw Error('Host disconnected'); return args.final ? { transcript: { text: 'next' } } : {}; } });
  try {
    await f.audio.start(); f.recorders[0]!.emit([1, 2]);
    expect(await f.audio.stop()).toBeUndefined();
    expect(f.seen.at(-1)).toMatchObject({ state: 'error', utteranceId: 'press-1' });
    fail = false;
    await f.audio.start(); f.recorders[1]!.emit([3, 4]);
    expect(await f.audio.stop()).toMatchObject({ text: 'next' });
    expect(f.sent.filter(args => args.utteranceId === 'press-2').map(args => [args.seq, args.final])).toEqual([[0, false], [1, true]]);
  } finally { await f.audio.dispose(); }
});

it('an oversized recording never sends a final marker or executes a transcript of its truncated prefix', async () => {
  const f = fixture({ maxBytes: 3 });
  try {
    await f.audio.start(); f.recorders[0]!.emit([1, 2]); await tick();
    f.recorders[0]!.emit([3, 4]); await tick();
    expect(await f.audio.stop()).toBeUndefined();
    expect(f.sent.some(args => args.final)).toBe(false);
    expect(f.seen.at(-1)).toMatchObject({ state: 'error', utteranceId: 'press-1' });
    expect(f.seen.some(event => event.state === 'heard')).toBe(false);
    await f.audio.start(); f.recorders[1]!.emit([5]);
    expect(await f.audio.stop()).toMatchObject({ text: 'next' });
  } finally { await f.audio.dispose(); }
});

it('cancel during transcription retires the old reply while a subsequent press still works', async () => {
  const answer = deferred<any>();
  const f = fixture({ send: async args => args.final ? args.utteranceId === 'press-1' ? answer.promise : { transcript: { text: 'back' } } : {} });
  try {
    await f.audio.start(); f.recorders[0]!.emit([1]);
    const stopping = f.audio.stop(); await tick();
    await f.audio.cancel();
    await f.audio.start(); f.recorders[1]!.emit([2]);
    answer.resolve({ transcript: { text: 'next' } });
    expect(await stopping).toBeUndefined();
    expect(f.track.enabled).toBe(true);
    expect(await f.audio.stop()).toMatchObject({ text: 'back' });
    expect(f.seen.filter(event => event.state === 'heard').map(event => event.text)).toEqual(['back']);
  } finally { await f.audio.dispose(); }
});

it('cancel drops a delayed Blob read without muting or overwriting the next recording', async () => {
  const bytes = deferred<ArrayBuffer>(); const f = fixture();
  try {
    await f.audio.start();
    f.recorders[0]!.ondataavailable!({ data: { arrayBuffer: () => bytes.promise } });
    const cancelling = f.audio.cancel();
    await f.audio.start();
    bytes.resolve(Uint8Array.from([1]).buffer); await cancelling;
    expect(f.track.enabled).toBe(true);
    expect(f.seen.at(-1)).toMatchObject({ state: 'recording', utteranceId: 'press-2' });
    expect(f.sent).toHaveLength(0);
    f.recorders[1]!.emit([2]); expect(await f.audio.stop()).toMatchObject({ text: 'next' });
  } finally { await f.audio.dispose(); }
});

it('an unreadable chunk refuses the recording instead of transcribing a partial prefix', async () => {
  const f = fixture();
  try {
    await f.audio.start(); f.recorders[0]!.emit([1]); await tick();
    f.recorders[0]!.ondataavailable!({ data: { arrayBuffer: async () => { throw Error('Blob read failed'); } } });
    expect(await f.audio.stop()).toBeUndefined();
    expect(f.sent.some(args => args.final)).toBe(false);
    expect(f.seen.at(-1)).toMatchObject({ state: 'error', message: 'Blob read failed' });
  } finally { await f.audio.dispose(); }
});

it('keeps recorder event order when an earlier Blob read resolves after a later chunk', async () => {
  const first = deferred<ArrayBuffer>(); const f = fixture();
  try {
    await f.audio.start();
    f.recorders[0]!.ondataavailable!({ data: { arrayBuffer: () => first.promise } });
    f.recorders[0]!.emit([3, 4]);
    await tick();
    const stopping = f.audio.stop();
    first.resolve(Uint8Array.from([1, 2]).buffer);
    expect(await stopping).toMatchObject({ text: 'next' });
    expect(f.sent.filter(args => args.data).map(args => [...Buffer.from(args.data, 'base64')])).toEqual([[1, 2], [3, 4]]);
    expect(f.sent.map(args => [args.seq, args.final])).toEqual([[0, false], [1, false], [2, true]]);
  } finally { await f.audio.dispose(); }
});

it('a microphone grant arriving after disposal stops its tracks and never starts a recorder', async () => {
  const grant = deferred<any>(); const f = fixture({ grant: grant.promise });
  const starting = f.audio.start();
  await tick(); await f.audio.dispose();
  grant.resolve(f.stream); await starting;
  expect(f.track.stop).toHaveBeenCalledOnce();
  expect(f.track.enabled).toBe(false);
  expect(f.recorders).toHaveLength(0); expect(f.sent).toHaveLength(0);
});

it('a grant arriving after the prompt timeout stays muted until the next deliberate press', async () => {
  const grant = deferred<any>(); let timeout!: () => void;
  const f = fixture({ grant: grant.promise, setTimer: handler => { timeout = handler; return 0; } });
  try {
    const starting = f.audio.start();
    const rejected = expect(starting).rejects.toThrow('did not answer the microphone prompt');
    await tick(); timeout(); await rejected;
    f.track.enabled = true; // Browser grants an enabled track by default.
    grant.resolve(f.stream); await tick();
    expect(f.track.readyState).toBe('live');
    expect(f.track.enabled).toBe(false);
    expect(f.recorders).toHaveLength(0);
    await f.audio.start(); expect(f.track.enabled).toBe(true);
    f.recorders[0]!.emit([1]); expect(await f.audio.stop()).toMatchObject({ text: 'next' });
  } finally { await f.audio.dispose(); }
});

it('disposal while transcription is pending suppresses the late heard event and page decision', async () => {
  const answer = deferred<any>();
  const f = fixture({ send: async args => args.final ? answer.promise : {} });
  await f.audio.start(); f.recorders[0]!.emit([1]);
  const stopping = f.audio.stop(); await tick();
  const disposing = f.audio.dispose();
  answer.resolve({ transcript: { text: 'next', pageDecision: 'late-decision' } });
  await Promise.all([stopping, disposing]);
  expect(f.seen.some(event => event.state === 'heard')).toBe(false);
  expect(f.track.stop).toHaveBeenCalledOnce();
});
