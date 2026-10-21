import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';

// Both versions execute the real search; only its geometry provider differs.
const url = new URL('./chapter-field.mjs', import.meta.url), require = createRequire(url);
const source = readFileSync(url, 'utf8');
const start = source.indexOf('function fieldGeometry('), end = source.indexOf('\n// A part seen in one eye', start);
assert.ok(start > 0 && end > start, 'the geometry provider boundary exists');
const original = readFileSync(new URL('./fixtures/chapter-field-before-fit.txt', import.meta.url), 'utf8');
let reference = original;
// Count the old work without changing arithmetic or the scanned parts.
reference = reference.replace('  const cornersAt =', '  let activeMeter;\n  const originalCornersAt =')
  .replace('  const subjectAt =', '  const cornersAt = (...args) => { if (activeMeter) activeMeter.cornerPlans = (activeMeter.cornerPlans ?? 0) + 1; return originalCornersAt(...args); };\n  const subjectAt =')
  .replace('    const toEye =', '    activeMeter = meter;\n    if (meter) meter.eyeTransforms = (meter.eyeTransforms ?? 0) + 1;\n    const toEye =')
  .replace('      eyeRoom ??=', '      if (!eyeRoom && meter) meter.eyeInverses = (meter.eyeInverses ?? 0) + 1;\n      eyeRoom ??=');
const load = text => import(`data:text/javascript;base64,${Buffer.from(text.replace(/from '([^']+)'/g, (_, name) =>
  `from '${name.startsWith('.') ? new URL(name, url).href : pathToFileURL(require.resolve(name)).href}'`)
  + '\nexport { fieldGeometry as testGeometry };').toString('base64')}`);
const current = await load(source), before = await load(source.slice(0, start) + reference + source.slice(end));
const uninstrumentedBefore = await load(source.slice(0, start) + original + source.slice(end));

const glass = (x, y, width = .2, height = .1, z = -1) => [-1, 1].flatMap(a => [-1, 1].map(b =>
  [x + a * width, y + b * height, z]));
function options(count = 96, plates = 8) {
  const center = [0, 0, -3];
  return { bounds: { center, radius: 2, spheres: [
    { center, radius: .45, kind: 'motion' },
    ...Array.from({ length: count }, (_, i) => ({ center: [((i * 37) % 101 - 50) / 50,
      ((i * 29) % 97 - 48) / 60, -3 + ((i * 19) % 89 - 44) / 70], radius: .025 + i % 4 / 100, kind: 'drawn' })),
    ...Array.from({ length: plates }, (_, i) => ({ center: [(i % 5 - 2) / 3, (i % 7 - 3) / 4, -2.8 - i % 3 / 10],
      radius: .25, kind: 'plate', quad: [[.2, .01, .005], [.007, .06, .002]], sweep: i % 2 ? .03 : 0,
      renderOffset: [0, 0, .1], push: i % 3 ? .1 : 0, toward: [0, 0, 1] })),
  ] }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  center, radius: 2, cameraScale: 1, renderFromRoom: identity(), headInRoom: identity(), views: syntheticViews(),
  exact: false, clearanceOnly: true, allowOffscreen: true, level: true, standoff: 5,
  menuGlass: [glass(.2, 0, .08, .1), glass(.65, -.65, .08, .06)] };
}
function outcome(implementation, input, measured = true) {
  const meter = measured ? {} : undefined;
  try { return { answer: implementation.fitChapterField({ ...input, meter }), meter }; }
  catch (error) { return { error: { message: error.message, code: error.code }, meter }; }
}
function compare(input) {
  const expected = outcome(before, input), actual = outcome(current, input);
  assert.deepEqual(actual.answer, expected.answer, 'the exact admitted move is unchanged');
  assert.deepEqual(actual.error, expected.error, 'the exact refusal is unchanged');
  for (const key of ['positions', 'tests', 'projections']) assert.equal(actual.meter[key], expected.meter[key], key);
  return { expected, actual };
}

test('moving-position fit preserves exact stereo results across placement, eyes, projection and room mapping', () => {
  let moved = 0, refused = 0, checks = 0;
  for (const exact of [false, true]) for (let variant = 0; variant < 8; variant++) {
    const input = options(36 + variant, 4 + variant);
    input.exact = exact;
    input.placement = { translation: [variant / 30, -variant / 40, -variant / 25],
      rotation: [variant * 3, variant * 7, -variant * 2], scale: 1 + variant / 15 };
    input.cameraScale = 1 + variant / 20;
    const angle = variant / 40, c = Math.cos(angle), s = Math.sin(angle);
    input.renderFromRoom = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, variant / 30, -variant / 50, 0, 1];
    input.views.forEach((view, eye) => {
      const yaw = (eye ? -1 : 1) * variant / 80;
      view.transform.inverse.matrix[0] = view.transform.inverse.matrix[10] = Math.cos(yaw);
      view.transform.inverse.matrix[2] = -Math.sin(yaw); view.transform.inverse.matrix[8] = Math.sin(yaw);
      view.transform.inverse.matrix[13] = variant / 50;
      view.projectionMatrix[8] = (eye ? -1 : 1) * variant / 40;
      view.projectionMatrix[9] = variant / 80;
      view.projectionMatrix[0] *= 1 + variant / 30;
      view.projectionMatrix[5] *= 1 + variant / 25;
    });
    input.headInRoom[0] = input.headInRoom[10] = Math.cos(angle);
    input.headInRoom[2] = -Math.sin(angle); input.headInRoom[8] = Math.sin(angle);
    if (variant % 4 === 3) input.maxMove = .01;
    const { actual } = compare(input);
    moved += Number(!!actual.answer?.field); refused += Number(!!actual.error); checks += actual.meter.positions ?? 0;
  }
  assert.ok(moved > 0 && refused > 0 && checks > 100, JSON.stringify({ moved, refused, checks }));
});

