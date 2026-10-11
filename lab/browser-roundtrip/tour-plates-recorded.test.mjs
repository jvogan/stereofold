import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as layout from './label-layout.mjs';
import { replayOptionsFromLayoutRecord } from './fixtures/layout-replay.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const capture = JSON.parse(readFileSync(new URL('./fixtures/acceptance-6-tour.json', import.meta.url)));
const entries = capture.actions.flatMap(a => a.entries);
const record = seq => entries.find(e => e.seq === seq).detail;
const source = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');

// The shader expands offsets and quad dimensions by the same per-eye depth.
// Calibrate that affine projection from the UNMODIFIED recorded head and eye
// rectangles. This replays placement changes at the captured pose; it is not
// a new headset capture or an estimate of the camera's missing matrices.
function eyeProjection(solved, before, eye) {
  // Recover the original unrounded rectangles through the proven historical
  // replay, avoiding an extra contact introduced by three-decimal output.
  const original = layout.layoutComponentPlates(replayOptionsFromLayoutRecord(before));
  return eye.rects.map(r => {
    const old = original.placements.find(p => p.id === r.id).rect;
    const p = solved.placements.find(p => p.id === r.id);
    const gainX = r.hw / old.halfWidth, gainY = r.hh / old.halfHeight;
    return { id: r.id, rect: { x: r.x + (p.rect.x - old.x) * gainX,
      y: r.y + (p.rect.y - old.y) * gainY,
      halfWidth: p.rect.halfWidth * gainX, halfHeight: p.rect.halfHeight * gainY } };
  });
}

test('acceptance 6 scene 3 #177/#183/#184: both recorded eyes separate every plate', () => {
  const before = record(177);
  const solved = layout.layoutComponentPlates({ ...replayOptionsFromLayoutRecord(before), clearance: .004 });
  assert.equal(solved.overlaps, 0);
  assert.equal(solved.subjectOverlaps, 0);
  assert.equal(solved.offGlass, 0, 'all ten plates remain on glass');
  for (const seq of [183, 184]) {
    const eye = record(seq), projected = eyeProjection(solved, before, eye);
    assert.equal(layout.countPlateOverlaps(eye.rects.map(r => ({ rect: { x: r.x, y: r.y, halfWidth: r.hw, halfHeight: r.hh } }))), eye.overlaps);
    assert.equal(layout.countPlateOverlaps(projected), 0, `drawn eye #${seq}`);
    const [x, y, halfWidth, halfHeight] = eye.silhouette;
    assert.equal(layout.countSubjectOverlaps(projected, { x, y, halfWidth, halfHeight }), 0);
  }
});

test('acceptance 6 scene windows: changed inputs solve and exact grow/follow repeats reuse', () => {
  let options, solves = 0, suspended = 0;
  const events = [];
  const h = vm.createContext({ ...layout, componentLabelLayoutCache: null,
    talkCaption: { suspend: () => { suspended++; } },
    menuResolveReason: null, componentLabelTextWidth: text => options.measureText(text),
    componentLabelViewBasis: () => ({ eye: [0, 0, 0], target: [0, 0, -1], basis: 'head' }),
    immersiveSession: { menuRows: () => options.obstacles.map(r => [-1, 1].flatMap(x => [-1, 1].map(y =>
      [r.x + x * r.halfWidth, r.y + y * r.halfHeight, -1]))),
      presentation: () => ({ roomMatrix: () => [] }) },
    applyMatrix4: p => p, recordCost: (kind, detail) => events.push({ kind, detail }),
    layoutComponentPlates: input => { solves++; return layout.layoutComponentPlates(input); },
  });
  vm.runInContext(pageFunction(source, 'componentLabelLayout'), h);
  let windows = 0;
  for (const entry of entries.filter(e => e.kind === 'component-label-layout' && e.seq < 260)) {
    options = replayOptionsFromLayoutRecord(entry.detail);
    const before = solves;
    const next = h.componentLabelLayout(options.plates, options, { transparency: .65 }, options.subject,
      entry.detail.reason, undefined, options.standoff);
    assert.equal(next.failed, undefined, `layout #${entry.seq} succeeds`);
    // These historical windows have small but real tracking/input changes.
    // They are not proof that an approximate cache can safely reuse a solve.
    assert.equal(solves, before + 1, `#${entry.seq} changed recorded inputs solve`);
    assert.equal(suspended, solves, 'changed layouts suspend the old reply seat');
    windows++;
    for (const reason of ['grow', 'follow', 'grow,follow']) {
      const retained = h.componentLabelLayout(options.plates, options, { transparency: .65 }, options.subject,
        reason, undefined, options.standoff);
      assert.equal(solves, before + 1, `#${entry.seq} exact ${reason} repeat reuses inputs`);
      assert.equal(retained.unchanged, true, 'relayout exits before staging a plate update');
      assert.equal(suspended, solves, 'an unchanged layout must not hide the reply');
    }
  }
  assert.equal(windows, 12);
  assert.equal(solves, windows, 'one solve per distinct recorded input, none for exact repeats');
});

