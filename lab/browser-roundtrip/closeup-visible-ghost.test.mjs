import assert from 'node:assert/strict';
import test from 'node:test';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';

// A lesson close-up (a figure focus) is held inside the lens together with the
// structure around it. When the chapter hides chains of its source, what stays
// around the close-up is the chains it shows, not the whole source.

const box = (center, half) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  .map(axis => axis.map((v, i) => center[i] + v * half));
const site = { center: [12, 0, 0], radius: 8, extrema: box([12, 0, 0], 8) };
const source = { center: [0, 0, 0], radius: 100, extrema: box([0, 0, 0], 100) };
const shown = { center: [10, 0, 0], radius: 30, extrema: box([10, 0, 0], 30) };

async function framedCloseUp(ghost) {
  const { h, records } = tourFocusHarness();
  h.recordBoundingSphere = () => source;
  h.loadedSphere = () => source;
  h.selection.toLoci = () => site;
  await h.focusSelection({ selectionKeys: ['B'], framing: 'fill', minTargetFraction: .15, liftEmphasis: false,
    elevationDegrees: 0, lessonSelection: true, ...(ghost ? { ghost } : {}) });
  return records.filter(record => record.kind === 'xr-focus').at(-1);
}

test('a close-up that hides chains is sized against the chains it shows', async () => {
  const whole = await framedCloseUp();
  const visible = await framedCloseUp(shown);
  assert.ok(whole && visible, 'both chapters were framed');
  assert.ok(visible.angleDegrees > whole.angleDegrees * 1.5,
    `the site grows when the hidden chains no longer count (${whole.angleDegrees} -> ${visible.angleDegrees} degrees)`);
});

test('the same close-up with nothing hidden frames exactly as before', async () => {
  // Measured on the viewer before close-ups knew their shown chains.
  const { scale, angleDegrees, distanceMetres } = await framedCloseUp();
  assert.deepEqual({ scale, angleDegrees, distanceMetres }, { scale: 0.8006888344225834, angleDegrees: 12.8, distanceMetres: 1.2 });
});
