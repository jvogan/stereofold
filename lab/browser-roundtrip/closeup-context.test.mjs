import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { closeUpContext, towardWearer } from './closeup-context.mjs';
import { figureTargetMatchesRow } from './lesson-figure.mjs';
import { hiddenRowKeys } from './inspection-visibility.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('the wearer direction is the reverse of the level gaze, carried into the structure frame', () => {
  const head = identity(); head[13] = 1.6;
  assert.ok(close(towardWearer({ headInRoom: head, renderFromRoom: identity(), rotation: [0, 0, 0] }), [0, 0, 1]));
  // A structure turned a quarter about the vertical shows the wearer its own +x or -x side.
  const turned = towardWearer({ headInRoom: head, renderFromRoom: identity(), rotation: [0, 90, 0] });
  assert.ok(Math.abs(Math.abs(turned[0]) - 1) < 1e-9 && Math.abs(turned[2]) < 1e-9, `turned ${turned}`);
  // Looking straight down has no level gaze.
  const down = identity(); down.splice(8, 3, 0, 1, 0);
  assert.equal(towardWearer({ headInRoom: down, renderFromRoom: identity() }), undefined);
});

const row = (key, chain, residue, componentId, points) => ({ key, coordinateState: points.length ? 'resolved' : 'unresolved',
  identity: { authorChain: chain, authorResidue: residue, componentId, labelChain: chain, copyId: '1' },
  atomSites: points.map(point => ({ assemblyCoordinatesAngstrom: point })) });
// The wearer is on +z. F is the focus; its nearest atom is at z = 0.5.
const rows = [
  row('F', 'A', 1, 'HEM', [[0, 0, 0], [0, 0, .5]]),
  row('beside', 'A', 2, 'ALA', [[3, 0, 0], [3.5, 0, .4]]),
  row('behind', 'A', 3, 'ALA', [[2, 0, -2], [2, 1, -3]]),
  row('front', 'A', 4, 'ALA', [[2, 0, 1], [2, 0, 2.5]]),
  row('far', 'A', 5, 'ALA', [[20, 0, 0]]),
  row('gap', 'A', 6, 'ALA', []),
  row('other', 'B', 1, 'ALA', [[1, 0, 0]]),
];

test('a close-up keeps residues near its focus and none between the focus and the wearer', () => {
  const site = closeUpContext({ rows, shownKeys: rows.filter(r => r.identity.authorChain === 'A').map(r => r.key),
    focusKeys: ['F'], radius: 4, towardEye: [0, 0, 1] });
  assert.deepEqual(site, { kept: ['F', 'beside', 'behind'], hidden: ['front', 'far', 'gap'] });
  assert.deepEqual(closeUpContext({ rows, shownKeys: ['F', 'front', 'far'], focusKeys: ['F'], namedKeys: ['front'], radius: 4,
    towardEye: [0, 0, 1] }), { kept: ['F', 'front'], hidden: ['far'] }, 'a residue the figure names keeps its cartoon too');
  assert.equal(closeUpContext({ rows, shownKeys: ['F'], focusKeys: ['gap'], radius: 4, towardEye: [0, 0, 1] }), undefined,
    'a focus with no modelled atom leaves the chapter as it is');
  assert.equal(closeUpContext({ rows, shownKeys: ['F'], focusKeys: ['F'], radius: 4 }), undefined);
});

