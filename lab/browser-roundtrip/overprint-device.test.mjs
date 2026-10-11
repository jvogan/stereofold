import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as layout from './label-layout.mjs';
import { menuLayoutHarness } from './fixtures/label-action-harness.mjs';
import { MOLSTAR_TEXT_EM_PER_SIZE } from './label-facing.mjs';
import { componentLabelPaint, COMPONENT_LABEL_BACKING_ALPHA_FLOOR } from './component-labels.mjs';
import { entryMenuSeat } from './entry-menu-seat.mjs';
import { HALF_IPD_METERS, SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel,
  toolbarDrawnMenuPoints, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { lensRect, lensRectFromPoints, lensRectsOverlap, PLATE_CLEARANCE_LENS,
  SUBJECT_WHOLE_LENS_CEILING } from './plate-standoff.mjs';
import { replayOptionsFromLayoutRecord } from './fixtures/layout-replay.mjs';
import { sanitizeDetail, MAX_DETAIL_KEYS } from './headset-diagnostics.mjs';
import { measureSolve, SOLVE_SAMPLES } from './fixtures/solve-timing.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const cases = JSON.parse(read('./fixtures/acceptance-5-overprint.json'));
const solverSource = process.env.OVERPRINT_BASELINE
  ? readFileSync(process.env.OVERPRINT_BASELINE, 'utf8') : read('./label-layout.mjs');
const baselineSource = name => process.env.OVERPRINT_BASELINE
  ? readFileSync(join(dirname(process.env.OVERPRINT_BASELINE), name), 'utf8') : read(`./${name}`);
const viewer = baselineSource('viewer.mjs'), toolbar = baselineSource('spatial-toolbar.mjs');
const entryContext = vm.createContext({ createToolbarPanel, toolbarDrawnMenuPoints,
  toolbarSeatBasis, HALF_IPD_METERS, lensRect, lensRectFromPoints, lensRectsOverlap,
  PLATE_CLEARANCE_LENS, SUBJECT_WHOLE_LENS_CEILING });
vm.runInContext(baselineSource('entry-menu-seat.mjs').replace(/^import .*;$/gm, '')
  .replace(/\bexport /g, ''), entryContext);
const seatAt = process.env.OVERPRINT_BASELINE ? entryContext.entryMenuSeat : entryMenuSeat;
const solverContext = vm.createContext({ MOLSTAR_TEXT_EM_PER_SIZE });
vm.runInContext(solverSource.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), solverContext);
const pageFunction = (source, name) => {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
const rect = r => ({ x: r.x, y: r.y, halfWidth: r.hw, halfHeight: r.hh });
const subjectOf = c => {
  const [x, y, halfWidth, halfHeight] = c.layout.silhouette;
  return { x, y, halfWidth, halfHeight };
};
const pointsOf = r => [-1, 1].flatMap(x => [-1, 1].map(y =>
  [r.x + x * r.halfWidth, r.y + y * r.halfHeight, -1]));

// The acceptance-5 rings retain each layout's output rectangles, its subject
// silhouette, the per-eye drawn records and the toolbar row positions. They
// do not retain the solver's inputs, so these are SYNTHETIC replays constrained
// by recorded outputs, not evidence of real-input replay fidelity:
// REAL from the rings: plate dimensions (hw/hh, inverted to one-line text
//   widths), the subject silhouette rectangle and both eyes' silhouettes, the
//   focused ids, and the menu column envelope reconstructed from recorded row
//   positions and shipped plate dimensions.
// SYNTHETIC: every anchor (all ten on the view axis at the depth that draws
//   the recorded height, or inside the silhouette in the Menu tests), every
//   part radius, hence every tether reach and stand-off exclusion disk; the
//   head basis (on-axis); characterUnits .05, stand-off .2, contextAlpha .35;
//   the subject extrema beyond the recorded rectangles. The demo's component
//   centroids cannot be projected without the head pose and the structure's
//   room transform, neither of which the rings hold.
// The page now records its solver inputs on every layout record (viewer.mjs
// componentLabelLayout, fixtures/layout-replay.mjs), which the round-trip
// tests below exercise on synthetic inputs. Fidelity needs a replay of inputs
// captured on a headset.

function assertRecordedLayoutReplay(record) {
  assert.ok(Array.isArray(record.anchors), 'capture must retain anchors');
  assert.ok(Array.isArray(record.obstacles), 'capture must retain obstacles');
  assert.ok(record.inputs, 'capture must retain scalar inputs');
  assert.ok(Array.isArray(record.rects), 'capture must retain output rectangles');
  assert.equal(record.failed, undefined, 'a failed layout cannot establish replay fidelity');
  const replay = layout.layoutComponentPlates(replayOptionsFromLayoutRecord(record));
  assert.equal(replay.placements.length, record.plates);
  assert.equal(record.anchors.length, record.plates);
  assert.equal(record.rects.length, record.plates);
  for (const p of replay.placements) {
    const expected = record.rects.find(r => r.id === p.id);
    assert.ok(expected, `recorded rectangle for ${p.id}`);
    for (const [actual, saved] of [['x', 'x'], ['y', 'y'], ['halfWidth', 'hw'], ['halfHeight', 'hh']]) {
      if (expected[saved] === null) assert.equal(p.rect, null);
      else assert.ok(Number.isFinite(p.rect?.[actual]) && Math.abs(p.rect[actual] - expected[saved]) <= 6e-4,
        `${p.id}.${saved}: replay ${p.rect?.[actual]}, recorded ${expected[saved]}`);
    }
  }
  for (const key of ['overlaps', 'focusOverlaps', 'offGlass', 'unresolved']) assert.equal(replay[key], record[key], key);
  if (record.menu !== null) assert.equal(replay.menuOverlaps, record.menu, 'menu overlaps');
  if (record.subject !== null) assert.equal(replay.subjectOverlaps, record.subject, 'subject overlaps');
  assert.equal(Boolean(replay.search), Boolean(record.search), 'search summary presence');
  if (record.search) {
    assert.equal(replay.search.complete, record.search.complete, 'search completeness');
    assert.ok(Math.abs(replay.search.resolution - record.search.resolution) <= 1e-6, 'search resolution');
    assert.ok(Number.isInteger(record.search.nodes) && Number.isInteger(record.search.slots), 'search work counts retained');
  }
}

if (process.env.OVERPRINT_DEVICE_RING) test('acceptance 6 device ring replay', () => {
  // Input is the saved, unabridged { entries: [...] } device export. Never
  // substitute acceptance-5's synthesized anchors when a field is missing.
  const capture = JSON.parse(readFileSync(process.env.OVERPRINT_DEVICE_RING, 'utf8'));
  assert.ok(Array.isArray(capture.entries), 'save a device export with entries');
  const entries = capture.entries.filter(entry => entry.kind === 'component-label-layout');
  assert.ok(entries.length > 0, 'capture must contain at least one layout');
  for (const entry of entries) {
    assertRecordedLayoutReplay(entry.detail);
  }
});

function optionsFor(c) {
  const characterUnits = .05, standoff = .2;
  const lineEm = layout.plateLineEm();
  const plates = c.layout.rects.map(r => ({ id: r.id, text: r.id,
    focused: c.focused.includes(r.id), radius: .02,
    anchor: [0, 0, -(characterUnits * lineEm / (2 * r.hh) + standoff)] }));
  const widths = new Map(c.layout.rects.map(r => [r.id,
    r.hw / r.hh * lineEm - 2 * layout.plateMarginEm()]));
  return { plates, characterUnits, standoff, minSizeScale: 1, contextAlpha: .35,
    eye: [0, 0, 0], target: [0, 0, -1], field: layout.PLATE_FIELD,
    subject: { ...subjectOf(c), points: c.eyes.flatMap(e => {
      const [x, y, halfWidth, halfHeight] = e.silhouette;
      return pointsOf({ x, y, halfWidth, halfHeight });
    }) }, obstacles: [c.obstacle], measureText: text => widths.get(text) };
}

for (const c of cases) {
  test(`synthetic acceptance 5 #${c.seq} ${c.name}: recorded ${c.layout.overlaps} pairs and ${c.layout.subject} subject covers become zero`, t => {
    const recorded = c.layout.rects.map(r => ({ id: r.id, rect: rect(r) }));
    assert.equal(layout.countPlateOverlaps(recorded), c.layout.overlaps);
    assert.equal(layout.countSubjectOverlaps(recorded, subjectOf(c)), c.layout.subject);
    const options = optionsFor(c);
    // Exercise the real solver from input to emission; no replacement of its
    // placements with the failed output rectangles at the validation boundary.
    const { result, ms, samples } = measureSolve(() => optionsFor(c), input => solverContext.layoutComponentPlates(input));
    t.diagnostic(`#${c.seq}: solve samples (ms): ${samples.map(ms => ms.toFixed(2)).join(', ')}`);
    assert.ok(ms < 20, `#${c.seq}: ten plates minimum of ${SOLVE_SAMPLES} solves ${ms.toFixed(2)} ms, must be under the 20 ms bound`);
    assert.equal(result.placements.length, 10);
    assert.equal(result.overlaps, 0, `#${c.seq}: all drawn plates, including context`);
    assert.equal(result.subjectOverlaps, 0, `#${c.seq}: the whole silhouette stays clear`);
    assert.equal(result.menuOverlaps, 0);
    assert.equal(result.offGlass, 0);
    for (const p of result.placements) {
      const before = recorded.find(r => r.id === p.id).rect;
      assert.ok(Math.abs(p.rect.halfWidth - before.halfWidth) < 1e-9);
      assert.ok(Math.abs(p.rect.halfHeight - before.halfHeight) < 1e-9);
      assert.equal(p.sizeScale, 1, 'repacking keeps the recorded glyph size');
      assert.ok(p.drawDepth < p.depth, 'the stand-off is retained');
      const plate = options.plates.find(entry => entry.id === p.id);
      const anchorX = plate.anchor[0] / p.depth, anchorY = plate.anchor[1] / p.depth;
      const subject = result.subject;
      const subjectReach = Math.hypot(anchorX - subject.x, anchorY - subject.y)
        + Math.hypot(subject.halfWidth, subject.halfHeight)
        + 2 * Math.hypot(p.rect.halfWidth, p.rect.halfHeight)
        + layout.PLATE_GAP_EM * options.characterUnits / p.drawDepth;
      const maxTravel = Math.max(layout.PLATE_BOUND_RADII * plate.radius / p.depth
        + layout.PLATE_BOUND_HEIGHTS * 2 * p.rect.halfHeight, subjectReach) * layout.PLATE_FOCUS_ESCAPE;
      const travel = Math.hypot(p.offsetX, p.offsetY);
      assert.ok(travel <= maxTravel * p.drawDepth + 1e-9, 'existing maximum tether reach');
      const anchorDistance = Math.hypot(travel, p.depth - p.drawDepth);
      assert.ok(anchorDistance >= options.standoff - 1e-9, 'anchor stand-off is a lower bound');
      assert.ok(anchorDistance <= Math.hypot(maxTravel * p.drawDepth, options.standoff) + 1e-9,
        'anchor distance cannot escape the tether budget');
      if (c.focused.length && !p.focused) assert.equal(componentLabelPaint({
        placeAlpha: p.alpha, contextAlpha: .35 }).backing.alpha, COMPONENT_LABEL_BACKING_ALPHA_FLOOR, 'context uses the readable single-primitive alpha floor');
    }
    // Offsets expand in each eye by the same pushed-depth gain as width.
    // Width is less affected than height by the head record's .001 rounding.
    // These are projections from recorded outputs, not new device captures.
    for (const eye of c.eyes) {
      const projected = eye.rects.map(r => {
        const before = c.layout.rects.find(p => p.id === r.id);
        const after = result.placements.find(p => p.id === r.id).rect;
        const gain = r.hw / before.hw;
        return { id: r.id, rect: { ...rect(r),
          x: r.x + (after.x - before.x) * gain,
          y: r.y + (after.y - before.y) * gain } };
      });
      const [x, y, halfWidth, halfHeight] = eye.silhouette;
      assert.equal(layout.countPlateOverlaps(projected), 0, `eye record #${eye.seq}`);
      assert.equal(layout.countSubjectOverlaps(projected, { x, y, halfWidth, halfHeight }), 0,
        `eye record #${eye.seq} keeps the full fringe clear`);
    }
  });

  test(`synthetic acceptance 5 #${c.seq}: viewer solves ten plates once around stable button rows`, () => {
    const options = optionsFor(c), records = [];
    const h = vm.createContext({ ...layout, layoutComponentPlates: solverContext.layoutComponentPlates,
      talkCaption: null, componentLabelLayoutCache: null,
      menuResolveReason: 'collapse,reseat', componentLabelTextWidth: options.measureText,
      componentLabelViewBasis: () => ({ eye: options.eye, target: options.target, basis: 'head' }),
      immersiveSession: { menuRows: () => [pointsOf(c.obstacle)],
        menuPoints: () => pointsOf(c.reservedObstacle), presentation: () => ({ roomMatrix: () => [] }) },
      applyMatrix4: p => p, recordCost: (kind, detail) => records.push({ kind, detail }),
    });
    vm.runInContext(pageFunction(viewer, 'componentLabelLayout'), h);
    const placed = h.componentLabelLayout(options.plates, options, { transparency: .65 },
      options.subject, 'placement', undefined, options.standoff);
    assert.equal(placed.size, 10);
    assert.equal(records.length, 1, 'one layout for the action');
    const result = records[0].detail;
    assert.equal(result.overlaps, 0);
    assert.equal(result.subject, 0);
    assert.equal(result.menu, 0);
    assert.equal(result.offGlass, 0);
    assert.equal(h.menuResolveReason, null, 'the menu action is consumed once');
    // The record carries the solver's inputs. Rebuilt from the JSON ring copy
    // alone, the real solver reproduces the same pass: same rectangles to the
    // inputs' six-decimal rounding, and the recorded rects to their three.
    const ring = JSON.parse(JSON.stringify(result));
    assert.ok(Array.isArray(ring.anchors), 'the layout record carries its solver inputs');
    assert.equal(ring.anchors.length, 10);
    assert.equal(ring.obstacles.length, 1);
    assert.deepEqual(sanitizeDetail(result), ring, 'the page ring keeps every layout field');
    assert.ok(Object.keys(ring).length <= MAX_DETAIL_KEYS);
    assertRecordedLayoutReplay(ring);
    const replay = solverContext.layoutComponentPlates(replayOptionsFromLayoutRecord(ring));
    assert.equal(replay.placements.length, 10);
    for (const p of replay.placements) {
      const original = placed.get(p.id), recorded = ring.rects.find(r => r.id === p.id);
      for (const key of ['x', 'y', 'halfWidth', 'halfHeight']) {
        assert.ok(Math.abs(p.rect[key] - original.rect[key]) < 1e-5, `#${c.seq} ${p.id} ${key} replays`);
      }
      assert.ok(Math.abs(p.rect.x - recorded.x) < 6e-4 && Math.abs(p.rect.y - recorded.y) < 6e-4);
      assert.equal(p.focused, original.focused);
    }
    assert.equal(replay.overlaps, 0);
    assert.equal(replay.subjectOverlaps, 0);
    assert.equal(replay.menuOverlaps, 0);
  });
}

test('a full field stacks outward without overlap, resizing or mutation', () => {
  const placements = ['a', 'b', 'c'].map(id => ({ id,
    rect: { x: 0, y: 0, halfWidth: .4, halfHeight: .3 } }));
  const before = JSON.stringify(placements), obstacle = { x: 0, y: 0, halfWidth: .6, halfHeight: .5 };
  const packed = layout.packPlateField(placements, [obstacle], layout.PLATE_FIELD);
  assert.ok(packed);
  const drawn = [...packed].map(([id, rect]) => ({ id, rect }));
  assert.equal(layout.countPlateOverlaps(drawn), 0);
  assert.equal(layout.countObstacleOverlaps(drawn, [obstacle]), 0);
  assert.equal(JSON.stringify(placements), before);
  assert.deepEqual([...layout.packPlateField(placements, [obstacle], layout.PLATE_FIELD)], [...packed]);
});

test('the free-space scan finds a narrow interior slot after more than 300 obstacles', () => {
  const obstacles = Array.from({ length: 340 }, (_, i) => ({ x: -.99 + i * .004, y: 0,
    halfWidth: .002, halfHeight: 1 }));
  obstacles.push({ x: .8, y: 0, halfWidth: .2, halfHeight: 1 });
  const p = { x: 0, y: 0, halfWidth: .1, halfHeight: .2 };
  const at = layout.freePlateSlot(p, obstacles, { halfWidth: 1, halfHeight: 1 });
  assert.ok(at);
  assert.equal(layout.countObstacleOverlaps([{ rect: at }], obstacles), 0);
  assert.equal(layout.freePlateSlot(p, obstacles, { halfWidth: 1, halfHeight: 1 }, p, .1), null,
    'a free slot outside the tether budget cannot be claimed');
});

test('preselected, unstarted demos still receive entry menu clearance (#34/#41)', () => {
  const h = vm.createContext({ getState: () => ({ tour: { selectedId: 'telomerase-haca', step: -1, active: false } }) });
  vm.runInContext(pageFunction(toolbar, 'isEntrySeat'), h);
  assert.equal(h.isEntrySeat(), true);
  for (const tour of [{ active: true, step: -1 }, { active: false, step: 0 }]) {
    h.getState = () => ({ tour });
    assert.equal(h.isEntrySeat(), false, 'displayed chapters retain their own framing');
  }
});

test('entry clearance cannot pass solely on the head-centre margin', () => {
  const head = { position: { x: 0, y: 0, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const rows = [{ label: 'Menu', action: {} }];
  const panel = createToolbarPanel({ rows, head, constants: SPATIAL_TOOLBAR_LAYOUT });
  const basis = toolbarSeatBasis(head);
  const menu = lensRectFromPoints({ points: toolbarDrawnMenuPoints(panel), origin: basis.origin, basis });
  const subjectLens = -menu.right - PLATE_CLEARANCE_LENS - .001;
  assert.ok(subjectLens > 0);
  const seat = seatAt({ rows, head, constants: SPATIAL_TOOLBAR_LAYOUT, subjectLens, factors: [1] });
  assert.equal(lensRectsOverlap(menu, seat.subject, PLATE_CLEARANCE_LENS), false);
  assert.equal(seat.clear, false, 'one eye loses the margin despite the centre clearing it');
});

test('complete free bands retain a tight four-plate tiling the bounded search rejects', () => {
  const placements = Array.from({ length: 4 }, (_, id) => ({ id: String(id),
    rect: { x: 0, y: 0, halfWidth: .5, halfHeight: .5 } }));
  const field = { halfWidth: 1, halfHeight: 1 };
  const packed = solverContext.packPlateField(placements, [], field);
  assert.ok(packed, 'free space exists even when the preferred inter-plate gap does not fit');
  const drawn = [...packed].map(([id, rect]) => ({ id, rect }));
  assert.equal(layout.countPlateOverlaps(drawn), 0);
  for (const { rect } of drawn) {
    assert.equal(rect.halfWidth, .5);
    assert.equal(rect.halfHeight, .5);
    assert.ok(Math.abs(rect.x) + rect.halfWidth <= 1);
    assert.ok(Math.abs(rect.y) + rect.halfHeight <= 1);
  }
});

test('off-axis billboard moves preserve physical anchor stand-off and maximum tether reach', () => {
  const options = { plates: [
    { id: 'a', text: 'A', anchor: [.5, 0, -2], radius: .01 },
    { id: 'b', text: 'B', anchor: [-.5, 0, -2], radius: .01 },
  ], eye: [0, 0, 0], target: [0, 0, -1], characterUnits: .02, standoff: .2,
  minSizeScale: 1, field: layout.PLATE_FIELD,
  obstacles: [{ x: .25, y: 0, halfWidth: .02, halfHeight: .1 }] };
  const solved = solverContext.layoutComponentPlates(options);
  assert.equal(solved.overlaps, 0);
  assert.equal(solved.menuOverlaps, 0);
  assert.equal(solved.offGlass, 0);
  for (const p of solved.placements) {
    const anchor = options.plates.find(plate => plate.id === p.id).anchor;
    const distance = Math.hypot(...anchor), push = options.standoff / distance;
    const separation = Math.hypot(p.offsetX - anchor[0] * push,
      p.offsetY - anchor[1] * push, anchor[2] * push);
    assert.ok(separation >= options.standoff - 1e-9, `${p.id}: physical separation ${separation}`);
    const bound = (layout.PLATE_BOUND_RADII * .01 / p.depth
      + layout.PLATE_BOUND_HEIGHTS * p.rect.halfHeight * 2) * layout.PLATE_FOCUS_ESCAPE;
    assert.ok(Math.hypot(p.offsetX, p.offsetY) <= bound * p.drawDepth + 1e-9);
    assert.equal(p.sizeScale, 1);
  }
});

for (const c of cases.slice(0, 4)) test(`synthetic acceptance 5 #${c.seq}: real menu action emits one clear layout/update`, async () => {
  const options = optionsFor(c);
  options.subject.points.push(...pointsOf(subjectOf(c)));
  // These are synthetic input anchors, placed inside the recorded silhouette.
  // Preserve the drawn depth when moving off-axis with a nonzero stand-off.
  for (const p of options.plates) {
    const depth = -p.anchor[2] - options.standoff + options.standoff
      / Math.hypot(options.subject.x, options.subject.y, 1);
    p.anchor = [options.subject.x * depth, options.subject.y * depth, -depth];
    p.radius = .001;
  }
  const h = await menuLayoutHarness(options);
  const records = await h.press();
  const layouts = records.filter(r => r.kind === 'component-label-layout');
  assert.equal(layouts.length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(layouts[0].overlaps, 0);
  assert.equal(layouts[0].subject, 0);
  assert.equal(layouts[0].offGlass, 0);
  assert.equal(layouts[0].unresolved, 0);
});

test('crowded tiling: real Menu press finds the arrangement that greedy abandons', async t => {
  const fixture = JSON.parse(read('./fixtures/overprint-backtracking.json'));
  const characterUnits = .05, standoff = .2, lineEm = layout.plateLineEm();
  const widths = new Map(fixture.rects.map(r => [r.id,
    r.halfWidth / r.halfHeight * lineEm - 2 * layout.plateMarginEm()]));
  const h = await menuLayoutHarness({
    plates: fixture.rects.map(r => ({ id: r.id, text: r.id, radius: .1,
      anchor: [0, 0, -(characterUnits * lineEm / (2 * r.halfHeight) + standoff)] })),
    characterUnits, standoff, field: fixture.field,
    eye: [0, 0, 0], target: [0, 0, -1], measureText: text => widths.get(text),
  });
  const records = await h.press();
  const result = records.find(r => r.kind === 'component-label-layout');
  assert.equal(records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(result.overlaps, 0);
  assert.equal(result.offGlass, 0);
  assert.equal(result.unresolved, 0);
  assert.equal(result.shrunk, 0);
  for (const r of result.rects) {
    const expected = fixture.rects.find(p => p.id === r.id);
    assert.ok(Math.abs(r.hw - expected.halfWidth) < .00051);
    assert.ok(Math.abs(r.hh - expected.halfHeight) < .00051);
  }
  // The stored witness is the ground truth: a zero-overlap arrangement inside
  // the field covering exactly its free area (a perfect tiling), every plate
  // of which sits in the solver's candidate space. The found arrangement is
  // verified against it: the same perfect tiling of the same field, found by
  // a search that completed.
  const witness = fixture.witness.map(w => ({ id: w.id, rect: { x: w.x, y: w.y, halfWidth: w.halfWidth, halfHeight: w.halfHeight } }));
  assert.equal(witness.length, fixture.rects.length);
  assert.equal(layout.countPlateOverlaps(witness), 0, 'the witness has no overlap');
  const fieldArea = 4 * fixture.field.halfWidth * fixture.field.halfHeight;
  const covered = rects => rects.reduce((sum, r) => sum + 4 * r.rect.halfWidth * r.rect.halfHeight, 0);
  const inside = rects => rects.every(r => Math.abs(r.rect.x) + r.rect.halfWidth <= fixture.field.halfWidth + 1e-9
    && Math.abs(r.rect.y) + r.rect.halfHeight <= fixture.field.halfHeight + 1e-9);
  assert.ok(inside(witness));
  assert.ok(Math.abs(covered(witness) - fieldArea) < 1e-9, 'the witness tiles the whole field');
  const placements = fixture.rects.map(r => ({ id: r.id, rect: { x: 0, y: 0, halfWidth: r.halfWidth, halfHeight: r.halfHeight },
    anchorRect: { x: 0, y: 0 }, maxTravel: Infinity, exclusion: null }));
  const resolution = Math.min(...placements.map(p => p.rect.halfHeight));
  for (const w of witness) {
    const slots = layout.plateFieldSlots(placements.find(p => p.id === w.id), [], fixture.field, resolution);
    assert.ok(slots.some(slot => Math.abs(slot.x - w.rect.x) < 1e-9 && Math.abs(slot.y - w.rect.y) < 1e-9),
      `witness plate ${w.id} is a candidate slot`);
  }
  assert.equal(result.search.complete, true, 'the exact search completed');
  assert.ok(Math.abs(result.search.resolution - resolution) < 1e-6);
  assert.ok(result.search.nodes < layout.PLATE_SEARCH_CEILING / 20, `${result.search.nodes} nodes`);
  // The action's arrangement: no overlap and nothing off the glass by the
  // solver's own unrounded count above, every dimension retained, so its
  // covered area is the witness's: a perfect tiling of the same field.
  assert.ok(Math.abs(fixture.rects.reduce((sum, r) => sum + 4 * r.halfWidth * r.halfHeight, 0) - covered(witness)) < 1e-9);
  const { result: exact, ms, samples } = measureSolve(() => structuredClone(placements),
    input => layout.exactPlateSearch(input, [], fixture.field, { resolution }));
  t.diagnostic(`exact search: ${exact.nodes} nodes; solve samples (ms): ${samples.map(ms => ms.toFixed(2)).join(', ')}`);
  assert.ok(exact.placed && exact.complete);
  assert.equal(exact.tight, true, 'the witness field is tight: the corner rule applies');
  const found = [...exact.placed].map(([id, rect]) => ({ id, rect }));
  assert.equal(layout.countPlateOverlaps(found), 0);
  assert.ok(inside(found));
  assert.ok(Math.abs(covered(found) - covered(witness)) < 1e-9, 'the direct search finds a perfect tiling like the witness');
  assert.ok(ms < 20, `exact search minimum of ${SOLVE_SAMPLES} solves ${ms.toFixed(2)} ms, must be under 20 ms; samples: ${samples.map(ms => ms.toFixed(2)).join(', ')}`);
});

// A deterministic guillotine tiling of the field on a grid, with the plates
// and obstacles drawn from its cells: the only zero-overlap arrangements are
// perfect tilings of the free area, and the planted one lies in the candidate
// space, so a complete enumeration must find one.
function plantedTiling(seed, { units = 12, cells = 14, obstacleCount = 4, halfWidth = .5 } = {}) {
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const step = 2 * halfWidth / units;
  let boxes = [{ x: 0, y: 0, w: units, h: units }];
  while (boxes.length < cells) {
    boxes.sort((a, b) => b.w * b.h - a.w * a.h);
    const box = boxes.shift();
    const vertical = box.w > box.h || (box.w === box.h && random() < .5);
    const span = vertical ? box.w : box.h;
    if (span < 2) { boxes.push(box); if (boxes.every(b => b.w < 2 && b.h < 2)) break; continue; }
    const cut = 1 + Math.floor(random() * (span - 1));
    boxes.push(vertical ? { ...box, w: cut } : { ...box, h: cut });
    boxes.push(vertical ? { ...box, x: box.x + cut, w: box.w - cut } : { ...box, y: box.y + cut, h: box.h - cut });
  }
  for (let i = boxes.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [boxes[i], boxes[j]] = [boxes[j], boxes[i]]; }
  const rect = b => ({ x: -halfWidth + (b.x + b.w / 2) * step, y: -halfWidth + (b.y + b.h / 2) * step,
    halfWidth: b.w * step / 2, halfHeight: b.h * step / 2 });
  const obstacles = boxes.slice(0, obstacleCount).map(rect);
  const witness = boxes.slice(obstacleCount).map((b, i) => ({ id: String(i), rect: rect(b) }));
  return { field: { halfWidth, halfHeight: halfWidth }, step, obstacles, witness };
}

test('exact search: a planted zero-overlap tiling in a crowded field is found for every seed', t => {
  for (const seed of [3, 17, 42, 99, 256, 1024]) {
    const { field, step, obstacles, witness } = plantedTiling(seed);
    assert.ok(witness.length >= 8, 'a crowded field');
    const placements = witness.map(w => ({ id: w.id, rect: { ...w.rect, x: 0, y: 0 },
      anchorRect: { x: 0, y: 0 }, maxTravel: Infinity, exclusion: null }));
    const free = layout.clippedFreeArea(field, obstacles);
    const need = placements.reduce((sum, p) => sum + 4 * p.rect.halfWidth * p.rect.halfHeight, 0);
    assert.ok(Math.abs(free - need) < 1e-9, 'the plates exactly fill the free area');
    for (const w of witness) {
      const slots = layout.plateFieldSlots(placements.find(p => p.id === w.id), obstacles, field, step);
      assert.ok(slots.some(slot => Math.abs(slot.x - w.rect.x) < 1e-9 && Math.abs(slot.y - w.rect.y) < 1e-9),
        `seed ${seed}: planted plate ${w.id} is in the candidate space`);
    }
    const { result: exact, ms, samples } = measureSolve(() => structuredClone(placements),
      input => layout.exactPlateSearch(input, obstacles, field, { resolution: step }));
    t.diagnostic(`seed ${seed}: ${exact.nodes} nodes; solve samples (ms): ${samples.map(ms => ms.toFixed(2)).join(', ')}`);
    assert.ok(exact.placed, `seed ${seed}: the planted arrangement is found`);
    assert.equal(exact.complete, true);
    const found = [...exact.placed].map(([id, r]) => ({ id, rect: r }));
    assert.equal(layout.countPlateOverlaps(found), 0);
    assert.equal(layout.countObstacleOverlaps(found, obstacles), 0);
    assert.ok(found.every(r => Math.abs(r.rect.x) + r.rect.halfWidth <= field.halfWidth + 1e-9
      && Math.abs(r.rect.y) + r.rect.halfHeight <= field.halfHeight + 1e-9));
    assert.ok(ms < 20, `seed ${seed}: ${exact.nodes} nodes, minimum of ${SOLVE_SAMPLES} solves ${ms.toFixed(2)} ms, must be under 20 ms`);
    // The production entry point, at its own resolution (the smallest plate
    // half-height, which divides this grid), finds a perfect tiling too.
    const packed = layout.packPlateField(placements, obstacles, field);
    assert.ok(packed && !packed.degraded);
    const drawn = [...packed].map(([id, r]) => ({ id, rect: r }));
    assert.equal(layout.countPlateOverlaps(drawn), 0);
    assert.equal(layout.countObstacleOverlaps(drawn, obstacles), 0);
  }
});

test('exact search: a node ceiling is reported as incomplete rather than hidden', () => {
  const fixture = JSON.parse(read('./fixtures/overprint-backtracking.json'));
  const placements = fixture.rects.map(r => ({ id: r.id, rect: { x: 0, y: 0, halfWidth: r.halfWidth, halfHeight: r.halfHeight },
    anchorRect: { x: 0, y: 0 }, maxTravel: Infinity, exclusion: null }));
  const cut = layout.exactPlateSearch(placements, [], fixture.field, { ceiling: 3 });
  assert.equal(cut.placed, null);
  assert.equal(cut.complete, false);
  assert.equal(cut.nodes, 3);
  const packed = layout.packPlateField(placements, [], fixture.field, { ceiling: 3 });
  assert.ok(packed, 'the outward bands still place every plate');
  assert.equal(packed.degraded, true);
  assert.equal(packed.search.complete, false, 'the record says the answer was not proven');
  const full = layout.packPlateField(placements, [], fixture.field);
  assert.equal(full.degraded, undefined);
  assert.equal(full.search.complete, true);
});

test('infeasible Menu field commits the minimum overlap while the subject stays clear', async () => {
  const characterUnits = .05, standoff = .2, hh = .1, hw = .4;
  const depth = characterUnits * layout.plateLineEm() / (2 * hh) + standoff / Math.hypot(1, .1);
  const h = await menuLayoutHarness({
    plates: ['a', 'b'].map(id => ({ id, text: id, radius: 0, anchor: [0, .1 * depth, -depth] })),
    characterUnits, standoff, field: { halfWidth: .5, halfHeight: .2 },
    subject: { points: pointsOf({ x: 0, y: .1, halfWidth: .5, halfHeight: .1 }) },
    eye: [0, 0, 0], target: [0, 0, -1],
    measureText: () => hw / hh * layout.plateLineEm() - 2 * layout.plateMarginEm(),
  });
  const records = await h.press();
  const result = records.find(r => r.kind === 'component-label-layout');
  assert.equal(records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(result.degraded, true);
  assert.equal(result.subject, 0);
  assert.ok(result.offGlass > 0, 'the exhausted readable band is recorded');
  assert.equal(result.overlapArea, 0, 'reachable outward bands achieve the global minimum overlap');
});

test('Menu covering the entire reachable field records the minimum unavoidable overlap', async () => {
  const h = await menuLayoutHarness({
    plates: ['a', 'b'].map(id => ({ id, text: id, radius: 0, anchor: [0, 0, -1] })),
    characterUnits: .05, standoff: .2, field: { halfWidth: .5, halfHeight: .3 },
    obstacles: [{ x: 0, y: 0, halfWidth: 100, halfHeight: 100 }],
    eye: [0, 0, 0], target: [0, 0, -1], measureText: () => 2,
  });
  const records = await h.press();
  const result = records.find(r => r.kind === 'component-label-layout');
  assert.equal(records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(result.degraded, true);
  assert.equal(result.unresolved, 2);
  assert.equal(result.overlaps, 0);
  assert.equal(result.menu, 2);
  assert.equal(result.offGlass, 0);
  // Every reachable point is inside the menu. Its two covered plate areas
  // are unavoidable; putting the plates apart attains that lower bound.
  const halfWidth = .05 * (2 + 2 * layout.plateMarginEm()) / 2 / .8;
  const halfHeight = .05 * layout.plateLineEm() / 2 / .8;
  assert.ok(Math.abs(result.overlapArea - 8 * halfWidth * halfHeight) < 1e-9);
});
