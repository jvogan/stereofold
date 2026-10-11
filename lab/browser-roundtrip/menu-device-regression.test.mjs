import { createSelectionBoundsCache } from './selection-bounds.mjs';
import assert from 'node:assert/strict';
import { PLACEMENT_MIN_SCALE, clampPlacementScale, clampPlacementTranslation } from './placement-limits.mjs';
import { updatePlacementBounds } from './placement-bounds.mjs';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spatialVoiceAction } from './voice-command-runner.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { createComponentLabelSession } from './component-labels.mjs';
import { recordLoopStage } from './loop-timing.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import * as labelFacing from './label-facing.mjs';
import * as componentLabels from './component-labels.mjs';
import { normalizePlacement } from './inspection-state.mjs';
import { pivotPreservingTranslation } from './presentation-pivot.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
import { renderedLabelQuads, renderedSubjectSpheres } from './component-label-measurement.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { menuSeatReceipt } from './menu-seat-receipt.mjs';

const toolbar = readFileSync(new URL('./spatial-toolbar.mjs', import.meta.url), 'utf8');
test('the initial compact controls expand on the first Menu press', () => {
  let collapsed = /collapsed = (true|false), mode/.exec(toolbar)?.[1] === 'true';
  assert.equal(collapsed, true);
  const counts = [];
  for (const expected of [false, true]) {
    const rows = spatialToolbarRows({ collapsed, voice: { state: 'idle' } });
    counts.push(rows.length);
    collapsed = rows.find(row => row.id === 'menu').action.value;
    assert.equal(collapsed, expected);
  }
  assert.ok(counts[0] < counts[1]);
});

