import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Leaving immersion rebuilds the structure for the flat page and paints its
// emphasis again: a heavy Quest 2 spacefill keeps its context solid only
// while presenting, and the flat page shows the ghost. An exit that met a
// change still waiting for its frame skipped that rebuild, because the
// viewer was busy, and nothing asked again, so the flat page kept the solid
// context until some later change repainted it. The viewer now keeps the
// debt and pays it when the page asks at a quiet moment (`repaintAfterExit`,
// asked by the headset page's `repaintAfterExitWhenQuiet`). These cases run
// the real `mutate`, `beginWork`, `canRebuildForXr` and exit callback.
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function body(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const exitHook = source.match(/onLeavingPresentation: (async \(\) => \{[^\n]+\})/)[1];
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

function harness() {
  const repaints = [], fits = [];
  let drawn;
  const canvas = { webgl: { isContextLost: false }, xr: { isPresenting: { value: true } }, commit() {} };
  const h = vm.createContext({
    canvas, busy: false, activeWork: undefined, pendingContextLoss: undefined, appearanceWork: undefined,
    state: { status: 'ready', contextLossCount: 0, revision: 0, mutationCounts: { inspection: 0 } },
    inspectionState: {}, structure: { obj: { data: {} } }, representation: {},
    motionMutationPaused: false, motionToolPaused: false, syncPresentationMotion() {},
    assertReady() {}, assertContext() {}, interactionActive: () => false, now: () => 0, retainCurrent: () => ({}),
    waitForFrame: () => new Promise(resolve => { drawn = resolve; }), recordRenderCost() {}, recordCost() {},
    snapshot: () => ({}), emit() {}, onMutation() {}, talkCaption: undefined, setTimeout,
    releaseFigurePlates() {}, fitDesktopPreview: () => fits.push(repaints.length),
    // The appearance rebuild: on a presenting Quest 2 its emphasis keeps a heavy spacefill's context solid.
    applyInspectionAppearance: async options => { repaints.push({ ...options, presenting: canvas.xr.isPresenting.value }); },
  });
  for (const name of ['beginWork', 'mutate', 'canRebuildForXr', ...(source.includes('function repaintAfterExit(') ? ['repaintAfterExit'] : [])])
    vm.runInContext(body(name), h);
  // What the headset page does at a quiet moment.
  const ask = () => h.repaintAfterExit?.();
  const leave = () => { canvas.xr.isPresenting.value = false; return vm.runInContext(`(${exitHook})()`, h); };
  // Draw the frame the change is waiting for, once it has asked for one.
  const draw = async () => {
    for (let turn = 0; turn < 20 && !drawn; turn++) await Promise.resolve();
    assert.ok(drawn, 'the change waits for its frame');
    const release = drawn; drawn = undefined; release();
  };
  return { h, canvas, repaints, fits, leave, draw, ask };
}

test('a page that leaves immersion while a change waits for its frame is repainted for the flat page when it asks after the change', async () => {
  const t = harness();
  // An emphasis change painted for the headset and waits for its frame.
  const change = t.h.mutate('inspection', async () => {});
  await Promise.resolve();
  assert.equal(t.h.busy, true);
  await t.leave();
  assert.deepEqual(t.repaints, [], 'a busy viewer refuses the rebuild while the change is in hand');
  await t.ask();
  assert.deepEqual(t.repaints, [], 'nor does it run while the change is still in hand');
  await t.draw(); await change;
  await macrotask(); await macrotask();
  // The viewer does not start it by itself, so it cannot land inside the command's receipt.
  assert.deepEqual(t.repaints, []);
  await t.ask();
  assert.deepEqual(t.repaints, [{ labels: false, componentLabels: false, presenting: false }]);
  assert.equal(t.fits.at(-1), 1, 'the flat preview is fitted to the repainted structure');
  // Nothing more is owed.
  await t.ask();
  assert.equal(t.repaints.length, 1);
});

test('a busy owner outside the operation lifecycle still gets the flat repaint once it lets go', async () => {
  const t = harness();
  // An in-place recovery holds `busy` without `beginWork`, as `recover()` does.
  t.h.busy = true;
  await t.leave();
  await t.ask();
  assert.deepEqual(t.repaints, []);
  t.h.busy = false;
  await t.ask();
  assert.deepEqual(t.repaints, [{ labels: false, componentLabels: false, presenting: false }]);
});

test('a page that goes back into immersion before the change ends leaves the geometry to entry', async () => {
  const t = harness();
  const change = t.h.mutate('inspection', async () => {});
  await Promise.resolve();
  await t.leave();
  t.canvas.xr.isPresenting.value = true;
  await t.draw(); await change; await t.ask();
  assert.deepEqual(t.repaints, []);
  // Nor is it owed after a later exit on an idle viewer, which repaints at once as it always has.
  await t.leave();
  assert.deepEqual(t.repaints, [{ labels: false, componentLabels: false, presenting: false }]);
  await t.ask();
  assert.equal(t.repaints.length, 1);
});
