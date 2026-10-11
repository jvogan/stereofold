import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomSeatMemory, initialRoomCameraScale } from './room-seat-memory.mjs';

const source = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1' };
const placement = { scale: 1.9824482982278422, translation: [1.6853, .4579, -1.6493], rotation: [11, -24, 7] };
const camera = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
const saved = { scene: source, placement, cameraScale: .009, camera };
const storage = () => {
  const items = new Map();
  return { getItem: key => items.get(key), setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
};

test('same-tab Mol* navigation consumes the scene scale once and never carries tracked matrices', () => {
  const tab = storage();
  assert.equal(createRoomSeatMemory(tab).remember(saved), true);
  const page = createRoomSeatMemory(tab), returned = page.take(saved);
  assert.deepEqual(returned, { source: [source.sourceSha256, 1, '1'], placement, cameraScale: .009, camera });
  assert.equal(page.take(saved), undefined);
  assert.equal(createRoomSeatMemory(tab).take(saved), undefined);
});

for (const change of ['source', 'model', 'assembly', 'translation', 'rotation', 'scale']) {
  test(`Mol* return refuses a stale ${change} record without changing the authoritative scene`, () => {
    const tab = storage(), next = structuredClone(saved);
    createRoomSeatMemory(tab).remember(saved);
    if (change === 'source') next.scene.sourceSha256 = 'b'.repeat(64);
    else if (change === 'model') next.scene.modelNumber = 2;
    else if (change === 'assembly') next.scene.assemblyId = '2';
    else if (change === 'scale') next.placement.scale = 4;
    else next.placement[change][0] += 1;
    const before = structuredClone(next);
    assert.equal(createRoomSeatMemory(tab).take(next), undefined);
    assert.deepEqual(next, before);
    assert.equal(createRoomSeatMemory(tab).take(saved), undefined, 'a mismatch consumes the stale record');
  });
}

test('unavailable storage retains same-document re-entry; corrupt storage cannot set a camera scale', () => {
  const denied = new Proxy({}, { get() { throw Error('storage denied'); } });
  const memory = createRoomSeatMemory(denied);
  assert.equal(memory.remember(saved), true);
  assert.equal(memory.take(saved).cameraScale, .009);
  assert.equal(memory.take(saved), undefined);
  assert.equal(createRoomSeatMemory({ getItem: () => '{bad', removeItem() {} }).take(saved), undefined);
});

test('fresh-page XR units remove existing placement scale exactly once, including explored sizes beyond the old range', () => {
  for (const placementScale of [.001, .25, 1, 1.9824482982278422, 4, 8, 100]) {
    assert.ok(Math.abs(initialRoomCameraScale({ radius: 100 * placementScale, placementScale }) - .9 / 100) <= Number.EPSILON * .009,
      'multiplying and dividing the placed radius may round by one ulp');
  }
  for (const radius of [0, NaN, Infinity]) assert.equal(initialRoomCameraScale({ radius, placementScale: 1 }), undefined);
});

for (const scale of [.01, 8, 100]) test(`explored scale ${scale} and travel survive same-tab XR return`, () => {
  const tab=storage(), explored={...saved,placement:{...placement,scale,translation:[12,-20,30]}};
  assert.equal(createRoomSeatMemory(tab).remember(explored),true);
  assert.deepEqual(createRoomSeatMemory(tab).take(explored).placement,explored.placement);
});