// The page path: setLessonFigure with the real mask helpers, the real visibility
// and row readers, and recording stand-ins for drawing and framing.
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function page({ presenting = true, held = false } = {}) {
  const calls = { paints: 0, frames: [], costs: [] };
  const structure = {};
  const c = vm.createContext({
    structure, closeUpMask: { keys: [], structure: undefined }, paintedCloseUpMask: '', state: {}, initialFigureFrame: undefined,
    assertReady() {}, now: () => 0, snapshot: () => ({ ready: true }),
    recordCost: (kind, detail) => calls.costs.push({ kind, ...detail }),
    lessonFigure: { installed: undefined, async install(value) { this.installed = value; }, geometryIdentity() { return this.installed; },
      snapshot: () => ({}), isEmptyFor() { return this.installed === undefined; } },
    inspectionMutation: async operation => { await operation(); },
    molecularAnimation: { poseSample: () => undefined, selectionSphere: loci => loci },
    syncStaticMask: async () => {}, applyInspectionTransform() {},
    paintVisibilityLayers: async () => { calls.paints++; c.paintedCloseUpMask = c.closeUpMaskKeys().join('\n'); },
    focusSelection: async options => { calls.frames.push(options); },
    select: async () => {},
    selection: { rows, toLoci: keys => ({ keys: [...keys] }) },
    canvas: { xr: { isPresenting: { value: presenting } } },
    wearerPlacement: { holdsPlacement: () => held },
    latestRoomPlacementPose: { headInRoom: identity(), renderFromRoom: identity() },
    inspectionSnapshot: () => ({ placement: { rotation: [0, 0, 0] } }),
    hiddenRowKeys, figureTargetMatchesRow, closeUpContext, towardWearer, closeUpFigureSignatures: new WeakMap(),
  });
  for (const name of ['installedFigure', 'closeUpMaskKeys', 'setCloseUpMask', 'closeUpSite', 'setLessonFigure'])
    vm.runInContext(pageFunction(source, name), c);
  return { c, calls };
}
const figure = { layers: [], labels: [], distances: [], focus: [{ chain: 'A', residues: { from: 1, to: 1 } }] };
const chapter = { frame: true, visibility: { hiddenChains: [{ labelChain: 'B', copyId: '1' }], hiddenClasses: [] } };

test('a headset site close-up draws only its kept residues and is framed with them', async () => {
  const { c, calls } = page();
  await c.setLessonFigure({ ...figure, contextRadius: 4 }, chapter);
  assert.deepEqual([...c.closeUpMaskKeys()], ['front', 'far', 'gap']);
  assert.equal(calls.paints, 1, 'the mask is drawn once, before the framing');
  assert.deepEqual(calls.frames.at(-1).ghost, { keys: ['F', 'beside', 'behind'] });
  assert.deepEqual(calls.costs.find(cost => cost.kind === 'closeup-site'), { kind: 'closeup-site', radius: 4, kept: 3, hidden: 3 });
  // Back or Next installs another figure: the mask goes and is drawn away once.
  await c.setLessonFigure(figure, chapter);
  assert.deepEqual([...c.closeUpMaskKeys()], []);
  assert.equal(calls.paints, 2);
  assert.deepEqual(calls.frames.at(-1).ghost, { keys: ['F', 'beside', 'behind', 'front', 'far', 'gap'] });
});

test('a figure installed by any other path, such as a restored chapter, ends the site mask', async () => {
  const { c, calls } = page();
  const site = { ...figure, contextRadius: 4 };
  await c.setLessonFigure(site, chapter);
  assert.equal(c.closeUpMaskKeys().length, 3);
  // Choosing Spacefill re-installs the same figure with a representation override.
  await c.lessonFigure.install({ ...structuredClone(site), representationOverride: 'spacefill' });
  assert.equal(c.closeUpMaskKeys().length, 3, 'a representation choice keeps the site close-up');
  // A cached-scene restore installs the earlier chapter's figure directly.
  await c.lessonFigure.install(structuredClone(figure));
  assert.deepEqual([...c.closeUpMaskKeys()], [], 'the next repaint of the hidden set draws the chapter whole');
  // The tour's own figure step afterwards still repaints the stale layer away.
  await c.setLessonFigure(figure, chapter);
  assert.equal(calls.paints, 2);
});

