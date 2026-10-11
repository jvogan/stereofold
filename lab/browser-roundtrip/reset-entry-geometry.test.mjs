import assert from 'node:assert/strict';
import test from 'node:test';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryGeometry, fitEntryGeometry, resetEntryLateralTravel, resetEntryTravel,
  resetEntryLateralBreakdown, subjectMargin, hullNormals, projectedHull, subjectVisibleInEyes } from './reset-entry-geometry.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { labelObjectVisible, renderedSubjectPoints, renderedSubjectSpheres } from './component-label-measurement.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const cell = value => ({ ref: { value } });
const transform = (scale, translation) => {
  const m = identity(); m[0] = m[5] = m[10] = scale;
  m.splice(12, 3, ...translation); return m;
};
const mesh = (matrix, positions) => ({ type: 'mesh', state: { visible: true }, values: {
  drawCount: cell(36), aPosition: cell(positions.flat()), instanceCount: cell(1), aTransform: cell(matrix),
} });
const referenceExtraction = ({ objects, fromPlacement, toPlacement, cameraScale }) => {
  const inverse = invertMatrix4(fromPlacement);
  const ratio = Math.max(...[0, 4, 8].map(i => Math.hypot(toPlacement[i], toPlacement[i + 1], toPlacement[i + 2])))
    / Math.max(...[0, 4, 8].map(i => Math.hypot(fromPlacement[i], fromPlacement[i + 1], fromPlacement[i + 2])));
  const subject = [];
  for (const object of objects.filter(labelObjectVisible)) {
    const vertices = object.type === 'mesh' ? renderedSubjectPoints(object, 1, Infinity) : [];
    const elements = vertices.length ? vertices.map(center => ({ center, radius: 0 })) : renderedSubjectSpheres(object, 1);
    if (!elements.length) return undefined;
    for (const element of elements) {
      const center = applyMatrix4(applyMatrix4(element.center, inverse), toPlacement).map(v => v * cameraScale);
      subject.push({ center, radius: element.radius * ratio * cameraScale });
    }
  }
  return subject.length ? subject : undefined;
};
const corners = [-.5, .5].flatMap(x => [-.5, .5].flatMap(y => [-.1, .1].map(z => [x, y, z])));
const input = () => {
  const seat = { scale: 1, rotation: [0, 0, 0], translation: [0, 0, -1] };
  const matrix = transform(seat.scale, seat.translation);
  return { seat, centered: true, headInRoom: identity(), renderFromRoom: identity(), cameraScale: 1,
    center: [0, 0, 0], radius: 1,
    geometry: { objects: [mesh(matrix, corners)], fromPlacement: matrix, toPlacement: matrix, views: syntheticViews() },
    points: [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1])) };
};

test('translated padded Mol* meshes fit exactly like their live vertices', () => {
  const options = { ...input(), centered: false, bounded: true, fit: true };
  const offset = [300, 250, 350];
  const positions = corners.map(p => p.map((v, i) => v + offset[i]));
  const matrix = transform(1, [-300, -250, -351]);
  const live = mesh(matrix, positions);
  live.values.uVertexCount = cell(positions.length);
  const padded = mesh(matrix, [...positions, [0, 0, 0], [900, -800, 700]]);
  padded.values.uVertexCount = cell(positions.length);
  const geometry = object => ({ ...options.geometry, objects: [object] });
  const extract = object => resetEntryGeometry({ ...geometry(object), cameraScale: 1, renderFromRoom: identity() });
  assert.deepEqual(extract(padded).subject, extract(live).subject);
  assert.deepEqual(renderedSubjectPoints(padded, 1, Infinity), renderedSubjectPoints(live, 1, Infinity));
  assert.deepEqual(resetViewPlacement({ ...options, geometry: geometry(padded) }),
    resetViewPlacement({ ...options, geometry: geometry(live) }));
  assert.equal(extract(padded).subject.length, positions.length);
  delete padded.values.uVertexCount;
  assert.equal(extract(padded).subject.length, positions.length + 2, 'missing count retains conservative geometry');
});

