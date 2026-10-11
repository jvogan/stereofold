import test from 'node:test';
import assert from 'node:assert/strict';
import { createXrControllerInput } from './xr-controller-input.mjs';
import { createXrManipulation, multiplyMatrix4, oneHandScaleFactor, rotationDegrees, TRIGGER_HOLD_MS } from './xr-manipulate.mjs';
import { createStickModifiers, STICK_MODE } from './xr-locomotion.mjs';
import { createXrThumbstick } from './xr-buttons.mjs';

function harness(hand, quality = 'tracked') {
  let clock = 0, targetZ = -4, scale = 1, onMenu = false;
  const ends = [], translations = [], modes = [], rotations = [];
  const source = { handedness: hand, targetRayMode: 'tracked-pointer', targetRaySpace: {}, gripSpace: {},
    gamepad: { axes: [0, 0, 0, 0], buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })) } };
  const manipulation = createXrManipulation({ now: () => clock, pulse() {}, record() {},
    triggerTargetDistance: () => -targetZ, isRayOnMenu: () => onMenu,
    onTranslate: delta => { targetZ += delta[2]; translations.push([...delta]); },
    onRotate: matrix => rotations.push([...matrix]),
    onGrabEnd: summary => ends.push(summary),
  });
  const modifiers = createStickModifiers({ now: () => clock,
    isRayOnMenu: () => onMenu, gripHeld: manipulation.gripHeld,
    scaleActive: () => manipulation.phase() === 'scale', triggerOwned: manipulation.triggerOwns,
    triggerDragging: name => manipulation.triggerPhase(name) === 'drag', requiresRelease: manipulation.requiresRelease,
  });
  const stick = createXrThumbstick({ hand, now: () => clock, onMove: value => {
    const mode = modifiers.mode(hand); modes.push(mode);
    if (mode === STICK_MODE.scale) scale *= oneHandScaleFactor(value.y, value.seconds);
  } });
  const reader = createXrControllerInput();
  function frame({ elapsed = 100, buttons = 0, z = 0, y = 0, axis = [0, 1, 0], angle = 0 } = {}) {
    clock += elapsed;
    for (const [index, bit] of [[0, 1], [1, 2]]) source.gamepad.buttons[index] = {
      pressed: Boolean(buttons & bit), value: buttons & bit ? 1 : 0,
    };
    source.gamepad.axes[3] = y;
    const [ax, ay, az] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c, half = Math.sin(angle / 2);
    const pose = quality === 'missing' ? null : { emulatedPosition: quality === 'emulated', transform: {
      position: { x: 0, y: 0, z }, orientation: { x: ax * half, y: ay * half, z: az * half, w: Math.cos(angle / 2) },
      matrix: [c+ax*ax*t, ay*ax*t+az*s, az*ax*t-ay*s, 0,
        ax*ay*t-az*s, c+ay*ay*t, az*ay*t+ax*s, 0,
        ax*az*t+ay*s, ay*az*t-ax*s, c+az*az*t, 0, 0,0,z,1],
    } };
    const pointers = reader.read({ predictedDisplayTime: clock, getPose: () => pose }, {}, { inputSources: [source] });
    manipulation.update(pointers); modifiers.update(pointers); stick.update(pointers);
  }
  return { frame, manipulation, ends, translations, modes, rotations, value: () => ({ targetZ, scale }),
    menu: value => { onMenu = value; } };
}

for (const hand of ['left', 'right']) for (const quality of ['tracked', 'emulated']) {
  for (const [name, axis] of [['pitch', [1,0,0]], ['yaw', [0,1,0]], ['roll', [0,0,1]]]) {
    test(`${hand} ${quality} grip ${name} reverses without translating or resizing the molecule`, () => {
      const h = harness(hand, quality);
      h.frame({ buttons: 2, axis });
      for (const angle of [.1, .2]) h.frame({ buttons: 2, axis, angle });
      const halfway = h.rotations.reduce((matrix, delta) => multiplyMatrix4(delta, matrix));
      assert.ok(Math.abs(rotationDegrees(halfway) - .2 * 180 / Math.PI) < 1e-9);
      for (const angle of [.1, 0]) h.frame({ buttons: 2, axis, angle });
      const restored = h.rotations.reduce((matrix, delta) => multiplyMatrix4(delta, matrix));
      assert.ok(rotationDegrees(restored) < 1e-5, 'the reverse wrist path restores the original orientation');
      assert.deepEqual(h.value(), { targetZ: -4, scale: 1 });
      assert.deepEqual(h.translations, []);
      h.frame(); assert.equal(h.ends.length, 1);
    });
  }
}