test('clearing to no figure after a restore still takes a drawn site mask away', async () => {
  const { c, calls } = page();
  await c.setLessonFigure({ ...figure, contextRadius: 4 }, chapter);
  await c.lessonFigure.install(undefined); // a figure-less scene restored directly
  await c.setLessonFigure(undefined);
  assert.equal(calls.paints, 2, 'the empty-figure shortcut does not skip a drawn mask');
  assert.equal(c.paintedCloseUpMask, '');
  await c.setLessonFigure(undefined);
  assert.equal(calls.paints, 2, 'and an empty clear after that is free again');
});

test('a refused repaint is retried by the next figure step', async () => {
  const { c, calls } = page();
  await c.setLessonFigure({ ...figure, contextRadius: 4 }, chapter);
  c.focusSelection = async () => { throw Error('busy'); };
  const paint = c.paintVisibilityLayers;
  c.paintVisibilityLayers = async () => { throw Error('busy'); };
  await assert.rejects(c.setLessonFigure({ ...figure, contextRadius: 4 }, chapter), /busy/);
  c.paintVisibilityLayers = paint;
  c.focusSelection = async () => {};
  await c.setLessonFigure(figure, chapter);
  assert.equal(c.paintedCloseUpMask, '', 'the mask still drawn after the refusal is taken away');
  assert.ok(calls.paints >= 2);
});

test('the site mask state exists before the presenting subscription can clear it', () => {
  const declared = source.indexOf('let closeUpMask =');
  const subscribed = source.indexOf('canvas.xr.isPresenting.subscribe(presenting => {');
  assert.ok(declared > 0 && subscribed > 0 && declared < subscribed, 'declared before the first presenting edge');
});

test('a failed framing leaves no site mask behind', async () => {
  const { c, calls } = page();
  c.focusSelection = async () => { throw Error('Wait for headset tracking before framing the chapter.'); };
  await assert.rejects(c.setLessonFigure({ ...figure, contextRadius: 4 }, chapter), /tracking/);
  assert.deepEqual([...c.closeUpMaskKeys()], []);
  assert.equal(calls.paints, 2);
});

test('without the radius, on the desktop, or where the wearer placed it, the close-up is unchanged', async () => {
  for (const [options, value, frame] of [[{}, figure, chapter], [{ presenting: false }, { ...figure, contextRadius: 4 }, chapter],
    [{ held: true }, { ...figure, contextRadius: 4 }, chapter], [{}, { ...figure, contextRadius: 4 }, { frame: true }]]) {
    const { c, calls } = page(options);
    await c.setLessonFigure(value, frame);
    assert.deepEqual([...c.closeUpMaskKeys()], []);
    assert.equal(calls.paints, 0);
    assert.equal(calls.costs.some(cost => cost.kind === 'closeup-site'), false);
  }
});