test('acceptance 6 #208/#217: close-up framing reserves a band for the focused plates', async () => {
  const { focusPlacement } = await import('./focus-placement.mjs');
  const demo = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url)));
  assert.deepEqual(demo.chapters[3].immersive.emphasis.focus, ['dyskerin-c', 'dyskerin-g']);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const seq of [208, 217]) {
    const before = record(seq), options = replayOptionsFromLayoutRecord(before);
    const original = layout.layoutComponentPlates(options);
    assert.equal(original.offGlass, 9);
    assert.equal(before.anchors.filter(a => a.z === null).length, 1, 'unrecoverable anchor stays unavailable');
    // All focus flags in the capture are false. The corrected authored focus
    // is applied explicitly; no original input or expected rectangle is edited.
    const focus = new Set(['dyskerin-c', 'dyskerin-g']);
    const live = options.plates.filter(p => before.anchors.find(a => a.id === p.id).z !== null);
    const focused = live.filter(p => focus.has(p.id));
    const center = [0, 1, 2].map(i => focused.reduce((v, p) => v + p.anchor[i] / focused.length, 0));
    const radius = Math.max(...live.map(p => Math.hypot(...p.anchor.map((v, i) => v - center[i])) + p.radius));
    const points = live.flatMap(p => [0, 1, 2].flatMap(axis => [-1, 1].map(sign =>
      p.anchor.map((v, i) => v + (axis === i ? sign * p.radius : 0)))));
    // These are the recorded part bounds in their canonical replay basis.
    // Reframing is a NEW production placement of those bounds, not a claim
    // that the impossible old silhouette acquired free space at the same pose.
    const framed = focusPlacement({ headInRoom: identity, renderFromRoom: identity,
      cameraScale: 1 / -center[2], center, radius, targetCenter: center, targetRadius: radius,
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      framing: 'context', elevationDegrees: 0, subjectPoints: points, assemblyPoints: points,
      enclosure: Math.tan(Math.PI / 12) });
    const plates = live.map(p => ({ ...p, focused: focus.has(p.id), radius: p.radius * framed.scale,
      anchor: p.anchor.map((v, i) => (v - center[i]) * framed.scale + center[i] + framed.translation[i] * radius) }));
    // Preserve the unavailable tenth identity exactly as the replay decoded
    // it; there is no evidence from which to reconstruct its behind-eye depth.
    plates.push(...options.plates.filter(p => before.anchors.find(a => a.id === p.id).z === null));
    const movedPoints = points.map(p => p.map((v, i) => (v - center[i]) * framed.scale + center[i] + framed.translation[i] * radius));
    const solved = layout.layoutComponentPlates({ ...options, plates,
      subject: { points: movedPoints }, standoff: options.standoff * framed.scale, clearance: .004 });
    assert.equal(solved.overlaps, 0);
    assert.equal(solved.subjectOverlaps, 0);
    assert.equal(solved.placements.length, 10);
    assert.equal(solved.offGlass, 1, 'only the recorded unavailable anchor is off glass');
    assert.equal(solved.degraded, true, 'the missing anchor is reported honestly');
    const visible = solved.placements.filter(p => p.rect && Math.abs(p.rect.x) + p.rect.halfWidth <= options.field.halfWidth
      && Math.abs(p.rect.y) + p.rect.halfHeight <= options.field.halfHeight);
    assert.ok(visible.length >= 1);
    for (const id of focus) assert.ok(visible.some(p => p.id === id && p.focused && p.leader), `${id} keeps its name and leader`);
  }
});

