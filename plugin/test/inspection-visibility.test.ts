import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, COMPOUND_MAX_OPS, expectedInspection,
  inspectionChangeSchema, matchesInspectionChange, sceneSchema, updateInspectionSchema,
  validateScene } from '../src/inspection-contract.js';
import { movedFields, undoChangeFor, bindVisibilitySelection, referentAppliedTo } from '../src/inspection-operation.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
// @ts-ignore The page's own hidden-set builder, so the shape the panel saves and
// the schema that has to accept it are checked against each other.
import { normalizeVisibility } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
// Crambin is a polymer and nothing else, so it is the structure that
// proves a refusal, and haemoglobin -- water, two kinds of ligand, no ion -- is
// the one that proves a hide the wearer actually asked for.
const hemoglobin = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');

async function setup(source = cif) {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-visibility-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold visibility test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif');
  await writeFile(filePath, source);
  const sessionId = (await call('inspect', { structureText: source })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  // A catalog over the inline bound rides as a compressed wire, which is how
  // haemoglobin arrives and crambin does not.
  const catalog = privateData.catalog ?? await decodeInspectionCatalog(privateData.catalogWire);
  const rows = catalog.rows as any[];
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
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
  const binding = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  // Every rendered command moves the inspection revision, and a command bound to
  // a stale one is refused. These tests run several changes in a row, so the
  // binding is re-read rather than captured once.
  const live = { ...binding };
  const advance = (value: any) => {
    if (typeof value?.stateRevision === 'number') live.baseStateRevision = value.stateRevision;
    if (typeof value?.inspectionRevision === 'number') live.baseInspectionRevision = value.inspectionRevision;
    return value;
  };
  const claim = async () => (await call('poll_inspection', { ...live, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  const state = async () => advance((await call('get_inspection_state', { sessionId })).structuredContent);
  /**
   * Answer a queued command with the scene the panel would have rendered, then
   * heartbeat. A panel that has not said `ready` since its last render is busy
   * as far as the host is concerned, and the next command is refused.
   */
  const render = async (delivery: any, rendered: any) => {
    const receipt = advance((await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: rendered })).structuredContent);
    await call('poll_inspection', { ...live, panelId, availability: 'ready' });
    return receipt;
  };
  return { call, catalog, rows, scene, panelId, claim, render, state, sessionId,
    get binding() { return { ...live }; },
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

/** The chain identity of a catalog row, which is what a hide request names. */
const chainOf = (row: any) => ({ labelChain: row.identity.labelChain, copyId: row.identity.copyId });
/** The scene a panel would save after hiding, with the camera bound the rebuild moved. */
const hiddenScene = (scene: any, visibility: unknown) => {
  const next = structuredClone(scene);
  if (visibility === undefined) delete next.inspection.visibility;
  else next.inspection.visibility = visibility;
  next.camera.radiusMax = 24;
  return next;
};

describe('the hidden set a scene carries', () => {
  const scene = (visibility?: unknown) => ({
    sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [],
    camera: { mode: 'perspective', fov: 1, position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0],
      radius: 1, radiusMax: 1, fog: 0, clipFar: false, minNear: .1, minFar: .1 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      ...(visibility === undefined ? {} : { visibility }),
    },
  });

  it('is optional, so every panel saved before this field existed still validates', () => {
    expect(sceneSchema.parse(scene()).inspection.visibility).toBeUndefined();
  });

  it('names a chain by label chain and copy id, never a bare letter', () => {
    expect(sceneSchema.safeParse(scene({ hiddenChains: [{ labelChain: 'B', copyId: 'one' }],
      hiddenClasses: [], showOnlySelection: false })).success).toBe(true);
    expect(sceneSchema.safeParse(scene({ hiddenChains: [{ labelChain: 'B' }],
      hiddenClasses: [], showOnlySelection: false })).success).toBe(false);
    expect(sceneSchema.safeParse(scene({ hiddenChains: [{ chain: 'B', copyId: 'one' }],
      hiddenClasses: [], showOnlySelection: false })).success).toBe(false);
    // Row keys are deliberately not on the wire; this is identities only.
    expect(sceneSchema.safeParse(scene({ hiddenChains: [], hiddenClasses: [],
      showOnlySelection: false, keys: ['k'] })).success).toBe(false);
    expect(sceneSchema.safeParse(scene({ hiddenChains: [], hiddenClasses: ['lipid'],
      showOnlySelection: false })).success).toBe(false);
  });

  it('has exactly one spelling, so two panels cannot save one picture two ways', () => {
    const written = { hiddenChains: [{ labelChain: 'B', copyId: 'one' }, { labelChain: 'A', copyId: 'one' }],
      hiddenClasses: ['polymer', 'water'], showOnlySelection: false };
    expect(sceneSchema.safeParse(scene(written)).success).toBe(false);
    expect(sceneSchema.safeParse(scene(normalizeVisibility(written))).success).toBe(true);
    // A duplicate is the same picture written twice and is refused too.
    expect(sceneSchema.safeParse(scene({ hiddenChains: [{ labelChain: 'A', copyId: 'one' },
      { labelChain: 'A', copyId: 'one' }], hiddenClasses: [], showOnlySelection: false })).success).toBe(false);
  });
});

describe('hiding part of the structure, as a command', () => {
  it('hides a canonical chain, confirms it in words, and says what is hidden now', async () => {
    const t = await setup();
    try {
      const chain = chainOf(t.rows[0]);
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-1',
        change: { kind: 'visibility', patch: { op: 'hide', chains: [chain] } } });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.visibility.hidden).toEqual({ hiddenChains: [chain], hiddenClasses: [], showOnlySelection: false });
      expect(queued.structuredContent.visibility.was).toBe('Everything is showing.');
      // 1CRN has one copy of chain A, so the wearer is told the chain and not a
      // copy number that distinguishes nothing.
      expect(queued.structuredContent.visibility.now).toBe('Hidden chain A.');
      expect(JSON.stringify(queued.content)).toMatch(/Hidden chain A\./);

      const delivery = await t.claim();
      // The panel is sent the whole hidden set after the edit, not the edit, so
      // it needs no memory of what was hidden a moment ago.
      expect(delivery.change).toEqual({ kind: 'visibility',
        patch: { hiddenChains: [chain], hiddenClasses: [], showOnlySelection: false } });

      const expected = expectedInspection(t.scene as any, delivery.change);
      const rendered = hiddenScene(t.scene, delivery.change.patch);
      expect(matchesInspectionChange(rendered, expected, delivery.change)).toBe(true);
      // Nothing else in the scene is the panel's to change under a hide.
      const moved = structuredClone(rendered); moved.inspection.placement.scale = 2;
      expect(matchesInspectionChange(moved, expected, delivery.change)).toBe(false);
      const other = structuredClone(rendered); other.inspection.visibility.hiddenClasses = ['water'];
      expect(matchesInspectionChange(other, expected, delivery.change)).toBe(false);
      // A panel that claimed to hide nothing has not done what was asked.
      expect(matchesInspectionChange(hiddenScene(t.scene, undefined), expected, delivery.change)).toBe(false);

      expect((await t.render(delivery, rendered)).command).toMatchObject({ status: 'rendered' });
      const state = await t.state();
      expect(state.view.visibility).toEqual({ hiddenChains: [chain], hiddenClasses: [], showOnlySelection: false });
    } finally { await t.close(); }
  });

  it('refuses a chain this model does not have and lists the ones it does', async () => {
    const t = await setup();
    try {
      const missing = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-missing',
        change: { kind: 'visibility', patch: { op: 'hide', chains: [{ labelChain: 'Z', copyId: 'nope' }] } } });
      expect(missing.isError).toBe(true);
      const text = JSON.stringify(missing.content);
      expect(text).toMatch(/no chain Z with copy id nope/);
      expect(text).toMatch(/use one of: A \(copy/);
      // Nothing was queued: a refusal is not a pending render the wearer waits on.
      expect((await t.state()).view.visibility).toBeUndefined();
    } finally { await t.close(); }
  });

  /**
   * `chains: ["A"]` used to fail MCP input validation before any of
   * this server's own rules ran, and the caller got the raw zod issue list —
   * `expected object, invalid_type, path change.patch.chains.0`
   * The same hide written as the
   * pair rendered in 559 ms, so the limit was a spelling and not a picture.
   */
  it('hides a chain named by its bare letter, and saves the canonical pair', async () => {
    const t = await setup();
    try {
      const chain = chainOf(t.rows[0]);
      for (const [commandId, written] of [['hide-bare', 'A'], ['hide-spoken', 'chain A'], ['hide-label', { labelChain: 'A' }]] as const) {
        const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId,
          change: { kind: 'visibility', patch: { op: 'hide', chains: [written] } } });
        expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
        expect(queued.structuredContent.visibility.now).toBe('Hidden chain A.');
        const delivery = await t.claim();
        // The panel is still sent the identity pair, never the letter: nothing
        // a receipt compares has been widened by accepting a referent.
        expect(delivery.change).toEqual({ kind: 'visibility',
          patch: { hiddenChains: [chain], hiddenClasses: [], showOnlySelection: false } });
        await t.render(delivery, hiddenScene(t.scene, delivery.change.patch));
        const reset = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: `${commandId}-reset`,
          change: { kind: 'visibility', patch: { op: 'reset' } } });
        expect(reset.isError).not.toBe(true);
        const undone = await t.claim();
        await t.render(undone, hiddenScene(t.scene, undefined));
      }
    } finally { await t.close(); }
  });

  it('refuses a bare letter this model does not have in one sentence, with no schema text', async () => {
    const t = await setup();
    try {
      const missing = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-bare-missing',
        change: { kind: 'visibility', patch: { op: 'hide', chains: ['Z'] } } });
      expect(missing.isError).toBe(true);
      const text = JSON.stringify(missing.content);
      expect(text).toMatch(/This structure has no chain Z: its chains are A\./);
      // The whole point of the defect: no zod path, code or type ever reaches
      // the model, and through it the wearer.
      expect(text).not.toMatch(/invalid_type|invalid_union|expected"|"path"|received/);
      expect((await t.state()).view.visibility).toBeUndefined();
    } finally { await t.close(); }
  });

  it('refuses an unreadable chain referent in plain language rather than a zod dump', async () => {
    const t = await setup();
    try {
      for (const written of [7, null, ['A']]) {
        const bad = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: `hide-bad-${JSON.stringify(written)}`,
          change: { kind: 'visibility', patch: { op: 'hide', chains: [written] } } });
        expect(bad.isError).toBe(true);
        const text = JSON.stringify(bad.content);
        expect(text, text).toMatch(/Name a chain by its label chain letter/);
        expect(text, text).not.toMatch(/invalid_type|invalid_union|received/);
      }
    } finally { await t.close(); }
  });

  it('reads back the identities a hide may name, so nobody has to guess a copy id', async () => {
    const t = await setup();
    try {
      const state = await t.state();
      // The classes THIS structure has, not the four a request may
      // spell. Crambin is polymer and nothing else, and a model that reads the
      // vocabulary here never asks to hide water that is not in the file.
      expect(state.visibilityTargets.classes).toEqual(['polymer']);
      expect(state.visibilityTargets.chains).toEqual([chainOf(t.rows[0])]);
      expect(state.visibilityTargets.chainCount).toBe(1);
    } finally { await t.close(); }
  });

  it('shows only what was named, and a reset brings the whole structure back', async () => {
    // This ran on crambin, which holds no ligand, and asserted the
    // three hidden classes that emptied the panel. It runs on haemoglobin now,
    // where there is a ligand to show; the crambin request is the refusal below.
    const t = await setup(hemoglobin);
    try {
      const only = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'only-1',
        change: { kind: 'visibility', patch: { op: 'only', classes: ['ligand'] } } });
      expect(only.isError, JSON.stringify(only.content)).not.toBe(true);
      const delivery = await t.claim();
      // 4HHB has no monatomic ion, so the complement names the two classes it
      // does have and the wearer is not told the ions went too.
      expect(delivery.change.patch.hiddenClasses).toEqual(['water', 'polymer']);
      expect(only.structuredContent.visibility.now).toBe('Hidden the water and the polymer.');
      const rendered = hiddenScene(t.scene, delivery.change.patch);
      await t.render(delivery, rendered);

      const reset = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'reset-1',
        change: { kind: 'visibility', patch: { op: 'reset' } } });
      expect(reset.isError).not.toBe(true);
      expect(reset.structuredContent.visibility.now).toBe('Everything is showing.');
      // Nothing hidden is the ABSENT field, so a reset's expected scene is the
      // scene an untouched panel saves rather than a second spelling of it.
      expect(reset.structuredContent.visibility.hidden).toBeUndefined();
      const back = await t.claim();
      expect(back.change.patch).toEqual({ hiddenChains: [], hiddenClasses: [], showOnlySelection: false });
      expect(expectedInspection(rendered as any, back.change).inspection.visibility).toBeUndefined();
      await t.render(back, hiddenScene(t.scene, undefined));
      expect((await t.state()).view.visibility).toBeUndefined();
    } finally { await t.close(); }
  });

  it('takes the hide back in one undo, restoring exactly what was hidden', async () => {
    const t = await setup(hemoglobin);
    try {
      const chain = chainOf(t.rows[0]);
      await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-2',
        change: { kind: 'visibility', patch: { op: 'hide', classes: ['water'] } } });
      const first = await t.claim();
      const water = hiddenScene(t.scene, first.change.patch);
      await t.render(first, water);

      await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-3',
        change: { kind: 'visibility', patch: { op: 'hide', chains: [chain] } } });
      const second = await t.claim();
      expect(second.change.patch.hiddenChains).toEqual([chain]);
      expect(second.change.patch.hiddenClasses).toEqual(['water']);
      await t.render(second, hiddenScene(t.scene, second.change.patch));

      const undo = await t.call('undo_last_change', { ...t.binding, panelId: t.panelId, commandId: 'undo-1' });
      expect(undo.structuredContent.undone).toBe(true);
      expect(undo.structuredContent.restores).toEqual(['visibility']);
      const back = await t.claim();
      // The earlier set comes back whole, not the edit reversed piecemeal.
      expect(back.change).toEqual({ kind: 'visibility',
        patch: { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false } });
      await t.render(back, water);
      expect((await t.state()).view.visibility).toEqual({ hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false });
    } finally { await t.close(); }
  });

  it('saves and restores a named view with its hidden set', async () => {
    const t = await setup(hemoglobin);
    try {
      await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-4',
        change: { kind: 'visibility', patch: { op: 'hide', classes: ['water', 'ligand'] } } });
      const hide = await t.claim();
      const hiddenWater = hiddenScene(t.scene, hide.change.patch);
      await t.render(hide, hiddenWater);

      const save = await t.call('manage_inspection_view', { ...t.binding, panelId: t.panelId,
        commandId: 'view-save', action: 'save', name: 'Protein only' });
      expect(save.isError).not.toBe(true);
      const saveDelivery = await t.claim();
      expect(saveDelivery.change.kind).toBe('save-view');
      const saved = await t.render(saveDelivery, hiddenWater);
      expect(saved.savedView.viewIntent.hiddenCount).toBe(2);
      const viewId = saved.savedView.id as string;

      // Bring everything back, then restore the view: the hidden set must return.
      await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'reset-2',
        change: { kind: 'visibility', patch: { op: 'reset' } } });
      const reset = await t.claim();
      await t.render(reset, hiddenScene(t.scene, undefined));
      expect((await t.state()).view.visibility).toBeUndefined();

      const restore = await t.call('manage_inspection_view', { ...t.binding, panelId: t.panelId,
        commandId: 'view-restore', action: 'restore', viewId });
      expect(restore.isError).not.toBe(true);
      const restoreDelivery = await t.claim();
      // The named-view scene IS the full supported scene, hidden set included.
      expect(restoreDelivery.change.patch.scene.inspection.visibility)
        .toEqual({ hiddenChains: [], hiddenClasses: ['water', 'ligand'], showOnlySelection: false });
      const receipt = await t.render(restoreDelivery, restoreDelivery.change.patch.scene);
      expect(receipt.command).toMatchObject({ status: 'rendered' });
      expect((await t.state()).view.visibility)
        .toEqual({ hiddenChains: [], hiddenClasses: ['water', 'ligand'], showOnlySelection: false });

      // A panel that dropped the hidden set on the way back is not the view.
      const wrong = structuredClone(restoreDelivery.change.patch.scene);
      delete wrong.inspection.visibility;
      const second = await t.call('manage_inspection_view', { ...t.binding, panelId: t.panelId,
        commandId: 'view-restore-2', action: 'restore', viewId });
      expect(second.isError).not.toBe(true);
      const again = await t.claim();
      expect((await t.render(again, wrong)).command).toMatchObject({ status: 'unconfirmed' });
    } finally { await t.close(); }
  });

  it('carries a hide inside a compound, as one render and one undo', async () => {
    const t = await setup(hemoglobin);
    try {
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'compound-1',
        change: { kind: 'compound', patch: { ops: [
          { kind: 'visibility', patch: { op: 'hide', classes: ['water'] } },
          { kind: 'appearance', patch: { opacity: 0.5 } },
        ] } } });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.compound.ops).toEqual(['visibility', 'appearance']);
      const delivery = await t.claim();
      // The caller's op is expanded into the panel's whole hidden set here, the
      // same way a lesson part name is expanded into the whole colour key.
      expect(delivery.change.patch.ops[0]).toEqual({ kind: 'visibility',
        patch: { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false } });

      const expected = expectedInspection(t.scene as any, delivery.change);
      const rendered = hiddenScene(t.scene, delivery.change.patch.ops[0].patch);
      rendered.inspection.appearance.opacity = 0.5;
      expect(matchesInspectionChange(rendered, expected, delivery.change)).toBe(true);
      await t.render(delivery, rendered);

      const undo = await t.call('undo_last_change', { ...t.binding, panelId: t.panelId, commandId: 'undo-2' });
      expect(undo.structuredContent.restores.sort()).toEqual(['appearance', 'visibility']);
    } finally { await t.close(); }
  });
});

