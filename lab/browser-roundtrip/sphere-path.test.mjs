import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as budget from './representation-budget.mjs';
import { geometryDebugOptions, requireGeometryBudget, requireSceneGeometryBudget, sphereTypeParams, withGeometryDebug,
  sphereMeshTriangles, XR_HEAVY_SPHERE_MESH_DETAIL, XR_SPHERE_MESH_DETAIL, XR_SPHERE_MESH_DEVICES,
  XR_SPHERE_MESH_TRIANGLE_CEILING, XR_LESSON_SPHERE_MESH_DETAIL, XR_LESSON_SPHERE_MESH_TRIANGLE_CEILING, XR_SOLID_CONTEXT_ATOM_CEILING, solidEmphasisContext } from './representation-budget.mjs';
import { HEAVY_SCENE_ATOM_SITES } from './xr-render-budget.mjs';

const heavy = { representation: 'spacefill', presenting: true, deviceClass: 'quest2', atoms: 58_870 };
const mesh = detail => ({ quality: 'custom', detail, doubleSided: false, tryUseImpostor: false });
const page = search => ({ location: { search } });
// What the shipped default draws a heavy Quest 2 spacefill with in a session.
// Every expectation below reads it, so setting the default is one line in
// representation-budget.mjs and no edit here.
const shipped = XR_HEAVY_SPHERE_MESH_DETAIL === null ? {} : mesh(XR_HEAVY_SPHERE_MESH_DETAIL);
async function withAddress(search, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const prior = globalThis.location;
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
  try { return await run(); }
  finally {
    if (had) Object.defineProperty(globalThis, 'location', { value: prior, configurable: true, writable: true });
    else delete globalThis.location;
  }
}

test('the shipped default is impostors or the heavy-tier mesh, and only a heavy Quest 2 session can take the mesh', () => {
  assert.ok(XR_HEAVY_SPHERE_MESH_DETAIL === null || XR_HEAVY_SPHERE_MESH_DETAIL === XR_SPHERE_MESH_DETAIL,
    'the default is off, or the rule the address can try (sphere:mesh)');
  assert.equal(XR_SPHERE_MESH_DETAIL, 1, 'detail 1 looks like the impostors at the giant pose');
  assert.deepEqual(XR_SPHERE_MESH_DEVICES, ['quest2']);
  assert.deepEqual(sphereTypeParams(heavy), shipped);
  const input = { ...heavy, bonds: 60_000, residues: 7_000, quality: 'low', standalone: true };
  assert.deepEqual(requireGeometryBudget(input).typeParams, shipped);
  assert.deepEqual(requireGeometryBudget({ ...input, presenting: false }).typeParams, {}, 'the flat view keeps impostors');
  assert.deepEqual(requireGeometryBudget({ ...input, deviceClass: 'quest3' }).typeParams, {});
  assert.deepEqual(requireGeometryBudget({ ...input, atoms: 9_000 }).typeParams, {}, 'a scene under the heavy tier keeps impostors');
});

test('the heavy-tier mesh applies only in a presenting session on a measured device above the heavy tier', () => {
  for (const heavyDetail of [0, 1]) {
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail }), mesh(heavyDetail));
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, presenting: false }), {}, 'the flat view never changes');
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, deviceClass: 'desktop' }), {});
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, deviceClass: 'quest3' }), {}, 'unmeasured headsets keep impostors');
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, atoms: HEAVY_SCENE_ATOM_SITES }), {}, 'at the tier edge');
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, atoms: HEAVY_SCENE_ATOM_SITES + 1 }), mesh(heavyDetail));
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, representation: 'ball-and-stick' }), {});
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, representation: 'cartoon' }), {});
    assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail, reduced: true }), {}, 'a geometry reduction keeps its own detail');
  }
});

