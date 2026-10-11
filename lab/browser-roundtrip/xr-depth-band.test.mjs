import { strict as assert } from 'node:assert';
import test from 'node:test';
import { immersiveDepthPatch, immersiveDepthPlanes, panelDepthBand, XR_FAR_METERS } from './xr-depth-band.mjs';

/**
 * A structure pushed far enough away used to disappear.
 *
 * The numbers below are the stock immersive fit. `sceneRadiusInMeters` is 0.9,
 * so a structure of scene radius 30 gives `camera.scale` 0.03, and Mol*'s own
 * `updateClip` then puts the far plane about 3 m from the wearer.
 */
const FITTED_SCALE = 0.03;

test('the far plane reaches across a room at the fitted scale', () => {
  const patch = immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 50 });
  assert.ok(patch, 'a fitted session needs the band written');
  // `updateClip` multiplies minFar by camera.scale, so this is 50 m.
  assert.equal(patch.minFar * FITTED_SCALE, XR_FAR_METERS);
  assert.ok(XR_FAR_METERS >= 50, 'the far plane must reach at least 50 m');
});

test('fog is off while the wearer can push the structure away', () => {
  assert.equal(immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 50 }).fog, 0);
  assert.equal(immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 12 }).fog, 0);
});

test('a structure scaled 3x keeps the same far plane in metres', () => {
  const seated = immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 50 });
  const scaled = immersiveDepthPatch({ cameraScale: FITTED_SCALE * 3, currentFog: 0, lastMinFar: seated.minFar });
  assert.ok(scaled, 'a scale gesture has to rewrite minFar');
  assert.equal(Number((scaled.minFar * FITTED_SCALE * 3).toFixed(6)), XR_FAR_METERS);
  assert.equal(Number((scaled.minFar * 3).toFixed(6)), Number(seated.minFar.toFixed(6)));
});

test('an unchanged scale with fog already off writes nothing', () => {
  const first = immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 50 });
  assert.equal(immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 0, lastMinFar: first.minFar }), undefined);
  // Fog that came back on is a write even when the plane did not move.
  assert.ok(immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 50, lastMinFar: first.minFar }));
  // A gesture under one percent of the plane is not worth a camera write.
  assert.equal(immersiveDepthPatch({ cameraScale: FITTED_SCALE * 1.002, currentFog: 0, lastMinFar: first.minFar }), undefined);
  assert.ok(immersiveDepthPatch({ cameraScale: FITTED_SCALE * 1.05, currentFog: 0, lastMinFar: first.minFar }));
});

test('an unreadable camera scale writes nothing rather than an infinite plane', () => {
  for (const cameraScale of [0, -1, NaN, Infinity, undefined, '0.03']) {
    assert.equal(immersiveDepthPatch({ cameraScale, currentFog: 50 }), undefined, `scale ${String(cameraScale)}`);
  }
  assert.equal(immersiveDepthPatch({ cameraScale: FITTED_SCALE, currentFog: 50, farMeters: 0 }), undefined);
});

/**
 * Measured on a Quest 2 running the microtubule wall stage.
 *
 * `render-budget` logged `cameraScale` 0.00713 and `depthNearMeters` 1.677 for
 * the wall chapter. Nobody had asked for a cutaway: that plane is Mol*'s own
 * `updateClip` arithmetic over a scene bounding sphere seven thousand units
 * across. Reporting it to the spatial panel as a plane to clear is what began
 * the chain that ended with `plate-standoff` recording `plateNear` 3.401 and
 * `pierced` 100 of 107.
 */
const WALL_NEAR_METRES = 1.677, WALL_FAR_METRES = 52.35;
/** The panel's own seat: 0.96 m of bearing, so its nearest plate lands here. */
const PANEL_NEAR_METRES = 0.9, PANEL_FAR_METRES = 1.25;

test('an automatic near plane is never a plane the panel has to clear', () => {
  const band = panelDepthBand({ clipped: false, depthNear: WALL_NEAR_METRES, depthFar: WALL_FAR_METRES });
  assert.equal(band.near, 0, 'this number exiled the menu to 3.85 m on the wall stage');
  assert.equal(band.far, Infinity, 'the far plane has always been gated on a cutaway');
});

test('a cutaway the wearer asked for is still a plane the panel has to clear', () => {
  const band = panelDepthBand({ clipped: true, depthNear: WALL_NEAR_METRES, depthFar: WALL_FAR_METRES });
  assert.equal(band.near, WALL_NEAR_METRES);
  assert.equal(band.far, WALL_FAR_METRES);
  // A session that never reported a plane leaves the panel unconstrained.
  assert.deepEqual(panelDepthBand({ clipped: true }), { near: 0, far: Infinity });
  assert.deepEqual(panelDepthBand(), { near: 0, far: Infinity });
});

test('an unrestricted frame opens its near plane to admit the panel', () => {
  const planes = immersiveDepthPlanes({ clipped: false, depthNear: WALL_NEAR_METRES, depthFar: WALL_FAR_METRES,
    presentationNear: PANEL_NEAR_METRES, presentationFar: PANEL_FAR_METRES });
  assert.equal(planes.depthNear, PANEL_NEAR_METRES, 'the menu at 0.9 m was inside the 1.677 m plane');
  assert.equal(planes.depthFar, WALL_FAR_METRES, 'the scene still reaches past the panel');
  // And it never RAISES the near plane: a panel further out than the structure
  // has nothing to ask for.
  assert.equal(immersiveDepthPlanes({ depthNear: 0.5, depthFar: 20, presentationNear: 3, presentationFar: 4 }).depthNear, 0.5);
});

test('a cutaway keeps both of its planes exactly as asked', () => {
  const planes = immersiveDepthPlanes({ clipped: true, depthNear: WALL_NEAR_METRES, depthFar: WALL_FAR_METRES,
    presentationNear: PANEL_NEAR_METRES, presentationFar: 99 });
  assert.equal(planes.depthNear, WALL_NEAR_METRES);
  assert.equal(planes.depthFar, WALL_FAR_METRES);
});

test('the band is never handed to WebXR inside out', () => {
  // A panel measured further out than the scene's own far plane may extend the
  // far plane, but it may never leave near at or past far.
  assert.equal(immersiveDepthPlanes({ depthNear: 5, depthFar: 6, presentationNear: 6.5, presentationFar: 6 }).depthNear, 5);
  assert.equal(immersiveDepthPlanes({ depthNear: 8, depthFar: 6 }).depthNear, undefined);
  const missing = immersiveDepthPlanes({ depthFar: 6, presentationNear: 0.5 });
  assert.equal(missing.depthNear, undefined, 'a session that asked for no near plane is given none');
  assert.equal(missing.depthFar, 6);
});
