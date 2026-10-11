import test from 'node:test';
import vm from 'node:vm';
import { Visual } from 'molstar/lib/mol-repr/visual.js';
import { createIdentityTransform } from 'molstar/lib/mol-geo/geometry/transform-data.js';
import { ValueCell } from 'molstar/lib/mol-util/index.js';
import * as measurement from './component-label-measurement.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLabelMeasurementGate, labelObjectRenderable, labelObjectVisible, measureComponentLabels, projectPlateQuad, renderedLabelQuads, renderedLeaderEm, renderedSubjectPoints, renderedSubjectSpheres, viewTangentBounds } from './component-label-measurement.mjs';
import { sanitizeDetail, collectSessionFacts, MAX_DETAIL_KEYS, MAX_DETAIL_ITEMS } from './headset-diagnostics.mjs';
import { componentLabelPaint } from './component-labels.mjs';
import { layoutDiagnosticEntry, syntheticViews, plate, identity } from './fixtures/component-label-diagnostics.mjs';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const views = syntheticViews();

test('the real layout producer keeps all twenty-nine fields and all ten rectangles', () => {
  const { detail } = layoutDiagnosticEntry();
  // Twenty-five output fields, then the anchors,
  // obstacles, inputs and search summary, which a device ring replays from.
  assert.equal(Object.keys(detail).length, 29);
  assert.equal(detail.anchors.length, 10);
  assert.deepEqual(detail.anchors[0], { id: 'part-0', x: -0.5, y: 0, z: 400, r: 5, w: 0.02, h: 0.03, lines: 1, focused: true });
  assert.deepEqual(detail.obstacles, [{ x: -0.55, y: -0.2, hw: 0.17, hh: 0.35 }]);
  assert.deepEqual(detail.inputs, { characterUnits: 0.08, minSizeScale: 1, contextAlpha: 0.35, standoff: 0.5, clearance: 0,
    fieldHalfWidth: 0.6, fieldHalfHeight: 0.58, subjectX: 0, subjectY: 0.1, subjectHalfWidth: 0.2, subjectHalfHeight: 0.3 });
  assert.deepEqual(detail.search, { nodes: 12, slots: 2048, complete: true, resolution: 0.03 });
  assert.equal(detail.predicted, true);
  assert.equal(detail.basis, 'head');
  assert.equal(detail.reason, 'scene');
  assert.deepEqual(sanitizeDetail(detail), detail);
  assert.equal(detail.rects.length, 10);
  assert.deepEqual(detail.rects[9], { id: 'part-9', x: 0.9, y: 0.1, hw: 0.02, hh: 0.03 });
  assert.deepEqual(detail.silhouette, [0, 0.1, 0.2, 0.3]);
  assert.equal(detail.menuReason, 'expand,reseat');
});

test('bounded diagnostics still cap overflow and preserve session input profiles', () => {
  const detail = { items: Array.from({ length: MAX_DETAIL_ITEMS + 1 }, (_, i) => i),
    ...Object.fromEntries(Array.from({ length: MAX_DETAIL_KEYS + 1 }, (_, i) => [`k${i}`, i])) };
  const kept = sanitizeDetail(detail);
  assert.equal(Object.keys(kept).length, MAX_DETAIL_KEYS);
  assert.equal(kept.items.length, MAX_DETAIL_ITEMS);
  const facts = collectSessionFacts({ describeInputSources: () => [{ profiles: ['oculus-touch-v3', 'generic-trigger'] }] });
  assert.equal(facts.inputSources[0].profiles, 'oculus-touch-v3,generic-trigger');
  assert.deepEqual(sanitizeDetail(facts), facts);
});

test('64 mm stereo views measure known world quads in tangent units, with 42/45 degree half-fields', () => {
  const records = measureComponentLabels({ plates: [plate('known', 0.2, 0.1, 2, 0.1, 0.05)], views });
  for (const [i, record] of records.entries()) {
    assert.equal(record.eye, i === 0 ? 'left' : 'right');
    close(record.rects[0].x, i === 0 ? 0.116 : 0.084);
    close(record.rects[0].y, 0.05); close(record.rects[0].hw, 0.05); close(record.rects[0].hh, 0.025);
    close(record.fov[0], -Math.tan(42 * Math.PI / 180)); close(record.fov[2], 1);
    assert.equal(record.visible, 1); assert.equal(record.offGlass, 0);
  }
});

