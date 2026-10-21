import { createPlacementHold } from './wearer-placement.mjs';
import { createAgentPlacementHistory } from './agent-placement-history.mjs';
import { clampPlacementScale } from './placement-limits.mjs';
import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import { viewerCallback } from './fixtures/viewer-callback.mjs';
import { createSelectionBoundsCache } from './selection-bounds.mjs';
import { connectionFrame } from './connection-liveness.mjs';
import { representationLayerRef } from './scene-transition.mjs';
import { normalizeStyles } from './inspection-styles.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import { pivotPreservingTranslation } from './presentation-pivot.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import { createRoomAnchor, headViewBasis, placementFromRoom } from './room-anchor.mjs';
import { measurePlateSeat } from './plate-seat.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';
import { createRoomSeatMemory } from './room-seat-memory.mjs';
import * as facing from './label-facing.mjs';
import * as layout from './label-layout.mjs';
import { componentPlateName, createComponentLabelSession } from './component-labels.mjs';
import * as componentPaint from './component-labels.mjs';
import * as measurement from './component-label-measurement.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { createLabelMeasurementGate } from './component-label-measurement.mjs';
import { applyMatrix4 } from './room-lock.mjs';
import { createMenuResolve, MENU_SETTLE_MS } from './menu-resolve.mjs';
import { menuSeatReceipt } from './menu-seat-receipt.mjs';
import { emptyVisibility, normalizeVisibility } from './inspection-visibility.mjs';
import { MOLECULAR_REPRESENTATIONS, spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { createToolbarPanel, toolbarMenuPoints } from './spatial-toolbar-geometry.mjs';
import { installSpatialMenuHook } from './spatial-menu-hook.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { watchFrameCost } from './xr-render-budget.mjs';
import { createDiagnosticsBuffer, watchFrameRate } from './headset-diagnostics.mjs';

const source = name => readFileSync(name === './viewer.mjs' && process.env.OVERPRINT_VIEWER_BASELINE
  ? process.env.OVERPRINT_VIEWER_BASELINE : new URL(name, import.meta.url), 'utf8');
const viewer = source('./viewer.mjs'), toolbar = source('./spatial-toolbar.mjs');
// Execute the page's actual closure functions with rendering/selection adapters.
// This catches missing rebuilds and action wiring that pure geometry tests miss.
function pageFunction(text, name) {
  const start = text.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing ${name}`);
  const firstLine = text.slice(start, text.indexOf('\n', start));
  if (firstLine.trimEnd().endsWith('}')) return representationLayerRef.toString() + '\n' + firstLine;
  const end = text.indexOf('\n  }', start) + 4;
  return representationLayerRef.toString() + '\n' + text.slice(start, end);
}
const plain = value => JSON.parse(JSON.stringify(value));
const identity = () => Array.from(Mat4.identity());

test('the eye-view wait expires on XR frame time without a window timer', async () => {
  let clock = 0;
  const session = {};
  const checks = new Set();
  const h = vm.createContext({ clampPlacementScale, ...emptyLessonFigureBinding(), setTimeout, clearTimeout, performance: { now: () => clock }, placementViewWaiters: checks,
    latestRoomPlacementPose: null, immersiveSession: { platePoints: () => [[0, 0, -1]] },
    canvas: { webgl: { xr: { session } }, xr: { isPresenting: { value: true } } } });
  vm.runInContext(pageFunction(viewer, 'awaitPlacementViews'), h);
  const pending = h.awaitPlacementViews();
  assert.equal(checks.size, 1);
  clock = 2001;
  for (const check of checks) check();
  await assert.rejects(pending, /both eye views are measurable/);
  assert.equal(checks.size, 0, 'the deadline retires its frame check');
});

test('an unsafe retained entry hides the molecule, keeps the menu, and preserves wearer ownership', async () => {
  const events = [], repr = { name: 'molecule' };
  const owner = { translation: [0, 0, -1], rotation: [0, 0, 0], scale: 2 };
  let safe = false;
  const h = vm.createContext({ clampPlacementScale, ...emptyLessonFigureBinding(), retainedEntryCheck: undefined, retainedEntryCheckPending: false, state: { status: 'ready' }, retainedPoseHidden: false, immersiveSession: { platePoints: () => [[0, 0, -1]] },
    inspectionSnapshot: () => ({ placement: owner }), scientificRepresentations: () => [repr],
    clearHeldPlatePlacement: placement => { if (!safe) throw Error('overlap'); return placement; },
    canvas: { xr: { isPresenting: { value: true } }, remove: value => events.push(`remove:${value.name}`), add: value => events.push(`add:${value.name}`),
      commit: () => events.push('commit') },
    talkCaption: { set: value => events.push(value.outcome) }, recordManipulation: () => {} });
  vm.runInContext(pageFunction(viewer, 'hideRetainedPose') + pageFunction(viewer, 'showRetainedPose') + pageFunction(viewer, 'checkRetainedEntryPose'), h);
  await h.checkRetainedEntryPose();
  assert.equal(h.retainedPoseHidden, true);
  assert.deepEqual(events.slice(0, 2), ['remove:molecule', 'commit']);
  assert.match(events[2], /Press Reset or Fit/);
  assert.equal(owner.scale, 2, 'the saved wearer placement is unchanged');
  safe = true;
  await h.checkRetainedEntryPose();
  assert.equal(h.retainedPoseHidden, false);
  assert.deepEqual(events.slice(-2), ['add:molecule', 'commit']);
});

import { labelHarness } from './fixtures/label-action-harness.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { spatialVoiceAction } from './voice-command-runner.mjs';

test('real voice actions: the diagnostics ring receives one layout and one update per action', async () => {
  const { h, labels, writes } = tourFocusHarness({ labels: true });
  h.molecularAnimation = { selectionSphere: loci => loci, refresh: async () => {} };
  // Re-extract the production action and every emphasis/focus/placement slice
  // in strict mode. The fixture supplies molecular bounds and renderer adapters;
  // the session, transaction, solver and diagnostic sanitizer remain real.
  for (const name of ['emphasize', 'focusSelection', 'bakeGrab', 'takeWearerPlacement',
    'rotationFromPlacement', 'rotationDegreesZYX', 'placementTransform', 'placeInspection',
    'rebuildComponentLabels', 'componentLabelLayout']) {
    vm.runInContext('"use strict";\n' + pageFunction(viewer, name), h);
  }
  h.clearHeldPlatePlacement = placement => placement;
  h.onSpatialAction = vm.runInContext('"use strict";\n' + viewerCallback(viewer, 'onSpatialAction'), h);
  // Disable sampling so a duplicate cheap plate-update cannot be hidden by
  // the production ring's five-second no-op throttle.
  const ring = createDiagnosticsBuffer({ now: () => h.performance.now(), rateLimitMs: 0 });
  h.recordCost = h.recordManipulation = (kind, detail) => ring.record(kind, detail);
  await h.rebuildComponentLabels();
  let cursor = ring.since(0, 200).at(-1).seq;
  for (const [phrase, kind, reason] of [
    ['show me dyskerin', 'emphasize-part', 'emphasis+placement'],
    ['make it smaller', 'scale', 'placement'],
  ]) {
    const before = h.inspectionSnapshot().placement.scale, written = writes.length;
    const { action } = spatialVoiceAction(phrase, { lessonParts: h.emphasisState.parts });
    assert.equal(action.kind, kind);
    if (kind === 'emphasize-part') assert.equal(action.framing, 'context');
    await h.onSpatialAction(action);
    while (labels.session.busy()) await new Promise(resolve => setImmediate(resolve));
    const entries = ring.since(cursor, 200);
    const layouts = entries.filter(entry => entry.kind === 'component-label-layout');
    const updates = entries.filter(entry => entry.kind === 'plate-update');
    assert.equal(layouts.length, 1, `${phrase}: exactly one layout in the ring`);
    assert.equal(updates.length, 1, `${phrase}: exactly one plate update in the ring`);
    assert.equal(layouts[0].detail.reason, reason, `${phrase}: combined transaction reason`);
    assert.equal(updates[0].detail.reason, reason);
    assert.equal(layouts[0].detail.failed, undefined, 'the real solver completed');
    assert.equal(layouts[0].detail.anchors.length, 2);
    assert.ok(writes.length > written, 'the production path committed placement');
    if (kind === 'emphasize-part') {
      assert.equal(entries.filter(entry => entry.kind === 'xr-focus').length, 1);
      assert.deepEqual(plain(h.emphasisState.focus), ['dyskerin']);
    } else assert.ok(h.inspectionSnapshot().placement.scale < before);
    cursor = entries.at(-1).seq;
  }
});

test('a plate build that fails part way deletes its plates, and the session retires any it could not', async () => {
  const roots = cells => [...cells.keys()].filter(ref => /^plate-\d+$/.test(ref));
  for (const deleteFails of [false, true]) {
    const { h, cells, session } = labelHarness();
    const build = h.plugin.build.bind(h.plugin), deletePlates = h.deleteComponentLabelCells;
    const deleted = [];
    h.deleteComponentLabelCells = refs => { deleted.push([...refs]); return deletePlates(refs); };
    let commits = 0, deletes = 0, failing = true;
    h.plugin.build = () => {
      const builder = build(), commit = builder.commit, drop = builder.delete;
      let deleting = false;
      builder.delete = ref => { deleting = true; return drop(ref); };
      builder.commit = async options => {
        // The second cleanup delete fails once: plate-0 goes, plate-1 and plate-2 stay.
        if (deleting) {
          deletes += 1;
          if (deleteFails && failing && deletes === 2) throw Error('delete_failed');
          return commit(options);
        }
        // The third plate commits its cells and then fails, as a partial commit would.
        commits += 1;
        await commit(options);
        if (failing && commits === 3) throw Error('plate_commit_failed');
      };
      return builder;
    };
    await assert.rejects(h.rebuildComponentLabels(), /plate_commit_failed/);
    assert.deepEqual(session.refs(), []);
    if (!deleteFails) {
      assert.deepEqual(roots(cells), []); assert.equal(session.active(), false);
      continue;
    }
    // Only the cells still present are stranded, and they still count as drawn.
    assert.deepEqual(roots(cells), ['plate-1', 'plate-2']); assert.equal(session.active(), true);
    failing = false;
    await h.rebuildComponentLabels();
    // The next pass deletes them before it builds, then reuses plate-0 for a
    // live plate, which no later retry may touch.
    assert.deepEqual(deleted.at(-1), ['plate-1', 'plate-2']);
    const live = session.refs();
    assert.ok(live.includes('plate-0'));
    assert.deepEqual(roots(cells).sort(), [...live].sort());
    await h.rebuildComponentLabels();
    assert.ok(live.every(ref => cells.has(ref)));
  }
});

for (const presenting of [true, false]) test(`an identical emphasis set repaints live plate opacity without rebuilding geometry (XR=${presenting})`, async () => {
  const h = labelHarness();
  h.h.canvas.xr.isPresenting.value = presenting;
  await h.h.rebuildComponentLabels();
  const beforeCells = new Map(h.cells);
  const refs = h.session.refs(), buildCommits = h.commits.length;
  h.h.componentLabelKeyPlan = () => ({ colours: h.h.emphasisState.parts.map(part => ({ id: part.id, opacity: .25 })) });
  await h.h.rebuildComponentLabels();
  assert.equal(h.commits.length, buildCommits + 1, 'opacity uses one atomic in-place update');
  assert.deepEqual(h.session.refs(), refs);
  for (const ref of refs) {
    assert.equal(h.cells.get(`${ref}-backing`).params.alpha, presenting ? 0 : .6);
    assert.equal(h.cells.has(`${ref}-text`), false, 'ink and backing share one primitive and alpha');
  }
  h.h.componentLabelKeyPlan = () => ({ colours: h.h.emphasisState.parts.map(part => ({ id: part.id, opacity: 1 })) });
  await h.h.rebuildComponentLabels();
  assert.equal(h.commits.length, buildCommits + 2, 'restoring emphasis also repaints in one commit');
  for (const ref of refs) assert.equal(h.cells.get(`${ref}-backing`).params.alpha, 1);
  for (const [ref, cell] of h.cells) assert.equal(cell, beforeCells.get(ref));
  assert.equal(h.session.passes(), 1);
  assert.ok(h.commits.slice(buildCommits).every(commit => commit.operations.every(op => op === 'update')));
});

for (const action of ['scale', 'focus']) test(`a committed ${action} re-solves live plates against the new silhouette`, async () => {
  const { h, session } = labelHarness();
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const solves = [], takeovers = [];
  h.inspectionSnapshot = () => ({ placement, appearance: { highlightColor: '#ffffff' } });
  h.presentationTransform = () => {
    const matrix = Mat4.fromScaling(Mat4(), Vec3.create(placement.scale, placement.scale, placement.scale));
    matrix[14] = -4 * (1 - placement.scale);
    return matrix;
  };
  const extrema = [[-1, -.5, -4], [1, .5, -4]];
  h.loadedSphere = () => ({ center: [0, 0, -4], radius: 1, extrema });
  h.componentLabelLayout = (drawable, sizing, plan, subject) => {
    assert.deepEqual(plain(subject.points), extrema.map(point =>
      Array.from(Vec3.transformMat4(Vec3(), point, h.presentationTransform()))),
    'build and relayout retain whole-assembly extrema after focus or scale');
    const solved = layout.layoutComponentPlates({ plates: drawable, ...sizing, subject,
      eye: [0, 0, 0], target: [0, 0, -1], field: layout.PLATE_FIELD });
    solves.push(solved);
    return new Map(solved.placements.map(plate => [plate.id, plate]));
  };
  Object.assign(h, { Euler, pivotPreservingTranslation, clampPlacementScale,
    assertReady() {}, normalizePlacement: (patch, base) => ({ ...base, ...patch }), syncInspectionPayload() {},
    inspectionMutation: async operation => { await operation(); return { placement }; },
    inspectionState: { placement: () => structuredClone(placement), place: patch => { placement = { ...placement, ...patch }; },
      checkpoint: () => placement, restoreCheckpoint: checkpoint => { placement = checkpoint; } },
    busy: false, state: { status: 'ready', generation: 1 }, grabRotation: null, grabOffset: null, grabScale: 1,
    gesturePivot: createGesturePivot(), focusPivotRequest: undefined, visibleStage: undefined,
    xrPlacementFollowup: undefined, latestRoomPlacementPose: undefined, AbortController, setTimeout, clearTimeout, now: () => performance.now(),
    mutate: async (_kind, operation) => operation(), recordManipulation() {},
    pivotBounds: () => ({ baseCenter: [0, 0, -4], visibleCenter: [0, 0, -4], radius: 1 }),
    takeWearerPlacement: reason => takeovers.push(reason),
  });
  h.canvas.webgl = { isContextLost: false };
  h.wearerPlacement = createPlacementHold();
  h.agentPlacementHistory = createAgentPlacementHistory({ hold: h.wearerPlacement, context: () => ({ session: h.canvas.xr.isPresenting.value ? h.canvas : undefined, source: 'fixture' }) });
  for (const name of ['cancelXrPlacementFollowup', 'invalidateGesturePivot', 'gesturePivotContext', 'gesturePivotCenter', 'grabPivotBounds', 'pivotCenter',
    'startXrPlacementFollowup', 'clearHeldPlatePlacement', 'placementIntentCheckpoint', 'settlePlacementIntent', 'placeInspection', 'bakeGrab', 'rotationFromPlacement', 'rotationDegreesZYX']) {
    vm.runInContext(pageFunction(viewer, name), h);
  }
  h.clearHeldPlatePlacement = requested => requested;
  const reseats = [];
  h.immersiveSession = { ...h.immersiveSession, toolbarAction: async request => { reseats.push(plain(request)); } };
  await session.rebuild();
  const before = solves.at(-1);
  h.componentLabelPlateParts = () => h.emphasisState.parts.map((part, i) => ({ ...part, focused: i < 2 }));
  if (action === 'scale') await h.placeInspection({ scale: .5 });
  else { h.grabScale = .5; await h.bakeGrab({ gesture: 'focus' }); }
  assert.deepEqual(takeovers, action === 'scale' ? ['agent-placement'] : [], 'explicit scale owns room intent; automatic focus does not');
  assert.deepEqual(reseats, action === 'scale' ? [{ kind: 'recenter-menu', reason: 'placement' }] : [],
    'an agent placement re-seats and reveals the glass; automatic focus leaves it');
  assert.equal(solves.length, 2, 'placement commits a layout without waiting for a menu press');
  const after = solves.at(-1);
  assert.ok(after.subject.halfWidth < before.subject.halfWidth);
  assert.equal(after.placements.filter(plate => plate.focused).length, 2, 'the new emphasis owns focus priority');
  assert.equal(after.subjectOverlaps, 0);
  assert.equal(after.overlaps, 0);
  assert.equal(after.offGlass, 0);
  if (action === 'scale') {
    await h.placeInspection({ rotation: [0, 35, 0] });
    assert.deepEqual(reseats, Array.from({ length: 2 }, () => ({ kind: 'recenter-menu', reason: 'placement' })),
      'a subsequent agent turn runs the same re-seat decision');
    assert.deepEqual(placement.rotation, [0, 35, 0]);
  }
});

test('changing part colours retains the readable plate palette without rebuilding geometry', async () => {
  const h = labelHarness(true);
  await h.h.rebuildComponentLabels();
  const refs = h.session.refs(), buildCommits = h.commits.length;
  const beforeCells = [...h.cells.values()];
  assert.equal(h.cells.has('plate-9-leader'), false);
  // Replace the authored objects so repaint cannot read a captured build-time colour.
  h.h.emphasisState.parts = h.h.emphasisState.parts.map(part => ({ ...part, color: '#e84a7f' }));
  await h.h.rebuildComponentLabels();
  assert.equal(h.commits.length, buildCommits, 'part colour does not change the fixed readable plate palette');
  assert.deepEqual(h.session.refs(), refs);
  [...h.cells.values()].forEach((cell, i) => assert.equal(cell, beforeCells[i]));
  const paint = componentPaint.componentLabelPaint({ color: 0xe84a7f });
  for (const ref of refs) {
    const cell = h.cells.get(`${ref}-backing`);
    assert.ok(cell, 'every part retains its backed text primitive');
    for (const key of ['textColor', 'backgroundColor', 'borderColor', 'alpha']) {
      assert.equal(cell.params[key], paint.backing[key], `${ref}-backing.${key}`);
    }
    assert.equal(cell.params.textColor, 0x15212b);
    assert.equal(cell.params.backgroundColor, 0xffffff);
    assert.equal(h.cells.has(`${ref}-text`), false);
    assert.equal(h.cells.has(`${ref}-leader`), false);
  }
});

// The telomerase tour re-solved thirty label layers for
// every caption line that made the menu glass taller (`menuReason: "grow"`,
// ring seq 682, 693, 708, 727, 745, 764), and each re-solve committed every
// layer because a head-sampled solve never repeats a float exactly. Mol*
// rebuilds a label's text and re-uploads its font atlas per changed layer, so
// each pass held the page for twelve seconds with one XR frame in it.
test('a repaint of an unchanged key stages no label cell and commits nothing', async () => {
  const h = labelHarness(true);
  await h.h.rebuildComponentLabels();
  const refs = h.session.refs(), buildCommits = h.commits.length;
  await h.h.rebuildComponentLabels();
  assert.equal(h.commits.length, buildCommits, 'an identical key is not a state-tree commit');
  assert.deepEqual(h.session.refs(), refs);
  const update = h.records.filter(record => record.kind === 'plate-update').at(-1);
  assert.deepEqual({ ...update, ms: 0 }, { kind: 'plate-update', path: 'repaint', layers: 10, changed: 0, geometry: false, ms: 0 });
});

test('a menu relayout that moves no plate commits nothing and keeps the measurement', async () => {
  const h = labelHarness(true);
  await h.session.rebuild();
  const refs = h.session.refs(), buildCommits = h.commits.length;
  const before = plain([...h.cells.values()].map(cell => cell.params));
  h.measure(0);
  const drawn = h.records.filter(record => record.kind === 'component-labels-drawn').length;
  // The caption glass grew and the head did not move: the same solve again.
  await h.session.relayout('grow');
  assert.equal(h.session.passes(), 1, 'this exercised the in-place update');
  assert.equal(h.commits.length, buildCommits, 'an unmoved layout is not a state-tree commit');
  assert.deepEqual(plain([...h.cells.values()].map(cell => cell.params)), before);
  const update = h.records.filter(record => record.kind === 'plate-update').at(-1);
  assert.deepEqual({ ...update, ms: 0 }, { kind: 'plate-update', path: 'relayout', reason: 'grow', layers: 10, changed: 0, geometry: false, ms: 0 });
  h.measure(1000);
  assert.equal(h.records.filter(record => record.kind === 'component-labels-drawn').length, drawn,
    'the plates on the glass are the ones already measured');
});

test('subpixel head jitter stays put; a real move commits only the moved layers', async () => {
  const h = labelHarness();
  await h.session.rebuild();
  const refs = h.session.refs(), buildCommits = h.commits.length;
  // At depth 4, 3000 px/radian gives a 60 px glyph and 750 px/scene unit.
  h.nudge(0.4 / 750);
  assert.equal(await h.h.updateMenuLabelPlates(refs, 'grow'), true);
  assert.equal(h.commits.length, buildCommits, 'head jitter is not a move');
  h.nudge(.08 * 2);
  assert.equal(await h.h.updateMenuLabelPlates(refs, 'reseat'), true);
  assert.equal(h.commits.length, buildCommits + 1, 'a two-character move commits');
  assert.deepEqual(h.commits.at(-1).operations, Array(10).fill('update'), 'every moved layer, and only those');
  assert.equal(h.records.filter(record => record.kind === 'plate-update').at(-1).changed, 10);
  for (const ref of refs) assert.equal(h.cells.get(`${ref}-backing`).params.offsetX, .16);
});

test('each headset plate uses one small font atlas for its backed text', async () => {
  const h = labelHarness(true);
  await h.session.rebuild();
  assert.equal(h.cells.get('plate-0-backing').params.fontQuality, componentPaint.COMPONENT_LABEL_FONT_QUALITY);
  for (const ref of h.session.refs()) {
    assert.equal(h.cells.get(`${ref}-backing`).params.fontQuality, 1);
    assert.equal(h.cells.has(`${ref}-text`), false);
    assert.equal(h.cells.has(`${ref}-leader`), false);
  }
  assert.equal([...h.cells.values()].filter(cell => cell.obj).length, 10);
});

for (const initialLeader of [false, true]) test(`menu relayout keeps single backed plates when solver leader hint changes from ${initialLeader}`, async () => {
  const h = labelHarness(initialLeader);
  await h.session.rebuild();
  const refs = h.session.refs(), before = refs.map(ref => h.cells.get(ref)), commits = h.commits.length;
  h.move(!initialLeader);
  await h.session.relayout('collapse,reseat');
  assert.equal(h.session.passes(), 1);
  assert.equal(h.commits.length, commits + 1);
  assert.deepEqual(h.session.refs(), refs);
  assert.deepEqual(refs.map(ref => h.cells.get(ref)), before);
  assert.equal(h.cells.size, 20, 'ten selection roots and ten backed text primitives');
  for (const ref of refs) {
    assert.equal(h.cells.has(`${ref}-leader`), false);
    assert.equal(h.cells.has(`${ref}-text`), false);
    assert.equal(h.cells.get(`${ref}-backing`).params.offsetX, .1);
  }
  assert.deepEqual(h.commits.at(-1).operations, Array(10).fill('update'));
  assert.equal(h.records.filter(r => r.kind === 'plate-update').length, 1);
});

test('per-eye drawn records retain all ten plates after a committed in-place menu update', async () => {
  const h = labelHarness();
  await h.session.rebuild();
  const refs = h.session.refs(), beforeCells = [...h.cells.values()];
  h.measure(0);
  const before = h.records.filter(record => record.kind === 'component-labels-drawn');
  assert.equal(before.length, 2);
  h.move();
  await h.session.relayout('collapse,reseat');
  assert.equal(h.session.passes(), 1, 'this exercised an in-place update');
  assert.deepEqual(h.session.refs(), refs);
  [...h.cells.values()].forEach((cell, i) => assert.equal(cell, beforeCells[i]));
  assert.deepEqual(plain(h.commits.at(-1).options), { revertOnError: true });
  h.measure(1000);
  const drawn = h.records.filter(record => record.kind === 'component-labels-drawn').slice(2);
  assert.deepEqual(drawn.map(record => record.eye), ['left', 'right']);
  for (const [i, record] of drawn.entries()) {
    assert.equal(record.plates, 10);
    assert.equal(record.visible, 10);
    assert.deepEqual(record.rects.map(rect => rect.id), Array.from({ length: 10 }, (_, i) => `part-${i}`));
    assert.ok(record.rects.every((rect, j) => rect.x > before[i].rects[j].x), 'measurement reads the committed offsets');
  }
});

test('label measurement waits for the first drawable commit before spending its gate', async () => {
  const h = labelHarness();
  await h.session.rebuild();
  const ref = h.session.refs()[0];
  const objects = [`${ref}-backing`].map(key => h.cells.get(key).obj.data.repr.renderObjects[0]);
  const positions = objects.map(object => object.values.aPosition);
  objects.forEach(object => { delete object.values.aPosition; });
  h.measure(0);
  assert.equal(h.records.filter(record => record.kind === 'component-labels-drawn').length, 0);
  objects.forEach((object, index) => { object.values.aPosition = positions[index]; });
  h.measure(1000);
  assert.equal(h.records.filter(record => record.kind === 'component-labels-drawn').length, 2);
});

test('settled collapse restores plate work and timers through XR, toolbar and diagnostics frames', async () => {
  const harness = labelHarness(true), { h, session, cells, commits } = harness;
  const work = { representationUpdates: 0, representationStateWrites: 0, measurements: 0, timersStarted: 0 };
  const timers = new Map();
  let clock = 0, timerId = 0, moved = false, relayout;
  h.setTimeout = (fn, ms) => { work.timersStarted++; timers.set(++timerId, { fn, at: clock + ms }); return timerId; };
  h.clearTimeout = id => timers.delete(id);
  h.setInterval = () => { throw Error('plate work must not start an interval'); };
  h.componentLabelLayout = () => new Map(h.emphasisState.parts.map(part => [part.id, {
    offsetX: moved ? 1 : 0, offsetY: 0, sizeScale: 1, alpha: 1, lines: [part.label],
    leader: { attachment: 'top-center', tetherLength: moved ? 2 : 1 },
  }]));
  h.measureComponentLabels = args => { work.measurements++; return measurement.measureComponentLabels(args); };
  await session.rebuild();
  // Execute the real transform updater too; a stub here would conceal writes
  // accidentally moved into onHeadFrame by a later change.
  for (const cell of cells.values()) if (cell.obj) {
    cell.obj.data.repr.setState = () => { work.representationStateWrites++; };
  }
  h.canvas.update = () => { work.representationUpdates++; };
  Object.assign(h, {
    inspectionState: {}, representation: { obj: { data: { repr: { renderObjects: [] } } } },
    scientificRepresentations: () => [], naturalInput: null, xrControllerInput: null,
    xrInputBlind: false, xrDeferredBake: undefined, xrDeferredGrab: undefined,
    roomAnchor: null, roomEntry: null, recordEntryStandoff: () => {},
    latestXrSpace: null, latestRoomPlacementPose: null, latestHeadContext: null, latestHeadSample: 0,
    pendingRoomLabelBasis: null, relativeHeadContext: () => ({}), xrSnapshotFrame: () => {},
    XRRigidTransform: class { inverse = { matrix: identity() }; },
  });
  h.canvas.camera.view = Mat4.identity();
  h.canvas.webgl = { xr: { session: {} } };
  for (const name of ['componentLabelRepresentations', 'applyInspectionTransform', 'flushXrDeferredGrab', 'sampleHeadFrame']) {
    vm.runInContext(pageFunction(viewer, name), h);
  }
  h.connectionFrame = connectionFrame;
  const onHeadFrame = vm.runInContext(viewerCallback(viewer, 'onHeadFrame'), h);
  // Unlike 605cf76, the viewer callback is invoked by the production XR
  // observer together with a real toolbar and the diagnostics RAF wrappers.
  // Mol* rendering/state and the XR scheduler remain counted adapters.
  const runtime = await toolbarFrameRuntime(undefined, { instrumentTimers: true });
  runtime.setTimers(h);
  const resolver = createMenuResolve({ now: () => clock, schedule: h.setTimeout, cancel: h.clearTimeout,
    solve: reason => { relayout = session.relayout(reason); } });
  let ready = false;
  const live = toolbarFrameHarness(runtime, { onRepresentationChange: count => {
    if (ready && count > 0) {
      moved = live.toolbar.isCollapsed();
      resolver.moved({ points: live.toolbar.menuPoints(), reason: live.toolbar.menuMotion() });
    }
  } });
  const ring = createDiagnosticsBuffer({ now: () => clock }), samples = [];
  const previousDiagnostics = globalThis.__stereofoldDiagnostics;
  const record = (kind, detail) => { samples.push({ kind, detail }); ring.record(kind, detail); };
  globalThis.__stereofoldDiagnostics = { record };
  let observer, cost, stopRate;
  try {
    await live.toolbar.update();
    live.toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    resolver.seed(live.toolbar.menuPoints()); ready = true;
    const pose = { transform: { position: { x: 0, y: 1.6, z: 0 }, matrix: identity() }, views: syntheticViews() };
    const frame = { getViewerPose: () => pose, getPose: () => null };
    const space = { getOffsetReferenceSpace: () => ({}) };
    const callbacks = new Map(); let callbackId = 0;
    live.session.requestAnimationFrame = callback => { callbacks.set(++callbackId, callback); return callbackId; };
    live.session.cancelAnimationFrame = id => callbacks.delete(id);
    h.canvas.webgl.xr.session = live.session;
    const frameRecord = { toolbar: live.toolbar };
    observer = runtime.installFrameProbe(frameRecord, live.session, space, onHeadFrame);
    cost = frameRecord.frameCost = watchFrameCost({ session: live.session, now: () => clock, record });
    assert.equal(cost.supported, true);
    stopRate = watchFrameRate(live.session, { now: () => clock, record });
    async function frames(count, observe = () => {}) {
      for (let i = 0; i < count; i++) {
        clock += 10; harness.time(clock); // synthetic time, no device-FPS assertion
        for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
        live.session.requestAnimationFrame((_time, xrFrame) => live.toolbar.depthRange(xrFrame));
        const due = [...callbacks.values()]; callbacks.clear();
        for (const callback of due) callback(clock, frame);
        // Drain action/representation/serial-owner continuations between frames.
        await new Promise(resolve => setImmediate(resolve));
        observe(i);
      }
    }
    const snapshot = () => ({ ...work, stateCommits: commits.length, timersArmed: timers.size });
    const window = async () => {
      const before = snapshot(), sampleStart = samples.length;
      const perFrame = [];
      runtime.reset();
      await frames(1000, index => {
        const current = snapshot();
        const delta = Object.fromEntries(Object.entries(current).map(([key, value]) =>
          [key, key === 'timersArmed' ? value : value - before[key]]));
        assert.deepEqual(delta, { representationUpdates: 0, representationStateWrites: 0,
          measurements: 0, timersStarted: 0, stateCommits: 0, timersArmed: 0 }, `settled frame ${index}`);
        assert.equal(callbacks.size, 1, 'exactly one diagnostics RAF remains armed between frames');
        const toolbarWork = {
          toolbarRepresentationUpdates: runtime.counts.toolbarRepresentationUpdates ?? 0,
          toolbarRepresentationStateWrites: runtime.counts.toolbarRepresentationStateWrites ?? 0,
        };
        assert.deepEqual(toolbarWork, { toolbarRepresentationUpdates: 0, toolbarRepresentationStateWrites: 0 },
          `settled toolbar frame ${index}`);
        perFrame.push({ ...delta, ...toolbarWork });
      });
      assert.equal(runtime.counts.syncPose, 1000, 'renderer and diagnostics share one pre-draw input pass');
      assert.equal(runtime.counts.syncInput, 1000);
      assert.equal(runtime.counts.depthRange, 1000);
      for (const name of ['update', 'createToolbarPanel', 'ShapeRepresentation', 'menuFootprintSignature']) {
        assert.equal(runtime.counts[name] ?? 0, 0, `${name} stays off settled frames`);
      }
      const emitted = samples.slice(sampleStart);
      assert.equal(emitted.filter(sample => sample.kind === 'frame-cost').length, 10);
      assert.equal(emitted.filter(sample => sample.kind === 'frame-rate').length, 2);
      assert.ok(ring.since(0, 200).some(entry => entry.kind === 'frame-cost'), 'production diagnostics buffer receives samples');
      return perFrame;
    };
    await frames(144);
    const baseline = await window();
    const before = snapshot();
    live.toolbar.runAction(live.toolbar.rows().find(row => row.id === 'menu').action);
    await frames(100); await relayout; await frames(144);
    assert.equal(live.toolbar.isCollapsed(), true, 'the production toolbar action collapses the grid');
    assert.ok(runtime.counts.createToolbarPanel > 0, 'collapse exercises the real redraw');
    assert.ok(runtime.counts.toolbarRepresentationUpdates > 0, 'toolbar representation update counter is live');
    assert.ok(work.timersStarted > before.timersStarted, 'action tick and menu settle timers are instrumented');
    assert.equal(commits.length, before.stateCommits + 1, 'one full 10-layer collapse commit');
    assert.equal(commits.at(-1).operations.length, 10);
    assert.equal(work.representationUpdates - before.representationUpdates, 10);
    assert.equal(work.representationStateWrites - before.representationStateWrites, 10);
    assert.equal(work.measurements - before.measurements, 1, 'one post-commit measurement for both eyes');
    assert.equal(session.busy(), false);
    assert.equal(resolver.pending(), false);
    assert.equal(timers.size, 0);
    assert.deepEqual(await window(), baseline, 'each settled frame matches the pre-collapse plate/timer baseline');
    assert.deepEqual(harness.records.filter(record => record.kind === 'xr-frame-error'), []);
    assert.deepEqual(samples.filter(record => record.kind === 'xr-frame-error'), []);
  } finally {
    stopRate?.(); cost?.stop(); observer?.restore(); resolver.dispose();
    await live.toolbar.dispose();
    globalThis.__stereofoldDiagnostics = previousDiagnostics;
  }

});

const stereoPose = headInRoom => ({ headInRoom, renderFromRoom: identity(),
  labelViews: syntheticViews().map(view => {
    const matrix = Mat4.mul(Mat4(), headInRoom, view.transform.matrix);
    return { ...view, transform: { matrix, inverse: { matrix: Mat4.invert(Mat4(), matrix) } } };
  }) });

function seatHarness() {
  const records = [], errors = [], nonEmptyBuilds = [];
  const sphere = { center: [0, 0, 0], radius: 100 };
  const parts = [
    { id: 'left', label: 'Dyskerin, first copy', keys: ['left'], bounds: { center: [-55, 0, 20], radius: 45 } },
    { id: 'right', label: 'Dyskerin, second copy', keys: ['right'], bounds: { center: [55, 15, 20], radius: 45 } },
  ];
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const camera = { scale: .01, getSnapshot: () => ({ position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0] }) };
  const h = vm.createContext({ clampPlacementScale, ...emptyLessonFigureBinding(), structuredClone,
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, connectionFrame, companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{}, ...facing, ...layout, ...componentPaint, Mat4, Vec3,
    // Nothing is hidden here, and the plate and adoption rules
    // both read the hidden set now.
    visibilityState: emptyVisibility(), normalizeStyles, stylesState: [], styleLayers: [], emptyVisibility, normalizeVisibility, hiddenSceneKeySet: () => new Set(),
    measurePlateSeat: input => { h.capInput = input; return measurePlateSeat(input); },
    placementFromRoom: input => { h.measureSeat = input.measureSeat; return placementFromRoom(input); },
    layoutComponentPlates: input => { h.lastObstacles = input.obstacles; h.lastLayoutInput = input; return layout.layoutComponentPlates(input); },
    createRoomAnchor, headViewBasis, componentPlateName, applyMatrix4,
    console: { error: error => errors.push(error) },
    roomEntry: null, roomAnchor: null, pendingRoomSeat: false, pendingRoomLabels: false, pendingRoomLabelBasis: null,
    roomSeatMemory: createRoomSeatMemory(), liveScene: () => ({}), cameraSnapshot: plain,
    settlingRoomAnchor: null, wearerPlacedInRoom: false, adoptionGeneration: 0,
    latestRoomPlacementPose: null, latestPlateSeat: null, latestSeatStandoffMeters: null,
    latestHeadContext: null, latestHeadSample: 0, talkCaption: null, menuResolveReason: null,
    labelMeasurementGate: createLabelMeasurementGate(),
    roomAnchorEnabled: () => true, loadedSphere: () => sphere, resetViewPlacement,
    busy: false, state: { status: 'ready' }, interactionActive: () => false,
    inspectionState: {}, inspectionSnapshot: () => ({ placement, appearance: { highlightColor: 0xffffff } }),
    canvas: { xr: { isPresenting: { value: true } }, camera: { ...camera, view: Mat4.identity() }, webgl: { xr: { session: {} } } }, plugin: {},
    XRRigidTransform: class { inverse = { matrix: identity() }; },
    relativeHeadContext: () => ({}), presentationTransform: () => h.placementTransform(placement),
    naturalInput: null, xrControllerInput: null,
    xrInputBlind: false, xrDeferredBake: undefined, xrDeferredGrab: undefined,
    recordEntryStandoff: () => {}, measureDrawnComponentLabels: () => {}, xrSnapshotFrame: () => {}, performance: { now: () => 0 },
    structureAtomSites: () => 13_121, sessionDeviceClass: () => 'quest2',
    emphasisState: { parts }, componentLabelLayoutCache: null, componentLabelBuildSignature: null,
    componentLabelPartsSignature: () => JSON.stringify(parts.map(part => [part.id, part.label, part.keys])),
    componentLabelsWanted: () => true,
    candidateRecords: new Set(), NO_EMPHASIS: {}, detached: plain,
    lessonResting: { setLabelsEnabled() {}, forget() {} }, lessonKey: { forget() {} },
    deleteComponentLabelCells: async () => {},
    componentLabelKeyPlan: () => ({}), componentLabelPlateParts: () => parts, currentEmphasisPlan: () => ({}), COMPONENT_LABEL_LIMIT: 10,
    selection: { toLoci: keys => parts.find(part => part.id === keys[0]).bounds },
    componentLabelBounds: createSelectionBoundsCache(loci => loci),
    StructureElement: { Loci: { getBoundingSphere: bounds => bounds, isEmpty: () => false } },
    componentLabelTextWidth: text => text.length * .55,
    setInspectionMotion: async () => {},
    placeInspection: async patch => { placement = { ...placement, ...patch }; },
    immersiveSession: { menuPoints: () => [], toolbarPlacementPoints: () => [[-.8, -.2, -1], [-.6, -.2, -1], [-.6, .2, -1], [-.8, .2, -1]],
      presentation: () => ({ roomMatrix: identity }) },
    scientificRepresentations: () => [],
    recordCost: (kind, value) => records.push({ kind, ...plain(value) }),
  });
  for (const name of ['adopt', 'beginRoomEntry', 'settleInRoom', 'roomAnchorPlacement', 'placementTransform', 'xrLabelSizing', 'componentLabelLayout', 'runFaceAction', 'flushXrDeferredGrab', 'sampleHeadFrame']) {
    vm.runInContext(pageFunction(viewer, name), h);
  }
  if (viewer.includes('  function componentLabelViewBasis(')) vm.runInContext(pageFunction(viewer, 'componentLabelViewBasis'), h);
  vm.runInContext(pageFunction(viewer, 'rebuildComponentLabels'), h);
  const rebuild = h.rebuildComponentLabels;
  let rebuilding;
  h.rebuildComponentLabels = (...args) => { h.requestedBasis = args[1]; rebuilding = rebuild(...args); return rebuilding; };
  h.onHeadFrame = vm.runInContext(viewerCallback(viewer, 'onHeadFrame'), h);
  const settle = h.settleInRoom;
  let settling;
  h.settleInRoom = (...args) => { settling = settle(...args); return settling; };
  // Execute the actual build through its solver call; replace only GPU uploads.
  const build = pageFunction(viewer, 'buildComponentLabelPlates');
  vm.runInContext(build.slice(0, build.indexOf('    const created =')) + `
    recordCost('component-labels', { seatMeters: sizing.distanceMeters, placementScale: placement.scale,
      sizeFactor: Math.round(sizing.sizeFactor * 100) / 100 });
    return drawable.map(entry => entry.id);
  }`, h);
  h.componentLabels = createComponentLabelSession({
    isPresenting: () => h.canvas.xr.isPresenting.value,
    wantsLabels: () => h.componentLabelsWanted(),
    buildPlates: async context => {
      h.builtBasis = context.seatBasis;
      const refs = await h.buildComponentLabelPlates(context);
      if (refs.length) nonEmptyBuilds.push(context);
      return refs;
    },
    deletePlates: refs => h.deletePlates?.(refs),
  });
  return { h, records, errors, nonEmptyBuilds, placement: () => placement,
    async frame(tracked = true, head = identity()) {
      h.onHeadFrame({ frame: { getViewerPose: () => tracked ? { transform: { matrix: head }, views: syntheticViews() } : null },
        space: { getOffsetReferenceSpace: () => ({}) }, mode: 'immersive-ar' });
      await settling;
      await rebuilding;
    } };
}

test('room-anchor solves reuse part bounds for stable selection loci', async () => {
  const view = seatHarness(), { h } = view;
  h.beginRoomEntry(true);
  await view.frame();
  let scans = 0;
  h.StructureElement.Loci.getBoundingSphere = loci => { scans++; return loci; };
  h.componentLabelBounds = createSelectionBoundsCache(h.StructureElement.Loci.getBoundingSphere);
  const solve = () => h.roomAnchorPlacement({ mode: 'auto', sphere: h.loadedSphere() });
  assert.ok(solve().seatBasis);
  assert.equal(scans, 2);
  assert.ok(solve().seatBasis);
  assert.equal(scans, 2, 'the second solve reads cached part spheres');
});

test('the XR session edge clears seat state before asking for entry labels', () => {
  const edge = viewer.slice(viewer.indexOf('    canvas.xr.isPresenting.subscribe(presenting =>'));
  const reset = edge.indexOf('beginRoomEntry(presenting)');
  assert.ok(reset >= 0 && reset < edge.indexOf('rebuildComponentLabels('));
});

for (const floor of [null, -1.6]) test(`viewer first settle and re-entry use one measured seat (floor ${floor})`, async () => {
  const view = seatHarness(), { h, records, errors } = view;
  for (let entry = 0; entry < 2; entry++) {
    h.beginRoomEntry(true);
    assert.equal(h.latestRoomPlacementPose, null, 'no pose from the previous session');
    assert.equal(h.latestPlateSeat, null, 'no cap from the previous session');
    await h.rebuildComponentLabels();
    assert.equal(records.length, entry * 2, 'no layout at the unmeasured desktop seat');
    await view.frame(false);
    assert.equal(records.length, entry * 2, 'tracking loss cannot spend the seat');
    if (floor !== null) h.roomAnchor.floorY = () => floor;
    h.busy = true;
    await view.frame();
    assert.equal(h.roomAnchor.status().placements, 0, 'startup mutation cannot spend the settle');
    h.busy = false;
    await view.frame();
    assert.equal(h.pendingRoomSeat, false);
    assert.equal(h.roomAnchor.status().placements, 1, h.roomEntry.seatRefusal ?? String(errors.at(-1)?.message ?? 'no seat'));
    assert.equal(h.latestPlateSeat.factor, 1);
    const measured = h.measureSeat({ ...view.placement(), standoffMeters: h.latestSeatStandoffMeters });
    assert.equal(measured.factor, 1);
    assert.ok(h.measureSeat({ ...view.placement(), scale: view.placement().scale + 1e-8,
      standoffMeters: h.latestSeatStandoffMeters }).factor < 1, 'no larger scale fits the plate band');
    await view.frame();
    assert.equal(records.length, (entry + 1) * 2, 'a settled entry does not solve per frame');
    h.beginRoomEntry(false);
  }
  assert.deepEqual(errors, []);
  assert.equal(records.length, 4);
  assert.deepEqual(records.slice(0, 2), records.slice(2));
  const [record, sizing] = records;
  assert.equal(record.seatDegrees, 45.003);
  assert.deepEqual(record.seatBand, [.058, .058]);
  assert.ok(Math.abs(sizing.placementScale - 1.5902740615) < 1e-9);
  assert.ok(record.seatBand.every(value => value > 0));
  assert.equal(sizing.seatMeters, 3);
  console.log('viewer repeated seat', JSON.stringify({ floor, seatDegrees: record.seatDegrees,
    seatBand: record.seatBand, ...sizing }));
});

function menuHarness(view) {
  const { h, records } = view;
  let liveToolbar;
  let now = 0, timer, points = [], seat = { position: { x: 0, y: 0, z: 0 }, matrix: identity() };
  const sessionSource = source('./immersive-session.mjs');
  // The commit now writes its own seat receipt. It goes to the page's
  // diagnostics ring, not to the layout records this harness counts, so it is
  // collected separately and asserted on beside them.
  const seatReceipts = [], actionErrors = [];
  const menu = vm.createContext({ clampPlacementScale, ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, companionRecord:undefined, retiredComparisons:new Set(),
    menuSeatReceipt,
    __stereofoldDiagnostics: { record: (kind, detail) => { seatReceipts.push({ kind, detail }); } },
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{},
    ...h, collapsed: true, actionChain: Promise.resolve(), actionEpoch: 0, inputLocked: false,
    acceptsInput: () => true, nextXrTick: async () => true, session: {}, gestures: { dispose() {} },
    menuLatched: true, seatReason: '', entryOutboard: 1, entryHead: seat, observedPlacementMoves: 0,
    wokenAt: 0, standingBack: false, engaged: false, setDimmed() {},
    restoredMenuLayout: undefined, tourSeatRestorePending: false,
    menuReseatRequested: false, renderedSeat: undefined, renderedGrid: undefined,
    renderedLayout: undefined, sameLayout: () => true, lastMenuMotion: [],
    // These presses act on a drawn menu, including when its grid is collapsed.
    // Mirror the visibility state read by the committed motion classification.
    hidden: false, hiddenMenuMotion: [], clearanceHidden: false, relocationSeat: undefined, cancelMenuDrag() {},
    getState: () => ({}), onActionError: error => { actionErrors.push(error); }, onAction: async () => {},
    menuPoints: () => points, startupPhase: 'active', active: null,
    createMenuResolve: options => createMenuResolve({ ...options, now: () => now,
      schedule: fn => { timer = fn; return 1; }, cancel: () => { timer = undefined; } }),
    onMenuPlaced: () => {},
  });
  // The production action consults placement ownership before it can redraw.
  // Include that real helper; an absent binding inside the action chain used
  // to silently end these presses before the fixture reached its commit.
  vm.runInContext(toolbar.match(/^  const wearerOwnsSeat = .*;$/m)[0], menu);
  for (const name of ['syncPlacementSeat', 'run', 'unlatchSeat']) vm.runInContext(pageFunction(toolbar, name), menu);
  for (const name of ['menuRedrawn', 'menuMotion', 'menuResolveFor']) vm.runInContext(pageFunction(sessionSource, name), menu);
  // Execute the toolbar's committed motion classification, up to its GPU swap.
  const commit = toolbar.slice(toolbar.indexOf('      const firstDraw = renderedSeat'),
    toolbar.indexOf('      seatedMenuPoints = toolbarMenuPoints(nextPanel)'));
  const callback = viewer.slice(viewer.indexOf('      onMenuPlaced: ({ reason }'), viewer.indexOf('      onPresented: async'));
  menu.onMenuPlaced = vm.runInContext('({' + callback + '}).onMenuPlaced', h);
  menu.active = { session: {}, toolbar: { menuMotion: () => menu.lastMenuMotion } };
  menu.record = menu.active;
  menu.reportPresentationRepresentationCount = () => {};
  const countStart = sessionSource.indexOf('          onRepresentationChange: count =>');
  const countCallback = sessionSource.slice(countStart, sessionSource.indexOf('\n          },', countStart) + 13);
  const committed = vm.runInContext('({' + countCallback + '}).onRepresentationChange', menu);
  h.immersiveSession.menuPoints = () => points;
  h.immersiveSession.isMenuCollapsed = () => menu.collapsed;
  h.immersiveSession.toolbarAction = action => menu.run(action);
  menu.update = async () => {
    menu.entryHead ??= seat;
    const rows = spatialToolbarRows({ collapsed: menu.collapsed });
    points = toolbarMenuPoints(createToolbarPanel({ rows, head: menu.entryHead }));
    menu.seatSignature = JSON.stringify(menu.entryHead.position);
    vm.runInContext('{' + commit + '}', menu);
    committed(1);
  };
  return { menu, seatReceipts, onRepresentationChange: committed,
    // Use the full toolbar for regressions in pose acquisition/build validation;
    // the small action harness above only exercises committed motion wiring.
    useToolbar(toolbar) {
      liveToolbar = toolbar;
      menu.active.toolbar = toolbar;
      menu.menuPoints = h.immersiveSession.menuPoints = () => toolbar.menuPoints();
      menu.update = () => toolbar.update();
      h.immersiveSession.toolbarRows = () => toolbar.rows();
      h.immersiveSession.toolbarAction = action => toolbar.runAction(action);
    }, async seed(collapsed) {
    menu.collapsed = collapsed;
    await menu.update();
    if (liveToolbar && liveToolbar.isCollapsed() !== collapsed) {
      liveToolbar.runAction({ kind: 'collapse', value: collapsed });
      await new Promise(resolve => setImmediate(resolve));
    }
    menu.menuResolveFor(menu.active).dispose();
    menu.menuResolveFor(menu.active).seed(menu.menuPoints());
  }, moveHead() { seat = { ...seat, position: { x: .25, y: 0, z: 0 } }; },
  async press(action) {
    menu.run(action);
    await menu.actionChain;
  }, async settle() {
    assert.deepEqual(actionErrors, [], 'explicit menu action must succeed before its layout notification');
    now += MENU_SETTLE_MS;
    assert.ok(timer, 'committed redraw must schedule a solve');
    timer(); timer = undefined;
    await new Promise(resolve => setImmediate(resolve));
    return records.filter(record => record.kind === 'component-label-layout').at(-1);
  } };
}

for (const [motion, collapsed, label, reason] of [
  ['Move', false, 'Re-seat', 'reseat'],
  ['stationary Move', false, 'Re-seat', 'reseat'],
  ['collapse', false, 'Close', 'collapse,reseat'],
  ['expand', true, 'Menu', 'expand,reseat'],
]) test(`toolbar ${motion} reaches a new page layout with a menu rectangle`, async () => {
  const view = seatHarness();
  view.h.beginRoomEntry(true);
  view.h.latestRoomPlacementPose = stereoPose(identity());
  await view.h.settleInRoom({}, {});
  const menu = menuHarness(view);
  await menu.seed(collapsed);
  const before = view.records.length;
  if (motion === 'Move') menu.moveHead();
  const action = spatialToolbarRows({ collapsed }).find(row => row.label === label)?.action;
  assert.ok(action, `${label} must be a shipped row`);
  await menu.press(action);
  const record = await menu.settle();
  assert.deepEqual(view.errors, []);
  assert.equal(view.records.length, before + 2, 'one new layout and sizing pass');
  assert.equal(view.h.labelMeasurementGate.due(0, true, [{}]), true, 'menu motion invalidates the drawn measurement');
  assert.equal(record.menuReason, reason);
  // And the commit's own receipt, which is all a scene without name
  // plates ever gets.
  const receipt = menu.seatReceipts.filter(entry => entry.detail.phase === 'seat-commit').at(-1);
  assert.ok(receipt, 'the committed re-seat must write a receipt of its own');
  assert.equal(receipt.kind, 'toolbar');
  assert.equal(receipt.detail.motion, reason);
  assert.equal(receipt.detail.reseated, true);
  assert.notEqual(record.menu, null, 'the menu rectangle reached the solver');
  assert.equal(view.h.lastObstacles.length, 1);
  assert.ok(view.h.lastObstacles[0].halfWidth > 0);
});

test('acceptance seq4 driver menu:menu twice commits one collapse and one expand layout', async () => {
  const view = seatHarness();
  view.h.beginRoomEntry(true);
  await view.frame();
  const menu = menuHarness(view);
  const runtime = await toolbarFrameRuntime();
  // seq4-menu/ring-press1-b.json: entry stand-off 0 (#43), then a latched
  // stand-off of 2.7 m (#110-111). The radius stayed.9; the explicit reseat
  // must pick up new room bounds before building, without another refresh.
  const live = toolbarFrameHarness(runtime, {
    state: { tour: { selectedId: 'telomerase-haca', active: false, step: -1, captionCard: 'hidden' } },
    bounds: { center: [0, 1.6, 2], radius: .9 },
    onRepresentationChange: menu.onRepresentationChange,
  });
  menu.useToolbar(live.toolbar);
  const diagnostics = [], previousDiagnostics = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => diagnostics.push({ kind, detail }) };
  // Execute the shipped page hook installation and the driver's actual CDP
  // expression: read current rows, press "menu" once, return without awaiting.
  view.h.installSpatialMenuHook = installSpatialMenuHook;
  const install = viewer.match(/detachSpatialMenuHook = installSpatialMenuHook\(\{[\s\S]*?\n    \}\);/)[0];
  const driver = source('../../plugin/scripts/headset-drive.ts');
  const driverMenu = driver.slice(driver.indexOf('export function menuStepArguments('));
  const expression = driverMenu.match(/expression: `([\s\S]*?)`,/)[1]
    .replaceAll('${JSON.stringify(id)}', JSON.stringify('menu'));
  let detach;
  try {
    await menu.seed(false);
    assert.equal(live.toolbar.isHidden(), false);
    assert.equal(diagnostics.find(record => record.detail.phase === 'standoff').detail.meters, 0);
    vm.runInContext(install, view.h);
    detach = view.h.detachSpatialMenuHook;
    live.setBounds({ center: [0, 1.6, -1.9], radius: .9 });
    let previousPoints = live.toolbar.drawnMenuPoints();
    const before = view.records.filter(record => record.kind === 'component-label-layout').length;
    for (const [index, label, reason] of [[0, 'Close', 'collapse,reseat'], [1, 'Menu', 'expand,reseat']]) {
      const drawStart = diagnostics.length;
      const result = vm.runInNewContext(expression, { globalThis });
      assert.equal(result.status, 'pressed');
      assert.equal(result.rows.find(row => row.id === 'menu').label, label);
      await new Promise(resolve => setImmediate(resolve));
      const record = await menu.settle();
      assert.equal(record.menuReason, reason);
      assert.equal(record.basis, 'head');
      assert.notEqual(record.menu, null);
      assert.equal(view.records.filter(record => record.kind === 'component-label-layout').length, before + index + 1);
      const rows = diagnostics.slice(drawStart).filter(record => record.detail.phase === 'rows');
      assert.equal(new Set(rows.map(record => record.detail.draw)).size, 1, 'one committed redraw per press');
      assert.ok(rows.flatMap(record => record.detail.labels).includes(index === 0 ? 'Menu' : 'Close'));
      assert.equal(live.toolbar.isCollapsed(), index === 0);
      assert.notDeepEqual(live.toolbar.drawnMenuPoints(), previousPoints, 'visible glass changes on each press');
      previousPoints = live.toolbar.drawnMenuPoints();
      await live.frames();
      assert.equal(menu.menu.menuResolveFor(menu.menu.active).pending(), false, 'steady frames cannot add a second solve');
    }
    assert.deepEqual(view.errors, []);
  } finally {
    detach?.();
    menu.menu.menuResolveFor(menu.menu.active).dispose();
    await live.toolbar.dispose();
    globalThis.__stereofoldDiagnostics = previousDiagnostics;
  }
});

test('face-button Menu follows the same toolbar fold and re-seat path', async () => {
  const view = seatHarness();
  view.h.beginRoomEntry(true);
  view.h.latestRoomPlacementPose = stereoPose(identity());
  await view.h.settleInRoom({}, {});
  const menu = menuHarness(view);
  await menu.seed(true);
  const before = view.records.length;
  menu.moveHead();
  await view.h.runFaceAction('menu');
  await menu.menu.actionChain;
  const record = await menu.settle();
  assert.deepEqual(view.errors, []);
  assert.equal(view.records.length, before + 2, 'one new layout and sizing pass');
  assert.equal(view.h.labelMeasurementGate.due(0, true, [{}]), true, 'menu motion invalidates the drawn measurement');
  assert.equal(record.menuReason, 'expand,reseat');
  assert.notEqual(record.menu, null);
});

test('anchor-off first entry and re-entry still cap and record the tracked seat', async () => {
  const view = seatHarness(), { h, records, errors } = view;
  h.roomAnchorEnabled = () => false;
  for (let entry = 0; entry < 2; entry++) {
    h.beginRoomEntry(true);
    assert.equal(h.roomAnchor, null);
    assert.equal(h.pendingRoomSeat, true);
    await view.frame(false);
    assert.equal(records.length, entry * 2);
    await view.frame();
    assert.equal(h.pendingRoomSeat, false);
    assert.equal(h.latestPlateSeat.factor, 1);
    assert.equal(records.length, (entry + 1) * 2);
    assert.equal(records.at(-2).seatDegrees, 45.003);
    assert.deepEqual(records.at(-2).seatBand, [.058, .058]);
    await view.frame();
    assert.equal(records.length, (entry + 1) * 2);
    h.beginRoomEntry(false);
  }
  assert.deepEqual(errors, []);
});

// The first entry after the headset reboot. The
// head stood off the room origin, the seat stood the structure straight ahead
// of the wearer, and the cap and the layout measured it from the origin: scale
// 0.68 where the re-entry got 1.90, silhouette x 0.349, nine plates at the left
// edge of the field. The wearer's view of the seat does not depend on where in
// the room they happen to be standing, so neither may the cap or the layout.
test('the seat cap and the plate layout measure from the tracked head, not the room origin', async () => {
  const seatFrom = async headInRoom => {
    const view = seatHarness(), { h, records, errors } = view;
    h.beginRoomEntry(true);
    h.latestRoomPlacementPose = stereoPose(headInRoom);
    await h.settleInRoom({}, {});
    assert.deepEqual(errors, []);
    const layout = records.findLast(record => record.kind === 'component-label-layout');
    assert.ok(layout, 'the seat publishes a layout');
    const placed = view.placement(), sphere = h.loadedSphere(), cameraScale = h.canvas.camera.scale;
    const geometry = { subject: [{ center: sphere.center.map((value, axis) =>
      (value + placed.translation[axis] * sphere.radius) * cameraScale),
      radius: sphere.radius * placed.scale * cameraScale }],
    views: stereoPose(headInRoom).labelViews, renderFromRoom: identity() };
    const menu = resetEntryLateralBreakdown({ geometry,
      points: h.immersiveSession.toolbarPlacementPoints(), clearance: 0 });
    return { scale: placed.scale, seatDegrees: layout.seatDegrees, silhouette: layout.silhouette,
      basis: layout.basis, sides: layout.sides, menu };
  };
  const origin = await seatFrom(identity());
  assert.equal(origin.seatDegrees, 45.003, 'the origin seat is the one every earlier capture took');
  assert.equal(origin.basis, 'head');
  const aside = Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0)));
  const turned = Array.from(Mat4.fromRotation(Mat4(), 25 * Math.PI / 180, Vec3.create(0, 1, 0)));
  const both = Array.from(Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.create(-0.8, 0.1, 0.6)), Mat4.fromRotation(Mat4(), -40 * Math.PI / 180, Vec3.create(0, 1, 0))));
  // A step to the side leaves the view unchanged. A turn can need a smaller
  // stereo fit beside the held menu, while the cap still uses the head basis.
  for (const [name, pose, tolerance] of [['aside', aside, 1e-6], ['turned', turned, 0.6], ['both', both, 0.6]]) {
    const seat = await seatFrom(pose);
    assert.equal(seat.basis, 'head', name);
    assert.ok(Math.abs(seat.scale - origin.scale) <= tolerance * origin.scale,
      `${name}: capped at ${seat.scale}, the origin seat at ${origin.scale}`);
    assert.ok(Math.abs(seat.seatDegrees - origin.seatDegrees) <= (tolerance < 0.01 ? 0.002 : 2),
      `${name}: ${seat.seatDegrees} degrees, the origin seat ${origin.seatDegrees}`);
    assert.ok(Math.abs(seat.silhouette[0]) < (tolerance < 0.01 ? 0.01 : 0.1351),
      `${name}: the structure stays in the head-centred band at x ${seat.silhouette[0]}`);
    assert.deepEqual(seat.menu.eyes.map(eye => eye.separated), [true, true],
      `${name}: the menu and molecule stay separate in both eyes`);
    if (tolerance < 0.01) assert.deepEqual(seat.sides, origin.sides, `${name}: the plates sit where they sit at the origin`);
  }
});


for (const anchors of [true, false]) test(`preserved wearer re-entry waits for its first tracked pose (anchors ${anchors})`, async () => {
  const view = seatHarness(), { h, records, errors } = view;
  h.roomAnchorEnabled = () => anchors;
  h.beginRoomEntry(true);
  await view.frame();
  const placed = plain(view.placement());
  h.wearerPlacedInRoom = true;
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  const before = records.length;
  await h.rebuildComponentLabels(); // the presenting subscriber's request
  assert.equal(records.length, before, 'the session edge must wait for a new head pose');
  await view.frame(false);
  assert.equal(records.length, before, 'tracking loss must keep the rebuild pending');
  await view.frame(true, Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0))));
  assert.deepEqual(Array.from(h.lastLayoutInput.eye), [150, 0, 0], 'use this session’s head position');
  assert.equal(records.length, before + 2, 'first tracking must publish the deferred layout');
  assert.equal(records.at(-2).basis, 'head');
  assert.deepEqual(plain(view.placement()), placed, 'preserve the wearer placement');
  await view.frame();
  assert.equal(records.length, before + 2, 'later frames must not solve again');
  assert.deepEqual(errors, []);
});

test('preserved re-entry coalesces its tracked basis behind a held label delete', async () => {
  const view = seatHarness(), { h, records, errors, nonEmptyBuilds } = view;
  h.beginRoomEntry(true);
  await view.frame(); // leave live plates for the session-edge pass to delete
  h.wearerPlacedInRoom = true;
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  const beforeBuilds = nonEmptyBuilds.length, beforeRecords = records.length;
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  h.deletePlates = () => { reached(); return held; };
  const edge = h.componentLabels.rebuild(); // the presenting subscriber's request
  await entered;
  const firstFrame = view.frame(true, Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0))));
  await Promise.resolve(); // let the tracked frame queue its deferred request
  const capturedBasis = h.requestedBasis;
  assert.ok(capturedBasis);
  // Tracking can advance again while the session-edge delete is still held.
  const laterFrame = view.frame(true, identity());
  assert.equal(records.length, beforeRecords, 'the delete still holds both builds');
  release();
  await Promise.all([edge, firstFrame, laterFrame]);
  const built = nonEmptyBuilds.slice(beforeBuilds);
  assert.equal(built.length, 1, 'only the deferred pass may build non-empty plates');
  assert.equal(built[0].seatBasis, capturedBasis, 'build with the first tracked basis');
  assert.equal(h.lastLayoutInput.eye, capturedBasis.eye);
  assert.deepEqual(Array.from(h.lastLayoutInput.eye), [150, 0, 0]);
  assert.equal(records.slice(beforeRecords).filter(record => record.kind === 'component-label-layout').length, 1,
    'publish the re-entry layout exactly once');
  assert.equal(h.pendingRoomLabels, false);
  assert.equal(h.componentLabels.refs().length, 2);
  await view.frame();
  assert.equal(nonEmptyBuilds.length, beforeBuilds + 1, 'later tracking cannot repeat the build');
  assert.deepEqual(errors, []);
});

test('disabling labels during a held re-entry rebuild does not gate later labels', async () => {
  const view = seatHarness(), { h, records, errors, nonEmptyBuilds } = view;
  h.beginRoomEntry(true);
  await view.frame();
  h.wearerPlacedInRoom = true;
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  const beforeBuilds = nonEmptyBuilds.length, beforeRecords = records.length;
  let release;
  h.deletePlates = () => new Promise(resolve => { release = resolve; });
  const edge = h.componentLabels.rebuild();
  assert.ok(release, 'the session-edge pass is awaiting its delete');
  const tracked = view.frame();
  await Promise.resolve();
  h.componentLabelsWanted = () => false;
  release();
  await Promise.all([edge, tracked]);
  assert.equal(nonEmptyBuilds.length, beforeBuilds, 'disabled labels skip the deferred build');
  assert.equal(records.length, beforeRecords);
  h.componentLabelsWanted = () => true;
  await h.rebuildComponentLabels();
  assert.equal(nonEmptyBuilds.length, beforeBuilds + 1, 'labels can build again after the queue drains');
  assert.equal(h.componentLabels.refs().length, 2);
  assert.deepEqual(errors, []);
});

test('a source swap clears deferred re-entry labels and the next entry rebuilds', async () => {
  const view = seatHarness(), { h, records, errors } = view;
  h.beginRoomEntry(true);
  await view.frame();
  h.wearerPlacedInRoom = true;
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  await h.rebuildComponentLabels();
  assert.equal(h.pendingRoomLabels, true);
  const before = records.length, emphasis = h.emphasisState;
  h.adopt({ source: { sha256: 'new-source' }, selection: h.selection });
  assert.equal(h.pendingRoomLabels, false, 'the old entry must not block the new source');
  h.emphasisState = emphasis; // author the new source's lesson plates
  await h.rebuildComponentLabels();
  assert.equal(records.length, before + 2, 'the source can build before tracking returns');
  assert.equal(h.componentLabels.refs().length, 2);
  await view.frame(false);
  assert.equal(h.pendingRoomLabels, false, 'only a new entry may re-arm the flag');
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  assert.equal(h.pendingRoomLabels, true);
  await h.rebuildComponentLabels();
  assert.equal(records.length, before + 2, 'the next entry waits for its own pose');
  await view.frame();
  assert.equal(h.pendingRoomLabels, false);
  assert.equal(records.length, before + 4);
  assert.equal(records.at(-2).basis, 'head');
  assert.equal(h.componentLabels.refs().length, 2);
  await view.frame();
  assert.equal(records.length, before + 4, 'the next entry rebuilds only once');
  assert.deepEqual(errors, []);
});

test('a source swap invalidates a tracked basis already queued in the label session', async () => {
  const view = seatHarness(), { h, errors, nonEmptyBuilds } = view;
  h.beginRoomEntry(true);
  await view.frame();
  h.wearerPlacedInRoom = true;
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  const before = nonEmptyBuilds.length, emphasis = h.emphasisState;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  h.deletePlates = () => held;
  const edge = h.componentLabels.rebuild();
  const tracked = view.frame(true, Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0))));
  await Promise.resolve();
  assert.ok(h.requestedBasis, 'the first tracked basis has reached the session queue');
  h.adopt({ source: { sha256: 'new-source' }, structure: { ref: 'new-structure' }, selection: h.selection });
  assert.equal(h.pendingRoomLabels, false);
  assert.equal(h.pendingRoomLabelBasis, null);
  h.emphasisState = emphasis; // author the new source's lesson before the queue drains
  release();
  await Promise.all([edge, tracked]);
  const built = nonEmptyBuilds.slice(before);
  assert.ok(built.length, 'the queued work builds the new source');
  assert.ok(built.every(build => build.seatBasis === undefined), 'the session must also discard the old basis');
  assert.equal(h.componentLabels.refs().length, 2);
  assert.deepEqual(errors, []);
});

test('a failed re-entry basis capture retries on the next tracked frame', async () => {
  const view = seatHarness(), { h, records, errors } = view;
  h.beginRoomEntry(true);
  await view.frame();
  h.wearerPlacedInRoom = true;
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  await h.rebuildComponentLabels();
  const before = records.length, captureBasis = h.componentLabelViewBasis;
  let captures = 0;
  h.componentLabelViewBasis = () => {
    if (++captures === 1) throw Error('temporary basis capture failure');
    return captureBasis();
  };
  await view.frame();
  assert.equal(captures, 1, 'the first tracked frame attempts the capture');
  assert.equal(h.pendingRoomLabels, true, 'capture failure must not spend the rebuild');
  // The frame boundary records the capture failure and keeps drawing; nothing is built.
  assert.equal(records.length, before + 1, 'the failed capture is recorded, no plates are built');
  assert.equal(records.at(-1).kind, 'xr-frame-error');
  assert.equal(records.at(-1).phase, 'head-frame');
  await view.frame(true, Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0))));
  assert.equal(captures, 2);
  assert.equal(h.pendingRoomLabels, false);
  assert.equal(records.length, before + 3, 'the next tracked frame builds the deferred plates');
  assert.equal(records.at(-2).basis, 'head');
  assert.deepEqual(Array.from(h.lastLayoutInput.eye), [150, 0, 0]);
  assert.equal(h.componentLabels.refs().length, 2);
  await view.frame();
  assert.equal(captures, 2);
  assert.equal(records.length, before + 3, 'successful retry consumes the rebuild');
  assert.deepEqual(errors, []);
});

for (const pause of ['anchor', 'labels']) test(`entry cap basis survives a head turn during ${pause} work`, async () => {
  const view = seatHarness(), { h, records, errors } = view;
  h.beginRoomEntry(true);
  await view.frame(); // seed live labels so the next rebuild must delete them
  const expected = plain(records.at(-2));
  h.beginRoomEntry(false);
  h.beginRoomEntry(true);
  let release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const hold = () => { reached(); return held; };
  if (pause === 'anchor') h.roomAnchor.applied = hold;
  else h.deletePlates = hold;
  h.latestRoomPlacementPose = stereoPose(identity());
  const settled = h.settleInRoom({}, {});
  await entered;
  // A later XR frame replaces the live pose while the original seat is awaiting work.
  h.onHeadFrame({ frame: { getViewerPose: () => ({ transform: {
    matrix: Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0))),
  } }) }, space: { getOffsetReferenceSpace: () => ({}) }, mode: 'immersive-ar' });
  release();
  await settled;
  assert.deepEqual(errors, []);
  assert.deepEqual(plain(records.at(-2)), expected,
    'the same capped seat must produce the same plate geometry and layout evidence');
  assert.deepEqual(Array.from(h.lastLayoutInput.eye), [0, 0, 0], 'solver must use the cap frame');
  assert.equal(h.builtBasis, h.requestedBasis, 'serialized rebuild must preserve the basis object');
  assert.equal(h.lastLayoutInput.eye, h.capInput.eye, 'solver uses the cap’s exact eye array');
  assert.equal(h.lastLayoutInput.target, h.capInput.target, 'solver uses the cap’s exact target array');
  assert.equal(h.lastLayoutInput.up, h.capInput.up, 'solver uses the cap’s exact up array');
});

for (const firstSeat of [true, false]) test(`adoption during anchor work discards the entry cap basis (first seat ${firstSeat})`, async () => {
  const view = seatHarness(), { h, records, errors, nonEmptyBuilds } = view;
  h.beginRoomEntry(true);
  await view.frame();
  if (firstSeat) {
    h.beginRoomEntry(false);
    h.beginRoomEntry(true);
  }
  const beforeBuilds = nonEmptyBuilds.length, beforeRecords = records.length;
  const entry = h.roomEntry, emphasis = h.emphasisState;
  const submitted = [], rebuild = h.rebuildComponentLabels;
  h.rebuildComponentLabels = (...args) => { submitted.push(args[1]); return rebuild(...args); };
  let release, reached, oldBasis;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  h.roomAnchor.applied = () => held;
  const place = h.placeInspection, seat = h.roomAnchorPlacement;
  h.placeInspection = async patch => { await place(patch); reached(); };
  h.roomAnchorPlacement = input => {
    const placement = seat(input);
    oldBasis = placement.seatBasis;
    return placement;
  };
  h.latestRoomPlacementPose = stereoPose(identity());
  const settled = h.settleInRoom({}, {});
  await entered;
  h.adopt({ source: { sha256: 'new-source' }, structure: { ref: 'new-structure' }, selection: h.selection });
  assert.equal(h.roomEntry, entry, 'adoption does not end the room entry');
  h.emphasisState = emphasis; // author the new source's lesson plates
  h.canvas.camera.scale = .02; // the new source has different scene units
  h.latestRoomPlacementPose.headInRoom = Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(1.5, 0, 0)));
  const freshBasis = h.componentLabelViewBasis();
  h.componentLabelViewBasis = () => freshBasis;
  // The adoption path requests labels while the old settlement is still held.
  await h.rebuildComponentLabels();
  release();
  await settled;
  assert.deepEqual(errors, []);
  assert.ok(submitted.every(basis => basis !== oldBasis), 'never submit the old source basis after adoption');
  const built = nonEmptyBuilds.slice(beforeBuilds);
  assert.equal(built.length, 1, 'adoption and settlement produce exactly one new-source build');
  assert.ok(built.every(build => build.seatBasis !== oldBasis), 'never build with the old source basis');
  assert.equal(records.length, beforeRecords + 2, 'publish one new-source layout and build record');
  assert.equal(records.at(-2).kind, 'component-label-layout');
  assert.equal(records.at(-2).basis, 'head');
  assert.equal(h.lastLayoutInput.eye, freshBasis.eye, 'the new-source layout samples a fresh basis');
  assert.deepEqual(Array.from(h.lastLayoutInput.eye), [75, 0, 0]);
  assert.equal(h.componentLabels.refs().length, 2);
  assert.equal(h.pendingRoomSeat, false);
  await view.frame();
  assert.equal(nonEmptyBuilds.length, beforeBuilds + 1, 'later tracking cannot repeat the build');
});


test('a 3 px projected move at a 60 px glyph commits; skipped jitter cannot drift', async () => {
  const h = labelHarness();
  await h.session.rebuild();
  const before = h.commits.length;
  h.nudge(3 / 750);
  await h.session.relayout('reseat');
  assert.equal(h.commits.length, before + 1, 'the 3 px position must commit');
  assert.equal(h.cells.get('plate-0-backing').params.offsetX, 3 / 750);
  h.nudge(3.4 / 750);
  await h.session.relayout('grow');
  assert.equal(h.commits.length, before + 1, '0.4 px is head jitter');
  h.nudge(3.8 / 750);
  await h.session.relayout('grow');
  assert.equal(h.commits.length, before + 2, 'compare accumulated movement to the committed offset');
  assert.deepEqual(h.commits.at(-1).operations, Array(10).fill('update'));
});


test('XR sizing derives a conservative pixel gain from both eye viewports read in the frame', () => {
  const { h } = seatHarness();
  const views = syntheticViews();
  const sampled = [];
  // The frame callback reads each viewport while its frame is active; sizing
  // runs later and must not call getViewport, which WebKit refuses for a view
  // whose frame has ended (InvalidStateError on Vision Pro).
  h.latestRoomPlacementPose = { labelViews: views,
    labelViewports: views.map(view => ({ width: view.eye === 'left' ? 1200 : 1800, height: 1600 })) };
  h.canvas.webgl.xr.session.renderState = { baseLayer: { getViewport(view) {
    sampled.push(view.eye);
    throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
  } } };
  const sizing = h.xrLabelSizing();
  assert.deepEqual(sampled, []);
  assert.equal(sizing.pixelsPerRadian, views[1].projectionMatrix[0] * 900);
  const still = componentPaint.componentLabelStillUnits(4, sizing.pixelsPerRadian);
  assert.ok(Math.abs(still * sizing.pixelsPerRadian / 4 - 0.5) < 1e-12);
  assert.equal(componentPaint.componentLabelStillUnits(8, sizing.pixelsPerRadian), still * 2);
  assert.equal(componentPaint.componentLabelStillUnits(4, 0), 0, 'unknown projection compares exactly');
});

for (const action of ['collapse,reseat', 'emphasis']) test(`${action}: real session and solver move backed plates in one layout and one update`, async () => {
  const { h, session, cells, commits, records } = labelHarness();
  const parts = h.emphasisState.parts;
  parts.splice(2);
  parts[0].center = [-100, 0, -400];
  parts[1].center = [100, 0, -400];
  let menu = [[-102, -2, -400], [-98, 2, -400]];
  Object.assign(h, {
    componentLabelViewBasis: () => ({ eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], basis: 'head' }),
    immersiveSession: { menuRows: () => menu.length ? [menu] : [], menuPoints: () => menu,
      presentation: () => ({ roomMatrix: () => identity() }) },
    applyMatrix4,
  });
  vm.runInContext(pageFunction(viewer, 'componentLabelLayout'), h);
  if (action === 'emphasis') menu = [];
  await session.rebuild();
  const before = [...cells].filter(([ref]) => ref.endsWith('-backing')).map(([ref, cell]) => [ref, plain(cell.params)]);
  const beforeCells = new Map(cells);
  const count = commits.length;
  records.length = 0;
  if (action === 'emphasis') {
    // A focus placement changes the live loci and focus priority; these are
    // read afresh by the production update installed during the real build.
    parts[1].center = [...parts[0].center];
    parts[1].focused = true;
    h.currentEmphasisPlan = () => ({ explained: [parts[1]], transparency: .65 });
    h.componentLabelKeyPlan = () => ({ colours: parts.map(part => ({ id: part.id,
      opacity: part.focused ? 1 : .35 })) });
  } else menu = [];
  const callback = viewer.slice(viewer.indexOf('      onMenuPlaced: ({ reason }'), viewer.indexOf('      onPresented: async'));
  h.onMenuPlaced = vm.runInContext('({' + callback + '}).onMenuPlaced', h);
  h.onMenuPlaced({ reason: action === 'emphasis' ? 'placement' : action });
  while (session.busy()) await new Promise(resolve => setImmediate(resolve));
  const after = [...cells].filter(([ref]) => ref.endsWith('-backing')).map(([ref, cell]) => [ref, plain(cell.params)]);
  assert.notDeepEqual(after, before, 'the action really changed committed label placement');
  assert.deepEqual([...cells.keys()], [...beforeCells.keys()], 'the primitive topology stays fixed');
  for (const [ref, cell] of cells) assert.equal(cell, beforeCells.get(ref));
  assert.ok([...cells.keys()].every(ref => !ref.endsWith('-leader') && !ref.endsWith('-text')));
  assert.equal(records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(commits.length, count + 1, 'the complete offsets and opacity update commits together');
  assert.equal(session.passes(), 1, 'the session did not fall back to another build');
  if (action === 'emphasis') {
    assert.equal(cells.get('plate-0-backing').params.alpha, 0, 'dimmed XR context is absent');
    assert.equal(cells.get('plate-1-backing').params.alpha, 1, 'emphasized XR ink and backing keep full contrast');
  }
});

// A missing layer is a rejected update, never permission to solve again.
test('Menu press rejects an incomplete plate update without a second layout', async () => {
  const { h, session, cells, records } = labelHarness();
  Object.assign(h, {
    componentLabelViewBasis: () => ({ eye: [0, 0, 0], target: [0, 0, -1], basis: 'head' }),
    immersiveSession: {}, console: { error() {} },
  });
  vm.runInContext(pageFunction(viewer, 'componentLabelLayout'), h);
  const callback = viewer.slice(viewer.indexOf('      onMenuPlaced: ({ reason }'), viewer.indexOf('      onPresented: async'));
  h.onMenuPlaced = vm.runInContext('({' + callback + '}).onMenuPlaced', h);
  await session.rebuild();
  cells.delete('plate-9-backing');
  const previous = cells.get('plate-0-backing');
  records.length = 0;
  h.onMenuPlaced({ reason: 'collapse,reseat' });
  while (session.busy()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(records.find(r => r.kind === 'plate-update').degraded, true);
  assert.equal(cells.get('plate-0-backing'), previous);
});

for (const failure of ['throw', 'missing-view', 'missing-anchor']) test(`Menu ${failure} retains committed placements and records degradation`, async () => {
  const { h, session, cells, records } = labelHarness();
  Object.assign(h, {
    componentLabelViewBasis: () => ({ eye: [0, 0, 0], target: [0, 0, -1], basis: 'head' }),
    immersiveSession: {},
  });
  vm.runInContext(pageFunction(viewer, 'componentLabelLayout'), h);
  const callback = viewer.slice(viewer.indexOf('      onMenuPlaced: ({ reason }'), viewer.indexOf('      onPresented: async'));
  h.onMenuPlaced = vm.runInContext('({' + callback + '}).onMenuPlaced', h);
  for (const part of h.emphasisState.parts) part.center = [0, 0, -400];
  await session.rebuild();
  const previous = [...cells].filter(([id]) => id.endsWith('-backing')).map(([id, cell]) => [id, plain(cell.params)]);
  assert.ok(previous.some(([, p]) => p.offsetX || p.offsetY), 'the prior placement is not identity');
  if (failure === 'throw') h.layoutComponentPlates = () => { throw Error('solver fault'); };
  if (failure === 'missing-view') h.componentLabelViewBasis = () => undefined;
  if (failure === 'missing-anchor') h.componentLabelBounds = () => null;
  records.length = 0;
  h.onMenuPlaced({ reason: 'collapse,reseat' });
  while (session.busy()) await new Promise(resolve => setImmediate(resolve));
  for (const [id, params] of previous) assert.deepEqual(plain(cells.get(id).params), params);
  const result = records.filter(r => r.kind === 'component-label-layout');
  assert.equal(result.length, 1);
  assert.equal(result[0].degraded, true);
  assert.equal(result[0].unresolved, 10);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(records.find(r => r.kind === 'plate-update').geometry, false);
});

test('two menu requests arriving before the pending solve merge in the label owner', async () => {
  const { h, session, records } = labelHarness();
  Object.assign(h, {
    componentLabelViewBasis: () => ({ eye: [0, 0, 0], target: [0, 0, -1], basis: 'head' }),
    immersiveSession: {},
  });
  vm.runInContext(pageFunction(viewer, 'componentLabelLayout'), h);
  const callback = viewer.slice(viewer.indexOf('      onMenuPlaced: ({ reason }'), viewer.indexOf('      onPresented: async'));
  h.onMenuPlaced = vm.runInContext('({' + callback + '}).onMenuPlaced', h);
  await session.rebuild();
  records.length = 0;
  h.onMenuPlaced({ reason: 'collapse' });
  h.onMenuPlaced({ reason: 'reseat' });
  while (session.busy()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(records.find(r => r.kind === 'component-label-layout').reason, 'collapse+reseat');
});

import { createStructureSubjectReader, structureReadout } from './structure-subject.mjs';
import { availableChains, resolveVisibility, sameVisibility } from './inspection-visibility.mjs';
import { createInspectionState, normalizeAppearance, sameAppearance } from './inspection-state.mjs';
import { colorOnlyAppearanceChange } from './inspection-appearance.mjs';

// Use the shipped mutation gate, notification, menu action and subject reader.
// Only molecular painting and frame admission are adapters in this sandbox.
function captionMutationHarness() {
  const events = [], cells = new Map(), inspectionState = createInspectionState();
  const rows = ['A', 'B', 'C', 'D'].map(labelChain => ({ key: labelChain, coordinateState: 'resolved', entityType: 'polymer',
    identity: { labelChain, copyId: 'asu', modelNumber: 1 } }));
  rows.push({ key: 'heme', coordinateState: 'resolved', entityType: 'non-polymer', identity: { labelChain: 'E', copyId: 'asu', modelNumber: 1 } });
  let release, refused = false, replyInvalidations = 0;
  const h = vm.createContext({ clampPlacementScale, ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, console, readStructureSubject: createStructureSubjectReader(), normalizeVisibility, emptyVisibility,
    availableChains, resolveVisibility, sameVisibility, normalizeAppearance, sameAppearance, normalizeStyles, colorOnlyAppearanceChange, MOLECULAR_REPRESENTATIONS,
    VISIBILITY_LAYER_REF: { water: 'water-layer', ligand: 'ligand-layer' },
    paintedContextOpacity: value => value, volume: undefined, companionRecord: undefined, styleLayers: [], stylesState: [], retiredComparisons: new Set(),
    sourceRecord: { pdbId: '4HHB', sha256: 'old', title: 'Hemoglobin', catalog: { rows, assemblyId: 'asymmetric_unit' } },
    structure: { obj: { data: { model: { modelNum: 1 } } } }, representation: { ref: 'main' },
    visibilityState: emptyVisibility(), emphasisState: { parts: [], focus: [] }, inspectionState,
    state: { status: 'ready', selectionKeys: [], revision: 0, mutationCounts: { inspection: 0, representation: 0 } }, busy: false,
    inspectionSnapshot: () => inspectionState.snapshot(), syncInspectionPayload() {}, inspectionPayload: () => ({}),
    restoreCompanion: async () => {}, deleteRecord: async () => {},
    motionMutationPaused: false, motionToolPaused: false, syncPresentationMotion() {},
    assertReady() { assert.equal(h.state.status, 'ready'); }, assertContext() {}, interactionActive: () => false,
    now: () => 0, beginWork: () => ({ finish() {} }), retainCurrent: () => ({}), recordRenderCost() {},
    onMutation: () => events.push('receipt'), onSelection() {},
    connectionStatus: () => ({ state: 'linked' }),
    canvas: { xr: { isPresenting: { value: true } }, commit() { events.push('commit'); }, webgl: { isContextLost: false } },
    talkCaption: { invalidate() { replyInvalidations++; } },
    waitForFrame: () => new Promise((resolve, reject) => { release = () => {
      if (refused) reject(Error('render refused')); else { events.push('render'); resolve(); }
    }; }),
    snapshot: () => { events.push('snapshot'); return { ready: !h.busy && h.state.status === 'ready',
      modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [...h.state.selectionKeys],
      representation: h.painted.representation, color: h.painted.color }; },
    painted: { representation: 'cartoon', color: 'chain-id' },
    immersiveSession: { refreshToolbar() { events.push('plate'); return Promise.resolve(); } },
    appliedGeometryBudget: undefined, runSpatialAction: async (_action, run) => { events.push('queue'); return run(); },
    findCurrentStructureRepresentation: () => undefined, geometryFor() {}, inspectionLayersIntact: () => true,
    lessonResting: { labelsEnabled: () => false, setLabelsEnabled() {} },
    wearerPlacement: { holdsPlacement: () => false }, clearHeldPlatePlacement: placement => placement,
    applyInspectionAppearance: async () => { h.painted = { ...inspectionState.snapshot().appearance }; },
    applyInspectionColorTheme: async () => { h.painted = { ...inspectionState.snapshot().appearance }; },
    paintVisibilityLayers: async () => {}, markSelection() {}, rebuildInspectionLabels: async () => {}, rebuildComponentLabels: async () => {},
    selection: { rows, toLoci: keys => keys },
    StructureElement: { Bundle: { fromLoci: loci => loci } },
    StateTransforms: { Representation: { TransparencyStructureRepresentation3DFromBundle: 'transparency' } },
    removeLigandOverlay: async () => {},
    plugin: { state: { data: { cells } }, representation: { structure: { registry: { get: () => ({ isApplicable: () => true }) } } },
      build: () => ({ to() { return this; }, apply(_transform, _params, { ref }) { this.ref = ref; return this; },
        delete(ref) { this.removed = ref; return this; }, async commit() { if (this.removed) cells.delete(this.removed); else cells.set(this.ref, { obj: {} }); } }) },
  });
  const start = viewer.indexOf('  let renderedStructureSubject,');
  vm.runInContext(viewer.slice(start, viewer.indexOf('\n  let sourceRecord', start)), h);
  for (const name of ['emit', 'mutate', 'inspectionMutation', 'visibilityChains', 'setSceneVisibility', 'visibilityGroupOf', 'setGroupVisible', 'configureInspection'])
    vm.runInContext(pageFunction(viewer, name), h);
  h.onSpatialAction = vm.runInContext(viewerCallback(viewer, 'onSpatialAction'), h);
  h.readSubject = vm.runInContext('spatialSubject', h);
  h.refreshStructureSubject(h.snapshot()); events.length = 0;
  return { h, events, replyInvalidations: () => replyInvalidations, async settle(pending, verify) {
    for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function', 'the mutation reached its render gate');
    assert.ok(!events.includes('plate'), 'no early caption refresh');
    verify?.(); release(); release = undefined; await pending;
    const render = events.indexOf('render'), snapshot = events.indexOf('snapshot'), plate = events.indexOf('plate');
    assert.ok(render >= 0 && snapshot > render && plate > snapshot, events.join(' → '));
    assert.ok(events.indexOf('receipt') > plate, 'the observer receives its rendered receipt after subject publication');
    events.length = 0;
  }, refuse() { refused = true; release(); release = undefined; } };
}

test('remote visibility and menu appearance use render → snapshot → plate; pending state never leaks', async () => {
  const t = captionMutationHarness(), { h } = t;
  await t.settle(h.setSceneVisibility({ hiddenChains: [{ labelChain: 'A', copyId: 'asu' }] }),
    () => assert.equal(h.readSubject().shownChains, undefined));
  assert.equal(t.replyInvalidations(), 1, 'a committed scene change retries a blocked reply');
  assert.equal(h.readSubject().shownChains, 3);
  assert.deepEqual(plain(h.readSubject().hiddenChains), ['A']);
  await t.settle(h.onSpatialAction({ kind: 'appearance', preset: 'ball-and-stick' }),
    () => assert.equal(h.readSubject().representation, 'cartoon'));
  assert.equal(t.replyInvalidations(), 2, 'appearance commits invalidate without waiting for label measurement');
  assert.equal(h.readSubject().representation, 'ball-and-stick');
  await t.settle(h.onSpatialAction({ kind: 'appearance', preset: 'element-symbol' }));
  assert.equal(h.readSubject().color, 'element-symbol');
  await t.settle(h.onSpatialAction({ kind: 'visibility', group: 'ligand', visible: false }));
  assert.match(structureReadout(h.readSubject()).map(row => row.text).join(' / '), /A, ligands hidden/u);
  await t.settle(h.onSpatialAction({ kind: 'visibility', group: 'ligand', visible: true }));
  assert.equal(h.readSubject().hiddenClasses, undefined);
});

test('selection, focus and source receipts refresh the committed caption; refused renders retain it', async () => {
  const t = captionMutationHarness(), { h, events } = t;
  await t.settle(h.mutate('inspection', () => { h.state.selectionKeys = ['B', 'C']; }));
  assert.equal(h.readSubject().selectionCount, 2);
  await t.settle(h.mutate('representation', () => { h.emphasisState = { parts: [{ id: 'beta', label: 'beta' }], focus: ['beta'], contextOpacity: .2 }; }));
  assert.deepEqual(plain(h.readSubject().focus), ['beta']);
  await t.settle(h.mutate('representation', () => {
    h.sourceRecord = { ...h.sourceRecord, pdbId: '1CRN', sha256: 'new', title: 'Crambin' };
    h.visibilityState = emptyVisibility(); h.state.selectionKeys = []; h.emphasisState = { parts: [], focus: [] };
  }), () => assert.equal(h.readSubject().pdbId, '4HHB'));
  assert.equal(h.readSubject().pdbId, '1CRN');
  assert.equal(h.readSubject().selectionCount, 0);
  const before = plain(h.readSubject());
  const pending = h.setSceneVisibility({ hiddenClasses: ['polymer'] });
  const rejection = assert.rejects(pending, /render refused/u);
  await new Promise(resolve => setImmediate(resolve));
  t.refuse(); await rejection;
  assert.deepEqual(plain(h.readSubject()), before);
  assert.ok(!events.includes('plate') && !events.includes('receipt'));
});

test('a menu press cancels a pending fit before joining its action chain', async () => {
  const t = menuHarness(tourFocusHarness());
  let release, called = 0;
  t.menu.actionChain = new Promise(resolve => { release = resolve; });
  t.menu.onActionIntent = () => { called++; release(); };
  t.menu.run({ kind: 'readout-page', delta: 1 });
  assert.equal(called, 1, 'press admission runs while the preceding action is pending');
  await t.menu.actionChain;
});
