import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import { focusPlacement } from './focus-placement.mjs';
import { pivotPreservingTranslation } from './presentation-pivot.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const production = name => {
  const start = viewer.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `production ${name}`);
  return viewer.slice(start, viewer.indexOf('\n  }\n', start) + 5);
};
const baseCenter = [35.2, 18.7, -12.4], targetCenter = [63, 27, 4], visibleCenter = [49.2, 9.7, -6.4], radius = 61;
const yaw = degrees => Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, Vec3.create(0, 1, 0));
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const close = (a, b, tolerance = .001) => assert.ok(distance(a, b) < tolerance, `${a} ≈ ${b}`);
const copy = value => structuredClone(value);

function matrixHarness(stage = false) {
  const headInRoom = Mat4.fromTranslation(Mat4(), Vec3.create(.2, 1.6, .5));
  const renderFromRoom = yaw(40); renderFromRoom[12] = .4; renderFromRoom[13] = -.2; renderFromRoom[14] = .3;
  const roomFromRender = Mat4.invert(Mat4(), renderFromRoom);
  const prior = { rotation: [21,-43,67], translation: [1,2,-1], scale: 5.93 };
  const options = { headInRoom, renderFromRoom, cameraScale: .01, center: baseCenter, radius,
    placement: prior, targetCenter, targetRadius: 10, framing: 'fill' };
  const first = focusPlacement(options);
  // Solve the same physical focus with the user's enlarged 5.93 placement.
  const plan = focusPlacement({ ...options, cameraScale: first.scale * .01 / 5.93 });
  assert.ok(Math.abs(plan.scale - 5.93) < 1e-12);
  let placement = { rotation: prior.rotation, translation: plan.translation, scale: plan.scale };
  const policy = createGesturePivot(), source = {}, subject = stage ? {} : undefined;
  const fallbackCenter = stage ? visibleCenter : baseCenter;
  const context = () => ({ source, subject, placement, fallbackCenter });
  const h = vm.createContext({ Mat4, Vec3, Euler, inspectionState: { placement: () => copy(placement) },
    loadedSphere: () => ({ center: baseCenter, radius }),
    pivotCenter: () => fallbackCenter, gesturePivot: policy, sourceRecord: source, visibleStage: subject, focusPivotRequest: undefined,
    motionAngle: 0, grabRotation: undefined, grabScale: 1, grabOffset: undefined,
    failure: (code, message) => Object.assign(Error(message), { code }) });
  for (const name of ['placementTransform', 'grabTransform', 'gesturePivotContext', 'beginGesturePivot', 'gesturePivotCenter',
    'pivotBounds', 'grabPivotBounds', 'presentationTransform', 'rotationFromPlacement', 'rotationDegreesZYX'])
    vm.runInContext(production(name), h);
  const world = (point = targetCenter) => {
    const drawn = Vec3.transformMat4(Vec3(), point, h.presentationTransform());
    return Array.from(Vec3.transformMat4(drawn, Vec3.scale(drawn, drawn, plan.cameraScale), roomFromRender));
  };
  const remember = () => policy.rememberFocus({ ...context(), targetCenter });
  const bake = () => {
    const before = placement;
    const next = { rotation: h.rotationDegreesZYX(Mat4.mul(Mat4(), h.grabRotation ?? Mat4.identity(), h.rotationFromPlacement(before))),
      scale: before.scale * h.grabScale };
    next.translation = pivotPreservingTranslation(h.grabPivotBounds(), before, next, h.grabOffset);
    placement = next;
    policy.commit({ ...context(), token: policy.ownership(), previousPlacement: before });
    h.grabRotation = undefined; h.grabScale = 1; h.grabOffset = undefined;
  };
  return { h, policy, world, remember, bake, context, plan };
}

for (const stage of [false, true]) {
  test(`real focusPlacement target orbits with the old ${stage ? 'stage' : 'source'} pivot at scale 5.93`, () => {
    const h = matrixHarness(stage), before = h.world();
    close(before, h.plan.targetRoom);
    // No focused gesture latch: this executes the previous source/stage pivot.
    h.h.grabRotation = yaw(90);
    assert.ok(distance(before, h.world()) > .5, 'quarter turn exposes the off-center orbit');
    h.h.grabRotation = yaw(360); close(before, h.world());
  });

  test(`focused ${stage ? 'stage' : 'source'} target stays within 1 mm through 90/360 yaw and production bake math`, () => {
    const h = matrixHarness(stage); h.remember(); h.h.beginGesturePivot();
    const before = h.world();
    const originalSource = h.world(baseCenter);
    for (let degrees = 1; degrees <= 360; degrees++) {
      h.h.grabRotation = Mat4.mul(Mat4(), yaw(1), h.h.grabRotation ?? Mat4.identity()); close(before, h.world());
      if (degrees === 90) {
        const beforeBake = h.world(); h.bake(); close(beforeBake, h.world());
        h.h.beginGesturePivot();
      }
    }
    close(originalSource, h.world(baseCenter)); // Full turn restores non-pivot geometry too.
    const beforeBake = h.world(); h.bake(); close(beforeBake, h.world()); close(originalSource, h.world(baseCenter));
    h.h.beginGesturePivot(); h.h.grabRotation = yaw(90); close(before, h.world());
  });

  test(`focused ${stage ? 'stage' : 'source'} pivot carries deliberate travel and scale continuously through bake`, () => {
    const h = matrixHarness(stage); h.remember(); h.h.beginGesturePivot();
    h.h.grabRotation = yaw(90); h.h.grabScale = 1.4; h.h.grabOffset = [3,-2,5];
    const points = [targetCenter, baseCenter, visibleCenter, [13,4,-9]];
    const before = points.map(point => h.world(point)); h.bake();
    points.forEach((point, i) => close(before[i], h.world(point)));
  });
}

