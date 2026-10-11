import test from 'node:test';
import assert from 'node:assert/strict';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';

test('an XR callback failure is contained and renews the one-shot frame subscription', async () => {
  const runtime = await toolbarFrameRuntime();
  const callbacks = [];
  const session = {
    requestAnimationFrame(callback) { callbacks.push(callback); return callbacks.length; },
  };
  const observer = runtime.installFrameProbe({ toolbar: { syncPose() {}, syncInput() {} } }, session, {});
  const previous = globalThis.__stereofoldDiagnostics, diagnostics = [];
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => diagnostics.push({ kind, detail }) };
  try {
    session.requestAnimationFrame(() => { throw new Error('render fault'); });
    const frame = { getViewerPose: () => ({ views: [] }) };
    assert.doesNotThrow(() => callbacks.shift()(0, frame));
    assert.equal(callbacks.length, 1, 'the observer renews the frame after a thrown callback');
    assert.deepEqual(diagnostics.map(entry => entry.kind), ['xr-frame-error']);
    assert.equal(diagnostics[0].detail.phase, 'renderer');
  } finally {
    observer.restore();
    if (previous === undefined) delete globalThis.__stereofoldDiagnostics;
    else globalThis.__stereofoldDiagnostics = previous;
  }
});

test('toolbar frame work cannot abort the renderer callback', async () => {
  const runtime = await toolbarFrameRuntime();
  const callbacks = [];
  const session = {
    requestAnimationFrame(callback) { callbacks.push(callback); return callbacks.length; },
  };
  const observer = runtime.installFrameProbe({ toolbar: {
    syncPose() { throw new Error('stale panel'); },
    syncInput() { throw new Error('bad ray'); },
  } }, session, {});
  const previous = globalThis.__stereofoldDiagnostics, diagnostics = [];
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => diagnostics.push({ kind, detail }) };
  try {
    let rendered = 0;
    const render = () => {
      rendered += 1;
      session.requestAnimationFrame(render);
    };
    session.requestAnimationFrame(render);
    const frame = { getViewerPose: () => ({ views: [] }) };
    for (let index = 1; index <= 2; index += 1) {
      diagnostics.length = 0;
      assert.doesNotThrow(() => callbacks.shift()(index, frame));
      assert.equal(rendered, index, 'rendering continues after toolbar failures');
      assert.equal(callbacks.length, 1, 'the next one-shot frame retains the observer');
      assert.equal(diagnostics.length, 2, 'both toolbar failures are recorded independently');
      for (const [phase, error] of [['toolbar-pose', 'stale panel'], ['toolbar-input', 'bad ray']]) {
        const diagnostic = diagnostics.find(entry => entry.detail.phase === phase);
        assert.ok(diagnostic, `${phase} is recorded on frame ${index}`);
        assert.equal(diagnostic.kind, 'xr-frame-error');
        assert.equal(diagnostic.detail.error, error);
      }
    }
  } finally {
    observer.restore();
    if (previous === undefined) delete globalThis.__stereofoldDiagnostics;
    else globalThis.__stereofoldDiagnostics = previous;
  }
});
