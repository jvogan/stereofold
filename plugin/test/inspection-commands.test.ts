import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { inspectionFailureReceipt, rendererContextReport } from '../src/inspection-failure-receipt.js';
import { MAX_INSPECTION_VIEWS } from '../src/inspection-views.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hydrateComparisonSource } from '../src/inspection-chunk-client.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Shared browser fixture has no TypeScript declaration.
import { tourFocusHarness } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';
// @ts-expect-error Shared browser fixture has no TypeScript declaration.
import { syntheticViews } from '../../lab/browser-roundtrip/fixtures/component-label-diagnostics.mjs';
// @ts-expect-error Shared browser transaction has no TypeScript declaration.
import { interruptibleCommand } from '../../lab/inspection/interruptible-command.mjs';
// @ts-expect-error Shared browser publication guard has no TypeScript declaration.
import { createNamedPublication } from '../../lab/inspection/named-publication.mjs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { decodeInspectionCatalog, verifyInspectionCatalogSource } from '../src/inspection-catalog-codec.js';
import { expectedInspection, availabilityCauseSchema, completeInspectionSchema, PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { choosePanel, COMPANION_LOADING_MESSAGE } from '../scripts/agent-arguments.js';
import { sendAgentCall, type AgentCall } from '../scripts/inspection-agent.js';
import { converse } from '../scripts/converse.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

type Binding = {
  sessionId: string;
  serverEpoch: string;
  sourceToken: string;
  baseStateRevision: number;
  baseInspectionRevision: number;
};

async function setup(structureText = cif, options: Parameters<typeof createStereoStructureServer>[1] = {}, placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, surface: 'desktop' | 'companion' = 'desktop') {
  const clock = { now: 0 };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { ...options, now: () => clock.now });
  const client = new Client({ name: 'Stereofold inspection command test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({
    name: `stereo_structure.${name}`,
    arguments: args,
  }) as Promise<any>;
  const opened = await call('inspect', { structureText });
  expect(opened.isError).not.toBe(true);
  const sessionId = opened.structuredContent.sessionId as string;
  const hydrated = await call('get_inspection', { sessionId });
  const privateData = hydrated._meta[PRIVATE_KEY];
  privateData.catalog = await decodeInspectionCatalog(privateData.catalogWire ?? privateData.catalog);
  const scene = {
    sourceSha256: privateData.catalog.source.sha256,
    modelNumber: privateData.catalog.modelNumbers[0],
    assemblyId: privateData.catalog.assemblyId,
    selectionKeys: [privateData.catalog.rows[0].key],
    camera: {
      mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0,
    },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015', opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: structuredClone(placement),
    },
  };
  const initial: Binding = {
    sessionId,
    serverEpoch: privateData.serverEpoch,
    sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision,
    baseInspectionRevision: privateData.inspectionRevision,
  };
  const saved = await call('sync_inspection', { ...initial, scene });
  expect(saved.structuredContent.saved).toBe(true);
  const binding: Binding = {
    ...initial,
    baseStateRevision: saved.structuredContent.stateRevision,
    baseInspectionRevision: saved.structuredContent.inspectionRevision,
  };
  const attached = await call('attach_inspection', { ...binding, surface });
  const panelId = attached.structuredContent.panelId as string;
  const current = async (commandId?: string) => call('get_inspection_state', {
    sessionId,
    ...(commandId == null ? {} : { commandId }),
  });
  const poll = async (availability: 'ready' | 'busy' | 'unsaved' = 'ready', expected = binding, panel = panelId) => {
    const result = await call('poll_inspection', { ...expected, panelId: panel, availability });
    return { result, delivery: result._meta?.[PRIVATE_KEY]?.delivery };
  };
  const close = async () => { await client.close(); await server.close(); };
  return { clock, client, server, call, sessionId, scene, binding, panelId, current, poll, close };
}

function update(binding: Binding, panelId: string, commandId: string, change: Record<string, unknown>) {
  return { ...binding, panelId, commandId, change };
}

describe('shared history admission preserves the acting panel viewpoint', () => {
  async function historyClaim(change: any = { kind: 'appearance', patch: { background: '#445566' } }) {
    const t = await setup();
    try {
      await t.call('update_inspection', update(t.binding, t.panelId, 'original-edit', change));
      const original = (await t.poll()).delivery;
      const shared = expectedInspection(t.scene as any, change);
      const completed = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: original.commandId, claimToken: original.claimToken, scene: shared });
      expect(completed.structuredContent.command.status).toBe('rendered');
      const binding = { ...t.binding, baseInspectionRevision: completed.structuredContent.inspectionRevision };
      const panelId = (await t.call('attach_inspection', { ...binding, surface: 'desktop' })).structuredContent.panelId;
      await t.call('undo_last_change', { ...binding, panelId, commandId: 'peer-undo' });
      const delivery = (await t.poll('ready', binding, panelId)).delivery;
      expect(delivery.historyAction).toBe('undo');
      const claim = { ...binding, panelId, commandId: delivery.commandId, claimToken: delivery.claimToken };
      // Following a shared edit retains this peer's own already-clean view.
      const local = structuredClone(shared);
      local.camera.position = [7, 3, 75];
      local.camera.radius = 17;
      local.inspection.placement = { translation: [1, 2, -3], rotation: [0, 35, 0], scale: 1.25 };
      return { t, binding, panelId, shared, delivery, claim, local };
    } catch (error) { await t.close(); throw error; }
  }

  it('binds each peer pose before Undo and Redo and consumes exactly one history entry per completion', async () => {
    const h = await historyClaim(), { t } = h;
    try {
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
      const admitted = await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: h.local });
      expect(admitted.structuredContent.admitted).toBe(true);
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
      const undone = expectedInspection(h.local, h.delivery.change);
      expect(undone.inspection.appearance).toEqual(t.scene.inspection.appearance);
      const receipt = { ...h.claim, scene: undone };
      const completed = await t.call('complete_inspection', receipt);
      expect(completed.structuredContent.command.status).toBe('rendered');
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(undone);
      await t.call('complete_inspection', receipt);
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 0, redoCount: 1 });

      const fresh = { ...h.binding, baseInspectionRevision: completed.structuredContent.inspectionRevision };
      await t.call('redo_last_change', { ...fresh, panelId: h.panelId, commandId: 'peer-redo' });
      const redo = (await t.poll('ready', fresh, h.panelId)).delivery;
      expect(redo.historyAction).toBe('redo');
      const redoClaim = { ...fresh, panelId: h.panelId, commandId: redo.commandId, claimToken: redo.claimToken };
      const nextLocal = structuredClone(undone);
      nextLocal.camera.position = [-4, 1, 60];
      nextLocal.inspection.placement.rotation = [5, -40, 0];
      expect((await t.call('complete_inspection', { ...redoClaim, phase: 'admit', historyScene: nextLocal })).structuredContent.admitted).toBe(true);
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 0, redoCount: 1 });
      const redone = expectedInspection(nextLocal, redo.change);
      const redoneReceipt = { ...redoClaim, scene: redone };
      expect((await t.call('complete_inspection', redoneReceipt)).structuredContent.command.status).toBe('rendered');
      await t.call('complete_inspection', redoneReceipt);
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(redone);
      expect(redone.inspection.appearance).toEqual(h.shared.inspection.appearance);
      expect(redone.camera).toEqual(nextLocal.camera);
      expect(redone.inspection.placement).toEqual(nextLocal.inspection.placement);
    } finally { await t.close(); }
  });

  it.each(['placement', 'compound'] as const)('an Undo owning %s overrides the admitted local placement exactly', async kind => {
    const placement = { kind: 'placement', patch: { scale: 2, rotation: [0, 60, 0], translation: [3, 0, -2] } };
    const change = kind === 'placement' ? placement : { kind: 'compound', patch: { ops: [placement,
      { kind: 'appearance', patch: { background: '#445566' } }] } };
    const h = await historyClaim(change), { t } = h;
    try {
      expect((await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: h.local })).structuredContent.admitted).toBe(true);
      const wrong = expectedInspection(h.local, h.delivery.change);
      wrong.inspection.placement = structuredClone(h.local.inspection.placement);
      expect((await t.call('complete_inspection', { ...h.claim, scene: wrong })).structuredContent.command.status).toBe('unconfirmed');
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
      await t.call('undo_last_change', { ...h.binding, panelId: h.panelId, commandId: 'retry-placement-undo' });
      const retry = (await t.poll('ready', h.binding, h.panelId)).delivery;
      const claim = { ...h.binding, panelId: h.panelId, commandId: retry.commandId, claimToken: retry.claimToken };
      expect((await t.call('complete_inspection', { ...claim, phase: 'admit', historyScene: h.local })).structuredContent.admitted).toBe(true);
      const restored = expectedInspection(h.local, retry.change);
      expect(restored.inspection.placement).toEqual(t.scene.inspection.placement);
      expect(restored.camera).toEqual(h.local.camera);
      expect((await t.call('complete_inspection', { ...claim, scene: restored })).structuredContent.command.status).toBe('rendered');
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 0, redoCount: 1 });
    } finally { await t.close(); }
  });

  it.each(['appearance', 'selection', 'source'] as const)('refuses changed %s at admission without consuming history or admitting the command', async field => {
    const h = await historyClaim(), { t } = h;
    try {
      const changed = structuredClone(h.local);
      if (field === 'appearance') changed.inspection.appearance.opacity = .5;
      else if (field === 'selection') changed.selectionKeys = [];
      else changed.sourceSha256 = '0'.repeat(64);
      const refused = await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: changed });
      expect(refused.structuredContent?.admitted).not.toBe(true);
      expect(refused.isError === true || refused.structuredContent?.admitted === false).toBe(true);
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(h.shared);
      expect((await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: h.local })).structuredContent.admitted).toBe(true);
    } finally { await t.close(); }
  });

  it.each(['revision', 'claim'] as const)('refuses a stale %s before binding a local viewpoint', async invalid => {
    const h = await historyClaim(), { t } = h;
    try {
      const claim = { ...h.claim, ...(invalid === 'revision'
        ? { baseInspectionRevision: h.claim.baseInspectionRevision - 1 } : { claimToken: randomUUID() }) };
      expect((await t.call('complete_inspection', { ...claim, phase: 'admit', historyScene: h.local })).isError).toBe(true);
      expect((await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: h.local })).structuredContent.admitted).toBe(true);
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
    } finally { await t.close(); }
  });

  it.each(['placement', 'camera'] as const)('refuses %s movement after admission, including a second admission attempt', async field => {
    const h = await historyClaim(), { t } = h;
    try {
      expect((await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: h.local })).structuredContent.admitted).toBe(true);
      const moved = structuredClone(h.local);
      if (field === 'placement') moved.inspection.placement.rotation[1] += 10;
      else moved.camera.position[0] += 10;
      expect((await t.call('complete_inspection', { ...h.claim, phase: 'admit', historyScene: moved })).structuredContent.admitted).toBe(false);
      const scene = expectedInspection(moved, h.delivery.change);
      expect((await t.call('complete_inspection', { ...h.claim, scene })).structuredContent.command.status).toBe('unconfirmed');
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 1, redoCount: 0 });
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(h.shared);
    } finally { await t.close(); }
  });

  it('does not let an ordinary command opt into history viewpoint admission', async () => {
    const t = await setup();
    try {
      const change = { kind: 'appearance', patch: { background: '#445566' } };
      await t.call('update_inspection', update(t.binding, t.panelId, 'ordinary-edit', change));
      const { delivery } = await t.poll();
      const claim = { ...t.binding, panelId: t.panelId, commandId: delivery.commandId, claimToken: delivery.claimToken };
      const local = structuredClone(t.scene); local.inspection.placement.rotation[1] = 35;
      const refused = await t.call('complete_inspection', { ...claim, phase: 'admit', historyScene: local });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/Only a shared Undo or Redo/);
      expect((await t.call('complete_inspection', { ...claim, phase: 'admit' })).structuredContent.admitted).toBe(true);
      expect((await t.call('complete_inspection', { ...claim, scene: expectedInspection(local as any, change as any) })).structuredContent.command.status).toBe('unconfirmed');
      expect((await t.current()).structuredContent.history).toMatchObject({ undoCount: 0, redoCount: 0 });
    } finally { await t.close(); }
  });

  it('accepts historyScene only during admission while keeping legacy admission valid', async () => {
    const t = await setup();
    try {
      const base = { ...t.binding, panelId: t.panelId, commandId: 'schema-history', claimToken: randomUUID() };
      expect(completeInspectionSchema.safeParse({ ...base, phase: 'admit' }).success).toBe(true);
      expect(completeInspectionSchema.safeParse({ ...base, phase: 'admit', historyScene: t.scene }).success).toBe(true);
      for (const lifecycle of [{ phase: 'settled' }, { phase: 'defer-local-save' }, { scene: t.scene }, { failure: 'render_failed' }])
        expect(completeInspectionSchema.safeParse({ ...base, ...lifecycle, historyScene: t.scene }).success).toBe(false);
    } finally { await t.close(); }
  });
});

// Exercise the shipped remote dispatcher and XR placement closures together.
// The tour fixture substitutes only drawing, tracking and scientific bounds.
function placementRenderer(scene: any) {
  const view = tourFocusHarness();
  view.h.latestRoomPlacementPose.labelViews = syntheticViews();
  // Real measurable cube geometry, with source radius and metre conversion
  // independent of the solver. An absent render object must never stand in for
  // a clear explicit pose.
  view.h.loadedSphere = () => ({ center: [0, 0, 0], radius: 1 });
  view.h.canvas.camera.scale = 1;
  const cell = (value: unknown) => ({ ref: { value } });
  const object = { type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(36), instanceCount: cell(1), uVertexCount: cell(8),
    aPosition: cell(new Float32Array([-.4,-.4,-.4, .4,-.4,-.4, -.4,.4,-.4, .4,.4,-.4,
      -.4,-.4,.4, .4,-.4,.4, -.4,.4,.4, .4,.4,.4])),
    aTransform: cell(view.h.placementTransform(scene.inspection.placement)),
  } };
  view.h.applyInspectionTransform = () => { object.values.aTransform.ref.value = view.h.placementTransform(view.snapshot().placement); };
  view.h.scientificRepresentations = () => [{ renderObjects: [object] }];
  view.h.presentationTransform = () => view.h.placementTransform(view.snapshot().placement);
  view.h.inspectionState.place(scene.inspection.placement);
  const capture = () => ({ ...structuredClone(scene), inspection: {
    ...structuredClone(scene.inspection), placement: structuredClone(view.snapshot().placement) } });
  const viewer = { snapshot: () => ({ xrPresenting: true }), inspection: {
    capture, place: view.h.placeInspection, placementFitEvidence: view.h.placementFitEvidence,
    restore: async (before: any) => view.h.inspectionState.place(before.inspection.placement),
  } };
  const source = readFileSync(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
  const remote = source.slice(source.indexOf('  applyRemote:') + '  applyRemote:'.length, source.lastIndexOf('\n});')).trim().replace(/,$/, '');
  const apply = new Function('run', 'namedPublication', 'interruptibleCommand', 'viewer', `return (${remote});`)(
    async (_message: string, action: () => Promise<unknown>) => action(), createNamedPublication(() => {}), interruptibleCommand, viewer);
  return { ...view, capture, apply };
}

it('XR dispatcher refuses a colliding explicit placement without fitting or confirming it', async () => {
  const t = await setup(), renderer = placementRenderer(t.scene);
  try {
    const before = renderer.capture(); let confirmed = false;
    await expect(renderer.apply({ kind: 'placement', patch: { scale: 20, translation: [0, 0, -12] } },
      async () => {}, async () => { confirmed = true; })).rejects.toThrow(/would cover the menu/);
    expect(confirmed).toBe(false);
    expect(renderer.capture()).toEqual(before);
    expect(renderer.h.wearerPlacement.holdsPlacement()).toBe(false);
  } finally { await t.close(); }
});

it.each([
  { name: 'scale-up with unrequested menu translation', patch: { scale: 2 }, result: { scale: 2, translation: [1.5, 0, 0] } },
  { name: 'rotation-only with unrequested translation', patch: { rotation: [0, 45, 0] }, result: { rotation: [0, 45, 0], translation: [1.5, 0, 0] } },
  { name: 'scale-down with unrequested translation', patch: { scale: .5 }, result: { scale: .5, translation: [1, 0, 0] } },
  { name: 'full-range wrong translation', patch: { scale: 2 }, result: { scale: 2, translation: [10, -10, 10] } },
  { name: 'one-millionth radius drift', patch: { scale: 2 }, result: { scale: 2, translation: [0, .000001, 0] } },
  { name: 'one-millionth scale drift', patch: { scale: 2 }, result: { scale: 2.000001 } },
  { name: 'explicit fractional position drift', patch: { translation: [.123456789, 0, 0] }, result: { translation: [.123457789, 0, 0] } },
])('reports $name as not rendered as requested without committing or consuming undo', async ({ patch, result }) => {
  const t = await setup();
  try {
    await t.call('update_inspection', update(t.binding, t.panelId, 'precision', { kind: 'placement', patch }));
    const { delivery } = await t.poll();
    const rendered = structuredClone(t.scene);
    Object.assign(rendered.inspection.placement, result);
    const response = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
      commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered });
    expect(response.structuredContent.command).toMatchObject({ status: 'unconfirmed', detail: 'The placement was not rendered as requested.' });
    expect(response.structuredContent.command.renderedAt).toBeUndefined();
    expect((await t.current()).structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision);
    expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(t.scene);
    expect((await t.call('undo_last_change', { ...t.binding, panelId: t.panelId, commandId: 'no-precision-undo' })).structuredContent.undone).toBe(false);
  } finally { await t.close(); }
});

it('renders absolute placement, scale-down and undo through the production XR dispatcher with safe history', async () => {
  const t = await setup(cif, {}, { scale: 1, rotation: [0, 0, 0], translation: [1, 0, -2] }), renderer = placementRenderer(t.scene);
  try {
    let binding = t.binding;
    const draw = async (id: string, patch?: object) => {
      if (patch) await t.call('update_inspection', update(binding, t.panelId, id, { kind: 'placement', patch }));
      else await t.call('undo_last_change', { ...binding, panelId: t.panelId, commandId: id });
      const { delivery } = await t.poll('ready', binding);
      expect(delivery).toBeDefined();
      await renderer.apply(delivery.change, async () => {}, async (scene: any, result: any) => {
        const completed = await t.call('complete_inspection', { ...binding, panelId: t.panelId,
          commandId: id, claimToken: delivery.claimToken, scene,
          ...(result?.placementAdjusted ? { placementAdjusted: true, placementFit: result.placementFit } : {}) });
        expect(completed.structuredContent.command.status).toBe('rendered');
        binding = { ...binding, baseInspectionRevision: completed.structuredContent.inspectionRevision };
      }, undefined, delivery.historyAction ? { preservePlacement: true } : {});
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(renderer.capture());
    };
    const placed = { scale: 20, rotation: [0, 30, 0], translation: [16, 0, -12] };
    await draw('absolute-up', placed);
    expect(renderer.snapshot().placement.rotation).toEqual(placed.rotation);
    expect(renderer.snapshot().placement).toEqual(placed);
    const before = renderer.capture();
    await draw('absolute-down', { scale: .5, translation: [1, 0, -2] });
    await draw('undo-down');
    expect(renderer.capture()).toEqual(before);
    await draw('undo-up');
    expect(renderer.capture().inspection.placement).toEqual(t.scene.inspection.placement);
    expect(renderer.h.wearerPlacement.holdsPlacement()).toBe(false);
    expect(renderer.capture().inspection.placement.rotation).toEqual(t.scene.inspection.placement.rotation);
    expect((await t.call('undo_last_change', { ...binding, panelId: t.panelId, commandId: 'empty' })).structuredContent.undone).toBe(false);
  } finally { await t.close(); }
});

