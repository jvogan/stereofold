import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel } from './spatial-toolbar-geometry.mjs';

// Production toolbar events and geometry, with only the GPU/text boundary
// replaced. Transient pinch cases simulate WebXR; they are not device evidence.
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));
const molecularState = history => ({ voice: { state: 'idle' },
  appearance: { representation: 'cartoon' }, history });

function sourceAt(point, input) {
  const matrix = [...identity];
  for (let axis = 0; axis < 3; axis++) matrix[8 + axis] = -(point[axis] - [0, 1.6, 0][axis]);
  return { targetRayMode: input === 'pinch' ? 'transient-pointer' : 'tracked-pointer',
    handedness: input === 'pinch' ? 'none' : input,
    targetRaySpace: { pose: { emulatedPosition: false,
      transform: { matrix, position: { x: 0, y: 1.6, z: 0 } } } } };
}

async function menu(input, history = { canUndo: true, canRedo: true }) {
  const actions = [], ownership = [];
  const t = toolbarFrameHarness(runtime, { state: molecularState(history),
    onAction: action => actions.push(action), onConsumeSelect: event => ownership.push(event),
    presentation: { setRoomOffset() {} } });
  await t.toolbar.update();
  let viewerReads = 0;
  const eventFrame = { getPose: t.frame.getPose,
    getViewerPose() { viewerReads++; throw new DOMException('Input event frame', 'InvalidStateError'); } };
  const emit = (type, source) => t.session.dispatchEvent(Object.assign(new Event(type, { cancelable: true }),
    { inputSource: source, frame: eventFrame }));
  const change = (added, removed) => {
    t.session.inputSources = [...t.session.inputSources.filter(source => !removed.includes(source)), ...added];
    t.session.dispatchEvent(Object.assign(new Event('inputsourceschange'), { added, removed }));
  };
  const panel = () => createToolbarPanel({ rows: t.toolbar.rows(), head: t.toolbar.head(), constants: t.toolbar.layout(),
    seatAnchor: t.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth });
  return { ...t, actions, ownership, panel, viewerReads: () => viewerReads,
    aim(kind) {
      const button = panel().buttons.find(row => row.action.kind === kind);
      assert.ok(button, `the menu contains ${kind}`);
      return sourceAt(button.point, input);
    },
    start(source) { change([source], []); emit('selectstart', source); },
    end(source) {
      emit('select', source); emit('selectend', source);
      if (input === 'pinch') change([], [source]);
    },
    async click(kind) {
      const source = this.aim(kind); this.start(source); this.end(source);
      await tick(); await t.toolbar.update();
      return source;
    },
  };
}

