import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './render-dedupe-harness.mjs';

const lines = [{ id: 'distance', a: { key: 'a', position: [1, 2, 3] }, b: { key: 'b', position: [4, 5, 6] }, color: '#f2c47c' }];
const change = { kind: 'compound', patch: { ops: [
  { kind: 'appearance', patch: { opacity: .5 } },
  { kind: 'measurement', patch: { lines } },
] } };

// Execute the production staged compound and mutation functions. This fixture
// models only the annotation registry/geometry and frame delivery, not a GPU.
function measuredHarness() {
  const h = harness();
  let drawn = [], rejectInstall = false;
  const installs = [];
  h.context.measurementLines = {
    async install(value) {
      installs.push(structuredClone(value));
      drawn = structuredClone(value ?? []);
      if (rejectInstall) { rejectInstall = false; throw Error('annotation build failed'); }
    },
  };
  const payload = h.context.inspectionPayload;
  h.context.inspectionPayload = () => ({ ...payload(), measurementLines: structuredClone(drawn) });
  h.context.completeInspectionCapture = () => ({ ...h.snapshot(), measurements: structuredClone(drawn) });
  const restore = h.context.restoreInspection;
  h.context.restoreInspection = async before => {
    await restore(before);
    await h.context.measurementLines.install(before.measurements);
  };
  return { ...h, installs, drawn: () => drawn, failInstall: () => { rejectInstall = true; } };
}

test('staged history compound installs exact measurement endpoints in one group and frame', async () => {
  const h = measuredHarness();
  const before = h.snapshot();
  await h.compound(change, { preservePlacement: true });
  assert.deepEqual(h.drawn(), lines);
  assert.equal(h.snapshot().inspection.appearance.opacity, .5);
  assert.deepEqual(h.snapshot().inspection.placement, before.inspection.placement);
  assert.equal(h.snapshot().inspection.history.undoCount, 1);
  assert.equal(h.counts.frames, 1);
  assert.equal(h.counts.publications, 1);
  assert.deepEqual(h.installs, [lines]);
});

for (const failure of ['install', 'frame']) test(`failed ${failure} restores appearance and measured endpoints atomically`, async () => {
  const h = measuredHarness();
  const before = h.snapshot();
  if (failure === 'install') h.failInstall(); else h.failFrame();
  await assert.rejects(h.compound(change, { preservePlacement: true }), /annotation build failed|frame_failed/);
  assert.deepEqual(h.drawn(), []);
  assert.deepEqual(h.snapshot().inspection.appearance, before.inspection.appearance);
  assert.deepEqual(h.snapshot().inspection.placement, before.inspection.placement);
  assert.equal(h.snapshot().inspection.history.undoCount, before.inspection.history.undoCount);
  assert.equal(h.counts.restores, 1);
  assert.equal(h.counts.publications, 0);
});