it('remote scale-only placement keeps its exact clear pose and waits for drawing before confirmation', async () => {
  const t = await setup(cif, {}, { scale: 1, rotation: [0, 0, 0], translation: [3, 0, -4] }), renderer = placementRenderer(t.scene);
  try {
    const patch = { scale: 2.123456789 };
    await t.call('update_inspection', update(t.binding, t.panelId, 'remote-scale', { kind: 'placement', patch }));
    const { delivery } = await t.poll();
    let release!: () => void, drawing!: () => void, confirmed = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { drawing = resolve; });
    renderer.h.inspectionMutation = async (operation: () => void) => { await operation(); drawing(); await gate; };
    const rendering = renderer.apply(delivery.change, async () => {}, async (scene: any, result: any) => {
      confirmed = true;
      const completed = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene,
        ...(result?.placementAdjusted ? { placementAdjusted: true, placementFit: result.placementFit } : {}) });
      expect(completed.structuredContent.command.status).toBe('rendered');
    });
    await started;
    expect(confirmed).toBe(false);
    expect((await t.current(delivery.commandId)).structuredContent.command.status).toBe('rendering');
    release(); await rendering;
    expect(renderer.snapshot().placement.scale).toBe(patch.scale);
    expect(renderer.snapshot().placement.translation).toEqual([3, 0, -4]);
  } finally { await t.close(); }
});

it('saves, lists, restores and deletes a target-bound session named view',async()=>{
  const t=await setup();
  try {
    const save=await t.call('manage_inspection_view',{...t.binding,action:'save',panelId:t.panelId,commandId:'save-view-1',name:'Active site'});
    expect(save.structuredContent.command).toMatchObject({status:'queued',panelId:t.panelId});
    const captured=structuredClone(t.scene);captured.selectionKeys=[(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY].catalog.rows[1].key];
    const saveDelivery=(await t.poll()).delivery;
    expect(saveDelivery.change).toEqual({kind:'save-view',patch:{name:'Active site'}});
    const saved=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:'save-view-1',claimToken:saveDelivery.claimToken,scene:captured});
    expect(saved.structuredContent.command).toMatchObject({status:'rendered'});
    const entries=saved.structuredContent.namedViews.entries;
    expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({name:'Active site',viewRevision:1,viewIntent:{selectionCount:1,orientation:'not-captured'}});
    expect(entries[0]).not.toHaveProperty('supportedScene');
    expect(JSON.stringify(entries[0])).not.toContain('position');
    const viewId=entries[0].id;

    const restore=await t.call('manage_inspection_view',{...t.binding,action:'restore',panelId:t.panelId,commandId:'restore-view-1',viewId});
    expect(restore.structuredContent.command.status).toBe('queued');
    const restoreDelivery=(await t.poll()).delivery;
    expect(restoreDelivery.change.kind).toBe('restore-view');
    expect(restoreDelivery.change.patch.scene.selectionKeys).toEqual(captured.selectionKeys);
    const rendered=structuredClone(captured);rendered.camera.position=[80,0,0];
    const restored=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:'restore-view-1',claimToken:restoreDelivery.claimToken,scene:rendered});
    expect(restored.structuredContent.command.status).toBe('rendered');

    const next={...t.binding,baseInspectionRevision:restored.structuredContent.inspectionRevision};
    const deleted=await t.call('manage_inspection_view',{...next,action:'delete',viewId,viewRevision:1});
    expect(deleted.structuredContent).toMatchObject({deleted:true,namedViews:{scope:'live-session',maximum:MAX_INSPECTION_VIEWS,entries:[]}});
  } finally {await t.close();}
});

it('reports one named-view listing from the tool, the state and the hydration',async()=>{
  const t=await setup();
  try {
    await t.call('manage_inspection_view',{...t.binding,action:'save',panelId:t.panelId,commandId:'listed-view',name:'Listed'});
    const delivery=(await t.poll()).delivery;
    const saved=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:'listed-view',
      claimToken:delivery.claimToken,scene:t.scene});
    expect(saved.structuredContent.command).toMatchObject({status:'rendered'});
    // Tool list answers from the same unfiltered host library as state/hydration.
    const listed=await t.call('manage_inspection_view',{sessionId:t.sessionId,action:'list'});
    expect(listed.structuredContent.namedViews).toMatchObject({scope:'live-session',maximum:MAX_INSPECTION_VIEWS});
    expect(listed.structuredContent.namedViews.entries).toHaveLength(1);
    const viewId=listed.structuredContent.namedViews.entries[0].id;
    // Inspection state carries the identical library, with source identity.
    const state=await t.current();
    expect(state.structuredContent.namedViews.entries).toEqual(listed.structuredContent.namedViews.entries);
    // Private hydration carries the identical library for panels.
    const hydrated=await t.call('get_inspection',{sessionId:t.sessionId});
    expect(hydrated._meta[PRIVATE_KEY].namedViews.entries).toEqual(listed.structuredContent.namedViews.entries);
    expect(listed.structuredContent.namedViews.entries[0]).toMatchObject({id:viewId,name:'Listed',
      sourceSha256:t.scene.sourceSha256,modelNumber:t.scene.modelNumber,assemblyId:t.scene.assemblyId});
  } finally {await t.close();}
});

it('does not mark a receipt rendered before named-view intent validation',async()=>{
  const makeIntent=(scene:any)=>({version:1,sourceSha256:scene.sourceSha256,modelNumber:scene.modelNumber,assemblyId:scene.assemblyId,
    targetOffsetRadii:[0,0,0],direction:[0,0,-1],up:[0,1,0],distanceInRadii:4,verticalSpanRadii:2});
  const first=await setup();
  try {
    await first.call('manage_inspection_view',{...first.binding,action:'save',panelId:first.panelId,commandId:'invalid-intent',name:'Angle'});
    const delivery=(await first.poll()).delivery;
    const invalid={...makeIntent(first.scene),sourceSha256:'0'.repeat(64)};
    const refused=await first.call('complete_inspection',{...first.binding,panelId:first.panelId,commandId:'invalid-intent',
      claimToken:delivery.claimToken,scene:first.scene,namedViewIntent:invalid});
    expect(refused.isError).toBe(true);
    expect((await first.current('invalid-intent')).structuredContent.command.status).toBe('rendering');
  } finally {await first.close();}

  const second=await setup();
  try {
    await second.call('update_inspection',update(second.binding,second.panelId,'ordinary',
      {kind:'appearance',patch:{opacity:.8}}));
    const delivery=(await second.poll()).delivery;
    const rendered=structuredClone(second.scene);rendered.inspection.appearance.opacity=.8;
    const refused=await second.call('complete_inspection',{...second.binding,panelId:second.panelId,commandId:'ordinary',
      claimToken:delivery.claimToken,scene:rendered,namedViewIntent:makeIntent(second.scene)});
    expect(refused.isError).toBe(true);
    expect((await second.current('ordinary')).structuredContent.command.status).toBe('rendering');
  } finally {await second.close();}
});

it('reports bounded XR startup state per panel with freshness and rejects arbitrary diagnostics',async()=>{
  const t=await setup();
  try {
    const xrStartup={phase:'requesting-headset',pending:true,reloadRequired:false,mode:'immersive-ar',gestureActive:true,pagePointerDowns:2,pagePointerUps:1,pageClicks:1,pointerCancels:0,lastInputTarget:'enter-ar'};
    const sent=await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',xrStartup});
    expect(sent.isError).not.toBe(true);
    let state=(await t.current()).structuredContent;
    expect(state.panels.find((p:any)=>p.panelId===t.panelId).xrStartup).toEqual({...xrStartup,ageMs:0,stale:false});
    t.clock.now+=4000;
    state=(await t.current()).structuredContent;
    expect(state.panels.find((p:any)=>p.panelId===t.panelId).xrStartup).toMatchObject({ageMs:4000,stale:true});
    await t.poll();
    state=(await t.current()).structuredContent;
    expect(state.panels.find((p:any)=>p.panelId===t.panelId).xrStartup).toMatchObject({ageMs:4000,stale:true});
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',xrStartup:{...xrStartup,pending:false}});
    state=(await t.current()).structuredContent;
    expect(state.panels.find((p:any)=>p.panelId===t.panelId).xrStartup).toMatchObject({pending:false,ageMs:0,stale:false});
    const invalid=await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',xrStartup:{...xrStartup,url:'https://example.com/private'}});
    expect(invalid.isError).toBe(true);
  } finally {await t.close();}
});

it.each([
  ['hidden','hidden-session'],['visible-blurred','blurred'],['visible','busy'],
])('publishes the %s availability cause in get_inspection_state without pending commands',async(sessionVisibility,cause)=>{
  const t=await setup();
  try {
    const panelId=(await t.call('attach_inspection',{...t.binding,surface:'companion'})).structuredContent.panelId;
    const xrStartup={phase:'active',pending:false,reloadRequired:false,mode:'immersive-vr',gestureActive:null,
      presenting:true,sessionVisibility};
    const sent=await t.call('poll_inspection',{...t.binding,panelId,availability:'busy',xrStartup});
    expect(sent.isError).not.toBe(true);
    let state=(await t.current()).structuredContent;
    let panel=state.panels.find((p:any)=>p.panelId===panelId);
    expect(panel).toMatchObject({availability:'busy',availabilityCause:cause});
    expect(availabilityCauseSchema.parse(panel.availabilityCause)).toBe(cause);
    expect(state.pendingCommand).toEqual([]);
    expect(state.commands).toEqual([]);
    // Omitted telemetry retains the last report, with its existing age/stale fields.
    t.clock.now+=4000;
    await t.call('poll_inspection',{...t.binding,panelId,availability:'busy'});
    state=(await t.current()).structuredContent;
    expect(state.panels.find((p:any)=>p.panelId===panelId)).toMatchObject({availabilityCause:cause,xrStartup:{stale:true,ageMs:4000}});
    for(const availability of ['ready','unsaved']) {
      await t.call('poll_inspection',{...t.binding,panelId,availability});
      panel=(await t.current()).structuredContent.panels.find((p:any)=>p.panelId===panelId);
      expect(panel).toMatchObject({availability,availabilityCause:null});
      expect(availabilityCauseSchema.parse(panel.availabilityCause)).toBeNull();
    }
    await t.call('poll_inspection',{...t.binding,panelId,availability:'busy',xrStartup:{...xrStartup,sessionVisibility:'visible'}});
    expect((await t.current()).structuredContent.panels.find((p:any)=>p.panelId===panelId))
      .toMatchObject({availability:'busy',availabilityCause:'busy'});
  } finally {await t.close();}
});

it('keeps a headset panel through a minute of silence and still retires a silent desktop panel in ten seconds',async()=>{
  const t=await setup();
  try {
    const companion=(await t.call('attach_inspection',{...t.binding,surface:'companion'})).structuredContent.panelId as string;
    const desktop=(await t.call('attach_inspection',{...t.binding,surface:'desktop'})).structuredContent.panelId as string;
    const ids=async()=>((await t.current()).structuredContent.panels as any[]).map(panel=>panel.panelId);
    // Taking a Quest off freezes its page: the heartbeat stops with no
    // pagehide, and the wearer expects to resume where they left off.
    t.clock.now+=30_000;
    let live=await ids();
    expect(live).toContain(companion);
    expect(live).not.toContain(desktop);
    // The frozen headset panel still owns its capability, so putting the
    // headset back on resumes the same panel rather than reattaching.
    expect((await t.poll('ready',t.binding,companion)).result.structuredContent.attached).toBe(true);
    // An abandoned headset panel is still collected, one minute after its last
    // heartbeat rather than after ten seconds.
    t.clock.now+=61_000;
    expect(await ids()).not.toContain(companion);
  } finally {await t.close();}
});

