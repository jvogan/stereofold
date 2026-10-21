import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createLessonFigure } from './lesson-figure.mjs';
import { motionFixture } from './motion-benchmark-fixture.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const coordinates = readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const definition = { layers: [{ id: 'part', target: { chain: 'A', residues: { from: 1, to: 12 } },
  representation: 'cartoon', color: '#246080', opacity: 1 }], labels: [], distances: [] };
async function fixture(t) {
  const h = await motionFixture({ source: coordinates, animation: null });
  let structure = h.structure, animation;
  const figure = createLessonFigure({ plugin: h.plugin, getStructure: () => structure,
    getTransform: () => h.presentation, getAnimation: () => animation });
  const calls = { mutations: 0, masks: 0, transforms: 0, refreshes: 0 };
  const c = vm.createContext({ structure: h.structure, lessonFigure: figure, state: {},
    assertReady() {}, now: () => performance.now(), recordCost() {}, snapshot: () => ({ ready: true }),
    inspectionMutation: async operation => { calls.mutations++; await operation(); },
    molecularAnimation: { poseSample: () => animation ? { definition: animation } : undefined,
      refresh: async () => { calls.refreshes++; } },
    syncStaticMask: async () => { calls.masks++; }, applyInspectionTransform: () => { calls.transforms++; },
  });
  vm.runInContext(pageFunction(source, 'setLessonFigure'), c);
  t.after(async () => { await figure.forget(); await h.dispose(); });
  return { h, figure, c, calls, set: c.setLessonFigure, setSource: value => { structure = value; },
    setAnimation: value => { animation = value; } };
}

test('clearing an already absent figure does not enqueue a mutation or redraw', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 3; i++) await h.set(undefined, { frame: true });
  assert.deepEqual(h.calls, { mutations: 0, masks: 0, transforms: 0, refreshes: 0 });
  assert.equal(h.figure.definition(), undefined);
  h.c.assertReady = () => { throw Error('busy'); };
  await assert.rejects(h.set(undefined), /busy/, 'normal mutation admission is never bypassed');
});

test('actual figure removal draws once and stale canvas objects prevent an empty shortcut', async t => {
  const h = await fixture(t);
  await h.figure.install(definition);
  const objects = h.figure.molecular().flatMap(repr => repr.renderObjects);
  assert.ok(objects.length > 0, 'the test constructs real Mol* geometry');
  await h.set(undefined);
  assert.equal(h.calls.mutations, 1);
  assert.equal(h.figure.definition(), undefined);
  assert.equal(h.figure.count(), 0);
  await h.set(undefined); assert.equal(h.calls.mutations, 1, 'a subsequent verified empty clear is free');
  h.h.canvas.getRenderObjects = () => objects;
  await h.set(undefined); assert.equal(h.calls.mutations, 2, 'retired objects still attached to Canvas3D require the normal draw');
  h.h.canvas.getRenderObjects = () => [];
});

test('queued installation and source retirement remain ordered before any empty clear', async t => {
  const h = await fixture(t);
  const installing = h.figure.install(definition);
  assert.equal(h.figure.isEmptyFor(h.h.structure), false, 'queued before its first microtask');
  const clearing = h.set(undefined);
  await installing; await clearing;
  assert.equal(h.calls.mutations, 1);
  assert.equal(h.figure.definition(), undefined);
  assert.equal(h.figure.isEmptyFor(h.h.structure), true);
  await h.figure.install(definition);
  const retiring = h.figure.forget();
  assert.equal(h.figure.definition(), undefined, 'forget retires the public identity immediately');
  assert.equal(h.figure.isEmptyFor(h.h.structure), false, 'retirement cleanup is still pending');
  await retiring;
  assert.equal(h.figure.isEmptyFor(h.h.structure), true);
});

test('empty eligibility follows exact source identity and preserves clockless and live animation work', async t => {
  const h = await fixture(t);
  assert.equal(h.figure.isEmptyFor({ ...h.h.structure }), false, 'equivalent selectors are not the current source');
  h.setSource(undefined); assert.equal(h.figure.isEmptyFor(h.h.structure), false);
  h.setSource(h.h.structure);
  const animation = { version: 1, durationSeconds: 1, tracks: [] };
  h.figure.setAnimation(animation);
  await h.set(undefined);
  assert.equal(h.calls.mutations, 1, 'clockless animation context must still clear');
  assert.equal(h.figure.animationContext(), undefined);
  h.setAnimation(animation);
  await h.set(undefined);
  assert.equal(h.calls.mutations, 2);
  assert.equal(h.calls.refreshes, 1, 'running motion still reapplies its figure masks');
  assert.equal(h.figure.animationContext(), animation);
  h.setAnimation(undefined);
});

test('failed retirement cannot turn retained Mol* cells into a falsely empty scene', async t => {
  const h = await fixture(t);
  await h.figure.install(definition);
  const build = h.h.plugin.build;
  h.h.plugin.build = () => {
    const builder = build.call(h.h.plugin);
    builder.commit = async () => { throw Error('retirement failed'); };
    return builder;
  };
  try { await assert.rejects(h.figure.forget(), /retirement failed/); }
  finally { h.h.plugin.build = build; }
  assert.equal(h.figure.definition(), undefined, 'public intent has already retired');
  assert.equal(h.figure.isEmptyFor(h.h.structure), false, 'owned cells still require cleanup/drawing');
  await h.set(undefined);
  assert.equal(h.calls.mutations, 1, 'the no-op must not conceal incomplete cleanup');
});