test('same-pose Move cannot be swallowed by the toolbar content cache', () => {
  const guard = toolbar.match(/if \(representation &&[^\n]+contentSignature === renderedContent[^\n]+/)[0];
  assert.match(guard, /!menuReseatRequested/);
});

// The Quest 2 defect the receipt exists for. Both
// `aim:move` and `menu:move` re-seated the menu and reported "the outcome never
// arrived" after 12.4 s, because the only record of a re-seat was written by the
// component-label solver and that scene had no name plates
test('a committed re-seat writes a receipt of its own, labels or no labels', () => {
  const receipt = menuSeatReceipt({ motion: ['reseat'], reason: 'menu', seat: '100,-200,300,1800' });
  assert.equal(receipt.phase, 'seat-commit');
  assert.equal(receipt.reseated, true);
  assert.equal(receipt.reason, 'menu');
  assert.equal(receipt.motion, 'reseat');
  assert.equal(receipt.seat, '100,-200,300,1800');
  assert.equal(receipt.hidden, false);
});

test('a fold and a re-seat in one draw name both causes and still read as a re-seat', () => {
  const receipt = menuSeatReceipt({ motion: ['collapse', 'reseat'], reason: 'menu', seat: null });
  assert.equal(receipt.motion, 'collapse,reseat');
  assert.equal(receipt.reseated, true);
  assert.equal(receipt.seat, null);
});

test('a first draw is a seat but not a re-seat, and a followed scene is neither', () => {
  assert.equal(menuSeatReceipt({ motion: ['seat'], reason: 'entry' }).reseated, false);
  assert.equal(menuSeatReceipt({ motion: ['follow'] }), undefined);
  assert.equal(menuSeatReceipt({ motion: ['grow'], reason: 'menu' }), undefined);
  assert.equal(menuSeatReceipt({}), undefined);
});

test('a re-seat committed behind a grab is recorded, and says it was hidden', () => {
  const receipt = menuSeatReceipt({ motion: ['reseat'], reason: 'menu', hidden: true });
  assert.equal(receipt.reseated, true);
  assert.equal(receipt.hidden, true);
});

test('the toolbar commit writes that receipt from the motion it just committed', () => {
  assert.match(toolbar, /import \{ menuSeatReceipt \} from '\.\/menu-seat-receipt\.mjs';/);
  const commit = toolbar.match(/const seatCommit = menuSeatReceipt\([^\n]+\n[^\n]+/)[0];
  assert.match(commit, /motion: committedMotion/);
  assert.match(commit, /reason: seatReason/);
  assert.match(commit, /seat: seatSignature/);
  assert.match(commit, /record\?\.\('toolbar', seatCommit\)/);
  // The reasons are taken before the hidden branch empties them.
  assert.ok(toolbar.indexOf('const committedMotion = [...lastMenuMotion];') < toolbar.indexOf('if (hidden) {'));
});

test('collapsing re-solves all ten live plates without deleting their cells', async () => {
  const live = new Set();
  let solves = 0;
  const labels = createComponentLabelSession({
    isPresenting: () => true, wantsLabels: () => true,
    buildPlates: async () => { for (let i = 0; i < 10; i++) live.add(`plate-${i}`); return [...live]; },
    deletePlates: async refs => { for (const ref of refs) live.delete(ref); },
    updatePlates: async (refs, reason) => {
      assert.equal(reason, 'collapse,reseat');
      assert.equal(live.size, 10);
      assert.deepEqual(refs, [...live]);
      solves++;
      return true;
    },
  });
  await labels.rebuild();
  await labels.relayout('collapse,reseat');
  assert.equal(solves, 1);
  assert.equal(live.size, 10);
  assert.equal(labels.refs().length, 10);
  assert.equal(labels.passes(), 1);
});

test('spoken records include exact word count even without command IDs', () => {
  const entries = [];
  const scope = { __stereofoldDiagnostics: { record: (kind, detail) => entries.push({ kind, detail }) } };
  recordLoopStage('spoken-confirmation-started', { text: '  Here is TCAB1.  ' }, scope);
  assert.deepEqual(entries, [{ kind: 'voice-loop', detail: {
    stage: 'spoken-confirmation-started', spokenText: 'Here is TCAB1.', spokenWords: 3,
  } }]);
  recordLoopStage('action-posted', { text: 'Never a spoken line.' }, scope);
  assert.equal(entries.length, 1);
  const long = Array.from({ length: 60 }, () => 'component').join(' ');
  recordLoopStage('spoken-confirmation-started', { text: long, commandId: 'cmd-1' }, scope);
  assert.equal(entries[1].detail.spokenWords, 60);
  assert.equal(entries[1].detail.spokenText.length, 200);
});


test('reply audio reports the bounded spoken sentence, not the longer caption', () => {
  const entries = [];
  recordLoopStage('spoken-confirmation-started', { text: 'Here is TCAB1. The caption explains much more.',
    speechText: 'Here is TCAB1.' }, { __stereofoldDiagnostics: { record: (kind, detail) => entries.push(detail) } });
  assert.equal(entries[0].spokenText, 'Here is TCAB1.');
  assert.equal(entries[0].spokenWords, 3);
});

test('a menu solve queued behind a molecular rebuild keeps the newest ten cells', async () => {
  let release, builds = 0, updates = 0;
  const labels = createComponentLabelSession({
    isPresenting: () => true, wantsLabels: () => true, deletePlates: async () => {},
    buildPlates: async () => { builds++; await new Promise(resolve => { release = resolve; });
      return Array.from({ length: 10 }, (_, i) => `new-${i}`); },
    updatePlates: async refs => { assert.equal(refs.length, 10); assert.equal(refs[0], 'new-0'); updates++; },
  });
  const build = labels.rebuild();
  const update = labels.relayout('collapse,reseat');
  release();
  await Promise.all([build, update]);
  assert.equal(builds, 1);
  assert.equal(updates, 1);
});

test('the viewer menu update commits offsets for ten existing plates atomically', async () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = viewer.indexOf('    updateMenuLabelPlates = async');
  const end = viewer.indexOf('\n    const detail', start);
  assert.ok(start > 0 && end > start, 'the viewer has a menu-only update path');
  const refs = Array.from({ length: 10 }, (_, i) => `plate-${i}`);
  const cells = new Map(refs.flatMap(ref => ['backing'].map(layer =>
    [`${ref}-${layer}`, { sizeFactor: 1, offsetX: 0, offsetY: 0, alpha: 1, attachment: 'middle-center' }])));
  const originalCells = [...cells.values()];
  let commits = 0, invalidations = 0, transforms = 0;
  const plugin = { state: { data: { cells } }, build() {
    const pending = [];
    return { to(ref) { return { update(fn) { pending.push([ref, fn]); } }; },
      async commit() {
        assert.equal(cells.size, 10);
        for (const [ref, update] of pending) Object.assign(cells.get(ref), update(cells.get(ref)));
        commits++;
      } };
  } };
  const solve = () => new Map(refs.map((ref, i) => [ref, {
    offsetX: i + 1, offsetY: -i, sizeScale: 1, alpha: 1, lines: [ref],
    leader: { attachment: 'top-center', tetherLength: i + 1 },
  }]));
  const update = new Function('createSelectionBoundsCache', 'plugin', 'created', 'drawable', 'sizing', 'plan', 'subject', 'presenting',
    'componentLabelLayout', 'componentLabelPaint', 'contextAlpha', 'applyInspectionTransform', 'labelMeasurementGate',
    'inspectionSnapshot', 'presentationTransform', 'xrLabelSizing', 'LABEL_CHARACTER_DEGREES', 'StructureElement',
    'Vec3', 'loadedSphere', 'componentLabelOffsetZ', 'COMPONENT_LABEL_BASE_OFFSET_Z',
    'stageComponentLabelLayers', 'componentLabelStillUnits', 'committedLayer', 'recordCost',
    'currentEmphasisPlan', 'componentLabelPlateParts', 'componentLabelKeyPlan', 'colorNumber', 'emphasisState', 'Color',
    'sourceRecord', 'state', 'componentLabels',
    'let updateMenuLabelPlates, menuResolveReason; const labelSource=sourceRecord,labelGeneration=state.generation; const componentLabelBounds = createSelectionBoundsCache(StructureElement.Loci.getBoundingSphere);\n' + viewer.slice(start, end) + '\nreturn updateMenuLabelPlates;')(
    createSelectionBoundsCache, plugin, refs, refs.map(id => ({ id, text: id, loci: {} })), { sizeFactor: 1, characterUnits: 0.8 }, {}, {}, true, solve,
    () => ({ backing: { alpha: 1 } }), new Map(),
    live => { assert.deepEqual(live, refs); transforms++; }, { invalidate() { invalidations++; } },
    () => ({ placement: { scale: 1 } }), () => Mat4.identity(), () => ({ sizeFactor: 1, characterUnits: 0.8 }),
    labelFacing.LABEL_CHARACTER_DEGREES, { Loci: { getBoundingSphere: () => null } }, Vec3, () => null,
    labelFacing.componentLabelOffsetZ, labelFacing.COMPONENT_LABEL_BASE_OFFSET_Z,
    componentLabels.stageComponentLabelLayers, componentLabels.componentLabelStillUnits, cell => cells.get(cell), () => {},
    () => ({}), () => refs.map(id => ({ id })), () => ({ colours: [] }), () => 0xffffff, { parts: [] }, value => value,
    { sha256: 'fixture' }, { generation: 1 }, { refs: () => [...refs] });
  await update(refs, 'collapse,reseat');
  assert.equal(commits, 1);
  assert.equal(invalidations, 1);
  assert.equal(transforms, 1);
  [...cells.values()].forEach((cell, i) => assert.equal(cell, originalCells[i], 'render cell identity is retained'));
  for (let i = 0; i < 10; i++) {
    for (const layer of ['backing']) {
      assert.equal(cells.get(`${refs[i]}-${layer}`).offsetX, i + 1);
      assert.equal(cells.get(`${refs[i]}-${layer}`).offsetY, -i || 0);
      assert.equal(cells.get(`${refs[i]}-${layer}`).alpha, 1);
    }
    assert.equal(cells.has(`${refs[i]}-leader`), false);
  }
});

// Execute the viewer's build, placement action and relayout together. The
// adapter commits label uniforms and representation transforms to render-value
// cells; the independent drawn-geometry reader then observes those cells.
function placedMenuHarness({ leaders = true } = {}) {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const extract = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `viewer section: ${start}`);
    return source.slice(from, to);
  };
  const sphere = { center: [3, -2, -80], radius: 5 };
  const parts = Array.from({ length: 10 }, (_, i) => ({ id: `part-${i}`, label: `Part ${i}`,
    keys: [i], color: '#ffffff', center: [i - 1, i % 3 - 2, -80 + i / 2], radius: 0.25 + i / 10 }));
  let placement = { scale: 1.7, translation: [0.4, -0.3, 0.2], rotation: [0, 0, 90] };
  let requiredLeader = leaders, commits = 0, updateCommits = 0, deletes = 0, placementGate;
  const cells = new Map(), solves = [], clearanceChecks = [];
  const values = entries => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, ValueCell.create(value)]));
  const subjectObject = { state: { visible: true }, values: values({
    drawCount: 6, alpha: 1, boundingSphere: sphere, matrix: Mat4.identity(),
    invariantBoundingSphere: sphere, aTransform: Mat4.identity(), instanceCount: 1,
  }) };
  const representation = object => ({ renderObjects: [object], setState({ transform }) {
    for (const key of ['matrix', 'aTransform']) {
      if (object.values[key]) object.values[key].ref.value = Array.from(transform);
    }
  } });
  const subjectRepr = representation(subjectObject);
  function labelCell(params, loci) {
    const object = { state: { visible: true }, values: values({
      aPosition: Array.from({ length: 4 }, () => loci.center).flat(),
      aMapping: [-2, -0.4, 2, -0.4, 2, 0.4, -2, 0.4], aTexCoord: Array(8).fill(10),
      aDepth: [0, 0, 0, 0], aTransform: Mat4.identity(), elements: [0, 1, 2, 0, 2, 3],
      drawCount: 6, instanceCount: 1, dSizeType: 'uniform', uSize: 1,
      invariantBoundingSphere: { center: loci.center, radius: 1 }, boundingSphere: { center: loci.center, radius: 1 },
      uSizeFactor: params.sizeFactor, uOffsetX: params.offsetX, uOffsetY: params.offsetY,
      uOffsetZ: params.offsetZ, alpha: params.alpha,
    }) };
    return { params, get transform() { return { params: this.params }; }, obj: { data: { repr: representation(object) } } };
  }
  const plugin = { state: { data: { cells } }, build() {
    const pending = []; let loci, updating = false;
    const builder = {
      toRoot: () => builder,
      apply(type, params, { ref }) {
        if (type === 'selection') {
          loci = params.selections[0].bundle;
          pending.push(() => cells.set(ref, { loci }));
        } else {
          const selected = loci;
          pending.push(() => cells.set(ref, labelCell(params, selected)));
        }
        return builder;
      },
      to(ref) { loci = cells.get(ref)?.loci; return {
        apply(...args) { updating = true; return builder.apply(...args); },
        update(fn) {
        updating = true;
        pending.push(() => {
          const cell = cells.get(ref);
          cell.params = fn(cell.params);
          for (const [param, uniform] of Object.entries({ sizeFactor: 'uSizeFactor', offsetX: 'uOffsetX',
            offsetY: 'uOffsetY', offsetZ: 'uOffsetZ', alpha: 'alpha' })) {
            cell.obj.data.repr.renderObjects[0].values[uniform].ref.value = cell.params[param];
          }
        });
      } }; },
      async commit() { pending.forEach(apply => apply()); commits++; if (updating) updateCommits++; },
    };
    return builder;
  } };
  const deps = {
    ...labelFacing, ...componentLabels, Vec3, Mat4, normalizePlacement, plugin, updatePlacementBounds,
    clampPlacementScale, clampPlacementTranslation, pivotPreservingTranslation,
    pendingRoomSeat: false, pendingRoomLabels: false, componentLabelLayoutCache: null, componentLabelBuildSignature: null,
    componentLabelPartsSignature: () => JSON.stringify(parts.map(part => [part.id, part.label, part.keys])),
    COMPONENT_LABEL_LIMIT: 10, COMPONENT_LABEL_REF: 'plate',
    DESKTOP_LABEL_SIZE_FACTOR: 1, emphasisState: { parts }, structure: { ref: 'structure' },
    sourceRecord: { sha256: 'fixture' }, state: { generation: 1 }, visibleStage: undefined,
    gesturePivot: createGesturePivot(), focusPivotRequest: undefined, xrPlacementFollowup: undefined, talkCaption: undefined,
    currentEmphasisPlan: () => ({}), componentLabelPlateParts: () => parts,
    componentLabelKeyPlan: () => ({ colours: [] }), componentLabelsWanted: () => true,
    inspectionSnapshot: () => ({ placement, appearance: { highlightColor: '#ffffff' } }),
    inspectionState: { placement: () => structuredClone(placement), place(patch) { placement = { ...placement, ...patch }; } },
    inspectionMutation: async fn => { await fn(); await placementGate; }, assertReady() {}, syncInspectionPayload() {},
    selection: { toLoci: ([i]) => parts[i] },
    componentLabelBounds: createSelectionBoundsCache(loci => loci),
    StructureElement: { Loci: { isEmpty: () => false, getBoundingSphere: loci => loci },
      Bundle: { fromLoci: loci => loci } },
    StateTransforms: { Model: { MultiStructureSelectionFromBundle: 'selection' },
      Representation: { StructureSelectionsLabel3D: 'label' } },
    Color: value => value, colorNumber: () => 0xffffff,
    loadedSphere: () => sphere, pivotCenter: () => sphere.center, representation: { obj: {} },
    scientificRepresentations: () => [subjectRepr],
    lessonFigure: { snapshot: () => null, annotations: () => [] },
    canvas: { camera: { scale: 0.02 }, xr: { isPresenting: { value: true } }, update() {} },
    latestSeatStandoffMeters: 1.5, latestRoomPlacementPose: null,
    clearHeldPlatePlacement: (requested, options) => {
      clearanceChecks.push({ requested: structuredClone(requested), options });
      return requested;
    },
    runSpatialAction: async (_action, run) => run(), takeWearerPlacement() {},
    motionAngle: 0, grabOffset: null, grabTransform: () => undefined,
    componentLabelLayout(drawable, sizing, plan, subject, _reason, _seatBasis, standoff) {
      const layout = new Map(drawable.map((entry, i) => [entry.id, {
        // Aim for known positions, independently of the molecular placement.
        offsetX: 12 + i - entry.anchor[0], offsetY: 8 - entry.anchor[1],
        sizeScale: 0.9, alpha: 1, lines: [entry.text, 'copy'],
        leader: requiredLeader ? { attachment: 'top-center', tetherLength: i + 1 } : null,
      }]));
      solves.push({ drawable: structuredClone(drawable), sizing, subject, layout, standoff });
      return layout;
    },
    labelMeasurementGate: { invalidate() {} }, recordCost() {},
    // The extracted spatial callback object also registers this callback;
    // these placement/label cases never dispatch session visibility changes.
    handleXrInputVisibility() {},
  };
  const code = [
    extract('  function cancelXrPlacementFollowup()', '\n  // The saved pose'),
    extract('  function placementTransform(', '\n  async function placeRoomTarget('),
    extract('  function pivotBounds()', '\n  function presentationTransform()'),
    extract('  function presentationTransform()', '\n  /**'),
    extract('  function applyInspectionTransform(', '\n  async function rebuildInspectionLabels('),
    extract('  function xrLabelSizing(', '\n  /** The name plates, as live'),
    extract('  function componentLabelRepresentations(', '\n  /** Take every name plate'),
    extract('  async function buildComponentLabelPlates(', '\n  // Called by the presenting session'),
    extract('  async function placeInspection(', '\n  async function fitInspection('),
  ].join('\n');
  const viewer = new Function(...Object.keys(deps), `
    let updateMenuLabelPlates, menuResolveReason, componentLabelMeasurement, componentLabels, companionRecord;
    ${code}
    const spatial = { ${extract('      onMenuPlaced: ({ reason } = {}) => {', '      onPresented:')}
      ${extract('      onSpatialAction: async action => {', '      onHeadFrame:')} };
    return { buildComponentLabelPlates, placeInspection, onSpatialAction: spatial.onSpatialAction,
      onMenuPlaced: spatial.onMenuPlaced,
      update: (...args) => updateMenuLabelPlates(...args),
      setOwner: owner => { componentLabels = owner; } };
  `)(...Object.values(deps));
  const labels = createComponentLabelSession({ isPresenting: () => true, wantsLabels: () => true,
    buildPlates: viewer.buildComponentLabelPlates, updatePlates: viewer.update,
    deletePlates: async refs => {
      deletes++;
      for (const key of cells.keys()) if (refs.some(ref => key === ref || key.startsWith(`${ref}-`))) cells.delete(key);
    } });
  viewer.setOwner(labels);
  return { labels, viewer, cells, solves, parts, sphere, subjectObject, clearanceChecks,
    placement: () => placement, requireLeader: value => { requiredLeader = value; },
    holdPlacement() { let release; placementGate = new Promise(resolve => { release = resolve; }); return release; },
    counts: () => ({ commits, updateCommits, deletes }) };
}

