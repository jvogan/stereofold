import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, expectedInspection, matchesInspectionChange } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

/**
 * `emphasis` saves the scene wearing a lesson's colour key, so
 * a framing command can be judged against a molecule that is already faded.
 */
async function setup(emphasis?: Record<string, unknown>, structureText = cif) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold focus test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText })).structuredContent.sessionId as string;
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
      ...(emphasis ? { emphasis } : {}),
    },
  };
  const opened = { sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision };
  const saved = (await call('sync_inspection', { ...opened, scene })).structuredContent;
  const binding = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  const claim = async () => (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  return { call, rows, scene, binding, panelId, claim, sessionId, catalog: privateData.catalog,
    close: async () => { await client.close(); await server.close(); } };
}

describe('bringing one region into view from a tool call', () => {
  it('retains gap counts in the rendered receipt and accepts the following edit', async () => {
    // Remove residue 2's atoms while retaining its declared polymer sequence.
    const gapped = cif.split('\n').filter(line => !line.startsWith('ATOM ') || line.trim().split(/\s+/)[8] !== '2').join('\n');
    const t = await setup(undefined, gapped);
    try {
      expect(t.rows.filter(row => row.coordinateState !== 'resolved')).toHaveLength(1);
      const queued = await t.call('focus_selection', { sessionId: t.sessionId, commandId: 'chain-with-gap', residues: { labelChain: 'A' } });
      expect(queued.isError).not.toBe(true);
      const counts = { residueCount: 46, modelledResidueCount: 45, missingCoordinateCount: 1 };
      expect(queued.structuredContent.command.focus).toEqual(counts);
      const delivery = await t.claim();
      const framed = expectedInspection(t.scene as any, delivery.change);
      expect(framed.selectionKeys).toHaveLength(46);
      const completed = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: framed });
      expect(completed.structuredContent.command).toMatchObject({ status: 'rendered', focus: counts });
      const read = await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: delivery.commandId });
      expect(read.structuredContent.command.focus).toEqual(counts);
      const nextBinding = { ...t.binding, baseInspectionRevision: completed.structuredContent.inspectionRevision };
      const next = await t.call('update_inspection', { sessionId: t.sessionId, commandId: 'after-gap-focus',
        change: { kind: 'appearance', patch: { opacity: .6 } } });
      expect(next.isError).not.toBe(true);
      const following = (await t.call('poll_inspection', { ...nextBinding, panelId: t.panelId, availability: 'ready' }))._meta[PRIVATE_KEY].delivery;
      const answer = await t.call('complete_inspection', { ...nextBinding, panelId: t.panelId,
        commandId: following.commandId, claimToken: following.claimToken, scene: expectedInspection(framed, following.change) });
      expect(answer.structuredContent.command.status).toBe('rendered');
    } finally { await t.close(); }
  });

  it('retains a typed all-gap refusal and lets the following edit render', async () => {
    const gapped = cif.split('\n').filter(line => !line.startsWith('ATOM ') || line.trim().split(/\s+/)[8] !== '2').join('\n');
    const t = await setup(undefined, gapped);
    try {
      await t.call('focus_selection', { sessionId: t.sessionId, commandId: 'only-gap',
        residues: { labelChain: 'A', labelSequenceRange: [2, 2] } });
      const delivery = await t.claim();
      const rejected = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, ...inspectionFailureReceipt(Object.assign(
          Error('None of the requested residues has modelled coordinates.'), { code: 'missing_coordinates' })) });
      expect(rejected.isError, JSON.stringify(rejected.content)).not.toBe(true);
      expect(rejected.structuredContent.command).toMatchObject({ status: 'rejected', reason: 'missing_coordinates',
        focus: { residueCount: 1, modelledResidueCount: 0, missingCoordinateCount: 1 } });
      expect(rejected.structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision);
      const next = await t.call('update_inspection', { sessionId: t.sessionId, commandId: 'after-gap-refusal',
        change: { kind: 'appearance', patch: { opacity: .6 } } });
      expect(next.isError).not.toBe(true);
      const following = await t.claim();
      const answer = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: following.commandId, claimToken: following.claimToken, scene: expectedInspection(t.scene as any, following.change) });
      expect(answer.structuredContent.command.status).toBe('rendered');
    } finally { await t.close(); }
  });

  it('resolves a residue range into a whole region and queues one framing command', async () => {
    const t = await setup();
    try {
      const queued = await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-range',
        residues: { authorChain: 'A', authorResidueRange: [22, 26] }, framing: 'fill' });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.focus).toEqual({ framing: 'fill', residueCount: 5 });
      // No coordinate, distance or pose reaches the caller.
      const text = JSON.stringify({ content: queued.content, structuredContent: queued.structuredContent });
      expect(text).not.toMatch(/translation|camera|position|metre/i);

      const delivery = await t.claim();
      expect(delivery.change.kind).toBe('focus');
      expect(delivery.change.patch.framing).toBe('fill');
      expect(delivery.change.patch.selectionKeys).toHaveLength(5);
      // Exactly the rows the same query would page out of get_inspection_state.
      const page = await t.call('get_inspection_state', { sessionId: t.sessionId,
        residues: { authorChain: 'A', authorResidueRange: [22, 26] } });
      expect(delivery.change.patch.selectionKeys).toEqual(page.structuredContent.residues.rows.map((row: any) => row.key));
    } finally { await t.close(); }
  });

  it('accepts the panel’s own framing but not its own idea of the region', async () => {
    const t = await setup();
    try {
      await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-accept',
        residues: { authorChain: 'A', authorResidueRange: [1, 3] } });
      const delivery = await t.claim();
      const change = delivery.change;
      const expected = expectedInspection(t.scene as any, change);
      // What a headset panel returns: the same region, moved and rescaled to
      // frame it, with the camera the renderer settled on.
      const framed = structuredClone(t.scene) as any;
      framed.selectionKeys = [...change.patch.selectionKeys].reverse();
      framed.inspection.placement = { translation: [0.4, 1.8, -1.2], rotation: [0, 0, 0], scale: 2.5 };
      framed.camera = { ...framed.camera, position: [0, 4, 60], radius: 31 };
      expect(matchesInspectionChange(framed, expected, change)).toBe(true);

      // Appearance is not the panel's to change under a focus.
      const recoloured = structuredClone(framed);
      recoloured.inspection.appearance.background = '#123456';
      expect(matchesInspectionChange(recoloured, expected, change)).toBe(false);
      // Neither is the region.
      const shortened = structuredClone(framed);
      shortened.selectionKeys = shortened.selectionKeys.slice(1);
      expect(matchesInspectionChange(shortened, expected, change)).toBe(false);

      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: framed });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'rendered' });
    } finally { await t.close(); }
  });

  it('falls back to what is already selected and refuses a region that names nothing', async () => {
    const t = await setup();
    try {
      const current = await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-current' });
      expect(current.structuredContent.focus).toEqual({ framing: 'context', residueCount: 1 });
      expect((await t.claim()).change.patch.selectionKeys).toEqual(t.scene.selectionKeys);

      const missing = await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-missing',
        residues: { authorChain: 'Z' } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toMatch(/No residue in the saved model matches/);

      const both = await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-both',
        selectionKeys: [t.rows[0].key], residues: { authorChain: 'A' } });
      expect(both.isError).toBe(true);
      const empty = await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-empty', residues: {} });
      expect(empty.isError).toBe(true);
    } finally { await t.close(); }
  });

  /**
   * The receipt for "show me the guide RNA" during a lesson.
   *
   * With the CRISPR lesson parked on "RECAP: REC", a focus over the guide RNA
   * came back `unconfirmed` — the panel had lifted the
   * chapter's fade off the region it was framing, exactly as it must, and the
   * one field that differed from the enqueued scene was
   * `inspection.emphasis.focus`: `["rec"]` expected, `["guide"]` returned. The
   * wearer was looking at the guide RNA while the host told the agent nothing
   * had been drawn.
   */
  it('confirms a framing that lifted the lesson fade off its region, and never one that left it faded', async () => {
    const key = {
      parts: [
        { id: 'head', label: 'N-terminal arm', color: '#ff8a1f', chain: 'A', residues: { from: 1, to: 10 } },
        { id: 'tail', label: 'C-terminal tail', color: '#5f35c4', chain: 'A', residues: { from: 20, to: 46 } },
      ],
      focus: ['tail'], contextOpacity: 0.35,
    };
    const t = await setup(key);
    try {
      await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-lift',
        residues: { authorChain: 'A', authorResidueRange: [1, 3] }, framing: 'fill' });
      const delivery = await t.claim();
      const change = delivery.change;
      const expected = expectedInspection(t.scene as any, change);
      // What the headset returns: the region framed, and the chapter's own key
      // still on the molecule with the framed part now the lit one.
      const framed = structuredClone(t.scene) as any;
      framed.selectionKeys = [...change.patch.selectionKeys];
      framed.inspection.placement = { translation: [0.4, 1.8, -1.2], rotation: [0, 0, 0], scale: 2.5 };
      framed.camera = { ...framed.camera, position: [0, 4, 60], radius: 31 };
      framed.inspection.emphasis = { ...key, focus: ['head'] };
      expect(matchesInspectionChange(framed, expected, change, t.catalog)).toBe(true);
      // The other honest lift: the whole key at full strength, nothing faded.
      const unfaded = structuredClone(framed);
      unfaded.inspection.emphasis = { ...key, focus: [] };
      expect(matchesInspectionChange(unfaded, expected, change, t.catalog)).toBe(true);

      // The failure this rule exists to catch: the region came back inside the
      // fade, so the wearer is looking at a ghost of what they asked for.
      const ghost = structuredClone(framed);
      ghost.inspection.emphasis = structuredClone(key);
      expect(matchesInspectionChange(ghost, expected, change, t.catalog)).toBe(false);
      // Lighting some other part is not lighting this one.
      const elsewhere = structuredClone(framed);
      elsewhere.inspection.emphasis = { ...key, focus: ['tail'] };
      expect(matchesInspectionChange(elsewhere, expected, change, t.catalog)).toBe(false);
      // A lift may not repaint the lesson, deepen its fade, or drop its key.
      for (const dishonest of [
        { ...key, focus: ['head'], parts: [{ ...key.parts[0], color: '#00ff00' }, key.parts[1]] },
        { ...key, focus: ['head'], contextOpacity: 0.02 },
        { parts: [], focus: [], contextOpacity: 0.35 },
      ]) {
        const repainted = structuredClone(framed);
        repainted.inspection.emphasis = dishonest;
        expect(matchesInspectionChange(repainted, expected, change, t.catalog)).toBe(false);
      }
      // Without a catalog the host cannot read a returned scene, so the older
      // exact comparison stands rather than a guess.
      expect(matchesInspectionChange(framed, expected, change)).toBe(false);

      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: framed });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'rendered' });
      // The lifted key is what the session now holds, so the next command is
      // judged against the picture the wearer is actually looking at.
      expect((await t.call('get_inspection_state', { sessionId: t.sessionId }))
        .structuredContent.view.emphasis.focus).toEqual(['head']);
    } finally { await t.close(); }
  });

  it('leaves a plain structure’s framing judged exactly as before', async () => {
    const t = await setup();
    try {
      await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-plain',
        residues: { authorChain: 'A', authorResidueRange: [1, 3] } });
      const delivery = await t.claim();
      const expected = expectedInspection(t.scene as any, delivery.change);
      const framed = structuredClone(t.scene) as any;
      framed.selectionKeys = [...delivery.change.patch.selectionKeys];
      expect(matchesInspectionChange(framed, expected, delivery.change, t.catalog)).toBe(true);
      // A panel that painted a colour key nobody asked for is not a framing.
      const invented = structuredClone(framed);
      invented.inspection.emphasis = { parts: [{ id: 'head', label: 'Head', color: '#ff8a1f', chain: 'A' }],
        focus: ['head'], contextOpacity: 0.35 };
      expect(matchesInspectionChange(invented, expected, delivery.change, t.catalog)).toBe(false);
    } finally { await t.close(); }
  });

  it('gives the model no way to send a pose, under this tool or update_inspection', async () => {
    const t = await setup();
    try {
      const posed = await t.call('focus_selection', { ...t.binding, panelId: t.panelId, commandId: 'focus-pose',
        residues: { authorChain: 'A' }, camera: t.scene.camera });
      expect(posed.isError).toBe(true);
      const smuggled = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'focus-union',
        change: { kind: 'focus', patch: { selectionKeys: [t.rows[0].key], framing: 'fill' } } });
      expect(smuggled.isError).toBe(true);
    } finally { await t.close(); }
  });
});

