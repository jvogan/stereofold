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

const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('../inspection/workspace.mjs', import.meta.url), 'utf8');
const closure = name => {
  const start = viewerSource.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, `${name} is in viewer.mjs`);
  return viewerSource.slice(start, viewerSource.indexOf('\n  }', start) + 4);
};

/** The viewer's `recenterInspection` and `runFaceAction`, over a counted seat and menu. */
function viewerHarness({ presenting = true, holding = false, menuFails = false } = {}) {
  const events = [];
  const context = vm.createContext({
    canvas: { xr: { isPresenting: { value: presenting } } },
    failure: (code, message) => Object.assign(new Error(message), { code }),
    immersiveSession: {
      refreshToolbar: async options => { events.push(['refresh', options]); },
      toolbarAction: action => { events.push(['menu', action.kind]); if (menuFails) throw Error('menu lost'); },
      isMenuHidden: () => false, isMenuCollapsed: () => true, setMenuHidden: () => {},
    },
    xrManipulation: { phase: () => (holding ? 'grabbing' : 'idle') },
    menuResetActions: () => [{ kind: 'recenter-menu' }],
    talkCaption: { set: value => { if (value.outcome) events.push(['caption', value.outcome]); } },
    showHeadsetCaption: text => events.push(['caption', text]),
    recordManipulation: (kind, detail) => events.push([kind, detail]),
    seatStructureForEntry: async options => { events.push(['seat', options]); return { mode: 'auto', metersAcross: 2.35 }; },
  });
  vm.runInContext(closure('runFaceAction'), context);
  vm.runInContext(closure('recenterInspection'), context);
  return { recenter: () => context.recenterInspection(), events };
}

test('the host recenter runs the wearer Reset: seat, menu re-seat and caption', async () => {
  const h = viewerHarness();
  const seat = await h.recenter();
  assert.equal(seat.metersAcross, 2.35);
  assert.equal(seat.structureReset, true);
  assert.equal(seat.menuReseated, true);
  assert.equal(h.events.find(([kind]) => kind === 'seat')[1].resetMenu, true);
  assert.ok(h.events.some(([kind, value]) => kind === 'refresh' && value.recenter === true), 'the menu comes back beside the wearer');
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
});

test('a page that is not in VR refuses the recenter and moves nothing', async () => {
  const h = viewerHarness({ presenting: false });
  await assert.rejects(h.recenter(), error => error.code === 'not_presenting' && /Enter VR first/.test(error.message));
  assert.deepEqual(h.events, []);
});

/** The workspace's real `applyRemote`, over a viewer that records what it was asked. */
function workspaceHarness() {
  const calls = [];
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const viewer = {
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
    async (_text, fn) => fn(), createNamedPublication(() => {}), interruptibleCommand, viewer, applyCompoundChange);
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
