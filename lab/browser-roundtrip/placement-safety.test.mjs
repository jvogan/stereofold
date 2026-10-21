import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { clampPlacementScale, PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE } from './placement-limits.mjs';
import { createInspectionState, normalizePlacement } from './inspection-state.mjs';
import { oneHandScaleFactor } from './xr-manipulate.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function body(name) {
  const start = source.indexOf(`  function ${name}(`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

test('saved and imported placement refuses invalid scales and clamping always stays finite and positive', () => {
  for (const scale of [0, -1, 1e-7, NaN, Infinity, -Infinity, PLACEMENT_MAX_SCALE * 2]) {
    assert.throws(() => normalizePlacement({ scale }));
    const clamped = clampPlacementScale(scale);
    assert.ok(Number.isFinite(clamped) && clamped >= PLACEMENT_MIN_SCALE && clamped <= PLACEMENT_MAX_SCALE, String(scale));
  }
});

test('small absolute scales remain available to restoration and automatic fitting', () => {
  for (const scale of [1e-6, 1.7e-6, 1e-4, .005]) {
    assert.equal(normalizePlacement({ scale }).scale, scale);
    assert.equal(clampPlacementScale(scale), scale);
  }
});

for (const entry of [.9313518360015975, .005])
test(`stick and repeated two-grip reductions stay inside the entry range before and after release (${entry})`, () => {
  const state = createInspectionState();
  state.place({ scale: entry });
  const h = vm.createContext({ inspectionState: state, clampPlacementScale,
    roomEntry: { seat: { scale: entry } }, canvas: { camera: { scale: 1 } },
    grabScale: 1, grabRotation: undefined, grabOffset: undefined, xrTransformBatchDepth: 0,
    canManipulateNow: () => true, cancelXrPlacementFollowup() {}, beginGesturePivot() {}, applyInspectionTransform() {},
  });
  vm.runInContext(body('applyGrabDelta'), h);
  // The exact production one-controller rate, integrated at Quest's 72 Hz.
  for (let i = 0; i < 72 * 9; i++) h.applyGrabDelta({ scale: oneHandScaleFactor(-1, 1 / 72) });
  assert.ok(state.placement().scale * h.grabScale >= entry / 5);
  // Commit/release, then start six fresh pinches. The bound cannot rebase on release.
  for (let gesture = 0; gesture < 6; gesture++) {
    state.place({ scale: clampPlacementScale(state.placement().scale * h.grabScale, entry) }); h.grabScale = 1;
    for (let frame = 0; frame < 10; frame++) h.applyGrabDelta({ scale: .82 });
    assert.ok(state.placement().scale * h.grabScale >= entry / 5);
  }
  h.applyGrabDelta({ scale: 1e100 });
  assert.ok(state.placement().scale * h.grabScale <= entry * 5);
  h.applyGrabDelta({ scale: NaN });
  assert.ok(Number.isFinite(h.grabScale));
});

test('wearer bounds intersect the absolute envelope even at its endpoints or with invalid inputs', () => {
  for (const entry of [1e-6, 2e-6, .005, .9313518360015975, PLACEMENT_MAX_SCALE]) {
    const low = Math.max(1e-6, entry / 5), high = Math.min(PLACEMENT_MAX_SCALE, entry * 5);
    assert.equal(clampPlacementScale(0, entry), low);
    assert.equal(clampPlacementScale(1e100, entry), high);
    for (const scale of [NaN, Infinity, -Infinity]) assert.equal(clampPlacementScale(scale, entry), entry);
  }
  for (const entry of [0, -1, NaN, Infinity, -Infinity]) {
    const scale = clampPlacementScale(NaN, entry);
    assert.ok(Number.isFinite(scale) && scale >= PLACEMENT_MIN_SCALE && scale <= PLACEMENT_MAX_SCALE);
  }
});

for (const authored of [12, .05]) test(`authored scale ${authored} returns gradually to the fixed band without outward ratcheting`, () => {
  let current = authored;
  const inward = authored > 5 ? .99 : 1.01;
  for (let frame = 0; frame < 2000; frame++) {
    const next = clampPlacementScale(current * inward, 1, current);
    assert.ok(inward < 1 ? next <= current : next >= current);
    assert.ok(Math.abs(Math.log(next / current)) <= Math.abs(Math.log(inward)) + 1e-12);
    current = next;
    if (current < .2 || current > 5) {
      assert.equal(clampPlacementScale(current / inward, 1, current), current, 'reversing cannot restore the earlier out-of-band scale');
    }
  }
  assert.equal(current, inward < 1 ? .2 : 5);
  // After reaching the band, extreme and invalid requests cannot escape it.
  for (const requested of [0, 1e100, Infinity, -Infinity, NaN, 0, 1e100]) {
    current = clampPlacementScale(requested, 1, current);
    assert.ok(Number.isFinite(current) && current >= .2 && current <= 5);
  }
});

test('invalid resize requests hold the current authored size, including the absolute endpoints', () => {
  for (const current of [PLACEMENT_MIN_SCALE, .05, 12, PLACEMENT_MAX_SCALE]) {
    for (const requested of [Infinity, -Infinity, NaN]) assert.equal(clampPlacementScale(requested, 1, current), current);
    const smaller = clampPlacementScale(0, 1, current), larger = clampPlacementScale(1e100, 1, current);
    assert.ok(smaller >= PLACEMENT_MIN_SCALE && smaller <= current);
    assert.ok(larger <= PLACEMENT_MAX_SCALE && larger >= current);
  }
});
