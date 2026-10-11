import assert from 'node:assert/strict';
import test from 'node:test';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { fitEntryGeometry } from './reset-entry-geometry.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { lensTangent, SUBJECT_SHIFT_LIMIT } from './plate-standoff.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const multiply = (a, b) => Array.from({ length: 16 }, (_, i) =>
  [0, 1, 2, 3].reduce((n, k) => n + a[(i % 4) + k * 4] * b[k + 4 * Math.floor(i / 4)], 0));
const frame = (degrees, origin) => {
  const c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, ...origin, 1];
};

function input({ side = -1, nonidentity = false, large = 1, asymmetric = false } = {}) {
  // Conservative box enclosing the measured public tubulin wall in the
  // stable IWER run. This is a test enclosure, not an exact captured mesh.
  const size = [1.3370593062821032, 1.1418704212576043, 1.0326298010584418];
  const radius = 1.8 * large, factor = radius / Math.hypot(...size.map(v => v / 2));
  const headInRoom = frame(35, [1.2, -1.5, -.8]);
  const renderFromRoom = nonidentity ? frame(-19, [.3, .2, -.7]) : identity();
  const intoRender = multiply(renderFromRoom, headInRoom);
  const centre = applyMatrix4([0, .4, -4], intoRender);
  const views = syntheticViews().map(view => {
    const matrix = multiply(intoRender, view.transform.matrix);
    const projectionMatrix = [...view.projectionMatrix];
    if (asymmetric) projectionMatrix[8] = view.eye === 'left' ? -.08 : .06;
    return { ...view, projectionMatrix, transform: { matrix, inverse: { matrix: invertMatrix4(matrix) } } };
  });
  const subject = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => ({
    center: applyMatrix4([x * size[0] * factor / 2, .4 + y * size[1] * factor / 2,
      -4 + z * size[2] * factor / 2], intoRender), radius: 0,
  }))));
  const points = [.81, .04].flatMap(x => [-.59, .77].map(y =>
    applyMatrix4([side * x * 1.25, y * 1.25, -1.25], headInRoom)));
  return { seat: { scale: 1, rotation: [0, 0, 0], translation: centre.map(v => v / radius) },
    fit: true, cameraScale: 1, center: [0, 0, 0], radius, headInRoom, renderFromRoom, points,
    renderedGeometry: { subject, views, renderFromRoom } };
}

function assertClear(options, result) {
  const anchor = options.seat.translation.map(v => v * options.radius);
  const moved = result.translation.map(v => v * options.radius);
  const geometry = fitEntryGeometry(options.renderedGeometry, { anchor, moved, ratio: result.scale });
  for (const view of geometry.views) {
    const inverse = view.transform.inverse.matrix;
    const subject = geometry.subject.map(s => applyMatrix4(s.center, inverse));
    const menu = options.points.map(p => applyMatrix4(applyMatrix4(p, options.renderFromRoom), inverse));
    const project = p => p[0] / -p[2];
    const xs = subject.map(project), glass = menu.map(project);
    assert.ok(Math.min(...xs) > Math.max(...glass) || Math.max(...xs) < Math.min(...glass), 'full menu separation in each eye');
    for (const p of subject) {
      assert.ok(p[2] < -.01 && p[2] > -100, 'physical depth remains inside near/far planes');
      const clip = applyMatrix4(p, view.projectionMatrix);
      assert.ok(clip.every(v => Math.abs(v) <= 1 + 1e-8), 'every enclosure vertex remains in the real eye frustum');
      assert.ok(Math.abs(project(p)) <= lensTangent(SUBJECT_SHIFT_LIMIT) + 1e-8, 'existing sideways edge limit');
    }
  }
}

for (const side of [-1, 1]) for (const nonidentity of [false, true]) {
  test(`automatic fit uses free binocular field before shrinking (menu ${side}, transformed ${nonidentity})`, () => {
    const options = input({ side, nonidentity, asymmetric: true });
    const result = resetViewPlacement(options);
    assert.equal(result.scale, 1, 'retain requested 3.6 metre bounding diameter');
    assert.notDeepEqual(result.translation, options.seat.translation);
    assertClear(options, result);
  });
}

