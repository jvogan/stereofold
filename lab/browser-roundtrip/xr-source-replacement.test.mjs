import assert from 'node:assert/strict';
import test from 'node:test';
import { createXrManipulation, TRIGGER_HOLD_MS } from './xr-manipulate.mjs';

for (const hand of ['left', 'right']) for (const prior of ['pending', 'drag', 'blocked']) {
  test(`${hand} replacement trigger starts fresh after the retired source's ${prior} press`, () => {
    let at = 0;
    const retired = { targetRayMode: 'tracked-pointer' }, replacement = { targetRayMode: 'tracked-pointer' };
    const translations = [], ends = [];
    const manipulation = createXrManipulation({ now: () => at, record() {}, pulse() {},
      triggerTargetDistance: pointer => pointer.source === retired && prior === 'blocked' ? undefined : 2,
      onTranslate: value => translations.push(value), onGrabEnd: value => ends.push(value) });
    const update = (source, x, buttons = 1) => manipulation.update([{ handedness: hand, source, buttons,
      ray: { origin: [x, 1.4, 0], direction: [0, 0, -1], emulatedPosition: false }, emulatedPosition: false }]);
    update(retired, 0);
    if (prior === 'drag') { at += TRIGGER_HOLD_MS; update(retired, 0); at += 10; update(retired, .02); }
    assert.equal(manipulation.triggerPhase(hand), prior);
    const before = translations.length;

    at += 10; update(replacement, .3);
    assert.equal(manipulation.triggerPhase(hand), 'pending', 'new source owns a new trigger intent');
    assert.equal(manipulation.consumesPick(hand), false, 'a fresh tap does not inherit the retired drag pick guard');
    assert.equal(translations.length, before, 'replacement must not translate from the retired pose');
    assert.equal(ends.length, prior === 'drag' ? 1 : 0, 'the old transform finishes exactly once');

    at += TRIGGER_HOLD_MS; update(replacement, .3);
    assert.equal(manipulation.phase(), 'grab', 'the replacement can hold the molecule without an extra release');
    at += 10; update(replacement, .32);
    assert.ok(translations.length > before);
    assert.ok(Math.abs(translations.at(-1)[0] - .05) < 1e-10, 'movement uses the replacement baseline and gain');
    at += 10; update(replacement, .32, 0);
    assert.equal(manipulation.phase(), 'idle');
    assert.equal(ends.length, prior === 'drag' ? 2 : 1);
  });
}
