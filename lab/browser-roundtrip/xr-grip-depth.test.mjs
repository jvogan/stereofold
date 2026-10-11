import assert from 'node:assert/strict';
import test from 'node:test';
import { createXrManipulation, gripDepthTranslation, GRIP_DEPTH_GAIN, GRIP_TRACKING_GRACE_MS } from './xr-manipulate.mjs';

const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} ≈ ${expected}`));
function harness(hand = 'right') {
  let at = 0, axis = [0, 0, -1], samples = 0, claimed = false;
  const deltas = [], ends = [];
  const sources = Object.fromEntries(['left', 'right'].map(name => [name,
    { targetRayMode: 'tracked-pointer', gamepad: { buttons: [{ value: 0 }, { value: 1 }] } }]));
  const manipulation = createXrManipulation({ now: () => at, record() {}, pulse() {}, isClaimed: () => claimed,
    gripDepthAxis: () => { samples++; return axis; },
    onDelta: delta => deltas.push(delta), onGrabEnd: value => ends.push(value) });
  const pointer = ({ origin = [0, 1.4, 0], quality = 'tracked-position', value = 1, missing = false,
    direction = [0, 0, -1], orientation = [0, 0, 0, 1], name = hand } = {}) => {
    sources[name].gamepad.buttons[1].value = value;
    const pose = { origin, direction, orientation, emulatedPosition: quality === 'tracked-position' ? false : quality === 'emulated-position' ? true : undefined };
    return { handedness: name, source: sources[name], buttons: value >= .7 ? 2 : 0,
      hasGripSpace: true, poseQualitySource: 'webxr', tracking: 'tracked-position', gripTracking: missing ? 'unavailable' : quality,
      ray: { ...pose, emulatedPosition: false }, gripPose: missing ? undefined : pose };
  };
  return { manipulation, deltas, ends, pointer, samples: () => samples, setAxis: value => { axis = value; }, setClaimed: value => { claimed = value; },
    replaceSource() { sources[hand] = { targetRayMode: 'tracked-pointer', gamepad: { buttons: [{ value: 0 }, { value: 1 }] } }; },
    frame(options = {}, ms = 14) { at += ms; manipulation.update([pointer(options)]); },
    frameMany(options, ms = 14) { at += ms; manipulation.update(options.map(pointer)); },
    absent(ms = 14) { at += ms; manipulation.update([]); } };
}

test('depth gain normalizes the fixed head-to-target axis and preserves lateral travel', () => {
  close(gripDepthTranslation([.12, .03, .12], [0, 0, -9]), [.12, .03, .12 * GRIP_DEPTH_GAIN]);
  close(gripDepthTranslation([.1, .2, .3], undefined), [.1, .2, .3]);
  close(gripDepthTranslation([.1, 0, .1], [1, 0, -1]), [.1, 0, .1]);
});

for (const hand of ['left', 'right']) {
  for (const owner of ['menu', 'molecule']) for (const source of ['same', 'replacement']) {
    test(`${hand} same-instance reset starts a fresh ${source} source after ${owner} ownership`, () => {
      const h = harness(hand);
      h.setClaimed(owner === 'menu'); h.frame();
      h.frame({ origin: [0, 1.4, .02] });
      const before = h.deltas.length, ends = h.ends.length;
      assert.equal(h.manipulation.reset(), owner === 'molecule');
      assert.equal(h.manipulation.phase(), 'idle');
      assert.equal(h.manipulation.requiresRelease(hand), false, 'session reset ends the prior physical-press lifecycle');
      assert.equal(h.ends.length, ends, 'reset does not bake the old placement');
      if (source === 'replacement') h.replaceSource();
      h.setClaimed(false); h.setAxis([1, 0, 0]);
      h.frame({ origin: [.4, 1.4, .3] });
      assert.equal(h.manipulation.phase(), 'grab', 'old menu ownership cannot cancel the new lifecycle');
      assert.equal(h.deltas.length, before, 'the first measured pose is a fresh baseline');
      assert.equal(h.samples(), 2, 'the new lifecycle samples its current head-to-target axis');
      h.frame({ origin: [.42, 1.4, .32] });
      close(h.deltas.at(-1).translation, [.05, 0, .02]);
      h.frame({ value: .2, origin: [.42, 1.4, .32] });
      assert.equal(h.manipulation.phase(), 'idle');
      assert.equal(h.ends.length, ends + 1);
      h.setAxis([0, 0, -1]);
      h.frame({ origin: [.42, 1.4, .32] });
      h.frame({ origin: [.42, 1.4, .34] });
      close(h.deltas.at(-1).translation, [0, 0, .05]);
      assert.equal(h.samples(), 3, 'a subsequent physical press also samples a fresh axis');
    });
  }

  test(`${hand} visibility suspension preserves the held menu grip release gate`, () => {
    const h = harness(hand); h.setClaimed(true); h.frame(); h.frame({ value: .5 });
    h.manipulation.suspend(); h.setClaimed(false);
    h.frame({ origin: [.3, 1.4, .3], value: .5 });
    h.frame({ origin: [.32, 1.4, .32] });
    assert.equal(h.manipulation.requiresRelease(hand), true);
    assert.equal(h.manipulation.phase(), 'idle');
    assert.deepEqual(h.deltas, []);
    h.frame({ value: .2 }); h.frame();
    assert.equal(h.manipulation.requiresRelease(hand), false);
    assert.equal(h.manipulation.phase(), 'grab');
    h.frame({ origin: [0, 1.4, .02] });
    close(h.deltas.at(-1).translation, [0, 0, .05]);
  });

  test(`${hand} bottom grip pushes and pulls 2.5x without scaling or following wrist direction`, () => {
    const h = harness(hand);
    h.frame();
    h.setAxis([1, 0, 0]); // The target/head may change after the initial press.
    h.frame({ origin: [.03, 1.42, .12], direction: [0, -1, 0], orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
    close(h.deltas.at(-1).translation, [.03, .02, .3]);
    assert.ok(h.deltas.at(-1).rotation, 'wrist rotation retains its own effect');
    assert.equal(h.deltas.at(-1).scale, undefined);
    h.frame({ origin: [0, 1.4, 0] });
    close(h.deltas.at(-1).translation, [-.03, -.02, -.3]);
    assert.equal(h.samples(), 1, 'depth axis belongs to the physical press');
  });

  test(`${hand} gain follows raw jump checks, so a fast valid pull survives`, () => {
    const h = harness(hand); h.frame();
    h.frame({ origin: [0, 1.4, .4] });
    close(h.deltas.at(-1).translation, [0, 0, 1]);
    h.frame({ origin: [0, 1.4, 1.1] });
    assert.equal(h.deltas.length, 1, 'raw 70cm jump rebases without movement');
    h.frame({ origin: [0, 1.4, 1.12] });
    close(h.deltas.at(-1).translation, [0, 0, .05]);
  });

  for (const quality of ['emulated-position', 'unknown']) test(`${hand} ${quality} grip cannot supply depth travel and recovery rebases`, () => {
    const h = harness(hand); h.frame();
    h.frame({ origin: [0, 1.4, .1], quality });
    h.frame({ origin: [0, 1.4, .3], quality });
    assert.equal(h.deltas.length, 0);
    h.frame({ origin: [0, 1.4, .4] });
    assert.equal(h.deltas.length, 0, 'returning tracked pose establishes its baseline');
    h.frame({ origin: [0, 1.4, .42] });
    close(h.deltas.at(-1).translation, [0, 0, .05]);
  });

  test(`${hand} live grip resumes after 600ms occlusion without releasing or jumping`, () => {
    const h = harness(hand); h.frame(); h.frame({ origin: [0, 1.4, .02] });
    const before = h.deltas.length;
    for (let i = 0; i < 4; i++) h.frame({ missing: true, value: .5 }, 200);
    assert.equal(h.manipulation.phase(), 'grab');
    assert.equal(h.manipulation.requiresRelease(hand), false);
    assert.equal(h.deltas.length, before);
    h.frame({ origin: [0, 1.4, .4], value: .5 });
    assert.equal(h.deltas.length, before);
    h.frame({ origin: [0, 1.4, .42], value: .5 });
    close(h.deltas.at(-1).translation, [0, 0, .05]);
    assert.equal(h.samples(), 1);
  });

  test(`${hand} analog release during lost tracking ends ownership immediately`, () => {
    const h = harness(hand); h.frame(); h.frame({ missing: true }, 200);
    h.frame({ missing: true, value: .2 });
    assert.equal(h.manipulation.phase(), 'idle');
    assert.equal(h.ends.length, 1);
    h.frame({ origin: [0, 1.4, .4], value: .2 });
    assert.equal(h.manipulation.phase(), 'idle');
    h.frame({ origin: [0, 1.4, .4] });
    assert.equal(h.samples(), 2);
  });

  for (const interruption of ['timeout', 'source-ended', 'blur']) test(`${hand} ${interruption} prevents sticky grip resumption`, () => {
    const h = harness(hand); h.frame();
    if (interruption === 'timeout') {
      for (let i = 0; i <= Math.ceil(GRIP_TRACKING_GRACE_MS / 200) + 1; i++) h.frame({ missing: true, value: .5 }, 200);
    } else if (interruption === 'source-ended') { h.absent(); h.absent(300); }
    else h.manipulation.suspend();
    assert.equal(h.manipulation.phase(), 'idle');
    assert.equal(h.manipulation.requiresRelease(hand), true);
    h.frame({ origin: [0, 1.4, .3], value: .5 });
    assert.equal(h.manipulation.phase(), 'idle');
    h.frame({ value: .2 }); h.frame();
    assert.equal(h.manipulation.phase(), 'grab');
  });

  for (const cause of ['menu-timeout', 'menu-cancel', 'frame-gap']) test(`${hand} ${cause} cannot transfer a held menu grip into a molecule grab`, () => {
    const h = harness(hand); h.setClaimed(true); h.frame();
    assert.equal(h.manipulation.phase(), 'idle');
    if (cause === 'menu-timeout') {
      for (let i = 0; i < 18; i++) h.frame({ missing: true, value: .5 }, 100);
    } else if (cause === 'frame-gap') h.frame({ value: .5 }, 600);
    h.setClaimed(false); // The toolbar's cancellation drops shared ownership.
    h.frame({ missing: cause === 'menu-timeout', value: .5 });
    assert.equal(h.manipulation.requiresRelease(hand), true, 'the cancelled menu press also blocks the molecule scale stick');
    h.frame({ origin: [0, 1.4, .3], value: .5 });
    h.frame({ origin: [0, 1.4, .35] });
    assert.equal(h.manipulation.phase(), 'idle');
    assert.deepEqual(h.deltas, []);
    h.frame({ origin: [0, 1.4, .35], value: .2 });
    assert.equal(h.manipulation.requiresRelease(hand), false);
    h.frame({ origin: [0, 1.4, .35] });
    h.frame({ origin: [0, 1.4, .37] });
    assert.equal(h.manipulation.phase(), 'grab');
    close(h.deltas.at(-1).translation, [0, 0, .05]);
  });
}

test('two grips retain measured midpoint travel and separation scaling', () => {
  const h = harness();
  const pair = (z, spread = .2) => [{ name: 'right', origin: [spread, 1.4, z] }, { name: 'left', origin: [-spread, 1.4, z] }];
  h.frameMany(pair(0)); h.frameMany(pair(0));
  assert.equal(h.manipulation.phase(), 'scale');
  h.frameMany(pair(.1, .22));
  close(h.deltas.at(-1).translation, [0, 0, .1]);
  assert.ok(Math.abs(h.deltas.at(-1).scale - 1.1) < 1e-9);
  h.frameMany([{ name: 'right', origin: [.22, 1.4, .1] }, { name: 'left', value: 0 }]);
  const count = h.deltas.length;
  h.frame({ origin: [.22, 1.4, .12] });
  assert.equal(h.deltas.length, count + 1);
  close(h.deltas.at(-1).translation, [0, 0, .05]);
});

for (const kind of ['transient-pointer', 'tracked-pointer-without-analog']) test(`${kind} retains short pose-loss cancellation`, () => {
  let at = 0;
  const manipulation = createXrManipulation({ now: () => at, record() {}, pulse() {} });
  const source = kind === 'transient-pointer'
    ? { targetRayMode: kind, gamepad: { buttons: [{ value: 0 }, { value: 1 }] } }
    : { targetRayMode: 'tracked-pointer' };
  const pointer = { handedness: 'right', source, buttons: 2,
    ray: { origin: [0, 1.4, 0], direction: [0, 0, -1] } };
  manipulation.update([pointer]);
  for (let i = 0; i < 5; i++) { at += 100; manipulation.update([{ ...pointer, ray: undefined }]); }
  assert.equal(manipulation.requiresRelease('right'), true);
  manipulation.update([pointer]);
  assert.equal(manipulation.phase(), 'idle', 'a returning pose cannot revive the timed-out press');
  manipulation.update([{ ...pointer, source: { targetRayMode: 'tracked-pointer' }, buttons: 0 }]);
  assert.equal(manipulation.requiresRelease('right'), false);
});