test('different depths overlap in the left eye only, missed by a centre-eye prediction', () => {
  const plates = [plate('near', 0, 0, 1, 0.01, 0.01), plate('far', 0.06, 0, 2, 0.02, 0.02)];
  const centre = { ...views[0], transform: { matrix: identity(), inverse: { matrix: identity() } } };
  assert.equal(measureComponentLabels({ plates, views: [centre] })[0].overlaps, 0);
  assert.deepEqual(measureComponentLabels({ plates, views }).map(r => r.overlaps), [1, 0]);
});

test('off-glass and the clipped edge differ by eye; wholly outside plates are invisible', () => {
  const right = Math.tan(42 * Math.PI / 180);
  const records = measureComponentLabels({ plates: [plate('edge', right - 0.03, 0, 1, 0.02, 0.02)], views });
  assert.deepEqual(records.map(r => r.offGlass), [1, 0]);
  assert.deepEqual(records.map(r => r.visible), [1, 1]);
  close(records[0].rects[0].x + records[0].rects[0].hw, right);
  close(records[0].rects[0].hw, 0.009);
  const outside = measureComponentLabels({ plates: [plate('out', 3, 0, 1, 0.02, 0.02)], views });
  assert.deepEqual(outside.map(r => [r.offGlass, r.visible]), [[1, 0], [1, 0]]);
});

test('off-glass uses the ninety-percent area threshold across a wrapped plate', () => {
  const view = views[0], right = viewTangentBounds(view)[1];
  // Left-eye centre is right - 0.016: 90% of a 0.04-wide quad is inside.
  const boundary = plate('boundary', right - 0.016 - 0.032, 0, 1, 0.02, 0.02);
  assert.equal(measureComponentLabels({ plates: [boundary], views: [view] })[0].offGlass, 0);
  const outside = plate('outside', right - 0.015 - 0.032, 0, 1, 0.02, 0.02);
  assert.equal(measureComponentLabels({ plates: [outside], views: [view] })[0].offGlass, 1);
  // A small second line is half clipped, but is only 1/11 of the paint area:
  // the whole plate retains 95.45%, so it must not be marked off-glass.
  const big = plate('big', 0, 0, 1, 0.1, 0.1);
  const small = plate('small', right - 0.032, 0.2, 1, 0.01, 0.1);
  const wrapped = { id: 'wrapped', quads: [...big.quads, ...small.quads] };
  assert.equal(measureComponentLabels({ plates: [wrapped], views: [view] })[0].offGlass, 0);
});

test('a quad crossing the eye plane is clipped before perspective division', () => {
  const quad = [[-0.2, -0.2, -1], [0.2, -0.2, -1], [0.2, 0.2, 0.1], [-0.2, 0.2, 0.1]];
  const result = projectPlateQuad(quad, views[0]);
  assert.ok(result.rect);
  assert.ok(Object.values(result.rect).every(Number.isFinite));
  const [left, right, top, bottom] = viewTangentBounds(views[0]);
  assert.ok(result.rect.x - result.rect.hw >= left - 1e-8);
  assert.ok(result.rect.x + result.rect.hw <= right + 1e-8);
  assert.ok(result.rect.y - result.rect.hh >= bottom - 1e-8);
  assert.ok(result.rect.y + result.rect.hh <= top + 1e-8);
});

test('subject silhouette is projected separately in each eye', () => {
  const records = measureComponentLabels({ plates: [plate('far', 0.06, 0, 2, 0.02, 0.02)], views,
    subject: { center: [0, 0, -1], radius: 0.005 } });
  assert.deepEqual(records.map(r => r.subject), [1, 0]);
  for (const depth of [0.001, 101]) {
    const clipped = measureComponentLabels({ plates: [plate('near', 0, 0, 1, 0.1, 0.1)], views,
      subject: { center: [0, 0, -depth], radius: 0.0001 } });
    assert.deepEqual(clipped.map(r => r.subject), [0, 0]);
  }
});