test('live origin vertices survive while invalid live counts retain conservative mesh bounds', () => {
  const object = mesh(identity(), [[0, 0, 0], [1, 2, -3], [90, 80, -70]]);
  object.values.uVertexCount = cell(2);
  const options = { objects: [object], fromPlacement: identity(), toPlacement: identity(),
    views: syntheticViews(), cameraScale: 1, renderFromRoom: identity() };
  assert.deepEqual(resetEntryGeometry(options).subject.map(s => s.center), [[0, 0, 0], [1, 2, -3]]);
  assert.deepEqual(renderedSubjectPoints(object, 1, Infinity), [[0, 0, 0], [1, 2, -3]]);
  for (const invalid of [undefined, NaN, Infinity, -1, 1.5, 4, '2']) {
    object.values.uVertexCount = cell(invalid);
    assert.equal(resetEntryGeometry(options).subject.length, 3, String(invalid));
    assert.equal(renderedSubjectPoints(object, 1, Infinity).length, 3, String(invalid));
  }
  object.values.uVertexCount = cell(0);
  assert.deepEqual(renderedSubjectPoints(object, 1, Infinity), []);
  assert.equal(resetEntryGeometry(options), undefined, 'an unreadable empty mesh retains conservative refusal');
});

test('rendered Reset moves only forward when the moved menu overlaps, retaining scale and lateral coordinates', () => {
  const options = input(), result = resetViewPlacement(options);
  assert.equal(result.scale, options.seat.scale);
  assert.deepEqual(result.rotation, options.seat.rotation);
  assert.deepEqual(result.translation.slice(0, 2), options.seat.translation.slice(0, 2));
  assert.ok(result.resetTravelMeters > 0 && result.standoffMeters <= 4);
  for (const eye of options.geometry.views) {
    const x = eye.transform.matrix[12], depth = -result.translation[2];
    const left = (-.5 - x) / (depth - .1), menuRight = -.3 - x;
    assert.ok(left > menuRight, 'the full mesh clears the menu independently in each eye');
  }
});

test('rendered Reset refuses a menu covering every reachable position and names useful actions', () => {
  const options = input(), before = structuredClone(options.seat);
  options.points = [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1]));
  assert.throws(() => resetViewPlacement(options), /within 4 m\. Press Fit, or move the menu\./u);
  assert.deepEqual(options.seat, before);
});

test('Reset keeps the same physical result for a small source beyond ten source radii', () => {
  const baseline = resetViewPlacement(input());
  const options = input();
  options.radius = 0.01;
  options.seat = { ...options.seat, scale: 100, translation: [0, 0, -100] };
  const matrix = transform(100, [0, 0, -1]);
  options.geometry = { objects: [mesh(matrix, corners.map(point => point.map(value => value / 100)))],
    fromPlacement: matrix, toPlacement: matrix, views: syntheticViews() };
  const result = resetViewPlacement(options);
  assert.equal(result.scale, 100);
  assert.ok(result.translation[2] < -100);
  result.translation.forEach((value, axis) =>
    assert.ok(Math.abs(value * options.radius - baseline.translation[axis]) < 1e-10));
});

test('Reset restores a clear entry exactly even when its gap is less than one degree', () => {
  const options = input();
  options.points = [-.8, -.596].flatMap(x => [-.8, .8].map(y => [x, y, -1]));
  const result = resetViewPlacement(options);
  assert.deepEqual(result.translation, options.seat.translation);
  assert.equal(result.resetTravelMeters, undefined);
});

test('rendered Reset tests both eyes and all vertices, including vertices beyond a diagnostic sample', () => {
  const options = input();
  const positions = Array.from({ length: 9000 }, () => [0, 0, 0]);
  positions[8999] = [-.5, 0, 0];
  options.geometry.objects = [mesh(options.geometry.fromPlacement, positions)];
  const geometry = resetEntryGeometry({ ...options.geometry, cameraScale: 1, renderFromRoom: identity() });
  assert.equal(geometry.subject.length, 9000);
  assert.deepEqual(geometry.subject.at(-1).center, [-.5, 0, -1]);
  assert.ok(resetViewPlacement(options).resetTravelMeters > 0);
  options.geometry.views = options.geometry.views.slice(0, 1);
  assert.equal(resetEntryGeometry({ ...options.geometry, cameraScale: 1, renderFromRoom: identity() }), undefined);
});

test('instance bounds apply placement once; an unreadable live object retains conservative refusal', () => {
  const options = input(), from = transform(4, [2, 3, -4]);
  options.geometry.fromPlacement = from;
  options.geometry.objects = [{ type: 'spheres', state: { visible: true }, values: {
    drawCount: cell(12), instanceCount: cell(1), aTransform: cell(from),
    invariantBoundingSphere: cell({ center: [0, 0, 0], radius: .5 }),
  } }];
  const geometry = resetEntryGeometry({ ...options.geometry, cameraScale: 1, renderFromRoom: identity() });
  assert.deepEqual(geometry.subject, [{ center: [0, 0, -1], radius: .5 }]);
  options.geometry.objects.push({ type: 'mesh', state: { visible: true }, values: { drawCount: cell(12) } });
  assert.equal(resetEntryGeometry({ ...options.geometry, cameraScale: 1, renderFromRoom: identity() }), undefined);
});