test('the automatic mesh stops at the triangle ceiling, where a typed path still applies', () => {
  assert.equal(sphereMeshTriangles(0), 20); assert.equal(sphereMeshTriangles(1), 80);
  assert.ok(58_870 * sphereMeshTriangles(1) <= XR_SPHERE_MESH_TRIANGLE_CEILING, 'the measured scene fits at detail 1');
  const most = Math.floor(XR_SPHERE_MESH_TRIANGLE_CEILING / sphereMeshTriangles(1));
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: most, heavyDetail: 1 }), mesh(1));
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: most + 1, heavyDetail: 1 }), {});
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: 1_000_001, heavyDetail: 0 }), {}, 'a million atoms keeps impostors');
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: 1_000_001, sphere: 0 }), mesh(0));
});

test('a lesson draws a heavy Quest 2 spacefill as detail-0 mesh spheres unless the address names a path', async () => {
  assert.equal(XR_LESSON_SPHERE_MESH_DETAIL, 0);
  // The microtubule wall: 40,908 atoms in spacefill, inside a lesson.
  const wallSpheres = { ...heavy, atoms: 40_908, lesson: true };
  for (const heavyDetail of [null, 0, 1])
    assert.deepEqual(sphereTypeParams({ ...wallSpheres, heavyDetail }), mesh(0), `whatever the default (${heavyDetail})`);
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, sphere: 1 }), mesh(1));
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, sphere: 'impostor' }), { tryUseImpostor: true });
  const input = { ...heavy, atoms: 40_908, bonds: 42_000, residues: 5_200, quality: 'low', standalone: true };
  assert.deepEqual(requireGeometryBudget({ ...input, lesson: true }).typeParams, mesh(0));
  assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail: 1 }), mesh(1), 'a scene outside a lesson, with a default detail');
  const wall = [{ representation: 'spacefill', atoms: 40_908, residues: 5_200 }];
  const options = { presenting: true, deviceClass: 'quest2', quality: 'low', standalone: true };
  assert.deepEqual(requireSceneGeometryBudget(wall, { ...options, lesson: true })[0].typeParams, mesh(0));
  assert.deepEqual(requireSceneGeometryBudget(wall, options)[0].typeParams, shipped, 'outside a lesson the default applies');
  await withAddress('?xrRenderBudget=sphere:impostor', () => {
    assert.deepEqual(requireSceneGeometryBudget(wall, { ...options, lesson: true })[0].typeParams, { tryUseImpostor: true }, 'the address still wins');
  });
  // The lesson rule keeps every other limit of the heavy-tier rule, under its own triangle ceiling.
  assert.equal(XR_LESSON_SPHERE_MESH_TRIANGLE_CEILING, 1_000_000);
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, presenting: false }), {}, 'the flat page keeps impostors');
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, deviceClass: 'quest3' }), {}, 'an unmeasured headset keeps impostors');
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, atoms: HEAVY_SCENE_ATOM_SITES }), {}, 'a scene at the heavy tier keeps impostors');
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, reduced: true }), {}, 'a geometry reduction keeps its own detail');
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, atoms: 50_000 }), mesh(0), 'the lesson ceiling at detail 0');
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, atoms: 50_001 }), {}, 'past it, impostors');
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, atoms: 177_268 }), {}, 'the whole tube keeps impostors');
  assert.deepEqual(sphereTypeParams({ ...heavy, lesson: true }), {}, '1AON in a lesson: 1.18 M triangles, impostors');
  // A translucent lesson spacefill keeps impostors; the heavy-tier rule outside lessons is unchanged.
  assert.deepEqual(sphereTypeParams({ ...wallSpheres, opacity: 0.35 }), {});
  assert.deepEqual(requireGeometryBudget({ ...input, lesson: true, opacity: 0.5 }).typeParams, {});
  assert.deepEqual(requireSceneGeometryBudget([{ ...wall[0], opacity: 0.5 }], { ...options, lesson: true })[0].typeParams, {});
  assert.deepEqual(sphereTypeParams({ ...heavy, heavyDetail: 1, opacity: 0.35 }), mesh(1), 'outside a lesson, as before');
});