test('hidden, absent and zero-alpha plates do not count as visible or overlapping', () => {
  for (const state of [{ hidden: true }, { exists: false }, { alpha: 0 }]) {
    const records = measureComponentLabels({ plates: [{ ...plate('hidden', 0, 0, 1, 0.1, 0.1), ...state }], views });
    assert.deepEqual(records.map(r => [r.plates, r.visible, r.overlaps]), [[1, 0, 0], [1, 0, 0]]);
  }
});

function renderObject() {
  const paint = componentLabelPaint({ placeAlpha: 1, contextAlpha: 1, offsetZ: 0.1 });
  const aTransform = identity(); aTransform[12] = 0.4; aTransform[14] = -4;
  return { state: { visible: true, alphaFactor: 1 }, values: Object.fromEntries(Object.entries({
    aPosition: new Float32Array(12), aMapping: [-2, -0.5, 2, -0.5, 2, 0.5, -2, 0.5],
    aTexCoord: Array(8).fill(10), aDepth: [0, 0, 0, 0], aTransform,
    elements: new Uint32Array([0, 1, 2, 0, 2, 3]), drawCount: 6, instanceCount: 1,
    dSizeType: 'uniform', uSize: 1, uSizeFactor: 0.1, uOffsetX: 0.2, uOffsetY: 0,
    uOffsetZ: paint.backing.offsetZ, alpha: paint.backing.alpha,
  }).map(([k, value]) => [k, { ref: { value } }])) };
}

test('live committed transforms, mapping extents, paint offsets and alpha drive the measurement', () => {
  const object = renderObject(), view = { ...views[0], eye: undefined }, scale = 0.5;
  const quads = renderedLabelQuads(object, view, scale);
  assert.equal(quads.length, 1);
  const c = [0.232, 0, -2], p = view.projectionMatrix;
  const bias = 0.001 * Math.hypot(-0.032 - p[0] * c[0], 0, -(p[10] * c[2] + p[14]));
  const pushRatio = 1 - (0.05 - bias) / Math.hypot(...c);
  const r = projectPlateQuad(quads[0].corners, view).rect;
  close(r.x, (c[0] * pushRatio + 0.1) / (2 * pushRatio));
  close(r.hw, 0.1 / (2 * pushRatio)); close(r.hh, 0.025 / (2 * pushRatio));
  const measure = () => measureComponentLabels({ plates: [{ id: 'live', objects: [object] }], views, cameraScale: scale });
  assert.deepEqual(measure().map(r => r.visible), [1, 1]);
  object.state.visible = false; assert.deepEqual(measure().map(r => r.visible), [0, 0]);
  object.state.visible = true; object.state.alphaFactor = 0;
  assert.deepEqual(measure().map(r => r.visible), [0, 0]);
});

test('a committed text object with no alpha cell is still drawable evidence', () => {
  const object = renderObject();
  delete object.values.alpha;
  assert.equal(labelObjectVisible(object), true);
  assert.equal(labelObjectRenderable(object), true);
  delete object.values.aTransform;
  assert.equal(labelObjectRenderable(object), false);
});

test('leader em comes from the committed tether geometry and disappears when hidden', () => {
  const leader = renderObject();
  leader.values.aMapping.ref.value = [0, 0, 2.4, 0.1, 2.4, -0.1, 2.4, 0];
  close(renderedLeaderEm(leader), 3);
  const measure = () => measureComponentLabels({ plates: [{ ...plate('led', 0, 0, 1, 0.1, 0.1), leaders: [leader] }], views });
  for (const record of measure()) close(record.leaderEm, 3);
  leader.state.visible = false;
  assert.deepEqual(measure().map(r => r.leaderEm), [0, 0]);
});

test('rotated XR view transforms project a world quad through the eye inverse', () => {
  const matrix = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const inverse = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];
  const view = { ...views[0], transform: { matrix, inverse: { matrix: inverse } } };
  const rect = projectPlateQuad([[-2, -0.1, 0.2], [-2, -0.1, -0.2], [-2, 0.1, -0.2], [-2, 0.1, 0.2]], view).rect;
  close(rect.x, 0); close(rect.y, 0); close(rect.hw, 0.1); close(rect.hh, 0.05);
});

