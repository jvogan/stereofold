import assert from 'node:assert/strict';
import test from 'node:test';
import { tourFocusHarness, framedTourScene } from './fixtures/tour-focus-harness.mjs';

// Framing a lesson's focus is a placement, not a selection. Telomerase's
// dyskerin chapter selected the dyskerin it framed, and the wide chapter after
// it never cleared that, so dyskerin stayed selection magenta over its key.

function recorded() {
  const harness = tourFocusHarness();
  const selections = [];
  harness.h.select = async keys => { selections.push([...keys]); };
  return { ...harness, selections };
}

test('a lesson chapter frames its focus without selecting it', async () => {
  const { h, writes, selections } = recorded();
  await h.emphasize({ ...framedTourScene.emphasis, origin: 'lesson' });
  assert.ok(writes.length > 0, 'the chapter was framed');
  assert.deepEqual(selections, []);
});

test('a spoken focus still selects what it frames', async () => {
  const { h, selections } = recorded();
  await h.focusSelection({ selectionKeys: ['B'], framing: 'context', liftEmphasis: false });
  assert.deepEqual(selections, [['B']]);
});