test('a subsequent automatic appearance keeps the accepted larger seat exactly', () => {
  const options = input(), placed = resetViewPlacement(options);
  const anchor = options.seat.translation.map(v => v * options.radius), moved = placed.translation.map(v => v * options.radius);
  const next = { ...options, seat: placed, keepClearSeat: true,
    renderedGeometry: fitEntryGeometry(options.renderedGeometry, { anchor, moved, ratio: placed.scale }) };
  assert.equal(resetViewPlacement(next), placed);
});

function acceptedEntry() {
  const options = input(), placed = resetViewPlacement(options);
  const anchor = options.seat.translation.map(v => v * options.radius), moved = placed.translation.map(v => v * options.radius);
  return { ...options, seat: placed,
    renderedGeometry: fitEntryGeometry(options.renderedGeometry, { anchor, moved, ratio: placed.scale }) };
}

for (const policy of [{ restoreSaved: true }, { centered: true }]) {
  test(`a proven current automatic entry survives ${policy.centered ? 'Reset' : 'Done'} without motion`, () => {
    const options = { ...acceptedEntry(), ...policy };
    assert.equal(resetViewPlacement({ ...options, retainFreeFieldSeat: true }), options.seat);
    assert.ok(resetViewPlacement(options).scale < options.seat.scale, 'unidentified saved poses retain the existing policy');
  });
}

test('known-entry retention falls through unchanged when new glass overlaps it', () => {
  const options = { ...acceptedEntry(), restoreSaved: true };
  options.points = [-.7, .7].flatMap(x => [-.7, .7].map(y =>
    applyMatrix4([x * 1.25, y * 1.25, -1.25], options.headInRoom)));
  const expected = resetViewPlacement(options);
  const actual = resetViewPlacement({ ...options, retainFreeFieldSeat: true });
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, options.seat);
});

test('known-entry retention refuses the old pose when tracked eye frusta no longer contain it', () => {
  const options = { ...acceptedEntry(), restoreSaved: true };
  // Equivalent to a narrower current visible field; all whole-mesh clips
  // must be repeated even for a pose with valid entry provenance.
  options.renderedGeometry = { ...options.renderedGeometry,
    views: options.renderedGeometry.views.map(view => ({ ...view,
      projectionMatrix: view.projectionMatrix.map((v, i) => i === 0 ? v * 4 : v) })) };
  const expected = resetViewPlacement(options);
  const actual = resetViewPlacement({ ...options, retainFreeFieldSeat: true });
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, options.seat);
});

test('known-entry retention rechecks a turned head with unchanged eye projections', () => {
  const options = { ...acceptedEntry(), restoreSaved: true };
  const oldHead = options.headInRoom;
  options.headInRoom = frame(125, oldHead.slice(12, 15));
  const turn = multiply(options.headInRoom, invertMatrix4(oldHead));
  options.renderedGeometry = { ...options.renderedGeometry,
    views: options.renderedGeometry.views.map(view => {
      const matrix = multiply(turn, view.transform.matrix);
      return { ...view, transform: { matrix, inverse: { matrix: invertMatrix4(matrix) } } };
    }) };
  const expected = resetViewPlacement(options);
  const actual = resetViewPlacement({ ...options, retainFreeFieldSeat: true });
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, options.seat);
});

test('saved-pose and centred Reset fitting retain their narrow-centre policy', () => {
  for (const flags of [{ restoreSaved: true }, { centered: true }]) {
    const options = { ...input(), ...flags }, result = resetViewPlacement(options);
    assert.ok(result.scale < .5);
    assertClear(options, result);
  }
});

test('a requested shape too large for both eyes still shrinks and cannot gain scale', () => {
  const options = input({ large: 3 }), result = resetViewPlacement(options);
  assert.ok(result.scale < 1 && result.scale > 0);
  assertClear(options, result);
});

test('missing rendered geometry keeps the existing conservative sphere fit', () => {
  const options = input(); delete options.renderedGeometry;
  const auto = resetViewPlacement(options), saved = resetViewPlacement({ ...options, restoreSaved: true });
  assert.deepEqual(auto, saved);
  assert.ok(auto.scale < 1);
});
