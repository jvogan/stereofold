/**
 * A voice request is one short call.
 *
 * The host already holds each recorded utterance's session, headset panel and
 * referent, so `{utteranceId, change}` is enough. Copying those back cost a
 * model one to two seconds of UUIDs per call, and echoing the referent on a
 * whole-molecule edit was refused outright.
 */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function setup({ omitTranscriptSession = false } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const transcriber = createPushToTalkTranscriber({ enabled: false });
  let heard = { text: 'Make it bigger.', referent: undefined as any };
  let session = '', panel = '';
  // The real transcriber stamps session, panel and referent on the record it publishes.
  transcriber.accept = async input => {
    if (input.final) transcriber.transcripts.publish({ utteranceId: input.utteranceId,
      ...(omitTranscriptSession ? {} : { sessionId: session }), panelId: panel,
      text: heard.text, durationMs: 1, receivedAt: new Date().toISOString(), model: 'synthetic',
      ...(heard.referent ? { referent: heard.referent } : {}) });
    return { ...input, accepted: true, reason: 'chunk', message: 'Synthetic chunk' };
  };
  const server = createStereoStructureServer(undefined, { transcriber });
  const client = new Client({ name: 'Stereofold voice fast path test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const data = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const keys = data.catalog.rows.map((row: any) => row.key) as string[];
  const scene = {
    sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
    assemblyId: data.catalog.assemblyId, selectionKeys: [keys[0]],
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
  await call('poll_inspection', { ...binding, panelId, availability: 'ready' });
  session = sessionId; panel = panelId;
  // One press, as the headset sends it, claimed the way the channel or listen_voice claims it.
  let presses = 0;
  const hear = async (text: string, referent?: unknown) => {
    heard = { text, referent };
    const utteranceId = `11111111-1111-4111-8111-${String(++presses).padStart(12, '0')}`;
    const audio = { sessionId, panelId, utteranceId, mime: 'audio/webm' };
    await call('push_to_talk_audio', { ...audio, seq: 0, data: 'AAAA', final: false });
    await call('push_to_talk_audio', { ...audio, seq: 1, final: true });
    const listened = await call('listen_voice', { timeoutSeconds: 1, cursor: presses - 1 });
    expect(listened.structuredContent.transcripts.map((t: any) => t.utteranceId)).toEqual([utteranceId]);
    return utteranceId;
  };
  const referent = { sourceToken: data.sourceToken, capturedAt: 1, selectionKeys: [keys[1]] };
  const close = async () => { await client.close(); await server.close(); };
  return { call, client, transcriber, sessionId, panelId, binding, keys, hear, referent, close };
}

describe('a voice request bound by its utteranceId alone', () => {
  for (const omitTranscriptSession of [true, false]) {
    it(`does not treat missing transcript provenance as another session (all missing: ${omitTranscriptSession})`, async () => {
      const t = await setup({ omitTranscriptSession });
      try {
        const utteranceId = await t.hear('Make it bigger.');
        // Also cover a legacy record beside a record with a known session.
        if (!omitTranscriptSession) {
          const { sessionId: _session, ...legacy } = t.transcriber.transcripts.all()[0]!;
          t.transcriber.transcripts.publish(legacy);
        }
        const result = await t.call('update_inspection', { sessionId: t.sessionId, panelId: t.panelId,
          utteranceId, change: { kind: 'placement', patch: { scale: 1.25 } } });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent.command.status).toBe('queued');
        const poll = await t.call('poll_inspection', { ...t.binding, panelId: t.panelId, availability: 'ready' });
        expect(poll._meta[PRIVATE_KEY].delivery.change).toMatchObject({ kind: 'placement', patch: { scale: 1.25 } });
      } finally { await t.close(); }
    });
  }

  it('preserves an explicit legacy appearance referent without a selection scope', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Colour this red.', t.referent);
      const result = await t.call('update_inspection', { sessionId: t.sessionId, panelId: t.panelId,
        utteranceId, referent: t.referent,
        change: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ff0000' } } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent.command.appliedTo).toEqual({ selectionKeys: t.referent.selectionKeys, capturedAt: 1 });
    } finally { await t.close(); }
  });

  it('infers a compound referent only for the selection colour, leaving opacity global', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Colour this red and make everything translucent.', t.referent);
      const answer = await t.call('update_inspection', { utteranceId, change: { kind: 'compound', patch: { ops: [
        { kind: 'appearance', scope: 'selection', patch: { color: 'uniform', uniformColor: '#ff0000' } },
        { kind: 'appearance', patch: { opacity: 0.4 } },
      ] } } });
      expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
      const poll = await t.call('poll_inspection', { ...t.binding, panelId: t.panelId, availability: 'ready' });
      const ops = poll._meta[PRIVATE_KEY].delivery.change.patch.ops;
      expect(ops).toContainEqual({ kind: 'appearance', patch: { opacity: 0.4 } });
      expect(ops.find((op: any) => op.kind === 'styles').patch.selectionKeys).toEqual(t.referent.selectionKeys);
    } finally { await t.close(); }
  });

  it('keeps a named region independent of another operation inferred from the selection', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Colour this red and chain A blue.', t.referent);
      const answer = await t.call('update_inspection', { utteranceId, change: { kind: 'compound', patch: { ops: [
        { kind: 'appearance', scope: 'selection', patch: { color: 'uniform', uniformColor: '#ff0000' } },
        { kind: 'appearance', residues: { labelChain: 'A' }, patch: { color: 'uniform', uniformColor: '#0000ff' } },
      ] } } });
      expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
    } finally { await t.close(); }
  });

  it('retains recording ID ownership after both 64-entry histories evict it', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('First request.');
      for (let i = 0; i < 65; i++) await t.hear('Another request.');
      expect(t.transcriber.transcripts.all().some(entry => entry.utteranceId === utteranceId)).toBe(false);
      const sessionId = (await t.call('inspect', { structureText: cif })).structuredContent.sessionId;
      const reused = await t.call('push_to_talk_audio', { sessionId, utteranceId, seq: 0, mime: 'audio/webm', data: 'AAAA', final: false });
      expect(reused.isError).toBe(true);
      expect(reused.content[0].text).toMatch(/another session/);
      // Even a legacy/injected transcript cannot transfer the tombstoned ID.
      t.transcriber.transcripts.publish({ ...t.transcriber.transcripts.all().at(-1)!, utteranceId, sessionId });
      const late = await t.call('update_inspection', { utteranceId, change: { kind: 'placement', patch: { scale: 2 } } });
      expect(late.isError).toBe(true);
      expect(late.content[0].text).toMatch(/ambiguous/);
    } finally { await t.close(); }
  });

  it('requires sessionId in schemas for tools without utterance binding', async () => {
    const t = await setup();
    try {
      const tools = (await t.client.listTools()).tools;
      for (const name of ['undo_last_change', 'redo_last_change', 'replace_inspection_source']) {
        expect(tools.find(tool => tool.name === `stereo_structure.${name}`)!.inputSchema.required).toContain('sessionId');
      }
      for (const name of ['update_inspection', 'control_tour', 'focus_selection', 'emphasize']) {
        expect(tools.find(tool => tool.name === `stereo_structure.${name}`)!.inputSchema.required ?? []).not.toContain('sessionId');
      }
      const utteranceId = await t.hear('Undo that.');
      const result = await t.call('undo_last_change', { utteranceId });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sessionId/);
      expect(result.content[0].text).not.toMatch(/no recorded voice request/);
    } finally { await t.close(); }
  });

  it('refuses an ambiguous retained utterance instead of binding the latest session', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Make it bigger.');
      const sessionId = (await t.call('inspect', { structureText: cif })).structuredContent.sessionId;
      t.transcriber.transcripts.publish({ ...t.transcriber.transcripts.all()[0]!, sessionId });
      for (const explicit of [{}, { sessionId: t.sessionId, panelId: t.panelId }]) {
        const result = await t.call('update_inspection', { ...explicit, utteranceId,
          change: { kind: 'placement', patch: { scale: 1.25 } } });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/ambiguous.*utteranceId|utteranceId.*ambiguous/i);
      }
    } finally { await t.close(); }
  });
  it('needs no sessionId, panelId or referent for a scene edit', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Make it bigger.', t.referent);
      const bigger = await t.call('update_inspection', { utteranceId, change: { kind: 'placement', patch: { scale: 1.25 } } });
      expect(bigger.isError, JSON.stringify(bigger.content)).not.toBe(true);
      expect(bigger.structuredContent.command).toMatchObject({ status: 'queued' });
      const state = await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: bigger.structuredContent.command.commandId });
      expect(state.structuredContent.pendingCommand.map((c: any) => c.panelId)).toContain(t.panelId);
    } finally { await t.close(); }
  });

  it('never refuses a whole-molecule edit for the referent it was spoken with, echoed or not', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Make it bigger.', t.referent);
      const echoed = await t.call('update_inspection', { sessionId: t.sessionId, panelId: t.panelId, utteranceId,
        referent: t.referent, change: { kind: 'placement', patch: { scale: 1.25 } } });
      expect(echoed.isError, JSON.stringify(echoed.content)).not.toBe(true);
    } finally { await t.close(); }
  });

  it('applies the utterance referent to an edit on "the selection" and not to the whole scene', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Colour this red.', t.referent);
      const scoped = await t.call('update_inspection', { utteranceId,
        change: { kind: 'appearance', scope: 'selection', patch: { uniformColor: '#ff0000', color: 'uniform' } } });
      expect(scoped.isError, JSON.stringify(scoped.content)).not.toBe(true);
      expect(scoped.structuredContent.command.appliedTo).toEqual({ selectionKeys: t.referent.selectionKeys, capturedAt: 1 });
    } finally { await t.close(); }
  });

  it('lets a named region win over its own echoed referent instead of refusing both', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Highlight chain A.', t.referent);
      const named = await t.call('focus_selection', { utteranceId, referent: t.referent, residues: { labelChain: 'A' } });
      expect(named.isError, JSON.stringify(named.content)).not.toBe(true);
    } finally { await t.close(); }
  });

  it('lets a named selection win over its own echoed referent too', async () => {
    const t = await setup();
    try {
      const other = await t.hear('Select chain A.', t.referent);
      const selected = await t.call('update_inspection', { utteranceId: other, referent: t.referent,
        change: { kind: 'selection', patch: { residues: { labelChain: 'A' } } } });
      expect(selected.isError, JSON.stringify(selected.content)).not.toBe(true);
    } finally { await t.close(); }
  });

  it('still asks for a sessionId when there is no utteranceId to bind', async () => {
    const t = await setup();
    try {
      const bare = await t.call('update_inspection', { change: { kind: 'placement', patch: { scale: 1.25 } } });
      expect(bare.isError).toBe(true);
      expect(bare.content[0].text).toMatch(/sessionId/);
    } finally { await t.close(); }
  });

  it('accepts and ignores a sessionId on say_to_headset', async () => {
    const t = await setup();
    try {
      const utteranceId = await t.hear('Make it bigger.');
      const said = await t.call('say_to_headset', { text: 'Bigger.', utteranceId, sessionId: t.sessionId, speak: false });
      expect(said.isError, JSON.stringify(said.content)).not.toBe(true);
    } finally { await t.close(); }
  });
});