test('asymmetric projection bounds and near/far clipping use the XR projection matrix', () => {
  const view = syntheticViews()[0]; view.projectionMatrix[8] = 0.2; view.projectionMatrix[9] = -0.1;
  close(viewTangentBounds(view)[0], -0.8 / view.projectionMatrix[0]);
  const known = measureComponentLabels({ views: [view], plates: [plate('known', 0, 0, 1, 0.01, 0.01)] })[0];
  close(known.rects[0].x, 0.032);
  for (const depth of [-1, 0.001, 101]) assert.equal(measureComponentLabels({ views: [view], plates: [plate('clipped', 0, 0, depth, 0.01, 0.01)] })[0].visible, 0);
});

test('subject and plate projections of the same points agree through the full projection matrix', () => {
  for (const view of syntheticViews()) {
    const p = view.projectionMatrix;
    p[8] = .2; p[9] = -.1;
    // Skew prevents the clip-to-tangent conversion from reducing to x/d, y/d.
    p[4] = .15; p[1] = -.1;
    const corners = plate('same', .2, .1, 2, .1, .05).quads[0].corners;
    const rect = projectPlateQuad(corners, view).rect;
    const subject = measureComponentLabels({ views: [view], subject: { points: corners } })[0];
    subject.silhouette.forEach((value, i) => close(value, [rect.x, rect.y, rect.hw, rect.hh][i]));
    // A single subject vertex must also land on its corresponding plate edge.
    const point = measureComponentLabels({ views: [view], subject: { points: [corners[0]] } })[0];
    close(point.silhouette[0], rect.x - rect.hw);
  }
});

test('all ten measured rectangles and all record fields survive sanitization whole', () => {
  const plates = Array.from({ length: 10 }, (_, i) => plate(`part-${i}`, (i - 5) / 10, 0, 2, 0.04, 0.02));
  for (const record of measureComponentLabels({ plates, views })) {
    assert.equal(record.rects.length, 10);
    assert.deepEqual(Object.keys(record), ['eye', 'plates', 'visible', 'overlaps', 'offGlass', 'subject', 'silhouette', 'leaderEm', 'rects', 'fov']);
    assert.equal(record.silhouette, null);
    assert.deepEqual(sanitizeDetail(record), record);
  }
});

test('layout/menu invalidations wait for a drawable commit and never measure every frame', () => {
  const gate = createLabelMeasurementGate();
  assert.equal(gate.due(0, true, views), false);
  gate.invalidate(); assert.equal(gate.due(0, false, views), false);
  assert.equal(gate.due(0, true, []), false); assert.equal(gate.due(0, true, views), true);
  gate.retry(0); assert.equal(gate.due(16, true, views), false);
  assert.equal(gate.due(1000, true, views), true);
  gate.measured(1000); assert.equal(gate.due(2000, true, views), false);
  gate.invalidate(); gate.invalidate(); assert.equal(gate.due(1999, true, views), false);
  assert.equal(gate.due(2000, true, views), true); gate.measured(2000);
  assert.equal(gate.due(2000, true, views), false);
});

test('the viewer measures after commits and adoption, on the presenting post-render pose', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  assert.match(source, /onHeadFrame:[\s\S]*?frame\.getViewerPose\(offset\)[\s\S]*?measureDrawnComponentLabels\(pose\)/);
  assert.match(source, /await builder\.commit\(\)[\s\S]*?applyInspectionTransform\(created\)[\s\S]*?labelMeasurementGate\.invalidate\(\)/);
  assert.match(source, /pending\.plates\.some\(plate => !live\.has\(plate\.ref\)\)/);
  assert.match(source, /labelMeasurementGate\.retry\(now\)/);
  assert.match(source, /committed\.some\(plate => plate\.lines\.some\(objects => !objects\.some\(labelObjectRenderable\)/);
  assert.match(source, /onMenuPlaced:[\s\S]*?labelMeasurementGate\.invalidate\(\)/);
});

const mul4 = (m, v) => [0, 1, 2, 3].map(i => m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2] + m[i + 12] * v[3]);
const mat4 = (a, b) => Array.from({ length: 16 }, (_, i) => {
  const row = i % 4, col = (i - row) / 4;
  return a[row] * b[col * 4] + a[row + 4] * b[col * 4 + 1] + a[row + 8] * b[col * 4 + 2] + a[row + 12] * b[col * 4 + 3];
});
/**
 * Mol* 5.11 `text.vert` for one stereo eye pass, on the same inputs the
 * measurement reads: uHasHeadRotation false (the session holds it at zero) and
 * uHasEyeCamera false, because `StereoCamera`'s eye cameras are created with a
 * zero `viewEye` that nothing in the XR path ever writes. uModelView is the
 * eye view times `Mat4.scaleUniformly(identity, uModelScale)`.
 */
