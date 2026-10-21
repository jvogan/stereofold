import test from 'node:test';
import assert from 'node:assert/strict';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { subjectVisibleInEyes, fitEntryGeometry } from './reset-entry-geometry.mjs';

for (const position of [[0, 0, 3.08], [0, 12, -1]]) test(`automatic fit recovers a visible seat from ${position}`, () => {
  const seat = { translation: position, scale: 1, rotation: [0, 0, 0] };
  const renderedGeometry = { subject: [{ center: position, radius: .5 }], views: syntheticViews(), renderFromRoom: identity() };
  const result = resetViewPlacement({ seat, fit: true, centered: true, recoverVisible: true,
    points: [-5, 5].flatMap(x => [-5, 5].map(y => [x, y, -1])),
    renderedGeometry, headInRoom: identity(), renderFromRoom: identity(), cameraScale: 1, center: [0, 0, 0], radius: 1 });
  assert.ok(result.translation[2] < 0, 'Reset must never keep a seat behind the wearer');
  assert.ok(result.scale >= .01, 'recovery keeps the numerical size floor');
  assert.equal(result.menuRecovery, true, 'the caller must move/hide glass before committing recovery');
  assert.ok(subjectVisibleInEyes(fitEntryGeometry(renderedGeometry, { anchor: position, moved: result.translation, ratio: result.scale })));
});

test('a recovery hides obstructing lesson glass while ordinary relocation keeps it drawn', async () => {
  const { toolbarFrameRuntime, toolbarFrameHarness } = await import('./fixtures/toolbar-frame-runtime.mjs');
  const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
  const h = toolbarFrameHarness(runtime, { state: { tour: { active: true, title: 'Wide', canNext: true } }, beforeMenuDraw: async () => ({ obstructed: true }) });
  try {
    await h.toolbar.update();
    const candidate = h.toolbar.prepareRelocation({ headInRoom: identity(), renderFromRoom: identity(), labelViews: syntheticViews() }).find(value => value.hide);
    await h.toolbar.commitRelocation(candidate);
    assert.equal(h.toolbar.isHidden(), false);
    const receipt = await h.toolbar.commitRelocation({ ...candidate, recovery: true });
    assert.equal(h.toolbar.isHidden(), true, 'a menu may not obscure the visible recovery');
    assert.deepEqual(h.toolbar.platePoints(), []);
    await h.toolbar.update();
    assert.equal(h.toolbar.isHidden(), true, 'a caption redraw cannot expose obstructing recovery glass');
    await receipt.rollback();
    assert.equal(h.toolbar.isHidden(), false, 'failed structure draw can restore the menu');
  } finally { await h.toolbar.dispose(); }
});
