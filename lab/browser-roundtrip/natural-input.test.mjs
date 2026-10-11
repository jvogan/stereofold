import assert from 'node:assert/strict';
import test from 'node:test';
import { attachNaturalInput, createNaturalInput, aimDegrees, isNaturalInputSource, naturalRayFor,
  naturalRayFromPose, pinchBecameDrag, pinchOwner, NATURAL_HANDS, NATURAL_OWNER,
  PINCH_DRAG_DEGREES, PINCH_DRAG_METERS, TRANSIENT_RAY_MODE } from './natural-input.mjs';
import { createNaturalInputEmulator, poseFromRay } from './natural-input-emulator.mjs';
import { createGripLatch, nextManipulation, idleManipulation, POINTER_GRIP } from './xr-manipulate.mjs';

/** A rig with the adapter already bound, and a log of everything it did. */
function rig({ onMenu = () => false, isClaimed = () => false } = {}) {
  const emulator = createNaturalInputEmulator();
  const picks = [], drives = [], owned = [];
  const adapter = attachNaturalInput({
    session: emulator.session,
    rayFor: (frame, source) => naturalRayFor(frame, source, emulator.space),
    onMenu,
    isClaimed,
    pick: entry => picks.push(entry),
    onDrive: list => drives.push(list),
    onOwn: report => owned.push(report),
    record: () => {},
  });
  return { emulator, adapter, picks, drives, owned,
    frame: () => adapter.frame(emulator.frame()) };
}

const forward = (origin = [0, 1.4, 0]) => ({ origin, direction: [0, 0, -1] });

test('only a transient pointer is this adapter\'s business', () => {
  assert.equal(TRANSIENT_RAY_MODE, 'transient-pointer');
  assert.equal(isNaturalInputSource({ targetRayMode: 'transient-pointer' }), true);
  assert.equal(isNaturalInputSource({ targetRayMode: 'tracked-pointer' }), false);
  assert.equal(isNaturalInputSource({ targetRayMode: 'gaze' }), false);
  assert.equal(isNaturalInputSource(null), false);
});

test('a pose reads as the aim Mol* and the menu already read', () => {
  const ray = { origin: [0.1, 1.5, -0.2], direction: [0, 0, -1] };
  const read = naturalRayFromPose(poseFromRay(ray));
  assert.deepEqual(read.origin, ray.origin);
  read.direction.forEach((value, axis) => assert.ok(Math.abs(value - ray.direction[axis]) < 1e-12));
  assert.equal(naturalRayFromPose(undefined), undefined);
  assert.equal(naturalRayFromPose({ transform: { matrix: [1, 2, 3], position: { x: 0, y: 0, z: 0 } } }), undefined);
});

test('an unresolved pose belongs to nobody', () => {
  assert.equal(pinchOwner({ ray: undefined, onMenu: false }), NATURAL_OWNER.none);
  assert.equal(pinchOwner({ ray: forward(), onMenu: true }), NATURAL_OWNER.menu);
  assert.equal(pinchOwner({ ray: forward(), onMenu: false }), NATURAL_OWNER.molecule);
});

test('a pinch that has not moved is a tap, and one that has is a drag', () => {
  const start = forward();
  assert.equal(pinchBecameDrag(start, forward([0, 1.4, 0])), false);
  assert.equal(pinchBecameDrag(start, forward([PINCH_DRAG_METERS / 2, 1.4, 0])), false);
  assert.equal(pinchBecameDrag(start, forward([PINCH_DRAG_METERS * 2, 1.4, 0])), true);
  // A wrist that turned without travelling is still carrying the structure.
  const turned = { origin: [0, 1.4, 0], direction: [Math.sin(0.2), 0, -Math.cos(0.2)] };
  assert.ok(aimDegrees([0, 0, -1], turned.direction) > PINCH_DRAG_DEGREES);
  assert.equal(pinchBecameDrag(start, turned), true);
  assert.equal(pinchBecameDrag(undefined, turned), false);
});