test('direct extraction equals the old per-element path across seeded mixed objects and placements', () => {
  let seed = 92;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (const projective of [false, true]) for (let trial = 0; trial < 8; trial++) {
    const from = transform(1.2 + random(), [random() - .5, random() - .5, -1]);
    const to = transform(.4 + random(), [random() - .5, random() - .5, -1.5]);
    if (projective) { from[3] = .04; to[7] = -.03; }
    const matrices = Array.from({ length: 3 }, () =>
      transform(.5 + random(), [random() - .5, random() - .5, -1 - random()]));
    const positions = Array.from({ length: 64 }, () => [random() - .5, random() - .5, random() - .5]);
    positions[7][0] = NaN; positions[49][2] = Infinity;
    const solid = mesh(matrices.flat(), positions); solid.values.instanceCount = cell(3);
    const empty = mesh(matrices.flat(), [[NaN, 0, 0], [Infinity, 0, 0]]);
    empty.values.instanceCount = cell(3);
    empty.values.invariantBoundingSphere = cell({ center: [.1, -.2, 0], radius: .3 });
    const sphere = { type: 'spheres', state: { visible: true }, values: {
      drawCount: cell(12), instanceCount: cell(2), aTransform: cell(matrices.slice(0, 2).flat()),
      invariantBoundingSphere: cell({ center: [0, .1, 0], radius: .2 }),
    } };
    const options = { objects: [solid, sphere, empty], fromPlacement: from, toPlacement: to,
      views: syntheticViews(), cameraScale: .7, renderFromRoom: identity() };
    const actual = resetEntryGeometry(options);
    assert.deepEqual(actual.subject, referenceExtraction(options), `${projective ? 'projective' : 'affine'} trial ${trial}`);
    assert.equal(actual.subject.length, 64 * 3 - 6 + 2 + 3);
  }
  const unreadable = mesh(identity(), [[NaN, 0, 0]]);
  const options = { objects: [unreadable], fromPlacement: identity(), toPlacement: identity(),
    views: syntheticViews(), cameraScale: 1, renderFromRoom: identity() };
  assert.equal(resetEntryGeometry(options), undefined);
  assert.equal(referenceExtraction(options), undefined);
});

test('fast mesh extraction reads positions directly without the old point-array path', () => {
  const object = mesh(identity(), [[.1, .2, -.9], [.3, .4, -1]]);
  const matrices = object.values.aTransform.ref.value;
  matrices.slice = (...range) => {
    const matrix = Array.prototype.slice.apply(matrices, range);
    matrix[Symbol.iterator] = () => { throw Error('renderedSubjectPoints copied an instance matrix'); };
    return matrix;
  };
  const geometry = resetEntryGeometry({ objects: [object], fromPlacement: identity(), toPlacement: identity(),
    views: syntheticViews(), cameraScale: 1, renderFromRoom: identity() });
  assert.deepEqual(geometry.subject, [
    { center: [.1, .2, -.9], radius: 0 }, { center: [.3, .4, -1], radius: 0 },
  ]);
});

test('fractional, absent, nonpositive and NaN instance counts match instanceMatrices, including short buffers', () => {
  const matrices = [transform(1, [0, 0, -1]), transform(1, [2, 0, -1]), transform(1, [4, 0, -1])];
  for (const [name, count, available, expected] of [
    ['fractional', 1.5, 2, 1], ['fractional short', 1.5, 1, 0],
    ['larger fractional', 2.5, 3, 2], ['larger fractional short', 2.5, 2, 0],
    ['zero', 0, 3, 1], ['negative', -2, 3, 1], ['NaN', NaN, 3, 0],
    ['missing', undefined, 3, 1], ['missing short', undefined, 0, 0],
  ]) {
    const object = mesh(matrices.slice(0, available).flat(), [[.1, .2, 0]]);
    if (count === undefined) delete object.values.instanceCount;
    else object.values.instanceCount = cell(count);
    const options = { objects: [object], fromPlacement: identity(), toPlacement: identity(),
      views: syntheticViews(), cameraScale: 1, renderFromRoom: identity() };
    assert.equal(renderedSubjectPoints(object, 1, Infinity).length, expected, `${name}: reference count`);
    assert.deepEqual(resetEntryGeometry(options)?.subject, referenceExtraction(options), name);
    if (expected) assert.equal(resetEntryGeometry(options).subject.length, expected, name);
  }
});

