import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { cameraSnapshot } from './camera-snapshot.mjs';
import { createLessonMotionHold, lessonCameraMove, lessonMotionApplies, normalizeLessonMotion } from './lesson-motion.mjs';
import { createPlacementHold } from './wearer-placement.mjs';
import { createSelectionAdapter } from './selection.mjs';
import { availableChains, emptyVisibility, hiddenRowKeys, normalizeVisibility, resolveVisibility, sameVisibility } from './inspection-visibility.mjs';
import { createDrawnSubsetCache, createVisibleStageBoundsCache } from './visible-stage-bounds.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import extraction from '../identity/extract.cjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { CIF } = require('molstar/lib/commonjs/mol-io/reader/cif.js');
const { trajectoryFromMmCIF } = require('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
const { Structure } = require('molstar/lib/commonjs/mol-model/structure/structure/structure.js');
const { StructureSymmetry } = require('molstar/lib/commonjs/mol-model/structure/structure/symmetry.js');

// Real hemoglobin: the catalog the host ships and the Mol* assembly it binds
// to, so hiding chain B and showing only a selection take real rows away.
let hemoglobin;
before(async () => {
  const bytes = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url));
  const parsed = await CIF.parse(bytes.toString('utf8')).run();
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const frame = trajectory.getFrameAtIndex(0);
  const model = typeof frame.run === 'function' ? await frame.run() : frame;
  const structure = await StructureSymmetry.buildAssembly(Structure.ofModel(model), '1').run();
  const catalog = await extraction.extractBytes(bytes, { sourceLabel: '4HHB', assemblyId: '1' });
  const { center, radius } = structure.boundary.sphere;
  hemoglobin = { catalog, selection: createSelectionAdapter(structure, catalog), sphere: { center: Vec3.clone(center), radius } };
  // Compile the turn path once, so the tick costs below are the steady ones a
  // headset sees from a chapter's second tick on, not the first call's.
  await hideThenShowOnly(headsetFixture());
});

// Hemoglobin's "Slow orbit": a 180-degree turntable over 9 s, sent by the tour
// player as 50 ms ticks of an eased fraction (tour-player.ts tickMotion).
const easeInOut = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
function turntableTicks(degrees = 180, seconds = 9) {
  const ticks = [], count = Math.round(seconds * 1000 / 50);
  let last = 0;
  for (let i = 1; i <= count; i += 1) {
    const fraction = easeInOut(i / count);
    ticks.push({ kind: 'orbit', axis: 'y', degrees: degrees * (fraction - last) });
    last = fraction;
  }
  return ticks;
}

/**
 * The real turn, pivot, visibility and orbit code over a camera whose view is
 * built the way Mol* builds it (`camera.js updateView`: a lookAt from the
 * camera-scaled position and target). In a headset that view is the
 * room-from-render transform (`viewer.mjs onHeadFrame`), so a render point's
 * room position is `view x (point x scale)`.
 *
 * The seat matches the one measured on hemoglobin's "Slow orbit": the
 * presented centre is about 3.8 m out, 1.4 m beyond the camera target and to
 * its right, with the placement turned 140 degrees and scaled 1.1 about the
 * model centre, as the chapter authors it. Turned about the target, that
 * centre ends about 1 m from the head.
 */
