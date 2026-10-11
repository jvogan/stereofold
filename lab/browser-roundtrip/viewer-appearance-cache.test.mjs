import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeAppearance, sameAppearance } from './inspection-state.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const start = viewer.indexOf('  async function configureInspection(');
const end = viewer.indexOf('\n  async function placeInspection(', start);
assert.ok(start >= 0 && end > start, 'the production appearance entry exists');
const configureSource = viewer.slice(start, end);

function configureHarness({ appearance, labels = true } = {}) {
  let live = normalizeAppearance(appearance ?? { fog: 30 });
  let labelState = labels, rebuilds = 0, mutations = 0;
  const context = vm.createContext({
    normalizeAppearance, sameAppearance,
    assertReady() {}, assertContext() {}, findCurrentStructureRepresentation: () => undefined,
    inspectionSnapshot: () => ({ appearance: live }), volume: {},
    lessonResting: {
      labelsEnabled: () => labelState,
      setLabelsEnabled: value => { labelState = value === true; },
    },
    rebuildComponentLabels: async () => { rebuilds += 1; },
    snapshot: () => ({ appearance: live }),
    inspectionMutation: async operation => {
      mutations += 1;
      // The label-only route must take a normal inspection admission and
      // receipt, while a real appearance change reaches its renderer body.
      if (operation.toString().includes('inspectionState.configure')) throw Error('a real appearance must mutate Mol*');
      await operation();
      return { receipt: 'settled' };
    },
  });
  vm.runInContext(`${configureSource}\nglobalThis.configureInspection = configureInspection;`, context);
  return { configure: context.configureInspection, state: () => ({ labelState, rebuilds, mutations }) };
}

test('a repeated tour appearance skips Mol* while a label-intent change still settles plates', async () => {
  const repeated = configureHarness({ appearance: { fog: 30 }, labels: true });
  await repeated.configure({ representation: 'cartoon', color: 'chain-id', opacity: 1, fog: 30, componentLabels: true });
  assert.deepEqual(repeated.state(), { labelState: true, rebuilds: 0, mutations: 0 });

  const labels = configureHarness({ appearance: { fog: 30 }, labels: false });
  await labels.configure({ componentLabels: true });
  assert.deepEqual(labels.state(), { labelState: true, rebuilds: 1, mutations: 1 });

  await assert.rejects(repeated.configure({ fog: 10 }), /real appearance must mutate Mol\*/);
  assert.equal(repeated.state().mutations, 1, 'a real fog change still takes the renderer path');
});

test('configure uses the appearance admission once without a second post-reveal fit', async () => {
  const configureOnly = viewer.slice(start, viewer.indexOf('\n  }', start) + 4);
  const run = async held => {
    let appearance = normalizeAppearance({ representation: 'cartoon' });
    let placement = { translation: [0, 0, -2], rotation: [0, 0, 0], scale: 2 };
    const events = [];
    const context = vm.createContext({ normalizeAppearance, sameAppearance,
      assertContext() {}, assertReady() {}, findCurrentStructureRepresentation: () => undefined,
      volume: {}, canvas: { xr: { isPresenting: { value: true } } },
      wearerPlacement: { holdsPlacement: () => held },
      lessonResting: { labelsEnabled: () => false },
      inspectionSnapshot: () => ({ appearance, placement }),
      inspectionState: {
        configure: patch => { appearance = normalizeAppearance(patch, appearance); events.push('configure'); },
        place: next => { placement = { ...placement, ...next }; events.push('place'); },
      },
      syncInspectionPayload() {}, applyInspectionTransform() { events.push('transform'); },
      recordManipulation() {},
      applyInspectionAppearance: async () => {
        events.push('rebuild');
        const cleared = context.clearHeldPlatePlacement(placement);
        if (!held) { context.inspectionState.place(cleared); context.applyInspectionTransform(); }
      },
      clearHeldPlatePlacement: requested => {
        events.push('clearance');
        return { ...requested, translation: [.5, 0, -2], scale: 1.5 };
      },
      inspectionMutation: async operation => { await operation(); return { rendered: true }; },
    });
    vm.runInContext(`${configureOnly}\nglobalThis.configure = configureInspection;`, context);
    await context.configure({ representation: 'molecular-surface' });
    return { placement, events };
  };
  const host = await run(false);
  assert.deepEqual(host.events, ['configure', 'rebuild', 'clearance', 'place', 'transform']);
  assert.deepEqual(host.placement.translation, [.5, 0, -2]);
  assert.equal(host.placement.scale, 1.5);
  const wearer = await run(true);
  assert.deepEqual(wearer.events, ['configure', 'rebuild', 'clearance']);
  assert.equal(wearer.placement.scale, 2);
});