// The hemoglobin heme chapter on its real coordinates, seated by the real
// focus solver in the front view the headset first shows.
test('the hemoglobin heme close-up seats the heme at a fifth of the view or more, nothing nearer than 0.45 m',
  { skip: !process.env.STEREOFOLD_DEMO_CACHE && 'needs STEREOFOLD_DEMO_CACHE' }, async () => {
    const { coordinates } = await import('./fixtures/kinesin-layout.mjs');
    const { tourFocusHarness } = await import('./fixtures/tour-focus-harness.mjs');
    const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/hemoglobin-switch/flipbook.json', import.meta.url), 'utf8'));
    const chapterFigure = lesson.chapters.find(entry => entry.id === 'heme').immersive.figure;
    const atoms = coordinates(`${process.env.STEREOFOLD_DEMO_CACHE}/hemoglobin-tr-flipbook.cif`, lesson.provenance.sourceSha256);
    const byKey = new Map();
    for (const atom of atoms) {
      const key = `${atom.chain}:${atom.residue}:${atom.component}`;
      if (!byKey.has(key)) byKey.set(key, row(key, atom.chain, atom.residue, atom.component, []));
      byKey.get(key).atomSites.push({ assemblyCoordinatesAngstrom: atom.position });
    }
    const all = [...byKey.values()];
    const polymer = new Set(['ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE', 'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL']);
    // The page frames a site with every shown row it keeps, ligands included.
    const shown = all.filter(r => ['A', 'E'].includes(r.identity.authorChain));
    const polymerShown = shown.filter(r => polymer.has(r.identity.componentId));
    const focus = all.filter(r => chapterFigure.focus.some(target => figureTargetMatchesRow(target, r)));
    assert.ok(chapterFigure.contextRadius > 0, 'the chapter names its context radius');
    const site = closeUpContext({ rows: all, shownKeys: shown.map(r => r.key), focusKeys: focus.map(r => r.key),
      radius: chapterFigure.contextRadius, towardEye: [0, 0, 1] });
    const points = list => list.flatMap(r => r.atomSites.map(s => s.assemblyCoordinatesAngstrom));
    const dirs = [];
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z]);
    const sphere = list => {
      const p = points(list), center = [0, 1, 2].map(k => (Math.min(...p.map(v => v[k])) + Math.max(...p.map(v => v[k]))) / 2);
      return { center, radius: Math.max(...p.map(v => Math.hypot(v[0] - center[0], v[1] - center[1], v[2] - center[2]))),
        extrema: dirs.map(d => p.reduce((best, v) => v[0] * d[0] + v[1] * d[1] + v[2] * d[2] > best[0] * d[0] + best[1] * d[1] + best[2] * d[2] ? v : best)) };
    };
    const whole = sphere(all), target = sphere(focus);
    const kept = shown.filter(r => site.kept.includes(r.key));
    const heme = points(all.filter(r => r.identity.authorChain === 'E' && r.identity.componentId === 'HEM'));
    const hemeWidth = Math.max(...heme.map(v => v[0])) - Math.min(...heme.map(v => v[0]));
    const seat = async ghostRows => {
      const { h, records } = tourFocusHarness();
      h.recordBoundingSphere = () => whole; h.loadedSphere = () => whole; h.selection.toLoci = () => target;
      await h.focusSelection({ selectionKeys: ['B'], framing: 'fill', minTargetFraction: .15, liftEmphasis: false,
        elevationDegrees: 0, lessonSelection: true, ghost: sphere(ghostRows) });
      const record = records.filter(r => r.kind === 'xr-focus').at(-1);
      const metresPerAngstrom = h.inspectionState.placement().scale * h.canvas.camera.scale;
      const front = Math.max(...points(ghostRows).map(v => v[2] - target.center[2]));
      return { heme: hemeWidth * metresPerAngstrom / record.distanceMetres / (Math.PI / 2),
        nearest: record.distanceMetres - front * metresPerAngstrom };
    };
    const before = await seat(polymerShown), after = await seat(kept);
    assert.ok(after.heme >= .2 && after.heme >= 2.5 * before.heme,
      `heme share of a 90 degree view ${before.heme.toFixed(3)} -> ${after.heme.toFixed(3)}`);
    assert.ok(after.nearest >= .45, `nearest drawn residue ${after.nearest.toFixed(2)} m`);
  });

test('the hemoglobin heme chapter is the only shipped chapter that draws a site close-up', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const root = new URL('../../plugin/', import.meta.url);
  const named = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = new URL(name, dir);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(new URL(`${name}/`, dir)); continue; }
      if (!name.endsWith('.json')) continue;
      const lesson = JSON.parse(readFileSync(path, 'utf8'));
      for (const chapter of Array.isArray(lesson?.chapters) ? lesson.chapters : [])
        if (chapter?.immersive?.figure?.contextRadius !== undefined)
          named.push(`${path.pathname.slice(root.pathname.length)}#${chapter.id}`);
    }
  };
  for (const folder of ['demos/', 'examples/']) walk(new URL(folder, root));
  assert.deepEqual(named, ['demos/hemoglobin-switch/flipbook.json#heme']);
});