test('a pinch on the molecule picks the residue it was aimed at', () => {
  const scene = rig();
  const aim = forward([0, 1.4, -0.05]);
  const pinch = scene.emulator.pinch({ ray: aim });
  pinch.start();
  assert.equal(scene.adapter.owner(pinch.source), NATURAL_OWNER.molecule);
  assert.equal(scene.picks.length, 0, 'the pick waits for a frame');
  pinch.select().end();
  assert.equal(scene.picks.length, 0, 'and it still waits until that frame arrives');
  scene.frame();
  assert.equal(scene.picks.length, 1);
  assert.deepEqual(scene.picks[0].ray.origin, aim.origin);
  assert.equal(scene.picks[0].source, pinch.source);
  assert.ok(scene.picks[0].frame, 'the wearer pose is available for an offscreen-menu summon');
  // A tap never carried the structure, so the gesture machine was never asked
  // for a frame of grab.
  assert.equal(scene.drives.length, 0);
  assert.equal(scene.adapter.active(), 0);
});

test('a pinch that travels grabs instead, and never also picks', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  scene.frame();
  assert.equal(scene.adapter.phase(pinch.source), 'pending');
  assert.equal(scene.drives.length, 0);
  pinch.aimAt(forward([0.25, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.phase(pinch.source), 'grab');
  assert.equal(scene.drives.length, 1);
  const [pointer] = scene.adapter.pointers();
  assert.equal(pointer.handedness, NATURAL_HANDS[0]);
  assert.equal(pointer.buttons, POINTER_GRIP);
  assert.equal(pointer.source, pinch.source);
  assert.deepEqual(pointer.ray.origin, [0.25, 1.4, 0]);
  pinch.aimAt(forward([0.4, 1.4, 0]));
  scene.frame();
  pinch.select().end();
  scene.frame();
  // The release is published as one more frame with the pointer gone, which is
  // what makes the gesture machine bake the placement.
  assert.deepEqual(scene.drives.at(-1), []);
  assert.equal(scene.picks.length, 0, 'a drag is not a pick');
  assert.equal(scene.adapter.active(), 0);
});

test('the grab starts from where the hand is, not from where the pinch began', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  scene.frame();
  pinch.aimAt(forward([0.25, 1.4, 0]));
  scene.frame();
  // The first published pointer is the promotion frame. Feeding it to the real
  // gesture machine has to open the grab with no travel: a baseline taken at
  // the pinch's own origin would move the structure by the whole threshold.
  const step = nextManipulation(idleManipulation(), { right: {
    grip: true, claimed: false, origin: scene.adapter.pointers()[0].ray.origin,
    direction: scene.adapter.pointers()[0].ray.direction } });
  assert.equal(step.started, 'grab');
  assert.equal(step.translation, undefined);
  assert.equal(step.rotation, undefined);
});

test('a release with no select is a cancelled pinch and picks nothing', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  scene.frame();
  pinch.end();
  scene.frame();
  assert.equal(scene.picks.length, 0);
  assert.equal(scene.adapter.active(), 0);
  assert.equal(scene.owned.at(-1).phase, 'cancel');
});

test('a source that vanishes mid-gesture releases the structure where it is', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  pinch.aimAt(forward([0.3, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.phase(pinch.source), 'grab');
  pinch.vanish();
  assert.equal(scene.adapter.active(), 0);
  scene.frame();
  // One closing frame with no pointer, so the placement the wearer watched is
  // baked rather than dropped.
  assert.deepEqual(scene.drives.at(-1), []);
  assert.equal(scene.picks.length, 0);
});

test('a cancelled pinch throws away the pick it had already queued', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  pinch.select();
  pinch.cancel();
  scene.frame();
  assert.equal(scene.picks.length, 0);
  assert.equal(scene.adapter.active(), 0);
});

test('every pinch in a row gets its own pick', () => {
  const scene = rig();
  for (let index = 0; index < 4; index += 1) {
    const pinch = scene.emulator.pinch({ ray: forward([index * 0.01, 1.4, 0]) });
    pinch.start().select().end();
    scene.frame();
    assert.equal(scene.adapter.active(), 0, 'nothing is retained between pinches');
  }
  assert.equal(scene.picks.length, 4);
  assert.equal(scene.picks[3].ray.origin[0], 0.03);
});

test('a pinch that starts on the menu never reaches the molecule', () => {
  const menu = forward([0.8, 1.4, 0]);
  const scene = rig({ onMenu: ray => ray.origin[0] > 0.5 });
  const pinch = scene.emulator.pinch({ ray: menu });
  pinch.start();
  assert.equal(scene.adapter.owner(pinch.source), NATURAL_OWNER.menu);
  // The wearer's gaze drifts off the panel while still pinching. Ownership was
  // settled at the start and does not follow the ray.
  pinch.aimAt(forward([0, 1.4, 0]));
  scene.frame();
  pinch.select().end();
  scene.frame();
  assert.equal(scene.picks.length, 0);
  assert.equal(scene.drives.length, 0);
  assert.deepEqual(scene.adapter.pointers(), []);
});

