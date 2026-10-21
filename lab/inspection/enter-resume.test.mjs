import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from '../../plugin/node_modules/typescript/lib/typescript.js';
import { installSpatialMenuHook } from '../browser-roundtrip/spatial-menu-hook.mjs';
import { demoSourceIdentity } from '../browser-roundtrip/demo-source-identity.mjs';
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE } from '../browser-roundtrip/placement-limits.mjs';

// Execute the workspace refresh/queue and the inspector's XR binding together.
// DOM and renderer adapters replace the browser; no timer repairs the controls.
const root = new URL('../../', import.meta.url);
function closure(path, name) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true);
  let found;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `Missing production function ${name}`);
  return ts.transpileModule(found.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const workspacePath = 'lab/inspection/workspace.mjs';
const functions = closure(workspacePath, 'sceneHistory') + closure(workspacePath, 'syncSceneHistory')
  + closure(workspacePath, 'sync') + closure(workspacePath, 'run')
  + closure('plugin/src/inspector.ts', 'syncXr');

function page() {
  const element = (dataset = {}) => ({ dataset, disabled: false, hidden: false, style: {},
    selectedOptions: [{ textContent: 'Chain identity' }],
    matches: () => ['enterXr', 'resumeXr', 'leaveXr'].some(key => key in dataset) });
  const enterButtons = ['immersive-ar', 'immersive-vr'].map(enterXr => element({ enterXr }));
  const leave = element({ leaveXr: '' }), resumeButton = element({ resumeXr: '' }), sceneButton = element();
  const controls = [...enterButtons, leave, resumeButton, sceneButton];
  const nodes = new Map();
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const snapshot = { ready: true, xrPresenting: false, generation: 0, selectionKeys: [], inspection: {
    appearance: { color: 'chain-id', labels: false }, placement: { scale: 1, translation: [0, 0, 0], rotation: [0, 0, 0] },
    history: { undoCount: 1, redoCount: 0 }, savedViews: [],
  } };
  const startup = { reloadRequired: false, pendingEntry: null };
  const capabilities = { ar: true, vr: true };
  const viewer = { snapshot: () => snapshot, xr: { startup: () => startup, capabilities: async () => capabilities } };
  const h = vm.createContext({ viewer, workspace: { snapshot: () => snapshot, viewer }, $, $$: selector => selector === '#app button, #app input, #app select' ? controls : [],
    PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, demoSourceIdentity,
    queue: Promise.resolve(), busy: false, closing: false, options: {}, fixture: null, moleculeCanvas: element(),
    selectedRows: () => [], hostDriven: () => false, lastGeneration: 0, lastSavedSignature: '{"tab":[]}',
    syncSearchAction() {}, syncWalkthrough() {}, syncMotion() {}, syncRenderQuality() {}, setStatus() {},
    xrSyncSequence: 0, generation: 1, closed: false, arSupported: true, xrPending: false, xrProblem: '',
    xrEntryAttempt: undefined, entryWatchdog: undefined, clearTimeout,
    reentryArmed: false, disarmReentry() {}, updateVoiceUi() {}, recording: element(),
    hudSignature: '', hudWaitingSince: 0, resumeMode: null, resume: element(), resumeNote: element(),
    resumeButton, enterButtons, leave, entryActions: element(), note: element(),
    xrReentryEntryView: () => ({ single: false }),
  });
  vm.runInContext(functions, h);
  return { h, snapshot, startup, capabilities, enterButtons, leave, sceneButton };
}

for (const action of ['journey Done', 'reconnect']) {
  test(`${action} refresh keeps Enter VR disabled for the live session`, async () => {
    const { h, snapshot, enterButtons, sceneButton } = page();
    await h.syncXr();
    assert.ok(enterButtons.every(button => !button.disabled));
    snapshot.xrPresenting = true;
    await h.syncXr();
    assert.ok(enterButtons.every(button => button.disabled));
    // Done restores via the serialized queue. Hydration also refreshes the
    // host view library without ending the session or waiting for an XR tick.
    if (action === 'journey Done') await h.run('Restoring your view…', async () => h.sync());
    else h.sync();
    assert.equal(snapshot.xrPresenting, true);
    assert.ok(enterButtons.every(button => button.disabled), `${action} re-enabled Enter VR`);
    assert.equal(sceneButton.disabled, false, 'Scene edits remain available');
    snapshot.xrPresenting = false;
    await h.syncXr();
    assert.ok(enterButtons.every(button => !button.disabled), 'Session end offers entry again');
  });
}

test('an in-flight Done restore preserves Leave headset view while scene controls wait', async () => {
  const { h, snapshot, enterButtons, leave, sceneButton } = page();
  snapshot.xrPresenting = true;
  await h.syncXr();
  await h.run('Restoring your view…', async () => {
    assert.equal(leave.disabled, false, 'The session owner keeps Leave available');
    assert.equal(sceneButton.disabled, true);
    assert.ok(enterButtons.every(button => button.disabled));
  });
});

for (const reason of ['reload required', 'unsupported modes']) {
  test(`workspace refresh preserves the XR ${reason} restriction after session end`, async () => {
    const { h, startup, capabilities, enterButtons } = page();
    if (reason === 'reload required') startup.reloadRequired = true;
    else capabilities.ar = capabilities.vr = false;
    await h.syncXr();
    h.sync();
    assert.ok(enterButtons.every(button => button.disabled));
  });
}

test('the viewer menu hook reads current XR startup even without toolbar rows', t => {
  const source = readFileSync(new URL('../browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const install = source.match(/detachSpatialMenuHook = installSpatialMenuHook\(\{[\s\S]*?\n    \}\);/)[0];
  let startup = { presenting: true, sessionVisibility: 'visible', phase: 'active', frameCount: 123 };
  const immersiveSession = { startup: () => startup, toolbarRows: () => [],
    toolbarAction: () => assert.fail('Observation must not press anything') };
  const h = vm.createContext({ immersiveSession, installSpatialMenuHook, detachSpatialMenuHook: null });
  vm.runInContext(install, h);
  t.after(() => h.detachSpatialMenuHook());
  const hook = globalThis.__stereofoldMenu;
  assert.deepEqual(hook.xrStartup(), { presenting: true, sessionVisibility: 'visible', phase: 'active' });
  startup = { presenting: true, sessionVisibility: 'hidden', phase: 'active' };
  assert.equal(hook.xrStartup().sessionVisibility, 'hidden');
  startup = { presenting: false, sessionVisibility: null, phase: 'idle' };
  assert.equal(hook.xrStartup().presenting, false);
});