describe('rich inspection command MCP contracts', () => {
  it('wakes a waiting edit from the committed receipt before the safety read', async () => {
    const t=await setup();
    try {
      const commandId='receipt-wakeup';
      const waiting=t.call('update_inspection',{...update(t.binding,t.panelId,commandId,
        {kind:'appearance',patch:{color:'uniform'}}),waitForRenderMs:2_000});
      let delivery;
      for(let attempt=0;attempt<20 && !delivery;attempt++) {
        delivery=(await t.poll()).delivery;
        if(!delivery) await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(delivery?.commandId).toBe(commandId);
      const scene=structuredClone(t.scene);
      scene.inspection.appearance.color='uniform';
      const complete=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId,
        claimToken:delivery.claimToken,scene});
      expect(complete.structuredContent.command.status).toBe('rendered');
      const answer=await Promise.race([waiting,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('receipt wake missed')),750))]);
      expect(answer.structuredContent.command).toMatchObject({status:'rendered',renderedRevision:t.binding.baseInspectionRevision+1});
    } finally {await t.close();}
  });

  it('records reduced geometry only after a matching rendered scene and keeps appearance exact', async () => {
    const t = await setup();
    const geometryBudget = { representation: 'ball-and-stick', deviceClass: 'quest2', atoms: 4400,
      budget: 260000, requestedLevel: 'lower', level: 'lowest', estimatedVertices: 242880,
      message: 'Showing sticks at reduced detail so the headset stays smooth.' };
    try {
      const request = update(t.binding, t.panelId, 'geometry-reduced', { kind: 'appearance', patch: { representation: 'ball-and-stick' } });
      const queued = await t.call('update_inspection', request);
      expect(queued.structuredContent.command).toMatchObject({status:'queued'});
      expect(queued.structuredContent.command.geometryBudget).toBeUndefined();
      const claimed = await t.poll();
      const premature = await t.call('complete_inspection', { ...t.binding, panelId:t.panelId,
        commandId:'geometry-reduced', claimToken:claimed.delivery.claimToken, failure:'render_failed', geometryBudget });
      expect(premature.isError).toBe(true);
      const scene = structuredClone(t.scene);
      scene.inspection.appearance.representation = 'ball-and-stick';
      const complete = await t.call('complete_inspection', { ...t.binding, panelId:t.panelId,
        commandId:'geometry-reduced', claimToken:claimed.delivery.claimToken, scene, geometryBudget });
      expect(complete.structuredContent.command).toMatchObject({status:'rendered', geometryBudget});
      const state = (await t.current('geometry-reduced')).structuredContent;
      expect(state.command.geometryBudget).toEqual(geometryBudget);
      expect(state.view.appearance).toEqual(scene.inspection.appearance);
      expect((await t.call('update_inspection',request)).structuredContent.command.geometryBudget).toEqual(geometryBudget);
    } finally { await t.close(); }
  });

  it('does not attach reduced geometry to an unconfirmed scene and preserves an actionable refusal', async () => {
    for (const mismatch of [true, false]) {
      const t = await setup();
      try {
        await t.call('update_inspection', update(t.binding,t.panelId,'geometry-refusal', {kind:'appearance',patch:{representation:'ball-and-stick'}}));
        const claimed = await t.poll();
        const refusal = 'This structure has 100000 atoms; showing sticks exceeds the 260000-vertex headset limit at lowest detail. Try cartoon, or sticks on a smaller selection.';
        const completed = await t.call('complete_inspection', { ...t.binding,panelId:t.panelId,
          commandId:'geometry-refusal',claimToken:claimed.delivery.claimToken,
          ...(mismatch ? {scene:t.scene,geometryBudget:{representation:'ball-and-stick',deviceClass:'quest2',atoms:4400,
            budget:260000,requestedLevel:'lower',level:'lowest',estimatedVertices:242880,
            message:'Showing sticks at reduced detail so the headset stays smooth.'}}
            : {failure:'render_failed',failureReason:refusal}) });
        expect(completed.structuredContent.command.status).toBe(mismatch?'unconfirmed':'rejected');
        expect(completed.structuredContent.command.geometryBudget).toBeUndefined();
        if (!mismatch) expect(completed.structuredContent.command.detail).toBe(refusal);
      } finally { await t.close(); }
    }
  });

  it('exposes only safe state publicly, queues a targeted patch, and records one rendered receipt', async () => {
    const t = await setup();
    try {
      const state = await t.current();
      const publicText = JSON.stringify({ content: state.content, structuredContent: state.structuredContent });
      expect(state._meta).toBeUndefined();
      expect(publicText).toContain(t.panelId);
      expect(publicText).not.toContain('selectionKeys');
      expect(publicText).not.toContain('"camera":');
      expect(publicText).not.toContain(t.scene.selectionKeys[0]);
      expect(publicText).not.toContain('_atom_site');

      const request = update(t.binding, t.panelId, 'appearance-one', { kind: 'appearance', patch: { background: '#445566' } });
      expect((await t.call('update_inspection', request)).structuredContent.command).toMatchObject({ commandId: 'appearance-one', status: 'queued' });
      const claimed = await t.poll();
      expect(claimed.result.structuredContent).toMatchObject({ attached: true });
      expect(claimed.result.structuredContent.delivery).toBeUndefined();
      expect(claimed.delivery).toMatchObject({ commandId: 'appearance-one', panelId: t.panelId, change: request.change });

      const rendered = structuredClone(t.scene);
      rendered.inspection.appearance.background = '#445566';
      const complete = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'appearance-one', claimToken: claimed.delivery.claimToken, scene: rendered,
      });
      expect(complete.structuredContent.command).toMatchObject({ commandId: 'appearance-one', status: 'rendered', renderedRevision: 2 });
      expect((await t.current('appearance-one')).structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });
      expect((await t.current()).structuredContent.view.appearance.background).toBe('#445566');

      expect((await t.call('update_inspection', request)).structuredContent.command).toMatchObject({ status: 'rendered' });
      const differentRetry = await t.call('update_inspection', { ...request, change: { kind: 'appearance', patch: { background: '#abcdef' } } });
      expect(differentRetry.isError).toBe(true);
    } finally { await t.close(); }
  });

  it.each([
    { name: 'explicitly positioned scale-up', patch: { scale: 2, translation: [1.5, 0, 0] }, translation: [1.5, 0, 0] },
    { name: 'rotation-only', patch: { rotation: [0, 45, 0] }, translation: [0, 0, 0] },
    { name: 'scale-up without clearance', patch: { scale: 2 }, translation: [0, 0, 0] },
  ])('confirms a $name placement receipt and saves the actual translation', async ({ patch, translation }) => {
    const t = await setup();
    try {
      await t.call('update_inspection', update(t.binding, t.panelId, 'placement-clearance', { kind: 'placement', patch }));
      const { delivery } = await t.poll();
      const rendered = structuredClone(t.scene);
      Object.assign(rendered.inspection.placement, patch, { translation });
      const complete = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered,
      });
      expect(complete.structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });
      expect(complete.structuredContent.command.detail).toBeUndefined();
      const state = (await t.current(delivery.commandId)).structuredContent;
      expect(state.command).toEqual(complete.structuredContent.command);
      expect(state.view.placement).toEqual(rendered.inspection.placement);
      const fresh = { ...t.binding, baseInspectionRevision: state.inspectionRevision };
      expect((await t.poll('ready', fresh)).result.structuredContent.outcome.detail).toBe(complete.structuredContent.command.detail);
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(rendered);
    } finally { await t.close(); }
  });

  it.each(['placement', 'compound'] as const)('confirms a stereo clearance adjustment in a %s receipt', async kind => {
    const t = await setup();
    try {
      const placement = { kind: 'placement' as const, patch: { scale: 2, translation: [-1, 0, 0] } };
      const change = kind === 'placement' ? placement : { kind: 'compound' as const, patch: { ops: [
        placement, { kind: 'appearance' as const, patch: { opacity: .5 } },
      ] } };
      await t.call('update_inspection', update(t.binding, t.panelId, `clear-${kind}`, change));
      const { delivery } = await t.poll();
      const rendered = structuredClone(t.scene);
      rendered.inspection.placement = { ...rendered.inspection.placement, scale: 1.5, translation: [1, 0, 0] };
      if (kind === 'compound') rendered.inspection.appearance.opacity = .5;
      const completed = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered, placementAdjusted: true, placementFit: { metersPerRadius: 1, centerMeters: [0, 0, -4],
          headFromScene: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] } });
      expect(completed.structuredContent.command.status).toBe('rendered');
      expect(completed.structuredContent.command.detail).toMatch(/clear the headset menu and reply plate/);
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene.inspection.placement)
        .toEqual(rendered.inspection.placement);
    } finally { await t.close(); }
  });

  it.each([
    { name: 'larger scale', placement: { scale: 2.1, translation: [1, 0, 0] } },
    { name: 'changed rotation', placement: { scale: 1.5, translation: [1, 0, 0], rotation: [0, 45, 0] } },
  ])('does not use a clearance receipt to confirm a $name', async ({ placement }) => {
    const t = await setup();
    try {
      await t.call('update_inspection', update(t.binding, t.panelId, 'bad-clearance',
        { kind: 'placement', patch: { scale: 2, translation: [-1, 0, 0] } }));
      const { delivery } = await t.poll();
      const rendered = structuredClone(t.scene);
      Object.assign(rendered.inspection.placement, placement);
      const completed = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered, placementAdjusted: true, placementFit: { metersPerRadius: 1, centerMeters: [0, 0, -4],
          headFromScene: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] } });
      expect(completed.structuredContent.command.status).toBe('unconfirmed');
    } finally { await t.close(); }
  });

  it.each([
    { name: 'scale-up with a wrong scale', change: { kind: 'placement', patch: { scale: 2 } }, placement: { scale: 1.75 } },
    { name: 'scale-up with an unrequested rotation', change: { kind: 'placement', patch: { scale: 2 } }, placement: { scale: 2, rotation: [0, 45, 0] } },
    { name: 'scale-up with a wrong requested rotation', change: { kind: 'placement', patch: { scale: 2, rotation: [0, 90, 0] } }, placement: { scale: 2, rotation: [0, 45, 0] } },
    { name: 'translation-only with a wrong translation', change: { kind: 'placement', patch: { translation: [1, 0, 0] } }, placement: {} },
    { name: 'scale-up with a wrong explicit translation', change: { kind: 'placement', patch: { scale: 2, translation: [1, 0, 0] } }, placement: { scale: 2 } },
    { name: 'appearance with an adjusted translation', change: { kind: 'appearance', patch: { opacity: 1 } }, placement: {} },
    { name: 'compound with an adjusted translation', change: { kind: 'compound', patch: { ops: [{ kind: 'placement', patch: { scale: 2 } }, { kind: 'appearance', patch: { opacity: 1 } }] } }, placement: { scale: 2 } },
  ])('leaves $name unconfirmed', async ({ change, placement }) => {
    const t = await setup();
    try {
      await t.call('update_inspection', update(t.binding, t.panelId, 'wrong-placement', change));
      const { delivery } = await t.poll();
      const rendered = structuredClone(t.scene);
      Object.assign(rendered.inspection.placement, placement, { translation: [1.5, 0, 0] });
      const complete = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered,
      });
      expect(complete.structuredContent.command).toMatchObject({ status: 'unconfirmed' });
      expect(complete.structuredContent.command.detail).toBe(change.kind === 'placement' || change.kind === 'compound'
        ? 'The placement was not rendered as requested.' : undefined);
      const state = (await t.current()).structuredContent;
      expect(state.inspectionRevision).toBe(t.binding.baseInspectionRevision);
      expect(state.view.placement).toEqual(t.scene.inspection.placement);
    } finally { await t.close(); }
  });

  it('undoes an adjusted scale-up by restoring both the previous scale and translation', async () => {
    const t = await setup();
    try {
      await t.call('update_inspection', update(t.binding, t.panelId, 'scale-before-undo', { kind: 'placement', patch: { scale: 2, translation: [1.5, 0, 0] } }));
      const { delivery } = await t.poll();
      const rendered = structuredClone(t.scene);
      rendered.inspection.placement.scale = 2;
      rendered.inspection.placement.translation = [1.5, 0, 0];
      const complete = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered,
      });
      expect(complete.structuredContent.command.status).toBe('rendered');
      const fresh = { ...t.binding, baseInspectionRevision: complete.structuredContent.inspectionRevision };
      const undo = await t.call('undo_last_change', { ...fresh, panelId: t.panelId, commandId: 'undo-clearance' });
      expect(undo.structuredContent).toMatchObject({ undone: true, restores: ['placement'], command: { status: 'queued' } });
      const undone = (await t.poll('ready', fresh)).delivery;
      expect(undone.change).toEqual({ kind: 'placement', patch: t.scene.inspection.placement });
      const restored = structuredClone(rendered);
      restored.inspection.placement = structuredClone(undone.change.patch);
      const receipt = await t.call('complete_inspection', {
        ...fresh, panelId: t.panelId, commandId: undone.commandId, claimToken: undone.claimToken, scene: restored,
      });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 3 });
      expect(receipt.structuredContent.command.detail).toBeUndefined();
      expect((await t.current()).structuredContent.view.placement).toEqual(t.scene.inspection.placement);
      expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(t.scene);
      const empty = await t.call('undo_last_change', {
        ...fresh, baseInspectionRevision: receipt.structuredContent.inspectionRevision, panelId: t.panelId, commandId: 'undo-empty',
      });
      expect(empty.structuredContent.undone).toBe(false);
    } finally { await t.close(); }
  });

  // The render budget travels the same queue an appearance
  // patch does, and the receipt its target panel reads names it by its kind. The
  // scene that comes back is unchanged, because a level is not a scene value.
  it('queues a render-quality level and reports a receipt that changed nothing saved', async () => {
    const t = await setup();
    try {
      const request = update(t.binding, t.panelId, 'quality-best', { kind: 'render-quality', patch: { level: 'best' } });
      expect((await t.call('update_inspection', request)).structuredContent.command).toMatchObject({ commandId: 'quality-best', status: 'queued' });
      const claimed = await t.poll();
      expect(claimed.delivery).toMatchObject({ commandId: 'quality-best', panelId: t.panelId, change: request.change });
      const complete = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'quality-best', claimToken: claimed.delivery.claimToken, scene: t.scene,
      });
      expect(complete.structuredContent.command).toMatchObject({ commandId: 'quality-best', status: 'rendered' });
      // The receipt the target panel reads back names the kind, not the field's
      // spelling, so an agent reporting it says "render-quality".
      const state = (await t.current()).structuredContent;
      const fresh = { sessionId: t.sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
        baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision };
      const desktop = (await t.call('attach_inspection', { ...fresh, surface: 'desktop' })).structuredContent.panelId as string;
      expect((await t.poll('ready', fresh, desktop)).result.structuredContent.outcome).toBeNull();
      const readout = (await t.poll('ready', fresh)).result;
      expect(readout.structuredContent.outcome).toMatchObject({ status: 'rendered', change: 'render-quality', fields: ['level'] });
      // Appearance, placement and selection are exactly where the wearer left
      // them: the agent bought frames, not a different scene.
      expect(state.view.appearance).toEqual(t.scene.inspection.appearance);
      expect(state.view.placement).toEqual(t.scene.inspection.placement);
      // Nothing was left pending, so nothing claims to be.
      expect(readout.structuredContent.outcome.scaleAppliesOnNextEntry).toBeUndefined();
    } finally { await t.close(); }
  });

  /**
   * The one thing a rendered scene cannot carry.
   *
   * An XRWebGLLayer's framebuffer scale is fixed when the layer is built, so a
   * `best` level asked for inside a running immersive session raises the
   * representation detail at once and the resolution only on the wearer's next
   * entry. The panel is the only party that knows, and an agent that cannot see
   * it reports a sharper picture the wearer is looking straight at and cannot
   * see. It rides the receipt, so `get_inspection_state` carries it.
   */
  it('carries a still-pending framebuffer scale from the panel to the agent', async () => {
    const t = await setup();
    try {
      const request = update(t.binding, t.panelId, 'quality-pending', { kind: 'render-quality', patch: { level: 'best' } });
      await t.call('update_inspection', request);
      const claimed = await t.poll();
      const complete = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'quality-pending', claimToken: claimed.delivery.claimToken,
        scene: t.scene, scaleAppliesOnNextEntry: true,
      });
      expect(complete.structuredContent.command).toMatchObject({ status: 'rendered', scaleAppliesOnNextEntry: true });
      const state = (await t.current()).structuredContent;
      const fresh = { sessionId: t.sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
        baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision };
      const desktop = (await t.call('attach_inspection', { ...fresh, surface: 'desktop' })).structuredContent.panelId as string;
      expect((await t.poll('ready', fresh, desktop)).result.structuredContent.outcome).toBeNull();
      const readout = (await t.poll('ready', fresh)).result;
      expect(readout.structuredContent.outcome).toMatchObject({ status: 'rendered', change: 'render-quality', scaleAppliesOnNextEntry: true });
    } finally { await t.close(); }
  });

  // A pending framebuffer scale belongs to a render that happened. It cannot
  // ride a failure, and it cannot be claimed for a change of another kind.
  it('refuses a pending framebuffer scale on a failure or on another kind of change', async () => {
    const t = await setup();
    try {
      const failing = update(t.binding, t.panelId, 'quality-failed', { kind: 'render-quality', patch: { level: 'best' } });
      await t.call('update_inspection', failing);
      const claimedFailure = await t.poll();
      const refused = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'quality-failed', claimToken: claimedFailure.delivery.claimToken,
        failure: 'render_failed', scaleAppliesOnNextEntry: true,
      });
      expect(refused.isError).toBe(true);
      // Release the command so the next one can be admitted at this revision.
      await t.call('complete_inspection', { ...t.binding, panelId: t.panelId, commandId: 'quality-failed',
        claimToken: claimedFailure.delivery.claimToken, failure: 'render_failed' });
      const spin = update(t.binding, t.panelId, 'spin-pending', { kind: 'motion', patch: { state: 'spin' } });
      await t.call('update_inspection', spin);
      const claimedSpin = await t.poll();
      const spun = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'spin-pending', claimToken: claimedSpin.delivery.claimToken,
        scene: t.scene, scaleAppliesOnNextEntry: true,
      });
      expect(spun.structuredContent.command.status).toBe('rendered');
      expect(spun.structuredContent.command.scaleAppliesOnNextEntry).toBeUndefined();
    } finally { await t.close(); }
  });

  it('retains one claimed panel during a long render, then resumes its heartbeat on the rendered revision', async () => {
    const t = await setup();
    try {
      await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',xrStartup:{
        phase:'active',pending:false,reloadRequired:false,mode:'immersive-ar',gestureActive:true,
      }});
      const request = update(t.binding, t.panelId, 'long-surface-render', {
        kind: 'appearance', patch: { representation: 'molecular-surface', opacity: 0.4, labels: true },
      });
      await t.call('update_inspection', request);
      const claimed = await t.poll();
      expect(claimed.delivery).toMatchObject({ commandId: 'long-surface-render', panelId: t.panelId });

      // This exceeds the ordinary ten-second panel heartbeat grace but stays
      // well inside the claimed render's bounded 120-second deadline.
      t.clock.now = 30_000;
      const drawing = (await t.current('long-surface-render')).structuredContent;
      expect(drawing.command).toMatchObject({ status: 'rendering' });
      expect(drawing.panels.map((panel: any) => panel.panelId)).toContain(t.panelId);

      const rendered = structuredClone(t.scene);
      Object.assign(rendered.inspection.appearance, { representation: 'molecular-surface', opacity: 0.4, labels: true });
      const completed = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'long-surface-render', claimToken: claimed.delivery.claimToken, scene: rendered,
      });
      expect(completed.structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });

      // Completion refreshes liveness once. The panel can poll with the new
      // revision just before that normal grace expires and keeps its identity.
      t.clock.now = 39_999;
      const afterRender: Binding = { ...t.binding, baseInspectionRevision: 2 };
      const resumed = await t.poll('ready', afterRender, t.panelId);
      expect(resumed.result.structuredContent).toMatchObject({ attached: true });
      const current = (await t.current()).structuredContent.panels.find((panel: any) => panel.panelId === t.panelId);
      expect(current).toMatchObject({ current: true, availability: 'ready', inspectionRevision: 2 });
      expect(current.xrStartup).toMatchObject({phase:'active',ageMs:39_999,stale:true});

      // A rendered receipt is terminal: without another heartbeat the panel
      // still expires normally and cannot become an immortal capability.
      t.clock.now = 50_000;
      expect((await t.current()).structuredContent.panels.map((panel: any) => panel.panelId)).not.toContain(t.panelId);
    } finally { await t.close(); }
  });

  it('admits the next request to the panel that just rendered before its heartbeat catches up', async () => {
    const t = await setup();
    try {
      const other = (await t.call('attach_inspection', t.binding)).structuredContent.panelId as string;
      await t.call('update_inspection', update(t.binding, t.panelId, 'first', { kind: 'appearance', patch: { opacity: 0.5 } }));
      const claimed = await t.poll();
      const rendered = structuredClone(t.scene);
      rendered.inspection.appearance.opacity = 0.5;
      const completed = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'first', claimToken: claimed.delivery.claimToken, scene: rendered,
      });
      expect(completed.structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });

      // No heartbeat has arrived since the render. The panel that reported it
      // is already current; the one that did not is still on the old revision.
      const panels = (await t.current()).structuredContent.panels;
      expect(panels.find((panel: any) => panel.panelId === t.panelId)).toMatchObject({ current: true, inspectionRevision: 2 });
      expect(panels.find((panel: any) => panel.panelId === other)).toMatchObject({ current: false, inspectionRevision: 1 });

      const afterRender: Binding = { ...t.binding, baseInspectionRevision: 2 };
      const next = await t.call('update_inspection', update(afterRender, t.panelId, 'second', { kind: 'appearance', patch: { opacity: 0.7 } }));
      expect(next.isError).not.toBe(true);
      expect(next.structuredContent.command).toMatchObject({ status: 'queued', panelId: t.panelId });
      const stale = await t.call('update_inspection', update(afterRender, other, 'stale-target', { kind: 'appearance', patch: { opacity: 0.7 } }));
      expect(stale.isError).toBe(true);
      expect((await t.poll('ready', afterRender, t.panelId)).delivery).toMatchObject({ commandId: 'second' });
    } finally { await t.close(); }
  });

  it('does not refresh an old panel when its claimed render is rejected', async () => {
    const t = await setup();
    try {
      await t.call('update_inspection', update(t.binding, t.panelId, 'rejected-long-render', {
        kind: 'appearance', patch: { representation: 'molecular-surface' },
      }));
      const claimed = await t.poll();
      t.clock.now = 10_001;
      const rejected = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'rejected-long-render', claimToken: claimed.delivery.claimToken,
        failure: 'render_failed', failureReason: 'Start a tour with remaining scenes before playing.',
      });
      expect(rejected.structuredContent.command).toMatchObject({ status: 'rejected' });
      // `render_failed` alone says nothing: the panel had refused a play on a
      // stopped tour. The refusal travels with the receipt.
      expect(rejected.structuredContent.command.detail).toBe('Start a tour with remaining scenes before playing.');
      const state = (await t.current('rejected-long-render')).structuredContent;
      expect(state.command).toMatchObject({ status: 'rejected' });
      expect(state.panels.map((panel: any) => panel.panelId)).not.toContain(t.panelId);
    } finally { await t.close(); }
  });

  it('refuses forged or obsolete panel claims and does not deliver an old command to a new panel', async () => {
    const t = await setup();
    try {
      const request = update(t.binding, t.panelId, 'old-panel', { kind: 'placement', patch: { scale: 1.25 } });
      await t.call('update_inspection', request);
      expect((await t.poll('ready', t.binding, randomUUID())).result.structuredContent).toMatchObject({ attached: false });

      t.clock.now = 10_001;
      await t.current(); // prune the old panel without consuming its targeted command
      const attached = await t.call('attach_inspection', t.binding);
      const replacement = attached.structuredContent.panelId as string;
      expect((await t.poll('ready', t.binding, replacement)).delivery).toBeUndefined();

      const forged = await t.call('complete_inspection', {
        ...t.binding, panelId: replacement, commandId: 'old-panel', claimToken: randomUUID(), scene: t.scene,
      });
      expect(forged.isError).toBe(true);
    } finally { await t.close(); }
  });

  it('lets a manual save win before claim or during rendering without overwriting it', async () => {
    const t = await setup();
    try {
      const first = update(t.binding, t.panelId, 'manual-before', { kind: 'appearance', patch: { opacity: 0.4 } });
      await t.call('update_inspection', first);
      const manual = structuredClone(t.scene);
      manual.inspection.appearance.background = '#192734';
      const saved = await t.call('sync_inspection', { ...t.binding, scene: manual });
      const afterManual: Binding = { ...t.binding, baseStateRevision: saved.structuredContent.stateRevision, baseInspectionRevision: saved.structuredContent.inspectionRevision };
      expect((await t.poll('ready', t.binding)).delivery).toBeUndefined();
      expect((await t.current('manual-before')).structuredContent.command).toMatchObject({ status: 'conflict' });
      expect((await t.current()).structuredContent.view.appearance.background).toBe('#192734');

      const newPanel = (await t.call('attach_inspection', afterManual)).structuredContent.panelId as string;
      const second = update(afterManual, newPanel, 'manual-during', { kind: 'appearance', patch: { opacity: 0.5 } });
      await t.call('update_inspection', second);
      const claimed = await t.poll('ready', afterManual, newPanel);
      expect(claimed.delivery).toBeDefined();
      const newer = structuredClone(manual);
      newer.inspection.appearance.highlightColor = '#abcdef';
      const savedAgain = await t.call('sync_inspection', { ...afterManual, scene: newer });
      expect(savedAgain.structuredContent.saved).toBe(true);
      const completed = await t.call('complete_inspection', {
        ...afterManual, panelId: newPanel, commandId: 'manual-during', claimToken: claimed.delivery.claimToken,
        scene: { ...newer, inspection: { ...newer.inspection, appearance: { ...newer.inspection.appearance, opacity: 0.5 } } },
      });
      expect(completed.structuredContent.command).toMatchObject({ status: 'unconfirmed' });
      expect((await t.current()).structuredContent.view.appearance).toMatchObject({ background: '#192734', highlightColor: '#abcdef', opacity: 1 });
    } finally { await t.close(); }
  });

  it('holds a busy panel, rejects an unsaved one at admission, and caps live panel registrations', async () => {
    const t = await setup();
    try {
      // A busy panel is a transient "not now", so its command waits for the
      // next ready heartbeat instead of being refused. Only unsaved work,
      // which the server does not hold, is turned away at admission.
      expect((await t.poll('busy')).result.structuredContent).toMatchObject({ attached: true });
      const busy = await t.call('update_inspection', update(t.binding, t.panelId, 'busy-panel', { kind: 'appearance', patch: { labels: true } }));
      expect(busy.isError).not.toBe(true);
      expect(busy.structuredContent.command).toMatchObject({ status: 'queued', heldForPanel: true });
      expect((await t.poll('busy')).delivery).toBeUndefined();
      expect((await t.poll('unsaved')).result.structuredContent).toMatchObject({ attached: true });
      const unsaved = await t.call('update_inspection', update(t.binding, t.panelId, 'unsaved-panel', { kind: 'appearance', patch: { labels: true } }));
      expect(unsaved.isError).toBe(true);

      await t.poll('ready');
      expect((await t.call('update_inspection', update(t.binding, t.panelId, 'ready-panel', { kind: 'appearance', patch: { labels: true } }))).structuredContent.command)
        .toMatchObject({ status: 'queued' });

      // This fixture already owns one panel. Seven further attachments reach
      // the session limit; the ninth active panel is rejected.
      for (let index = 0; index < 7; index += 1) {
        expect((await t.call('attach_inspection', t.binding)).isError).not.toBe(true);
      }
      expect((await t.call('attach_inspection', t.binding)).isError).toBe(true);
    } finally { await t.close(); }
  });

  it('retires only its exact panel capability and terminally closes queued or claimed work', async () => {
    const t = await setup();
    try {
      const queued = update(t.binding, t.panelId, 'detach-queued', { kind: 'appearance', patch: { labels: true } });
      await t.call('update_inspection', queued);
      const forged = await t.call('detach_inspection', { ...t.binding, panelId: t.panelId, sourceToken: randomUUID() });
      expect(forged.structuredContent).toMatchObject({ detached: false });
      expect((await t.poll()).delivery).toMatchObject({ commandId: 'detach-queued' });

      // Detaching after a claim makes that receipt unconfirmed, so an old
      // panel cannot complete it or transfer it to a replacement panel.
      expect((await t.call('detach_inspection', { ...t.binding, panelId: t.panelId })).structuredContent).toMatchObject({ detached: true });
      expect((await t.current('detach-queued')).structuredContent.command).toMatchObject({ status: 'unconfirmed' });
      expect((await t.poll()).result.structuredContent).toMatchObject({ attached: false });

      const replacement = (await t.call('attach_inspection', t.binding)).structuredContent.panelId as string;
      expect((await t.poll('ready', t.binding, replacement)).delivery).toBeUndefined();
      const next = update(t.binding, replacement, 'detach-before-claim', { kind: 'placement', patch: { scale: 1.1 } });
      await t.call('update_inspection', next);
      expect((await t.call('detach_inspection', { ...t.binding, panelId: replacement })).structuredContent).toMatchObject({ detached: true });
      expect((await t.current('detach-before-claim')).structuredContent.command).toMatchObject({ status: 'conflict' });
    } finally { await t.close(); }
  });

  it('makes a lost completion receipt retryable after later manual work without rewriting history', async () => {
    const t = await setup();
    try {
      const request = update(t.binding, t.panelId, 'lost-receipt', { kind: 'appearance', patch: { background: '#445566' } });
      await t.call('update_inspection', request);
      const claimed = await t.poll();
      const rendered = structuredClone(t.scene);
      rendered.inspection.appearance.background = '#445566';
      const completion = { ...t.binding, panelId: t.panelId, commandId: 'lost-receipt', claimToken: claimed.delivery.claimToken, scene: rendered };
      expect((await t.call('complete_inspection', completion)).structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });
      expect((await t.call('complete_inspection', completion)).structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });

      const afterRender: Binding = { ...t.binding, baseInspectionRevision: 2 };
      const manual = structuredClone(rendered);
      manual.inspection.appearance.highlightColor = '#abcdef';
      expect((await t.call('sync_inspection', { ...afterRender, scene: manual })).structuredContent).toMatchObject({ saved: true, inspectionRevision: 3 });
      const retryAfterManual = await t.call('complete_inspection', completion);
      expect(retryAfterManual.structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });
      expect((await t.current()).structuredContent.view.appearance).toMatchObject({ background: '#445566', highlightColor: '#abcdef' });
    } finally { await t.close(); }
  });

  it('does not evict same-revision failed receipts, then frees them after a deliberate newer save', async () => {
    const t = await setup();
    try {
      // Each unsaved heartbeat terminally conflicts one queued command without
      // changing the saved revision. Those receipts must remain: deleting them
      // would let an old command ID be silently reused at this same view.
      for (let index = 0; index < 32; index += 1) {
        const commandId = `same-revision-${index}`;
        expect((await t.call('update_inspection', update(t.binding, t.panelId, commandId, {
          kind: 'appearance', patch: { labels: Boolean(index % 2) },
        }))).structuredContent.command).toMatchObject({ status: 'queued' });
        expect((await t.poll('unsaved')).delivery).toBeUndefined();
        expect((await t.current(commandId)).structuredContent.command).toMatchObject({ status: 'conflict' });
        await t.poll('ready');
      }
      const blocked = await t.call('update_inspection', update(t.binding, t.panelId, 'same-revision-overflow', {
        kind: 'appearance', patch: { labels: true },
      }));
      expect(blocked.isError).toBe(true);

      const manual = structuredClone(t.scene);
      manual.inspection.appearance.background = '#192734';
      const saved = await t.call('sync_inspection', { ...t.binding, scene: manual });
      const newer: Binding = { ...t.binding, baseStateRevision: saved.structuredContent.stateRevision, baseInspectionRevision: saved.structuredContent.inspectionRevision };
      const panel = (await t.call('attach_inspection', newer)).structuredContent.panelId as string;
      expect((await t.call('update_inspection', update(newer, panel, 'newer-revision', {
        kind: 'appearance', patch: { labels: true },
      }))).structuredContent.command).toMatchObject({ status: 'queued' });
    } finally { await t.close(); }
  });

  it('rejects a rendered snapshot that changes anything beyond the typed patch and expires without replay', async () => {
    const t = await setup();
    try {
      const request = update(t.binding, t.panelId, 'wrong-scene', { kind: 'placement', patch: { scale: 1.2 } });
      await t.call('update_inspection', request);
      const claimed = await t.poll();
      const wrong = structuredClone(t.scene);
      wrong.inspection.placement.scale = 1.2;
      wrong.inspection.appearance.background = '#abcdef';
      const receipt = await t.call('complete_inspection', {
        ...t.binding, panelId: t.panelId, commandId: 'wrong-scene', claimToken: claimed.delivery.claimToken, scene: wrong,
      });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'unconfirmed' });
      expect((await t.current()).structuredContent.view.appearance.background).toBe('#071015');

      const queued = update(t.binding, t.panelId, 'queue-expiry', { kind: 'appearance', patch: { labels: true } });
      await t.call('update_inspection', queued);
      t.clock.now = 15_001;
      expect((await t.current('queue-expiry')).structuredContent.command).toMatchObject({ status: 'expired' });
      expect((await t.poll()).delivery).toBeUndefined();

      const attached = await t.call('attach_inspection', t.binding);
      const replacement = attached.structuredContent.panelId as string;
      const rendering = update(t.binding, replacement, 'render-expiry', { kind: 'appearance', patch: { labels: true } });
      await t.call('update_inspection', rendering);
      expect((await t.poll('ready', t.binding, replacement)).delivery).toBeDefined();
      t.clock.now += (await t.current('render-expiry')).structuredContent.command.renderBudgetMs + 1;
      const expired = (await t.current('render-expiry')).structuredContent;
      expect(expired.command).toMatchObject({ status: 'unconfirmed' });
      expect(expired.panels.map((panel: any) => panel.panelId)).not.toContain(replacement);
      expect((await t.poll('ready', t.binding, replacement)).delivery).toBeUndefined();
    } finally { await t.close(); }
  });

  it('does not carry commands across a source replacement or server epoch', async () => {
    const t = await setup();
    try {
      const request = update(t.binding, t.panelId, 'source-replaced', { kind: 'appearance', patch: { labels: true } });
      await t.call('update_inspection', request);
      await t.call('open', { sessionId: t.sessionId, structureText: cif });
      const replaced = await t.current('source-replaced');
      expect(replaced.structuredContent).toMatchObject({ hasScene: false });
      expect(replaced.structuredContent.command).toMatchObject({ commandId: 'source-replaced', status: 'unknown' });
      const staleEpoch = await t.call('update_inspection', { ...request, commandId: 'wrong-epoch', serverEpoch: randomUUID() });
      expect(staleEpoch.isError).toBe(true);
    } finally { await t.close(); }
  });
});

