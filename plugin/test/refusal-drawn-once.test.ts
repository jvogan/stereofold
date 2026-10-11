/**
 * A refusal the wearer has already read is not news twice.
 *
 * On a model-driven session "show only the ligand"
 * on crambin was refused. The host captioned it — "Could not apply · request
 * refused. 1CRN has no ligands to show only." — and two seconds later the
 * model's own refusal-scoped `say_to_headset` drew the same sentence again.
 * The wearer read one refusal twice and learned nothing the second time.
 *
 * The rule here is narrow on purpose: only the identical caption for the same
 * command, inside a short window, is held back. A reply that adds anything at
 * all is a different sentence and is drawn, because that is the reply the
 * wearer was owed.
 */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';

const crambin = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
/** Row 5b's sentence, host-side and model-side, word for word. */
const ABSENT_LIGAND = '1CRN has no ligands to show only.';
const DRAWN = `Could not apply · request refused. ${ABSENT_LIGAND}`;

async function setup() {
  const clock = { now: 1_700_000_000_000 };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { now: () => clock.now });
  const client = new Client({ name: 'Stereofold refusal caption test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: crambin })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const rows = privateData.catalog.rows as any[];
  const scene = {
    sourceSha256: privateData.catalog.source.sha256,
    modelNumber: privateData.catalog.modelNumbers[0],
    assemblyId: privateData.catalog.assemblyId,
    selectionKeys: [rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const opened = { sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision };
  const saved = (await call('sync_inspection', { ...opened, scene })).structuredContent;
  const live = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  const poll = async () => (await call('poll_inspection', { ...live, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.headsetCaption;
  await poll();
  /** Row 5b: the one command the host turns down by name. */
  const askForTheAbsentLigand = async (commandId: string) => await call('update_inspection', { ...live, panelId, commandId,
    change: { kind: 'visibility', patch: { op: 'only', classes: ['ligand'] } } });
  return { call, clock, sessionId, panelId, poll, askForTheAbsentLigand,
    binding: () => live,
    close: async () => { await client.close(); await server.close(); } };
}

describe('a refused command the model then reports back', () => {
  it('draws the refusal once and tells the model the wearer already has it', async () => {
    const t = await setup();
    try {
      const refused = await t.askForTheAbsentLigand('only-ligand');
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain(ABSENT_LIGAND);
      const drawn = await t.poll();
      expect(drawn).toMatchObject({ text: DRAWN, speak: false, refusal: { tool: 'update_inspection' } });

      t.clock.now += 2_000;
      const reported = await t.call('say_to_headset', { text: ABSENT_LIGAND,
        refusal: { tool: 'update_inspection', sessionId: t.sessionId } });
      expect(reported.isError).not.toBe(true);
      expect(reported.structuredContent).toMatchObject({ duplicate: true, queued: false, delivered: false,
        stale: false, text: DRAWN, captionId: drawn.id,
        undrawnReason: 'the panel had already drawn this refusal for this command, so the wearer was not shown it twice' });
      expect(reported.content[0].text).toContain('Say what to do instead, or say nothing.');
      // Nothing new reached the plate, so the wearer read it once.
      expect(await t.poll()).toBeUndefined();

      const outcomes = (await t.call('read_headset_log', { kind: 'outcome' })).structuredContent.entries;
      expect(outcomes.map((entry: any) => entry.detail.seatOutcome)).toEqual(['pending', 'duplicate']);
      expect(outcomes[1].detail.duplicateOf).toBe(drawn.id);
    } finally { await t.close(); }
  });

  it('draws a reply that adds anything to the refusal the wearer read', async () => {
    const t = await setup();
    try {
      expect((await t.askForTheAbsentLigand('only-ligand')).isError).toBe(true);
      expect(await t.poll()).toMatchObject({ text: DRAWN });
      t.clock.now += 2_000;
      const reported = await t.call('say_to_headset',
        { text: `${ABSENT_LIGAND} It is protein only, so there is nothing else to isolate.`,
          refusal: { tool: 'update_inspection', sessionId: t.sessionId } });
      expect(reported.structuredContent.duplicate).toBeUndefined();
      expect(reported.structuredContent.queued).toBe(true);
      expect(await t.poll()).toMatchObject({ text: expect.stringContaining('nothing else to isolate') });
    } finally { await t.close(); }
  });

  it('draws the same sentence again once the window has passed', async () => {
    const t = await setup();
    try {
      expect((await t.askForTheAbsentLigand('only-ligand')).isError).toBe(true);
      expect(await t.poll()).toMatchObject({ text: DRAWN });
      t.clock.now += 20_001;
      const reported = await t.call('say_to_headset', { text: ABSENT_LIGAND,
        refusal: { tool: 'update_inspection', sessionId: t.sessionId } });
      expect(reported.structuredContent.duplicate).toBeUndefined();
      expect(reported.structuredContent.queued).toBe(true);
      expect(await t.poll()).toMatchObject({ text: DRAWN });
    } finally { await t.close(); }
  });

  it('draws a refusal for a request that never became a tool call, as it always did', async () => {
    const t = await setup();
    try {
      const reported = await t.call('say_to_headset', { text: 'That paste is larger than the inspector accepts.',
        refusal: { tool: 'replace_inspection_source', sessionId: t.sessionId } });
      expect(reported.structuredContent.queued).toBe(true);
      expect(reported.structuredContent.duplicate).toBeUndefined();
      expect(await t.poll()).toMatchObject({ text: 'Could not load · request refused. That paste is larger than the inspector accepts.' });
    } finally { await t.close(); }
  });

  it('keeps a refusal for another command, even in the same words', async () => {
    const t = await setup();
    try {
      expect((await t.askForTheAbsentLigand('only-ligand')).isError).toBe(true);
      expect(await t.poll()).toMatchObject({ text: DRAWN });
      t.clock.now += 2_000;
      const reported = await t.call('say_to_headset', { text: ABSENT_LIGAND,
        refusal: { tool: 'focus_selection', sessionId: t.sessionId } });
      expect(reported.structuredContent.duplicate).toBeUndefined();
      expect(await t.poll()).toMatchObject({ text: DRAWN, refusal: { tool: 'focus_selection' } });
    } finally { await t.close(); }
  });
});