/**
 * On one device session, "hide the water" on 1CRN -- 327 atom
 * sites, no HOH -- came back "Hidden the water", the plate drew `Applied.
 * change. r6`, and nothing on the glass moved. The wearer was told a change
 * they were looking straight at had happened. SHARED.md asks an unsupported
 * request to explain its limit instead, so a class this structure has none of
 * is now named and refused before anything is queued.
 */
describe('hiding a class the structure does not contain', () => {
  it('refuses a hide naming only absent classes, and names the structure and the class', async () => {
    const t = await setup();
    try {
      const before = await t.state();
      const missing = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-absent',
        change: { kind: 'visibility', patch: { op: 'hide', classes: ['water'] } } });
      expect(missing.isError).toBe(true);
      const text = JSON.stringify(missing.content);
      expect(text, text).toMatch(/1CRN has no water to hide\./);
      // The whole defect: nothing anywhere in the reply may read as a hide that
      // happened, because none did.
      expect(text, text).not.toMatch(/Hidden/);
      // A refusal is not a pending render. Nothing was queued, nothing was
      // saved, and the revision the plate prints did not move.
      expect(await t.claim()).toBeUndefined();
      const after = await t.state();
      expect(after.view.visibility).toBeUndefined();
      expect(after.inspectionRevision).toBe(before.inspectionRevision);
    } finally { await t.close(); }
  });

  it('refuses the same request inside a compound, so no half of it is queued', async () => {
    const t = await setup();
    try {
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'compound-absent',
        change: { kind: 'compound', patch: { ops: [
          { kind: 'visibility', patch: { op: 'hide', classes: ['water'] } },
          { kind: 'appearance', patch: { opacity: 0.5 } },
        ] } } });
      expect(queued.isError).toBe(true);
      expect(JSON.stringify(queued.content)).toMatch(/1CRN has no water to hide\./);
      expect(await t.claim()).toBeUndefined();
      expect((await t.state()).view.visibility).toBeUndefined();
    } finally { await t.close(); }
  });

  it('hides the classes the structure does have and says which of them it has none of', async () => {
    const t = await setup(hemoglobin);
    try {
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-mixed',
        change: { kind: 'visibility', patch: { op: 'hide', classes: ['water', 'ion'] } } });
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      // 4HHB carries waters, haems and a phosphate, and no monatomic ion. The
      // half of the request the structure can answer is answered; the other
      // half is explained in the same reply rather than silently confirmed.
      expect(queued.structuredContent.visibility.hidden)
        .toEqual({ hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false });
      expect(queued.structuredContent.visibility.now).toBe('Hidden the water.');
      expect(queued.structuredContent.visibility.absent).toEqual(['ion']);
      const text = JSON.stringify(queued.content);
      expect(text, text).toMatch(/Hidden the water\./);
      expect(text, text).toMatch(/4HHB has no ions\./);
      const delivery = await t.claim();
      expect(delivery.change.patch.hiddenClasses).toEqual(['water']);
    } finally { await t.close(); }
  });

  it('leaves a hide naming only classes the structure has exactly as it was', async () => {
    const t = await setup(hemoglobin);
    try {
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'hide-present',
        change: { kind: 'visibility', patch: { op: 'hide', classes: ['water', 'ligand'] } } });
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      expect(queued.structuredContent.visibility.hidden)
        .toEqual({ hiddenChains: [], hiddenClasses: ['water', 'ligand'], showOnlySelection: false });
      expect(queued.structuredContent.visibility.now).toBe('Hidden the water and the ligands.');
      expect(queued.structuredContent.visibility.absent).toBeUndefined();
      expect(JSON.stringify(queued.content)).not.toMatch(/has no/);
      const delivery = await t.claim();
      expect(delivery.change).toEqual({ kind: 'visibility',
        patch: { hiddenChains: [], hiddenClasses: ['water', 'ligand'], showOnlySelection: false } });
      await t.render(delivery, hiddenScene(t.scene, delivery.change.patch));
      expect((await t.state()).view.visibility)
        .toEqual({ hiddenChains: [], hiddenClasses: ['water', 'ligand'], showOnlySelection: false });
    } finally { await t.close(); }
  });

  it('reads back the classes this structure has, so nobody names one it lacks', async () => {
    const t = await setup(hemoglobin);
    try {
      expect((await t.state()).visibilityTargets.classes).toEqual(['water', 'ligand', 'polymer']);
    } finally { await t.close(); }
  });

  it('refuses a show the same way, in the verb the request used', async () => {
    const t = await setup();
    try {
      const shown = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'show-absent',
        change: { kind: 'visibility', patch: { op: 'show', classes: ['water'] } } });
      expect(shown.isError).toBe(true);
      expect(JSON.stringify(shown.content)).toMatch(/1CRN has no water to show\./);
      expect(await t.claim()).toBeUndefined();
    } finally { await t.close(); }
  });

  /**
   * D104 taught hide and show to refuse an absent class and left
   * `only` computing its complement over all four names, so on one device session "show
   * only the ligand" on 1CRN hid water, ion and polymer: an empty panel under an
   * `Applied` receipt, from the one request a wearer makes in order to see
   * something. `only` now refuses on the same terms and in the same sentence.
   */
  it('refuses showing only a class the structure has none of, and saves nothing', async () => {
    const t = await setup();
    try {
      const before = await t.state();
      const only = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'only-absent',
        change: { kind: 'visibility', patch: { op: 'only', classes: ['ligand'] } } });
      expect(only.isError).toBe(true);
      const text = JSON.stringify(only.content);
      expect(text, text).toMatch(/1CRN has no ligands to show only\./);
      expect(text, text).not.toMatch(/Hidden/);
      expect(await t.claim()).toBeUndefined();
      const after = await t.state();
      expect(after.view.visibility).toBeUndefined();
      expect(after.inspectionRevision).toBe(before.inspectionRevision);
    } finally { await t.close(); }
  });

  it('refuses it with a chain named as well, because that intersection is empty too', async () => {
    const t = await setup();
    try {
      const before = await t.state();
      const only = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'only-absent-chain',
        change: { kind: 'visibility', patch: { op: 'only', chains: [chainOf(t.rows[0])], classes: ['water'] } } });
      expect(only.isError).toBe(true);
      expect(JSON.stringify(only.content)).toMatch(/1CRN has no water to show only\./);
      expect(await t.claim()).toBeUndefined();
      expect((await t.state()).inspectionRevision).toBe(before.inspectionRevision);
    } finally { await t.close(); }
  });

  it('refuses the same request inside a compound, so no half of it is queued', async () => {
    const t = await setup();
    try {
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'compound-only-absent',
        change: { kind: 'compound', patch: { ops: [
          { kind: 'visibility', patch: { op: 'only', classes: ['ion'] } },
          { kind: 'appearance', patch: { opacity: 0.5 } },
        ] } } });
      expect(queued.isError).toBe(true);
      expect(JSON.stringify(queued.content)).toMatch(/1CRN has no ions to show only\./);
      expect(await t.claim()).toBeUndefined();
      expect((await t.state()).view.visibility).toBeUndefined();
    } finally { await t.close(); }
  });

  it('shows the classes the structure does have and says which of them it has none of', async () => {
    const t = await setup(hemoglobin);
    try {
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'only-mixed',
        change: { kind: 'visibility', patch: { op: 'only', classes: ['ion', 'ligand'] } } });
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      // 4HHB has ligands and no monatomic ion. The half it can answer is
      // answered, and the other half is explained in the same reply.
      expect(queued.structuredContent.visibility.hidden)
        .toEqual({ hiddenChains: [], hiddenClasses: ['water', 'polymer'], showOnlySelection: false });
      expect(queued.structuredContent.visibility.now).toBe('Hidden the water and the polymer.');
      expect(queued.structuredContent.visibility.absent).toEqual(['ion']);
      const text = JSON.stringify(queued.content);
      expect(text, text).toMatch(/4HHB has no ions\./);
      const delivery = await t.claim();
      expect(delivery.change.patch.hiddenClasses).toEqual(['water', 'polymer']);
    } finally { await t.close(); }
  });

  it('refuses an only whose chain and class share no residue, so nothing empties the panel', async () => {
    const t = await setup(hemoglobin);
    try {
      // Chain A of haemoglobin is polymer, and its intersection with the water
      // is nothing. Both halves name something 4HHB has, so no class is absent
      // and only the picture says the request cannot be drawn.
      const before = await t.state();
      const only = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'only-empty',
        change: { kind: 'visibility', patch: { op: 'only', chains: [chainOf(t.rows[0])], classes: ['water'] } } });
      expect(only.isError).toBe(true);
      const text = JSON.stringify(only.content);
      expect(text, text).toMatch(/4HHB has nothing that is both of those/);
      expect(text, text).not.toMatch(/Hidden/);
      expect(await t.claim()).toBeUndefined();
      expect((await t.state()).inspectionRevision).toBe(before.inspectionRevision);
    } finally { await t.close(); }
  });
});

