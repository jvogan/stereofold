import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, expectedInspection, inspectionChangeSchema,
  matchesInspectionChange, sceneSchema } from '../src/inspection-contract.js';
// @ts-ignore The page's own emphasis-state builder, so the saved shape and the
// schema that has to accept it are checked against each other.
import { normalizeEmphasisState, planLessonEmphasis } from '../../lab/browser-roundtrip/lesson-emphasis.mjs';
// @ts-ignore Real Mol* geometry and playback, with an adapted Canvas3D.
import { molecularAnimationHarness } from '../../lab/browser-roundtrip/fixtures/molecular-animation-harness.mjs';

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

async function setup(sourceText = cif, makeLesson: (filePath: string) => unknown = lesson) {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-emphasis-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold emphasis test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif'), lessonPath = join(root, 'lesson.json');
  await writeFile(filePath, sourceText);
  await writeFile(lessonPath, JSON.stringify(makeLesson(filePath)));
  const sessionId = (await call('inspect_lesson', { filePath, lessonPath })).structuredContent.sessionId as string;
  const meta = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const privateData = { ...meta, catalog: meta.catalog ?? await decodeInspectionCatalog(meta.catalogWire) };
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

// A small synthetic catalog uses the deposited chain/residue identities. The
// shipped manifests supply the real keys and extra parts; no demo cache is needed.
function nucleotideFixture(chains: string[], anpChains: string[]) {
  const atomHeaders = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id',
    'label_comp_id', 'label_asym_id', 'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code',
    'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv', 'auth_seq_id',
    'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'];
  let id = 0;
  return `data_SYNTHETIC_KINESIN\n# Synthetic emphasis test, not experimental coordinates.\n` +
    `loop_\n_entity.id\n_entity.type\n_entity.pdbx_description\n1 polymer 'Test polymer'\n2 non-polymer ANP\n3 non-polymer ADP\n#\n` +
    `loop_\n_entity_poly.entity_id\n_entity_poly.type\n_entity_poly.pdbx_seq_one_letter_code\n1 'polypeptide(L)' G\n#\n` +
    `loop_\n_entity_poly_seq.entity_id\n_entity_poly_seq.num\n_entity_poly_seq.mon_id\n1 1 GLY\n#\n` +
    `loop_\n_struct_asym.id\n_struct_asym.entity_id\n` +
    chains.map(chain => `${chain} 1`).join('\n') + '\n' +
    anpChains.flatMap((_, i) => [`L${i} 2`, `D${i} 3`]).join('\n') + '\n#\nloop_\n' +
    atomHeaders.map(h => `_atom_site.${h}`).join('\n') + '\n' +
    chains.map(chain => `ATOM ${++id} C CA . GLY ${chain} 1 1 ? ${id} 0 0 1 0 1 GLY ${chain} CA 1`).join('\n') + '\n' +
    anpChains.flatMap((chain, i) => [
      `HETATM ${++id} P PA . ANP L${i} 2 . ? ${id} 1 0 1 0 1001 ANP ${chain} PA 1`,
      `HETATM ${++id} P PA . ADP D${i} 3 . ? ${id} 2 0 1 0 401 ADP ${chain} PA 1`,
    ]).join('\n') + '\n#\n';
}

it('emphasize names the lesson, its part count and the limit when the colour key is too long', async () => {
  // Three chapters of 11 parts each name 33 between them: one over the scene's 32-part key.
  const parts = (from: number) => Array.from({ length: 11 }, (_, i) =>
    ({ id: `part-${from + i}`, label: `Part ${from + i}`, color: '#8899aa', chain: 'A', residues: { from: from + i + 1, to: from + i + 1 } }));
  const crowded = (filePath: string) => {
    const base = lesson(filePath) as any;
    return { ...base, id: 'crowded-key', title: 'Crowded key', chapters: [0, 11, 22].map((from, i) =>
      ({ ...base.chapters[i % 2], id: `chapter-${i}`, immersive: { ...base.chapters[i % 2].immersive,
        emphasis: { parts: parts(from), contextOpacity: 0.18 } } })) };
  };
  const t = await setup(cif, crowded);
  try {
    const answer = await t.call('emphasize', { ...t.binding, panelId: t.panelId, parts: ['Part 3'] });
    expect(answer.isError).toBe(true);
    const text = answer.content.map((block: any) => block.text).join(' ');
    expect(text).toMatch(/Crowded key/);
    expect(text).toMatch(/33 parts/);
    expect(text).toMatch(/32/);
  } finally { await t.close(); }
});