test('a heavy spacefill on a Quest 2 in a session keeps its emphasis context solid', () => {
  const wall = { representation: 'spacefill', presenting: true, deviceClass: 'quest2', atoms: 40_908 };
  assert.equal(solidEmphasisContext(wall), true);
  assert.equal(solidEmphasisContext({ ...wall, atoms: HEAVY_SCENE_ATOM_SITES }), false, 'at the heavy tier the ghost stays');
  assert.equal(XR_SOLID_CONTEXT_ATOM_CEILING, 50_000);
  assert.equal(solidEmphasisContext({ ...wall, atoms: 43_066 }), true, 'the tip tier');
  assert.equal(solidEmphasisContext({ ...wall, atoms: 50_000 }), true);
  assert.equal(solidEmphasisContext({ ...wall, atoms: 50_001 }), false, 'past the ceiling the ghost stays');
  // The whole tube keeps exactly what it drew before: its ghost and impostors.
  const tube = { ...wall, atoms: 177_268 };
  assert.equal(solidEmphasisContext(tube), false);
  assert.deepEqual(sphereTypeParams({ ...tube, lesson: true }), {});
  assert.equal(solidEmphasisContext({ ...wall, atoms: 58_870 }), false, '1AON keeps its ghost');
  assert.equal(solidEmphasisContext({ ...wall, presenting: false }), false, 'the flat page keeps the ghost');
  for (const deviceClass of ['quest3', 'quest-pro', 'vision-pro', 'desktop', 'unknown', undefined])
    assert.equal(solidEmphasisContext({ ...wall, deviceClass }), false, `${deviceClass} keeps the ghost`);
  for (const representation of ['cartoon', 'molecular-surface', 'ball-and-stick', 'gaussian-surface'])
    assert.equal(solidEmphasisContext({ ...wall, representation }), false, `${representation} keeps the ghost`);
  assert.equal(solidEmphasisContext({ ...wall, atoms: Number.NaN }), false);
  assert.equal(solidEmphasisContext(), false);
});

test('the viewer judges a solid context per painted representation at paint time', () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const body = name => { const start = viewer.indexOf(`function ${name}(`); return viewer.slice(start, viewer.indexOf('\n  }\n', start) + 4); };
  const solid = (state, repr, data) => vm.runInNewContext(`${body('solidContextTarget')}\nsolidContextTarget(repr, data)`, {
    solidEmphasisContext, sessionDeviceClass: () => state.deviceClass, currentXrSession: () => ({}), globalThis: { navigator: {} },
    canvas: { xr: { isPresenting: { value: state.presenting } } }, repr, data });
  const drawn = type => ({ cell: { params: { values: { type: { name: type } } } } });
  const quest = { presenting: true, deviceClass: 'quest2' };
  assert.equal(solid(quest, drawn('spacefill'), { elementCount: 40_908 }), true, 'the heavy spacefill base');
  assert.equal(solid(quest, { cell: { transform: { params: { type: { name: 'spacefill' } } } } }, { elementCount: 40_908 }), true);
  assert.equal(solid(quest, drawn('cartoon'), { elementCount: 40_908 }), false, 'a cartoon keeps its ghost');
  assert.equal(solid(quest, drawn('molecular-surface'), { elementCount: 177_268 }), false, 'a surface keeps its ghost');
  assert.equal(solid(quest, drawn('spacefill'), { elementCount: 738 }), false, 'a small spacefill layer keeps its ghost');
  assert.equal(solid({ ...quest, deviceClass: 'quest3' }, drawn('spacefill'), { elementCount: 40_908 }), false);
  assert.equal(solid({ ...quest, presenting: false }, drawn('spacefill'), { elementCount: 40_908 }), false, 'the flat page');
  assert.equal(solid(quest, undefined, undefined), false);
  // The ghost strength itself is still the authored one with the passthrough floor.
  assert.doesNotMatch(body('paintedContextOpacity'), /solid/);
  // Each paint target answers for itself, and a zero-strength fade is not drawn.
  assert.match(viewer, /if \(!transparency \|\| !repr\?\.ref \|\| !plan\.faded\.length\n\s+\|\| \(typeof solidContextTarget === 'function' && solidContextTarget\(repr, data\)\)\) continue;/);
  assert.match(body('paintVisibilityLayers'), /if \(!\(typeof solidContextTarget === 'function' && solidContextTarget\(repr, data\)\)\) add\(fade\?\.faded, fade\?\.transparency\);/);
  // The layer check expects no fade cell on a solid base, so a repeated edit is not taken for a broken scene.
  assert.match(body('inspectionLayersIntact'), /const fadeDrawn = plan\?\.faded\.length > 0\n\s+&& !\(typeof solidContextTarget === 'function' && solidContextTarget\(representation, structure\?\.obj\?\.data\)\);/);
  // A representation of a component counts the component's atoms, not the whole structure's.
  assert.equal(solid(quest, { ...drawn('spacefill'), obj: { data: { sourceData: { elementCount: 900 } } } }, { elementCount: 40_908 }), false);
  assert.equal(solid(quest, { ...drawn('spacefill'), obj: { data: { sourceData: { elementCount: 40_908 } } } }, { elementCount: 40_908 }), true);
  // The appearance rebuild hands its opacity to the sphere rule.
  assert.match(viewer, /const geometry = geometryFor\(built, undefined, undefined, appearance\.opacity\);/);
  assert.match(body('geometryFor'), /lesson: lessonOwnsScene\(\), opacity \}\);/);
});

