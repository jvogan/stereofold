import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createXrManipulation } from './xr-manipulate.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  function gripTargetDepthAxis(');
assert.ok(start >= 0);
const helper = source.slice(start, source.indexOf('\n  }', start) + 4);
const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} ≈ ${expected}`));
function harness() {
  // A rotated/translated camera exposes accidental world/room mixing and
  // double application of camera.scale that an identity-camera test misses.
  const renderFromRoom = Mat4.fromRotation(Mat4(), Math.PI / 2, Vec3.create(0, 1, 0));
  renderFromRoom[12] = 3; renderFromRoom[13] = -2; renderFromRoom[14] = 5;
  const headInRoom = Mat4.fromTranslation(Mat4(), Vec3.create(1, 1.5, 2));
  const placement = Mat4.fromTranslation(Mat4(), Vec3.create(4, -1, 3));
  const h = vm.createContext({ Mat4, Vec3,
    latestRoomPlacementPose: { headInRoom: Array.from(headInRoom) }, latestHeadSample: 990, xrInputHeadInRoom: undefined,
    performance: { now: () => 1000 }, visibleStage: false, sourceRecord: {},
    canvas: { camera: { view: Mat4.invert(Mat4(), renderFromRoom), scale: .25 } },
    loadedSphere: () => ({ center: [2, 3, -4], radius: 1 }),
    catalogVisibleBounds: () => ({ center: [-2, 1, 4], radius: .5 }),
    presentationTransform: () => placement });
  vm.runInContext(helper, h);
  return h;
}

test('viewer grip depth axis compares drawn molecular centre and current head in pointer coordinates', () => {
  const h = harness();
  // head [1,1.5,2] rotates to [2,1.5,-1], then translates to [5,-.5,4].
  // molecule [2,3,-4] places at [6,2,-1], then scales to [1.5,.5,-.25].
  close(h.gripTargetDepthAxis(), [-3.5, 1, -4.25]);
  h.visibleStage = true; h.sourceRecord = { catalog: {} };
  close(h.gripTargetDepthAxis(), [-4.5, .5, -2.25]);
  h.catalogVisibleBounds = () => undefined;
  close(h.gripTargetDepthAxis(), [-3.5, 1, -4.25]);
});

test('current input-frame head overrides stale placement sampling without changing coordinate units', () => {
  const h = harness(); h.latestHeadSample = -501;
  h.xrInputHeadInRoom = Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(2, 1.5, 2)));
  // Current head renders at [5,-.5,3], molecular center at [1.5,.5,-.25].
  close(h.gripTargetDepthAxis(), [-3.5, 1, -3.25]);
  h.xrInputHeadInRoom = undefined;
  assert.equal(h.gripTargetDepthAxis(), undefined, 'borrowed frame pose must not keep stale fallback alive');
});

for (const missing of ['stale-head', 'missing-head', 'invalid-head', 'short-head', 'missing-target']) test(`viewer ${missing} keeps direct-grip fallback available`, () => {
  const h = harness();
  if (missing === 'stale-head') h.latestHeadSample = -501;
  if (missing === 'missing-head') h.latestRoomPlacementPose = null;
  if (missing === 'invalid-head') h.latestRoomPlacementPose.headInRoom[12] = NaN;
  if (missing === 'short-head') h.latestRoomPlacementPose.headInRoom = [];
  if (missing === 'missing-target') h.loadedSphere = () => undefined;
  assert.equal(h.gripTargetDepthAxis(), undefined);
});

test('production hookup supplies the axis once per press and gain works along the resulting oblique axis', () => {
  const h = harness(), deltas = [];
  const hookupStart = source.indexOf('    xrManipulation = createXrManipulation({');
  const hookupEnd = source.indexOf('\n    xrButtons =', hookupStart);
  assert.match(source.slice(hookupStart, hookupEnd), /gripDepthAxis:\s*gripTargetDepthAxis/u);
  const axis = Array.from(h.gripTargetDepthAxis()), length = Math.hypot(...axis);
  const unit = axis.map(v => v / length);
  const manipulation = createXrManipulation({ gripDepthAxis: h.gripTargetDepthAxis,
    onTranslate: value => deltas.push(value), now: () => 0, pulse() {}, record() {} });
  const sourceController = { gamepad: { buttons: [{ value: 0 }, { value: 1 }] } };
  const pointer = distance => [{ handedness: 'right', source: sourceController, buttons: 2,
    ray: { origin: unit.map(v => v * distance), direction: [0, -1, 0] } }];
  manipulation.update(pointer(0));
  h.latestRoomPlacementPose.headInRoom[12] += 5;
  manipulation.update(pointer(.12));
  close(deltas.at(-1), unit.map(v => v * .3));
});
