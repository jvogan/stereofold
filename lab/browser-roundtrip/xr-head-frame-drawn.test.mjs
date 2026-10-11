/**
 * Which XR callback drew the frame.
 *
 * The head observer wraps every callback the page registers on the session.
 * The frame-rate watcher registers first, so in every frame its callback runs
 * before Mol*'s, and a headset capture taken after it read a framebuffer Mol*
 * had not drawn into: the byte-identical black eyes of 2026-09-24 and
 * 2026-09-28. The observer now tells its caller whether the callback it
 * follows drew. This runs the module's real observer over a scripted session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
const topLevel = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in immersive-session.mjs`);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
};

function observed({ onInputFrame, isVisible } = {}) {
  const context = vm.createContext({ globalThis: {} });
  vm.runInContext(topLevel('recordXrFrameError') + topLevel('installHeadFrameObserver'), context);
  const queued = [];
  const session = { requestAnimationFrame: callback => { queued.push(callback); return queued.length; } };
  let draws = 0;
  const seen = [];
  context.installHeadFrameObserver({ session, space: {}, mode: 'immersive-ar', drawCount: () => draws,
    onInputFrame, isVisible,
    onHeadFrame: ({ drawn }) => { seen.push(drawn); } });
  return {
    session, seen,
    draw: () => { draws += 1; },
    runFrame: (time = 0) => { const callbacks = queued.splice(0); for (const callback of callbacks) callback(time, {}); },
  };
}

test('only the callback that drew runs drawn-image observation', () => {
  const h = observed();
  // The frame-rate watcher asks first, as `beginSessionDiagnostics` does on
  // entry, and Mol* asks after `canvas.animate()`.
  h.session.requestAnimationFrame(() => {});
  h.session.requestAnimationFrame(() => { h.draw(); });
  h.runFrame();
  assert.deepEqual(h.seen, [true]);
});

test('fresh held input precedes both eyes once despite several callbacks sharing a native timestamp', () => {
  let placed = 0;
  const h = observed({ onInputFrame: () => placed++ });
  const eyes = [];
  for (const timestamp of [100, 114]) {
    h.session.requestAnimationFrame(() => {}); // frame-rate observer arrives first
    h.session.requestAnimationFrame(() => { eyes.push(['left', placed], ['right', placed]); h.draw(); });
    h.session.requestAnimationFrame(() => {}); // transition receipt arrives last
    h.runFrame(timestamp);
  }
  assert.deepEqual(eyes, [['left', 1], ['right', 1], ['left', 2], ['right', 2]]);
  assert.equal(placed, 2, 'the same held input is not applied once per subscriber');
  assert.deepEqual(h.seen, [true, true], 'captures and head evidence still follow only eye draws');
});

test('hidden frames do not process input; resuming and an input failure cannot duplicate delivery', () => {
  let visible = false, calls = 0;
  const h = observed({ isVisible: () => visible, onInputFrame() { calls++; throw Error('input failed'); } });
  for (const timestamp of [10, 24, 38]) {
    h.session.requestAnimationFrame(() => {});
    h.session.requestAnimationFrame(h.draw);
    h.runFrame(timestamp);
    visible = true;
  }
  assert.equal(calls, 2);
  assert.deepEqual(h.seen, [true, true], 'input errors leave subsequent drawing and capture alive');
});

test('a caller with no draw counter learns nothing, and keeps the older behaviour', () => {
  const context = vm.createContext({ globalThis: {} });
  vm.runInContext(topLevel('recordXrFrameError') + topLevel('installHeadFrameObserver'), context);
  const queued = [], seen = [];
  const session = { requestAnimationFrame: callback => { queued.push(callback); return 1; } };
  context.installHeadFrameObserver({ session, space: {}, mode: 'immersive-vr', onHeadFrame: ({ drawn }) => seen.push(drawn) });
  session.requestAnimationFrame(() => {});
  queued.splice(0).forEach(callback => callback(0, {}));
  assert.deepEqual(seen, [undefined]);
});