for (const hand of ['left', 'right']) for (const direction of [-1, 1]) {
  test(`${hand} measured ${direction > 0 ? 'pull then push' : 'push then pull'} reverses fully and repeats after release`, () => {
    const h = harness(hand);
    for (let cycle = 0; cycle < 2; cycle++) {
      h.frame({ buttons: 1 }); h.frame({ buttons: 1, elapsed: TRIGGER_HOLD_MS });
      for (let step = 1; step <= 6; step++) h.frame({ buttons: 1, z: direction * .1 * step });
      assert.ok(Math.abs(h.value().targetZ - (-4 + direction * 4.8)) < 1e-9,
        'the whole amplified motion survives even when the pull passes through the controller plane');
      for (let step = 5; step >= 0; step--) h.frame({ buttons: 1, z: direction * .1 * step });
      assert.ok(Math.abs(h.value().targetZ + 4) < 1e-9, 'the reverse hand path restores the starting location');
      h.frame();
      assert.equal(h.manipulation.phase(), 'idle');
      assert.equal(h.ends.length, cycle + 1, 'one release ends one deliberate gesture');
    }
  });
}

for (const hand of ['left', 'right']) for (const quality of ['tracked', 'emulated', 'missing']) {
  test(`${hand} ${quality} controller grows beyond 4x and shrinks back after release/regrip`, () => {
    const h = harness(hand, quality);
    h.frame(); h.frame({ buttons: 2 });
    for (let step = 0; step < 12; step++) h.frame({ buttons: 2, y: -1 });
    const enlarged = h.value().scale;
    assert.ok(enlarged > 10, 'one controller can grow well beyond the retired 4x ceiling');
    h.frame(); h.frame({ buttons: 2 });
    for (let step = 0; step < 12; step++) h.frame({ buttons: 2, y: 1 });
    assert.ok(Math.abs(h.value().scale - 1) < 1e-12, 'equal reverse stick time restores the original size');
    assert.ok(h.modes.every(mode => mode === STICK_MODE.scale), 'neither direction changes to travel mode');
    assert.equal(h.value().targetZ, -4, 'resize never changes translation');
    h.frame();
  });

  test(`${hand} ${quality} controller can shrink first, release and grow back`, () => {
    const h = harness(hand, quality);
    h.frame(); h.frame({ buttons: 2 });
    for (let step = 0; step < 12; step++) h.frame({ buttons: 2, y: 1 });
    assert.ok(h.value().scale < .1, 'shrinking has no former default-size floor');
    h.frame(); h.frame({ buttons: 2 });
    for (let step = 0; step < 12; step++) h.frame({ buttons: 2, y: -1 });
    assert.ok(Math.abs(h.value().scale - 1) < 1e-12);
    assert.equal(h.value().targetZ, -4);
  });
}

for (const hand of ['left', 'right']) test(`${hand} targeted drag stays owned when its ray crosses the menu and reverses`, () => {
  const h = harness(hand);
  h.frame({ buttons: 1 }); h.frame({ buttons: 1, elapsed: TRIGGER_HOLD_MS });
  h.frame({ buttons: 1, z: .1 });
  h.menu(true);
  h.frame({ buttons: 1, z: .2 }); h.frame({ buttons: 1, z: .1 }); h.frame({ buttons: 1, z: 0 });
  assert.ok(Math.abs(h.value().targetZ + 4) < 1e-9);
  assert.equal(h.manipulation.triggerPhase(hand), 'drag');
  h.frame();
  assert.equal(h.ends.length, 1);
  h.frame({ buttons: 1 }); h.frame({ buttons: 1, elapsed: TRIGGER_HOLD_MS });
  h.frame({ buttons: 1, z: .1 });
  assert.equal(h.manipulation.triggerPhase(hand), 'blocked', 'a new menu-started press belongs to the menu');
  assert.ok(Math.abs(h.value().targetZ + 4) < 1e-9);
});
