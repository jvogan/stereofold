import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { questTourFit } from './fixtures/quest-tour-fit.mjs';
import { placementFitWithinEnvelope } from './placement-fit-envelope.mjs';
const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { MOLECULAR_EXPERIENCES } = await tsImport('../../plugin/src/molecular-experience.ts', import.meta.url);
const { TOURS } = await tsImport('../../plugin/src/tour-catalog.ts', import.meta.url);
for (const [id, tour] of [
  ['4HHB', MOLECULAR_EXPERIENCES.find(t => t.id === 'hemoglobin-quaternary-structure')],
  ['1CRN', TOURS.find(t => t.id === 'fold-detective')],
]) test(`${id}: every shipped ${tour.id} step passes the page fit and host envelope at Quest proportions`, async t => {
  const h = await questTourFit(id, { worker: true });
  try {
    t.diagnostic(JSON.stringify({ sites: h.sites, radius: h.sphere.radius, cameraScale: h.cameraScale,
      radiusMeters: h.sphere.radius * h.cameraScale }));
    assert.equal(tour.steps.length, 20);
    for (const [index, step] of tour.steps.entries()) {
      const { requested, actual, fitted, evidence } = await h.step(step);
      assert.equal(JSON.stringify(actual.translation), JSON.stringify(fitted.translation));
      assert.equal(actual.scale, fitted.scale);
      assert.equal(placementFitWithinEnvelope(requested, actual, evidence), true, `${tour.id} step ${index}`);
      if (index === 0) t.diagnostic(JSON.stringify({ requested, actual, evidence }));
    }
  } finally { h.dispose(); }
});

test('ten colour-only Quest appearance fits keep an already clear pose; a wider surface still moves', async () => {
  const h = await questTourFit('4HHB', { worker: true });
  try {
    const first = await h.step({ appearance: { representation: 'cartoon', color: 'chain-id' } });
    assert.notDeepEqual(first.actual, first.requested, 'the initial overlapping pose needs a fit');
    const clear = structuredClone(first.actual);
    for (let index = 0; index < 10; index++) {
      const { requested, actual, placementAdjusted } = await h.step({ appearance: { representation: 'cartoon',
        color: index % 2 ? 'chain-id' : 'uniform' } });
      assert.deepEqual(requested, clear);
      assert.deepEqual(actual, clear, `colour edit ${index + 1} must preserve every placement bit`);
      assert.equal(placementAdjusted, false, `colour edit ${index + 1} must not report an adjustment`);
    }
    const surface = await h.step({ appearance: { representation: 'molecular-surface', color: 'chain-id' } });
    assert.notDeepEqual(surface.actual, surface.requested, 'the larger geometry must still move or shrink');
    assert.equal(surface.placementAdjusted, true);
    assert.equal(placementFitWithinEnvelope(surface.requested, surface.actual, surface.evidence), true);
  } finally { h.dispose(); }
});
