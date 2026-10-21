/**
 * CRISPR chapter 2 says "Orange is the guide RNA", and the RNA came up pink.
 * Chapters 4 and 8 said purple over a pink recognition lobe, and telomerase
 * chapter 4 drew dyskerin pink beside a purple colour key. Each was a focus
 * chapter: its framing selected the part it lit, and the selection mark
 * (#ff2dd4, the last overpaint layer) covered the lesson's own colour.
 *
 * These run the page's own `select`, `markSelection` and
 * `currentSelectionPlan` and check that a selection the lesson makes keeps
 * the lesson's colour, while a wearer's selection is still marked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { selectionPaintPlan, selectionSignature } from './selection-paint.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

function page() {
  const marked = [], painted = [];
  const context = vm.createContext({
    state: { selectionKeys: [] }, lessonSelection: undefined, settledSelectionLayers: undefined,
    selection: { rows: [] }, structure: {}, inspectionState: undefined, stylesState: [], styleLayers: [],
    assertReady() {}, selectedKeys: keys => [...keys], selectionLayersUnchanged: () => false,
    hiddenSceneKeys: () => [], hiddenSceneKeySet: () => new Set(), retainCurrent: () => ({}),
    markRecord: (record, keys) => marked.push([...keys]),
    inspectionSnapshot: () => ({ appearance: { background: '#071015', highlightColor: '#f2c47c' } }),
    selectionPaintPlan, selectionSignature, emphasisOrigin: 'lesson',
    currentEmphasisPlan: () => ({ colours: [{keys:['B:1','B:2','B:3','A:60','A:61']}] }),
    async rebuildComponentLabels() {}, async rebuildInspectionLabels() {},
    mutate: async (kind, operation) => operation(),
  });
  context.paintSelectionOverlay = async () => { painted.push(context.currentSelectionPlan().keys); };
  for (const name of ['select', 'markSelection', 'currentSelectionPlan']) vm.runInContext(pageFunction(viewer, name), context);
  return { context, marked, painted };
}

test('a lesson selection keeps the lesson colour, and a wearer selection is still marked', async () => {
  const { context, marked, painted } = page();
  const guide = ['B:1', 'B:2', 'B:3'];
  await context.select(guide, 'selection', { lesson: true });
  // Selected, so framing, the focus view and residue labels still read it...
  assert.deepEqual([...context.state.selectionKeys], guide);
  // ...but neither the overpaint nor the flat marker covers the key colour.
  assert.deepEqual([...painted.at(-1)], []);
  assert.deepEqual(marked.at(-1), []);
  // The wearer then selects the same part by hand: that is their mark to see.
  await context.select(guide);
  assert.deepEqual([...painted.at(-1)], guide);
  assert.deepEqual(marked.at(-1), guide);
  // And a later lesson selection is the lesson's again.
  await context.select(['A:60', 'A:61'], 'selection', { lesson: true });
  assert.deepEqual([...painted.at(-1)], []);
});

test('a lesson chapter frames and selects its part as the lesson', () => {
  // The emphasis framing and the figure framing are the two lesson callers
  // that hand `focusSelection` row keys to select.
  const focusSelection = pageFunction(viewer, 'focusSelection');
  assert.match(focusSelection, /lessonSelection\s*=\s*false/);
  assert.match(focusSelection, /select\(chosen, 'selection', \{ lesson: lessonSelection \}\)/);
  const framed = [...viewer.matchAll(/focusSelection\(\{ selectionKeys: (\w+)/g)].map(match => match.index);
  assert.ok(framed.length >= 2);
  for (const at of framed) {
    const call = viewer.slice(at, viewer.indexOf('});', at));
    assert.match(call, /lessonSelection: /, call);
  }
});