function policyHarness() {
  const policy = createGesturePivot();
  const context = { source: {}, subject: {}, placement: { scale: 5.93, rotation: [0,0,0], translation: [1,2,3] }, fallbackCenter: visibleCenter };
  policy.rememberFocus({ ...context, targetCenter });
  return { policy, context };
}

test('focus and gesture points are copied; selection-only changes cannot retarget a held gesture', () => {
  const { policy, context } = policyHarness();
  const selected = policy.begin(context); selected[0] = -999;
  assert.deepEqual(policy.read({ ...context, selection: ['another-residue'] }), targetCenter);
  context.fallbackCenter = [90,80,70];
  assert.deepEqual(policy.read(context), targetCenter, 'fallback bounds cannot drift during the owned gesture');
  policy.release(); assert.deepEqual(policy.read(context), context.fallbackCenter);
  assert.deepEqual(policy.begin(context), targetCenter, 'release without placement change can begin the same framed subject again');
});

for (const change of ['source', 'subject', 'translation', 'rotation', 'scale', 'reset']) test(`${change} invalidates stale focus ownership`, () => {
  const { policy, context } = policyHarness(); policy.begin(context);
  if (change === 'source' || change === 'subject') context[change] = {};
  else if (change === 'scale') context.placement.scale = 6;
  else if (change === 'reset') policy.invalidate();
  else context.placement[change][0] += 1;
  assert.deepEqual(policy.read(context), visibleCenter);
  assert.deepEqual(policy.begin(context), visibleCenter);
});

test('a newly framed target replaces the previous focus; an unowned bake cannot promote stale focus', () => {
  const { policy, context } = policyHarness(); policy.begin(context);
  const nextTarget = [6,7,8]; policy.rememberFocus({ ...context, targetCenter: nextTarget });
  assert.deepEqual(policy.begin(context), nextTarget);
  const old = copy(context.placement); context.placement = { ...context.placement, scale: 7 };
  assert.equal(policy.commit({ ...context, token: policy.ownership(), previousPlacement: { ...old, scale: 8 } }), false);
  assert.deepEqual(policy.begin(context), visibleCenter);
});

test('successful own bake keeps focus for the next gesture, but restoring an older pose does not', () => {
  const { policy, context } = policyHarness(); policy.begin(context);
  const previousPlacement = copy(context.placement);
  context.placement = { ...context.placement, rotation: [0,90,0], translation: [2,3,4] };
  assert.equal(policy.commit({ ...context, token: policy.ownership(), previousPlacement }), true);
  assert.deepEqual(policy.begin(context), targetCenter);
  context.placement = previousPlacement;
  assert.deepEqual(policy.begin(context), visibleCenter);
});

test('a stale bake cannot replace a retarget at the same pose or erase its new ownership', () => {
  const { policy, context } = policyHarness(); policy.begin(context);
  const token = policy.ownership(), previousPlacement = copy(context.placement);
  policy.rememberFocus({ ...context, targetCenter: [6,7,8] }); policy.begin(context);
  assert.equal(policy.isCurrent(token, context), false);
  assert.equal(policy.commit({ ...context, token, previousPlacement }), false);
  assert.deepEqual(policy.read(context), [6,7,8]);
  assert.equal(policy.isCurrent(policy.ownership(), context), true);
  policy.release(token); assert.deepEqual(policy.read(context), [6,7,8]);
});

test('source and stage replacement during a gesture reject its captured bake token', () => {
  for (const key of ['source', 'subject']) {
    const { policy, context } = policyHarness(); policy.begin(context);
    const token = policy.ownership(), previousPlacement = copy(context.placement);
    context[key] = {};
    assert.equal(policy.isCurrent(token, context), false);
    assert.equal(policy.commit({ ...context, token, previousPlacement }), false);
    assert.deepEqual(policy.begin(context), visibleCenter);
  }
});

test('presentation spin retains its stage pivot while the manual turn fixes the currently spun focused point', () => {
  const h = matrixHarness(true); h.remember();
  h.h.motionAngle = 37;
  const spun = h.world();
  h.h.beginGesturePivot();
  for (const degrees of [1,90,180,360]) { h.h.grabRotation = yaw(degrees); close(spun, h.world()); }
  h.h.grabRotation = undefined; h.policy.release();
  close(spun, h.world());
});