// Done must measure the rendered mesh, and cap any lateral correction.
test('Done uses the minimum stereo mesh clearance and retains size, rotation and forward depth', () => {
  const options = input(); options.centered = false; options.bounded = true;
  options.seat.rotation = [12, 23, 34];
  options.geometry.objects = [mesh(options.geometry.fromPlacement,
    [-.05, .05].flatMap(x => [-.1, .1].map(y => [x, y, 0])))];
  options.points = [-.3, -.04].flatMap(x => [-.5, .5].map(y => [x, y, -1]));
  const result = resetViewPlacement(options);
  assert.ok(result && result.translation[0] < .1, 'a padded radius must not exile the narrow mesh');
  assert.equal(result.scale, options.seat.scale);
  assert.deepEqual(result.rotation, options.seat.rotation);
  assert.deepEqual(result.translation.slice(1), options.seat.translation.slice(1));
  assert.ok(Math.abs(result.translation[0] - (.01 + Math.tan(Math.PI / 180))) < 1e-9,
    'the binding eye clears by precisely the existing one-degree margin');
});

test('Done declines lateral clearance outside the existing comfortable centre band', () => {
  const options = input(); options.centered = false; options.bounded = true;
  assert.equal(resetViewPlacement(options), undefined, 'the caller must use the entry/Fit seat instead');
});

test('the size fit transforms every vertex and instance bound once about the molecular anchor', () => {
  const geometry = { subject: [
    { center: [10, 20, 30], radius: 2 },
    ...Array.from({ length: 9000 }, (_, i) => ({ center: [10 + i, 20, 30], radius: 0 })),
  ], views: syntheticViews(), renderFromRoom: identity() };
  const fitted = fitEntryGeometry(geometry, { anchor: [10, 20, 30], moved: [3, 4, -4], ratio: .5 });
  assert.deepEqual(fitted.subject[0], { center: [3, 4, -4], radius: 1 });
  assert.deepEqual(fitted.subject.at(-1), { center: [3 + 8999 / 2, 4, -4], radius: 0 });
  assert.deepEqual(geometry.subject[0], { center: [10, 20, 30], radius: 2 });
  assert.equal(fitted.views, geometry.views);
});

// Zero clearance asks whether a saved placement already clears the drawn
// glass. Separation above or below the menu is separation.
const rendered = options => resetEntryGeometry({ ...options.geometry, cameraScale: 1, renderFromRoom: identity() });

test('box-pruned support is strictly equal to exhaustive support for 4,096 mixed-radius spheres', () => {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const spheres = Array.from({ length: 4096 }, () => ({
    center: [random() - .5, random() - .5, -1 + random() * .2], radius: random() * .02,
  }));
  const dot = (p, n) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  for (let i = 0; i < 100; i++) {
    const normal = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    const norm = Math.hypot(...normal);
    let exhaustive = Infinity;
    for (const sphere of spheres) exhaustive = Math.min(exhaustive,
      dot(sphere.center, normal) - sphere.radius * norm);
    assert.equal(subjectMargin(spheres, normal), exhaustive, `direction ${i}`);
  }
  const coincident = Array.from({ length: 2048 }, (_, i) => ({ center: [1, 2, 3], radius: i / 10000 }));
  assert.equal(subjectMargin(coincident, [0, 0, 0]), 0);
  assert.equal(subjectMargin(coincident, [1, -2, 3]), 6 - .2047 * Math.sqrt(14));

  const clusters = Array.from({ length: 1024 }, (_, i) => ({
    center: [i < 512 ? 0 : 10, 0, -1], radius: 0,
  }));
  assert.equal(subjectMargin(clusters, [1, 0, 0]), 0);
  clusters[900].center[0] = -100;
  assert.equal(subjectMargin(clusters, [1, 0, 0]), -100,
    'an exported support query reads a caller array after its contents change');
});

test('an extracted subject changed by its caller invalidates carried eye coordinates', () => {
  const options = input(), geometry = rendered(options);
  const points = [-.2, .2].flatMap(x => [-.2, .2].map(y => [x, y, -1]));
  const first = resetEntryLateralBreakdown({ geometry, points });
  for (const sphere of geometry.subject) sphere.center[0] += 100;
  const changed = resetEntryLateralBreakdown({ geometry, points });
  const uncached = resetEntryLateralBreakdown({ geometry: { ...geometry, subject: geometry.subject.slice() }, points });
  assert.deepEqual(changed, uncached);
  assert.notDeepEqual(changed, first);
});

