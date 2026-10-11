/**
 * The depth band an immersive session needs, as pure arithmetic.
 *
 * Mol* derives both the far plane and the fog band from the scene bounding
 * sphere. `mol-canvas3d/camera.js` `updateClip` computes
 * `normalizedFar = max(radius, minFar)` and `far = cameraDistance +
 * normalizedFar`, and at the stock fog intensity 50 it sets
 * `fogNear = cameraDistance` with `fogFar = far`. A structure fitted to
 * `sceneRadiusInMeters` 0.9 therefore reaches full fog about a metre behind
 * its own centre and is clipped about two metres behind it, so a wearer who
 * pushes it across the room watches it fade into the background colour and
 * vanish.
 *
 * Two writes fix it. `camera.state.minFar` moves the far plane out, and
 * WebXR's own projection planes follow it through
 * `mol-canvas3d/helper/xr-manager.js`, which copies `camera.near` and
 * `camera.far` into `updateRenderState`. `camera.state.fog` of 0 clears
 * `uFog` in `mol-gl/renderer.js`, which drops the fade entirely.
 *
 * `updateClip` multiplies `minFar` by `camera.scale` before it uses it, so
 * `minFar` is in scene units and has to be recomputed whenever the wearer
 * scales the structure.
 */

/**
 * The shortest immersive far plane, in metres.
 *
 * The wearer can push the structure to the far wall of a room, so the plane
 * has to outrun a room rather than a fitted bounding sphere. 50 m is past any
 * room and still leaves a 24-bit depth buffer far more precision than a
 * molecule at 0.9 m needs.
 */
export const XR_FAR_METERS = 50;

/** Below this relative change the planes are the same and nothing is written. */
const MIN_FAR_TOLERANCE = 0.01;

/**
 * The camera state an immersive frame should be drawn with, or `undefined`
 * when the current state already carries it.
 *
 * @param {object} input
 * @param {number} input.cameraScale `camera.scale`, render units per scene unit
 * @param {number} input.currentFog `camera.state.fog`, 0 when fog is off
 * @param {number} [input.lastMinFar] the `minFar` this band last wrote
 * @param {number} [input.farMeters] the far plane to reach, in metres
 * @returns {{minFar: number, fog: number}|undefined}
 */
export function immersiveDepthPatch({ cameraScale, currentFog, lastMinFar = 0, farMeters = XR_FAR_METERS }) {
  if (!Number.isFinite(cameraScale) || cameraScale <= 0) return undefined;
  if (!Number.isFinite(farMeters) || farMeters <= 0) return undefined;
  const minFar = farMeters / cameraScale;
  // A scale gesture moves `camera.scale` every frame it runs, and writing the
  // camera state on each of those frames costs a transition and a clip
  // recompute for a plane the wearer cannot see move.
  if (Math.abs(minFar - lastMinFar) < minFar * MIN_FAR_TOLERANCE && currentFog === 0) return undefined;
  return { minFar, fog: 0 };
}

/**
 * The near plane the spatial panel must seat itself beyond, and the far plane
 * it must stay inside.
 *
 * A cutaway is an instruction. Mol*'s automatic near plane is not: it comes
 * out of `updateClip`'s arithmetic over the scene bounding sphere, so it
 * follows the structure's distance and the camera scale. On the microtubule
 * wall stage that put it at 1.677 m (`cameraScale` 0.00713) and the menu, which
 * has a fixed 0.96 m seat, was relocated out past it and scaled 2.67x to hold its angular
 * size. The structure stand-off then pushed the same seat out again by its
 * 1.5x cap and the panel's plates ended up 3.40-4.45 m from the eye. The
 * framing solver reads those plates as the glass it must clear, and a plate
 * at 3.40 m asks for a structure past ten metres: it hit its reach cap, left
 * the wall at 3.5 m and the 40 per cent subject floor, and still drew over
 * 100 of the 107 plate points it was moved to spare.
 *
 * So the panel is told about a near plane only when the wearer asked for one.
 * The far plane keeps the gate it always had.
 *
 * @param {{clipped?: boolean, depthNear?: number, depthFar?: number}} input
 * @returns {{near: number, far: number}} metres; 0 and Infinity mean "no plane"
 */
export function panelDepthBand({ clipped = false, depthNear, depthFar } = {}) {
  const near = Number.isFinite(depthNear) && depthNear > 0 ? depthNear : 0;
  const far = Number.isFinite(depthFar) && depthFar > 0 ? depthFar : Infinity;
  return { near: clipped ? near : 0, far: clipped ? far : Infinity };
}

/**
 * The projection planes an immersive frame is drawn with.
 *
 * The far plane has always opened to admit the presentation layer when the
 * wearer asked for no cutaway. The near plane now does the same, and for two
 * reasons rather than one. It keeps the menu at its own seat instead of
 * exiling it across the room, which is what stops the framing solver chasing
 * a plate it should never have been shown. And it stops an automatic plane
 * slicing the front off the structure: on that wall stage everything nearer
 * than 1.677 m was clipped away from an assembly whose nearest point was
 * 0.069 m BEHIND the wearer's eye.
 *
 * Under `clipped` both planes are returned exactly as asked. A cutaway is the
 * one case where the wearer chose the plane, and neither the menu nor the
 * presentation layer may take it back.
 *
 * @param {{clipped?: boolean, depthNear?: number, depthFar?: number,
 *   presentationNear?: number, presentationFar?: number}} input
 * @returns {{depthNear: number|undefined, depthFar: number|undefined}}
 */
export function immersiveDepthPlanes({ clipped = false, depthNear, depthFar,
  presentationNear, presentationFar } = {}) {
  let near = Number.isFinite(depthNear) && depthNear > 0 ? depthNear : undefined;
  let far = Number.isFinite(depthFar) && depthFar > 0 ? depthFar : undefined;
  if (!clipped && Number.isFinite(presentationFar) && presentationFar > 0) {
    far = Number.isFinite(far) ? Math.max(far, presentationFar) : presentationFar;
  }
  if (!clipped && Number.isFinite(near) && Number.isFinite(presentationNear) && presentationNear > 0) {
    near = Math.min(near, presentationNear);
  }
  // WebXR rejects a near plane at or past the far plane, and a session that
  // throws here loses the wearer the whole scene, so the band is kept ordered
  // whatever arrived.
  if (Number.isFinite(near) && Number.isFinite(far) && near >= far) near = undefined;
  return { depthNear: near, depthFar: far };
}