describe('a panel blurred by a system dialog', () => {
  // On a Quest 2, a vrshell dialog blurred the wearer's session for two to
  // five seconds every twelve, and every agent command that landed inside one
  // of those windows was refused outright.
  it('queues a command through the blur and delivers it when the wearer is back', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.poll('busy', t.binding, companion);
      const request = update(t.binding, companion, 'blurred-play', { kind: 'appearance', patch: { representation: 'spacefill' } });
      const queued = await t.call('update_inspection', request);
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.command).toMatchObject({ status: 'queued', heldForPanel: true });

      // Nothing is handed to a blurred panel: it cannot draw what it is told.
      const held = await t.poll('busy', t.binding, companion);
      expect(held.delivery).toBeUndefined();

      const back = await t.poll('ready', t.binding, companion);
      expect(back.delivery).toMatchObject({ commandId: 'blurred-play', panelId: companion });
      const state = (await t.current('blurred-play')).structuredContent;
      expect(state.command).toMatchObject({ status: 'rendering', heldForPanel: true });
    } finally { await t.close(); }
  });

  it('still refuses a command aimed at a panel with unsaved work', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.poll('unsaved', t.binding, companion);
      const refused = await t.call('update_inspection',
        update(t.binding, companion, 'unsaved-play', { kind: 'appearance', patch: { representation: 'spacefill' } }));
      expect(refused.isError).toBe(true);
    } finally { await t.close(); }
  });

  it('does not mark an ordinary command as held', async () => {
    const t = await setup();
    try {
      const queued = await t.call('update_inspection',
        update(t.binding, t.panelId, 'plain-play', { kind: 'appearance', patch: { representation: 'spacefill' } }));
      expect(queued.structuredContent.command.heldForPanel).toBeUndefined();
    } finally { await t.close(); }
  });
});

describe('a wearer who left for the full Mol* viewer', () => {
  it('is reported as in the detail view until a companion comes back', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      expect((await t.current()).structuredContent.companionInDetailedView).toBe(false);

      const left = await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'detailed-view' });
      expect(left.structuredContent.detached).toBe(true);
      expect((await t.current()).structuredContent.companionInDetailedView).toBe(true);

      await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      expect((await t.current()).structuredContent.companionInDetailedView).toBe(false);
    } finally { await t.close(); }
  });

  it('stops claiming the wearer is in Mol* once the trip is older than the horizon', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'detailed-view' });
      t.clock.now += 10 * 60_000;
      expect((await t.current()).structuredContent.companionInDetailedView).toBe(false);
    } finally { await t.close(); }
  });

  it('is not claimed for an ordinary detach or for a desktop panel', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion });
      expect((await t.current()).structuredContent.companionInDetailedView).toBe(false);

      const desktop = (await t.call('attach_inspection', { ...t.binding, surface: 'desktop' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: desktop, reason: 'detailed-view' });
      expect((await t.current()).structuredContent.companionInDetailedView).toBe(false);
    } finally { await t.close(); }
  });
});

/**
 * The agent's rescue out of the full Mol* viewer.
 *
 * A wearer in Mol* has no companion panel, so say_to_headset has no page to
 * reach and every queued command has no panel to render on. Before this the
 * only answer was advice the wearer could not hear: "press Back to headset
 * view". recall_headset leaves one sentence in a mailbox the Mol* page polls.
 */
describe('calling the wearer back out of the full Mol* viewer', () => {
  it('is taken exactly once by the page that polls for it', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'detailed-view' });

      const queued = await t.call('recall_headset', { sessionId: t.sessionId, text: 'Come back, the lesson is waiting.' });
      expect(queued.structuredContent.detailedRecall).toMatchObject({ queued: true, away: true, text: 'Come back, the lesson is waiting.' });
      expect((await t.current()).structuredContent.detailedViewRecallPending).toBe(true);

      const taken = await t.call('poll_detailed_view', { sessionId: t.sessionId });
      expect(taken.structuredContent.detailedRecall).toEqual({ recall: true, text: 'Come back, the lesson is waiting.' });
      // The page navigates on it. A second delivery would yank a wearer who
      // opened the viewer again minutes later straight back out of it.
      expect((await t.call('poll_detailed_view', { sessionId: t.sessionId })).structuredContent.detailedRecall).toEqual({ recall: false });
      expect((await t.current()).structuredContent.detailedViewRecallPending).toBe(false);
    } finally { await t.close(); }
  });

  it('carries a default sentence and is dropped when the wearer is already back', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'detailed-view' });
      const queued = await t.call('recall_headset', { sessionId: t.sessionId });
      expect(queued.structuredContent.detailedRecall.text).toBe('Coming back to the headset.');

      // Whatever brought the wearer home answered the recall, so it must not
      // wait for their next visit to the viewer.
      await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      expect((await t.call('poll_detailed_view', { sessionId: t.sessionId })).structuredContent.detailedRecall).toEqual({ recall: false });
    } finally { await t.close(); }
  });

  /**
   * A recall that answered `{queued:true}` and then
   * nothing. Polling for a companion panel cannot tell a page that never read
   * the sentence from a wearer who took the headset off, so the receipt records
   * each step on its own evidence.
   */
  it('records what became of the recall: read by the Mol* page, then returned to the companion', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'detailed-view' });

      const queued = await t.call('recall_headset', { sessionId: t.sessionId, text: 'Come back.' });
      const recallId = queued.structuredContent.detailedRecall.recallId as string;
      expect(recallId).toMatch(/^recall-\d+$/);
      expect((await t.current()).structuredContent.detailedRecallReceipt)
        .toMatchObject({ recallId, status: 'queued', text: 'Come back.' });

      // The page takes the sentence and navigates. That is evidence it read it,
      // and nothing more: the wearer is still on their way.
      await t.call('poll_detailed_view', { sessionId: t.sessionId });
      expect((await t.current()).structuredContent.detailedRecallReceipt).toMatchObject({ recallId, status: 'read' });

      await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      expect((await t.current()).structuredContent.detailedRecallReceipt).toMatchObject({ recallId, status: 'returned' });
    } finally { await t.close(); }
  });

  it('never calls a wearer who came back some other way a recall that was answered', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'detailed-view' });
      await t.call('recall_headset', { sessionId: t.sessionId, text: 'Come back.' });
      // No poll_detailed_view: nothing read the sentence. The wearer pressed
      // Back to headset view themselves, or the tab was reopened from the Mac.
      await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      expect((await t.current()).structuredContent.detailedRecallReceipt).toMatchObject({ status: 'queued' });
    } finally { await t.close(); }
  });

  it('turns a recall nobody ever read into an expired receipt rather than a waiting one', async () => {
    const t = await setup();
    try {
      await t.call('recall_headset', { sessionId: t.sessionId, text: 'Back to the lesson.' });
      expect((await t.current()).structuredContent.detailedRecallReceipt.status).toBe('queued');
      t.clock.now += 10 * 60_000;
      const state = (await t.current()).structuredContent;
      expect(state.detailedRecallReceipt.status).toBe('expired');
      expect(state.detailedViewRecallPending).toBe(false);
    } finally { await t.close(); }
  });

  it('starts a new receipt for a second recall rather than reusing the first', async () => {
    const t = await setup();
    try {
      const first = (await t.call('recall_headset', { sessionId: t.sessionId, text: 'One.' })).structuredContent.detailedRecall.recallId;
      const second = (await t.call('recall_headset', { sessionId: t.sessionId, text: 'Two.' })).structuredContent.detailedRecall.recallId;
      expect(second).not.toBe(first);
      expect((await t.current()).structuredContent.detailedRecallReceipt).toMatchObject({ recallId: second, status: 'queued', text: 'Two.' });
    } finally { await t.close(); }
  });

  it('is queued for a wearer nobody has reported in the viewer, and expires with the trip', async () => {
    const t = await setup();
    try {
      const queued = await t.call('recall_headset', { sessionId: t.sessionId, text: 'Back to the lesson.' });
      // The departure marker expires after ten minutes and a wearer can study
      // a structure for longer, so a recall is never refused on that belief.
      expect(queued.structuredContent.detailedRecall.away).toBe(false);
      expect(queued.content[0].text).toContain('Back to the lesson.');
      t.clock.now += 10 * 60_000;
      expect((await t.call('poll_detailed_view', { sessionId: t.sessionId })).structuredContent.detailedRecall).toEqual({ recall: false });
    } finally { await t.close(); }
  });
});

describe('a headset page loading a heavy structure', () => {
  it('reports an overdue load with the last panel state and refuses desktop fallback', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId;
      await t.call('poll_inspection', { ...t.binding, panelId: companion, availability: 'busy' });
      const budget = (await t.current()).structuredContent.renderBudgetMs;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'loading' });
      t.clock.now += budget - 1;
      expect((await t.current()).structuredContent.companionLoading).toBe(true);
      t.clock.now++;
      const overdue = (await t.current()).structuredContent;
      expect(overdue.companionLoading).toBe(false);
      expect(overdue.companionLoad).toMatchObject({ status: 'timed-out', budgetMs: budget, elapsedMs: budget,
        lastPanel: { panelId: companion, availability: 'busy', stateRevision: t.binding.baseStateRevision,
          inspectionRevision: t.binding.baseInspectionRevision } });
      const refusal = choosePanel([{ panelId: 'ready-desktop', surface: 'desktop', current: true, availability: 'ready' }], overdue);
      expect(refusal).toEqual({ error: `The headset page did not re-register within its ${budget} ms render budget. Last panel ${companion} was busy at state revision ${t.binding.baseStateRevision}, inspection revision ${t.binding.baseInspectionRevision}. Read the headset diagnostics before retrying.` });
      t.clock.now += 5 * 60_000;
      expect((await t.current()).structuredContent.companionLoad.status).toBe('timed-out');
      await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      expect((await t.current()).structuredContent.companionLoad).toBeNull();
    } finally { await t.close(); }
  });
  it('is reported as loading, not as nobody having the page open', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      expect((await t.current()).structuredContent.companionLoading).toBe(false);

      // inspector.ts hydrate() detaches before it loads and cannot register
      // again until the structure has rendered and saved. The microtubule wall
      // stage holds that gap open long enough for an agent command to land
      // inside it.
      const left = await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'loading' });
      expect(left.structuredContent.detached).toBe(true);
      const loading = (await t.current()).structuredContent;
      expect(loading.companionLoading).toBe(true);
      expect((loading.panels as any[]).some(panel => panel.surface === 'companion')).toBe(false);

      // The advice the agent used to give here was "open the printed address
      // in a browser", read out to someone already wearing the headset. The
      // Mac's own ready panel is not the answer either: a change rendered
      // there is a change nobody in the session can see.
      expect((loading.panels as any[]).map(panel => `${panel.surface} ${panel.availability}`)).toEqual(['desktop ready']);
      expect(choosePanel(loading.panels, { companionLoading: loading.companionLoading }))
        .toEqual({ error: COMPANION_LOADING_MESSAGE });

      await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      expect((await t.current()).structuredContent.companionLoading).toBe(false);
    } finally { await t.close(); }
  });

  it('stops claiming a load past the horizon, and claims none for a desktop panel or a plain detach', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: companion, reason: 'loading' });
      t.clock.now += 5 * 60_000;
      expect((await t.current()).structuredContent.companionLoading).toBe(false);

      const again = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: again });
      expect((await t.current()).structuredContent.companionLoading).toBe(false);

      const desktop = (await t.call('attach_inspection', { ...t.binding, surface: 'desktop' })).structuredContent.panelId as string;
      await t.call('detach_inspection', { ...t.binding, panelId: desktop, reason: 'loading' });
      expect((await t.current()).structuredContent.companionLoading).toBe(false);
    } finally { await t.close(); }
  });

  it('keeps a headset panel that said busy through a rebuild longer than the ordinary minute', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      const ids = async () => ((await t.current()).structuredContent.panels as any[]).map(panel => panel.panelId);

      // A Quest 2 at 3 fps inside a 40,908-site representation rebuild runs no
      // JavaScript, so the beat stops. Before this the panel was deleted at a
      // minute and the agent was told there was no page at all.
      await t.call('poll_inspection', { ...t.binding, panelId: companion, availability: 'busy' });
      t.clock.now += 90_000;
      expect(await ids()).toContain(companion);

      // It is a longer wait, not an unbounded one.
      t.clock.now += 95_000;
      expect(await ids()).not.toContain(companion);
    } finally { await t.close(); }
  });

  it('still retires a headset panel that stopped beating while it said ready', async () => {
    const t = await setup();
    try {
      const companion = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId as string;
      await t.call('poll_inspection', { ...t.binding, panelId: companion, availability: 'ready' });
      t.clock.now += 90_000;
      expect(((await t.current()).structuredContent.panels as any[]).map(panel => panel.panelId)).not.toContain(companion);
    } finally { await t.close(); }
  });
});