describe('presentation motion from a tool call', () => {
  it('queues a spin that saves nothing and a stop whose baked placement is the panel’s answer', async () => {
    const t = await setup();
    try {
      const spin = { kind: 'motion', patch: { state: 'spin' } } as const;
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'spin-1', change: spin });
      expect(queued.isError).not.toBe(true);
      const delivery = await t.claim();
      expect(delivery.change).toEqual(spin);
      // Starting the turntable changes nothing that is saved.
      const expected = expectedInspection(t.scene as any, spin);
      expect(expected).toEqual(t.scene);
      expect(matchesInspectionChange(t.scene as any, expected, spin)).toBe(true);
      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'rendered' });

      // A stop bakes the shown angle into the placement rotation, exactly as
      // the wearer's own pause does, and that is the panel's to report.
      const stop = { kind: 'motion', patch: { state: 'stop' } } as const;
      const settled = expectedInspection(t.scene as any, stop);
      const baked = structuredClone(t.scene) as any;
      baked.inspection.placement.rotation = [0, 137.5, 0];
      expect(matchesInspectionChange(baked, settled, stop)).toBe(true);
      // Nothing else may ride along with a stop.
      const recoloured = structuredClone(baked);
      recoloured.inspection.appearance.background = '#123456';
      expect(matchesInspectionChange(recoloured, settled, stop)).toBe(false);
      const reselected = structuredClone(baked);
      reselected.selectionKeys = [];
      expect(matchesInspectionChange(reselected, settled, stop)).toBe(false);
    } finally { await t.close(); }
  });

  it('accepts only spin or stop', async () => {
    const t = await setup();
    try {
      const fast = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'spin-fast',
        change: { kind: 'motion', patch: { state: 'fast' } } });
      expect(fast.isError).toBe(true);
      const extra = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'spin-extra',
        change: { kind: 'motion', patch: { state: 'spin', degreesPerSecond: 90 } } });
      expect(extra.isError).toBe(true);
    } finally { await t.close(); }
  });
});

