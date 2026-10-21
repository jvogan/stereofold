import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber, createTranscriptQueue } from '../src/push-to-talk-transcribe.js';
import { startSceneSocketRelay } from '../scripts/scene-socket-relay.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(socket = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sf-voice-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const transcriber = createPushToTalkTranscriber({ enabled: false });
  async function host(name: string, owner = false) {
    const server = createStereoStructureServer(undefined, {
      sceneServiceFile: join(directory, 'scene.json'), ...(owner ? { transcriber } : {}),
      ...(!owner && socket ? { environment: { STEREOFOLD_SCENE_SOCKET: join(directory, 'scene.sock') } } : {}),
    });
    const client = new Client({ name, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    cleanups.push(async () => { await client.close(); await server.close(); });
    return { client, call: async (tool: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: `stereo_structure.${tool}`, arguments: args }) as any;
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent;
    } };
  }
  const owner = await host('owner', true);
  const opened = await owner.call('inspect', { structureText: cif });
  await owner.call('continue_session', { assistant: 'Codex' });
  if (socket) cleanups.push(await startSceneSocketRelay(join(directory, 'scene.json'), join(directory, 'scene.sock')));
  const follower = await host('follower');
  await follower.call('continue_session', { assistant: 'Claude' });
  const speak = (text: string) => transcriber.transcripts.publish({
    utteranceId: randomUUID(), text, durationMs: 400, receivedAt: new Date().toISOString(), model: 'synthetic',
  });
  return { owner, follower, transcriber, host, sessionId: opened.sessionId, speak };
}

for (const route of ['owner', 'attached', 'socket-attached'] as const) for (const tool of ['listen_voice', 'poll_voice_transcripts'])
it(`cancelled ${route} ${tool} does not consume the next utterance`, async () => {
  const t = await fixture(route === 'socket-attached');
  const listener = route === 'owner' ? t.owner : t.follower;
  if (route !== 'owner') await t.owner.call('switch_assistant', { sessionId: t.sessionId, to: 'Claude' });
  const since = vi.spyOn(t.transcriber.transcripts, 'since');
  const controller = new AbortController();
  const args = tool === 'listen_voice' ? { timeoutSeconds: 2 } : { sessionId: t.sessionId, waitMs: 2_000 };
  const pending = listener.client.callTool({ name: `stereo_structure.${tool}`, arguments: args },
    undefined, { signal: controller.signal }).then(() => 'completed', () => 'cancelled');
  await vi.waitFor(() => expect(since).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await pending).toBe('cancelled');
  await vi.waitFor(() => expect(since.mock.calls[0][1]?.signal?.aborted).toBe(true));
  const utterance = t.speak('Keep this request for the resumed listener');
  await new Promise(resolve => setTimeout(resolve, 50));
  const resumed = await listener.call('listen_voice', { timeoutSeconds: 1 });
  expect(resumed.transcripts.map((entry: any) => entry.utteranceId)).toEqual([utterance.utteranceId]);
  expect(resumed.listening).toBe(true);
  const replay = await listener.call('poll_voice_transcripts', { sessionId: t.sessionId, after: 0, waitMs: 0 });
  expect(replay.transcripts).toEqual([]);
  expect((await listener.call('get_inspection_state', { sessionId: t.sessionId })).sessionId).toBe(t.sessionId);
});

it('reports lost ownership when the floor changes while a listen is pending', async () => {
  const t = await fixture();
  const since = vi.spyOn(t.transcriber.transcripts, 'since');
  const pending = t.owner.call('listen_voice', { timeoutSeconds: 1 });
  await vi.waitFor(() => expect(since).toHaveBeenCalledTimes(1));
  await t.follower.call('switch_assistant', { sessionId: t.sessionId, to: 'Claude' });
  const utterance = t.speak('This belongs to Claude now');
  const previous = await pending;
  expect(previous).toMatchObject({ active: 'Claude', listening: false, timedOut: false, transcripts: [] });
  const current = await t.follower.call('listen_voice', { timeoutSeconds: 1 });
  expect(current.transcripts.map((entry: any) => entry.utteranceId)).toEqual([utterance.utteranceId]);
});