describe('what the contract promises about a hidden set', () => {
  const base = {
    sourceSha256: 'b'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: [],
    camera: { mode: 'perspective', fov: 1, position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0],
      radius: 1, radiusMax: 1, fog: 0, clipFar: false, minNear: .1, minFar: .1 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  } as any;
  const catalog = { source: { sha256: 'b'.repeat(64) }, modelNumbers: [1], assemblyId: '1',
    rows: [{ key: 'k1', identity: { modelNumber: 1, labelChain: 'A', copyId: 'one', componentId: 'ALA' } }] };

  it.each([[[]], [['k1']]])('pins even an unchanged or empty captured selection %j', (selectionKeys) => {
    const referent = { sourceToken: 'source', capturedAt: 1, selectionKeys };
    const scene = { ...base, selectionKeys };
    const change = bindVisibilitySelection({ kind: 'visibility',
      patch: { hiddenChains: [], hiddenClasses: [], showOnlySelection: true } }, referent);
    expect(change).toEqual({ kind: 'compound', patch: { ops: [
      { kind: 'selection', patch: { selectionKeys } },
      { kind: 'visibility', patch: { hiddenChains: [], hiddenClasses: [], showOnlySelection: true } },
    ] } });
    expect(referentAppliedTo(change, referent, scene, catalog, undefined, true))
      .toEqual({ capturedAt: 1, selectionKeys });
    const expected = expectedInspection(scene, change);
    expect(matchesInspectionChange(sceneSchema.parse(expected), expected, change)).toBe(true);
    const wrong = structuredClone(expected);
    wrong.selectionKeys = selectionKeys.length ? [] : ['k1'];
    expect(matchesInspectionChange(wrong, expected, change)).toBe(false);
  });

  it('confirms a compound with visibility before emphasis only when every captured field matches', () => {
    const referent = { sourceToken: 'source', capturedAt: 1, selectionKeys: ['k1'] };
    const change = bindVisibilitySelection({ kind: 'compound', patch: { ops: [
      { kind: 'visibility', patch: { hiddenChains: [], hiddenClasses: [], showOnlySelection: true } },
      { kind: 'emphasis', patch: { parts: [], focus: [], contextOpacity: 0.12 } },
    ] } }, referent);
    const expected = expectedInspection(base, change);
    const rendered = sceneSchema.parse(expected);
    expect(matchesInspectionChange(rendered, expected, change)).toBe(true);
    for (const field of ['selection', 'visibility', 'emphasis']) {
      const wrong = structuredClone(rendered);
      if (field === 'selection') wrong.selectionKeys = [];
      if (field === 'visibility') delete wrong.inspection.visibility;
      if (field === 'emphasis') delete wrong.inspection.emphasis;
      expect(matchesInspectionChange(wrong, expected, change), field).toBe(false);
    }
  });

  it('an empty hidden set is written by leaving the field out, not by saving one', () => {
    expect(() => validateScene(base, catalog)).not.toThrow();
    const empty = structuredClone(base);
    empty.inspection.visibility = { hiddenChains: [], hiddenClasses: [], showOnlySelection: false };
    expect(() => validateScene(empty, catalog)).toThrow(/leaves inspection.visibility out/);
  });

  it('a hidden chain must be a canonical identity from this model', () => {
    const good = structuredClone(base);
    good.inspection.visibility = { hiddenChains: [{ labelChain: 'A', copyId: 'one' }], hiddenClasses: [], showOnlySelection: false };
    expect(() => validateScene(good, catalog)).not.toThrow();
    const bad = structuredClone(base);
    bad.inspection.visibility = { hiddenChains: [{ labelChain: 'A', copyId: 'two' }], hiddenClasses: [], showOnlySelection: false };
    expect(() => validateScene(bad, catalog)).toThrow(/canonical label chain and copy id/);
  });

  it('a hide is an undoable field, and a compound can hold visibility plus the other scene fields', () => {
    expect(COMPOUND_MAX_OPS).toBe(7);
    const after = structuredClone(base);
    after.inspection.visibility = { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false };
    expect(movedFields(base, after)).toEqual(['visibility']);
    // Absent and explicitly empty are the same picture, so neither is a change.
    const spelled = structuredClone(base);
    spelled.inspection.visibility = { hiddenChains: [], hiddenClasses: [], showOnlySelection: false };
    expect(movedFields(base, spelled)).toEqual([]);
    expect(undoChangeFor({ id: 'x', at: 0, origin: 'manual', surface: 'desktop', label: 'manual',
      before: base, after } as any)).toEqual({ kind: 'visibility',
      patch: { hiddenChains: [], hiddenClasses: [], showOnlySelection: false } });
  });

  it('is refused as a change a caller cannot have meant', () => {
    const change = (patch: unknown) => updateInspectionSchema.shape.change.safeParse({ kind: 'visibility', patch });
    expect(change({ op: 'hide', classes: ['water'] }).success).toBe(true);
    expect(change({ op: 'reset' }).success).toBe(true);
    expect(change({ op: 'only', selection: true }).success).toBe(true);
    expect(change({ op: 'hide' }).success).toBe(false);
    expect(change({ op: 'reset', classes: ['water'] }).success).toBe(false);
    expect(change({ op: 'hide', selection: true }).success).toBe(false);
    expect(change({ op: 'only', selection: true, classes: ['water'] }).success).toBe(false);
    expect(change({ op: 'vanish', classes: ['water'] }).success).toBe(false);
    // The RESOLVED change is what the panel is handed, and it is the full set.
    expect(inspectionChangeSchema.safeParse({ kind: 'visibility',
      patch: { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false } }).success).toBe(true);
    expect(inspectionChangeSchema.safeParse({ kind: 'visibility', patch: { op: 'hide' } }).success).toBe(false);
  });
});
