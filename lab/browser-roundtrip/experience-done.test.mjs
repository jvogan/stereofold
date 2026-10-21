import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { normalizeStyles } from './inspection-styles.mjs';
import { emptyVisibility, normalizeVisibility } from './inspection-visibility.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import { demoSourceIdentity } from './demo-source-identity.mjs';
import { viewerCallback } from './fixtures/viewer-callback.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { transpileModule, ScriptTarget, ModuleKind } = require('typescript');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const viewerSource = read('./viewer.mjs'), workspaceSource = read('../inspection/workspace.mjs');
const inspectorSource = read('../../plugin/src/inspector.ts');
const playerSource = read('../../plugin/src/experience-player.ts');
const initializationSource = read('../../plugin/src/lesson-source-initialization.ts');
const initializationJs = transpileModule(initializationSource.replace(/^import .*;\n/gm, '').replaceAll('export ', ''),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;
const runtime = await toolbarFrameRuntime();
const exactRestoreDeclaration = inspectorSource.match(/^    const restoreExactScene=.*;$/m)?.[0];
assert.ok(exactRestoreDeclaration, 'use the production exact-restore decision');
test('only pending completion or explicit rollback selects exact hydration restoration', () => {
  for (const [completion, options, expected] of [[undefined, {}, false], [{ status: 'rendered' }, {}, false],
    [{ status: 'pending' }, {}, true], [undefined, { restoreExactScene: true }, true]]) {
    assert.equal(vm.runInNewContext(`${exactRestoreDeclaration}\nrestoreExactScene`, { completion, options }), expected);
  }
});
const plain = value => JSON.parse(JSON.stringify(value));
const fn = (source, name, indent = '  ') => {
  const start = source.indexOf(`${indent}async function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  return source.slice(start, source.indexOf(`\n${indent}}`, start) + indent.length + 2);
};
function element() {
  const children = new Map();
  return { dataset: {}, after() {}, remove() {}, setAttribute() {}, addEventListener() {}, replaceChildren() {}, append() {},
    querySelectorAll: () => [], querySelector(name) { if (!children.has(name)) children.set(name, element()); return children.get(name); } };
}

// Execute the shipped Done action, player, hydrate load call, workspace queue,
// and viewer restore. Only the Mol* draw and host receipt are held adapters.
for (const stepIndex of [0, 19]) for (const fails of [false, true]) {
  test(`Done restores appearance, selection and placement after rendering (scene ${stepIndex + 1}, failure ${fails})`, async () => {
    const events = [];
    const saved = { sourceSha256: 'original', modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: ['A:7'],
      camera: { position: [5, 0, 7] }, inspection: { appearance: { representation: 'cartoon', color: 'chain-id' },
        styles: [{ selectionKeys: ['A:7'], color: 'uniform', uniformColor: '#ff8800' },
          { selectionKeys: ['A:8'], representation: 'ball-and-stick' }],
        placement: { translation: [2, 1, 0], rotation: [10, 40, 0], scale: 1.4 } } };
    const last = { ...structuredClone(saved), selectionKeys: [], inspection: { appearance: { representation: 'molecular-surface', color: 'uniform' },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 2 } } };
    let live = structuredClone(last), release, entered;
    const frame = new Promise(resolve => { release = resolve; });
    const drawing = new Promise(resolve => { entered = resolve; });
    const context = vm.createContext({ ...emptyLessonFigureBinding(), setTimeout, clearTimeout, Error, structuredClone,
      gesturePivot:createGesturePivot(),focusPivotRequest:undefined,xrPlacementFollowup:undefined,talkCaption:undefined,
      document: { createElement: element, createTextNode: value => value, body: { dataset: {} }, addEventListener() {}, removeEventListener() {} },
      wearerPages: () => ['Chapter'],
      normalizeStyles, normalizeVisibility, visibilityState: emptyVisibility(), stylesState: [],
      assertReady() {}, validInspectionCapture: value => ({ ...value, keys: value.selectionKeys }),
      wearerPlacement: { holdsPlacement: () => true, state: () => ({}) }, recordManipulation() {},
      inspectionSnapshot: () => ({ placement: live.inspection.placement }), lessonMotionHold: { release() {} },
      inspectionMutation: async action => {
        const before = structuredClone(live);
        try { await action(); events.push('rendered'); } catch (error) { live = before; throw error; }
      },
      syncInspectionPayload() {}, inspectionPayload: () => ({ selectionKeys: live.selectionKeys, camera: live.camera }),
      restoreCompanion: async () => {},
      inspectionState: { replace: value => { live.inspection = value; }, setPayload() {} },
      markSelection: keys => { live.selectionKeys = keys; },
      applyInspectionAppearance: async () => { entered(); await frame; if (fails) throw Error('Restore draw failed'); },
      applyInspectionTransform() {}, fitDesktopPreview: () => assert.fail('Done must preserve the saved preview'),
      canvas: { camera: { setState: () => assert.fail('Done must never set the tracked XR camera') } },
      run: async (_label, action) => { events.push('queue'); return action(); },
      fixture: undefined, searchValue: '', chainValue: '', anchor: undefined, loadedView: undefined, walkthrough: undefined, demoSourceIdentity,
      $: element, currentRows: () => [], options: { enableXr: true }, renderSequence() {},
      spatialTour: undefined, connectionStatus: () => ({ state: 'linked' }),
    });
    for (const name of ['cancelXrPlacementFollowup','invalidateGesturePivot']) vm.runInContext(pageFunction(viewerSource,name),context);
    vm.runInContext(fn(viewerSource, 'restoreInspection'), context);
    context.viewer = { snapshot: () => ({ ready: true, xrPresenting: true }),
      load: async (_next, options) => { assert.equal(options.preserveRoomPlacement, true); events.push('load'); },
      inspection: { restore: context.restoreInspection, capture: () => structuredClone(live) } };
    vm.runInContext(fn(workspaceSource, 'loadSource', ''), context);
    context.workspace = { loadSource: context.loadSource, snapshot: context.viewer.snapshot };
    const playerJs = transpileModule(playerSource.replace(/^import .*;\n/gm, '').replaceAll('export ', ''),
      { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;
    vm.runInContext(playerJs, context);
    const definition = { id: 'journey', stages: [], steps: Array.from({ length: 20 }, () => ({ title: 'Chapter', body: 'Chapter' })) };
    context.data = { structureText: 'fixture', scene: saved }; context.restoredScene = saved;
    context.catalog = { modelNumbers: [1], assemblyId: 'asymmetric_unit' }; context.loadSettings = {};
    context.loadedSha256 = 'original'; context.density = context.visible = context.stage = undefined;
    // This fixture restores ordinary atomic coordinates, with no custom
    // lesson or map-reference-only caption on the hydration path.
    context.panelCustomTour = undefined; context.densityReferencePreview = false;
    vm.runInContext(initializationJs, context);
    context.heading = {}; // the panel's file-named heading, read on the line before the load
    context.completion = { status: 'pending' };
    context.sourceReplacement = false; // Done restores a journey; it is not an agent's swap.
    const loadStart = inspectorSource.indexOf('          await workspace.loadSource({id:');
    const loadEnd = inspectorSource.indexOf('\n', inspectorSource.indexOf('restorePlacement:restoreExactScene', loadStart));
    assert.ok(loadStart >= 0 && loadEnd > loadStart, 'use the inspector hydration call and its real restore options');
    const hydrateLoad = `${exactRestoreDeclaration}\n${inspectorSource.slice(loadStart, loadEnd)}`;
    const player = context.mountExperiencePlayer({ after: element(), navigate: async () => {}, explore() {},
      onFeedback: message => events.push(message),
      finish: async () => {
        await vm.runInContext(`(async()=>{${hydrateLoad}})()`, context);
        events.push('saved', 'acknowledged');
        return { status: 'rendered' };
      } });
    player.update({ definition, revision: 1, stepIndex, stageId: 'stage', sourceKey: 'chapter' });
    context.spatialTour = player;
    const action = vm.runInContext(viewerCallback(viewerSource, 'onSpatialAction'), context);
    const done = action({ kind: 'tour-done' });
    await drawing;
    assert.equal(player.getState().active, true);
    assert.deepEqual(runtime.tourReadout(player.getState(), {}), [{ text: 'Restoring your view…' }]);
    assert.deepEqual(events, ['queue', 'load']);
    release();
    if (fails) {
      await assert.rejects(done, /Restore draw failed/);
      assert.deepEqual(plain(live), last);
      assert.equal(player.getState().active, true);
      assert.ok(!events.includes('acknowledged'));
      assert.ok(!events.includes('Back to your view'));
    } else {
      await done;
      assert.deepEqual(plain(live.inspection), saved.inspection);
      assert.deepEqual(plain(context.stylesState), saved.inspection.styles);
      assert.deepEqual(plain(live.selectionKeys), saved.selectionKeys);
      assert.deepEqual(events, ['queue', 'load', 'rendered', 'saved', 'acknowledged', 'Back to your view']);
      assert.equal(player.getState().active, false);
      assert.equal(runtime.tourReadout(player.getState(), {})[0].text, 'Back to your view');
    }
    player.dispose();
  });
}
