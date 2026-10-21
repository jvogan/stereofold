import { emptyMolecularAnimationBinding } from './fixtures/empty-lesson-figure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { createLessonKeyMemory, normalizeEmphasisState } from './lesson-emphasis.mjs';
import { createLessonResting } from './lesson-resting.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const oldEmphasis = normalizeEmphasisState({ parts: [{ id: 'old', label: 'Old lesson', chain: 'A', color: '#25859b' }] });

// Execute the production callers, retained snapshots and mutation admission.
// The draw adapter injects loss after admission; no GPU rendering is claimed.
function harness() {
  const noop = () => {};
  const c = vm.createContext({ ...emptyMolecularAnimationBinding(), lessonSelection: undefined, structuredClone, Error, console,
    detached: clone, assertReady: noop, assertContext: noop, interactionActive: () => false,
    state: { status: 'ready', revision: 0, mutationCounts: { representation: 0, inspection: 0 }, selectionKeys: [], lastPick: null },
    structure: { obj: { data: {} } }, volume: null, representation: {}, sourceRecord: {}, dataRoot: 'root',
    companionRecord: null, appliedGeometryBudget: null, visibilityState: {}, stylesState: [], styleLayers: [],
    visibleStage: null, volumeTriangles: 0, volumeIsoExtent: null, volumePaint: null,
    normalizeVisibility: value => value, normalizeStyles: value => value, liveScene: () => ({}),
    selection: { rows: [] }, spokenSelectionKeys: [], normalizeEmphasisState,
    planLessonEmphasis: () => ({ colours: [], faded: [], lit: [], unresolved: [], transparency: 0 }),
    paintedContextOpacity: value => value, recordEmphasisResolution: noop,
    DEFAULT_CONTEXT_OPACITY: .1, componentLabels: {}, lessonPlayback: { lessonId: 'old' }, lastLessonChapterKey: 'old-chapter',
    emphasisState: clone(oldEmphasis), emphasisOrigin: 'lesson', lessonKey: createLessonKeyMemory(),
    lessonFigure: { definition: () => undefined, install: async () => {} },
    now: () => 0, busy: false, activeWork: undefined, pendingContextLoss: undefined, motionMutationPaused: false, motionToolPaused: false,
    syncPresentationMotion: noop, recordRenderCost: noop,
    canvas: { xr: { isPresenting: { value: false } }, webgl: { isContextLost: false }, commit: noop,
      camera: { setState: noop } },
    retainedPoseHidden: false, waitForFrame: async () => {}, onMutation: noop,
    snapshot: () => ({}), emit: () => { c.observedOrigin = c.emphasisOrigin; },
    rebuildComponentLabels: async () => {}, findCurrentStructureRepresentation: () => undefined,
    plugin: { representation: { structure: { registry: { get: () => ({ isApplicable: () => true }) } } } },
    normalizeAppearance: (patch, current) => ({ ...current, ...patch }), sameAppearance: () => false,
    colorOnlyAppearanceChange: () => false, inspectionLayersIntact: () => true,
    syncInspectionPayload: noop, applyInspectionTransform: noop, invalidateGesturePivot: noop,
    recordManipulation: noop, restoreCompanion: async () => {}, lessonMotionHold: { release: noop },
    wearerPlacement: { holdsPlacement: () => false }, selectedKeys: value => value,
    markSelection: noop, fitDesktopPreview: noop, inspectionPayload: () => ({}), desktopPreviewCamera: undefined,
  });
  c.lessonResting = createLessonResting({ emphasize: async () => {}, snapshot: () => ({}), rebuildLabels: async () => {},
    getEmphasis: () => c.emphasisState, getOrigin: () => c.emphasisOrigin });
  c.lessonResting.restoreCheckpoint({ resting: { emphasis: oldEmphasis, componentLabels: true }, labels: false });
  c.inspectionState = { configure: () => {}, replace: () => {}, setPayload: () => {} };
  c.inspectionSnapshot = () => ({ appearance: { representation: 'cartoon', color: 'uniform' }, placement: {} });
  for (const name of ['retainCurrent', 'restoreRetainedLessonState', 'beginWork', 'mutate', 'emphasize', 'configureInspection', 'restoreInspection'])
    vm.runInContext(pageFunction(source, name), c);
  const lose = () => {
    c.recoveryRecord = c.activeWork.previous;
    c.canvas.webgl.isContextLost = true;
    throw Error('Injected context loss');
  };
  c.paintEmphasisLayers = async () => lose(); c.paintVisibilityLayers = async () => {};
  c.applyInspectionAppearance = async () => lose();
  c.inspectionMutation = async (operation, options) => {
    try { return await c.mutate('inspection', operation, options); }
    catch (error) { await options?.rollback?.(); throw error; }
  };
  c.validInspectionCapture = value => value;
  return c;
}

