import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { preserveSourceTransitionAnchor, transformedVisibleCenter } from './source-transition-anchor.mjs';

/**
 * The anchor arithmetic is exact, and the camera is what broke it.
 *
 * In the headset every grown tier arrived smaller than the one it replaced and
 * further away — the wall (40,908 atom sites) ended as a speck near the ceiling
 * of the room. The arithmetic below was never wrong. What was wrong is that
 * `showCandidate` ran
 * `canvas.requestCameraReset` on the way, and in XR the camera IS the room
 * frame: `onHeadFrame` builds `roomFromRender` by decomposing
 * `canvas.camera.view`, so re-fitting the camera to a six-times-larger structure
 * moved the render origin metres away from where the anchor had been solved.
 */

/** The microtubule tiers, as their bounding spheres actually relate. */
const MONOMER = { center: [10, 4, -2], radius: 24 };
const WALL = { center: [-30, 55, 120], radius: 150 };
const PLACEMENT = { translation: [0.2, -0.35, 1.1], rotation: [0, 25, 0], scale: 2.2 };

for (const next of [{ center: [9, 10, 7], radius: 15 }, { center: [900, -400, 600], radius: 2 }]) {
  test(`a smaller or offset source preserves room position within placement limits (${next.radius})`, () => {
    const prior = { center: [0, 0, 0], radius: 35 };
    const placement = { translation: [2, -1, 9], rotation: [12, 25, -7], scale: 1.2 };
    const camera = { position: [40, -30, 100], target: [5, 3, -2], up: [0, 1, 0] };
    const anchor = preserveSourceTransitionAnchor({ priorBase: prior, priorPlacement: placement,
      priorCameraScale: .02, nextBase: next });
    assert.ok(anchor.placement.translation.every(value => Math.abs(value) <= 1e6));
    assert.ok(anchor.placement.scale >= 1e-6 && anchor.placement.scale <= 1e6);
    assert.deepEqual(anchor.placement.rotation, placement.rotation);
    const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  function setXrCameraScale(');
    const writes = [], current = structuredClone(camera);
    const c = vm.createContext({ canvas: { xr: { isPresenting: { value: true } }, camera: {
      scale: .02, getSnapshot: () => structuredClone(current),
      setState: value => { writes.push(value); Object.assign(current, value); },
    } }, failure: (code, message) => Object.assign(Error(message), { code }) });
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), c);
    c.setXrCameraScale(anchor);
    const before = transformedVisibleCenter({ base: prior, placement });
    const after = transformedVisibleCenter({ base: next, placement: anchor.placement });
    // The source and Mol* reference origin move together. The tracked head,
    // stereo baseline and viewing direction remain in the same room frame.
    for (const axis of [0, 1, 2]) {
      assert.ok(Math.abs((before[axis] - camera.position[axis]) * .02
        - (after[axis] - current.position[axis]) * anchor.cameraScale) < 1e-9);
      assert.ok(Math.abs((camera.target[axis] - camera.position[axis]) * .02
        - (current.target[axis] - current.position[axis]) * anchor.cameraScale) < 1e-9);
    }
    assert.ok(Math.abs(prior.radius * placement.scale * .02 - next.radius * anchor.placement.scale * anchor.cameraScale) < 1e-9);
    assert.deepEqual(current.up, camera.up);
    assert.equal(writes.length, 1);
  });
}

test('a preserved anchor keeps the tier exactly where the last one stood, at the same room size', () => {
  const anchor = preserveSourceTransitionAnchor({
    priorBase: MONOMER, priorVisible: MONOMER, priorPlacement: PLACEMENT, priorCameraScale: 0.004,
    nextBase: WALL, nextVisible: WALL,
  });
  // Same camera scale in and out, so the whole preservation is in the placement.
  assert.equal(anchor.cameraScale, 0.004);
  assert.equal(anchor.usedCameraScale, false);
  const before = transformedVisibleCenter({ base: MONOMER, visible: MONOMER, placement: PLACEMENT });
  const after = transformedVisibleCenter({ base: WALL, visible: WALL, placement: anchor.placement });
  for (const axis of [0, 1, 2]) assert.ok(Math.abs(after[axis] - before[axis]) < 1e-9,
    `axis ${axis} moved by ${after[axis] - before[axis]} render units`);
  // Apparent radius is radius x placement scale. Same in, same out.
  assert.ok(Math.abs(WALL.radius * anchor.placement.scale - MONOMER.radius * PLACEMENT.scale) < 1e-9);
  // And the tier that is six times the molecule is placed six times smaller, not
  // shown six times smaller. That distinction is the whole defect.
  assert.ok(anchor.placement.scale < PLACEMENT.scale);
});