function headsetFixture({ presenting = true, animation, held = false } = {}) {
  const { catalog, selection, sphere } = hemoglobin;
  const scale = 0.01, offset = [60, 30, -140];
  const placement = Object.freeze({ scale: 1.1, rotation: [0, 140, 0], translation: offset.map(value => value / sphere.radius) });
  const target = Array.from(sphere.center);
  let state = { mode: 'perspective', fov: Math.PI / 4, position: [target[0], target[1], target[2] + 230], target, up: [0, 1, 0],
    radius: sphere.radius * 1.1, radiusMax: sphere.radius * 1.1, fog: 0, clipFar: true, minNear: 5, minFar: 0 };
  const saved = cameraSnapshot(state);
  const wearerPlacement = createPlacementHold();
  if (held) wearerPlacement.takeover('grab');
  const camera = {
    scale,
    getSnapshot: () => cameraSnapshot(state),
    setState(next) { state = { ...state, ...cameraSnapshot({ ...state, ...next }) }; },
    view() {
      const p = Vec3.scale(Vec3(), Vec3.create(...state.position), scale);
      const t = Vec3.scale(Vec3(), Vec3.create(...state.target), scale);
      return Mat4.lookAt(Mat4(), p, t, Vec3.create(...state.up));
    },
  };
  let turning = false;
  const mutations = [], subsets = new Set(), lociRequests = [];
  const cachedDrawnSubset = createDrawnSubsetCache();
  const h = vm.createContext({
    Mat4, Vec3, cameraSnapshot, lessonCameraMove, lessonMotionApplies, normalizeLessonMotion,
    availableChains, emptyVisibility, hiddenRowKeys, normalizeVisibility, resolveVisibility, sameVisibility,
    lessonMotionHold: createLessonMotionHold(),
    wearerPlacement,
    interactionActive: () => false,
    assertReady() {},
    failure: (code, message) => Object.assign(Error(message), { code }),
    canvas: { camera, xr: { isPresenting: { value: presenting } }, webgl: { isContextLost: false }, requestDraw() {}, mark() {} },
    liveScene: () => ({ camera: saved, sourceSha256: 'fixture', modelNumber: 1, assemblyId: '1' }),
    sourceRecord: { catalog }, selection: { ...selection, toLoci: keys => { lociRequests.push(keys); return { keys }; } },
    volume: undefined, visibleStage: undefined, representation: undefined,
    state: { selectionKeys: [] }, visibilityState: emptyVisibility(), stylesState: [], styleLayers: [],
    loadedSphere: () => sphere, cachedVisibleStageBounds: createVisibleStageBoundsCache(),
    cachedDrawnSubset(input) { const subset = cachedDrawnSubset(input); if (subset) subsets.add(subset.keys); return subset; },
    drawnSubsetLoci: undefined, staticMaskKeys: () => [],
    molecularAnimation: animation ?? { snapshot: () => null, drawnSphere: () => assert.fail('no animation is installed') },
    inspectionState: { placement: () => placement, recordPayload() {}, setPayload() {} },
    motionAngle: 0, grabOffset: undefined, grabTransform: () => undefined,
    markRecord() {}, retainCurrent() {},
    syncInspectionPayload() {}, inspectionPayload: () => ({}),
    paintSelectionOverlay: async () => {}, paintVisibilityLayers: async () => {},
    rebuildInspectionLabels: async () => {}, rebuildComponentLabels: async () => {},
    snapshot: () => ({}),
    // A chapter turn is a camera move. It may not re-pose or rebuild the
    // molecule, and it may not commit an inspection edit. The agent's own
    // `orbit` and visibility edits are saved edits and do.
    async inspectionMutation(apply) {
      if (turning) assert.fail('a lesson turn committed an inspection mutation');
      mutations.push(apply); await apply();
    },
    applyInspectionTransform: () => assert.fail('a turn re-posed the molecule'),
    mutate: () => assert.fail('a lesson turn committed a mutation'),
  });
  for (const name of ['applyLessonMotion', 'headsetTurnPivot', 'drawnCenter', 'pivotCenter', 'catalogVisibleBounds',
    'placementTransform', 'presentationTransform', 'orbit', 'setSceneVisibility', 'visibilityChains',
    'markSelection', 'hiddenSceneKeys', 'hiddenSceneKeySet']) vm.runInContext(pageFunction(source, name), h);
  const seat = h.presentationTransform();
  const toRoom = point => Array.from(Vec3.transformMat4(Vec3(),
    Vec3.scale(Vec3(), Vec3.transformMat4(Vec3(), Vec3.create(...point), seat), scale), camera.view()));
  return {
    h, camera, placement, toRoom, mutations, subsets, lociRequests, state: () => state,
    async tick(move) { turning = true; try { await h.applyLessonMotion(move); } finally { turning = false; } },
  };
}

/** The centre of the rows the wearer can see, measured here, not by the viewer. */
function rowsCentre(keep) {
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const row of hemoglobin.selection.rows) {
    if (!keep(row)) continue;
    for (const atom of row.atomSites ?? []) atom.assemblyCoordinatesAngstrom.forEach((value, axis) => {
      minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value);
    });
  }
  return minimum.map((value, axis) => (value + maximum[axis]) / 2);
}

// The wearer stands still for the whole chapter, a little off the room origin.
const head = [0.05, 0.02, 0.1];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const percentile95 = values => [...values].sort((x, y) => x - y)[Math.floor(values.length * .95)];