function textVertTangentRect(object, view, scale) {
  const v = name => object.values[name].ref.value;
  const P = view.projectionMatrix, eye = view.transform.matrix.slice(12, 15);
  const model = identity(); model[0] = model[5] = model[10] = scale;
  const modelView = mat4(view.transform.inverse.matrix, model);
  const size = v('uSize') * v('uSizeFactor');
  const xs = [], ys = [];
  for (let i = 0; i < 4; i++) {
    const position = [v('aPosition')[i * 3], v('aPosition')[i * 3 + 1], v('aPosition')[i * 3 + 2], 1];
    const mv = mul4(modelView, mul4(v('aTransform'), position));
    let offsetZ = (v('uOffsetZ') + v('aDepth')[i] * 0.95) * scale;
    if (v('aTexCoord')[i * 2] === 10) {
      const c = mul4(P, mv);
      offsetZ -= 0.001 * Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]);
    }
    const n = Math.hypot(mv[0], mv[1], mv[2]);
    const clip = mul4(P, [mv[0] - mv[0] / n * offsetZ, mv[1] - mv[1] / n * offsetZ, mv[2] - mv[2] / n * offsetZ, 1]);
    clip[0] += P[0] * (v('aMapping')[i * 2] * size * scale + v('uOffsetX') * scale);
    clip[1] += P[5] * (v('aMapping')[i * 2 + 1] * size * scale + v('uOffsetY') * scale);
    xs.push((clip[0] / clip[3] + P[8]) / P[0]); ys.push((clip[1] / clip[3] + P[9]) / P[5]);
  }
  const l = Math.min(...xs), r = Math.max(...xs), b = Math.min(...ys), t = Math.max(...ys);
  return { x: (l + r) / 2, y: (b + t) / 2, hw: (r - l) / 2, hh: (t - b) / 2 };
}

/** A GAR1-sized plate at the acceptance-3 telomerase entry numbers. */
function entryPlateObject() {
  const paint = componentLabelPaint({ placeAlpha: 1, contextAlpha: 1, offsetZ: 50 * 1.898 });
  const aTransform = identity(); aTransform[12] = 10; aTransform[13] = 20; aTransform[14] = -343;
  return { state: { visible: true, alphaFactor: 1 }, values: Object.fromEntries(Object.entries({
    aPosition: new Float32Array(12), aMapping: [-1.8, 0.7, -1.8, -0.5, 1.8, 0.7, 1.8, -0.5],
    aTexCoord: Array(8).fill(10), aDepth: [0, 0, 0, 0], aTransform,
    elements: new Uint32Array([0, 1, 2, 0, 2, 3]), drawCount: 6, instanceCount: 1,
    dSizeType: 'uniform', uSize: 1, uSizeFactor: 11.82, uOffsetX: 0.3 * 343, uOffsetY: -0.4 * 343,
    uOffsetZ: paint.backing.offsetZ, alpha: paint.backing.alpha,
  }).map(([k, value]) => [k, { ref: { value } }])) };
}