test('the wearer keeps their own orientation across a grow', () => {
  const anchor = preserveSourceTransitionAnchor({
    priorBase: MONOMER, priorVisible: MONOMER, priorPlacement: PLACEMENT, priorCameraScale: 0.004,
    nextBase: WALL, nextVisible: WALL,
  });
  assert.deepEqual(anchor.placement.rotation, PLACEMENT.rotation);
});

test('a source swap that preserves the room anchor never touches the XR camera', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function showCandidate');
  assert.ok(start > 0, 'showCandidate is gone from viewer.mjs');
  const body = source.slice(start, source.indexOf('async function restoreRecord', start))
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  // The preserving branch comes first and does nothing, so neither
  // `requestCameraReset` nor a camera fit can run underneath it.
  assert.match(body, /if \(settings\.preserveRoomPlacement\) \{[^}]*\}\s*\n\s*else if \(settings\.camera\)/);
  // Every remaining camera move is guarded by having NOT preserved the anchor.
  const guard = body.indexOf('else if (settings.camera)');
  const moves = [...body.matchAll(/requestCameraReset|focusSnapshot|focusSphere|camera\.setState/gu)];
  assert.ok(moves.length >= 4, 'the camera branches are gone from showCandidate');
  for (const move of moves) {
    assert.ok(move.index > guard,
      `${move[0]} runs before the preserveRoomPlacement guard`);
  }
});

// The framing path has the same escape, and it has to spend it in the same
// place — on the camera, before anything is baked.
test('a framing too big for the placement floor spends the scene scale before the travel', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function focusSelection(');
  assert.ok(start > 0, 'focusSelection is gone from viewer.mjs');
  const body = source.slice(start, source.indexOf('async function setCamera', start))
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  // The plan says whether it needed the escape; nothing here decides that again.
  assert.match(body, /if \(plan\.usedCameraScale\) \{\n\s*setXrCameraScale\(\{ cameraScale: plan\.cameraScale \}\);/);
  // The far plane is XR_FAR_METERS divided by the scene scale, so a changed
  // scale leaves the depth band describing the scene that is gone.
  assert.match(body, /plan\.usedCameraScale[\s\S]{0,300}lastDepthMinFar = 0; applyImmersiveDepth\(\);/);
  // Before the travel: the plan's translation is solved in the new scale, so a
  // travel that ran first would ease every offset through the old room frame.
  assert.ok(body.indexOf('setXrCameraScale({ cameraScale: plan.cameraScale })') < body.indexOf('await focusTravel('),
    'the scene scale is spent after the travel has already moved the structure');
  // And the sizes that explain the framing are recorded with the frame.
  assert.match(body, /recordManipulation\('xr-focus'[\s\S]{0,600}sceneScale: Number\(plan\.cameraScale\.toPrecision\(6\)\)/);
});

test('the grown tier opens its own lesson rather than keeping the anchor alone', () => {
  const source = readFileSync(new URL('../../plugin/src/inspector.ts', import.meta.url), 'utf8');
  // The rule lives in tour-player.ts; this is the one place that carries it out.
  assert.match(source, /grownTierIntent\(\{presenting:/);
  assert.match(source, /if\(swappedSource && !restoredLessonPlayback\)await openGrownTier\(/);
  // The lesson state has to be read BEFORE hydrate stops the tour, or a wearer
  // mid-lesson is indistinguishable from one who had put it away.
  const hydrate = source.slice(source.indexOf('async function hydrate('));
  assert.ok(hydrate.indexOf('const priorTour=tourPlayer?.getState();')
    < hydrate.indexOf("tourPlayer?.stop('Tour stopped"),
    'the tour state is read after it has already been stopped');
});
