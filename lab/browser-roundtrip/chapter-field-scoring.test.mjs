import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuObstructionScorer, menuObstruction } from './chapter-field.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';

const glass = (x, y, width = .2, height = .1, z = -1) => [-1, 1].flatMap(a => [-1, 1].map(b =>
  [x + a * width, y + b * height, z]));
function field(count = 96, plateCount = 5) {
  return { center: [0, 0, -3], radius: 2, spheres: [
    { center: [0, 0, -3], radius: .7, kind: 'motion' },
    ...Array.from({ length: count }, (_, i) => ({ center: [((i * 37) % 101 - 50) / 50,
      ((i * 29) % 97 - 48) / 60, -3 + ((i * 19) % 89 - 44) / 70], radius: .025 + i % 4 / 100, kind: 'drawn' })),
    ...Array.from({ length: plateCount }, (_, i) => ({ center: [(i % 5 - 2) / 3, (i % 7 - 3) / 4, -2.8 - i % 3 / 10],
      radius: .25, kind: 'plate', quad: [[.2, 0, 0], [0, .06, 0]], sweep: i % 2 ? .03 : 0,
      renderOffset: [0, 0, .1], push: .1, toward: [0, 0, 1] })),
  ] };
}
const base = bounds => ({ bounds, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  center: [0, 0, -3], radius: 2, cameraScale: 1, renderFromRoom: identity(), views: syntheticViews(), exact: true });
const seats = Array.from({ length: 22 }, (_, i) => {
  const plates = [glass(0, i < 12 ? .55 : -.55, .4, .1), glass((i % 11 - 5) / 9, .05), glass((i % 11 - 5) / 9, -.2, .1, .04)];
  return { menuPoints: plates.flat(), menuGlass: plates };
});

test('one solve reuses exact field projections for candidate seats and their diagnostic plates', t => {
  // The device's stalled solve counted 3,731 drawn bounds and 51 plates.
  // This deterministic field matches that size without depending on a demo.
  const options = base(field(3731, 51)), cached = {}, uncached = {};
  const score = createMenuObstructionScorer(options);
  const queries = seats.flatMap(seat => [seat, ...seat.menuGlass.map(plate => ({ menuPoints: plate, menuGlass: [plate] }))]);
  const started = performance.now();
  const expected = queries.map(query => menuObstruction({ ...options, ...query, meter: uncached }));
  const baselineMs = performance.now() - started, began = performance.now();
  const actual = queries.map(query => score({ ...query, meter: cached }));
  const reusedMs = performance.now() - began;
  assert.deepEqual(actual, expected, 'area, blocker, eye, plate index and ties remain exact');
  assert.equal(cached.tests, uncached.tests, 'the same geometric parts pass through the same clearance checks');
  assert.ok(cached.projections < uncached.projections / 4, `${cached.projections} projections versus ${uncached.projections}`);
  const after = cached.projections;
  queries.forEach(query => score({ ...query, meter: cached }));
  assert.equal(cached.projections, after, 'a repeated breakdown reuses every already measured projection');
  t.diagnostic(JSON.stringify({ baselineMs, reusedMs, baselineProjections: uncached.projections, reusedProjections: after }));
});

test('equivalence holds for new bounds, placement, rotation, scale and room frames in separate solves', () => {
  for (const exact of [false, true]) for (const variant of [0, 1, 2, 3]) {
    const options = base(field(40 + variant, 3 + variant));
    options.exact = exact;
    options.placement = { translation: [variant / 12, -variant / 20, -variant / 15],
      rotation: [variant * 11, variant * 17, variant * -7], scale: 1 + variant / 8 };
    options.cameraScale = 1 + variant / 10;
    options.renderFromRoom[12] = variant / 30;
    options.renderFromRoom[13] = -variant / 40;
    options.bounds.spheres[0].radius += variant / 10;
    const score = createMenuObstructionScorer(options);
    for (const query of seats) assert.deepEqual(score(query), menuObstruction({ ...options, ...query }));
  }
});

test('reused view objects cannot keep an obsolete eye or projection matrix', () => {
  const options = base(field()), score = createMenuObstructionScorer(options), meter = {};
  for (const query of seats) assert.deepEqual(score({ ...query, meter }), menuObstruction({ ...options, ...query }));
  const previous = meter.projections;
  options.views[0].transform.inverse.matrix[12] += .3;
  options.views[1].projectionMatrix[8] += .15;
  options.views[1].projectionMatrix[5] *= 1.2;
  for (const query of seats) assert.deepEqual(score({ ...query, meter }), menuObstruction({ ...options, ...query }));
  assert.ok(meter.projections > previous, 'both changed eyes are projected again');
  const turnedViews = syntheticViews();
  for (const view of turnedViews) {
    const m = view.transform.inverse.matrix, angle = .3;
    m[0] = Math.cos(angle); m[2] = -Math.sin(angle); m[8] = Math.sin(angle); m[10] = Math.cos(angle);
  }
  for (const query of seats) assert.deepEqual(score({ ...query, views: turnedViews }),
    menuObstruction({ ...options, ...query, views: turnedViews }));
});

test('empty and unmeasurable glass and equal blockers keep the existing outcomes', () => {
  const options = base({ center: [0, 0, -3], radius: 1, spheres: [
    { center: [0, 0, -3], radius: 1, kind: 'motion' },
    { center: [0, 0, -3], radius: 1, kind: 'drawn' },
  ] });
  const score = createMenuObstructionScorer(options), plate = glass(0, 0);
  for (const query of [{}, { menuPoints: plate, menuGlass: [plate, plate] }, { menuPoints: glass(0, 0, .2, .1, 1) },
    { views: [], menuPoints: plate }]) assert.deepEqual(score(query), menuObstruction({ ...options, ...query }));
  const tied = score({ menuPoints: plate, menuGlass: [plate, plate] });
  assert.equal(tied.part, 0); assert.equal(tied.plate, 0);
  assert.deepEqual(createMenuObstructionScorer({ ...options, bounds: undefined })({ menuPoints: plate }), { area: 0 });
});