test('held XR orbit, turntable and camera-spin chapters turn in place without changing placement or ownership', async t => {
  for (const reason of ['grab', 'voice-move', 'voice-scale']) {
    for (const ticks of [
      Array.from({ length: 60 }, () => ({ kind: 'orbit', axis: 'x', degrees: 0.5 })),
      turntableTicks(),
      // A lesson's desktop camera spin, carried to the headset about its own axis.
      Array.from({ length: 60 }, () => ({ kind: 'orbit', axis: [0, -1, 0], degrees: 6 })),
    ]) {
      const fixture = headsetFixture({ held: true });
      fixture.h.wearerPlacement.takeover(reason);
      const owner = fixture.h.wearerPlacement.ownership().token;
      const heldPlacement = structuredClone(fixture.placement);
      const before = fixture.camera.getSnapshot();
      const { drift, costs } = await follow(fixture, ticks, () => hemoglobin.sphere.center);
      assert.notDeepEqual(fixture.camera.getSnapshot().position, before.position, `${reason}: the chapter must turn`);
      assert.ok(drift < 1e-6, `${reason}: the drawn centre stays in place`);
      assert.deepEqual(fixture.placement, heldPlacement, 'held translation and scale stay exact');
      assert.equal(fixture.h.wearerPlacement.ownership().token, owner);
      fixture.h.wearerPlacement.chapterStart();
      assert.equal(fixture.h.wearerPlacement.holdsPlacement(), true, 'later chapters still respect the hold');
      assert.equal(fixture.subsets.size, 0, 'no atom scans for the full drawn structure');
      const p95 = percentile95(costs);
      t.diagnostic(`${reason}: ${ticks.length} ticks, p95 ${p95.toFixed(3)} ms`);
      assert.ok(p95 < 2, `held pose work costs ${p95} ms at p95`);
    }
  }
});

test('a held XR dolly stays suppressed between permitted orbit ticks', async () => {
  const fixture = headsetFixture({ held: true });
  const before = fixture.camera.getSnapshot();
  await fixture.tick({ kind: 'dolly', factor: 0.9 });
  assert.deepEqual(fixture.camera.getSnapshot(), before);
  assert.equal(fixture.h.lessonMotionHold.holding(), false, 'suppressed motion does not pin a camera');
  await fixture.tick({ kind: 'orbit', axis: 'y', degrees: 10 });
  const turned = fixture.camera.getSnapshot();
  assert.notDeepEqual(turned, before, 'the placement hold permits rotation');
  await fixture.tick({ kind: 'dolly', factor: 1.1 });
  assert.deepEqual(fixture.camera.getSnapshot(), turned);
  assert.equal(fixture.h.wearerPlacement.holdsPlacement(), true);
});

test('active gripping blocks every tick; releasing permits a turn while retaining placement', async () => {
  for (const held of [false, true]) {
    const fixture = headsetFixture({ held });
    const before = fixture.camera.getSnapshot();
    fixture.h.interactionActive = () => true;
    for (const move of [{ kind: 'orbit', axis: 'y', degrees: 10 }, { kind: 'dolly', factor: 0.9 }]) {
      await fixture.tick(move);
      assert.deepEqual(fixture.camera.getSnapshot(), before);
    }
    assert.equal(fixture.h.lessonMotionHold.holding(), false);
    fixture.h.interactionActive = () => false;
    await fixture.tick({ kind: 'orbit', axis: 'y', degrees: 10 });
    assert.notDeepEqual(fixture.camera.getSnapshot(), before, 'the released molecule turns');
    assert.equal(fixture.h.wearerPlacement.holdsPlacement(), held);
  }
});

test('the hold exception is XR-only; desktop keeps its existing orbit and dolly behavior', async () => {
  for (const move of [{ kind: 'orbit', axis: 'y', degrees: 10 }, { kind: 'dolly', factor: 0.9 }]) {
    for (const held of [false, true]) {
      const fixture = headsetFixture({ presenting: false, held });
      const before = fixture.camera.getSnapshot();
      await fixture.tick(move);
      const expected = held ? before : cameraSnapshot({ ...before, ...lessonCameraMove(before, move) });
      assert.deepEqual(fixture.camera.getSnapshot(), expected);
    }
  }
  const xr = headsetFixture({ held: true });
  const before = xr.camera.getSnapshot();
  await xr.tick({ kind: 'orbit', axis: 'y', degrees: 10 });
  assert.notDeepEqual(xr.camera.getSnapshot(), before, 'only XR gets the held orbit exception');
});