test('past the triangle ceiling the default keeps impostors, never a coarser mesh', () => {
  // 70,000 atoms at detail 1 is 5.6 M triangles: over the ceiling.
  assert.ok(70_000 * sphereMeshTriangles(1) > XR_SPHERE_MESH_TRIANGLE_CEILING);
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: 70_000, heavyDetail: 1 }), {});
  assert.deepEqual(requireGeometryBudget({ ...heavy, atoms: 70_000, bonds: 72_000, residues: 9_000, quality: 'low', standalone: true }).typeParams, {});
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: 62_500, heavyDetail: 1 }), mesh(1), 'the largest scene a detail-1 default would mesh');
  assert.deepEqual(sphereTypeParams({ ...heavy, atoms: 62_501, heavyDetail: 1 }), {});
});

test('a path typed on the address wins in either view and an unreadable one changes nothing', () => {
  assert.deepEqual(sphereTypeParams({ ...heavy, sphere: 'impostor', heavyDetail: 0 }), { tryUseImpostor: true });
  assert.deepEqual(sphereTypeParams({ ...heavy, sphere: 1 }), mesh(1));
  assert.deepEqual(sphereTypeParams({ ...heavy, sphere: 0, presenting: false, deviceClass: 'desktop', atoms: 300 }), mesh(0));
  assert.deepEqual(sphereTypeParams({ ...heavy, sphere: 0, representation: 'cartoon' }), {});
  assert.deepEqual(sphereTypeParams({ ...heavy, sphere: 7 }), {});
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:auto')), {});
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:0,sphere:auto')), {});
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:fan')), {});
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:1')), { sphereDetail: 1 });
});

test('the sphere path reaches a whole-structure decision through the page address', async () => {
  const input = { ...heavy, bonds: 60_000, residues: 7_000, quality: 'low', standalone: true };
  await withAddress('?xrRenderBudget=sphere:0', () => {
    const decided = requireGeometryBudget(input);
    assert.deepEqual(decided.typeParams, mesh(0));
    assert.equal(decided.estimatedVertices, requireGeometryBudget({ ...input, representation: 'spacefill' }).estimatedVertices);
  });
  await withAddress('?xrRenderBudget=sphere:impostor', () => {
    assert.deepEqual(requireGeometryBudget(input).typeParams, { tryUseImpostor: true });
  });
  await withAddress('?xrRenderBudget=spherecull:fan', () => {
    assert.deepEqual(requireGeometryBudget(input).typeParams, shipped, 'another key leaves the default alone');
  });
});

