import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { tourFocusHarness, framedTourScene } from './fixtures/tour-focus-harness.mjs';
import { SUBJECT_CENTRE_LENS } from './plate-standoff.mjs';

// Load the source player, never plugin/dist, in the ordinary lab node:test run.
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { applyTourStep } = await tsImport('../../plugin/src/tour-player.ts', import.meta.url);

for (const held of [false, true]) test(`XR tour framing respects wearer placement (held=${held})`, async () => {
  const h = tourFocusHarness();
  if (held) await h.wearerMove();
  const before = h.writes.length;
  const placementBefore = h.snapshot().placement;
  const lensBefore = held ? h.targetLens() : undefined;
  await applyTourStep(h.workspace, framedTourScene, () => true, false,
    undefined, error => { throw error; });
  assert.equal(h.records.filter(row => row.kind === 'xr-focus').length, held ? 0 : 1,
    'automatic framing applies only without a wearer placement hold');
  assert.equal(h.paints.length, 1, 'the authored emphasis was painted');
  assert.deepEqual(h.writes.slice(before).map(row => row.action), held ? [] : ['tour-placement', 'grab']);
  const [x, y] = h.targetLens();
  if (held) {
    assert.deepEqual(h.snapshot().placement, placementBefore, 'the authored chapter preserves the exact wearer seat');
    assert.deepEqual([x, y], lensBefore);
  } else {
    assert.ok(Math.abs(x) <= SUBJECT_CENTRE_LENS + 1e-6, `committed focus lens x=${x}`);
    assert.ok(Math.abs(y) <= SUBJECT_CENTRE_LENS + 1e-6, `committed focus lens y=${y}`);
  }
  assert.equal(h.hold.holdsPlacement(), held, 'chapter framing does not release the session hold');
});

for (const path of ['voice', 'tour']) test(`${path}: framed emphasis emits one layout and one plate update`, async () => {
  const h = tourFocusHarness({ labels: true });
  await h.h.rebuildComponentLabels();
  h.records.length = 0;
  const plateParams = () => [...h.labels.cells].filter(([id]) => id.endsWith('-backing'))
    .map(([id, cell]) => [id, JSON.parse(JSON.stringify(cell.params))]);
  const platesBefore = plateParams();
  const cellsBefore = new Map(h.labels.cells);
  if (path === 'voice') {
    const { spatialVoiceAction } = await import('./voice-command-runner.mjs');
    const command = spatialVoiceAction('show me dyskerin', { lessonParts: h.h.emphasisState.parts });
    assert.equal(command.action.kind, 'emphasize-part');
    await h.h.onSpatialAction(command.action);
  } else {
    await applyTourStep(h.workspace, { ...framedTourScene,
      emphasis: { parts: h.h.emphasisState.parts, focus: 'dyskerin', framing: 'context' } },
    () => true, false, undefined, error => { throw error; });
  }
  assert.notDeepEqual(plateParams(), platesBefore, 'the real framing commits changed plate uniforms');
  assert.deepEqual([...h.labels.cells.keys()], [...cellsBefore.keys()], 'framing retains the primitive topology');
  for (const [id, cell] of h.labels.cells) {
    assert.equal(cell, cellsBefore.get(id));
    assert.ok(!id.endsWith('-leader') && !id.endsWith('-text'));
  }
  assert.equal(h.records.filter(r => r.kind === 'xr-focus').length, 1);
  assert.equal(h.records.filter(r => r.kind === 'component-label-layout').length, 1);
  assert.equal(h.records.filter(r => r.kind === 'plate-update').length, 1);
  assert.equal(h.records.find(r => r.kind === 'component-label-layout').reason, 'emphasis+placement');
});