test('XR eye quads land where text.vert draws them: the Z offset push scales every corner offset', () => {
  // The entry plates were drawn half to one plate width
  // off their recorded rectangles because the record skipped the push a
  // stereo eye pass still applies. Same inputs, same rectangle, both eyes.
  const object = entryPlateObject(), scale = 0.0108;
  for (const view of views) {
    const quad = renderedLabelQuads(object, view, scale)[0];
    const measured = projectPlateQuad(quad.corners, view).rect;
    const drawn = textVertTangentRect(object, view, scale);
    for (const key of ['x', 'y', 'hw', 'hh']) close(measured[key], drawn[key]);
    // The anchor stays put on the glass; the fan offset and the glyphs do not.
    const centre = mul4(view.transform.inverse.matrix, [10 * scale, 20 * scale, -343 * scale, 1]);
    const anchor = { x: centre[0] / -centre[2], y: centre[1] / -centre[2] };
    const ratio = (drawn.x - anchor.x) / (0.3 * 343 * scale / -centre[2]);
    assert.ok(ratio > 1.3 && ratio < 1.5, `push ratio ${ratio}`);
    close((drawn.y - anchor.y) / ((-0.4 * 343 + 0.1 * 11.82) * scale / -centre[2]), ratio);
    close(drawn.hw / (1.8 * 11.82 * scale / -centre[2]), ratio);
  }
});

test('a text-only XR quad still carries its own Z offset and glyph depth', () => {
  const object = renderObject();
  object.values.uOffsetZ.ref.value = 1.5;
  object.values.aDepth.ref.value = [2, 2, 2, 2];
  object.values.aTexCoord.ref.value = Array(8).fill(0);
  for (const view of views) {
    const quad = renderedLabelQuads(object, view, 0.5)[0];
    const drawn = textVertTangentRect(object, view, 0.5);
    const rect = projectPlateQuad(quad.corners, view).rect;
    for (const key of ['x', 'y', 'hw', 'hh']) close(rect[key], drawn[key]);
    // (1.5 + 1.9) * 0.5 metres toward the eye out of a 2 metre depth.
    close(quad.corners[0][2], -2 + 1.7 * 2 / Math.hypot(0.2 - view.transform.matrix[12], 0, 2));
  }
});

test('drawn silhouettes use the committed presentation matrix once, including radius scale', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function measureDrawnComponentLabels(');
  const code = source.slice(start, source.indexOf('\n  }', start) + 4);
  const object = renderObject();
  // Rotate, scale and translate a sphere whose local centre is off the plate.
  const matrix = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 0.8, -20, 4, 1];
  Object.assign(object.values, createIdentityTransform());
  const sphere = { center: [10, 0, -4], radius: 0.25 };
  // Four committed vertices at local (10, 0.1, -4): world (0.3, 0, -2), under the plate.
  object.values.aPosition.ref.value = new Float32Array([10, 0.1, -4, 10, 0.1, -4, 10, 0.1, -4, 10, 0.1, -4]);
  object.values.invariantBoundingSphere = ValueCell.create(sphere);
  object.values.boundingSphere = ValueCell.create(sphere);
  Visual.setTransform(object, matrix);
  assert.deepEqual(object.values.boundingSphere.ref.value.center, sphere.center);
  assert.equal(object.values.boundingSphere.ref.value.radius, sphere.radius);
  const records = [];
  const context = vm.createContext({ ...measurement, performance: { now: () => 0 },
    measureComponentLabels: options => {
      const sphere = options.subject.spheres[0];
      sphere.center.forEach((value, i) => close(value, [0.4, 0, -2][i]));
      close(sphere.radius, 0.25);
      assert.equal(options.subject.points.length, 4);
      options.subject.points[0].forEach((value, i) => close(value, [0.3, 0, -2][i]));
      return measurement.measureComponentLabels(options);
    },
    talkCaption: null, componentLabelMeasurement: { plates: [{ id: 'live', ref: 'plate', lines: 1 }], detail: {} },
    componentLabels: { refs: () => ['plate'] }, labelMeasurementGate: { due: () => true, measured() {} },
    canvas: { xr: { isPresenting: { value: true } }, camera: { scale: 0.5 } },
    representation: { obj: { data: { repr: { renderObjects: [object] } } } }, ligandOverlay: null,
    plugin: { state: { data: { cells: new Map([['plate-backing', { obj: { data: { repr: { renderObjects: [renderObject()] } } } }]]) } } },
    recordCost: (kind, detail) => records.push({ kind, ...detail }),
  });
  vm.runInContext(code, context);
  context.measureDrawnComponentLabels({ views });
  assert.deepEqual(records.filter(r => r.kind === 'component-labels-drawn').map(r => r.subject), [1, 1]);
});