test('a caller-mutated NaN coordinate follows applyMatrix4 into the solver refusal', () => {
  const object = mesh(identity(), [[0, 0, -1]]);
  const geometry = resetEntryGeometry({ objects: [object], fromPlacement: identity(),
    toPlacement: identity(), views: syntheticViews(), cameraScale: 1, renderFromRoom: identity() });
  geometry.subject[0].center[0] = NaN;
  const points = [[-.1, -.1, -1], [.1, .1, -1]];
  assert.equal(applyMatrix4(geometry.subject[0].center, geometry.views[0].transform.inverse.matrix), undefined);
  assert.throws(() => resetEntryLateralBreakdown({ geometry, points }), TypeError);
});

test('a replaced non-array center cannot reuse a previously carried eye', () => {
  const geometry = rendered(input());
  resetEntryLateralBreakdown({ geometry, points: [] });
  geometry.subject[0].center = Float64Array.from(geometry.subject[0].center);
  const points = [[-.1, -.1, -1], [.1, .1, -1]];
  assert.equal(applyMatrix4(geometry.subject[0].center, geometry.views[0].transform.inverse.matrix), undefined);
  assert.throws(() => resetEntryLateralBreakdown({ geometry, points }), TypeError);
});

test('an unchanged NaN radius reuses the extracted subject eye', () => {
  const geometry = rendered(input());
  geometry.subject[0].radius = NaN;
  const view = geometry.views[0], matrix = view.transform.inverse.matrix;
  let reads = 0;
  view.transform.inverse.matrix = new Proxy(matrix, { get(target, key) {
    if (key === 'join') return () => view.eye;
    if (typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key)) reads++;
    return Reflect.get(target, key);
  } });
  assert.equal(subjectVisibleInEyes(geometry), false);
  assert.ok(reads > 0, 'the first question carries the subject into the eye');
  reads = 0;
  assert.equal(subjectVisibleInEyes(geometry), false);
  assert.equal(reads, 0, 'the unchanged NaN radius leaves the carried eye valid');
});

test('one extracted subject carries both eyes across the questions in a solve', () => {
  const options = input(), geometry = rendered(options);
  const reads = { left: 0, right: 0 };
  for (const view of geometry.views) {
    const matrix = view.transform.inverse.matrix;
    view.transform.inverse.matrix = new Proxy(matrix, { get(target, key) {
      if (key === 'join') return () => view.eye;
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key)) reads[view.eye]++;
      return Reflect.get(target, key);
    } });
  }
  assert.equal(resetEntryLateralBreakdown({ geometry, points: [] }).eyes.length, 2);
  assert.ok(reads.left > geometry.subject.length && reads.right > geometry.subject.length);
  reads.left = reads.right = 0;
  assert.equal(subjectVisibleInEyes(geometry), true);
  assert.deepEqual(reads, { left: 0, right: 0 }, 'the second question reuses both carried eye arrays');
});

test('both-eye travel and diagnostic normals retain the original mixed-radius answers', () => {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const geometry = { subject: Array.from({ length: 4096 }, () => ({
    center: [random() - .5, random() - .5, -1 + random() * .2], radius: random() * .02,
  })), views: syntheticViews(), renderFromRoom: identity() };
  const menus = {
    empty: [], overlap: [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1])),
    clear: [-.8, .8].flatMap(x => [.7, .95].map(y => [x, y, -1])),
    enclosing: [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1])),
  };
  const expected = {
    empty: { forward: 0, zero: 0, lateral: 0, separated: true, normals: [[null, null], [null, null]] },
    overlap: { forward: 1.112398154733173, zero: Infinity, lateral: Infinity, separated: false,
      normals: [[null, null], [null, null]] },
    clear: { forward: 0, zero: 0, lateral: Infinity, separated: true, normals: [[0, -1], [0, -1]] },
    enclosing: { forward: Infinity, zero: Infinity, lateral: Infinity, separated: false,
      normals: [[null, null], [null, null]] },
  };
  for (const [name, points] of Object.entries(menus)) {
    const args = { geometry, points, forward: [0, 0, -1], maximum: 3, right: [1, 0, 0] };
    const want = expected[name], breakdown = resetEntryLateralBreakdown(args);
    assert.equal(resetEntryTravel(args), want.forward, name);
    assert.equal(resetEntryLateralTravel({ ...args, clearance: 0 }), want.zero, name);
    assert.equal(resetEntryLateralTravel(args), want.lateral, name);
    assert.equal(breakdown.separated, want.separated, name);
    assert.deepEqual(breakdown.eyes.map(eye => [eye.separationX, eye.separationY]), want.normals, name);
    assert.deepEqual(breakdown.eyes.map(eye => eye.eye), ['left', 'right'], name);
  }
});