test('a held turn follows the drawn subset and never rescans atoms on steady ticks', async () => {
  const fixture = headsetFixture({ held: true });
  const { h } = fixture;
  let guardAtoms = false;
  h.selection.rows = h.selection.rows.map(row => ({ ...row, get atomSites() {
    assert.equal(guardAtoms, false, 'a held turn must not rescan atoms');
    return row.atomSites;
  } }));
  await h.setSceneVisibility(resolveVisibility(h.visibilityState, { op: 'only', chains: ['A'] }, h.visibilityChains()));
  const center = rowsCentre(row => row.identity.labelChain === 'A');
  h.drawnCenter(); // Measure the new subset before its steady ticks.
  const measured = fixture.subsets.size;
  guardAtoms = true;
  const before = fixture.camera.getSnapshot();
  const { drift, costs } = await follow(fixture, turntableTicks(), () => center);
  assert.notDeepEqual(fixture.camera.getSnapshot(), before);
  assert.ok(drift < 1e-6, 'the drawn chain, not the full assembly, stays in place');
  assert.equal(fixture.subsets.size, measured);
  assert.ok(percentile95(costs) < 2);
});

/** Turn through `ticks`, following the room position of whatever `centre()` names now. */
async function follow(fixture, ticks, centre) {
  const start = fixture.toRoom(centre());
  let drift = 0, nearest = distance(start, head), degrees = 0;
  const costs = [];
  for (const tick of ticks) {
    const began = performance.now();
    await fixture.tick(tick);
    costs.push(performance.now() - began);
    degrees += tick.degrees;
    const now = fixture.toRoom(centre());
    drift = Math.max(drift, distance(now, start));
    nearest = Math.min(nearest, distance(now, head));
  }
  return { start, drift, nearest, degrees, startDistance: distance(start, head), costs };
}

test('a headset lesson turn keeps the molecule centre fixed in the room and never brings it closer', async t => {
  const fixture = headsetFixture();
  const { drift, nearest, startDistance, costs } = await follow(fixture, turntableTicks(), () => hemoglobin.sphere.center);
  const p95 = percentile95(costs);
  t.diagnostic(`room drift ${(drift * 100).toFixed(4)} cm; nearest ${nearest.toFixed(3)} m of ${startDistance.toFixed(3)} m; tick p95 ${p95.toFixed(3)} ms`);
  assert.ok(p95 < 2, `a turn tick costs ${p95} ms at p95`);
  assert.ok(startDistance > 3 && startDistance < 4.5, `fixture seats the molecule ${startDistance.toFixed(2)} m out`);
  assert.ok(drift <= 0.02, `presented centre drifted ${(drift * 100).toFixed(2)} cm in the room during the turn`);
  assert.ok(nearest >= startDistance - 1e-6,
    `the turn brought the centre to ${nearest.toFixed(3)} m from the head, closer than its ${startDistance.toFixed(3)} m start`);
  assert.equal(fixture.subsets.size, 0, 'with nothing hidden the turn reads the stage centre and never scans rows');
});

/**
 * Hemoglobin's slow orbit with real visibility edits around it. Before the
 * turn the agent shows only chains A and B, one alpha-beta dimer. A third of
 * the way round it hides chain B, so chain A is all the wearer sees, and chain
 * A is what must turn in place. Two thirds of the way round it selects chain
 * A's first 40 residues and shows only them.
 */
async function hideThenShowOnly(fixture) {
  const { h } = fixture;
  const ticks = turntableTicks();
  const edit = patch => h.setSceneVisibility(resolveVisibility(h.visibilityState, patch, h.visibilityChains()));
  await edit({ op: 'only', chains: ['A', 'B'] });
  const dimer = rowsCentre(row => ['A', 'B'].includes(row.identity.labelChain));
  const both = await follow(fixture, ticks.slice(0, 60), () => dimer);
  await edit({ op: 'hide', chains: ['B'] });
  assert.ok(h.visibilityState.hiddenChains.some(chain => chain.labelChain === 'B'));
  const chainA = rowsCentre(row => row.identity.labelChain === 'A');
  const hidden = await follow(fixture, ticks.slice(60, 120), () => chainA);
  const picked = hemoglobin.selection.rows.filter(row => row.identity.labelChain === 'A' && row.identity.labelSequenceId <= 40)
    .map(row => row.key);
  h.markSelection(picked);
  await edit({ op: 'only', selection: true });
  assert.equal(h.visibilityState.showOnlySelection, true);
  const only = rowsCentre(row => picked.includes(row.key));
  const shown = await follow(fixture, ticks.slice(120), () => only);
  return [['only chains A and B', both], ['chain B hidden', hidden], ['only the selection', shown]];
}

