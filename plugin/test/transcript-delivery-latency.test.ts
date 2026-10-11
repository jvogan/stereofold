/**
 * How long the wearer's words take to reach the agent listening.
 *
 * On a device pass the converse loop printed each transcript 1.6 to
 * 2.1 s after the host's own `at` stamp. Nothing in this path is an interval:
 * the queue wakes its waiters the moment a record is published, and the
 * long poll in `listen_voice` is that wake and nothing else. What stood in
 * front of the publish was the delivery fan-out — a transcript-log append, a
 * headset-bridge write and a spawned shell command, all awaited before the
 * queue heard about the utterance.
 *
 * These tests hold the fan-out still with a slow delivery and measure the wait
 * from the commit to the poll resolving. There is no time-based debounce to
 * preserve anywhere in this pipeline: a record exists only once the `final`
 * chunk has arrived and the recognizer has exited, which is the whole of the
 * protection against a half-finished transcript.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createPushToTalkTranscriber, pushToTalkAudioSchema, type PushToTalkAudioInput,
} from '../src/push-to-talk-transcribe.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const HEARD = 'open the microtubule lattice';
/** What one slow delivery costs, standing in for a bridge write or a text command. */
const SLOW_DELIVERY_MS = 1_900;
/** The whole budget the fix buys back: a commit the listener sees at once. */
const DELIVERY_BUDGET_MS = 50;

/** ffmpeg and whisper-cli, answered without running either. */
function fakeSpawner() {
  const spawn = ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = () => true;
    void Promise.resolve().then(async () => {
      if (command.includes('ffmpeg')) {
        await writeFile(args[args.length - 1]!, Buffer.from('RIFFfake'));
        child.emit('close', 0);
        return;
      }
      if (command.includes('whisper')) {
        await writeFile(`${args[args.indexOf('-of') + 1]!}.txt`, `${HEARD}\n`);
        child.emit('close', 0);
        return;
      }
      child.emit('close', 0);
    });
    return child;
  }) as any;
  return spawn;
}

function build(overrides: Parameters<typeof createPushToTalkTranscriber>[0] = {}) {
  return createPushToTalkTranscriber({
    enabled: true,
    transcriber: 'whisper',
    whisperBin: '/opt/homebrew/bin/whisper-cli',
    whisperModel: '/models/ggml-small.en.bin',
    ffmpegBin: '/opt/homebrew/bin/ffmpeg',
    exists: () => true,
    spawn: fakeSpawner(),
    log: () => {},
    ...overrides,
  });
}

function chunk(over: Partial<PushToTalkAudioInput> = {}): PushToTalkAudioInput {
  return pushToTalkAudioSchema.parse({
    sessionId: SESSION, utteranceId: FIRST, seq: 0, mime: 'audio/webm;codecs=opus',
    data: Buffer.from('opus-bytes').toString('base64'), final: false, ...over,
  });
}

/**
 * Real event-loop turns, which the fake clock does not supply.
 *
 * `Date` and `setTimeout` are frozen here so the measurement is exact, but the
 * recognizer stubs write real files and their completions arrive on the poll
 * phase. Spinning on `setImmediate` lets the pipeline run all the way to the
 * commit without moving the clock a millisecond, so every latency this file
 * asserts is measured against a clock that never ticked.
 */
const turn = () => new Promise<void>(resolve => { setImmediate(resolve); });
const spin = async (ready: () => boolean, turns = 4_000) => {
  for (let index = 0; index < turns; index++) {
    if (ready()) return true;
    await turn();
  }
  return ready();
};
const drain = async (turns = 200) => { for (let index = 0; index < turns; index++) await turn(); };

const frozenClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
// A frozen clock that outlived its test would hang every test after it, so the
// restore happens here rather than only in each test's own `finally`.
afterEach(() => { vi.useRealTimers(); });