// Entry A of the device acceptance, left eye: the record's own fov
// and ten rects, the drawn structure read off the crop (0.7 by 0.4 tangent),
// and the whole-cartoon sphere the old test used (a 0.9 tangent box).
function entryA() {
  const [l, r, t, b] = [-0.9325151580179747, 1.0000000719918023, 1.1106126135506718, -1.1917536043911405];
  const near = 0.01, far = 50, projectionMatrix = [
    2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(far + near) / (far - near), -1,
    0, 0, -2 * far * near / (far - near), 0];
  const view = { eye: 'left', transform: { matrix: identity(), inverse: { matrix: identity() } }, projectionMatrix };
  const depth = 3, at = (x, y, hw, hh) => [x * depth, y * depth, depth, hw * depth, hh * depth];
  const rects = [['dyskerin-c', 0.283, -0.322, 0.058, 0.020], ['dyskerin-g', 0.412, -0.372, 0.053, 0.018],
    ['nop10-f', 0.287, -0.449, 0.056, 0.022], ['nop10-j', 0.445, -0.323, 0.049, 0.019],
    ['nhp2-e', 0.483, -0.431, 0.046, 0.020], ['nhp2-i', 0.302, 0.540, 0.047, 0.020],
    ['gar1-d', 0.233, -0.388, 0.052, 0.023], ['gar1-h', 0.444, 0.541, 0.045, 0.020],
    ['tcab1-k', 0.198, 0.542, 0.044, 0.021], ['htr-b', 0.257, 0.115, 0.114, 0.018]];
  const plates = rects.map(([id, ...rest]) => plate(id, ...at(...rest)));
  const box = { x: [-0.39, 0.31], y: [-0.09, 0.32] }, points = [];
  for (let i = 0; i <= 40; i++) for (let j = 0; j <= 24; j++) {
    points.push([(box.x[0] + (box.x[1] - box.x[0]) * i / 40) * depth, (box.y[0] + (box.y[1] - box.y[0]) * j / 24) * depth, -depth]);
  }
  const center = [(box.x[0] + box.x[1]) / 2 * depth, (box.y[0] + box.y[1]) / 2 * depth, -depth];
  const radius = Math.hypot((box.x[1] - box.x[0]) / 2 * depth, (box.y[1] - box.y[0]) / 2 * depth, 0.3);
  return { view, plates, points, spheres: [{ center, radius }], box };
}

test('entry A: only a plate with drawn vertices under it is over the subject, not one inside the sphere', () => {
  const { view, plates, points, spheres, box } = entryA();
  const bySphere = measureComponentLabels({ plates, views: [view], subject: { spheres } })[0];
  assert.equal(bySphere.visible, 10); assert.equal(bySphere.overlaps, 0); assert.equal(bySphere.offGlass, 0);
  assert.ok(bySphere.subject >= 3, `sphere silhouette counted ${bySphere.subject}`);
  const drawn = measureComponentLabels({ plates, views: [view], subject: { spheres, points } })[0];
  assert.equal(drawn.subject, 1);
  assert.deepEqual(drawn.rects.map(r => r.id), bySphere.rects.map(r => r.id));
  close(drawn.silhouette[0], (box.x[0] + box.x[1]) / 2); close(drawn.silhouette[1], (box.y[0] + box.y[1]) / 2);
  close(drawn.silhouette[2], (box.x[1] - box.x[0]) / 2); close(drawn.silhouette[3], (box.y[1] - box.y[0]) / 2);
  assert.ok(bySphere.silhouette[2] > 0.45 && bySphere.silhouette[3] > 0.4, 'the sphere box is the inflated one');
  // Vertices behind the eye or outside the frustum cannot make a plate a subject overlap.
  const away = points.map(([x, y, z]) => [x, y, z + 8]);
  assert.equal(measureComponentLabels({ plates, views: [view], subject: { spheres, points: away } })[0].subject, 0);
});

