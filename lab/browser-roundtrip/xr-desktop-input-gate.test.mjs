import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { InputObserver, ButtonsType } from 'molstar/lib/mol-util/input/input-observer.js';
import { pointerManipulates } from './presentation-motion.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const start = viewer.indexOf('  const interactionSubscriptions = [');
const end = viewer.indexOf('    // A held controller owns inspection', start);
assert.ok(start >= 0 && end > start);
const subscriptions = viewer.slice(start, end) + '];';

function withObserver(action) {
  const saved = { window: globalThis.window, document: globalThis.document };
  const target = () => ({ addEventListener() {}, removeEventListener() {} });
  globalThis.window = { ...target(), devicePixelRatio: 1 };
  globalThis.document = { ...target(), createElement: () => ({ style: {}, remove() {} }) };
  const input = InputObserver.fromElement({ ...target(), clientWidth: 1280, clientHeight: 493 });
  try { return action(input); }
  finally { input.dispose(); for (const key of ['window', 'document']) {
    if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key];
  } }
}

for (const button of [ButtonsType.Flag.Secondary, ButtonsType.Flag.Primary]) {
  for (const firstReleased of ['left', 'right']) {
    test(`actual Mol* two-controller button ${button}, ${firstReleased} release first, leaves no desktop interaction latch`, () => withObserver(input => {
      const c = vm.createContext({ canvas: { input, xr: { isPresenting: { value: true } } },
        inputInteraction: false, xrInputHeld: false, mouseHeld: false, touchHeld: false,
        XR_TRIGGER_BUTTON: ButtonsType.Flag.Trigger, syncPresentationMotion() {} });
      vm.runInContext(subscriptions + '\nconst interactionActive=()=>mouseHeld||touchHeld||inputInteraction||xrInputHeld;', c);
      input.trackedPointers.subscribe(p => { c.xrInputHeld = p.some(pointerManipulates); });
      const gestures = [], ended = [];
      input.gesture.subscribe(e => gestures.push(e)); input.interactionEnd.subscribe(e => ended.push(e));
      const pointer = (hand, buttons, x, pushed = false) => ({ handedness: hand, buttons, x: 100, y: 100, dx: 0, dy: 0,
        ray: { origin: [x, 0, 0], direction: [0, 0, -1] }, axes: [0, 0, 0, pushed ? -.8 : 0] });
      const frame = (left, right, span = .5, pushed = false) => input.updateTrackedPointers([
        pointer('left', left, -span / 2, pushed), pointer('right', right, span / 2, pushed),
      ]);
      frame(0, button); // Ordinary single-controller start must not claim desktop input.
      assert.equal(c.inputInteraction, false);
      frame(button, button); frame(button, button, .53, true);
      assert.ok(gestures.length > 0, 'Real upstream gesture path was not exercised');
      assert.ok(gestures.every(e => e.isEnd === undefined), 'Pinned upstream XR gesture unexpectedly has an end marker');
      assert.equal(c.inputInteraction, false);
      assert.equal(vm.runInContext('interactionActive()', c), true, 'Held native controllers still gate capture');
      frame(firstReleased === 'left' ? 0 : button, firstReleased === 'right' ? 0 : button, .53, true);
      assert.equal(vm.runInContext('interactionActive()', c), true, 'Surviving grip/stick must retain its real gate');
      frame(0, 0, .53); frame(0, 0, .53);
      assert.equal(vm.runInContext('interactionActive()', c), false, 'Neutral controllers must release capture/edit admission');
      if (button === ButtonsType.Flag.Secondary) assert.equal(ended.length, 0, 'Squeeze reproduces the missing upstream interactionEnd');
      c.canvas.xr.isPresenting.value = false;
      assert.equal(vm.runInContext('interactionActive()', c), false, 'XR exit cannot leave a stale desktop latch');
      // Actual desktop gesture ownership still starts/ends normally after XR.
      input.gesture.next({ button: 0, isStart: true }); assert.equal(c.inputInteraction, true);
      input.gesture.next({ button: 0, isEnd: true }); assert.equal(c.inputInteraction, false);
      input.drag.next({ button: 1, buttons: 1 }); assert.equal(c.inputInteraction, true);
      input.interactionEnd.next(); assert.equal(c.inputInteraction, false);
      input.pinch.next({}); assert.equal(c.inputInteraction, true);
      input.interactionEnd.next(); assert.equal(c.inputInteraction, false);
      for (const subscription of vm.runInContext('interactionSubscriptions', c)) subscription.unsubscribe();
    }));
  }
}