for (const input of ['left', 'right', 'pinch']) {
  for (const loss of ['ray', 'head']) test(`${input} active menu drag continues from its drawn offset after ${loss} tracking recovery`, async () => {
    const t = await menu(input);
    try {
      const before = [...t.toolbar.seatAnchor()], source = t.aim('appearance-cycle');
      const pose = source.targetRaySpace.pose, getViewerPose = t.frame.getViewerPose;
      t.start(source);
      pose.transform.position.x = -.08; t.toolbar.syncInput(t.frame);
      if (loss === 'ray') source.targetRaySpace.pose = undefined;
      else t.frame.getViewerPose = () => null;
      t.toolbar.syncInput(t.frame);
      pose.transform.position.x = -.28;
      source.targetRaySpace.pose = pose; t.frame.getViewerPose = getViewerPose;
      t.toolbar.syncInput(t.frame);
      pose.transform.position.x = -.30; t.toolbar.syncInput(t.frame);
      t.end(source); await tick();
      assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .10) < 1e-9,
        'recovery ignores the unseen jump and resumes from the last drawn offset');
      assert.deepEqual(t.actions, [], 'tracking recovery cannot also change molecular style');
      await t.click('appearance-cycle');
      assert.deepEqual(t.actions, [{ kind: 'appearance-cycle' }]);
    } finally { await t.toolbar.dispose(); }
  });

  for (const loss of ['ray', 'head']) for (const recovery of [false, true]) test(`${input} interrupted style press cannot click after ${loss} ${recovery ? 'tracking recovery' : 'tracking loss at release'}`, async () => {
    const t = await menu(input);
    try {
      const before = [...t.toolbar.seatAnchor()], source = t.aim('appearance-cycle');
      const pose = source.targetRaySpace.pose, getViewerPose = t.frame.getViewerPose;
      t.start(source);
      if (loss === 'ray') source.targetRaySpace.pose = undefined;
      else t.frame.getViewerPose = () => null;
      t.toolbar.syncInput(t.frame);
      if (recovery) {
        source.targetRaySpace.pose = pose; t.frame.getViewerPose = getViewerPose;
        t.toolbar.syncInput(t.frame);
      }
      t.end(source); await tick();
      assert.deepEqual(t.actions, [], 'an unobserved gesture must not become a molecular edit');
      assert.deepEqual(t.toolbar.seatAnchor(), before);
      assert.ok(t.ownership.some(event => event.phase === 'cancel'));
      t.frame.getViewerPose = getViewerPose;
      await t.click('appearance-cycle');
      assert.deepEqual(t.actions, [{ kind: 'appearance-cycle' }], 'a fresh tracked press still works');
    } finally { await t.toolbar.dispose(); }
  });

  test(`${input} style click dispatches once, while style drag only moves the menu`, async () => {
    const t = await menu(input);
    try {
      const before = [...t.toolbar.seatAnchor()];
      const clickSource = await t.click('appearance-cycle');
      assert.deepEqual(t.actions, [{ kind: 'appearance-cycle' }]);
      assert.deepEqual(t.toolbar.seatAnchor(), before);
      const dragSource = t.aim('appearance-cycle');
      t.start(dragSource);
      dragSource.targetRaySpace.pose.transform.position.x -= .1;
      t.toolbar.syncInput(t.frame);
      t.end(dragSource); await tick();
      assert.deepEqual(t.actions, [{ kind: 'appearance-cycle' }], 'drag cannot also change molecular style');
      assert.ok(Math.abs(t.toolbar.seatAnchor()[0] - before[0] + .1) < 1e-9);
      assert.equal(t.toolbar.isCollapsed(), true);
      const nextClickSource = await t.click('appearance-cycle');
      assert.deepEqual(t.actions, [{ kind: 'appearance-cycle' }, { kind: 'appearance-cycle' }]);
      assert.equal(t.viewerReads(), 0, 'input event frames only read source poses');
      if (input === 'pinch') {
        assert.notEqual(clickSource, dragSource);
        assert.notEqual(dragSource, nextClickSource);
        assert.deepEqual(t.session.inputSources, []);
      }
    } finally { await t.toolbar.dispose(); }
  });

  test(`${input} unavailable Undo and Redo reject clicks and become usable after state refresh`, async () => {
    const t = await menu(input, { canUndo: false, canRedo: false, undoCount: 2, redoCount: 3 });
    try {
      await t.click('collapse');
      assert.equal(t.toolbar.isCollapsed(), false);
      for (const kind of ['undo', 'redo']) {
        assert.equal(t.panel().buttons.find(row => row.action.kind === kind).targetable, false);
        await t.click(kind);
      }
      assert.deepEqual(t.actions, [], 'disabled history availability overrides nonzero counts');
      t.setState(molecularState({ canUndo: true, canRedo: true }));
      await t.toolbar.update();
      for (const kind of ['undo', 'redo']) {
        assert.equal(t.panel().buttons.find(row => row.action.kind === kind).targetable, true);
        await t.click(kind);
      }
      assert.deepEqual(t.actions, [{ kind: 'undo' }, { kind: 'redo' }]);
      assert.equal(t.viewerReads(), 0);
    } finally { await t.toolbar.dispose(); }
  });
}
