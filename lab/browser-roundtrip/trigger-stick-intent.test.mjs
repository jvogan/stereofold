import assert from 'node:assert/strict';
import test from 'node:test';
import { createTriggerStickIntent } from './trigger-stick-intent.mjs';
import { createXrManipulation, createTriggerDrag } from './xr-manipulate.mjs';
import { createStickModifiers, STICK_MODE } from './xr-locomotion.mjs';
import { createXrThumbstick, STICK_METRES_PER_SECOND, STICK_DEGREES_PER_SECOND } from './xr-buttons.mjs';

const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${actual} ≈ ${expected}`));
function harness(hand = 'left') {
  let at = 0, blocked = false, source = { targetRayMode: 'tracked-pointer', gamepad: { buttons: [{ value: 0 }, { value: 0 }] } };
  const translation = [0,0,0], diagnostics = [], ends = [];
  let scale = 1, yaw = 0, manipulation;
  const intent = createTriggerStickIntent({ isBlocked: name => blocked || manipulation.requiresRelease(name),
    gripHeld: name => manipulation.gripHeld(name) });
  manipulation = createXrManipulation({ now: () => at, isClaimed: () => blocked, triggerTargetDistance: () => 4,
    triggerStickOwnsMotion: name => intent.suppressRayMotion(name),
    onDelta: delta => { if (delta.translation) delta.translation.forEach((v,i) => translation[i] += v); scale *= delta.scale ?? 1; },
    onGrabEnd: value => ends.push(value), record: (kind, detail) => diagnostics.push({ kind, ...detail }), pulse() {} });
  const modifiers = createStickModifiers({ now: () => at, isRayOnMenu: () => blocked,
    gripHeld: name => manipulation.gripHeld(name), requiresRelease: name => manipulation.requiresRelease(name),
    triggerOwned: name => manipulation.triggerOwns(name), triggerDragging: name => manipulation.triggerPhase(name) === 'drag' });
  const thumbstick = createXrThumbstick({ now: () => at, hand, isClaimed: () => blocked, onMove: deflection => {
    if (modifiers.mode(hand) !== STICK_MODE.depthYaw) return;
    const { x, y, seconds } = intent.filter(hand, deflection);
    yaw -= x * STICK_DEGREES_PER_SECOND * seconds;
    const travel = [0,0,-y * STICK_METRES_PER_SECOND * seconds];
    travel.forEach((v,i) => translation[i] += v); manipulation.offsetRayAnchor(hand, travel);
  } });
  return { intent, manipulation, translation, diagnostics, ends, yaw: () => yaw, scale: () => scale,
    blocked(value) { blocked = value; },
    replaceSource() { source = { targetRayMode: 'tracked-pointer', gamepad: { buttons: [{ value: 0 }, { value: 0 }] } }; },
    frame({ x = 0, y = 0, angle = 0, origin = [0,0,0], trigger = true, grip = 0, missing = false, quality = 'tracked-position' } = {}, ms = 14) {
      at += ms; source.gamepad.buttons[0].value = trigger ? 1 : 0; source.gamepad.buttons[1].value = grip;
      const pose = { origin, direction: [Math.sin(angle),0,-Math.cos(angle)], emulatedPosition: quality === 'emulated-position' };
      const pointer = { handedness: hand, source, buttons: (trigger ? 1 : 0) | (grip >= .7 ? 2 : 0), axes: [0,0,x,y],
        ray: missing ? undefined : pose, gripPose: missing ? undefined : pose, hasGripSpace: true,
        poseQualitySource: 'webxr', tracking: missing ? 'unavailable' : quality, gripTracking: missing ? 'unavailable' : quality };
      // This is the integration order required in viewer.mjs; inputs remain
      // genuine, including missing poses and analog release values.
      intent.update([pointer]); manipulation.update([pointer]); modifiers.update([pointer]); thumbstick.update([pointer]);
    },
  };
}

for (const hand of ['left', 'right']) {
  test(`${hand} horizontal top-trigger stick ignores incidental 10 degree wrist turn and minor vertical drift`, () => {
    const h = harness(hand); h.frame({ x: -.8, y: .2 }); h.frame({ x: -.8, y: .2 });
    for (let i = 1; i <= 20; i++) h.frame({ x: -.8, y: .2, angle: Math.PI / 18 * i / 20, origin: [0,0,.01 * i / 20] });
    assert.equal(h.intent.lane(hand), 'yaw'); assert.ok(h.yaw() > 0);
    close(h.translation, [0,0,0]); assert.equal(h.scale(), 1);
  });

  test(`${hand} deliberate vertical stick moves depth while incidental hand motion stays excluded`, () => {
    const h = harness(hand); h.frame({ x: .2, y: -.8 }); h.frame({ x: .2, y: -.8, angle: .1, origin: [.01,0,.01] });
    assert.equal(h.intent.lane(hand), 'depth'); assert.equal(h.yaw(), 0);
    assert.ok(h.translation[2] < 0); close(h.translation.slice(0,2), [0,0]); assert.equal(h.scale(), 1);
  });

  test(`${hand} neutral safely resumes pure trigger ray travel without a catch-up jump`, () => {
    const h = harness(hand); h.frame({ x: .8 }); h.frame({ x: .8, angle: .1, origin: [0,0,.03] });
    h.frame({ angle: .2, origin: [0,0,.05] }); close(h.translation, [0,0,0]);
    assert.equal(h.intent.suppressRayMotion(hand), true, 'neutral boundary rebases once');
    h.frame({ angle: .2, origin: [0,0,.05] }); close(h.translation, [0,0,0]);
    assert.equal(h.intent.suppressRayMotion(hand), false);
    h.frame({ angle: .2, origin: [0,0,.06] });
    assert.ok(Math.hypot(...h.translation) > .01 && Math.hypot(...h.translation) < .09);
  });

  test(`${hand} trigger release and source replacement clear the previous directional lock`, () => {
    const h = harness(hand); h.frame({ x: .8 }); h.frame({ x: .8 });
    h.frame({ trigger: false }); assert.equal(h.intent.lane(hand), undefined); assert.equal(h.intent.suppressRayMotion(hand), false);
    h.frame({ y: .8 }); assert.equal(h.intent.lane(hand), 'depth');
    h.replaceSource(); h.frame({ x: .8 }); assert.equal(h.intent.lane(hand), 'yaw', 'replacement never inherits old depth lock');
    h.intent.reset(); assert.equal(h.intent.suppressRayMotion(hand), false);
  });

  test(`${hand} menu claims, physical grips and held relaxed grips keep their own ownership`, () => {
    const h = harness(hand); h.blocked(true); h.frame({ x: .8 }); assert.equal(h.intent.suppressRayMotion(hand), false);
    h.frame({ trigger: false }); h.blocked(false);
    h.frame({ grip: 1, x: .8 }); assert.equal(h.intent.suppressRayMotion(hand), false);
    h.frame({ grip: .5, x: .8 }); assert.equal(h.manipulation.gripHeld(hand), true); assert.equal(h.intent.suppressRayMotion(hand), false);
  });

  test(`${hand} prolonged pose loss still cancels the held trigger and requires physical release`, () => {
    const h = harness(hand); h.frame({ x: .8 }); h.frame({ x: .8 });
    h.frame({ x: .8, missing: true }); h.frame({ x: .8, missing: true }, 260);
    assert.equal(h.manipulation.requiresRelease(hand), true);
    h.frame({ x: .8 }); assert.equal(h.intent.suppressRayMotion(hand), false);
    const yaw = h.yaw(); h.frame({ x: .8 }); assert.equal(h.yaw(), yaw);
    h.frame({ trigger: false }); h.frame({ x: .8 }); h.frame({ x: .8 }); assert.ok(h.yaw() < yaw);
  });

  test(`${hand} frame gaps and explicit suspension still cancel stick-owned trigger motion`, () => {
    for (const cancellation of ['frame-gap', 'suspend']) {
      const h = harness(hand); h.frame({ x: .8 }); h.frame({ x: .8 });
      const yaw = h.yaw();
      if (cancellation === 'suspend') { h.manipulation.suspend(); h.intent.reset(); }
      h.frame({ x: .8, angle: .2, origin: [0,0,.02] }, cancellation === 'frame-gap' ? 501 : 14);
      assert.equal(h.manipulation.requiresRelease(hand), true, cancellation);
      assert.equal(h.yaw(), yaw); close(h.translation, [0,0,0]);
      h.frame({ x: .8 }); assert.equal(h.intent.suppressRayMotion(hand), false);
      h.frame({ trigger: false }); h.frame({ x: .8 }); h.frame({ x: .8 }); assert.ok(h.yaw() < yaw);
    }
  });

  test(`${hand} brief tracking loss and emulated recovery cannot transport the stick-owned ray`, () => {
    const h = harness(hand); h.frame({ x: .8 }); h.frame({ x: .8 });
    h.frame({ x: .8, missing: true });
    h.frame({ x: .8, angle: .2, origin: [.1,0,.1], quality: 'emulated-position' }, 100);
    h.frame({ x: .8, angle: .3, origin: [.15,0,.1], quality: 'emulated-position' });
    assert.equal(h.manipulation.requiresRelease(hand), false);
    assert.equal(h.intent.lane(hand), 'yaw'); assert.ok(h.yaw() < 0);
    close(h.translation, [0,0,0]); assert.equal(h.scale(), 1);
  });
}

test('balanced diagonal intent stays combined, and dominant intent changes only after recentering', () => {
  const h = harness(); h.frame({ x: .8, y: .6 }); h.frame({ x: .8, y: .6 });
  assert.equal(h.intent.lane('left'), 'diagonal'); assert.ok(h.yaw() < 0 && h.translation[2] > 0);
  h.frame(); h.frame({ x: .8, y: .2 }); assert.equal(h.intent.lane('left'), 'yaw');
  const depth = h.translation[2]; h.frame({ x: .2, y: .8 }); assert.equal(h.translation[2], depth, 'changing direction without recentering does not change modes');
  h.frame(); h.frame({ x: .2, y: .8 }); assert.equal(h.intent.lane('left'), 'depth');
});

test('neutral trigger-only ray dragging remains unchanged', () => {
  const h = harness(); h.frame(); h.frame({}, 230); h.frame({ origin: [0,0,.01] });
  close(h.translation, [0,0,.08]); assert.equal(h.intent.suppressRayMotion('left'), false);
});

test('suppression preserves raw tracking discontinuity and quality rebase diagnostics', () => {
  let at = 0;
  const drag = createTriggerDrag({ targetDistance: () => 4, suppressMotion: () => true, now: () => at });
  const pointer = (x, emulated = false) => ({ buttons: 1, axes: [0,0,.8,0], poseQualitySource: 'webxr',
    tracking: emulated ? 'emulated-position' : 'tracked-position', ray: { origin: [x,0,0], direction: [0,0,-1], emulatedPosition: emulated } });
  drag.read('left', pointer(0)); at += 14; const start = drag.read('left', pointer(0));
  at += 14; const jumped = drag.read('left', pointer(.6)); assert.equal(jumped.rebased, 'tracking-jump'); close(jumped.anchor, start.anchor);
  at += 14; assert.equal(drag.read('left', pointer(.6, true)).rebased, 'tracking-mode');
});

test('missing sources clear policy without inventing pointer samples', () => {
  const intent = createTriggerStickIntent(); intent.update([{ handedness: 'left', buttons: 1, axes: [0,0,.8,0] }]);
  assert.equal(intent.suppressRayMotion('left'), true); intent.update([]); assert.equal(intent.suppressRayMotion('left'), false);
});