test('a chain hidden mid-turn, then a selection shown alone, each stays put for the rest of the turn', async t => {
  const fixture = headsetFixture();
  // The same turn about the stage centre, which is what the pivot was: the
  // part left on screen swings around the empty middle of the assembly.
  const stagePivot = headsetFixture();
  stagePivot.h.drawnCenter = () => stagePivot.h.pivotCenter();
  const phases = await hideThenShowOnly(fixture), swung = await hideThenShowOnly(stagePivot);
  phases.forEach(([name, phase], index) => {
    const before = swung[index][1];
    t.diagnostic(`${name}: ${phase.degrees.toFixed(1)} degrees; drift ${(phase.drift * 100).toFixed(4)} cm `
      + `(${(before.drift * 100).toFixed(1)} cm about the stage centre); nearest ${phase.nearest.toFixed(3)} m of ${phase.startDistance.toFixed(3)} m`);
    assert.ok(phase.degrees > 20 && before.drift > 0.02, `${name} is a discriminating part of the turn`);
    assert.ok(phase.drift <= 0.02, `${name}: the visible part drifted ${(phase.drift * 100).toFixed(2)} cm in the room`);
    assert.ok(phase.nearest >= phase.startDistance - 1e-6, `${name}: the turn brought the visible part closer to the head`);
    assert.ok(percentile95(phase.costs) < 2, `${name}: a turn tick costs ${percentile95(phase.costs)} ms at p95`);
  });
  assert.equal(fixture.mutations.length, 3, 'only the three visibility edits were saved');
  assert.equal(fixture.subsets.size, 3, 'the drawn rows were measured once per visibility change, not once per tick');
  assert.equal(fixture.lociRequests.length, 0, 'a static scene never builds a Mol* loci for the pivot');
});

test('an animated chapter pivots on its posed, drawn bodies and builds their loci once per subset', async () => {
  // The animation registry poses the bodies; here it reports a body moving
  // along x, as `drawnSphere` composes it from cached bounds per tick.
  let x = 0;
  const seen = new Set();
  const animation = { snapshot: () => ({ id: 'walk' }), drawnSphere(loci) { seen.add(loci); return { center: [x, 1, 2], radius: 5 }; } };
  const fixture = headsetFixture({ animation });
  const { h } = fixture;
  for (const step of [0, 4, 8]) {
    x = step;
    assert.deepEqual(Array.from(h.drawnCenter()), [step, 1, 2], 'the pivot follows the current pose');
  }
  assert.equal(seen.size, 1, 'one loci for one drawn subset');
  assert.equal(fixture.lociRequests.length, 1);
  await h.setSceneVisibility(resolveVisibility(h.visibilityState, { op: 'hide', chains: ['C'] }, h.visibilityChains()));
  h.drawnCenter(); h.drawnCenter();
  assert.equal(fixture.lociRequests.length, 2, 'a visibility change builds the new subset once');
  assert.ok(!fixture.lociRequests[1].some(key => hemoglobin.selection.rows.find(row => row.key === key).identity.labelChain === 'C'));
  // A subset the animation draws none of falls back to the rows' own box.
  animation.drawnSphere = () => undefined;
  assert.deepEqual(Array.from(h.drawnCenter()), rowsCentre(row => row.identity.labelChain !== 'C'));
});

test('in a headset the agent orbit turns the visible molecule in place', async t => {
  const fixture = headsetFixture();
  const { h } = fixture;
  await h.setSceneVisibility(resolveVisibility(h.visibilityState, { op: 'hide', chains: ['B', 'D'] }, h.visibilityChains()));
  const alphas = rowsCentre(row => !['B', 'D'].includes(row.identity.labelChain));
  const start = fixture.toRoom(alphas), startDistance = distance(start, head);
  let drift = 0, nearest = startDistance;
  for (const [axis, degrees] of [['y', 90], ['x', 45], ['y', -170], ['z', 30]]) {
    await h.orbit(axis, degrees);
    const now = fixture.toRoom(alphas);
    drift = Math.max(drift, distance(now, start));
    nearest = Math.min(nearest, distance(now, head));
  }
  t.diagnostic(`agent orbit drift ${(drift * 100).toFixed(4)} cm; nearest ${nearest.toFixed(3)} m of ${startDistance.toFixed(3)} m`);
  assert.ok(drift <= 0.02, `the visible chains drifted ${(drift * 100).toFixed(2)} cm in the room`);
  assert.ok(nearest >= startDistance - 1e-6, 'the orbit brought the molecule closer to the head');
  assert.equal(fixture.mutations.length, 5, 'each rotate is still one saved edit');
  assert.equal(h.inspectionState.placement(), fixture.placement, 'the wearer placement is never written');
  assert.deepEqual(fixture.placement.rotation, [0, 140, 0]);
});