describe('transcript delivery latency', () => {
  it('hands a waiting poll the transcript at the moment it is committed, not when the deliveries finish', async () => {
    frozenClock();
    const finishedDeliveries: number[] = [];
    const instance = build({
      deliver: [() => new Promise<void>(resolve => {
        setTimeout(() => { finishedDeliveries.push(Date.now()); resolve(); }, SLOW_DELIVERY_MS);
      })],
    });
    try {
      await instance.accept(chunk({ seq: 0 }));
      let resolvedAt = -1;
      const waiting = instance.transcripts.since(0, { waitMs: 15_000 })
        .then(answer => { resolvedAt = Date.now(); return answer; });
      await drain();

      const committedAt = Date.now();
      const spoken = instance.accept(chunk({ seq: 1, final: true }));
      await spin(() => resolvedAt !== -1);

      expect(resolvedAt, 'the poll is still waiting behind the delivery fan-out').not.toBe(-1);
      expect(resolvedAt - committedAt).toBeLessThanOrEqual(DELIVERY_BUDGET_MS);
      expect((await waiting).entries.map(entry => entry.text)).toEqual([HEARD]);
      expect(finishedDeliveries, 'the slow delivery is deliberately still running').toHaveLength(0);

      // The deliveries still finish, and `push_to_talk_audio` still waits for
      // them: only the listener stopped paying.
      await vi.advanceTimersByTimeAsync(SLOW_DELIVERY_MS);
      expect((await spoken).transcript?.text).toBe(HEARD);
      expect(finishedDeliveries).toHaveLength(1);
    } finally {
      await instance.dispose();
      vi.useRealTimers();
    }
  });

  it('delivers two transcripts committed 100 ms apart in order, once each', async () => {
    frozenClock();
    const instance = build({
      deliver: [() => new Promise<void>(resolve => { setTimeout(resolve, SLOW_DELIVERY_MS); })],
    });
    try {
      await instance.accept(chunk({ seq: 0, utteranceId: FIRST }));
      let firstResolved = false;
      const firstPoll = instance.transcripts.since(0, { waitMs: 15_000 })
        .then(answer => { firstResolved = true; return answer; });
      await drain();
      const firstSpoken = instance.accept(chunk({ seq: 1, final: true, utteranceId: FIRST }));
      await spin(() => firstResolved);
      expect(firstResolved, 'the first poll is still waiting behind the delivery fan-out').toBe(true);
      const first = await firstPoll;
      expect(first.entries.map(entry => entry.utteranceId)).toEqual([FIRST]);
      expect(first.cursor).toBe(1);

      await vi.advanceTimersByTimeAsync(100);

      await instance.accept(chunk({ seq: 0, utteranceId: SECOND }));
      const committedSecondAt = Date.now();
      let secondResolvedAt = -1;
      const secondPoll = instance.transcripts.since(first.cursor, { waitMs: 15_000 })
        .then(answer => { secondResolvedAt = Date.now(); return answer; });
      await drain();
      const secondSpoken = instance.accept(chunk({ seq: 1, final: true, utteranceId: SECOND }));
      await spin(() => secondResolvedAt !== -1);

      expect(secondResolvedAt, 'the second poll is still waiting behind the delivery fan-out').not.toBe(-1);
      const second = await secondPoll;
      expect(secondResolvedAt - committedSecondAt).toBeLessThanOrEqual(DELIVERY_BUDGET_MS);
      expect(second.entries.map(entry => entry.utteranceId)).toEqual([SECOND]);
      expect(second.cursor).toBe(2);
      // Once each: the moved cursor holds nothing back and repeats nothing.
      expect((await instance.transcripts.since(second.cursor, { waitMs: 0 })).entries).toEqual([]);
      expect(instance.transcripts.all().map(entry => entry.utteranceId)).toEqual([FIRST, SECOND]);

      await vi.advanceTimersByTimeAsync(SLOW_DELIVERY_MS);
      await Promise.all([firstSpoken, secondSpoken]);
    } finally {
      await instance.dispose();
      vi.useRealTimers();
    }
  });

  it('still holds a transcript nobody was waiting for until the next call asks for it', async () => {
    const instance = build();
    try {
      await instance.accept(chunk({ seq: 0 }));
      await instance.accept(chunk({ seq: 1, final: true }));
      const answer = await instance.transcripts.since(0, { waitMs: 0 });
      expect(answer.entries.map(entry => entry.text)).toEqual([HEARD]);
      expect(answer.cursor).toBe(1);
    } finally { await instance.dispose(); }
  });
});

describe('listen_voice through the real server', () => {
  /** The same in-memory pair the other voice tests use, with a real session. */
  async function session(overrides: Parameters<typeof createPushToTalkTranscriber>[0] = {}) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createStereoStructureServer } = await import('../src/server.js');
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const instance = build(overrides);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { transcriber: instance });
    const client = new Client({ name: 'Transcript delivery latency test', version: '1' });
    await server.connect(b);
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) =>
      await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    const opened = await call('inspect', { structureText: cif });
    return { call, sessionId: opened.structuredContent.sessionId as string,
      close: async () => { await instance.dispose(); await client.close(); await server.close(); } };
  }

  it('answers a waiting call while a delivery is still running', async () => {
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const live = await session({ deliver: [() => blocked] });
    let audio: Promise<unknown> = Promise.resolve();
    try {
      // One second, the tool's floor, so a regression costs a second rather
      // than the twenty a real listener waits.
      const listening = live.call('listen_voice', { timeoutSeconds: 1 });
      await new Promise<void>(resolve => { setTimeout(resolve, 20); });
      const askedAt = Date.now();
      audio = live.call('push_to_talk_audio', { sessionId: live.sessionId, utteranceId: FIRST,
        seq: 0, mime: 'audio/webm;codecs=opus', data: Buffer.from('opus').toString('base64'), final: true });
      const heard = await listening;
      // Real time here, so the bound is loose enough for a slow machine and
      // still far below the second the call would otherwise wait out.
      expect(Date.now() - askedAt).toBeLessThan(500);
      expect(heard.structuredContent.timedOut).toBe(false);
      expect(heard.structuredContent.transcripts.map((entry: any) => entry.text)).toEqual([HEARD]);
    } finally {
      release();
      await audio.catch(() => {});
      await live.close();
    }
  });
});
