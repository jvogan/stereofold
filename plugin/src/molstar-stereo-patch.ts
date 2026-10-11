/** Apply Stereofold's convergence and viewport assignment patch to an
 * in-memory Mol* 5.11.0 StereoCamera module. */
export function patchMolstarStereoSource(source: string): string {
  const viewportNeedle = 'right.viewport.width -= w;';
  const enabledNeedle = `left.disabled = false;
    right.disabled = false;`;
  const translationNeedle = `tmpEyeLeft[12] = -eyeSepHalf;
    tmpEyeRight[12] = eyeSepHalf;`;
  const leftProjectionNeedle = 'left.projection[8] = (xmax + xmin) / (xmax - xmin);';
  const rightProjectionNeedle = 'right.projection[8] = (xmax + xmin) / (xmax - xmin);';
  const leftViewNeedle = 'Mat4.mul(left.view, left.view, tmpEyeLeft);';
  const rightViewNeedle = 'Mat4.mul(right.view, right.view, tmpEyeRight);';
  if (!source.includes(viewportNeedle) || !source.includes(translationNeedle)
    || !source.includes(leftProjectionNeedle) || !source.includes(rightProjectionNeedle)
    || !source.includes(leftViewNeedle) || !source.includes(rightViewNeedle)
    || !source.includes(enabledNeedle)) {
    throw new Error('Mol* StereoCamera layout changed; Stereofold patch was not applied.');
  }
  const correctedTranslations = source.replace(translationNeedle, `// Stereofold convergence correction: stock Mol* 5.11.0
    // translates left/right by -/+B/2, which reinforces its native frustum
    // skew and leaves a pedestal at focus. Keep the native frustum signs but
    // use the opposite local eye translations.
    tmpEyeLeft[12] = eyeSepHalf;
    tmpEyeRight[12] = -eyeSepHalf;`);
  const correctedFrustum = correctedTranslations
    // Preserve the parent camera's off-axis projection (mouse parallax), then
    // add only the eye-specific convergence skew. Both eyes therefore inherit
    // the same parallax motion while their baseline/focus remain untouched.
    .replace(leftProjectionNeedle, 'left.projection[8] = camera.projection[8] + eyeSepOnProjection / (ymax * aspect);')
    .replace(rightProjectionNeedle, 'right.projection[8] = camera.projection[8] - eyeSepOnProjection / (ymax * aspect);');
  // Move the eye baseline into the camera's own frame.
  //
  // Mol* adapted three.js's StereoCamera, where `_eyeLeft` post-multiplies the
  // camera's *matrixWorld* (camera to world), so the ±B/2 column lands on the
  // camera's own x axis. Mol* post-multiplies the *view* matrix (world to
  // camera) instead, and `view · T` applies T before the view rotation, i.e.
  // along the world x axis. The frustum skew below is always applied along the
  // eye's own x axis, so the two only cancel when the camera's right vector
  // happens to be world +x. At any other yaw the residual is a fixed
  // outward shift of both eye images at the focus plane, plus a vertical
  // disparity once the baseline also acquires a camera-y component:
  //
  //   Δx per eye = (B · H) / (4 · F · tan(fov/2)) · (u·x̂ − 1),  u = R_view · x̂
  //
  // which is fusion-breaking rather than cosmetic. Pre-multiplying is the same
  // baseline expressed in camera coordinates, so the skew cancels at focus for
  // every camera pose, and the axis-aligned pose the pixel gate pins is
  // unchanged to the last bit.
  const correctedFrame = correctedFrustum
    .replace(leftViewNeedle, 'Mat4.mul(left.view, tmpEyeLeft, left.view);')
    .replace(rightViewNeedle, 'Mat4.mul(right.view, tmpEyeRight, right.view);');
  const withViewportSwap = correctedFrame.replace(viewportNeedle, `${viewportNeedle}
    // Stereofold: cross-eyed and swap-eyes modes exchange the eye viewport X slots.
    if (globalThis.__stereoStructureViewportXSwap === true) {
        const leftX = left.viewport.x;
        const leftWidth = left.viewport.width;
        left.viewport.x = right.viewport.x;
        left.viewport.width = right.viewport.width;
        right.viewport.x = leftX;
        right.viewport.width = leftWidth;
    }`);
  // Stereofold: publish the split this update produced.
  //
  // The eye viewports the draw pass uses are computed here and nowhere else,
  // and the viewer's fit is computed from a CSS layout box. Whether those two
  // agree is the question no screenshot of a Codex side panel can
  // answer, so the update records what it actually produced and
  // `plugin/src/viewer.ts` reads it into `diagnostics.geometry`. These are
  // Mol*'s own viewport units, which are drawing-buffer (device) pixels, not
  // CSS pixels: at devicePixelRatio 2 a 238 CSS px eye is 476 here, and the
  // two disagreeing by anything other than the ratio is the finding.
  //
  // `at` is recorded because a mono panel keeps the last stereo frame's
  // numbers: without it a stale split is indistinguishable from a live one.
  return withViewportSwap.replace(enabledNeedle, `${enabledNeedle}
    globalThis.__stereoStructureEyeViewports = {
        left: { x: left.viewport.x, y: left.viewport.y, width: left.viewport.width, height: left.viewport.height },
        right: { x: right.viewport.x, y: right.viewport.y, width: right.viewport.width, height: right.viewport.height },
        parent: { x: camera.viewport.x, y: camera.viewport.y, width: camera.viewport.width, height: camera.viewport.height },
        at: Date.now(),
    };`);
}