it('a replacement panel does not inherit an old panel conflict outcome', async () => {
  const t = await setup();
  try {
    const tourId = (await t.current()).structuredContent.tours[0].id as string;
    const queued = await t.call('update_inspection', update(t.binding, t.panelId, 'old-tour-start', {
      kind: 'tour', patch: { action: 'start', tourId },
    }));
    expect(queued.isError).not.toBe(true);
    const conflict = await t.poll('unsaved');
    expect(conflict.result.structuredContent.outcome).toMatchObject({
      commandId: 'old-tour-start', panelId: t.panelId, status: 'conflict', fields: ['action', 'tourId'],
    });
    await t.call('detach_inspection', { ...t.binding, panelId: t.panelId });
    const replacement = (await t.call('attach_inspection', t.binding)).structuredContent.panelId as string;
    const fresh = await t.poll('ready', t.binding, replacement);
    expect(fresh.result.structuredContent.attached).toBe(true);
    expect(fresh.result.structuredContent.outcome).toBeNull();
    expect(fresh.delivery).toBeUndefined();
    expect((await t.current('old-tour-start')).structuredContent.command.status).toBe('conflict');
  } finally { await t.close(); }
});


it('keeps operation and timing metadata through retries and rendered state',async()=>{
  const t=await setup();
  try {
    t.clock.now=100;
    const lifecycle=await t.call('update_inspection',{...t.binding,panelId:t.panelId,commandId:'timed-begin',change:{kind:'utterance',patch:{action:'begin'}}});
    const utteranceId=lifecycle.structuredContent.lifecycle.utterance.utteranceId;
    const input={...update(t.binding,t.panelId,'timed-command',{kind:'appearance',patch:{opacity:0.5}}),utteranceId,actionPostedAt:90};
    const queued=(await t.call('update_inspection',input)).structuredContent.command;
    expect(queued).toMatchObject({acceptedAt:100,actionPostedAt:90,utteranceId,
      operation:{version:1,kind:'visual-edit',coordinatesChanged:false,tool:'update_inspection',effects:['appearance']}});
    expect(queued.renderedAt).toBeUndefined();
    t.clock.now=120;
    expect((await t.call('update_inspection',input)).structuredContent.command).toEqual(queued);
    const claimed=await t.poll();
    expect(claimed.delivery.utteranceId).toBe(utteranceId);
    const scene=structuredClone(t.scene);scene.inspection.appearance.opacity=0.5;
    t.clock.now=180;
    const completed=(await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:'timed-command',claimToken:claimed.delivery.claimToken,scene})).structuredContent.command;
    expect(completed).toMatchObject({status:'rendered',acceptedAt:100,renderedAt:180,operation:queued.operation});
    const state=(await t.current('timed-command')).structuredContent;
    expect(state.command).toEqual(completed);
    expect(state.operationInventory).toContainEqual({kind:'appearance',operation:'visual-edit',coordinatesChanged:false});
    expect(state.sourceOperation).toBeNull();
  } finally {await t.close();}
});

it('reattach retires exactly the replaced companion and leaves its commands unconfirmed', async () => {
  const t = await setup();
  try {
    const old = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId;
    const queued = update(t.binding, old, 'old-panel-command', { kind: 'appearance', patch: { color: 'chain-id' } });
    await t.call('update_inspection', queued);
    const delivery = (await t.poll('ready', t.binding, old)).delivery;
    expect(delivery).toBeTruthy();
    const attached = await t.call('attach_inspection', { ...t.binding, surface: 'companion', replacesPanelId: old });
    expect(attached.isError).not.toBe(true);
    const summary = (await t.current('old-panel-command')).structuredContent;
    expect(summary.panels.map((p: any) => p.panelId)).toEqual(expect.arrayContaining([t.panelId, attached.structuredContent.panelId]));
    expect(summary.panels.some((p: any) => p.panelId === old)).toBe(false);
    expect(summary.command.status).toBe('unconfirmed');
    expect((await t.poll('ready', t.binding, old)).result.structuredContent.attached).toBe(false);
  } finally { await t.close(); }
});

it('replacement refuses stale binding and wrong surface without retiring an existing panel', async () => {
  const t = await setup();
  try {
    expect((await t.call('attach_inspection', { ...t.binding, sourceToken: 'stale', replacesPanelId: t.panelId })).isError).toBe(true);
    expect((await t.call('attach_inspection', { ...t.binding, surface: 'companion', replacesPanelId: t.panelId })).isError).toBe(true);
    expect((await t.current()).structuredContent.panels.map((p: any) => p.panelId)).toEqual([t.panelId]);
  } finally { await t.close(); }
});