for (const [action, patch] of [
  ['scale', { scale: 2.6 }],
  ['translate', { translation: [-0.8, 0.7, -0.5] }],
]) test(`menu relayout after ${action} uses current molecular geometry and sizing`, async () => {
  const h = placedMenuHarness();
  await h.labels.rebuild();
  const initial = h.solves[0], refs = h.labels.refs(), cells = [...h.cells.values()];
  await h.viewer.placeInspection(patch, action);
  assert.equal(h.solves.length, 2, 'placement immediately re-solves the existing plates');
  await h.labels.relayout('collapse,reseat');
  assert.equal(h.solves.length, 3);
  assert.deepEqual(h.solves[2], h.solves[1], 'a later menu pass sees the same current geometry');
  assert.equal(h.labels.passes(), 1, 'the existing plates were updated in place');
  assert.deepEqual(h.labels.refs(), refs);
  [...h.cells.values()].forEach((cell, i) => assert.equal(cell, cells[i]));
  const current = h.solves[1], placement = h.placement(), cameraScale = 0.02;
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  const closePoint = (actual, expected) => actual.forEach((value, i) => close(value, expected[i]));
  // Independent 90-degree Z rotation about a nonzero molecular centre.
  const expectedCenter = h.sphere.center.map((value, i) => value + placement.translation[i] * h.sphere.radius);
  closePoint(current.subject.anchor, expectedCenter);
  close(current.subject.radius, h.sphere.radius * placement.scale);
  assert.notDeepEqual(current.subject, initial.subject);
  assert.equal(current.sizing.placementScale, placement.scale);
  // Match the live viewer: invariant bounds + aTransform avoid applying the
  // placement twice once the render object's culling sphere is corrected.
  const drawnSubjects = renderedSubjectSpheres(h.subjectObject, cameraScale);
  assert.equal(drawnSubjects.length, 1);
  const [drawnSubject] = drawnSubjects;
  closePoint(drawnSubject.center, current.subject.anchor.map(value => value * cameraScale));
  close(drawnSubject.radius, current.subject.radius * cameraScale);
  const view = syntheticViews()[0];
  for (const [i, part] of h.parts.entries()) {
    const expected = [
      expectedCenter[0] - (part.center[1] - h.sphere.center[1]) * placement.scale,
      expectedCenter[1] + (part.center[0] - h.sphere.center[0]) * placement.scale,
      expectedCenter[2] + (part.center[2] - h.sphere.center[2]) * placement.scale,
    ];
    closePoint(current.drawable[i].anchor, expected);
    close(current.drawable[i].radius, part.radius * placement.scale);
    assert.notDeepEqual(current.drawable[i].anchor, initial.drawable[i].anchor);
    const em = current.sizing.characterUnits * 0.9;
    for (let line = 0; line < 2; line++) for (const layer of ['backing']) {
      const cell = h.cells.get(`${refs[i]}-${line}-${layer}`);
      const [quad] = renderedLabelQuads(cell.obj.data.repr.renderObjects[0], view, cameraScale);
      closePoint(quad.anchor, expected.map(value => value * cameraScale));
      close(quad.em, em * cameraScale);
      const center = [0, 1, 2].map(axis => quad.corners.reduce((sum, corner) => sum + corner[axis], 0) / 4);
      const paint = componentLabels.componentLabelPaint({ offsetZ: labelFacing.componentLabelOffsetZ(placement.scale) });
      // Text.vert pushes the centre toward the eye by the
      // layer's offsetZ (less the backing's z-fighting bias) before it adds
      // the offsets, so the drawn quad sits on that pushed centre.
      const eye = view.transform.matrix.slice(12, 15), p = view.projectionMatrix;
      const relative = expected.map((value, axis) => value * cameraScale - eye[axis]);
      let push = paint[layer].offsetZ * cameraScale;
      // This harness tags every quad as a background plane, so the bias
      // applies to both layers here, as it would to any backed quad.
      if (cell.obj.data.repr.renderObjects[0].values.aTexCoord.ref.value[0] === 10) {
        const clip = [p[0] * relative[0] + p[8] * relative[2], p[5] * relative[1] + p[9] * relative[2], p[10] * relative[2] + p[14]];
        push -= 0.001 * Math.hypot(...eye.map((value, axis) => value - clip[axis]));
      }
      const ratio = 1 - push / Math.hypot(...relative);
      const wanted = [eye[0] + relative[0] * ratio + (12 + i - expected[0]) * cameraScale,
        eye[1] + relative[1] * ratio + (8 - expected[1] + (line - 0.5) * em) * cameraScale,
        eye[2] + relative[2] * ratio];
      wanted.forEach((value, axis) => assert.ok(Math.abs(center[axis] - value) < 1e-9,
        `${layer} line ${line} axis ${axis}: ${center[axis]} != ${value}`));
      close(cell.params.offsetZ, paint[layer].offsetZ);
      assert.equal(h.cells.has(`${refs[i]}-leader`), false);
      assert.equal(h.cells.has(`${refs[i]}-${line}-text`), false, 'each line has one glyph primitive');
    }
  }
  assert.equal(h.counts().updateCommits, 1, 'the placement committed once; the identical menu pass committed nothing');
});