it.each(['motion', 'flipbook'])('emphasize ATP lights only the ANP residues in the kinesin %s lesson', async stage => {
  const manifest = JSON.parse(await readFile(new URL(`../demos/kinesin-walk/${stage}.json`, import.meta.url), 'utf8'));
  const anpChains = stage === 'motion' ? ['K1T', 'K2T'] : ['K1T0', 'K2T2', 'K1T5'];
  const allChains = [...new Set<string>(manifest.chapters.flatMap((chapter: any) => chapter.immersive.emphasis.parts.map((part: any) => part.chain)))];
  const recipe = JSON.parse(await readFile(new URL(`../demos/kinesin-walk/${stage}-recipe.json`, import.meta.url), 'utf8'));
  expect(recipe.bodies.filter((body: any) => body.ligands?.includes('ANP')).map((body: any) => body.chain)).toEqual(anpChains);
  // The scene carries the lesson's whole colour key, which holds at most 32 parts.
  const key = new Set(manifest.chapters.flatMap((chapter: any) =>
    [...chapter.immersive.emphasis.parts, ...(chapter.immersive.parts ?? [])].map((part: any) => part.id)));
  expect(key.size).toBeLessThanOrEqual(32);
  for (const chapter of manifest.chapters) {
    expect(chapter.immersive.emphasis.parts.length).toBeLessThanOrEqual(16);
    expect(chapter.immersive.parts?.length ?? 0).toBeLessThanOrEqual(16);
    const visible = new Set(chapter.immersive.visibility.chains);
    const expectedChains = anpChains.filter(chain => visible.has(chain));
    expect((chapter.immersive.parts ?? []).map((part: any) => part.chain)).toEqual(expectedChains);
  }
  // Keep every authored emphasis/name definition while omitting unrelated
  // geometry controls that the deliberately tiny fixture cannot represent.
  const testManifest = { ...manifest, provenance: { sourceRefs: [{ kind: 'local', ref: 'synthetic test' }] },
    chapters: manifest.chapters.map((chapter: any) => ({ ...chapter, animation: undefined,
      immersive: { emphasis: chapter.immersive.emphasis, parts: chapter.immersive.parts } })) };
  for (const name of ['ATP', 'the ATP', 'nucleotide', 'AMP-PNP']) {
    const cache = process.env.STEREOFOLD_DEMO_CACHE;
    // Prepared composites are content-addressed; the bare name is a legacy copy.
    const addressed = cache && join(cache, `kinesin-walk-${stage}.${manifest.provenance.sourceSha256}.cif`);
    const sourceText = cache ? await readFile(addressed && existsSync(addressed) ? addressed : join(cache, `kinesin-walk-${stage}.cif`), 'utf8')
      : nucleotideFixture(allChains, anpChains);
    const t = await setup(sourceText, () => cache ? manifest : testManifest);
    try {
      const queued = await t.call('emphasize', { ...t.binding, panelId: t.panelId, parts: [name] });
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      const delivery = await t.claim();
      const patch = delivery.change.patch;
      expect(patch.focus).toEqual(anpChains.map(chain => `${chain.toLowerCase()}-anp`));
      // Scene state is strict: lookup aliases must not leak onto the wire.
      expect(patch.parts.every((part: any) => part.aliases === undefined)).toBe(true);
      const plan = planLessonEmphasis(patch, ({ chain, residues }: any) => t.rows.filter(row =>
        row.identity.authorChain === chain && (!residues ||
          (Number(row.identity.authorResidue) >= residues[0] && Number(row.identity.authorResidue) <= residues[1])))
        .map(row => row.key), t.rows.map(row => row.key));
      const lit = t.rows.filter(row => plan.lit.includes(row.key));
      expect(lit.map(row => row.identity.authorChain)).toEqual(anpChains);
      expect(lit.every(row => row.identity.componentId === 'ANP' && Number(row.identity.authorResidue) === 1001)).toBe(true);
      expect(plan.faded.length).toBe(t.rows.length - anpChains.length);
      const painted = expectedInspection(t.scene as any, delivery.change);
      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: painted });
      expect(receipt.isError, JSON.stringify(receipt.content)).not.toBe(true);
      expect(receipt.structuredContent.command.status).toBe('rendered');
    } finally { await t.close(); }
  }
}, 120_000);

