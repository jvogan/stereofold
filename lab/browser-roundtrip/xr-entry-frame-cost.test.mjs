import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beginSceneTransition, watchFrameCost } from './xr-render-budget.mjs';

const source = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
function sliceBetween(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production slice: ${start}`);
  return source.slice(from, to);
}
const definitions = sliceBetween('function installSceneDepthAdapter(',
  '\n/**\n * The production XR boundary');
const install = sliceBetween('        record.presentationDepth =', '        plugin.animationLoop.stop');
const cleanup = sliceBetween('      try { record.restoreLayer?.(); }', '      // The immersive quality');

function harness() {
  let time = 0;
  const queued = [], samples = [], order = [];
  const native = callback => { queued.push(callback); return queued.length; };
  const updateRenderState = () => {};
  const session = { requestAnimationFrame: native, updateRenderState };
  const record = { toolbar: {
    syncPose() { order.push('menu-pose'); time += 5; },
    syncInput() { order.push('menu-input'); time += 3; },
  } };
  const emit = (kind, detail) => samples.push({ kind, ...detail });
  const context = vm.createContext({
    record, session, active: record,
    plugin: {}, canvas: {}, space: {}, Mat4: {},
    xrMode: 'immersive-ar', sessionVisibility: 'visible',
    frameCount: 0, viewCount: 0,
    blindVisibility: () => false,
    deliberateClipping: () => false,
    presentationDepthRange: () => undefined,
    installPresentationDepthAdapter: () => ({ restore() {} }),
    // The session's draw counter option; this harness draws nothing.
    getDrawCount: () => undefined,
    onInputFrame() { order.push('molecular-input'); },
    onHeadFrame() { order.push('drawn-head'); time += 200; },
    watchFrameCost: options => watchFrameCost({
      ...options, scope: {}, now: () => time, intervalMs: 1, record: emit,
    }),
  });
  vm.runInContext(definitions + '\n' + install, context);
  return { record, session, native, updateRenderState, samples, context, order,
    transition: () => beginSceneTransition({ session, operation: 'entry', now: () => time, record: emit }),
    render() {
      function render() { order.push('eye-draw'); time += 11; session.requestAnimationFrame(render); }
      session.requestAnimationFrame(render);
    },
    frame() {
      queued.shift()(time, { getViewerPose: () => ({ views: [{}, {}] }) });
      assert.equal(queued.length, 1, 'the next frame is already armed');
    },
    restore() { vm.runInContext(cleanup, context); },
  };
}

test('entry frame timing includes a synchronous 200 ms head observer and preserves the next frame', () => {
  const h = harness(), transition = h.transition();
  try {
    h.render();
    for (let i = 0; i < 2; i++) {
      h.frame();
      const sample = h.samples.filter(row => row.kind === 'frame-cost')[i];
      assert.equal(sample.callbackCount, 1);
      assert.equal(sample.frameMs, 219);
      assert.equal(sample.maxFrameMs, 219);
      assert.equal(sample.overlayMs, 208);
      assert.equal(sample.drawMs, 11);
      assert.equal(sample.longFrames, 1);
      assert.equal(sample.maxFrameGapMs, i === 0 ? null : 219);
      assert.deepEqual(h.order.slice(i * 5), ['menu-pose', 'menu-input', 'molecular-input', 'eye-draw', 'drawn-head']);
    }
    transition.finish();
    const result = h.samples.find(row => row.kind === 'transition' && row.phase === 'complete');
    assert.equal(result.frames, 2);
    assert.equal(result.maxCallbackMs, 219);
    assert.equal(result.maxFrameGapMs, 219);
  } finally { transition.finish(); h.restore(); }
});

test('entry frame wrappers unwind in reverse installation order without surviving teardown', () => {
  const h = harness(), restored = [];
  for (const [name, method] of [['headObserver', 'restore'], ['frameCost', 'stop'],
    ['sceneDepth', 'restore'], ['presentationDepth', 'restore']]) {
    const original = h.record[name][method];
    h.record[name][method] = () => { restored.push(name); original(); };
  }
  h.restore();
  assert.deepEqual(restored, ['headObserver', 'frameCost', 'sceneDepth', 'presentationDepth']);
  assert.equal(h.session.requestAnimationFrame, h.native, 'no animation frame wrapper survives teardown');
  assert.equal(h.session.updateRenderState, h.updateRenderState, 'the scene depth wrapper is also removed');
});
