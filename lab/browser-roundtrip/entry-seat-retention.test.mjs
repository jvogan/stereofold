import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function closure(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const seat = () => ({ scale: 1.6, rotation: [60, -25, 10], translation: [1.7, .4, -4] });

function harness({ held = false, presenting = true, current = seat(), entry = seat() } = {}) {
  const calls = [];
  const roomEntry = entry ? { seat: structuredClone(entry) } : {};
  const context = vm.createContext({
    roomEntry, wearerPlacement: { holdsPlacement: () => held },
    canvas: { xr: { isPresenting: { value: presenting } }, camera: { scale: 1 } },
    inspectionSnapshot: () => ({ placement: current }),
    emphasisState: { parts: [] }, componentLabelsWanted: () => false,
    componentLabelViewBasis: () => ({}), placementTransform: identity, presentationTransform: identity,
    latestRoomPlacementPose: { labelViews: [{ eye: 'left' }, { eye: 'right' }],
      headInRoom: identity(), renderFromRoom: identity() },
    immersiveSession: { toolbarPlacementPoints: () => [] }, scientificRepresentations: () => [],
    resetViewPlacement: options => { calls.push(options); return options.seat; },
    loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }), cameraSnapshot: value => value,
    restoreTourSeat: async () => {}, recordJourneySeat() {}, structuredClone,
    applyMatrix4: point => point, Mat4, Vec3,
  });
  for (const name of ['roomAnchorPlacement', 'restoreJourneySeat']) vm.runInContext(closure(name), context);
  return { calls, context, run: route => route === 'Reset'
    ? context.roomAnchorPlacement({ resetMenu: true, sphere: { center: [0, 0, 0], radius: 1 } })
    : context.restoreJourneySeat({ scene: { camera: {} } }) };
}

for (const route of ['Reset', 'Done']) {
  test(`${route} passes accepted entry provenance to the geometry solver`, async () => {
    const h = harness(); await h.run(route);
    assert.equal(h.calls[0].retainFreeFieldSeat, true);
    assert.equal(h.calls[0][route === 'Reset' ? 'centered' : 'restoreSaved'], true);
  });
  for (const field of ['scale', 'rotation', 'translation']) test(`${route} ${route === 'Reset' ? 'restores the accepted target after an automatic' : 'rejects modified'} ${field} change`, async () => {
    const current = seat();
    if (field === 'scale') current.scale += .001;
    else current[field][0] += .001;
    const h = harness({ current }); await h.run(route);
    assert.equal(h.calls[0].retainFreeFieldSeat, route === 'Reset');
    if (route === 'Reset') assert.deepEqual(h.calls[0].seat, seat(), 'Reset validates its accepted target, not the outgoing automatic pose');
  });
  test(`${route} keeps wearer ownership out of automatic entry retention`, async () => {
    const h = harness({ held: true }); await h.run(route);
    assert.equal(h.calls[0].retainFreeFieldSeat, false);
  });
}

test('Done after source adoption has no old entry provenance', async () => {
  // Source adoption deletes roomEntry.seat; the session itself may continue.
  const h = harness({ entry: null }); await h.run('Done');
  assert.equal(h.calls[0].retainFreeFieldSeat, false);
});
test('Reset without a current source entry keeps its existing refusal', () => {
  const h = harness({ entry: null });
  assert.throws(() => h.run('Reset'), /entry seat has not rendered/);
});
test('a nonpresenting session cannot authorize automatic entry retention', () => {
  const h = harness({ presenting: false }); h.run('Reset');
  assert.equal(h.calls[0].retainFreeFieldSeat, false);
});