it.each(['emphasize', 'color', 'scoped color', 'label', 'measure', 'placement', 'compound'])(
  '%s confirms its own edit while the kinesin motion clock advances', async tool => {
    const manifest = JSON.parse(await readFile(new URL('../demos/kinesin-walk/motion.json', import.meta.url), 'utf8'));
    // Every emphasised chain and every chain a track moves, linker pieces included.
    const chains = [...new Set<string>(manifest.chapters.flatMap((chapter: any) => [
      ...chapter.immersive.emphasis.parts.map((part: any) => part.chain),
      ...(chapter.animation?.tracks ?? []).flatMap((track: any) => track.chains)]))];
    const sourceText = nucleotideFixture(chains, ['K1T', 'K2T']);
    // Real shipped tracks/visibility and ATP identities, tiny synthetic coordinates.
    // Omit tether/figure endpoints absent from this deliberately small source.
    const lesson = { ...manifest, provenance: { sourceRefs: [{ kind: 'local', ref: 'synthetic playback test' }] },
      chapters: manifest.chapters.map((chapter: any) => ({ ...chapter,
        animation: chapter.animation && { ...chapter.animation, tethers: [] },
        immersive: { emphasis: chapter.immersive.emphasis, parts: chapter.immersive.parts } })) };
    const cleanup: (() => any)[] = [];
    const molecular = await molecularAnimationHarness({ after: (fn: () => any) => cleanup.push(fn) },
      { structureText: sourceText, representation: 'ball-and-stick' });
    const t = await setup(sourceText, () => lesson);
    try {
      const chapter = lesson.chapters[0];
      await molecular.registry.install(chapter.animation, chapter.id);
      molecular.registry.tick(0); molecular.registry.tick(100);
      await molecular.registry.refresh();
      const before: any = structuredClone(t.scene);
      before.inspection.animation = molecular.registry.capture();
      const saved = await t.call('sync_inspection', { ...t.binding, scene: before });
      expect(saved.isError).not.toBe(true);
      t.binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
      await t.claim();
      const changes: Record<string, any> = {
        color: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ff8800' } },
        'scoped color': { kind: 'appearance', residues: { authorChain: 'K1T' }, patch: { color: 'uniform', uniformColor: '#ff8800' } },
        label: { kind: 'appearance', patch: { labels: true } },
        placement: { kind: 'placement', patch: { scale: 1.5 } },
        compound: { kind: 'compound', patch: { ops: [
          { kind: 'emphasis', parts: ['k1t-anp', 'k2t-anp'] }, { kind: 'placement', patch: { scale: 1.5 } }] } },
      };
      const queued = await t.call(tool === 'emphasize' ? 'emphasize' : tool === 'measure' ? 'measure' : 'update_inspection',
        { sessionId: t.sessionId, ...(tool === 'emphasize' ? { parts: ['k1t-anp', 'k2t-anp'] }
          : tool === 'measure' ? { targets: ['K1T', 'K2T'].map(authorChain => ({ authorChain, authorResidue: 1001, atomName: 'PA' })), annotate: true }
          : { change: changes[tool] }) });
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      const delivery = await t.claim();
      expect(delivery).toBeDefined();
      const expected = expectedInspection(before, delivery.change);
      // This is the renderer refresh reached by every mutation, not a hand-written clock sample.
      if (tool === 'label' || tool === 'measure') molecular.annotations.push({
        repr: { renderObjects: [], state: { visible: true }, setState(patch: any) { Object.assign(this.state, patch); } }, chains: ['K1T'],
      });
      molecular.registry.tick(200); molecular.registry.tick(300);
      await molecular.registry.refresh();
      const returned = structuredClone(expected);
      returned.inspection.animation = molecular.registry.capture();
      expect(returned.inspection.animation!.playback.timeSeconds).toBeGreaterThan(before.inspection.animation.playback.timeSeconds);
      if (tool === 'emphasize') {
        const withoutClock = structuredClone(returned);
        withoutClock.inspection.animation!.playback.timeSeconds = expected.inspection.animation!.playback.timeSeconds;
        expect(withoutClock).toEqual(expected); // The exact field that caused the false rejection.
      }
      // A stale/missing edit must still fail even though its animation is valid.
      const missing = structuredClone(before);
      missing.inspection.animation = molecular.registry.capture();
      expect(matchesInspectionChange(missing, expected, delivery.change)).toBe(false);
      expect(matchesInspectionChange(returned, expected, delivery.change)).toBe(true);
      // Ignoring the live clock must not permit a different clip, controls or source.
      for (const corrupt of [
        (v: any) => { v.inspection.animation.playback.state = 'paused'; },
        (v: any) => { v.inspection.animation.playback.speed = 2; },
        (v: any) => { v.inspection.animation.playback.loop = !v.inspection.animation.playback.loop; },
        (v: any) => { v.inspection.animation.playback.id = 'other'; },
        (v: any) => { v.inspection.animation.playback.chapterId = 'other'; },
        (v: any) => { v.inspection.animation.definition.tracks[0].keyframes[0].translation[0] += 1; },
        (v: any) => { delete v.inspection.animation; },
        (v: any) => { v.sourceSha256 = '0'.repeat(64); },
      ]) {
        const wrong = structuredClone(returned); corrupt(wrong);
        expect(matchesInspectionChange(wrong, expected, delivery.change)).toBe(false);
      }
      // A paused sample cannot silently seek; a playing clip can wrap or finish.
      const paused = structuredClone(expected);
      paused.inspection.animation!.playback.state = 'paused';
      const sought = structuredClone(returned);
      sought.inspection.animation!.playback.state = 'paused';
      expect(matchesInspectionChange(sought, paused, delivery.change)).toBe(false);
      const wrapped = structuredClone(returned);
      wrapped.inspection.animation!.playback.timeSeconds = 0;
      expect(matchesInspectionChange(wrapped, expected, delivery.change)).toBe(true);
      const ending = structuredClone(expected);
      ending.inspection.animation!.playback.loop = false;
      const ended = structuredClone(returned);
      Object.assign(ended.inspection.animation!.playback, { loop: false, state: 'paused', timeSeconds: chapter.animation.durationSeconds });
      expect(matchesInspectionChange(ended, ending, delivery.change)).toBe(true);
      // A playback heartbeat during the render does not create a revision race.
      const heartbeat = await t.call('poll_inspection', { ...t.binding, panelId: t.panelId,
        availability: 'busy', animation: molecular.registry.snapshot() });
      expect(heartbeat.isError).not.toBe(true);
      const live = await t.call('get_inspection_state', { sessionId: t.sessionId });
      expect(live.structuredContent.inspectionRevision).toBe(t.binding.baseInspectionRevision);
      const receipt = await t.call('complete_inspection', { ...t.binding, panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, scene: returned });
      expect(receipt.isError, JSON.stringify(receipt.content)).not.toBe(true);
      expect(receipt.structuredContent.command.status).toBe('rendered');
      const sample = molecular.registry.snapshot();
      molecular.registry.tick(400);
      expect(molecular.registry.snapshot().state).toBe('playing');
      expect(molecular.registry.snapshot().timeSeconds).toBeGreaterThan(sample.timeSeconds);
    } finally { await t.close(); for (const fn of cleanup.reverse()) await fn(); }
  }, 20000);

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

  it('accepts the emphasis the page saves for a chapter that lights parts beside its focus', () => {
    const lit = normalizeEmphasisState({ parts: KEY, focus: ['site'], alsoLit: [KEY[0].id], contextOpacity: .18 });
    expect(lit.alsoLit).toEqual([KEY[0].id]);
    expect(sceneSchema.safeParse(scene(lit)).success).toBe(true);
    expect(inspectionChangeSchema.safeParse({ kind: 'emphasis', patch: lit }).success).toBe(true);
    expect(sceneSchema.safeParse(scene({ ...lit, alsoLit: ['nucleus'] })).success).toBe(false);
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