test('a menu relayout keeps one untethered primitive per line without rebuilding', async () => {
  const h = placedMenuHarness({ leaders: false });
  await h.labels.rebuild();
  const originalCells = [...h.cells.values()];
  h.requireLeader(true);
  await h.labels.relayout('expand,reseat');
  assert.equal(h.counts().updateCommits, 0, 'a leader-only layout change needs no GPU update');
  assert.equal(h.counts().deletes, 0);
  assert.equal(h.labels.passes(), 1);
  assert.equal(h.solves.length, 2);
  assert.deepEqual([...h.cells.values()], originalCells);
  assert.ok(h.labels.refs().every(ref => !h.cells.has(`${ref}-leader`)));
  assert.equal([...h.cells.keys()].filter(ref => ref.endsWith('-backing')).length, h.parts.length * 2);
  assert.equal([...h.cells.keys()].filter(ref => ref.endsWith('-text')).length, 0);
});


test('production smaller/bigger action relayouts once after placement and commits changed plates', async () => {
  const h = placedMenuHarness();
  await h.labels.rebuild();
  let layouts = h.solves.length, updates = h.counts().updateCommits;
  for (const direction of [-1, 1]) {
    const placementBefore = structuredClone(h.placement());
    const object = h.cells.get('plate-0-0-backing').obj.data.repr.renderObjects[0];
    const view = syntheticViews()[0];
    const before = renderedLabelQuads(object, view, 0.02)[0];
    const release = h.holdPlacement();
    const applying = h.viewer.onSpatialAction(spatialVoiceAction(direction < 0 ? 'make it smaller' : 'make it bigger').action);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.solves.length, layouts, 'no solve before rendered placement settles');
    const during = renderedLabelQuads(object, view, 0.02)[0];
    assert.notDeepEqual(during.anchor, before.anchor, 'aTransform already moved the anchor');
    assert.equal(during.em, before.em, 'billboard glyphs do not inherit molecular scale');
    release();
    await applying;
    assert.deepEqual(h.clearanceChecks.at(-1).options,
      { keepWearer: true, allowOffscreen: true, kind: 'wearer-placement' },
      'the actual placement function checks scale as wearer-owned placement');
    assert.deepEqual(h.placement().translation, placementBefore.translation);
    assert.deepEqual(h.placement().rotation, placementBefore.rotation);
    assert.equal(h.solves.length, ++layouts, 'one solve per discrete voice/menu motion');
    assert.equal(h.counts().updateCommits, ++updates, 'one plate update commit');
    assert.equal(h.solves.at(-1).sizing.placementScale, h.placement().scale);
    assert.notEqual(renderedLabelQuads(object, view, 0.02)[0].em, before.em,
      'the settled relayout applies the new scale-aware glyph size');
  }
  // A clamped action changes neither placement nor plates.
  await h.viewer.placeInspection({ scale: PLACEMENT_MIN_SCALE });
  layouts = h.solves.length; updates = h.counts().updateCommits;
  await h.viewer.onSpatialAction({ kind: 'scale', direction: -1 });
  assert.equal(h.solves.length, layouts);
  assert.equal(h.counts().updateCommits, updates);
});