test('a degraded field keeps the focused plate on glass before spending space on context', () => {
  const field = { halfWidth: .5, halfHeight: .15 };
  const packed = layout.packPlateField([
    { id: 'context', rect: { x: 0, y: 0, halfWidth: .45, halfHeight: .12 } },
    { id: 'focus', focused: true, rect: { x: 0, y: 0, halfWidth: .2, halfHeight: .12 } },
  ], [], field, { prioritizeFocus: true });
  assert.equal(packed.degraded, true);
  const focus = packed.get('focus');
  assert.ok(Math.abs(focus.x) + focus.halfWidth <= field.halfWidth);
  assert.ok(Math.abs(focus.y) + focus.halfHeight <= field.halfHeight);
  assert.equal(layout.countPlateOverlaps([...packed].map(([id, rect]) => ({ id, rect }))), 0);
});

test('a cached grow/follow layout stages no plate update or renderer commit', async () => {
  const { labelHarness } = await import('./fixtures/label-action-harness.mjs');
  const h = labelHarness();
  await h.session.rebuild();
  const committed = h.commits.length;
  h.records.length = 0;
  h.h.componentLabelLayout = () => { const retained = new Map(); retained.unchanged = true; return retained; };
  await h.session.relayout('grow,follow');
  assert.equal(h.commits.length, committed);
  assert.equal(h.records.filter(r => r.kind === 'plate-update').length, 0);
});

test('the layout cache invalidates material inputs and retains its original envelope', () => {
  const options = replayOptionsFromLayoutRecord(record(177));
  const key = layout.plateLayoutKey(options);
  assert.equal(layout.reusablePlateLayout(layout.plateLayoutKey(options), key), true);
  for (const changed of [
    { characterUnits: options.characterUnits + .0005 },
    { minSizeScale: options.minSizeScale + .0005 },
    { contextAlpha: options.contextAlpha + .0005 },
    { standoff: options.standoff + .0005 },
    { measureText: text => options.measureText(text) * 1.0005 },
    { plates: options.plates.map((p, i) => i ? p : { ...p, anchor: p.anchor.map(v => v * 1.0005) }) },
    { characterUnits: options.characterUnits * 1.01 },
    { minSizeScale: .8 }, { contextAlpha: .7 }, { standoff: options.standoff * 1.01 },
    { measureText: text => options.measureText(text) * 1.01 },
    { subject: { ...options.subject, halfWidth: options.subject.halfWidth + .01 } },
    { plates: options.plates.map((p, i) => i ? p : { ...p, focused: !p.focused }) },
    { plates: options.plates.map((p, i) => i ? p : { ...p, anchor: p.anchor.map(v => v * 1.01) }) },
    { obstacles: options.obstacles.map(o => ({ ...o, halfWidth: o.halfWidth + .01 })) },
  ]) assert.equal(layout.reusablePlateLayout(layout.plateLayoutKey({ ...options, ...changed }), key), false);
  const smaller = { ...options, obstacles: options.obstacles.map(o => ({ ...o, halfWidth: o.halfWidth / 2 })) };
  assert.equal(layout.reusablePlateLayout(layout.plateLayoutKey(smaller), key), true);
  const drifted = { ...options, plates: options.plates.map(p => ({ ...p, anchor: p.anchor.map(v => v * 1.002) })) };
  assert.equal(layout.reusablePlateLayout(layout.plateLayoutKey(drifted), key), false, 'jitter cannot accumulate between redraws');
});

test('the page reserves whole-assembly label margin before a lesson focus travels', async () => {
  const { tourFocusHarness } = await import('./fixtures/tour-focus-harness.mjs');
  const h = tourFocusHarness({ labels: true });
  await h.h.rebuildComponentLabels();
  h.h.emphasisOrigin = 'lesson';
  const focus = h.h.focusPlacement;
  let input;
  h.h.focusPlacement = options => { input = options; return focus(options); };
  await h.h.focusSelection({ selectionKeys: ['B'], framing: 'fill', enclosure: .85,
    minTargetFraction: .6, liftEmphasis: false });
  assert.equal(input.targetRadius, input.radius, 'the faded assembly also needs a clear label band');
  assert.equal(input.enclosure, .4, 'a labelled lesson cannot spend the entire lens');
  assert.equal(h.records.filter(r => r.kind === 'xr-focus').length, 1);
});