test('a scene decision judges each spacefill entry by its own atom count', () => {
  const entries = [{ representation: 'spacefill', atoms: 58_870, residues: 7_000 },
    { representation: 'spacefill', atoms: 600, residues: 40 }, { representation: 'cartoon', atoms: 58_870, residues: 7_000 }];
  const options = { presenting: true, deviceClass: 'quest2', quality: 'low', standalone: true };
  // The shipped default: only the heavy spacefill entry can change.
  assert.deepEqual(requireSceneGeometryBudget(entries, options).map(decision => decision.typeParams), [shipped, {}, {}]);
  // Run the production scene function with the layering step recorded, and
  // with the sphere rule at a mesh detail, to see what each entry is judged by.
  const text = readFileSync(new URL('./representation-budget.mjs', import.meta.url), 'utf8');
  const start = text.indexOf('export function requireSceneGeometryBudget(');
  const body = text.slice(start, text.indexOf('\n}', start) + 2).replace('export ', '');
  const seen = [];
  const context = vm.createContext({ ...budget, geometryDebugOptions: () => ({}),
    withGeometryDebug: (decision, debug, layer) => {
      seen.push({ representation: decision.representation, total: decision.atoms, ...layer });
      return budget.withGeometryDebug(decision, debug, layer);
    } });
  vm.runInContext(`${body}\nglobalThis.sceneBudget = requireSceneGeometryBudget;`, context);
  context.sceneBudget(entries, options);
  assert.deepEqual(seen.map(({ representation, atoms, presenting }) => ({ representation, atoms, presenting })), [
    { representation: 'spacefill', atoms: 58_870, presenting: true },
    { representation: 'spacefill', atoms: 600, presenting: true },
    { representation: 'cartoon', atoms: 58_870, presenting: true }]);
  assert.ok(seen.every(entry => entry.total === 118_340), 'the decision itself still carries the scene total');
  const judged = seen.map(entry => sphereTypeParams({ representation: entry.representation, presenting: entry.presenting,
    deviceClass: 'quest2', atoms: entry.atoms, heavyDetail: 0 }));
  assert.deepEqual(judged, [mesh(0), {}, {}], 'a small spacefill layer in a heavy scene keeps impostors');
});

test('the viewer tells the geometry decision when a lesson owns the scene', () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const body = name => { const start = viewer.indexOf(`function ${name}(`); return viewer.slice(start, viewer.indexOf('\n  }\n', start) + 4); };
  assert.match(body('geometryFor'), /lesson: lessonOwnsScene\(\)/);
  assert.match(body('sceneGeometry'), /lesson: Boolean\(figure\) \|\| lessonOwnsScene\(\)/);
  const owns = state => vm.runInNewContext(`${body('lessonOwnsScene')}\nlessonOwnsScene()`, state);
  assert.equal(owns({ lessonPlayback: undefined, lessonFigure: { geometryIdentity: () => undefined } }), false);
  assert.equal(owns({ lessonPlayback: { chapter: 2 }, lessonFigure: { geometryIdentity: () => undefined } }), true);
  assert.equal(owns({ lessonPlayback: undefined, lessonFigure: { geometryIdentity: () => ({ layers: [] }) } }), true);
  const figure = readFileSync(new URL('./lesson-figure.mjs', import.meta.url), 'utf8');
  assert.match(figure, /const geometryOptions = \{ quality: 'low', \.\.\.getGeometryOptions\(\), presenting, lesson: true \};/);
});

