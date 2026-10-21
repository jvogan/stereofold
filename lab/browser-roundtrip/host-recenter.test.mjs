/**
 * An agent's `placement {recenter:true}` reaches the headset's
 * own Reset.
 *
 * On 2026-09-28 the only way an agent could put a lost structure back in
 * front of the wearer was to find Quest Browser's debugger and press the
 * page's Reset through it, which needs a USB cable. The command now rides the
 * ordinary receipt path over the Wi-Fi share. These tests run the page's real
 * source: the workspace hands the command to `viewer.inspection.recenter`, and
 * that runs `runFaceAction('recenter-structure')`, the Reset a held B or Y runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { applyCompoundChange } from './compound-change.mjs';
import { createNamedPublication } from '../inspection/named-publication.mjs';
import { interruptibleCommand } from '../inspection/interruptible-command.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('../inspection/workspace.mjs', import.meta.url), 'utf8');
const closure = name => {
  const start = viewerSource.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, `${name} is in viewer.mjs`);
  return viewerSource.slice(start, viewerSource.indexOf('\n  }', start) + 4);
};

/** The viewer's `recenterInspection` and `runFaceAction`, over a counted seat and menu. */
function viewerHarness({ presenting = true, holding = false, menuFails = false, seatFailure } = {}) {
  const events = [];
  const context = vm.createContext({
    canvas: { xr: { isPresenting: { value: presenting } } },
    failure: (code, message) => Object.assign(new Error(message), { code }),
    immersiveSession: {
      refreshToolbar: async options => { events.push(['refresh', options]); if (menuFails && options?.resetMenu) throw Error('menu lost'); },
      toolbarAction: action => { events.push(['menu', action.kind]); if (menuFails) throw Error('menu lost'); },
      isMenuHidden: () => false, isMenuCollapsed: () => true, setMenuHidden: () => {},
    },
    xrManipulation: { phase: () => (holding ? 'grabbing' : 'idle') },
    menuResetActions: () => [{ kind: 'recenter-menu' }],
    talkCaption: { set: value => { if (value.outcome) events.push(['caption', value.outcome]); } },
    showHeadsetCaption: text => events.push(['caption', text]),
    recordManipulation: (kind, detail) => events.push([kind, detail]),
    seatStructureForEntry: async options => { events.push(['seat', options]); if (seatFailure) throw Error(seatFailure); return { mode: 'auto', metersAcross: 2.35 }; },
  });
  vm.runInContext(closure('runFaceAction'), context);
  vm.runInContext(closure('recenterInspection'), context);
  return { recenter: () => context.recenterInspection(), events, context };
}

test('an agent recenter waits for an in-flight render before touching the menu or seat', async () => {
  const h = viewerHarness();
  let finish;
  h.context.busy = true;
  h.context.activeWork = { done: new Promise(resolve => { finish = resolve; }) };
  const reset = h.recenter();
  await new Promise(resolve => setImmediate(resolve));
  const premature = h.events.slice();
  h.context.busy = false; h.context.activeWork = undefined; finish();
  await reset;
  assert.deepEqual(premature, [], 'Reset must not enter a chapter render');
  assert.ok(h.events.some(([kind]) => kind === 'seat'));
});

test('queued recenter follows chapter framing and waits for toolbar clearance before capturing its seat', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = viewerHarness();
  let clears = 0, release, rendering = false;
  let placement = { translation: [0, 0, -1], rotation: [0, 0, 0], scale: 1 };
  const entry = { translation: [0, 0.2, -1.4], rotation: [0, 0, 0], scale: 0.6 };
  const gate = new Promise(resolve => { release = resolve; });
  const t = toolbarFrameHarness(runtime, { beforeMenuDraw: async () => {
    if (++clears < 2) return;
    rendering = true;
    await gate;
    rendering = false;
  } });
  await t.toolbar.update();
  Object.assign(h.context.immersiveSession, {
    refreshToolbar: options => t.toolbar.update(options),
    toolbarAction: action => t.toolbar.runAction(action, { origin: 'programmatic' }),
  });
  h.context.seatStructureForEntry = async () => { placement = structuredClone(entry); return {}; };
  // Use the production workspace queue: a chapter is one action, even when
  // it yields between animation installation, appearance and focus travel.
  const q = vm.createContext({ queue: Promise.resolve(), closing: false, busy: false,
    // This headset queue fixture has no desktop sequence group.
    $: selector => { assert.equal(selector, '.sequence-items'); return null; },
    $$: () => [], moleculeCanvas: { style: {} }, setStatus() {}, sync() {}, options: {} });
  const start = workspaceSource.indexOf('function run(message,');
  vm.runInContext(workspaceSource.slice(start, workspaceSource.indexOf('\n}', start) + 2), q);
  let finishChapter;
  const chapterGate = new Promise(resolve => { finishChapter = resolve; });
  const chapter = q.run('Chapter', async () => {
    await chapterGate;
    placement = { ...placement, translation: [0.77, -0.33, -3.54] };
  });
  const w = workspaceHarness({
    snapshot: () => ({ xrPresenting: true, applied: {} }),
    inspection: {
      recenter: h.recenter,
      capture: () => {
        assert.equal(rendering, false, 'capture must not race a molecular clearance render');
        return { inspection: { placement: structuredClone(placement) } };
      },
    },
  }, q.run);
  let completed = false;
  let confirmed, failure;
  const reset = w.remote({ kind: 'placement', patch: { recenter: true } }, async () => {},
    async scene => { confirmed = scene; }).then(() => { completed = true; }, error => { failure = error; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clears, 1, 'queued recenter cannot touch the menu during the chapter');
    finishChapter(); await chapter;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rendering, true, 'exercise the pending clearance draw');
    assert.equal(completed, false, 'capture would throw viewer_busy while clearance is drawing');
  } finally { finishChapter(); release(); await reset; await t.toolbar.dispose(); }
  if (failure) throw failure;
  assert.equal(rendering, false);
  assert.deepEqual(confirmed.inspection.placement, entry, 'chapter framing cannot overwrite the later Reset receipt');
});