test('the flat page keeps orbiting about the camera target', async () => {
  const fixture = headsetFixture({ presenting: false });
  const before = fixture.state();
  await fixture.h.orbit('y', 90);
  const after = fixture.state();
  // The desktop arithmetic, unchanged: the eye vector turns about the target.
  const rotation = Mat4.fromRotation(Mat4(), Math.PI / 2, Vec3.create(0, 1, 0));
  const eye = Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), Vec3.create(...before.position), Vec3.create(...before.target)), rotation);
  assert.deepEqual(after.target, before.target);
  assert.deepEqual(after.position, cameraSnapshot({ ...before, position: Array.from(Vec3.add(Vec3(), Vec3.create(...before.target), eye)) }).position);
});

test('the headset turn is still a full 180-degree turntable of the molecule', async () => {
  const fixture = headsetFixture();
  const before = fixture.state();
  await follow(fixture, turntableTicks(), () => hemoglobin.sphere.center);
  const after = fixture.state();
  // The eye looked along -Z before the turn and along +Z after it: the room
  // turned half a revolution about the molecule, so the wearer sees its back.
  const look = camera => Vec3.normalize(Vec3(), Vec3.sub(Vec3(), Vec3.create(...camera.target), Vec3.create(...camera.position)));
  assert.ok(Vec3.dot(look(before), look(after)) < -0.9999, 'the view direction reversed');
  assert.ok(Math.abs(Vec3.distance(Vec3.create(...after.position), Vec3.create(...after.target))
    - Vec3.distance(Vec3.create(...before.position), Vec3.create(...before.target))) < 1e-6, 'the eye distance is kept');
});

test('the flat page keeps turning a lesson chapter about the camera target', async () => {
  // The same seat on the Mac: the orbit is the desktop one, about the target,
  // and the target never moves. The presented centre is not held there, which
  // is the swing the headset path exists to avoid.
  const fixture = headsetFixture({ presenting: false });
  const target = [...fixture.state().target];
  const { drift } = await follow(fixture, turntableTicks(), () => hemoglobin.sphere.center);
  assert.deepEqual(fixture.state().target, target);
  assert.ok(drift > 1, `turning about the target carries an offset seat ${drift.toFixed(2)} m`);
});


test('removing animation pivots on the static t=0 copy and reuses its measurements through a turn', async () => {
  let animated = true;
  const fixture = headsetFixture({ animation: { snapshot: () => animated ? {} : null,
    drawnSphere: () => ({ center: [0, 0, 0], radius: 1 }) } });
  const { h } = fixture;
  let guardAtoms = false;
  h.selection.rows = h.selection.rows.map(row => ({ ...row, get atomSites() {
    assert.equal(guardAtoms, false, 'steady turn must not rescan atoms');
    return row.atomSites;
  } }));
  let mask = hemoglobin.selection.rows.filter(row => row.identity.labelChain !== 'A').map(row => row.key);
  h.staticMaskKeys = () => mask;
  h.drawnCenter();
  assert.equal(fixture.lociRequests[0].length, hemoglobin.selection.rows.length, 'live motion owns visibility');
  animated = false;
  const center = rowsCentre(row => row.identity.labelChain === 'A');
  assert.deepEqual(Array.from(h.drawnCenter()), center, 'hidden copies cannot shift the static pivot');
  const measured = fixture.subsets.size;
  // Even reading atomSites again is forbidden on steady turn ticks.
  guardAtoms = true;
  const result = await follow(fixture, turntableTicks(), () => center);
  assert.ok(result.drift < 1e-6);
  assert.equal(fixture.subsets.size, measured);
  guardAtoms = false;
  mask = hemoglobin.selection.rows.filter(row => row.identity.labelChain !== 'B').map(row => row.key);
  assert.deepEqual(Array.from(h.drawnCenter()), rowsCentre(row => row.identity.labelChain === 'B'));
  assert.equal(fixture.subsets.size, measured + 1, 'a new static mask remeasures once');
  mask = [];
  assert.deepEqual(Array.from(h.drawnCenter()), Array.from(hemoglobin.sphere.center));
});
