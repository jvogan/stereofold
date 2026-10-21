import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { focusPlacement, focusRotation } from './focus-placement.mjs';
import { motionFocusPlacement, MOTION_SCALE_CAP } from './motion-framing.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from './spatial-toolbar-geometry.mjs';

const demos = JSON.parse(readFileSync(new URL('./fixtures/motion-demo-bounds.json', import.meta.url)));
export function demoPlans(demo) {
  // A reproducible level-head reference seat, not a physical-device measurement.
  const options = { headInRoom: Mat4.identity(), renderFromRoom: Mat4.identity(), cameraScale: .003,
    center: demo.source.center, radius: demo.source.radius,
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, framing: 'context', elevationDegrees: 0 };
  const previous = focusPlacement({ ...options, targetCenter: demo.source.center, targetRadius: demo.source.radius,
    subjectPoints: demo.source.extrema, assemblyPoints: demo.source.extrema, framing: 'fill', wholeStructure: true });
  const before = focusPlacement({ ...options, targetCenter: demo.whole.center, targetRadius: demo.whole.radius,
    assemblyRadius: Math.max(demo.source.radius, Vec3.distance(demo.source.center, demo.whole.center) + demo.whole.radius), wholeStructure: true });
  const after = motionFocusPlacement({ ...options, framing: 'fill', targetCenter: demo.target.center, targetRadius: demo.target.radius,
    previousScale: previous.scale });
  return { options, previous, before, after };
}

function checkTravel(demo, plan, options) {
  const rotation = focusRotation(options.placement.rotation);
  const roomFromRender = Mat4.invert(Mat4(), options.renderFromRoom);
  const headFromRoom = Mat4.invert(Mat4(), options.headInRoom);
  for (const body of demo.travel) for (const sphere of body.poses) {
    assert.ok(Vec3.distance(sphere.center, demo.target.center) + sphere.radius <= demo.target.radius + 1e-6,
      `${body.id}: keyframes and interpolated arc inside envelope`);
    const local = Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), sphere.center, demo.source.center), rotation);
    const render = local.map((v, i) => v * plan.scale + demo.source.center[i] + plan.translation[i] * demo.source.radius);
    const room = Vec3.transformMat4(Vec3(), render.map(v => v * plan.cameraScale), roomFromRender);
    const head = Vec3.transformMat4(Vec3(), room, headFromRoom);
    const radius = sphere.radius * plan.scale * plan.cameraScale;
    const near = -head[2] - radius;
    assert.ok(near > 0, `${body.id} in front of wearer`);
    for (const eye of [-.032, .032]) assert.ok((Math.abs(head[0] - eye) + radius) / near < EYE_TAN_HALF_HORIZONTAL,
      `${body.id} inside both horizontal views`);
    assert.ok((Math.abs(head[1]) + radius) / near < EYE_TAN_HALF_VERTICAL, `${body.id} inside vertical view`);
  }
}

for (const demo of demos) test(`${demo.demo}/${demo.chapter}: composite travel stays framed`, t => {
  const lesson = readFileSync(new URL(`../../plugin/demos/${demo.demo}/motion.json`, import.meta.url));
  assert.equal(createHash('sha256').update(lesson).digest('hex'), demo.lessonSha256, 'regenerate bounds after lesson changes');
  assert.equal(JSON.parse(lesson).provenance.sourceSha256, demo.sha256, 'bounds came from the lesson composite');
  const { options, previous, before, after } = demoPlans(demo);
  assert.ok(after.scale >= previous.scale / MOTION_SCALE_CAP - 1e-9);
  assert.ok(after.scale <= previous.scale * MOTION_SCALE_CAP + 1e-9);
  assert.ok(after.scale * after.cameraScale / after.distance > before.scale * before.cameraScale / before.distance,
    'moving bodies gain angular size, not only a larger saved scale');
  checkTravel(demo, after, options);
  t.diagnostic(JSON.stringify({ chapter: demo.chapter, previous: previous.scale, before: before.scale,
    after: after.scale, bounds: demo.target }));
});

test('kinesin observed 2.005 chapter cannot shrink more than 20%, including a turned wearer', () => {
  const demo = demos[0], { options } = demoPlans(demo);
  options.headInRoom = Mat4.fromRotation(Mat4(), .65, [0, 1, 0]);
  options.headInRoom[12] = .4; options.headInRoom[13] = 1.6;
  options.renderFromRoom = Mat4.fromTranslation(Mat4(), [.1, -.2, .3]);
  options.placement.rotation = [20, 35, -10];
  const plan = motionFocusPlacement({ ...options, framing: 'fill', targetCenter: demo.target.center, targetRadius: demo.target.radius, previousScale: 2.0053477078983453 });
  assert.ok(plan.scale >= 2.0053477078983453 / MOTION_SCALE_CAP);
  assert.ok(plan.scale <= 2.0053477078983453 * MOTION_SCALE_CAP);
  checkTravel(demo, plan, options);
});

test('viewer bakes the capped travel seat in the unchanged source basis and a hold wins', async () => {
  const { h, hold } = tourFocusHarness();
  const demo = demos[0];
  Object.assign(h, { motionFocusPlacement, recordBoundingSphere: () => demo.source,
    pivotBounds: () => ({ baseCenter: demo.source.center, visibleCenter: demo.source.center, radius: demo.source.radius }) });
  h.inspectionState.place({ scale: 2.0053477078983453 });
  await h.focusSelection({ framing: 'fill', liftEmphasis: false, durationMs: 0, elevationDegrees: 0,
    motionFrame: { target: demo.target, previousScale: 2.0053477078983453 } });
  assert.ok(h.inspectionSnapshot().placement.scale >= 2.0053477078983453 / MOTION_SCALE_CAP - 1e-9);
  const saved = structuredClone(h.inspectionSnapshot().placement);
  hold.takeover('grab'); h.chapterInteractionDepth = 1;
  await h.focusSelection({ motionFrame: { target: demo.target, previousScale: .1 } });
  assert.deepEqual(h.inspectionSnapshot().placement, saved);
});

for (const previousScale of [.5, 6]) test(`both scale-cap edges preserve travel (previous ${previousScale})`, () => {
  const demo = demos[0], { options } = demoPlans(demo);
  const plan = motionFocusPlacement({ ...options, framing: 'fill', targetCenter: demo.target.center,
    targetRadius: demo.target.radius, previousScale });
  assert.ok(plan.scale >= previousScale / MOTION_SCALE_CAP);
  assert.ok(plan.scale <= previousScale * MOTION_SCALE_CAP);
  checkTravel(demo, plan, options);
});

test('hemoglobin first animated chapter caps scale against the currently visible scene', () => {
  const demo = demos.find(d => d.chapter === 'switch');
  const { options } = demoPlans(demo), previousScale = 2.022824;
  const plan = motionFocusPlacement({ ...options, framing: 'fill', targetCenter: demo.target.center,
    targetRadius: demo.target.radius, previousScale });
  assert.ok(plan.scale >= previousScale / MOTION_SCALE_CAP);
  assert.ok(plan.scale <= previousScale * MOTION_SCALE_CAP);
  checkTravel(demo, plan, options);
  const deviceOptions = { ...options, cameraScale: options.cameraScale * plan.motionScale.fitted / 1.370728 };
  const devicePlan = motionFocusPlacement({ ...deviceOptions, framing: 'fill', targetCenter: demo.target.center,
    targetRadius: demo.target.radius, previousScale });
  assert.ok(Math.abs(devicePlan.scale - 1.6182592) < 1e-6);
  checkTravel(demo, devicePlan, deviceOptions);
});