describe('superseded receipt parity', () => {
  it.each([false, true])('releases queued supersession chains only after a matching correction renders (failure=%s)', async failure => {
    const t = await setup();
    try {
      const control = async (commandId: string, action: 'begin' | 'correct') => {
        const result = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId,
          change: { kind: 'utterance', patch: { action } } });
        return result.structuredContent.lifecycle.utterance.utteranceId as string;
      };
      const edit = (commandId: string, utteranceId: string) => t.call('update_inspection', {
        ...t.binding, panelId: t.panelId, commandId, utteranceId,
        change: { kind: 'appearance', patch: { representation: 'cartoon' } } });
      await edit('slow', await control('begin', 'begin'));
      t.clock.now = 200;
      const first = await control('correct-1', 'correct');
      await edit('first', first);
      t.clock.now = 400;
      const second = await control('correct-2', 'correct');
      await edit('second', second);
      const delivery = (await t.poll()).delivery;
      expect(delivery.commandId).toBe('second');
      const before = (await t.current()).structuredContent;
      expect(before.commands.filter((c: any) => c.commandId !== 'second')).toMatchObject([
        { commandId: 'slow', status: 'superseded', supersededBy: first, fenceReleased: 'pending' },
        { commandId: 'first', status: 'superseded', supersededBy: second, fenceReleased: 'pending' },
      ]);
      const done = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken,
        ...(failure ? { failure: 'render_failed', failureReason: 'Synthetic geometry failure.' } : { scene: t.scene }) });
      expect(done.isError).not.toBe(true);
      expect(done.structuredContent.command.status).toBe(failure ? 'rejected' : 'rendered');
      const after = (await t.current()).structuredContent;
      expect(after.commands.filter((c: any) => c.commandId !== 'second')).toMatchObject([
        { commandId: 'slow', status: 'superseded', supersededBy: first, fenceReleased: failure ? 'pending' : 'replacement-rendered' },
        { commandId: 'first', status: 'superseded', supersededBy: second, fenceReleased: failure ? 'pending' : 'replacement-rendered' },
      ]);
    } finally { await t.close(); }
  });

  it.each([
    { gap: 200, wait: false }, { gap: 200, wait: true },
    { gap: 500, wait: false }, { gap: 500, wait: true },
  ])('echoes the $gap ms correction with wait=$wait through the real queue, server and converse', async ({ gap, wait }) => {
    const t = await setup();
    const directory = await mkdtemp(join(tmpdir(), 'd73-converse-'));
    const stop = new AbortController();
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const posted = gate(), initialEcho = gate(), corrected = gate(), render = gate();
    const lines: any[] = [];
    let lifecycle: any, oldClaim: any, loop: Promise<void> | undefined;
    try {
      t.scene.inspection.appearance.representation = 'ball-and-stick';
      const saved = await t.call('sync_inspection', { ...t.binding, scene: t.scene });
      t.binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
      const panelId = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId;
      const statePath = join(directory, 'control.json');
      await writeFile(statePath, JSON.stringify({ origin: 'http://127.0.0.1:12345', token: 'synthetic', sessionId: t.sessionId }));
      // Only the socket and geometry are synthetic. Receipt publication,
      // argument binding, lifecycle dispatch and JSON result lines are real.
      vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
        const call = JSON.parse(String(options.body));
        if (call.name === 'listen_voice') return Response.json({ structuredContent: { listening: true, cursor: 0, transcripts: [] } });
        const result = await t.call(call.name, { ...call.arguments, sessionId: t.sessionId });
        if (result.isError) return Response.json({ error: result.content[0].text }, { status: 409 });
        if (call.name === 'update_inspection') {
          if (call.arguments.change.kind === 'utterance') lifecycle = result.structuredContent.lifecycle;
          else if (call.arguments.commandId === 'slow') posted.resolve();
          else if (call.arguments.commandId === 'correction') corrected.resolve();
        }
        return Response.json(result);
      });
      const command = (id: string, representation: string) => ({ id, tool: 'update_inspection',
        args: { commandId: id, change: { kind: 'appearance', patch: { representation } } } });
      async function* input() {
        yield JSON.stringify({ ...command('slow', 'molecular-surface'), utterance: 'begin', wait });
        await posted.promise;
        if (!wait) await initialEcho.promise;
        if (gap === 500) {
          t.clock.now = 100;
          const delivery = (await t.poll('ready', t.binding, panelId)).delivery;
          oldClaim = { ...t.binding, panelId, commandId: delivery.commandId, claimToken: delivery.claimToken };
          expect((await t.call('complete_inspection', { ...oldClaim, phase: 'admit' })).structuredContent.admitted).toBe(true);
          await t.poll('busy', t.binding, panelId);
        }
        expect((await t.current('slow')).structuredContent.command.status).toBe(gap === 200 ? 'queued' : 'rendering');
        t.clock.now = gap;
        yield JSON.stringify({ ...command('correction', 'cartoon'), utterance: 'correct' });
        await render.promise;
        if (oldClaim) {
          expect((await t.poll('ready', t.binding, panelId)).delivery).toBeUndefined();
          const late = structuredClone(t.scene); late.inspection.appearance.representation = 'molecular-surface';
          expect((await t.call('complete_inspection', { ...oldClaim, scene: late })).structuredContent.accepted).toBe(false);
          await t.call('complete_inspection', { ...oldClaim, phase: 'settled' });
        }
        const delivery = (await t.poll('ready', t.binding, panelId)).delivery;
        expect(delivery.commandId).toBe('correction');
        // Claiming the correction is not a rendered confirmation.
        if (gap === 200) expect.soft((await t.current('slow')).structuredContent.command.fenceReleased).toBe('pending');
        t.clock.now += 300;
        const scene = structuredClone(t.scene); scene.inspection.appearance.representation = 'cartoon';
        const done = await t.call('complete_inspection', { ...t.binding, panelId,
          commandId: delivery.commandId, claimToken: delivery.claimToken, scene });
        expect(done.structuredContent.command.status).toBe('rendered');
        t.binding.baseInspectionRevision = done.structuredContent.inspectionRevision;
      }
      loop = converse({ statePath, input: input(), stop: stop.signal, note: () => {},
        wait: { pollMs: 1, timeoutMs: 2_000 }, idleFloorMs: 1,
        write: line => {
          const result = JSON.parse(line); lines.push(result);
          if (result.id === 'slow') initialEcho.resolve();
          if (result.id === 'correction' && result.type === 'result') stop.abort();
        } });
      await corrected.promise;
      const before = (await t.current('slow')).structuredContent;
      const superseded = { commandId: 'slow', status: 'superseded',
        supersededBy: lifecycle.utterance.utteranceId, fenceReleased: 'pending' };
      expect.soft(lifecycle.commands[0]).toMatchObject(superseded);
      expect.soft(before.command).toMatchObject(superseded);
      expect.soft(before.commands.find((c: any) => c.commandId === 'slow')).toMatchObject(superseded);
      expect(before.view.appearance.representation).toBe('ball-and-stick');
      expect(lines.some(line => line.id === 'correction' && line.rendered)).toBe(false);
      // Let the ordinary receipt follower observe supersession before draw.
      if (wait) await initialEcho.promise;
      render.resolve();
      await loop;
      const oldResults = lines.filter(line => line.id === 'slow' && line.type === 'result');
      if (!wait) expect(oldResults[0].receipt.status).toBe('queued');
      const terminal = oldResults.filter(line => line.receipt?.status === 'superseded');
      expect.soft(terminal).toHaveLength(1);
      expect.soft(terminal[0]).toMatchObject({ rendered: false, timedOut: false, receipt: superseded });
      expect(lines.filter(line => line.type === 'error')).toEqual([]);
      expect(lines.find(line => line.id === 'correction')).toMatchObject({ rendered: true, receipt: { status: 'rendered' } });
      const after = (await t.current('slow')).structuredContent;
      const released = { ...superseded, fenceReleased: gap === 200 ? 'replacement-rendered' : 'rolled-back' };
      expect.soft(after.command).toMatchObject(released);
      expect.soft(after.commands.find((c: any) => c.commandId === 'slow')).toMatchObject(released);
      expect(after.pendingCommand).toEqual([]);
      expect(after.view.appearance.representation).toBe('cartoon');
    } finally {
      render.resolve(); stop.abort();
      await loop;
      vi.unstubAllGlobals();
      await t.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('superseded render fence recovery', () => {
  it.each([200, 500])('admits the agent correction at %i ms through the real server with a busy headset', async gap => {
    const t = await setup();
    try {
      const panelId = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId;
      const send = (call: AgentCall) => sendAgentCall({ origin: 'http://127.0.0.1:12345', token: 'synthetic', sessionId: t.sessionId },
        call, undefined, async (_host, name, args = {}) => {
          const result = await t.call(name, { ...args, sessionId: t.sessionId });
          if (result.isError) throw Error(result.content.map((part: any) => part.text ?? '').join(' '));
          return result;
        });
      const edit = (commandId: string, patch: object, utterance: 'begin' | 'correct'): AgentCall => ({
        name: 'update_inspection', utterance, arguments: { commandId, change: { kind: 'appearance', patch } },
      });
      await send(edit('surface', { representation: 'molecular-surface' }, 'begin'));
      const old = (await t.poll('ready', t.binding, panelId)).delivery;
      const claim = { ...t.binding, panelId, commandId: old.commandId, claimToken: old.claimToken };
      expect((await t.call('complete_inspection', { ...claim, phase: 'admit' })).structuredContent.admitted).toBe(true);
      await t.poll('busy', t.binding, panelId);
      t.clock.now = gap;
      const correction = await send(edit('cartoon', { representation: 'cartoon' }, 'correct'));
      expect(correction).toMatchObject({ panelId, blurWaitedMs: 0,
        utterance: { action: 'correct', superseded: 1 }, receipt: { status: 'queued' } });
      expect((await t.current('surface')).structuredContent.command).toMatchObject({ status: 'superseded',
        supersededBy: correction.utterance!.utteranceId });
      expect((await t.poll('ready', t.binding, panelId)).delivery).toBeUndefined();
      t.clock.now = 700;
      const late = structuredClone(t.scene); late.inspection.appearance.representation = 'molecular-surface';
      expect((await t.call('complete_inspection', { ...claim, scene: late })).structuredContent.accepted).toBe(false);
      expect((await t.call('complete_inspection', { ...claim, phase: 'settled' })).structuredContent.command)
        .toMatchObject({ status: 'superseded', fenceReleased: 'rolled-back' });
      const next = (await t.poll('ready', t.binding, panelId)).delivery;
      expect(next.commandId).toBe('cartoon');
      t.clock.now = 1400;
      const rendered = await t.call('complete_inspection', { ...t.binding, panelId,
        commandId: next.commandId, claimToken: next.claimToken, scene: t.scene });
      expect(rendered.structuredContent.command).toMatchObject({ status: 'rendered', renderedAt: 1400 });
      t.binding.baseInspectionRevision = rendered.structuredContent.inspectionRevision;
      expect((await send(edit('third', { opacity: .8 }, 'begin'))).receipt?.status).toBe('queued');
      const third = (await t.poll('ready', t.binding, panelId)).delivery;
      t.scene.inspection.appearance.opacity = .8;
      t.clock.now = 2100;
      expect((await t.call('complete_inspection', { ...t.binding, panelId,
        commandId: third.commandId, claimToken: third.claimToken, scene: t.scene })).structuredContent.command)
        .toMatchObject({ status: 'rendered', renderedAt: 2100 });
      expect((await t.current()).structuredContent.pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it.each(['rollback', 'settles-before-admission', 'detach', 'desktop-grace', 'companion-grace', 'deadline', 'host-suspension', 'late-settlement-first'] as const)(
    'renders a third command after a correction 262 ms into a render: %s', async path => {
      const t = await setup();
      try {
        t.scene.inspection.appearance.representation = 'ball-and-stick';
        t.scene.inspection.appearance.color = 'element-symbol';
        const saved = await t.call('sync_inspection', { ...t.binding, scene: t.scene });
        t.binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
        let panelId = (await t.call('attach_inspection', { ...t.binding,
          surface: path === 'desktop-grace' ? 'desktop' : 'companion' })).structuredContent.panelId;
        const begin = async (id: string, action = 'begin') => {
          const result = await t.call('update_inspection', { ...t.binding, panelId, commandId: id,
            change: { kind: 'utterance', patch: { action } } });
          expect(result.isError).not.toBe(true);
          return result.structuredContent.lifecycle.utterance.utteranceId;
        };
        const firstUtterance = await begin('surface-utterance');
        await t.call('update_inspection', { ...update(t.binding, panelId, 'surface',
          { kind: 'appearance', patch: { representation: 'molecular-surface' } }), utteranceId: firstUtterance });
        const old = (await t.poll('ready', t.binding, panelId)).delivery;
        const oldClaim = { ...t.binding, panelId, commandId: old.commandId, claimToken: old.claimToken };
        if (path !== 'settles-before-admission')
          expect((await t.call('complete_inspection', { ...oldClaim, phase: 'admit' })).structuredContent.admitted).toBe(true);
        t.clock.now = 262;
        const correction = await begin('cartoon-utterance', 'correct');
        expect((await t.current('surface')).structuredContent.command).toMatchObject({ status: 'superseded', supersededBy: correction });
        expect((await t.call('update_inspection', { ...update(t.binding, panelId, 'cartoon',
          { kind: 'appearance', patch: { representation: 'cartoon' } }), utteranceId: correction })).structuredContent.command.status).toBe('queued');
        const availability = path.includes('grace') ? 'ready' : 'busy';
        expect((await t.poll(availability, t.binding, panelId)).delivery).toBeUndefined();
        expect((await t.current()).structuredContent.pendingCommand).toContainEqual(expect.objectContaining({ commandId: 'surface', renderFence: true }));
        let reason: 'rolled-back' | 'panel-lost' | 'deadline';
        if (path === 'rollback' || path === 'settles-before-admission') {
          if (path === 'rollback') {
            const late = structuredClone(t.scene); late.inspection.appearance.representation = 'molecular-surface';
            expect((await t.call('complete_inspection', { ...oldClaim, scene: late })).structuredContent)
              .toMatchObject({ accepted: false, command: { status: 'superseded' } });
          } else expect((await t.call('complete_inspection', { ...oldClaim, phase: 'admit' })).structuredContent.admitted).toBe(false);
          const forged = await t.call('complete_inspection', { ...oldClaim, claimToken: randomUUID(), phase: 'settled' });
          expect(forged.isError).toBe(true);
          expect((await t.poll('ready', t.binding, panelId)).delivery).toBeUndefined();
          const done = await t.call('complete_inspection', { ...oldClaim, phase: 'settled' });
          expect(done.structuredContent).toMatchObject({ settled: true, command: { status: 'superseded', fenceReleased: 'rolled-back' } });
          reason = 'rolled-back';
          const next = (await t.poll('ready', t.binding, panelId)).delivery;
          expect(next.commandId).toBe('cartoon');
          expect((await t.current('cartoon')).structuredContent.command.renderedAt).toBeUndefined();
          t.scene.inspection.appearance.representation = 'cartoon';
          const rendered = await t.call('complete_inspection', { ...t.binding, panelId, commandId: next.commandId, claimToken: next.claimToken, scene: t.scene });
          expect(rendered.structuredContent.command.status).toBe('rendered');
          t.binding.baseInspectionRevision = rendered.structuredContent.inspectionRevision;
        } else {
          if (path === 'detach') {
            await t.call('detach_inspection', { ...t.binding, panelId }); reason = 'panel-lost';
          } else {
            const bound = path === 'desktop-grace' ? 10_262 : path === 'companion-grace' ? 60_262
              : (await t.current('surface')).structuredContent.command.renderBudgetMs;
            t.clock.now = bound - 1;
            expect((await t.current()).structuredContent.pendingCommand).toContainEqual(expect.objectContaining({ commandId: 'surface', renderFence: true }));
            if (path === 'deadline') await t.poll('busy', t.binding, panelId); // Heartbeats cannot renew the claim deadline.
            t.clock.now = path === 'host-suspension' ? 28 * 60_000 : bound;
            reason = path.includes('grace') ? 'panel-lost' : 'deadline';
            if (path === 'late-settlement-first')
              expect((await t.call('complete_inspection', { ...oldClaim, phase: 'settled' })).structuredContent.command.fenceReleased).toBe('deadline');
            expect((await t.current('surface')).structuredContent.command.fenceReleased).toBe(reason);
            if (path === 'desktop-grace') {
              expect((await t.current('cartoon')).structuredContent.command.status).toBe('queued');
              t.clock.now = 15_262; // The dead panel's correction retains its own queue deadline.
            }
            expect((await t.current('cartoon')).structuredContent.command.status).toBe('expired');
          }
          panelId = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId;
        }
        expect((await t.current('surface')).structuredContent.command).toMatchObject({ status: 'superseded', supersededBy: correction, fenceReleased: reason });
        expect((await t.current()).structuredContent.pendingCommand).toEqual([]);
        await t.poll('ready', t.binding, panelId);
        // An independent next utterance must be able to use the corrected session.
        const thirdUtterance = await begin('third-utterance');
        const third = await t.call('update_inspection', { ...update(t.binding, panelId, 'third',
          { kind: 'appearance', patch: { opacity: .8 } }), utteranceId: thirdUtterance });
        expect(third.structuredContent.command.status).toBe('queued');
        const delivery = (await t.poll('ready', t.binding, panelId)).delivery;
        expect(delivery.commandId).toBe('third');
        t.scene.inspection.appearance.opacity = .8;
        const rendered = await t.call('complete_inspection', { ...t.binding, panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene });
        expect(rendered.structuredContent.command.status).toBe('rendered');
        // A late frame or repeated settlement cannot overwrite the third command
        // or relabel a deadline/panel-loss release as proof of rollback.
        expect((await t.call('complete_inspection', { ...oldClaim, scene: t.scene })).structuredContent)
          .toMatchObject({ accepted: false, command: { status: 'superseded', fenceReleased: reason } });
        expect((await t.call('complete_inspection', { ...oldClaim, phase: 'settled' })).structuredContent.command.fenceReleased).toBe(reason);
        expect((await t.call('get_inspection', { sessionId: t.sessionId }))._meta[PRIVATE_KEY].scene).toEqual(t.scene);
      } finally { await t.close(); }
    });
});

/**
 * The budget a caller has to follow belongs on the receipt.
 *
 * `get_inspection_state` has published `renderBudgetMs` for the loaded source
 * since tabs and waits were added. A Quest 2 run collected every
 * receipt the converse loop returned and not one of them carried the field, so
 * an agent following a single command had to read the budget off a different
 * answer about a possibly different source. These assert the two numbers are
 * the same number, at each of the three statuses a command passes through.
 */
describe('stated render budget on receipts', () => {
  it('carries the host renderBudgetMs on the queued, rendering and rendered receipt', async () => {
    const t = await setup();
    try {
      const budget = (await t.current()).structuredContent.renderBudgetMs;
      expect(budget).toBeGreaterThan(0);
      const queued = await t.call('update_inspection',
        update(t.binding, t.panelId, 'budget-receipt', { kind: 'appearance', patch: { color: 'chain-id' } }));
      expect(queued.structuredContent.command).toMatchObject({ status: 'queued', renderBudgetMs: budget });
      const followed = (await t.current('budget-receipt')).structuredContent;
      expect(followed.command).toMatchObject({ status: 'queued', renderBudgetMs: budget });
      expect(followed.pendingCommand[0]).toMatchObject({ commandId: 'budget-receipt', renderBudgetMs: budget });
      const { delivery } = await t.poll();
      expect(delivery.commandId).toBe('budget-receipt');
      expect((await t.current('budget-receipt')).structuredContent.command)
        .toMatchObject({ status: 'rendering', renderBudgetMs: budget });
      const rendered = structuredClone(t.scene);
      rendered.inspection.appearance.color = 'chain-id';
      const done = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered });
      expect(done.structuredContent.command).toMatchObject({ status: 'rendered', renderBudgetMs: budget });
      expect(done.structuredContent.command.renderedAt).toBeGreaterThanOrEqual(0);
    } finally { await t.close(); }
  });

  it('states the same budget on a named-view receipt', async () => {
    const t = await setup();
    try {
      const budget = (await t.current()).structuredContent.renderBudgetMs;
      const saved = await t.call('manage_inspection_view', { ...t.binding, panelId: t.panelId,
        commandId: 'budget-view', action: 'save', name: 'Budget view' });
      expect(saved.isError).not.toBe(true);
      expect(saved.structuredContent.command).toMatchObject({ status: 'queued', renderBudgetMs: budget });
    } finally { await t.close(); }
  });
});

describe('overlapping voice correction', () => {
  async function voiceFixture() {
    const transcriber = createPushToTalkTranscriber({ enabled: false });
    transcriber.accept = async input => {
      if (input.final) transcriber.transcripts.publish({ utteranceId: input.utteranceId,
        text: 'No, make it cartoon.', durationMs: 1, receivedAt: new Date(0).toISOString(), model: 'synthetic' });
      return { ...input, accepted: true, reason: 'chunk', message: 'Synthetic chunk' };
    };
    const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
    const t = await setup(hhb, { transcriber });
    const panelId = (await t.call('attach_inspection', { ...t.binding, surface: 'companion' })).structuredContent.panelId;
    await t.poll('ready', t.binding, panelId); // Register the wearer's caption mailbox before speaking.
    let cursor = 0;
    const record = async () => {
      const utteranceId = randomUUID();
      const audio = { sessionId: t.sessionId, panelId, utteranceId, mime: 'audio/webm' };
      expect((await t.call('push_to_talk_audio', { ...audio, seq: 0, data: 'AAAA', final: false })).isError).not.toBe(true);
      return async () => {
        await t.call('push_to_talk_audio', { ...audio, seq: 1, final: true });
        const heard = await t.call('listen_voice', { cursor, timeoutSeconds: 1 });
        cursor = heard.structuredContent.cursor;
        expect(heard.structuredContent.transcripts[0].utteranceId).toBe(utteranceId);
        return utteranceId;
      };
    };
    const hear = async () => (await record())();
    const edit = (commandId: string, utteranceId: string, representation = 'cartoon') => t.call('update_inspection', {
      ...update(t.binding, panelId, commandId, { kind: 'appearance', patch: { representation } }), utteranceId,
    });
    const correct = async () => {
      const utteranceId = await hear();
      expect((await t.call('update_inspection', { ...t.binding, panelId, utteranceId, commandId: `correct-${utteranceId}`,
        change: { kind: 'utterance', patch: { action: 'correct' } } })).isError).not.toBe(true);
      return utteranceId;
    };
    const beat = (availability: 'ready' | 'busy' | 'unsaved' = 'ready', binding = t.binding) => t.poll(availability, binding, panelId);
    const startSurface = async (lastBeatAt = 2595) => {
      await edit('surface', await hear(), 'molecular-surface');
      t.clock.now = 762;
      const { delivery } = await beat();
      const claim = { ...t.binding, panelId, commandId: delivery.commandId, claimToken: delivery.claimToken };
      expect((await t.call('complete_inspection', { ...claim, phase: 'admit' })).structuredContent.admitted).toBe(true);
      t.clock.now = lastBeatAt; // The last heartbeat is 5 ms before the correction.
      await beat('busy');
      t.clock.now = lastBeatAt + 5; // Default: 1,838 ms into the render, as recorded on a device run.
      return claim;
    };
    return { ...t, panelId, record, hear, edit, correct, beat, startSurface };
  }

  describe('correction after render', () => {
    it('captions a voice correction refused after a genuine source retarget', async () => {
      const t = await voiceFixture();
      try {
        const claim = await t.startSurface();
        const transcript = await t.record();
        const original = { ...t.binding };
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        await t.call('complete_inspection', { ...claim, scene: surface });
        t.binding.baseInspectionRevision++;
        await t.beat();
        const replaced = await t.call('replace_inspection_source', { ...t.binding, panelId: t.panelId,
          source: { kind: 'pasted', text: cif, format: 'mmcif' } });
        expect(replaced.isError).not.toBe(true);
        expect(replaced.structuredContent.sourceToken).not.toBe(original.sourceToken);
        const utteranceId = await transcript();
        const refused = await t.call('update_inspection', { ...original, panelId: t.panelId, utteranceId,
          commandId: 'd79-source-refusal', change: { kind: 'utterance', patch: { action: 'correct' } } });
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain('will not be retargeted');
        const caption = (await t.beat('busy', original)).result._meta[PRIVATE_KEY].headsetCaption;
        expect(caption).toMatchObject({ utteranceId, commandId: 'd79-source-refusal',
          refusal: { tool: 'update_inspection' }, text: expect.stringMatching(/^Could not apply · request refused\. .*changed/u) });
        expect(caption.text).not.toMatch(/_inspection/u);
        expect((await t.current()).structuredContent.pendingCommand).toHaveLength(0);
        expect((await t.current('surface')).structuredContent.command.status).toBe('rendered');
      } finally { await t.close(); }
    });

    it.each(['unsaved', 'different revision'] as const)('preserves the %s conflict during registration', async path => {
      const t = await voiceFixture();
      try {
        const claim = await t.startSurface();
        const prior = { ...t.binding };
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        await t.call('complete_inspection', { ...claim, scene: surface });
        t.binding.baseInspectionRevision++;
        const queued = await t.edit('d79-conflict', await t.hear());
        expect(queued.structuredContent.command.status).toBe('queued');
        const heartbeat = path === 'unsaved' ? prior : { ...prior, baseInspectionRevision: 0 };
        const polled = await t.beat(path === 'unsaved' ? 'unsaved' : 'busy', heartbeat);
        expect(polled.delivery).toBeUndefined();
        expect((await t.current('d79-conflict')).structuredContent.command).toMatchObject({ status: 'conflict',
          reason: 'The target panel has newer or unsaved local work.' });
      } finally { await t.close(); }
    });

    it('keeps a later old heartbeat from undoing a completed re-registration', async () => {
      const t = await voiceFixture();
      try {
        const claim = await t.startSurface();
        const prior = { ...t.binding };
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        await t.call('complete_inspection', { ...claim, scene: surface });
        t.binding.baseInspectionRevision++;
        await t.beat();
        await t.edit('d79-late-beat', await t.hear());
        expect((await t.beat('busy', prior)).delivery).toBeUndefined();
        const state = (await t.current('d79-late-beat')).structuredContent;
        expect(state.command.status).toBe('queued');
        expect(state.panels.find((p: any) => p.panelId === t.panelId)).toMatchObject({ current: true, availability: 'ready' });
        expect((await t.beat()).delivery.commandId).toBe('d79-late-beat');
      } finally { await t.close(); }
    });

    it('reserves the browser-opening sentence for a session without a registered companion', async () => {
      const t = await voiceFixture();
      try {
        await t.call('detach_inspection', { ...t.binding, panelId: t.panelId });
        const state = (await t.current()).structuredContent;
        const empty = choosePanel([], state);
        expect(empty).toHaveProperty('error');
        expect((empty as { error: string }).error).not.toContain('Open the printed address');
        expect((choosePanel([]) as { error: string }).error).toContain('Open the printed address');
      } finally { await t.close(); }
    });

    it.each([1413, 332])('renders the first spoken correction issued %i ms after the older render', async gap => {
      const t = await voiceFixture();
      try {
        const claim = await t.startSurface(2525);
        const prior = { ...t.binding }; // Row 1: first audio chunk recorded 200 ms before the receipt.
        const transcript = await t.record();
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        t.clock.now = 2730;
        expect((await t.call('complete_inspection', { ...claim, scene: surface })).structuredContent.command.status).toBe('rendered');
        t.binding.baseInspectionRevision++;
        // A poll dispatched before complete can arrive after its response.
        await t.beat('busy', { ...t.binding, baseInspectionRevision: claim.baseInspectionRevision });
        if (gap === 1413) await t.beat(); // Row 1 has re-registered; row 1b has not.
        t.clock.now = 2730 + gap;
        const utteranceId = await transcript();
        const sent = await sendAgentCall({ origin: 'http://127.0.0.1:12345', token: 'synthetic', sessionId: t.sessionId },
          { name: 'update_inspection', utterance: 'correct', arguments: { utteranceId, commandId: 'd79-cartoon',
            change: { kind: 'appearance', patch: { representation: 'cartoon' } } } }, undefined,
          async (_host, name, args = {}) => {
            const result = await t.call(name, { ...args, sessionId: t.sessionId });
            if (result.isError) throw Error(result.content[0].text);
            return result;
          });
        expect(sent).toMatchObject({ panelId: t.panelId, blurWaitedMs: 0,
          utterance: { action: 'correct', superseded: 1 }, receipt: { status: 'queued' } });
        expect((await t.current('surface')).structuredContent.command).toMatchObject({ status: 'superseded',
          supersededBy: utteranceId, renderedRevision: 2 });
        if (gap === 332) {
          expect(sent.receipt).toMatchObject({ heldForPanel: true });
          expect((await t.beat('busy', prior)).delivery).toBeUndefined();
          expect((await t.current('d79-cartoon')).structuredContent.command.status).toBe('queued');
        }
        const { delivery } = await t.beat();
        expect(delivery.commandId).toBe('d79-cartoon');
        expect((await t.current('d79-cartoon')).structuredContent.command.renderedAt).toBeUndefined();
        expect((await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
          commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene })).structuredContent)
          .toMatchObject({ accepted: true, inspectionRevision: 3, command: { status: 'rendered', renderedRevision: 3 } });
        expect((await t.call('complete_inspection', { ...claim, scene: surface })).structuredContent)
          .toMatchObject({ accepted: false, inspectionRevision: 3, command: { status: 'superseded' } });
      } finally { await t.close(); }
    });

    it('queues an ordinary command 332 ms after rendering until the exact panel re-registers', async () => {
      const t = await voiceFixture();
      try {
        const claim = await t.startSurface(2177);
        const prior = { ...t.binding };
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        t.clock.now = 2187;
        await t.call('complete_inspection', { ...claim, scene: surface });
        t.binding.baseInspectionRevision++;
        await t.beat('busy', prior);
        t.clock.now += 332;
        const state = (await t.current()).structuredContent;
        expect(choosePanel(state.panels, state)).toEqual({ panelId: t.panelId });
        const utteranceId = await t.hear(); // New speech is allowed during re-registration too.
        const queued = await t.edit('d79-next', utteranceId);
        expect(queued.structuredContent.command).toMatchObject({ status: 'queued', heldForPanel: true });
        for (const availability of ['busy', 'ready'] as const) {
          const held = await t.beat(availability, prior);
          expect(held.result.isError).not.toBe(true);
          expect(held.delivery).toBeUndefined();
          expect((await t.current('d79-next')).structuredContent.command.status).toBe('queued');
        }
        expect((await t.poll('ready', t.binding)).delivery).toBeUndefined(); // Desktop cannot claim it.
        const { delivery } = await t.beat();
        expect((await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
          commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene })).structuredContent.command.status).toBe('rendered');
      } finally { await t.close(); }
    });

    it.each(['manual save', 'unrelated utterance', 'begin instead of correct'] as const)(
      'refuses revision borrowing for %s and captions the active voice refusal', async path => {
        const t = await voiceFixture();
        try {
          const early = path === 'unrelated utterance' ? await t.record() : undefined;
          const claim = await t.startSurface();
          const transcript = early ?? await t.record();
          const surface = structuredClone(t.scene);
          surface.inspection.appearance.representation = 'molecular-surface';
          await t.call('complete_inspection', { ...claim, scene: surface });
          t.binding.baseInspectionRevision++;
          if (path === 'manual save') {
            surface.inspection.appearance.background = '#ffffff';
            await t.call('sync_inspection', { ...t.binding, scene: surface });
            t.binding.baseInspectionRevision++;
          }
          await t.beat();
          const utteranceId = await transcript();
          const refused = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, utteranceId,
            commandId: 'd79-refused', change: { kind: 'utterance', patch: { action: path === 'begin instead of correct' ? 'begin' : 'correct' } } });
          expect(refused.isError).toBe(true);
          expect(refused.content[0].text).toContain('changed since this utterance began');
          expect((await t.current('surface')).structuredContent.command.status).toBe('rendered');
          expect((await t.beat()).result._meta[PRIVATE_KEY].headsetCaption)
            .toMatchObject({ utteranceId, refusal: { tool: 'update_inspection' }, text: expect.stringContaining('changed since this utterance began') });
        } finally { await t.close(); }
      });
  });

  it.each(['after enqueue', 'before enqueue'] as const)(
    'renders the first correction after supersession produces unsaved work %s', async when => {
      const t = await voiceFixture();
      try {
        const claim = await t.startSurface();
        const utteranceId = await t.correct();
        if (when === 'before enqueue') await t.beat('unsaved');
        expect((await t.edit('cartoon', utteranceId)).structuredContent.command).toMatchObject({ status: 'queued', heldForPanel: true });
        t.clock.now = 2857;
        for (const availability of ['unsaved', 'busy', 'unsaved', 'ready'] as const) {
          const beat = await t.beat(availability);
          expect(beat.delivery).toBeUndefined();
          expect(beat.result._meta[PRIVATE_KEY].headsetCaption).toBeUndefined();
          expect((await t.current('cartoon')).structuredContent.command).toMatchObject({ status: 'queued' });
        }
        const late = structuredClone(t.scene); late.inspection.appearance.representation = 'molecular-surface';
        expect((await t.call('complete_inspection', { ...claim, scene: late })).structuredContent)
          .toMatchObject({ accepted: false, command: { status: 'superseded', supersededBy: utteranceId } });
        expect((await t.current()).structuredContent.inspectionRevision).toBe(1);
        expect((await t.call('complete_inspection', { ...claim, phase: 'settled' })).structuredContent.command)
          .toMatchObject({ status: 'superseded', fenceReleased: 'rolled-back' });
        const { delivery } = await t.beat();
        expect(delivery.commandId).toBe('cartoon');
        expect((await t.current('cartoon')).structuredContent.command.renderedAt).toBeUndefined();
        const rendered = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
          commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene });
        expect(rendered.structuredContent).toMatchObject({ accepted: true, inspectionRevision: 2,
          command: { status: 'rendered', renderedRevision: 2 } });
        expect((await t.current('surface')).structuredContent.command.status).toBe('superseded');
        expect((await t.current()).structuredContent.pendingCommand).toEqual([]);
      } finally { await t.close(); }
    });

  it.each(['no supersession', 'rollback finished', 'different heartbeat revision'] as const)(
    'preserves a genuine local conflict and delivers its refusal caption: %s', async cause => {
      const t = await voiceFixture();
      try {
        const claim = cause === 'no supersession' ? undefined : await t.startSurface();
        const utteranceId = claim ? await t.correct() : await t.hear();
        await t.edit('cartoon', utteranceId);
        if (cause === 'rollback finished') await t.call('complete_inspection', { ...claim, phase: 'settled' });
        const heartbeat = cause === 'different heartbeat revision'
          ? { ...t.binding, baseInspectionRevision: t.binding.baseInspectionRevision + 1 } : t.binding;
        const beat = await t.beat('unsaved', heartbeat);
        expect(beat.delivery).toBeUndefined();
        const receipt = (await t.current('cartoon')).structuredContent.command;
        expect(receipt).toMatchObject({ status: 'conflict', reason: 'The target panel has newer or unsaved local work.' });
        expect(receipt.renderedAt).toBeUndefined();
        expect((await t.current()).structuredContent.inspectionRevision).toBe(1);
        expect(beat.result._meta[PRIVATE_KEY].headsetCaption).toMatchObject({ commandId: 'cartoon', utteranceId,
          text: 'Could not apply · request refused. The target panel has newer or unsaved local work.',
          refusal: { tool: 'update_inspection', reason: 'request refused' } });
        expect((await t.beat('unsaved', heartbeat)).result._meta[PRIVATE_KEY].headsetCaption).toBeUndefined();
      } finally { await t.close(); }
    });

  it('does not borrow a pending render fence for an unrelated newer utterance', async () => {
    const t = await voiceFixture();
    try {
      await t.startSurface();
      await t.correct();
      const utteranceId = await t.hear();
      await t.edit('unrelated', utteranceId);
      const beat = await t.beat('unsaved');
      expect((await t.current('unrelated')).structuredContent.command.status).toBe('conflict');
      expect(beat.result._meta[PRIVATE_KEY].headsetCaption).toMatchObject({ commandId: 'unrelated', utteranceId });
    } finally { await t.close(); }
  });

  it('drops an older conflict caption when the wearer has already asked a new question', async () => {
    const t = await voiceFixture();
    try {
      await t.edit('old-request', await t.hear());
      await t.hear();
      const beat = await t.beat('unsaved');
      expect((await t.current('old-request')).structuredContent.command.status).toBe('conflict');
      expect(beat.result._meta[PRIVATE_KEY].headsetCaption).toBeUndefined();
    } finally { await t.close(); }
  });

  it('captions a conflict discovered by a state read after a genuine manual save', async () => {
    const t = await voiceFixture();
    try {
      const utteranceId = await t.hear();
      await t.edit('cartoon', utteranceId);
      const manual = structuredClone(t.scene); manual.inspection.appearance.background = '#192734';
      const saved = await t.call('sync_inspection', { ...t.binding, scene: manual });
      expect(saved.structuredContent.saved).toBe(true);
      const receipt = (await t.current('cartoon')).structuredContent.command;
      expect(receipt).toMatchObject({ status: 'conflict', reason: 'The saved view changed.' });
      t.binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
      expect((await t.beat()).result._meta[PRIVATE_KEY].headsetCaption).toMatchObject({ commandId: 'cartoon', utteranceId,
        text: 'Could not apply · request refused. The saved view changed.' });
      expect((await t.current()).structuredContent.view.appearance.background).toBe('#192734');
    } finally { await t.close(); }
  });

  it('keeps a second correction behind the original render until rollback completes', async () => {
    const t = await voiceFixture();
    try {
      const claim = await t.startSurface();
      await t.edit('first-correction', await t.correct());
      const utteranceId = await t.correct();
      await t.edit('second-correction', utteranceId);
      expect((await t.beat('unsaved')).delivery).toBeUndefined();
      expect((await t.current('second-correction')).structuredContent.command.status).toBe('queued');
      expect((await t.current('first-correction')).structuredContent.command.status).toBe('superseded');
      await t.call('complete_inspection', { ...claim, phase: 'settled' });
      const { delivery } = await t.beat();
      expect(delivery.commandId).toBe('second-correction');
      const rendered = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene });
      expect(rendered.structuredContent.command).toMatchObject({ status: 'rendered', renderedRevision: 2 });
    } finally { await t.close(); }
  });

  it('cannot use another panel\'s superseded render to excuse local unsaved work', async () => {
    const t = await voiceFixture();
    try {
      await t.startSurface();
      const utteranceId = await t.correct();
      const otherPanel = (await t.call('attach_inspection', { ...t.binding })).structuredContent.panelId;
      // Unrelated text work on a second panel cannot inherit the voice render's fence.
      await t.call('update_inspection', { ...update(t.binding, otherPanel, 'other-panel',
        { kind: 'appearance', patch: { representation: 'cartoon' } }) });
      await t.poll('unsaved', t.binding, otherPanel);
      expect((await t.current('other-panel')).structuredContent.command.status).toBe('conflict');
      expect((await t.current('surface')).structuredContent.command.supersededBy).toBe(utteranceId);
    } finally { await t.close(); }
  });
});

