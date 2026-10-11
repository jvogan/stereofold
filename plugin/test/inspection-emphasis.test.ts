import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, expectedInspection, inspectionChangeSchema,
  matchesInspectionChange, sceneSchema } from '../src/inspection-contract.js';
// @ts-ignore The page's own emphasis-state builder, so the saved shape and the
// schema that has to accept it are checked against each other.
import { normalizeEmphasisState } from '../../lab/browser-roundtrip/lesson-emphasis.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

const KEY = [
  { id: 'protein', label: 'protein', color: '#8899aa', chain: 'A' },
  { id: 'site', label: 'active site', color: '#ffaa33', chain: 'A', residues: { from: 22, to: 26 } },
];

const lesson = (filePath: string) => ({
  version: 1, id: 'emphasis-demo', title: 'Emphasis demo', mode: 'explore',
  provenance: { sourceRefs: [{ kind: 'local', ref: filePath }] },
  chapters: [
    { id: 'intro', title: 'Intro', caption: 'The whole complex.', durationSeconds: .5,
      changes: [{ kind: 'rotate', durationSeconds: .5, degrees: 10 }],
      immersive: { appearance: { representation: 'cartoon', color: 'chain-id' },
        emphasis: { parts: KEY, contextOpacity: 0.18 } } },
    { id: 'site', title: 'The site', caption: 'Here is the active site.', durationSeconds: .5,
      changes: [{ kind: 'rotate', durationSeconds: .5, degrees: 10 }],
      immersive: { emphasis: { parts: KEY, focus: 'site', contextOpacity: 0.18 } } },
  ],
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-emphasis-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold emphasis test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif'), lessonPath = join(root, 'lesson.json');
  await writeFile(filePath, cif);
  await writeFile(lessonPath, JSON.stringify(lesson(filePath)));
  const sessionId = (await call('inspect_lesson', { filePath, lessonPath })).structuredContent.sessionId as string;
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
  const binding = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  const claim = async () => (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  return { call, rows, scene, binding, panelId, claim, sessionId,
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('named-part emphasis as saved, commandable state', () => {
  it('reports the loaded lesson’s colour key so a caller can ask for a part by name', async () => {
    const t = await setup();
    try {
      const state = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent;
      expect(state.lesson).toMatchObject({ id: 'lesson-emphasis-demo', title: 'Emphasis demo' });
      // The key is written into every chapter; the report collapses the repeats.
      expect(state.lesson.parts).toEqual(KEY);
      // Nothing is emphasised until something emphasises it.
      expect(state.view.emphasis).toBeUndefined();
    } finally { await t.close(); }
  });

  it('expands a spoken part name into the whole colour key and confirms what was painted', async () => {
    const t = await setup();
    try {
      // The name the lesson shows a wearer, not the id and not a chain letter.
      const queued = await t.call('emphasize', { ...t.binding, panelId: t.panelId, commandId: 'emph-1',
        parts: ['active site'] });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.emphasis).toEqual({ focus: ['site'], contextOpacity: 0.18, parts: 2 });
      expect(JSON.stringify(queued.content)).toMatch(/active site held at full strength/);

      const delivery = await t.claim();
      expect(delivery.change.kind).toBe('emphasis');
      // The whole key travels, so the part is lit inside the mapping the wearer
      // has already learned rather than against a repaint.
      expect(delivery.change.patch.parts).toEqual(KEY);
      expect(delivery.change.patch.focus).toEqual(['site']);

      const expected = expectedInspection(t.scene as any, delivery.change);
      const painted = structuredClone(t.scene) as any;
      painted.inspection.emphasis = { parts: KEY, focus: ['site'], contextOpacity: 0.18 };
      // Rebuilding the layers can move the bound Mol* computes from geometry.
      painted.camera.radiusMax = 24;
      expect(matchesInspectionChange(painted, expected, delivery.change)).toBe(true);

      // Nothing else in the scene is the panel's to change under an emphasis.
      const moved = structuredClone(painted);
      moved.inspection.placement.scale = 2;
      expect(matchesInspectionChange(moved, expected, delivery.change)).toBe(false);
      const other = structuredClone(painted);
      other.inspection.emphasis.focus = ['protein'];
      expect(matchesInspectionChange(other, expected, delivery.change)).toBe(false);

      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: painted });
      expect(receipt.structuredContent.command).toMatchObject({ status: 'rendered' });

      // What the agent reads back is what the wearer is looking at.
      const state = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent;
      expect(state.view.emphasis).toEqual({ parts: KEY, focus: ['site'], contextOpacity: 0.18 });
    } finally { await t.close(); }
  });

  it('clears the emphasis with an empty part list and refuses a part the lesson does not name', async () => {
    const t = await setup();
    try {
      const cleared = await t.call('emphasize', { ...t.binding, panelId: t.panelId, commandId: 'emph-clear', parts: [] });
      expect(cleared.isError).not.toBe(true);
      expect(JSON.stringify(cleared.content)).toMatch(/colour key is cleared/);
      const delivery = await t.claim();
      // Clearing drops the key with the focus: an empty emphasis is the plain
      // structure, not an unlit colour key.
      expect(delivery.change.patch).toEqual({ parts: [], focus: [], contextOpacity: 0.18 });

      const painted = structuredClone(t.scene) as any;
      painted.inspection.emphasis = { parts: [], focus: [], contextOpacity: 0.18 };
      await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: painted });

      const missing = await t.call('emphasize', { ...t.binding, panelId: t.panelId, commandId: 'emph-missing',
        parts: ['the ribosome'] });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toMatch(/does not name a part called/);
    } finally { await t.close(); }
  });

  /**
   * The wedge a Quest 2 can sit in for nearly two minutes.
   *
   * The tour's first wall chapter paints shaded strands, the page writes the
   * flag into the emphasis it saves, and `sync_inspection` refused the whole
   * scene. A companion never blocks on a refused save — it retries for as long
   * as the wearer is in there — so the panel stayed `dirty`, answered
   * `unsaved`, and every agent command after it was refused. The schema case
   * above is the cause; this is the sentence the driver was reading.
   */
  it('saves a scene whose emphasis shades the strands of a whole-structure chapter', async () => {
    const t = await setup();
    try {
      const shaded = structuredClone(t.scene) as any;
      shaded.inspection.emphasis = normalizeEmphasisState({ parts: KEY, focus: ['site'], contextOpacity: .18, strandShades: true });
      const saved = await t.call('sync_inspection', { ...t.binding, scene: shaded });
      expect(saved.isError).not.toBe(true);
      expect(saved.structuredContent.saved).toBe(true);
      const state = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent;
      expect(state.view.emphasis.strandShades).toBe(true);
    } finally { await t.close(); }
  });
});