test('axis-clear geometry exits before reading a subject hull or adjustment directions', () => {
  const subject = Array.from({ length: 4096 }, (_, i) => ({ center: [i / 4096 - .5, 0, -1], radius: 0 }));
  const map = subject.map.bind(subject);
  let carriedReads = 0;
  subject.map = visit => {
    const carried = map(visit);
    for (const sphere of carried) {
      const center = sphere.center;
      Object.defineProperty(sphere, 'center', { get() { carriedReads++; return center; } });
    }
    carried.map = () => { throw Error('subject hull requested'); };
    return carried;
  };
  const geometry = { subject, views: syntheticViews(), renderFromRoom: identity() };
  const points = [-.8, .8].flatMap(x => [.7, .95].map(y => [x, y, -1]));
  assert.equal(resetEntryTravel({ geometry, points, forward: [0, 0, -1], maximum: 3 }), 0);
  assert.equal(resetEntryLateralBreakdown({ geometry, points }).separated, true);
  assert.ok(carriedReads < subject.length * 12, `read ${carriedReads} centres`);
});

test('overlap witness avoids per-direction vertex reads in the saved-seat diagnosis', () => {
  const subject = Array.from({ length: 4096 }, (_, i) => ({
    center: [((i * 37) % 4096) / 4096 - .5, ((i * 73) % 4096) / 8192 - .25, -1], radius: 0,
  }));
  const map = subject.map.bind(subject);
  let reads = 0;
  subject.map = visit => {
    const carried = map(visit);
    for (const sphere of carried) {
      const center = sphere.center;
      Object.defineProperty(sphere, 'center', { get() { reads++; return center; } });
    }
    return carried;
  };
  const geometry = { subject, views: syntheticViews(), renderFromRoom: identity() };
  const points = [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1]));
  assert.equal(resetEntryLateralTravel({ geometry, points, right: [1, 0, 0], clearance: 0 }), Infinity);
  assert.ok(reads < subject.length * 2, `zero-clearance read ${reads} centres`);
  reads = 0;
  assert.equal(resetEntryLateralBreakdown({ geometry, points }).separated, false);
  assert.ok(reads < subject.length * 8, `read ${reads} centres for ${subject.length} vertices`);
});

test('the exact hull sorts only boundary candidates from a dense mesh', () => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const subject = [];
  while (subject.length < 8192) {
    const x = random() * 2 - 1, y = random() * 2 - 1;
    if (x * x + y * y < 1) subject.push({ center: [x * .5, y * .5, -1], radius: 0 });
  }
  const geometry = { subject, views: syntheticViews(), renderFromRoom: identity() };
  const points = [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1]));
  const sort = Array.prototype.sort;
  let largest = 0;
  Array.prototype.sort = function (...args) { largest = Math.max(largest, this.length); return sort.apply(this, args); };
  try { assert.ok(Number.isFinite(resetEntryTravel({ geometry, points, forward: [0, 0, -1], maximum: 3 }))); }
  finally { Array.prototype.sort = sort; }
  assert.ok(largest < subject.length / 2, `sorted ${largest} of ${subject.length} projected vertices`);
});

