import assert from 'node:assert/strict';
import test from 'node:test';
import { createStickModifiers, STICK_MODE } from './xr-locomotion.mjs';
import { createXrThumbstick } from './xr-buttons.mjs';
import { oneHandScaleFactor } from './xr-manipulate.mjs';

function harness(hand = 'left') {
  let at = 0, grip = false;
  let scale = 1, slide = 0, depth = 0;
  const modes = [];
  const modifiers = createStickModifiers({
    now: () => at,
    gripHeld: () => grip,
    triggerDragging: () => true,
  });
  const stick = createXrThumbstick({ hand, now: () => at, onMove: value => {
    const mode = modifiers.mode(hand);
    modes.push(mode);
    if (mode === STICK_MODE.slide) slide += Math.hypot(value.x, value.y) * value.seconds;
    if (mode === STICK_MODE.depthYaw) depth += Math.hypot(value.x, value.y) * value.seconds;
    if (mode === STICK_MODE.scale) scale *= oneHandScaleFactor(value.y, value.seconds);
  } });

  function frame({ x = 0, y = 0, gripDown = false, triggerDown = false, elapsed = 16 } = {}) {
    at += elapsed;
    grip = gripDown;
    const pointer = {
      handedness: hand,
      buttons: (gripDown ? 2 : 0) | (triggerDown ? 1 : 0),
      axes: [0, 0, x, y],
    };
    // This is the viewer's ordering: classify this frame before the stick uses it.
    modifiers.update([pointer]);
    stick.update([pointer]);
    return modifiers.mode(hand);
  }

  return { frame, modes, values: () => ({ scale, slide, depth }), modifiers, stick,
    time(value) { at = value; } };
}

for (const hand of ['left', 'right']) test(`${hand} bare horizontal push keeps its lane when the same grip is added, then grip release blocks until recenter`, () => {
  const h = harness(hand);
  const mode = () => h.modifiers.mode(hand);
  h.frame({ x: 0.8 });
  h.frame({ x: 0.8 });
  assert.equal(mode(), STICK_MODE.slide);

  h.frame({ x: 0.8, gripDown: true });
  assert.equal(mode(), STICK_MODE.slide,
    'adding a grip to an already-deflected bare stick must not change its lane');
  assert.equal(h.values().scale, 1, 'the held horizontal stick must not resize');

  h.frame({ gripDown: true });
  assert.equal(mode(), STICK_MODE.scale,
    'recentring while the grip is held arms the scale lane');
  h.frame({ y: -0.8, gripDown: true });
  assert.ok(h.values().scale > 1, 'the next vertical deflection scales');

  const releasedScale = h.values().scale;
  h.frame({ y: -0.8 });
  assert.equal(mode(), STICK_MODE.inert,
    'releasing the grip with the stick pushed must stop movement');
  h.frame({ y: -0.8 });
  assert.equal(mode(), STICK_MODE.inert,
    'the released lane stays blocked until the thumb returns to centre');
  assert.equal(h.values().scale, releasedScale, 'scale must not continue after grip release');

  h.frame();
  assert.equal(mode(), STICK_MODE.slide,
    'recentring clears the released-modifier block');
  const beforeSlide = h.values().slide;
  h.frame({ x: 0.8 });
  assert.ok(h.values().slide > beforeSlide, 'a fresh deflection after recenter moves in the bare lane');
});

for (const hand of ['left', 'right']) test(`${hand} trigger release while deflected blocks until recenter`, () => {
  const h = harness(hand);
  const mode = () => h.modifiers.mode(hand);
  h.frame({ x: 0.8, triggerDown: true });
  h.frame({ x: 0.8, triggerDown: true });
  assert.equal(mode(), STICK_MODE.depthYaw);
  assert.ok(h.values().depth > 0);

  const depthBeforeRelease = h.values().depth;
  h.frame({ x: 0.8 });
  assert.equal(mode(), STICK_MODE.inert);
  h.frame({ x: 0.8 });
  assert.equal(mode(), STICK_MODE.inert);
  assert.equal(h.values().depth, depthBeforeRelease,
    'depth/yaw must not continue after releasing its trigger modifier');

  h.frame();
  assert.equal(mode(), STICK_MODE.slide);
});

test('a modifier released after the stick is already centred resumes the bare lane immediately', () => {
  const h = harness();
  h.frame({ gripDown: true });
  assert.equal(h.modifiers.mode('left'), STICK_MODE.scale);
  h.frame({ y: -0.8, gripDown: true });
  h.frame({ gripDown: true });
  const scaleBeforeRelease = h.values().scale;
  assert.ok(scaleBeforeRelease > 1);

  h.frame();
  assert.equal(h.modifiers.mode('left'), STICK_MODE.slide,
    'a release at centre does not require an additional recenter cycle');
});

test('thumbstick timer can be rebased across a paused save and drops a stalled frame', () => {
  let at = 0;
  const moved = [];
  const stick = createXrThumbstick({ hand: 'right', now: () => at,
    onMove: value => moved.push(value.seconds) });
  const pointer = { handedness: 'right', buttons: 0, axes: [0, 0, 0, -1] };

  at += 16; stick.update([pointer]);
  at += 16; stick.update([pointer]);
  assert.equal(moved.length, 1);

  at += 500;
  stick.resetTimer();
  stick.update([pointer]);
  assert.equal(moved.length, 1, 'the first frame after a deferred save is a timing rebase');
  at += 16;
  stick.update([pointer]);
  assert.equal(moved.length, 2);
  assert.equal(moved[1], 0.016);

  at += 250;
  stick.update([pointer]);
  assert.equal(moved.length, 2, 'a frame longer than the documented stall limit is not integrated');
  at += 16;
  stick.update([pointer]);
  assert.equal(moved.length, 3);
  assert.equal(moved[2], 0.016);
});