test('a held "make it smaller" solves once with the stand-off; a menu collapse solves once', async () => {
  const h = placedMenuHarness();
  await h.labels.rebuild();
  const layouts = h.solves.length, updates = h.counts().updateCommits;
  // The production voice/menu route, with the placement mutation held open
  // the way the renderer holds it. focus-frame re-solves after a placement
  // and tour-stall-2 re-solves after a settled scale: between them, ONE.
  const release = h.holdPlacement();
  const applying = h.viewer.onSpatialAction(spatialVoiceAction('make it smaller').action);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.solves.length, layouts, 'no solve while the placement is held');
  release();
  await applying;
  assert.deepEqual(h.clearanceChecks.at(-1).options,
    { keepWearer: true, allowOffscreen: true, kind: 'wearer-placement' });
  assert.equal(h.solves.length, layouts + 1, 'one layout for one settled placement');
  assert.equal(h.counts().updateCommits, updates + 1, 'one plate-update commit');
  const solve = h.solves.at(-1);
  assert.equal(solve.sizing.placementScale, h.placement().scale, 'solved at the new scale');
  assert.ok(solve.standoff > 0);
  assert.equal(solve.standoff,
    labelFacing.componentLabelOffsetZ(h.placement().scale, labelFacing.COMPONENT_LABEL_BASE_OFFSET_Z),
    'the settled relayout carries the stand-off the plates are painted with');
  // A real menu collapse arrives through the presenting session's settled
  // motion callback, which names the press and asks the owner once.
  h.viewer.onMenuPlaced({ reason: 'collapse,reseat' });
  for (let turn = 0; turn < 50 && h.labels.busy(); turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.labels.busy(), false, 'the owner drained the collapse');
  assert.equal(h.solves.length, layouts + 2, 'a menu collapse is one layout');
  assert.equal(h.solves.at(-1).standoff, solve.standoff, 'the menu pass keeps the stand-off');
  assert.equal(h.labels.passes(), 1, 'both passes updated the existing plates in place');
});