test('sphere:mesh applies the heavy-tier rule at the default’s detail, whatever the shipped default is', async () => {
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:mesh')), { sphereDetail: 'mesh' });
  assert.deepEqual(geometryDebugOptions(page('?xrRenderBudget=sphere:mesh,sphere:auto')), {}, 'auto still returns to the default');
  for (const heavyDetail of [null, 0, 1]) {
    const rule = { ...heavy, sphere: 'mesh', heavyDetail };
    assert.deepEqual(sphereTypeParams(rule), mesh(XR_SPHERE_MESH_DETAIL));
    assert.deepEqual(sphereTypeParams({ ...rule, presenting: false }), {}, 'the flat page keeps impostors');
    assert.deepEqual(sphereTypeParams({ ...rule, deviceClass: 'quest3' }), {}, 'an unmeasured headset keeps impostors');
    assert.deepEqual(sphereTypeParams({ ...rule, atoms: HEAVY_SCENE_ATOM_SITES }), {}, 'a scene at the heavy tier keeps impostors');
    assert.deepEqual(sphereTypeParams({ ...rule, lesson: true }), {}, 'a lesson past its own ceiling keeps impostors');
    assert.deepEqual(sphereTypeParams({ ...rule, lesson: true, atoms: 40_908 }), mesh(XR_LESSON_SPHERE_MESH_DETAIL), 'a lesson under it takes its own detail');
    assert.deepEqual(sphereTypeParams({ ...rule, reduced: true }), {}, 'a geometry reduction keeps its own detail');
    assert.deepEqual(sphereTypeParams({ ...rule, atoms: 70_000 }), {}, 'past the triangle ceiling, impostors');
    assert.deepEqual(sphereTypeParams({ ...rule, representation: 'cartoon' }), {});
  }
  const input = { ...heavy, bonds: 60_000, residues: 7_000, quality: 'low', standalone: true };
  await withAddress('?xrRenderBudget=sphere:mesh', () => {
    assert.deepEqual(requireGeometryBudget(input).typeParams, mesh(XR_SPHERE_MESH_DETAIL));
    assert.deepEqual(requireGeometryBudget({ ...input, lesson: true }).typeParams, {});
    assert.deepEqual(requireGeometryBudget({ ...input, atoms: 40_908, lesson: true }).typeParams, mesh(XR_LESSON_SPHERE_MESH_DETAIL));
    assert.deepEqual(requireGeometryBudget({ ...input, presenting: false }).typeParams, {});
  });
});

test('with no address key a heavy spacefill on a Quest 2 in a session draws the detail-1 sphere mesh', async () => {
  const input = { ...heavy, bonds: 60_000, residues: 7_000, quality: 'low', standalone: true };
  await withAddress('', () => {
    assert.deepEqual(requireGeometryBudget(input).typeParams, mesh(1), '1AON, 58,870 atoms');
    assert.deepEqual(requireGeometryBudget({ ...input, atoms: HEAVY_SCENE_ATOM_SITES + 1 }).typeParams, mesh(1));
    assert.deepEqual(requireGeometryBudget({ ...input, atoms: 62_500 }).typeParams, mesh(1), 'the triangle ceiling at detail 1');
    assert.deepEqual(requireGeometryBudget({ ...input, atoms: HEAVY_SCENE_ATOM_SITES }).typeParams, {}, 'at the heavy tier, impostors');
    assert.deepEqual(requireGeometryBudget({ ...input, atoms: 62_501 }).typeParams, {}, 'past the ceiling, impostors');
    assert.deepEqual(requireGeometryBudget({ ...input, lesson: true }).typeParams, {}, 'a lesson past its ceiling keeps impostors');
    assert.deepEqual(requireGeometryBudget({ ...input, atoms: 40_908, lesson: true }).typeParams, mesh(0), 'a lesson under it takes detail 0');
    assert.deepEqual(requireGeometryBudget({ ...input, presenting: false }).typeParams, {}, 'the flat page keeps impostors');
    for (const deviceClass of ['quest3', 'desktop', 'unknown'])
      assert.deepEqual(requireGeometryBudget({ ...input, deviceClass }).typeParams, {}, `${deviceClass} keeps impostors`);
    for (const representation of ['cartoon', 'ball-and-stick'])
      assert.deepEqual(requireGeometryBudget({ ...input, representation }).typeParams?.detail, undefined, `${representation} is not a sphere path`);
  });
  await withAddress('?xrRenderBudget=sphere:impostor', () => {
    assert.deepEqual(requireGeometryBudget(input).typeParams, { tryUseImpostor: true }, 'the address still chooses impostors');
  });
});