describe('the emphasis a scene carries', () => {
  const scene = (emphasis?: unknown) => ({
    sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [],
    camera: { mode: 'perspective', fov: 1, position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0],
      radius: 1, radiusMax: 1, fog: 0, clipFar: false, minNear: .1, minFar: .1 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      ...(emphasis === undefined ? {} : { emphasis }),
    },
  });

  it('is optional, so a panel saved before it existed still validates', () => {
    expect(sceneSchema.parse(scene()).inspection.emphasis).toBeUndefined();
  });

  it('may only focus parts its own colour key names', () => {
    expect(sceneSchema.safeParse(scene({ parts: KEY, focus: ['site'], contextOpacity: .12 })).success).toBe(true);
    expect(sceneSchema.safeParse(scene({ parts: KEY, focus: ['nucleus'], contextOpacity: .12 })).success).toBe(false);
    // A part has to name a region of the structure, and a colour has to be one.
    expect(sceneSchema.safeParse(scene({ parts: [{ id: 'x', label: 'x', color: '#ffffff' }], focus: [], contextOpacity: .12 })).success).toBe(false);
    expect(sceneSchema.safeParse(scene({ parts: [{ id: 'x', label: 'x', color: 'orange', chain: 'A' }], focus: [], contextOpacity: .12 })).success).toBe(false);
    // Row keys are deliberately not on the wire: this is the lesson's words.
    expect(sceneSchema.safeParse(scene({ parts: [{ id: 'x', label: 'x', color: '#ffffff', chain: 'A', keys: ['k'] }], focus: [], contextOpacity: .12 })).success).toBe(false);
  });

  /**
   * The state the page actually saves, not a hand-typed copy.
   *
   * `strandShades` reached the saved scene without reaching this schema, and a
   * strict object refuses a key it does not name. Every save and
   * every command receipt from a headset showing the wall tier's first chapter
   * was rejected, the panel stayed `dirty`, `panelAvailability` answered
   * `unsaved`, and the agent's next command was refused for as long as the
   * wearer stood there. Building the emphasis with the page's own function is
   * the point of the case: a copy of the shape would have drifted the same way.
   */
  it('accepts the emphasis the page saves for a shaded whole-wall chapter', () => {
    const shaded = normalizeEmphasisState({ parts: KEY, focus: ['site'], contextOpacity: .18, strandShades: true });
    expect(shaded.strandShades).toBe(true);
    expect(sceneSchema.safeParse(scene(shaded)).success).toBe(true);
    // A part chapter saves no flag at all, and the key is unchanged by it.
    const plain = normalizeEmphasisState({ parts: KEY, focus: ['site'], contextOpacity: .18 });
    expect('strandShades' in plain).toBe(false);
    expect(sceneSchema.safeParse(scene(plain)).success).toBe(true);
    // Still strict about everything it does not name.
    expect(sceneSchema.safeParse(scene({ ...plain, strandTint: true })).success).toBe(false);
    expect(sceneSchema.safeParse(scene({ ...plain, strandShades: 'yes' })).success).toBe(false);
  });

  /**
   * Who painted the key, saved with it.
   *
   * The page decides whether a colour key is the lesson's to repaint from who
   * asked for it, and a reload used to throw that answer away: the saved scene
   * is restored in the hydrate's `built` phase, before the `placed` phase
   * installs the lesson baseline, so nothing on the page could tell the
   * lesson's own opening key from one the wearer had asked for by name. The
   * shipped telomerase lesson came back from every reload with none of its ten
   * name plates. So the provenance rides in the scene, and this schema has to
   * admit it or every save from a lesson page is refused — which is exactly how
   * `strandShades` failed above.
   */
  it('carries who painted the key, and only on a scene', () => {
    const plain = normalizeEmphasisState({ parts: KEY, focus: ['site'], contextOpacity: .18 });
    for (const origin of ['lesson', 'resting', 'command']) {
      expect(sceneSchema.safeParse(scene({ ...plain, origin })).success).toBe(true);
    }
    // Absent is how 'command' is written, and is what every scene saved before
    // this says. A reader with no word for provenance must read one that way.
    expect(sceneSchema.parse(scene(plain)).inspection.emphasis?.origin).toBeUndefined();
    expect(sceneSchema.safeParse(scene({ ...plain, origin: 'wearer' })).success).toBe(false);
    // And a COMMAND may not claim it. `update_inspection`'s emphasis patch is
    // the agent's own words for a key it is asking for; letting it name an
    // origin would let it claim the lesson's ownership of the molecule and have
    // the next hydrate repaint over whatever the wearer had chosen.
    expect(inspectionChangeSchema.safeParse({ kind: 'emphasis', patch: plain }).success).toBe(true);
    expect(inspectionChangeSchema.safeParse({ kind: 'emphasis', patch: { ...plain, origin: 'lesson' } }).success).toBe(false);
  });
});
