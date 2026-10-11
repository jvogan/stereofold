import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { focusResidues } from './focus-residues.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function harness() {
  const framed = [], mutations = [];
  const rows = [
    { key: 'A1', coordinateState: 'resolved', atomSites: [{}] },
    { key: 'A2', coordinateState: 'unresolved', atomSites: [] },
    { key: 'A3', coordinateState: 'resolved', atomSites: [{}] },
  ];
  const state = { selectionKeys: ['A3'] };
  const h = vm.createContext({
    focusResidues, state, now: () => 0, recordCost() {}, assertReady() {},
    cancelXrPlacementFollowup() {}, invalidateGesturePivot() {}, focusPivotRequest: undefined,
    LESSON_FRAMING_TRAVEL_MS: 0, structure: {}, volume: undefined, inspectionState: undefined,
    recordBoundingSphere: () => ({}),
    failure: (code, message) => Object.assign(new Error(message), { code }),
    selection: { rows, toLoci(keys) {
      if (keys.some(key => !rows.some(row => row.key === key))) throw Error('invalid selection');
      return [...keys];
    } },
    liftFocusOutOfFade: async () => { mutations.push('emphasis'); },
    select: async keys => { state.selectionKeys = [...keys]; mutations.push('selection'); },
    mutate: async (kind, apply) => { mutations.push(kind); await apply(); },
    plugin: { managers: { camera: { focusLoci: keys => framed.push([...keys]) } } },
    fitInspection: async () => { mutations.push('fit'); },
  });
  for (const name of ['selectedKeys', 'modelledFocusKeys', 'focus', 'focusSelection']) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0);
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), h);
  }
  return { h, rows, state, framed, mutations };
}

test('a whole chain keeps its gaps selected and frames only modelled residues', async () => {
  const t = harness(), keys = t.rows.map(row => row.key);
  await t.h.focusSelection({ selectionKeys: keys });
  assert.deepEqual(t.state.selectionKeys, keys);
  assert.deepEqual(t.framed, [['A1', 'A3']]);
  assert.deepEqual(focusResidues(t.rows, keys), { modelledKeys: ['A1', 'A3'], missingCoordinateCount: 1 });
});

test('a focus with no modelled residues refuses before selection or emphasis changes', async () => {
  const t = harness();
  await assert.rejects(t.h.focusSelection({ selectionKeys: ['A2'] }), { code: 'missing_coordinates' });
  assert.deepEqual(t.state.selectionKeys, ['A3']);
  assert.deepEqual(t.mutations, []);
  assert.deepEqual(t.framed, []);
  await t.h.focusSelection({ selectionKeys: ['A1'] });
  assert.deepEqual(t.framed, [['A1']]);
});

test('direct focus accepts gaps and still refuses an entirely unmodelled selection', async () => {
  const t = harness();
  await t.h.focus(['A1', 'A2']);
  assert.deepEqual(t.framed, [['A1']]);
  await assert.rejects(t.h.focus(['A2']), { code: 'missing_coordinates' });
});

import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';

test('XR framing uses modelled bounds while retaining a whole chain with gaps', async () => {
  const { h, records } = tourFocusHarness();
  h.selection.rows.push({ key: 'gap', coordinateState: 'unresolved', atomSites: [] });
  const bounds = h.selection.toLoci([]), framed = [];
  h.selection.toLoci = keys => { framed.push([...keys]); return bounds; };
  let selected;
  h.select = async keys => { selected = [...keys]; };
  await h.focusSelection({ selectionKeys: ['B', 'gap'], liftEmphasis: false });
  assert.deepEqual(selected, ['B', 'gap']);
  assert.ok(framed.length > 0);
  assert.ok(framed.every(keys => !keys.includes('gap')));
  assert.equal(records.filter(row => row.kind === 'xr-focus').length, 1);
});

test('XR focus refuses an all-gap selection before changing the page', async () => {
  const { h, writes, paints } = tourFocusHarness();
  h.selection.rows.push({ key: 'gap', coordinateState: 'unresolved', atomSites: [] });
  h.failure = (code, message) => Object.assign(Error(message), { code });
  h.select = async () => assert.fail('An all-gap focus must not change selection');
  await assert.rejects(h.focusSelection({ selectionKeys: ['gap'] }), { code: 'missing_coordinates' });
  assert.deepEqual(writes, []);
  assert.deepEqual(paints, []);
});