/**
 * A wearer looking at a coarse molecular surface has to be able to force the
 * render quality higher. This is the agent's half of that answer; the menu
 * setting is the other half.
 */
describe('render quality from a tool call', () => {
  it('queues a level that changes nothing saved and leaves the camera bound to the renderer', async () => {
    const t = await setup();
    try {
      const best = { kind: 'render-quality', patch: { level: 'best' } } as const;
      const queued = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'quality-1', change: best });
      expect(queued.isError).not.toBe(true);
      const delivery = await t.claim();
      expect(delivery.change).toEqual(best);
      // A render budget is not a scene value. Nothing that is saved moves.
      const expected = expectedInspection(t.scene as any, best);
      expect(expected).toEqual(t.scene);
      expect(matchesInspectionChange(t.scene as any, expected, best)).toBe(true);
      // Rebuilding the representation may move the bound Mol* computes from
      // committed geometry, exactly as it may for an appearance change.
      const rebuilt = structuredClone(t.scene) as any;
      rebuilt.camera.radiusMax = rebuilt.camera.radiusMax + 3;
      expect(matchesInspectionChange(rebuilt, expected, best)).toBe(true);
      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: t.scene });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'rendered' });

      // Nothing else may ride along with a level.
      const recoloured = structuredClone(t.scene) as any;
      recoloured.inspection.appearance.background = '#123456';
      expect(matchesInspectionChange(recoloured, expected, best)).toBe(false);
      const moved = structuredClone(t.scene) as any;
      moved.inspection.placement.rotation = [0, 30, 0];
      expect(matchesInspectionChange(moved, expected, best)).toBe(false);
      const reselected = structuredClone(t.scene) as any;
      reselected.selectionKeys = [];
      expect(matchesInspectionChange(reselected, expected, best)).toBe(false);
    } finally { await t.close(); }
  });

  it('accepts only the three named levels, and nothing beside them', async () => {
    const t = await setup();
    try {
      for (const [commandId, patch] of [['quality-number', { level: 3 }], ['quality-word', { level: 'ultra' }],
        ['quality-extra', { level: 'best', scale: 1.4 }], ['quality-empty', {}]] as const) {
        const refused = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId, change: { kind: 'render-quality', patch } });
        expect(refused.isError).toBe(true);
      }
    } finally { await t.close(); }
    // Each accepted level on its own panel: one queued command per binding is
    // what `update_inspection` allows, and the point here is the schema.
    for (const level of ['fast', 'balanced', 'best'] as const) {
      const panel = await setup();
      try {
        const accepted = await panel.call('update_inspection', { ...panel.binding, panelId: panel.panelId,
          commandId: `quality-${level}`, change: { kind: 'render-quality', patch: { level } } });
        expect(accepted.isError).not.toBe(true);
        expect((await panel.claim()).change).toEqual({ kind: 'render-quality', patch: { level } });
      } finally { await panel.close(); }
    }
  });
});