test('corner plans preserve each pushed and swept plate rectangle at every proposed position', () => {
  for (const exact of [false, true]) {
    const input = options(40, 9); input.exact = exact;
    const a = current.testGeometry({ ...input, fixedViews: input.views }), b = before.testGeometry(input);
    const points = Array.from({ length: 21 }, (_, i) => [-.4 + i / 20, .15 - i / 80, -1.5 - i / 10]);
    points.push([0, 0, -.000001], [0, 0, 0], [0, 0, .3]);
    for (const point of points) for (const view of input.views) {
      const left = [], right = [];
      a.scan(point, view, { prune: () => false, visit: (index, part) => left.push([index, part]) });
      b.scan(point, view, { prune: () => false, visit: (index, part) => right.push([index, part]) });
      assert.deepEqual(left, right, 'all silhouette and quad rectangles remain bit-for-bit identical');
      assert.deepEqual(a.subjectAt(point), b.subjectAt(point), 'the complete nearest-move envelope remains identical');
    }
  }
});

test('request-local preparation cannot reuse a prior source, bounds, scale, placement or eye', () => {
  const input = options(); compare(input);
  input.bounds.spheres = input.bounds.spheres.map(sphere => ({ ...sphere, center: sphere.center.map((v, i) => v + (i === 0 ? .1 : 0)) }));
  input.bounds.spheres[0].radius += .13;
  input.placement.rotation[1] += 21; input.placement.scale = .8; input.placement.translation[0] += .1;
  input.views[0].transform.inverse.matrix[12] += .2; input.views[1].projectionMatrix[8] += .11;
  compare(input);
  input.bounds = structuredClone(input.bounds); input.bounds.spheres[1].radius += .2; compare(input);
});

test('kept placements, non-level nearest moves, walking fits and unmeasurable glass retain their contracts', () => {
  for (const edits of [
    { keepPlacement: true }, { level: false }, { clearanceOnly: false, allowOffscreen: false },
    { menuGlass: [] }, { menuGlass: [glass(0, 0, .2, .1, 1)] }, { force: true }, { maxDistance: 3 },
  ]) compare({ ...options(32, 3), ...edits });
});

test('a device-sized moving fit prepares invariant eye and plate work once per request', t => {
  const input = options(3416, 40);
  compare(input);
  // Time the untouched old provider, without counters on either side.
  assert.deepEqual(outcome(current, input, false), outcome(uninstrumentedBefore, input, false));
  const times = { before: [], current: [] };
  for (let i = 0; i < 5; i++) {
    const pair = [['before', uninstrumentedBefore], ['current', current]];
    for (const [name, implementation] of i % 2 ? pair.reverse() : pair) {
      const began = performance.now(); outcome(implementation, input, false); times[name].push(performance.now() - began);
    }
  }
  const { expected, actual } = compare(input);
  assert.ok(actual.meter.positions > 100, 'the workload visits many live candidate positions');
  assert.ok(actual.meter.eyeTransforms <= input.views.length, 'each visited eye is composed once');
  assert.ok(actual.meter.eyeInverses <= input.views.length, 'each pushed-plate eye position is inverted once');
  assert.ok(actual.meter.cornerPlans <= 41, 'one plan per visited motion/plate shape');
  assert.ok(expected.meter.eyeTransforms > actual.meter.eyeTransforms * 20);
  assert.ok(expected.meter.cornerPlans > actual.meter.cornerPlans * 20);
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  t.diagnostic(JSON.stringify({ before: expected.meter, current: actual.meter,
    beforeMs: median(times.before), currentMs: median(times.current), samples: times }));
});