test('both-eye pruned hulls equal exhaustive sorted hulls on randomized mixed-radius subjects', () => {
  let seed = 9384;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const spheres = Array.from({ length: 8192 }, () => ({
    center: [(random() - .5) * 1.1, (random() - .5) * .8, -1 + random() * .3], radius: random() * .03,
  }));
  const exhaustive = points => {
    const values = points.map(p => [p[0] / -p[2], p[1] / -p[2]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const half = sorted => {
      const result = [];
      for (const p of sorted) {
        while (result.length >= 2 && cross(result.at(-2), result.at(-1), p) <= 0) result.pop();
        result.push(p);
      }
      return result.slice(0, -1);
    };
    const hull = [...half(values), ...half([...values].reverse())];
    return hull.flatMap((p, i) => {
      const q = hull[(i + 1) % hull.length], n = [q[1] - p[1], p[0] - q[0]], length = Math.hypot(...n);
      return length > 1e-12 ? [[n[0] / length, n[1] / length]] : [];
    });
  };
  for (const view of syntheticViews()) {
    const carried = spheres.map(s => ({ center: applyMatrix4(s.center, view.transform.inverse.matrix), radius: s.radius }));
    assert.deepEqual(hullNormals(carried, true), exhaustive(carried.map(s => s.center)), view.eye);
  }
});

test('dense projected hulls and first separating normals match an unfiltered reference', () => {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const referenceHull = points => {
    const sorted = points.map(p => [p[0] / -p[2], p[1] / -p[2]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const half = values => {
      const result = [];
      for (const point of values) {
        while (result.length >= 2 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
        result.push(point);
      }
      return result.slice(0, -1);
    };
    return [...half(sorted), ...half([...sorted].reverse())];
  };
  const normals = hull => hull.flatMap((p, i) => {
    const q = hull[(i + 1) % hull.length], n = [q[1] - p[1], p[0] - q[0]];
    const length = Math.hypot(...n);
    return length > 1e-12 ? [[n[0] / length, n[1] / length]] : [];
  });
  for (const seedStart of [7, 31, 9384]) {
    let seed = seedStart;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const cloud = Array.from({ length: 5000 }, (_, i) => {
      const x = random() * .8 - .4;
      const y = i % 11 === 0 ? .1 + x * 1e-13 : random() * .5 - .25;
      return [x, y, -1 - random() * .1];
    });
    for (let i = 0; i < 200; i++) cloud.push(cloud[i]);
    for (let i = 0; i < 200; i++) cloud.push([-.4 + i * .004, -.25, -1]);
    const hull = referenceHull(cloud);
    assert.deepEqual(projectedHull(cloud), hull, `seed ${seedStart}: complete ordered hull`);
    assert.deepEqual(hullNormals(cloud), normals(hull), `seed ${seedStart}: hull normals`);
    const subject = cloud.map(center => ({ center, radius: 0 }));
    const views = syntheticViews();
    const geometry = { subject, views, renderFromRoom: identity() };
    for (const menu of [[-.2, .2], [-.9, -.7]].map(xs =>
      xs.flatMap(x => [-.15, .15].map(y => [x, y, -1])))) {
      const answer = resetEntryLateralBreakdown({ geometry, points: menu });
      for (const [index, view] of views.entries()) {
        const matrix = view.transform.inverse.matrix;
        const glass = menu.map(p => applyMatrix4(p, matrix));
        const carried = subject.map(s => ({ center: applyMatrix4(s.center, matrix), radius: s.radius }));
        const directions = [...normals(referenceHull(glass)),
          ...normals(referenceHull(carried.map(s => s.center)))];
        for (let degrees = 0; degrees < 360; degrees += 5)
          directions.push([Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]);
        const first = directions.find(([x, y]) => {
          const edge = Math.max(...glass.map(p => (x * p[0] + y * p[1]) / -p[2]));
          const norm = Math.hypot(x, y, edge);
          return carried.every(s => s.center[0] * x + s.center[1] * y + s.center[2] * edge
            - s.radius * norm > 1e-10);
        });
        assert.equal(answer.eyes[index].separated, Boolean(first), `seed ${seedStart}, ${view.eye}: separation`);
        assert.deepEqual([answer.eyes[index].separationX, answer.eyes[index].separationY],
          first ?? [null, null], `seed ${seedStart}, ${view.eye}: first normal`);
      }
    }
  }
});

test('randomized mixed-radius fit candidates read each base eye once, and match exhaustive candidate reads', () => {
  let seed = 745;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let reads = 0;
  const subject = Array.from({ length: 4096 }, () => {
    const center = [(random() - .5) * .4, (random() - .5) * .3, -1 + (random() - .5) * .1];
    return { get center() { reads++; return center; }, radius: random() * .005 };
  });
  const geometry = { subject, views: syntheticViews(), renderFromRoom: identity() };
  const menus = [[], [-.5, -.25].flatMap(x => [-.3, .3].map(y => [x, y, -1]))];
  for (const ratio of [.3, .5, 1, 1.4]) for (const points of menus) {
    const fitted = fitEntryGeometry(geometry, { anchor: [0, 0, -1], moved: [.15, 0, -1], ratio });
    const before = reads;
    const fast = resetEntryLateralTravel({ geometry: fitted, points, right: [1, 0, 0] });
    assert.ok(reads - before <= subject.length * 2, `candidate re-read ${reads - before} base centres`);
    const slow = resetEntryLateralTravel({ geometry: { ...fitted }, points, right: [1, 0, 0] });
    assert.ok(fast === slow || Math.abs(fast - slow) < 1e-9, `${ratio}: ${fast} vs ${slow}`);
  }
});

test('fit centring skips exact boxes instead of scanning every sphere for each candidate', () => {
  let seed = 3;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const subject = Array.from({ length: 8192 }, () => ({
    center: [(random() - .5) * .5, (random() - .5) * .3, -1 + (random() - .5) * .1],
    radius: random() * .001,
  }));
  const geometry = { subject, views: syntheticViews(), renderFromRoom: identity() };
  const sqrt = Math.sqrt;
  let reads = 0;
  Math.sqrt = (...args) => { reads++; return sqrt(...args); };
  try {
    for (const ratio of [.3, .4, .5, .6, .7, .8]) {
      const fitted = fitEntryGeometry(geometry, { anchor: [0, 0, -1], moved: [0, 0, -1], ratio });
      assert.equal(resetEntryLateralTravel({ geometry: fitted, points: [], right: [1, 0, 0] }), 0);
    }
  } finally { Math.sqrt = sqrt; }
  assert.ok(reads < subject.length * 2, `centring scanned ${reads} spheres over six candidates and both eyes`);
});

test('centered fit extracts its full mesh once before forward Reset', () => {
  const options = input();
  options.fit = true;
  let bufferReads = 0;
  const position = options.geometry.objects[0].values.aPosition.ref;
  const vertices = position.value;
  Object.defineProperty(position, 'value', { get() { bufferReads++; return vertices; } });
  const result = resetViewPlacement(options);
  assert.ok(result.resetTravelMeters > 0);
  assert.equal(bufferReads, 1, 'centered placement and fit must share one exact extraction');
});

test('the lateral solve reads a fit candidate from its base, never rebuilding its vertices, and agrees with them', () => {
  // A Quest 2 cartoon has hundreds of thousands of vertices, and the size fit
  // asks about twenty candidates inside one XR frame. Rebuilding each one held
  // the first frame after Enter VR for 15 s on 4HHB.
  const options = input();
  options.geometry.objects = [mesh(options.geometry.fromPlacement,
    [-.05, .05].flatMap(x => [-.1, .1].map(y => [x, y, 0])))];
  const base = rendered(options);
  // Count every vertex the fast path reads, so a return to scanning each
  // candidate's vertices fails here even without the eager rebuild.
  let reads = 0, counting = false;
  base.subject = base.subject.map(({ center, radius }) => ({ get center() { if (counting) reads++; return center; }, radius }));
  const points = [-.3, -.04].flatMap(x => [-.5, .5].map(y => [x, y, -1]));
  let rebuilt = 0;
  const map = base.subject.map;
  base.subject.map = function (...args) { rebuilt++; return map.apply(this, args); };
  // The per-vertex solver this replaced gave these answers for the same candidates.
  const before = [0.027455064928217587, 0.002455064928217586, 0.05434607791386111, 0, -0.497, Infinity];
  const answers = [[1, [0, 0, -1]], [.5, [0, 0, -1]], [1.5, [0, 0, -1.2]], [.25, [.02, 0, -.9]], [1, [.6, 0, -1]], [3, [0, 0, -1]]]
    .map(([ratio, moved], i) => {
      const fitted = fitEntryGeometry(base, { anchor: [0, 0, -1], moved, ratio });
      counting = true;
      const fast = resetEntryLateralTravel({ geometry: fitted, points, right: [1, 0, 0] });
      counting = false;
      assert.equal(rebuilt, 0, 'the candidate answered from the base extremes');
      // A spread copy carries the vertices but not the fit, so it takes the per-vertex path.
      const slow = resetEntryLateralTravel({ geometry: { ...fitted }, points, right: [1, 0, 0] });
      rebuilt = 0;
      for (const other of [slow, before[i]])
        assert.ok(fast === other || Math.abs(fast - other) < 1e-9, `ratio ${ratio}: ${fast} against ${other}`);
      return fast;
    });
  assert.ok(answers.some(Number.isFinite) && answers.some(answer => answer === Infinity), `both outcomes are exercised: ${answers}`);
  assert.ok(reads <= base.views.length * base.subject.length,
    `six candidates read each vertex at most once per eye, not once per candidate: ${reads} reads`);
});
const savedClearance = options => resetEntryLateralTravel({ geometry: rendered(options),
  points: options.points, right: [1, 0, 0], clearance: 0 });
const menuAbove = [-.8, .8].flatMap(x => [.7, .95].map(y => [x, y, -1]));

test('a saved placement wholly below the menu already clears it in both eyes', () => {
  const options = input();
  options.points = menuAbove;
  assert.equal(savedClearance(options), 0, 'full separation in projection, not only the two lateral edges');
});

test('a saved placement laterally clear of the menu still already clears it', () => {
  const options = input();
  options.points = [-1, -.75].flatMap(x => [-.8, .8].map(y => [x, y, -1]));
  assert.equal(savedClearance(options), 0);
});

test('a saved placement the menu overlaps is still refused, and Done fits instead', () => {
  const options = input();
  assert.equal(savedClearance(options), Infinity, 'the caller must spend the fit path');
});

test('Done keeps the saved seat itself when the menu sits wholly above the molecule', () => {
  const options = { ...input(), centered: false, bounded: true, fit: true, restoreSaved: true };
  options.points = menuAbove;
  assert.equal(resetViewPlacement(options), options.seat, 'Done must not shrink a view that was clear');
});
