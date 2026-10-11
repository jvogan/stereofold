/**
 * Build-local Mol* 5.11.0 PickHelper fork.
 *
 * Mol*'s stock helper hard-codes `left` into the left pick half and `right`
 * into the right half. Stereofold applies the same display assignment
 * used by DrawPass so cross-eyed and swap-eyes clicks unproject through the
 * eye that was actually drawn there.
 */
export function forkPickHelperSource(source: string): string {
  const renderBlock = `        if (StereoCamera.is(camera)) {
            renderer.setViewport(pickX, pickY, halfPickWidth, pickHeight);
            this.pickPass.render(renderer, camera.left, scene, helper);
            renderer.setViewport(pickX + halfPickWidth, pickY, pickWidth - halfPickWidth, pickHeight);
            this.pickPass.render(renderer, camera.right, scene, helper);
        }`;
  const patchedRenderBlock = `        if (StereoCamera.is(camera)) {
            const swapViewportX = globalThis.__stereoStructureViewportXSwap === true;
            renderer.setViewport(pickX, pickY, halfPickWidth, pickHeight);
            this.pickPass.render(renderer, swapViewportX ? camera.right : camera.left, scene, helper);
            renderer.setViewport(pickX + halfPickWidth, pickY, pickWidth - halfPickWidth, pickHeight);
            this.pickPass.render(renderer, swapViewportX ? camera.left : camera.right, scene, helper);
        }`;
  if (!source.includes(renderBlock)) {
    throw new Error('Mol* PickHelper render layout changed; refusing to apply eye-assignment patch.');
  }

  const identifyBlock = `        if (StereoCamera.is(camera)) {
            const halfWidth = Math.floor(viewport.width / 2);
            if (x > viewport.x + halfWidth) {
                position[0] = viewport.x + (xv - halfWidth) * 2;
                cameraUnproject(position, position, viewport, camera.right.inverseProjectionView);
            }
            else {
                position[0] = viewport.x + xv * 2;
                cameraUnproject(position, position, viewport, camera.left.inverseProjectionView);
            }
        }`;
  const patchedIdentifyBlock = `        if (StereoCamera.is(camera)) {
            const halfWidth = Math.floor(viewport.width / 2);
            const swapViewportX = globalThis.__stereoStructureViewportXSwap === true;
            if (x > viewport.x + halfWidth) {
                position[0] = viewport.x + (xv - halfWidth) * 2;
                const eye = swapViewportX ? camera.left : camera.right;
                cameraUnproject(position, position, viewport, eye.inverseProjectionView);
            }
            else {
                position[0] = viewport.x + xv * 2;
                const eye = swapViewportX ? camera.right : camera.left;
                cameraUnproject(position, position, viewport, eye.inverseProjectionView);
            }
        }`;
  if (!source.includes(identifyBlock)) {
    throw new Error('Mol* PickHelper identify layout changed; refusing to apply eye-assignment patch.');
  }
  return source.replace(renderBlock, patchedRenderBlock).replace(identifyBlock, patchedIdentifyBlock);
}