test('scalar corner projection keeps both homogeneous divisions and invalid-input behavior', () => {
  const snapshot = (implementation, input, point, view) => {
    try {
      const parts = [], geometry = implementation.testGeometry({ ...input, fixedViews: input.views });
      geometry.scan(point, view, { prune: () => false, visit: (index, part) => parts.push([index, part]) });
      return { parts };
    } catch (error) { return { error: { name: error.name, message: error.message } }; }
  };
  let finiteCases = 0, rejectedCases = 0;
  for (let variant = 0; variant < 15; variant++) {
    const input = options(4, 3);
    // Deliberately non-rigid transforms. A combined transform is numerically
    // different; each original homogeneous divide must still happen in order.
    input.renderFromRoom = [1.2, .02, .03, .007, .04, .9, -.06, -.003,
      -.04, .06, 1.1, .004, .2, -.1, .15, 1.03];
    const view = input.views[variant % 2];
    view.transform.inverse.matrix = [.9, -.02, .05, .003, .04, 1.2, .03, -.002,
      .02, -.01, 1.1, .006, .03, -.04, -.1, .99];
    view.projectionMatrix[8] = .123; view.projectionMatrix[9] = -.071;
    view.projectionMatrix[12] = .011; view.projectionMatrix[13] = -.009;
    let point = [.17, -.12, -2.1];
    if (variant === 1) point = [0, 0, -.000001];
    if (variant === 2) point = [0, 0, .2];
    if (variant === 3) { view.transform.inverse.matrix[3] = 0; view.transform.inverse.matrix[7] = 0; view.transform.inverse.matrix[11] = 0; view.transform.inverse.matrix[15] = 1e-7; }
    if (variant === 4) { input.renderFromRoom[3] = 0; input.renderFromRoom[7] = 0; input.renderFromRoom[11] = 0; input.renderFromRoom[15] = 1e-7; }
    if (variant === 5) view.transform.inverse.matrix[0] = NaN;
    if (variant === 6) view.transform.inverse.matrix[0] = Infinity;
    if (variant === 7) view.transform.inverse.matrix = view.transform.inverse.matrix.slice(0, 15);
    if (variant === 8) point = [NaN, -.12, -2.1];
    if (variant === 9) point = new Float64Array(point);
    if (variant === 10) view.transform.inverse.matrix[0] = '1';
    if (variant === 11) input.renderFromRoom[0] = 1e308;
    if (variant === 12) point = [1e308, 1e308, -1e308];
    if (variant === 13) view.projectionMatrix[0] = NaN;
    if (variant === 14) view.transform.inverse.matrix[3] = 1e308;
    const expected = snapshot(before, input, point, view), actual = snapshot(current, input, point, view);
    assert.deepEqual(actual, expected, `projection case ${variant} must retain exact values or rejection`);
    finiteCases += Number(Boolean(actual.parts)); rejectedCases += Number(Boolean(actual.error));
  }
  assert.ok(finiteCases >= 8 && rejectedCases >= 3, JSON.stringify({ finiteCases, rejectedCases }));
  for (const w of [-1.000001e-6, -1e-6, -.999999e-6, -0, 0, .999999e-6, 1e-6, 1.000001e-6]) {
    const input = options(0, 2);
    input.bounds.spheres.forEach(sphere => { sphere.push = 0; });
    const view = input.views[0]; view.transform.inverse.matrix[15] = w;
    for (const point of [[-0, 0, -3], [0, -0, 1e-5], [0, 0, -1e-5]]) {
      assert.deepEqual(snapshot(current, input, point, view), snapshot(before, input, point, view),
        `homogeneous threshold ${w} and signed-zero/eye-plane point must retain the original projection`);
    }
  }
});

test('direct corner rectangles eliminate generic per-corner transforms without changing search work', async t => {
  const counted = text => load(text.replace('import { applyMatrix4,', 'import { applyMatrix4 as genericApplyMatrix4,')
    + '\nlet genericPointTransforms = 0; const applyMatrix4 = (...args) => { genericPointTransforms++; return genericApplyMatrix4(...args); };'
    + '\nexport function takePointTransforms() { const count = genericPointTransforms; genericPointTransforms = 0; return count; }');
  const fast = await counted(source), slow = await counted(source.slice(0, start) + original + source.slice(end));
  const input = options(3416, 40);
  // Warm the unchanged source-bounds cache, then count only a complete fit.
  outcome(fast, input); outcome(slow, input);
  fast.takePointTransforms(); slow.takePointTransforms();
  const actual = outcome(fast, input), expected = outcome(slow, input);
  assert.deepEqual(actual.answer, expected.answer);
  assert.deepEqual(actual.error, expected.error);
  for (const key of ['positions', 'tests', 'projections']) assert.equal(actual.meter[key], expected.meter[key], key);
  const direct = fast.takePointTransforms(), generic = slow.takePointTransforms();
  assert.ok(generic > 100000, `the fixture must exercise substantial corner work: ${generic}`);
  assert.ok(direct < generic / 20, `generic transforms ${generic} -> ${direct}`);
  t.diagnostic(JSON.stringify({ genericPointTransformsBefore: generic, genericPointTransformsAfter: direct,
    positions: actual.meter.positions, tests: actual.meter.tests, projections: actual.meter.projections }));
});
