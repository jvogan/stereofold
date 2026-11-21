import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { figureTargetMatchesRow } from './lesson-figure.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

// The page path: the real setLessonFigure, with recording stand-ins for
// drawing, framing and selection. A chapter whose figure is framed on entry
// used to clear every selection afterwards, so residues the wearer or an agent
// had selected (and their labels) vanished on Next, which a chapter without a
// figure never did.
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const row = (key, chain, residue) => ({ key, coordinateState: 'resolved',
  identity: { authorChain: chain, authorResidue: residue, componentId: 'ALA', labelChain: chain, copyId: '1' },
  atomSites: [{ assemblyCoordinatesAngstrom: [residue, 0, 0] }] });
const rows = [row('A1', 'A', 1), row('A2', 'A', 2), row('B1', 'B', 1)];

function page({ selectionKeys = [], lessonSelection, held = false } = {}) {
  const calls = { frames: [], selects: [] };
  const c = vm.createContext({
    structure: {}, state: { selectionKeys }, lessonSelection, initialFigureFrame: undefined,
    assertReady() {}, now: () => 0, snapshot: () => ({ ready: true }), recordCost() {},
    lessonFigure: { installed: undefined, async install(value) { this.installed = value; }, snapshot: () => ({}),
      isEmptyFor() { return this.installed === undefined; } },
    inspectionMutation: async operation => { await operation(); },
    molecularAnimation: { poseSample: () => undefined, selectionSphere: loci => loci },
    syncStaticMask: async () => {}, applyInspectionTransform() {},
    focusSelection: async options => { calls.frames.push(options); },
    select: async keys => { calls.selects.push([...keys]); },
    selection: { rows, toLoci: keys => ({ keys: [...keys] }) },
    canvas: { xr: { isPresenting: { value: true } } },
    wearerPlacement: { holdsPlacement: () => held },
    figureTargetMatchesRow,
  });
  vm.runInContext(pageFunction(source, 'setLessonFigure'), c);
  return { c, calls };
}
const figure = { layers: [{ id: 'site' }], labels: [{ id: 'name' }], distances: [] };

test('a figure framed on chapter entry keeps the residues the wearer or an agent selected', async () => {
  const { c, calls } = page({ selectionKeys: ['A2', 'B1'] });
  await c.setLessonFigure(figure, { frame: true });
  assert.equal(calls.frames.length, 1, 'the chapter is still framed');
  assert.deepEqual(calls.selects, [['A2', 'B1']]);
});

test('a figure framed on chapter entry still clears a selection a lesson made', async () => {
  const { c, calls } = page({ selectionKeys: ['A1'], lessonSelection: 'A1' });
  await c.setLessonFigure(figure, { frame: true });
  assert.deepEqual(calls.selects, [[]]);
});

test('with nothing selected, a framed figure leaves nothing selected, as before', async () => {
  const { c, calls } = page();
  await c.setLessonFigure({ ...figure, focus: [{ chain: 'A', residues: { from: 1, to: 1 } }] }, { frame: true });
  assert.deepEqual(calls.frames[0].selectionKeys, ['A1'], 'a focus is framed by its own residues');
  assert.deepEqual(calls.selects, [[]]);
});

test('a figure that is not framed, or a held placement, does not touch the selection', async () => {
  for (const [options, held] of [[{ frame: false }, false], [{ frame: true }, true]]) {
    const { c, calls } = page({ selectionKeys: ['A2'], held });
    await c.setLessonFigure(figure, options);
    assert.deepEqual(calls.selects, []);
    assert.deepEqual(calls.frames, []);
  }
});