test('mesh points and a point-less impostor sphere both count under their plates', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function measureDrawnComponentLabels(');
  const code = source.slice(start, source.indexOf('\n  }', start) + 4);
  const mesh = renderObject(), impostor = renderObject();
  mesh.values.aTransform.ref.value = identity();
  mesh.values.aPosition.ref.value = new Float32Array([-0.6, 0, -2, -0.5, 0, -2]);
  // The mesh's broad sphere also covers the empty plate: it must not be a fallback.
  mesh.values.invariantBoundingSphere = ValueCell.create({ center: [0, 0, -2], radius: 1 });
  delete impostor.values.aPosition;
  impostor.values.matrix = ValueCell.create(identity());
  impostor.values.boundingSphere = ValueCell.create({ center: [0.6, 0, -2], radius: 0.1 });
  const plates = [plate('A', -0.55, 0, 2, 0.15, 0.1),
    plate('B', 0.6, 0, 2, 0.15, 0.1), plate('neither', 0, 0, 2, 0.1, 0.1)];
  const records = [];
  const context = vm.createContext({ ...measurement, performance: { now: () => 0 },
    measureComponentLabels: options => {
      for (const [i, plate] of plates.entries()) {
        const measured = measurement.measureComponentLabels({ ...options, plates: [plate] });
        assert.deepEqual(measured.map(r => r.subject), i < 2 ? [1, 1] : [0, 0], plate.id);
      }
      const measured = measurement.measureComponentLabels({ ...options, plates });
      const pointOnly = measurement.measureComponentLabels({ ...options, plates,
        subject: { points: renderedSubjectPoints(mesh, 1) } });
      assert.deepEqual(measured.map(r => r.silhouette), pointOnly.map(r => r.silhouette));
      return measured;
    },
    talkCaption: null, componentLabelMeasurement: { plates: [], detail: {} }, componentLabels: { refs: () => [] },
    labelMeasurementGate: { due: () => true, measured() {} },
    canvas: { xr: { isPresenting: { value: true } }, camera: { scale: 1 } },
    representation: { obj: { data: { repr: { renderObjects: [mesh] } } } },
    ligandOverlay: { representation: { obj: { data: { repr: { renderObjects: [impostor] } } } } },
    recordCost: (kind, detail) => records.push({ kind, ...detail }),
  });
  vm.runInContext(code, context);
  context.measureDrawnComponentLabels({ views });
  assert.deepEqual(records.filter(r => r.kind === 'component-labels-drawn').map(r => r.subject), [2, 2]);
});

test('committed instance transforms place the subject spheres and the strided vertex sample', () => {
  const object = renderObject();
  Object.assign(object.values, createIdentityTransform());
  const vertices = 1000;
  object.values.aPosition.ref.value = Float32Array.from({ length: vertices * 3 }, (_, i) => i % 3 === 0 ? (i / 3) / vertices : 0);
  object.values.invariantBoundingSphere = ValueCell.create({ center: [0.5, 0, 0], radius: 0.5 });
  object.values.boundingSphere = ValueCell.create({ center: [0.5, 0, 0], radius: 0.5 });
  const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, -4, 1];
  Visual.setTransform(object, scaled);
  // A geometry update writes boundingSphere from aTransform, matrix folded in;
  // setTransform writes it from transform alone. Neither frame is consulted.
  object.values.boundingSphere = ValueCell.create({ center: [2, 0, -4], radius: 1 });
  const [sphere] = renderedSubjectSpheres(object, 0.5);
  sphere.center.forEach((value, i) => close(value, [1, 0, -2][i])); close(sphere.radius, 0.5);
  const points = renderedSubjectPoints(object, 0.5, 100);
  assert.ok(points.length <= 100 && points.length >= 90, `${points.length} points`);
  points[0].forEach((value, i) => close(value, [0.5, 0, -2][i]));
  const last = points[points.length - 1];
  assert.ok(last[0] > 1.4 && last[0] <= 1.5, `sample reaches the far end: ${last[0]}`);
  assert.deepEqual(renderedSubjectPoints({ ...object, state: { visible: false } }, 0.5), []);
  assert.deepEqual(renderedSubjectSpheres({ ...object, state: { visible: false } }, 0.5), []);
});