test('the host recenter runs the wearer Reset: seat, menu re-seat and caption', async () => {
  const h = viewerHarness();
  const seat = await h.recenter();
  assert.equal(seat.metersAcross, 2.35);
  assert.equal(seat.structureReset, true);
  assert.equal(seat.menuReseated, true);
  assert.equal(h.events.find(([kind]) => kind === 'seat')[1].resetMenu, true);
  assert.ok(h.events.some(([kind, value]) => kind === 'refresh' && value.recenter === true), 'the menu comes back beside the wearer');
  assert.ok(h.events.findIndex(([kind]) => kind === 'seat') < h.events.findIndex(([kind]) => kind === 'refresh'),
    'the molecular reset must commit before the menu moves');
  assert.deepEqual(h.events.at(-1), ['caption', 'View reset.']);
});

test('a failed menu re-seat is a partial Reset in the result and caption', async () => {
  const h = viewerHarness({ menuFails: true });
  const result = await h.recenter();
  assert.equal(result.structureReset, true);
  assert.equal(result.menuReseated, false);
  assert.ok(h.events.some(([kind, value]) => kind === 'caption' && value === 'View reset. The menu did not move.'));
});

test('the host recenter keeps the Reset refusal while a hand holds the structure', async () => {
  const h = viewerHarness({ holding: true });
  await assert.rejects(h.recenter(), /Let go of it first/);
  assert.equal(h.events.some(([kind]) => kind === 'seat'), false);
  assert.equal(h.events.some(([kind]) => kind === 'refresh'), false, 'a held structure cannot produce a menu-only reset');
});

for (const reason of ['Enter VR and wait for tracking before recentring the structure.',
  'Could not reset: the entry seat has not rendered yet. Wait for the structure to appear.',
  'Reset draw failed']) test(`a refused structure Reset preserves the menu seat: ${reason}`, async () => {
  const h = viewerHarness({ seatFailure: reason });
  await assert.rejects(h.recenter(), { message: reason });
  assert.equal(h.events.some(([kind]) => kind === 'refresh'), false);
  assert.ok(h.events.some(([kind, text]) => kind === 'caption' && text === reason));
  assert.ok(!h.events.some(([kind, text]) => kind === 'caption' && text === 'View reset.'));
});

test('a page that is not in VR refuses the recenter and moves nothing', async () => {
  const h = viewerHarness({ presenting: false });
  await assert.rejects(h.recenter(), error => error.code === 'not_presenting' && /Enter VR first/.test(error.message));
  assert.deepEqual(h.events, []);
});

/** The workspace's real `applyRemote`, over a viewer that records what it was asked. */
function workspaceHarness(viewerOverride, run = async (_text, fn) => fn()) {
  const calls = [];
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const viewer = viewerOverride ?? {
    snapshot: () => ({ xrPresenting: true, applied: {} }),
    inspection: {
      capture: () => ({ inspection: { placement: structuredClone(placement) } }),
      recenter: async () => { calls.push('recenter'); placement = { translation: [0, 0.2, -1.4], rotation: [0, 12, 0], scale: 0.6 };
        return { structureReset: true, menuReseated: true }; },
      place: async () => { calls.push('place'); throw Error('A recenter must not become a numeric placement.'); },
      placementFitEvidence: () => ({ fit: true }),
    },
  };
  const body = workspaceSource.slice(workspaceSource.indexOf('  applyRemote:') + '  applyRemote:'.length,
    workspaceSource.lastIndexOf('\n});')).trim().replace(/,$/, '');
  const remote = new Function('run', 'namedPublication', 'interruptibleCommand', 'viewer', 'applyCompoundChange', `return (${body});`)(
    run, createNamedPublication(() => {}), interruptibleCommand, viewer, applyCompoundChange);
  return { remote, calls };
}

test('the workspace sends placement {recenter:true} to the Reset and confirms what it drew', async () => {
  const h = workspaceHarness();
  let confirmed;
  await h.remote({ kind: 'placement', patch: { recenter: true } }, async () => {}, async (scene, applied) => { confirmed = { scene, applied }; });
  assert.deepEqual(h.calls, ['recenter']);
  assert.deepEqual(confirmed.scene.inspection.placement, { translation: [0, 0.2, -1.4], rotation: [0, 12, 0], scale: 0.6 });
  // No numbers were asked for, so nothing was "adjusted" against a request.
  assert.equal(confirmed.applied.placementAdjusted, undefined);
  assert.deepEqual(confirmed.applied.recenterCompletion.placement, confirmed.scene.inspection.placement);
});

test('a numeric placement still takes the numeric path', async () => {
  const h = workspaceHarness();
  await assert.rejects(h.remote({ kind: 'placement', patch: { scale: 2 } }, async () => {}, async () => {}), /numeric placement/);
  assert.deepEqual(h.calls, ['place']);
});