it('publishes idle renderer failure, recovery and explicit clearing without modifying the saved source',async()=>{
  const t=await setup();
  try {
    const before=(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY];
    expect(before.rendererContext).toBe(true);
    const startup={phase:'idle',pending:false,reloadRequired:false,mode:null,gestureActive:null,presenting:false};
    for(const [status,cause] of [['context_lost','context-lost'],['recovering','context-recovering'],['error','renderer-error']] as const){
      const rendererContext={status,detail:'Reopen the same inspection if recovery does not complete.',error:'Graphics context failed.'};
      const sent=await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'busy',xrStartup:{...startup,rendererContext}});
      expect(sent.isError).not.toBe(true);
      const state=(await t.current()).structuredContent;
      expect(state.panels.find((p:any)=>p.panelId===t.panelId)).toMatchObject({availability:'busy',availabilityCause:cause,current:true,xrStartup:{rendererContext,stale:false}});
      expect(state.commands).toEqual([]);expect(state.pendingCommand).toEqual([]);
      expect(state.sourceToken).toBe(t.binding.sourceToken);expect(state.inspectionRevision).toBe(t.binding.baseInspectionRevision);
    }
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',xrStartup:{...startup,rendererContext:null}});
    expect((await t.current()).structuredContent.panels.find((p:any)=>p.panelId===t.panelId)).toMatchObject({availability:'ready',availabilityCause:null,xrStartup:{rendererContext:null}});
    const after=(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY];
    expect(after.scene).toEqual(before.scene);expect(after.scene).toBeDefined();
  }finally{await t.close();}
});

it('keeps an active context-loss refusal explicit and admits a smaller pose only after recovery is ready',async()=>{
  const t=await setup();
  try{
    await t.call('update_inspection',update(t.binding,t.panelId,'gpu-loss',{kind:'placement',patch:{scale:4}}));
    const {delivery}=await t.poll();expect(delivery).toBeDefined();
    const reason='The molecular WebGL context was lost.';
    const failed=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,
      ...inspectionFailureReceipt(Object.assign(Error(reason),{code:'context_lost'}))});
    expect(failed.structuredContent.command).toMatchObject({status:'rejected',reason:'render_failed',detail:reason});
    const startup={phase:'idle',pending:false,reloadRequired:false,mode:null,gestureActive:null,presenting:false};
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'busy',xrStartup:{...startup,rendererContext:rendererContextReport({status:'context_lost',error:reason})}});
    const lost=(await t.current()).structuredContent;
    expect(lost.view.placement).toEqual(t.scene.inspection.placement);expect(lost.sourceToken).toBe(t.binding.sourceToken);
    await t.call('update_inspection',update(t.binding,t.panelId,'safe-pose',{kind:'placement',patch:{scale:.5}}));
    expect((await t.poll('busy')).delivery).toBeUndefined();
    const ready=await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',xrStartup:{...startup,rendererContext:null}});
    const next=ready._meta[PRIVATE_KEY].delivery;expect(next.commandId).toBe('safe-pose');
    const safe=structuredClone(t.scene);safe.inspection.placement.scale=.5;
    const completed=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:next.commandId,claimToken:next.claimToken,scene:safe});
    expect(completed.structuredContent.command.status).toBe('rendered');
    expect((await t.current()).structuredContent.sourceToken).toBe(t.binding.sourceToken);
  }finally{await t.close();}
});

const animationSample={id:'clip-digest',chapterId:'walk',state:'playing',timeSeconds:1,durationSeconds:10,loop:true,speed:1};
it('animation routes to the headset, commits a rendered sample and replays once',async()=>{
  const t=await setup();
  try {
    const attached=await t.call('attach_inspection',{...t.binding,surface:'companion'}),headset=attached.structuredContent.panelId;
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',animation:{...animationSample,id:'desktop'}});
    await t.call('poll_inspection',{...t.binding,panelId:headset,availability:'ready',animation:animationSample});
    expect((await t.current()).structuredContent.animation).toEqual(animationSample);
    const request={sessionId:t.sessionId,commandId:'pause-walk',change:{kind:'animation',patch:{state:'pause',speed:0.5,seekSeconds:3,loop:false}}};
    const queued=await t.call('update_inspection',request);
    expect(queued.isError).not.toBe(true);
    expect(queued.structuredContent.command).toMatchObject({panelId:headset,status:'queued',operation:{effects:['animation']}});
    expect((await t.poll()).delivery).toBeUndefined();
    const {delivery}=await t.poll('ready',t.binding,headset);
    expect(delivery.change).toEqual({...request.change,target:{id:animationSample.id,chapterId:'walk'}});
    const applied={...animationSample,state:'paused',speed:0.5,timeSeconds:3,loop:false};
    const completed=await t.call('complete_inspection',{...t.binding,panelId:headset,commandId:delivery.commandId,claimToken:delivery.claimToken,scene:t.scene,animation:applied});
    expect(completed.structuredContent.command).toMatchObject({status:'rendered',animation:applied,renderedRevision:t.binding.baseInspectionRevision+1});
    expect((await t.current()).structuredContent.animation).toEqual(applied);
    expect((await t.call('update_inspection',request)).structuredContent.command).toMatchObject({commandId:'pause-walk',status:'rendered'});
    expect((await t.current()).structuredContent.commands).toHaveLength(1);
  }finally{await t.close();}
});
it('animation reports desktop playback, clears on a static chapter and refuses controls',async()=>{
  const t=await setup();
  try {
    expect((await t.current()).structuredContent.animation).toBeNull();
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',animation:animationSample});
    expect((await t.current()).structuredContent.animation).toEqual(animationSample);
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',animation:null});
    expect((await t.current()).structuredContent.animation).toBeNull();
    const refused=await t.call('update_inspection',{sessionId:t.sessionId,change:{kind:'animation',patch:{state:'pause'}}});
    expect(refused.isError).toBe(true);expect(JSON.stringify(refused.content)).toContain('This chapter has no animation.');
    expect((await t.current()).structuredContent.commands).toHaveLength(0);
  }finally{await t.close();}
});
for(const invalid of ['missing','wrong-chapter','wrong-state','wrong-time'] as const)
it(`animation receipt refuses ${invalid} playback evidence`,async()=>{
  const t=await setup();
  try {
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',animation:animationSample});
    expect((await t.call('update_inspection',{sessionId:t.sessionId,change:{kind:'animation',patch:{state:'pause',restart:true}}})).isError).not.toBe(true);
    const {delivery}=await t.poll();
    const animation={...animationSample,state:'paused',timeSeconds:0,...(invalid==='wrong-chapter'?{chapterId:'other'}:invalid==='wrong-state'?{state:'playing'}:invalid==='wrong-time'?{timeSeconds:1}:{})};
    const result=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene:t.scene,...(invalid==='missing'?{}:{animation})});
    expect(result.structuredContent.command.status).toBe('unconfirmed');
    expect(result.structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision);
  }finally{await t.close();}
});
it('animation rejects stale revisions and seeks beyond the clip',async()=>{
  const t=await setup();
  try {
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',animation:animationSample});
    const beyond=await t.call('update_inspection',{sessionId:t.sessionId,change:{kind:'animation',patch:{seekSeconds:11}}});
    expect(beyond.isError).toBe(true);expect(JSON.stringify(beyond.content)).toContain('Choose a time within this animation.');
    const stale=await t.call('update_inspection',update({...t.binding,baseInspectionRevision:0},t.panelId,'stale-animation',{kind:'animation',patch:{state:'pause'}}));
    expect(stale.isError).toBe(true);
  }finally{await t.close();}
});

it('animation completion publishes its playback with the shared scene revision and accepts elapsed render time',async()=>{
  const t=await setup();
  try {
    const definition={version:1,durationSeconds:10,tracks:[{id:'body',chains:['A'],keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]}]}]};
    const scene={...t.scene,inspection:{...t.scene.inspection,animation:{definition,playback:animationSample}}};
    const saved=await t.call('sync_inspection',{...t.binding,scene});
    expect(saved.structuredContent.saved).toBe(true);
    const binding={...t.binding,baseInspectionRevision:saved.structuredContent.inspectionRevision};
    await t.call('poll_inspection',{...binding,panelId:t.panelId,availability:'ready',animation:animationSample});
    const request=await t.call('update_inspection',{sessionId:t.sessionId,change:{kind:'animation',patch:{state:'play',seekSeconds:3,speed:2,loop:false}}});
    expect(request.isError).not.toBe(true);
    const {delivery}=await t.poll('ready',binding);
    t.clock.now+=100;
    const rendered={...animationSample,timeSeconds:3.2,speed:2,loop:false};
    scene.inspection.animation.playback=rendered;
    const result=await t.call('complete_inspection',{...binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene,animation:rendered});
    expect(result.structuredContent.command).toMatchObject({status:'rendered',animation:rendered,renderedRevision:binding.baseInspectionRevision+1});
    const shared=await t.call('get_inspection',{sessionId:t.sessionId});
    expect(shared._meta[PRIVATE_KEY].scene.inspection.animation.playback).toEqual(rendered);
    expect((await t.current()).structuredContent.animation).toEqual(rendered);
  }finally{await t.close();}
});

// @ts-ignore Executes the production inspector receive/confirmation closures.
import { journeyNavigationHarness } from '../../lab/browser-roundtrip/fixtures/journey-navigation-harness.mjs';
import { TOURS } from '../src/tour-catalog.js';
import { readinessStripView } from '../src/inspection-readiness-strip.js';

async function tourReceiptFixture(editAfterReceipt=false, surface: 'desktop' | 'companion' = 'desktop') {
  const t = await setup(cif, {}, undefined, surface);
  let animation: any = null, localScene=t.scene;
  const receipts: any[] = [], readinessUpdates: any[] = [], boundaries: any[] = [];
  const page = journeyNavigationHarness({
    PRIVATE_KEY, panelId: t.panelId, savedScene: t.scene,
    binding: { ...t.binding, stateRevision: t.binding.baseStateRevision, inspectionRevision: t.binding.baseInspectionRevision },
    workspace: { capture: () => localScene, snapshot: () => ({ ready: true, animation }),
      applyRemote: async (change:any,admit:()=>Promise<void>,confirm:(scene:any,applied:any)=>Promise<void>)=>{
        await admit();
        await page.busyBeat(page.generation,true);
        const p=change.patch;
        animation={...animation,...(p.state?{state:p.state==='pause'?'paused':'playing'}:{}),
          ...(p.speed?{speed:p.speed}:{}),...(p.seekSeconds!==undefined?{timeSeconds:p.seekSeconds}:{}),
          ...(p.restart?{timeSeconds:0}:{})};
        await confirm(localScene,{animation});
      } },
    applyTourCommand: async (_player: any, patch: any) => {
      // Installation resolves before the production inspector captures its receipt.
      await t.call('poll_inspection', {...page.expected(), panelId:t.panelId, availability:'busy'});
      animation = patch.action === 'start' ? { ...animationSample } : null;
    },
    call: async (name: string, args: any) => {
      const result = await t.call(name, args);
      expect(result.isError).not.toBe(true);
      if (name === 'complete_inspection' && !args.phase) {
        boundaries.push({state:(await t.current(args.commandId)).structuredContent,readiness:readinessUpdates.at(-1)});
        receipts.push(result.structuredContent);
        if(editAfterReceipt) localScene={...t.scene,localEdit:true} as any;
      }
      if(result.structuredContent?.readiness) readinessUpdates.push(result.structuredContent.readiness);
      return result;
    },
    recoverConfirmation: async (error: Error) => { throw error; },
  });
  const chapter = async (action: string) => {
    const queued = await t.call('control_tour', { ...page.expected(), panelId: t.panelId,
      commandId: `receipt-${action}`, action, ...(action === 'start' ? { tourId: TOURS[0].id } : {}) });
    expect(queued.isError).not.toBe(true);
    const sent = { ...page.expected(), panelId: t.panelId, availability: 'ready' };
    const poll = await t.call('poll_inspection', sent);
    await page.receive(poll._meta[PRIVATE_KEY].delivery, sent, page.generation);
    expect(receipts.at(-1).command.status).toBe('rendered');
  };
  const control=async(patch:any)=>{
    const queued=await t.call('update_inspection',{...page.expected(),panelId:t.panelId,
      change:{kind:'animation',patch}});
    expect(queued.isError).not.toBe(true);
    const sent={...page.expected(),panelId:t.panelId,availability:'ready'};
    const poll=await t.call('poll_inspection',sent);
    await page.receive(poll._meta[PRIVATE_KEY].delivery,sent,page.generation);
  };
  return { t, page, receipts, readinessUpdates, boundaries, chapter, control };
}

const enteringStartup = { phase: 'preparing-menu', pending: true, presenting: true, reloadRequired: false,
  mode: 'immersive-vr', gestureActive: null, visible: true, sessionVisibility: 'visible', errorName: null };
const activeStartup = { ...enteringStartup, phase: 'active', pending: false };

