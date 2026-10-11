/**
 * The heartbeat has to tell the headset that Claude is here.
 *
 * A wearer could finish a whole run without knowing the Mac-side agent
 * existed, because nothing in this protocol ever said so. The page polls the
 * host and the host answered with command state only. This
 * asserts the one field that closes that gap, on the heartbeat the companion
 * already sends, against the real server.
 */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { AGENT_PRESENCE_WINDOW_MS } from '../src/inspection-server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

/**
 * One saved session with a companion panel attached, on a clock the test moves.
 *
 * Nothing in the setup is an agent acting: `inspect`, `get_inspection`,
 * `sync_inspection` and `attach_inspection` are the page opening and
 * registering itself, so a freshly built session must report no agent.
 */
async function setup() {
  const clock = { now: 1_000 };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const transcriber = createPushToTalkTranscriber({ enabled: false });
  transcriber.accept = async input => {
    if (input.final) transcriber.transcripts.publish({ utteranceId: input.utteranceId, text: 'Make it blue.',
      durationMs: 1, receivedAt: new Date(clock.now).toISOString(), model: 'synthetic' });
    return { ...input, accepted: true, reason: 'chunk', message: 'Synthetic chunk' };
  };
  const server = createStereoStructureServer(undefined, { now: () => clock.now, transcriber });
  const client = new Client({ name: 'Stereofold agent presence test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const data = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const scene = {
    sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
    assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const initial = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  const saved = (await call('sync_inspection', { ...initial, scene })).structuredContent;
  const binding = { ...initial, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  const beat = async () => (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))
    ._meta[PRIVATE_KEY].agentAttached;
  const close = async () => { await client.close(); await server.close(); };
  const hear = async () => {
    const audio = { sessionId, panelId, utteranceId: '11111111-1111-4111-8111-111111111111', mime: 'audio/webm' };
    await call('push_to_talk_audio', { ...audio, seq: 0, data: 'AAAA', final: false });
    await call('push_to_talk_audio', { ...audio, seq: 1, final: true });
    const heard = await call('listen_voice', { timeoutSeconds: 1 });
    return heard.structuredContent.transcripts[0];
  };
  return { clock, call, sessionId, binding, panelId, beat, close, hear };
}

describe('the agent presence the headset heartbeat carries', () => {
  it('does not count generic tool traffic as a conversation consumer', async () => {
    const { call, sessionId, beat, close } = await setup();
    try {
      expect(await beat()).toBe(false);
      await call('get_inspection_state', { sessionId });
      expect(await beat()).toBe(false);
    } finally { await close(); }
  });

  it('does not count a transcript monitor alone or an unbound reply', async () => {
    const { call, sessionId, beat, close } = await setup();
    try {
      await call('poll_voice_transcripts', { sessionId, waitMs: 0 });
      expect(await beat()).toBe(false);
      await call('say_to_headset', { text: 'Hello.', speak: false });
      expect(await beat()).toBe(false);
    } finally { await close(); }
  });

  it('requires a claimed request and admitted action, and expires even while polling continues', async () => {
    const { clock, call, sessionId, binding, panelId, beat, close, hear } = await setup();
    try {
      const utterance = await hear();
      expect(await beat()).toBe(false);
      const request = { ...binding, panelId, commandId: 'quality-presence', utteranceId: utterance.utteranceId,
        change: { kind: 'render-quality', patch: { level: 'best' } } };
      expect((await call('update_inspection', request)).isError).not.toBe(true);
      expect(await beat()).toBe(true);
      clock.now += AGENT_PRESENCE_WINDOW_MS;
      expect(await beat()).toBe(true);
      clock.now += 1;
      await call('poll_voice_transcripts', { sessionId, waitMs: 0 });
      expect(await beat()).toBe(false);
      // Exact command retries and generic traffic cannot fabricate fresh processed requests.
      await call('update_inspection', request);
      await call('get_inspection_state', { sessionId });
      expect(await beat()).toBe(false);
      const readiness = (await call('get_readiness', { sessionId })).structuredContent.readiness;
      expect(readiness.items.find((i: any) => i.capability === 'agent').state).toBe('missing');
    } finally { await close(); }
  });

  it('does not count a rejected scene action as processing a request', async () => {
    const { call, binding, panelId, beat, close, hear } = await setup();
    try {
      const utterance = await hear();
      const rejected = await call('update_inspection', { ...binding, baseStateRevision: -1, panelId,
        commandId: 'invalid', utteranceId: utterance.utteranceId, change: { kind: 'render-quality', patch: { level: 'best' } } });
      expect(rejected.isError).toBe(true);
      expect(await beat()).toBe(false);
    } finally { await close(); }
  });

  it('always reports the field, so a page can tell absence from an older host', async () => {
    const { call, binding, panelId, close } = await setup();
    try {
      const meta = (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta[PRIVATE_KEY];
      expect(Object.hasOwn(meta, 'agentAttached')).toBe(true);
      expect(meta.agentAttached).toBe(false);
    } finally { await close(); }
  });
});
