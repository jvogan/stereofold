import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { immersiveDepthPlanes, panelDepthBand } from './xr-depth-band.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const source = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function installSceneDepthAdapter(');
assert.ok(start >= 0);
const adapterSource = source.slice(start, source.indexOf('\n}', start) + 2);
const install = new Function('immersiveDepthPlanes', 'panelDepthBand', 'XRRigidTransform',
  `${adapterSource}\nreturn installSceneDepthAdapter;`)(immersiveDepthPlanes, panelDepthBand, class {});

function harness() {
  const requests = [], bands = [], callbacks = [];
  let clipped = false;
  const session = {
    requestAnimationFrame(callback) { callbacks.push(callback); return callbacks.length; },
    updateRenderState(options) { requests.push(options); },
  };
  const original = { request: session.requestAnimationFrame, update: session.updateRenderState };
  const adapter = install({ session, Mat4, space: { getOffsetReferenceSpace: () => ({}) },
    canvas: { camera: { view: Mat4.identity(), scale: .01 }, boundingSphereVisible: { center: [0, 0, -100], radius: 50 } },
    deliberateClipping: () => clipped, presentationDepth: () => ({ near: .01, far: 60 }),
    onMolecularDepth: band => bands.push(band) });
  return { session, original, requests, bands, adapter, setClipped(value) { clipped = value; },
    frame(options) {
      session.requestAnimationFrame(() => session.updateRenderState(options));
      callbacks.shift()(0, { getViewerPose: () => ({ views: syntheticViews() }) });
      return requests.at(-1);
    } };
}

test('XR depth adapter retains the immersive near band when no cutaway is requested', () => {
  const h = harness();
  try {
    const result = h.frame({ depthNear: 1.677, depthFar: 50 });
    assert.equal(result.depthNear, .01, 'the presentation band prevents the automatic 1.677 m near plane');
    assert.equal(result.depthFar, 60);
    assert.deepEqual(h.bands.at(-1), { near: 0, far: Infinity });
    assert.equal(h.frame({ depthNear: .005, depthFar: 50 }).depthNear, .005, 'never raise an already closer plane');
  } finally { h.adapter.restore(); }
});

test('XR depth adapter preserves deliberate cutaway planes and restores the immersive band when cleared', () => {
  const h = harness();
  try {
    h.setClipped(true);
    const cutaway = { depthNear: 1.677, depthFar: 2.5 };
    assert.deepEqual(h.frame(cutaway), cutaway, 'clamping this near plane would silently remove the requested cutaway');
    assert.deepEqual(h.bands.at(-1), { near: 1.677, far: 2.5 });
    h.setClipped(false);
    assert.deepEqual(h.frame(cutaway), { depthNear: .01, depthFar: 60 });
    assert.deepEqual(h.bands.at(-1), { near: 0, far: Infinity });
  } finally { h.adapter.restore(); }
});

test('XR depth adapter leaves non-frame requests alone and restores native session methods', () => {
  const h = harness(), options = { depthNear: .02, depthFar: 50 };
  h.session.updateRenderState(options);
  assert.equal(h.requests.at(-1), options);
  h.adapter.restore();
  assert.equal(h.session.requestAnimationFrame, h.original.request);
  assert.equal(h.session.updateRenderState, h.original.update);
});
