import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

const runtime = await toolbarFrameRuntime();

test('an active gallery exposes the live Room toggle through Menu while retaining four quiet rows', async () => {
  const state = { passthrough: true, passthroughSupported: true, voice: { state: 'idle' },
    tour: { selectedId: 'gallery', active: true, step: 0, total: 17, autoplay: false,
      title: 'Complex 1', canNext: true, canBack: false } };
  const actions = [];
  const h = toolbarFrameHarness(runtime, { state, onAction: async action => {
    actions.push(action);
    if (action.kind === 'passthrough') state.passthrough = action.on;
  } });
  const press = async id => {
    assert.equal(h.toolbar.aimSynthetic({ id }).fired, true, `the drawn ${id} row accepts the ray`);
    await h.toolbar.runAction({ kind: 'notice' });
  };
  try {
    await h.toolbar.update();
    assert.deepEqual(h.toolbar.rows().map(row => row.label), ['Talk', 'Play', 'Next', 'Menu']);
    await press('menu');
    assert.equal(h.toolbar.rows().find(row => row.id === 'room')?.label, 'Room on');
    await press('room');
    assert.deepEqual(actions.at(-1), { kind: 'passthrough', on: false });
    assert.equal(h.toolbar.rows().find(row => row.id === 'room')?.label, 'Room off');
    await press('room');
    assert.deepEqual(actions.at(-1), { kind: 'passthrough', on: true });
    assert.equal(h.toolbar.rows().find(row => row.id === 'room')?.label, 'Room on');
    await press('menu');
    assert.deepEqual(h.toolbar.rows().map(row => row.label), ['Talk', 'Play', 'Next', 'Menu']);
  } finally { await h.toolbar.dispose(); }
});

for (const active of [true, false]) test(`an explicit Menu press keeps full controls available despite unavailable molecular clearance: lesson=${active}`, async () => {
  let obstructed = false, checks = 0;
  const state = step => ({ voice: { state: 'idle' },
    tour: { selectedId: 'gallery', active, step: active ? step : -1, total: 17, autoplay: false,
      title: `Complex ${step + 1}`, canNext: active, canBack: step > 0 } });
  const h = toolbarFrameHarness(runtime, { state: state(0), beforeMenuDraw: async () => {
    checks++; return obstructed ? { obstructed: true } : undefined;
  } });
  try {
    await h.toolbar.update();
    obstructed = true;
    assert.equal(h.toolbar.aimSynthetic({ id: 'menu' }).fired, true, 'exercise the actual pointed Menu row');
    // Join the production action chain without adding another menu action.
    await h.toolbar.runAction({ kind: 'notice' });
    assert.equal(h.toolbar.isCollapsed(), false, 'the accepted Menu action must leave the expanded state');
    assert.equal(h.toolbar.isHidden(), false);
    assert.ok(h.toolbar.rows().some(row => row.label === 'Close'), 'the drawn rows offer Close after opening');
    assert.ok(h.toolbar.rows().some(row => row.id === 'reset'), 'Reset is reachable in the expanded grid');
    assert.ok(checks > 1, 'the obstructed clearance path actually ran');
    for (let step = 1; step <= 3; step++) {
      h.setState(state(step));
      await h.toolbar.update();
      assert.equal(h.toolbar.isCollapsed(), false, 'later status and chapter paints retain the wearer choice');
      assert.equal(h.toolbar.isHidden(), false);
    }
    await h.toolbar.runAction({ kind: 'collapse', value: true });
    assert.equal(h.toolbar.isCollapsed(), true, 'Close remains an explicit way to collapse the grid');
  } finally { await h.toolbar.dispose(); }
});
