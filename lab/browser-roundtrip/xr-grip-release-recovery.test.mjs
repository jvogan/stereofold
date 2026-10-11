import assert from 'node:assert/strict';
import test from 'node:test';
import { createXrManipulation, GRIP_RELEASE, TRIGGER_TRACKING_GRACE_MS, MANIPULATION_FRAME_GAP_MS } from './xr-manipulate.mjs';

for (const hand of ['left', 'right']) for (const interruption of ['tracking', 'frame-gap']) {
  test(`${hand} ${interruption} cancellation waits for analog grip release before regrabbing`, () => {
    let at = 0;
    const gamepad = { buttons: [{ value: 0 }, { value: 1 }] }, source = { gamepad, targetRayMode: 'tracked-pointer' };
    const translations = [], ends = [];
    const manipulation = createXrManipulation({ now: () => at, record() {}, pulse() {},
      onTranslate: value => translations.push(value), onGrabEnd: value => ends.push(value) });
    const update = (value, x = 0) => {
      gamepad.buttons[1].value = value;
      manipulation.update([{ handedness: hand, source, buttons: value >= .7 ? 2 : 0,
        ray: { origin: [x, 1.4, 0], direction: [0, 0, -1] } }]);
    };
    update(1); at += 10; update(.5, .02);
    assert.equal(manipulation.phase(), 'grab', 'relaxed grip remains held before interruption');
    if (interruption === 'tracking') {
      at += 10; manipulation.update([]);
      at += TRIGGER_TRACKING_GRACE_MS + 1; manipulation.update([]);
    } else { at += MANIPULATION_FRAME_GAP_MS + 1; update(.5, .04); }
    assert.equal(ends.length, 1);
    assert.equal(manipulation.requiresRelease(hand), true);
    const count = translations.length;
    at += 10; update(.5, .2);
    assert.equal(manipulation.requiresRelease(hand), true, 'cancellation cannot mistake a relaxed grip for physical release');
    at += 10; update(1, .24);
    assert.equal(manipulation.phase(), 'idle', 'squeezing again without releasing remains cancelled');
    assert.equal(translations.length, count);
    at += 10; update(GRIP_RELEASE - .01, .24);
    assert.equal(manipulation.requiresRelease(hand), false);
    at += 10; update(1, .24);
    assert.equal(manipulation.phase(), 'grab');
    at += 10; update(1, .26);
    assert.ok(Math.abs(translations.at(-1)[0] - .02) < 1e-10);
  });
}