test('a failed command cannot relabel the retained lesson key during context recovery', async () => {
  const c = harness();
  await assert.rejects(c.emphasize({ parts: [{ id: 'new', label: 'New command', chain: 'B', color: '#60b4c1' }], origin: 'command' }), /Injected context loss/);
  assert.equal(c.emphasisOrigin, 'lesson');
  c.restoreRetainedLessonState(c.recoveryRecord.lesson);
  assert.equal(c.emphasisOrigin, 'lesson');
  assert.deepEqual(c.emphasisState, oldEmphasis);
});

test('a failed appearance cannot restore its rejected provisional lesson labels', async () => {
  const c = harness();
  await assert.rejects(c.configureInspection({ color: 'chain-id', componentLabels: true }), /Injected context loss/);
  assert.equal(c.lessonResting.labelsEnabled(), false);
  c.restoreRetainedLessonState(c.recoveryRecord.lesson);
  assert.equal(c.lessonResting.labelsEnabled(), false);
  assert.equal(c.lessonResting.state().componentLabels, true, 'baseline intent remains independent of the live labels flag');
});

test('a failed saved-scene restore keeps the prior emphasis, ownership and labels in recovery', async () => {
  const c = harness();
  const restoredEmphasis = normalizeEmphasisState({ parts: [{ id: 'saved', label: 'Saved scene', chain: 'B', color: '#60b4c1' }] });
  c.lessonResting.restoreCheckpoint({ resting: { emphasis: restoredEmphasis, componentLabels: true }, labels: false });
  await assert.rejects(c.restoreInspection({ keys: [], camera: {}, inspection: {
    emphasis: { ...restoredEmphasis, origin: 'resting' }, visibility: {}, styles: [], placement: {},
  } }), /Injected context loss/);
  c.restoreRetainedLessonState(c.recoveryRecord.lesson);
  assert.deepEqual(c.emphasisState, oldEmphasis);
  assert.equal(c.emphasisOrigin, 'lesson');
  assert.equal(c.lessonResting.labelsEnabled(), false);
});

test('a successful command still publishes its new ownership while retaining prior recovery intent', async () => {
  const c = harness();
  let retained;
  const beginWork = c.beginWork;
  c.beginWork = previous => { retained = previous; return beginWork(previous); };
  c.paintEmphasisLayers = async () => {}; c.lessonKey.remember = () => {};
  await c.emphasize({ parts: [], origin: 'command' });
  assert.equal(c.observedOrigin, 'command');
  assert.equal(c.emphasisOrigin, 'command');
  assert.equal(retained.lesson.origin, 'lesson');
});

test('an idle retained snapshot continues to preserve all committed lesson metadata', () => {
  const c = harness(), retained = c.retainCurrent();
  c.emphasisOrigin = 'command'; c.lessonPlayback = undefined; c.lessonResting.setLabelsEnabled(true);
  c.restoreRetainedLessonState(retained.lesson);
  assert.equal(c.emphasisOrigin, 'lesson');
  assert.deepEqual(c.lessonPlayback, { lessonId: 'old' });
  assert.equal(c.lessonResting.labelsEnabled(), false);
});