test('a pinch that starts on the molecule never reaches the menu', () => {
  const onPanel = ray => ray.origin[0] > 0.5;
  const scene = rig({ onMenu: onPanel });
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  assert.equal(scene.adapter.owner(pinch.source), NATURAL_OWNER.molecule);
  // The toolbar starts a gesture only when the pressing ray hits a row, and
  // this is the same predicate the adapter asked. Both cannot be true at once.
  assert.equal(onPanel(forward()), false);
  // The wearer drags the structure and the ray crosses the panel on the way.
  // Ownership does not change hands, and the menu is never consulted again.
  pinch.aimAt(forward([0.9, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.owner(pinch.source), NATURAL_OWNER.molecule);
  assert.equal(scene.adapter.pointers().length, 1);
  pinch.select().end();
  scene.frame();
  assert.deepEqual(scene.drives.at(-1), [], 'the grab released rather than firing a row');
  assert.equal(scene.picks.length, 0);
});

test('a tap that ends over the menu is still the molecule\'s pick', () => {
  const scene = rig({ onMenu: ray => ray.origin[0] > 0.5 });
  const pinch = scene.emulator.pinch({ ray: forward([0.49, 1.4, 0]) });
  pinch.start();
  // A drift under the drag threshold that lands the ray on the panel. Frames
  // keep arriving throughout, and none of them changes who owns the pinch.
  scene.frame();
  pinch.aimAt(forward([0.51, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.phase(pinch.source), 'pending');
  pinch.select().end();
  scene.frame();
  assert.equal(scene.picks.length, 1);
  assert.equal(scene.drives.length, 0);
});

test('a slot the menu is holding is not given to a pinch', () => {
  const held = new Set(['right']);
  const scene = rig({ isClaimed: hand => held.has(hand) });
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  pinch.aimAt(forward([0.3, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.pointers()[0].handedness, 'left');
});

test('a tap made while the other hand is grabbing says so to the pick', () => {
  const scene = rig();
  const grab = scene.emulator.pinch({ ray: forward([-0.2, 1.4, 0]) }).start();
  grab.aimAt(forward([-0.35, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.phase(grab.source), 'grab');
  const tap = scene.emulator.pinch({ ray: forward([0.2, 1.4, 0]) }).start();
  tap.select().end();
  scene.frame();
  assert.equal(scene.picks.length, 1);
  assert.equal(scene.picks[0].grabbing, true);
  grab.select().end();
  scene.frame();
  const alone = scene.emulator.pinch({ ray: forward() }).start();
  alone.select().end();
  scene.frame();
  assert.equal(scene.picks.at(-1).grabbing, false);
});

test('two pinches at once become the two-hand scale', () => {
  const scene = rig();
  const first = scene.emulator.pinch({ ray: forward([-0.2, 1.4, 0]) }).start();
  const second = scene.emulator.pinch({ ray: forward([0.2, 1.4, 0]) }).start();
  first.aimAt(forward([-0.35, 1.4, 0]));
  second.aimAt(forward([0.35, 1.4, 0]));
  scene.frame();
  const hands = scene.adapter.pointers().map(pointer => pointer.handedness).sort();
  assert.deepEqual(hands, ['left', 'right']);
  // A third pinch has no slot left and is ignored rather than fought over.
  const third = scene.emulator.pinch({ ray: forward([0, 1.4, 0]) }).start();
  assert.equal(scene.adapter.owner(third.source), NATURAL_OWNER.none);
  assert.equal(scene.adapter.pointers().length, 2);
});

test('a pinch with no gamepad still reads as a held grip', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  pinch.aimAt(forward([0.3, 1.4, 0]));
  scene.frame();
  const [pointer] = scene.adapter.pointers();
  assert.equal(pointer.source.gamepad, undefined);
  // The grip latch reads the squeeze off the gamepad when there is one and
  // falls back to this bitmask when there is not.
  const latch = createGripLatch();
  assert.equal(latch.read('right', pointer), true);
  assert.equal(latch.read('right', { ...pointer, buttons: 0 }), false);
});

test('denied hand tracking costs the wearer nothing', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward(), hands: false });
  pinch.start();
  assert.equal(pinch.source.hand, undefined);
  assert.equal(scene.adapter.owner(pinch.source), NATURAL_OWNER.molecule);
  pinch.select().end();
  scene.frame();
  assert.equal(scene.picks.length, 1);
});

test('granted hands sit alongside the pinch and keep their own path', () => {
  const scene = rig();
  const left = scene.emulator.addHand('left');
  const right = scene.emulator.addHand('right');
  // The transient source arrives after both hands, which is where visionOS
  // puts it. Nothing here reads an array position.
  const pinch = scene.emulator.pinch({ ray: forward(), hands: true });
  pinch.start();
  assert.deepEqual(scene.emulator.sources().slice(0, 2), [left, right]);
  assert.equal(scene.adapter.owner(pinch.source), NATURAL_OWNER.molecule);
  assert.equal(scene.adapter.owner(left), undefined);
  assert.equal(scene.adapter.owner(right), undefined);
  pinch.select().end();
  scene.frame();
  assert.equal(scene.picks.length, 1);
});

test('a Quest controller is left entirely alone', () => {
  const scene = rig();
  const controller = scene.emulator.addController('right');
  scene.emulator.emit('selectstart', { inputSource: controller, frame: scene.emulator.frame() });
  scene.emulator.emit('select', { inputSource: controller, frame: scene.emulator.frame() });
  scene.emulator.emit('selectend', { inputSource: controller, frame: scene.emulator.frame() });
  scene.frame();
  assert.equal(scene.adapter.active(), 0);
  assert.equal(scene.picks.length, 0);
  assert.equal(scene.drives.length, 0);
  assert.deepEqual(scene.owned, []);
});

test('a select that arrives before its own selectstart still picks', async () => {
  // The pinned IWER emulator sends the two in one dispatch turn, reversed.
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  scene.emulator.emit('select', { inputSource: pinch.source, frame: scene.emulator.frame() });
  pinch.start();
  pinch.end();
  scene.frame();
  assert.equal(scene.picks.length, 1);
});

test('an unclaimed select expires with its dispatch turn', async () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  scene.emulator.emit('select', { inputSource: pinch.source, frame: scene.emulator.frame() });
  await Promise.resolve();
  pinch.start();
  pinch.end();
  scene.frame();
  assert.equal(scene.picks.length, 0, 'a later press must not inherit it');
});

test('a pinch with no resolved pose is declined rather than guessed at', () => {
  const emulator = createNaturalInputEmulator();
  const picks = [], drives = [];
  const adapter = attachNaturalInput({ session: emulator.session,
    rayFor: () => undefined, pick: entry => picks.push(entry), onDrive: list => drives.push(list), record: () => {} });
  const pinch = emulator.pinch({ ray: forward() });
  pinch.start().select().end();
  adapter.frame(emulator.frame());
  assert.equal(picks.length, 0);
  assert.equal(drives.length, 0);
});

test('a menu hit test that throws is read as the menu, never as the molecule', () => {
  const scene = rig({ onMenu: () => { throw Error('no panel'); } });
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start().select().end();
  scene.frame();
  assert.equal(scene.picks.length, 0);
});

test('the session edge unbinds every listener and drops a held pinch', () => {
  const scene = rig();
  const pinch = scene.emulator.pinch({ ray: forward() });
  pinch.start();
  pinch.aimAt(forward([0.3, 1.4, 0]));
  scene.frame();
  assert.equal(scene.adapter.pointers().length, 1);
  assert.equal(scene.adapter.dispose(), true, 'it reports that a pinch was held');
  assert.equal(scene.adapter.active(), 0);
  for (const type of ['selectstart', 'select', 'selectend', 'selectcancel', 'inputsourceschange']) {
    assert.equal(scene.emulator.session.listenerCount(type), 0);
  }
  // Dropped, not baked: an ended session has no placement to write.
  const before = scene.drives.length;
  scene.frame();
  assert.equal(scene.drives.length, before);
});

test('an adapter with no session still runs, so a test never needs one', () => {
  const adapter = createNaturalInput({ record: () => {} });
  assert.equal(adapter.selectStart({ inputSource: { targetRayMode: 'tracked-pointer' } }), undefined);
  assert.equal(adapter.frame(undefined), 0);
  assert.equal(adapter.reset(), false);
});