it('ends an idle listen on handover without needing another spoken word', async () => {
  const t = await fixture();
  const since = vi.spyOn(t.transcriber.transcripts, 'since');
  let settled: any;
  const pending = t.owner.call('listen_voice', { timeoutSeconds: 2 }).then(result => { settled = result; });
  await vi.waitFor(() => expect(since).toHaveBeenCalledTimes(1));
  await t.follower.call('switch_assistant', { sessionId: t.sessionId, to: 'Claude' });
  await vi.waitFor(() => expect(settled).toMatchObject({ active: 'Claude', listening: false, timedOut: false }), { timeout: 1_000 });
  await pending;
  expect(t.transcriber.transcripts.cursor).toBe(0);
});

it('reports a spoken handover as no longer listening and leaves its following request for the new assistant', async () => {
  const t = await fixture();
  t.speak('Switch to Claude');
  const next = t.speak('Explain the active site');
  const previous = await t.owner.call('listen_voice', { timeoutSeconds: 1 });
  expect(previous).toMatchObject({ active: 'Claude', listening: false, timedOut: false, transcripts: [],
    handover: { from: 'Codex', to: 'Claude', by: 'phrase' } });
  const current = await t.follower.call('listen_voice', { timeoutSeconds: 1 });
  expect(current.transcripts.map((entry: any) => entry.utteranceId)).toEqual([next.utteranceId]);
});

it('checks cancellation after the queue wakes but before reserving its transcript', async () => {
  const t = await fixture();
  const original = t.transcriber.transcripts.since.bind(t.transcriber.transcripts);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let woke = false;
  const since = vi.spyOn(t.transcriber.transcripts, 'since').mockImplementationOnce(async (after, options) => {
    const answer = await original(after, options);
    woke = true; await hold; return answer;
  });
  const controller = new AbortController();
  const pending = t.owner.client.callTool({ name: 'stereo_structure.listen_voice', arguments: { timeoutSeconds: 2 } },
    undefined, { signal: controller.signal }).catch(() => undefined);
  await vi.waitFor(() => expect(since).toHaveBeenCalledTimes(1));
  const entry = t.speak('Still unclaimed');
  await vi.waitFor(() => expect(woke).toBe(true));
  controller.abort(); await pending;
  await vi.waitFor(() => expect(since.mock.calls[0][1]?.signal?.aborted).toBe(true));
  release();
  const heard = await t.owner.call('listen_voice', { timeoutSeconds: 1 });
  expect(heard.transcripts.map((value: any) => value.utteranceId)).toEqual([entry.utteranceId]);
});

it('releases an attached listener when its MCP client disconnects, without closing the scene', async () => {
  const t = await fixture();
  await t.owner.call('switch_assistant', { sessionId: t.sessionId, to: 'Claude' });
  const since = vi.spyOn(t.transcriber.transcripts, 'since');
  const pending = t.follower.client.callTool({ name: 'stereo_structure.listen_voice', arguments: { timeoutSeconds: 2 } })
    .catch(() => undefined);
  await vi.waitFor(() => expect(since).toHaveBeenCalledTimes(1));
  await t.follower.client.close(); await pending;
  await vi.waitFor(() => expect(since.mock.calls[0][1]?.signal?.aborted).toBe(true));
  const entry = t.speak('Resume this shared session');
  const returning = await t.host('returning Claude');
  expect(await returning.call('continue_session', { assistant: 'Claude' })).toMatchObject({ role: 'attached', sessionId: t.sessionId });
  const heard = await returning.call('listen_voice', { timeoutSeconds: 1 });
  expect(heard.transcripts.map((value: any) => value.utteranceId)).toEqual([entry.utteranceId]);
});

for (const completion of ['timeout', 'abort']) it(`retires a queue waiter after ${completion}`, async () => {
  vi.useFakeTimers();
  const queue = createTranscriptQueue();
  const controller = new AbortController();
  const detach = vi.spyOn(controller.signal, 'removeEventListener');
  const waiting = queue.since(0, { waitMs: 5, signal: controller.signal });
  if (completion === 'abort') controller.abort();
  else await vi.advanceTimersByTimeAsync(5);
  expect((await waiting).entries).toEqual([]);
  expect(detach).toHaveBeenCalledTimes(1);
  detach.mockClear();
  queue.publish({ utteranceId: randomUUID(), text: 'new request', durationMs: 100,
    receivedAt: new Date().toISOString(), model: 'synthetic' });
  // A completed wait must not retain its callback until future speech.
  expect(detach).not.toHaveBeenCalled();
  expect((await queue.since(0, { waitMs: 0 })).entries.map(entry => entry.text)).toEqual(['new request']);
});