it.each([
  { entryMs: 17000, activeBeforeReady: false }, { entryMs: 30000, activeBeforeReady: false },
  { entryMs: 17000, activeBeforeReady: true }, { entryMs: 30000, activeBeforeReady: true },
])('one start at 1552 ms renders after $entryMs ms entry (early active: $activeBeforeReady)', async ({ entryMs, activeBeforeReady }) => {
  const { t, page, receipts } = await tourReceiptFixture(false, 'companion');
  const beat = (availability: string, xrStartup: any) => t.call('poll_inspection',
    { ...page.expected(), panelId: t.panelId, availability, xrStartup });
  try {
    t.clock.now = 1552;
    await beat('busy', enteringStartup);
    const queued = await t.call('control_tour', { ...page.expected(), panelId: t.panelId,
      commandId: 'entry-start', action: 'start', tourId: TOURS[0].id });
    expect(queued.structuredContent.command).toMatchObject({ status: 'queued', heldForPanel: true });
    // Neither early readiness during entry nor active XR with a busy scene is enough.
    expect((await beat('ready', enteringStartup))._meta?.[PRIVATE_KEY]?.delivery).toBeUndefined();
    for (t.clock.now = 2000; t.clock.now < entryMs; t.clock.now += 1000) {
      expect((await beat('busy', activeBeforeReady ? activeStartup : enteringStartup))._meta?.[PRIVATE_KEY]?.delivery).toBeUndefined();
      expect((await t.current('entry-start')).structuredContent.command.status).toBe('queued');
    }
    t.clock.now = entryMs;
    const delivered = await beat('ready', activeStartup);
    const delivery = delivered._meta[PRIVATE_KEY].delivery;
    expect(delivery).toMatchObject({ commandId: 'entry-start', settleBudgetMs: 15000 });
    expect((await t.current('entry-start')).structuredContent.command.status).toBe('rendering');
    await page.receive(delivery, { ...page.expected(), panelId: t.panelId, availability: 'ready' }, page.generation);
    expect(receipts.at(-1).command).toMatchObject({ status: 'rendered', heldForPanel: true,
      acceptedAt: 1552, renderedAt: entryMs, renderedRevision: t.binding.baseInspectionRevision + 1 });
    expect((await t.current()).structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision + 1);
  } finally { await t.close(); }
});

it.each(['failed', 'cancelled', 'closed', 'timeout', 'silent', 'ordinary'])(
  'entry delivery ends promptly for %s without a false render receipt', async outcome => {
    const t = await setup(cif, {}, undefined, 'companion');
    const beat = (xrStartup: any) => t.call('poll_inspection', { ...t.binding, panelId: t.panelId, availability: 'busy', xrStartup });
    try {
      await beat(outcome === 'ordinary' ? activeStartup : enteringStartup);
      const queued = await t.call('control_tour', { ...t.binding, panelId: t.panelId,
        commandId: 'entry-end', action: 'start', tourId: TOURS[0].id });
      expect(queued.structuredContent.command.status).toBe('queued');
      if (outcome === 'failed' || outcome === 'cancelled') {
        t.clock.now = 2000;
        await beat({ ...activeStartup, phase: 'idle', presenting: false,
          errorName: outcome === 'failed' ? 'NotAllowedError' : null });
      } else if (outcome === 'closed') {
        t.clock.now = 2000;
        await t.call('detach_inspection', { ...t.binding, panelId: t.panelId });
      } else {
        const limit = outcome === 'ordinary' ? 15000 : 45000;
        for (t.clock.now = 1000; t.clock.now < limit; t.clock.now += 1000) {
          if (outcome !== 'silent') await beat(outcome === 'ordinary' ? activeStartup : enteringStartup);
          expect((await t.current('entry-end')).structuredContent.command.status).toBe('queued');
        }
      }
      const receipt = (await t.current('entry-end')).structuredContent.command;
      expect(receipt).toMatchObject(outcome === 'closed' ? { status: 'conflict', reason: 'The targeted panel detached.' }
        : outcome === 'ordinary' ? { status: 'expired', reason: 'panel_hold_expired' }
        : outcome === 'failed' || outcome === 'cancelled' ? { status: 'rejected', reason: 'panel_entry_failed' }
        : { status: 'expired', reason: 'panel_entry_timeout' });
      expect(receipt.renderedAt).toBeUndefined();
      expect((await t.current()).structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision);
      expect((await beat(activeStartup))._meta?.[PRIVATE_KEY]?.delivery).toBeUndefined();
    } finally { await t.close(); }
  });

it('tour receipt publishes installed animation before an immediate control and clears it on the static chapter', async () => {
  const { t, page, chapter } = await tourReceiptFixture();
  try {
    await chapter('start');
    expect((await t.current()).structuredContent.animation).toEqual(animationSample);
    const control = await t.call('update_inspection', { ...page.expected(), panelId: t.panelId,
      commandId: 'immediate-pause', change: { kind: 'animation', patch: { state: 'pause' } } });
    expect(control.isError).not.toBe(true);
    const sent = { ...page.expected(), panelId: t.panelId, availability: 'ready' };
    const poll = await t.call('poll_inspection', sent), delivery = poll._meta[PRIVATE_KEY].delivery;
    const completed = await t.call('complete_inspection', { ...page.expected(), panelId: t.panelId,
      commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene,
      animation: { ...animationSample, state: 'paused' } });
    expect(completed.structuredContent.command.status).toBe('rendered');
    page.binding = { ...page.binding, ...completed.structuredContent };
    await chapter('next');
    expect((await t.current()).structuredContent.animation).toBeNull();
    const refused = await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'animation', patch: { state: 'play' } } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('This chapter has no animation.');
  } finally { await t.close(); }
});

it.each(['start','next','back'])('desktop %s receipt is ready at publication, before receive returns', async action => {
  const { t, receipts, boundaries, chapter } = await tourReceiptFixture();
  try {
    await chapter(action);
    const {state,readiness}=boundaries.at(-1);
    expect(state.command).toMatchObject({status:'rendered',renderedRevision:state.inspectionRevision});
    expect(state.panels.find((panel:any)=>panel.panelId===state.command.panelId)).toMatchObject({availability:'ready',current:true});
    expect(state.modelContext.readiness.blocking).not.toContain('structure');
    expect(receipts.at(-1).readiness.items.find((item:any)=>item.capability==='structure').state).toBe('ok');
    expect(readinessStripView(readiness).rows.find(row=>row.id==='lesson')?.headline).toBe('Structure ready');
  } finally { await t.close(); }
});


it('the post-command heartbeat preserves unsaved local work instead of forcing the strip ready', async()=>{
  const {t,page,readinessUpdates,chapter}=await tourReceiptFixture(true);
  try {
    await chapter('next');
    expect(page.dirty).toBe(true);
    expect(readinessUpdates.at(-1).items.find((item:any)=>item.capability==='structure').state).toBe('missing');
  } finally {await t.close();}
});


it.each([{state:'pause'},{state:'play'},{speed:0.5},{seekSeconds:3},{restart:true}])(
  'desktop animation %j publishes ready state and strip before its rendered receipt',async patch=>{
    const {t,chapter,control,boundaries}=await tourReceiptFixture();
    try {
      await chapter('start');await control(patch);
      const {state,readiness}=boundaries.at(-1);
      expect(state.command).toMatchObject({status:'rendered',renderedRevision:state.inspectionRevision});
      expect(state.panels.find((p:any)=>p.panelId===state.command.panelId)).toMatchObject({availability:'ready',current:true});
      expect(state.modelContext.readiness.blocking).not.toContain('structure');
      expect(readinessStripView(readiness).rows.find(row=>row.id==='lesson')?.headline).toBe('Structure ready');
    } finally {await t.close();}
  });

it('desktop completion drains a delayed busy beat and keeps only ready beats until the receipt returns',async()=>{
  const {t,page,chapter,receipts,boundaries}=await tourReceiptFixture();
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
  const busyStarted=deferred(),releaseBusy=deferred(),completionStarted=deferred(),releaseCompletion=deferred();
  const calls:string[]=[],call=page.call;
  page.call=async(name:string,args:any)=>{
    calls.push(`${name}:${args.phase??args.availability??'complete'}`);
    if(name==='poll_inspection' && args.availability==='busy') {busyStarted.resolve();await releaseBusy.promise;}
    const result=await call(name,args);
    if(name==='complete_inspection' && !args.phase) {completionStarted.resolve();await releaseCompletion.promise;}
    return result;
  };
  page.applyTourCommand=async()=>{void page.busyBeat(page.generation,true);};
  const running=chapter('next');
  try {
    await busyStarted.promise;
    expect(receipts).toHaveLength(0);
    expect(calls).not.toContain('poll_inspection:ready');
    releaseBusy.resolve();await completionStarted.promise;
    const count=calls.length;
    await page.busyBeat(page.generation,true);
    expect(calls.slice(count)).toEqual(['get_inspection_state:complete','poll_inspection:ready']);
    expect(boundaries.at(-1).state.modelContext.readiness.blocking).not.toContain('structure');
    expect(readinessStripView(boundaries.at(-1).readiness).summary).not.toContain('Structure not ready');
    releaseCompletion.resolve();await running;
  } finally {releaseBusy.resolve();releaseCompletion.resolve();await running;await t.close();}
});


it('desktop readiness failure keeps the command unrendered and releases the heartbeat hold',async()=>{
  const {t,page,chapter,receipts}=await tourReceiptFixture();
  const call=page.call;
  page.call=async(name:string,args:any)=>{
    if(name==='poll_inspection' && args.availability==='ready') throw Error('Readiness transport failed');
    return call(name,args);
  };
  try {
    await expect(chapter('next')).rejects.toThrow('Readiness transport failed');
    expect(receipts).toHaveLength(0);
    expect(page.desktopReceiptInFlight).toBe(false);
    expect(page.pendingReceipt.commandId).toBe('receipt-next');
    expect((await t.current('receipt-next')).structuredContent.command.status).toBe('rendering');
  } finally {await t.close();}
});

it('leaves companion completion and its post-command availability report unchanged',async()=>{
  const {t,page,chapter,boundaries}=await tourReceiptFixture();
  page.isCompanion=true;
  page.workspace.viewer={};
  page.xrStartupReport=()=>({phase:'idle',pending:false,reloadRequired:false,mode:null,gestureActive:null,presenting:false});
  try {
    await chapter('next');
    expect(boundaries.at(-1).state.command.status).toBe('rendered');
    expect(boundaries.at(-1).state.panels[0].availability).toBe('busy');
    expect((await t.current()).structuredContent.panels[0].availability).toBe('ready');
  } finally {await t.close();}
});


it('keeps a desktop live and claims the next command through a 20-second receipt response delay',async()=>{
  const {t,page,chapter,boundaries}=await tourReceiptFixture();
  let release!:()=>void, started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}), committed=new Promise<void>(resolve=>{started=resolve;});
  const call=page.call, beats:any[]=[];
  page.call=async(name:string,args:any)=>{
    if(name==='poll_inspection') beats.push(args);
    const result=await call(name,args);
    if(name==='complete_inspection' && !args.phase && args.commandId==='receipt-next') {started();await held;}
    return result;
  };
  const running=chapter('next');page.rendering=running;
  try {
    await committed;
    const state=boundaries.at(-1).state;
    expect(state.panels.find((p:any)=>p.panelId===t.panelId)).toMatchObject({availability:'ready',current:true});
    expect(state.modelContext.readiness.blocking).not.toContain('structure');
    const queued=await t.call('control_tour',{...page.expected(),baseInspectionRevision:state.inspectionRevision,
      panelId:t.panelId,commandId:'after-delayed-receipt',action:'next'});
    expect(queued.isError).not.toBe(true);
    const observations:any[]=[];
    for(t.clock.now=1000;t.clock.now<=20000;t.clock.now+=1000) {
      // Even forced busy and changed local flags must not overwrite the receipt.
      page.dirty=true;page.blocked=true;
      await page.busyBeat(page.generation,true);
      observations.push((await t.current('after-delayed-receipt')).structuredContent);
    }
    expect(observations.at(-1).command.status).toBe('rendering');
    for(const live of observations)
      expect(live.panels.find((p:any)=>p.panelId===t.panelId)).toMatchObject({availability:'ready',current:true});
    expect(beats.at(-1)).toMatchObject({availability:'ready',baseInspectionRevision:state.inspectionRevision});
    page.dirty=false;page.blocked=false;
    release();await running;await page.rendering;
    expect((await t.current('after-delayed-receipt')).structuredContent.command.status).toBe('rendered');
  } finally {release();await running;await page.rendering;await t.close();}
});

it('registers comparison bytes claimed by a named capture retry before receiving the delivery',async()=>{
  const t=await setup(cif,{fetchPdbText:async()=>cif});
  let scene:any=structuredClone(t.scene), loseResponse=true;
  const namedViews:any[]=[], failures:string[]=[];
  // Execute the viewer's comparison lookup; substitute only its GPU operations.
  const viewerSource=readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs',import.meta.url),'utf8');
  const start=viewerSource.indexOf('  async function restoreCompanion(');
  const renderer:any=vm.createContext({Error,comparisonSources:new Map(),companionRecord:undefined,candidateRecords:new Set(),
    retiredComparisons:new Set(),detached:structuredClone,comparisonGeometry:()=>{},paintCompanion:async()=>{},
    applyInspectionTransform:()=>{},canvas:{xr:{isPresenting:{value:false}}},
    plugin:{state:{data:{updateCellState:()=>{}}}},
    checkedFixture:async(source:any)=>{expect(source.cif).toBeTruthy();return {source,settings:{}};},
    buildCandidate:async()=>({representation:{ref:'comparison'}}),deleteRecord:async()=>{},
    inspectionState:{checkpoint:()=>scene}});
  vm.runInContext(viewerSource.slice(start,viewerSource.indexOf('\n  }',start)+4),renderer);
  const registerStart=viewerSource.indexOf('    registerComparisonSources: sources => {');
  vm.runInContext('globalThis.register = '+viewerSource.slice(registerStart+'    registerComparisonSources: '.length,
    viewerSource.indexOf('\n    },',registerStart)+6),renderer);
  const page=journeyNavigationHarness({PRIVATE_KEY,panelId:t.panelId,savedScene:scene,
    binding:{...t.binding,stateRevision:t.binding.baseStateRevision,inspectionRevision:t.binding.baseInspectionRevision},
    hydrateComparisonSource,decodeInspectionCatalog,verifyInspectionCatalogSource,
    noteNamedViews:(views:any)=>namedViews.push(views),
    workspace:{capture:()=>scene,snapshot:()=>({ready:true}),registerComparisonSources:renderer.register,
      captureNamedView:async(admit:any,confirm:any)=>{await admit();await confirm(scene);},
      applyRemote:async(change:any,admit:any,confirm:any)=>{
        await admit();const next=expectedInspection(scene,change);
        try {await renderer.restoreCompanion(next.inspection.companionStructure);}
        catch(error) {failures.push((error as Error).message);throw error;}
        scene=next;await confirm(scene);
      }},
    call:async(name:string,args:any)=>{
      const result=await t.call(name,args);expect(result.isError).not.toBe(true);
      if(name==='complete_inspection'&&!args.phase&&args.commandId==='capture-retry'&&loseResponse) {
        loseResponse=false;throw Error('Capture response lost');
      }
      return result;
    },
    recoverConfirmation:async()=>{},showProblem:(message:string)=>failures.push(message),
  });
  try {
    await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,action:'save',name:'Comparison baseline',commandId:'capture-retry'});
    const sent={...page.expected(),panelId:t.panelId,availability:'ready'};
    page.rendering=page.receive((await t.poll()).delivery,sent,page.generation);await page.rendering;
    expect(page.pendingReceipt.commandId).toBe('capture-retry');
    expect((await t.current('capture-retry')).structuredContent.command.status).toBe('rendered');
    const queued=await t.call('replace_inspection_source',{...t.binding,panelId:t.panelId,mode:'compare',pdbId:'2HHB',commandId:'comparison-after-capture'});
    expect(queued.isError).not.toBe(true);
    page.rendering=page.rendering.then(()=>page.confirmReceipt(page.pendingReceipt));
    await page.rendering;await page.rendering;
    expect(failures).toEqual([]);
    const result=(await t.current('comparison-after-capture')).structuredContent.command;
    expect(result.status,JSON.stringify(result)).toBe('rendered');
    expect(renderer.comparisonSources.size).toBe(1);
    expect(namedViews.at(-1).entries).toContainEqual(expect.objectContaining({name:'Comparison baseline'}));
  } finally {await t.close();}
});


it('drains a delayed ready heartbeat before reporting an edit after confirmation',async()=>{
  const {t,page,chapter}=await tourReceiptFixture(true);
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
  const committed=deferred(),releaseReceipt=deferred(),beatStarted=deferred(),releaseBeat=deferred();
  const call=page.call, availability:string[]=[];
  let delayBeat=false;
  page.call=async(name:string,args:any)=>{
    if(name==='poll_inspection') {
      if(delayBeat && args.availability==='ready') {beatStarted.resolve();await releaseBeat.promise;}
      availability.push(args.availability);
    }
    const result=await call(name,args);
    if(name==='complete_inspection'&&!args.phase) {committed.resolve();await releaseReceipt.promise;}
    return result;
  };
  const running=chapter('next');
  let heartbeat=Promise.resolve();
  try {
    await committed.promise;delayBeat=true;
    heartbeat=page.busyBeat(page.generation,true);await beatStarted.promise;
    releaseReceipt.resolve();
    // Let the receipt continuation reach its drain without releasing the beat.
    await new Promise(resolve=>setImmediate(resolve));
    expect(page.desktopReceiptInFlight).toBe(true);
    expect(page.pendingReceipt).toBeDefined();
    expect(availability).not.toContain('unsaved');
    releaseBeat.resolve();await heartbeat;await running;
    expect(availability.slice(-2)).toEqual(['ready','unsaved']);
    expect((await t.current()).structuredContent.panels[0].availability).toBe('unsaved');
  } finally {releaseReceipt.resolve();releaseBeat.resolve();await heartbeat;await running;await t.close();}
});

it.each(['animation','placement'])('%s receipt owns its controls, not a re-derived lesson emphasis', async kind => {
  const t=await setup();
  try {
    const scene:any=structuredClone(t.scene);
    scene.inspection.emphasis={parts:[{id:'body',chain:'A',label:'Body',color:'#ff0000'}],focus:['body'],contextOpacity:.1,origin:'lesson'};
    const saved=await t.call('sync_inspection',{...t.binding,scene});
    const binding={...t.binding,baseInspectionRevision:saved.structuredContent.inspectionRevision};
    await t.call('poll_inspection',{...binding,panelId:t.panelId,availability:'ready',animation:animationSample});
    const change=kind==='animation'?{kind,patch:{state:'play'}}:{kind,patch:{scale:2}};
    await t.call('update_inspection',{sessionId:t.sessionId,change});
    const {delivery}=await t.poll('ready',binding);
    scene.inspection.emphasis={...scene.inspection.emphasis,focus:[],origin:'resting'};
    if(kind==='placement') scene.inspection.placement.scale=2;
    const result=await t.call('complete_inspection',{...binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene,animation:animationSample});
    expect(result.structuredContent.command.status).toBe('rendered');
    const shared=(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY];
    expect(shared.scene.inspection.emphasis).toEqual(scene.inspection.emphasis);
  }finally{await t.close();}
});

it.each(['animation','placement'])('%s still rejects missing requested effect even if the lesson key changed',async kind=>{
  const t=await setup();
  try {
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',animation:animationSample});
    await t.call('update_inspection',{sessionId:t.sessionId,change:kind==='animation'?{kind,patch:{state:'pause'}}:{kind,patch:{scale:2}}});
    const {delivery}=await t.poll();
    const scene:any=structuredClone(t.scene);
    scene.inspection.emphasis={parts:[],focus:[],contextOpacity:.1,origin:'resting'};
    const result=await t.call('complete_inspection',{...t.binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,scene,animation:animationSample});
    expect(result.structuredContent.command.status).toBe('unconfirmed');
  }finally{await t.close();}
});
