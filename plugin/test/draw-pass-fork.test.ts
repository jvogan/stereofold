import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forkDrawPassSource } from '../src/molstar-draw-pass-fork.js';
import { forkPickHelperSource } from '../src/molstar-pick-helper-fork.js';
import { patchMolstarStereoSource } from '../src/molstar-stereo-patch.js';

const drawPassFixture = `import { BloomPass } from './bloom.js';
export class DrawPass {
  render(ctx, props, toDrawingBuffer) {
        if (StereoCamera.is(camera)) {
            this._render(renderer, camera.left, scene, helper, toDrawingBuffer, transparentBackground, props);
        }
  }
}`;

describe('build-local Mol* DrawPass anaglyph fork', () => {
  it('uses the package-owned eye FBOs and corrects split-view projection before the composite', () => {
    const fork = forkDrawPassSource(drawPassFixture);
    expect(fork).toContain("import { createAnaglyphPass } from '@stereo/anaglyph';");
    expect(fork).toContain('renderEye(camera.left, pass.leftTexture);');
    expect(fork).toContain('renderEye(camera.right, pass.rightTexture);');
    expect(fork).toContain('pass.render(pass.leftTexture, pass.rightTexture, toDrawingBuffer ? null : rawFramebuffer(this.getColorTarget(props.postprocessing)));');
    expect(fork).toContain('this.webgl.state.disable(gl.DEPTH_TEST);');
    expect(fork).toContain('eye.projection[0] *= 0.5;');
    expect(fork).toContain('eye.projection[8] *= 0.5;');
    // Mol* 5.11.0's Mat4 is a plain array. A typed-array .set() restore threw
    // out of the draw loop every frame and blanked the anaglyph composite.
    expect(fork).toContain('Mat4.copy(eye.projection, projection);');
    expect(fork).not.toContain('eye.projection.set(');
  });

  it('composites after AntialiasingPass instead of being painted over by it', () => {
    const fork = forkDrawPassSource(drawPassFixture);
    // `toDrawingBuffer` false is what routes an eye through AntialiasingPass
    // into an offscreen target rather than straight to the canvas.
    expect(fork).toContain('this._render(renderer, eye, scene, helper, false, transparentBackground, props);');
    expect(fork).not.toContain('this._render(renderer, eye, scene, helper, true,');
    // Each resolved eye is copied out before the next overwrites the shared target.
    expect(fork).toContain('this.getColorTarget(props.postprocessing).framebuffer.bind();');
    expect(fork).toContain('gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, pass.width, pass.height);');
    // The old fork rebound this.drawTarget, which antialiasing bypasses.
    expect(fork).not.toContain('this.drawTarget = {');
  });

  it('carries the anaglyph variant into the pass', () => {
    const fork = forkDrawPassSource(drawPassFixture);
    expect(fork).toContain('variant: anaglyph.variant');
    expect(fork).toContain('pass.variant = anaglyph.variant;');
  });

  it('refuses a Mol* layout it cannot patch exactly', () => {
    expect(() => forkDrawPassSource('export class DrawPass {}')).toThrow(/refusing to apply/i);
  });
});

const pickHelperFixture = `export class PickHelper {
  render(camera) {
        if (StereoCamera.is(camera)) {
            renderer.setViewport(pickX, pickY, halfPickWidth, pickHeight);
            this.pickPass.render(renderer, camera.left, scene, helper);
            renderer.setViewport(pickX + halfPickWidth, pickY, pickWidth - halfPickWidth, pickHeight);
            this.pickPass.render(renderer, camera.right, scene, helper);
        }
  }
  identifyInternal(x, y, camera) {
        if (StereoCamera.is(camera)) {
            const halfWidth = Math.floor(viewport.width / 2);
            if (x > viewport.x + halfWidth) {
                position[0] = viewport.x + (xv - halfWidth) * 2;
                cameraUnproject(position, position, viewport, camera.right.inverseProjectionView);
            }
            else {
                position[0] = viewport.x + xv * 2;
                cameraUnproject(position, position, viewport, camera.left.inverseProjectionView);
            }
        }
  }
}`;

describe('build-local Mol* PickHelper eye assignment', () => {
  it('uses the displayed eye for pick rendering and unprojection after a viewport swap', () => {
    const fork = forkPickHelperSource(pickHelperFixture);
    expect(fork).toContain('swapViewportX ? camera.right : camera.left');
    expect(fork).toContain('swapViewportX ? camera.left : camera.right');
    expect(fork).toContain('const eye = swapViewportX ? camera.left : camera.right;');
    expect(fork).toContain('const eye = swapViewportX ? camera.right : camera.left;');
  });

  it('refuses an unrecognised PickHelper layout', () => {
    expect(() => forkPickHelperSource('export class PickHelper {}')).toThrow(/refusing to apply/i);
  });
});

describe('build-local Mol* StereoCamera convergence patch', () => {
  it('patches the installed Mol* 5.11.0 source with corrected translations and explicit focus skew', () => {
    const sourcePath = fileURLToPath(new URL('../node_modules/molstar/lib/mol-canvas3d/camera/stereo.js', import.meta.url));
    const patched = patchMolstarStereoSource(readFileSync(sourcePath, 'utf8'));
    expect(patched).toContain('tmpEyeLeft[12] = eyeSepHalf;');
    expect(patched).toContain('tmpEyeRight[12] = -eyeSepHalf;');
    expect(patched).toContain('left.projection[8] = camera.projection[8] + eyeSepOnProjection / (ymax * aspect);');
    expect(patched).toContain('right.projection[8] = camera.projection[8] - eyeSepOnProjection / (ymax * aspect);');
    expect(patched).toContain('globalThis.__stereoStructureViewportXSwap === true');
    expect(patched).not.toContain('tmpEyeLeft[12] = -eyeSepHalf;');
    expect(patched).not.toContain('tmpEyeRight[12] = eyeSepHalf;');
  });

  it('applies the eye baseline in the camera frame, not the world frame', () => {
    const sourcePath = fileURLToPath(new URL('../node_modules/molstar/lib/mol-canvas3d/camera/stereo.js', import.meta.url));
    const patched = patchMolstarStereoSource(readFileSync(sourcePath, 'utf8'));
    // `view * T` translates before the view rotation, so stock Mol* moves the
    // eyes along world x. `T * view` is the same baseline on the camera's own
    // x axis, which is the axis the frustum skew is applied along.
    expect(patched).toContain('Mat4.mul(left.view, tmpEyeLeft, left.view);');
    expect(patched).toContain('Mat4.mul(right.view, tmpEyeRight, right.view);');
    expect(patched).not.toContain('Mat4.mul(left.view, left.view, tmpEyeLeft);');
    expect(patched).not.toContain('Mat4.mul(right.view, right.view, tmpEyeRight);');
  });

  it('publishes the eye viewports each update produced, in Mol* viewport units', () => {
    const sourcePath = fileURLToPath(new URL('../node_modules/molstar/lib/mol-canvas3d/camera/stereo.js', import.meta.url));
    const patched = patchMolstarStereoSource(readFileSync(sourcePath, 'utf8'));
    // The viewer's fit is solved from a CSS layout box and the draw pass uses
    // the split computed here. Whether those two agree is the question no
    // screenshot of a Codex side panel can answer, so the update records what
    // it produced and the fit diagnostics report it.
    expect(patched).toContain('globalThis.__stereoStructureEyeViewports = {');
    expect(patched).toContain('left: { x: left.viewport.x, y: left.viewport.y, width: left.viewport.width, height: left.viewport.height },');
    expect(patched).toContain('parent: { x: camera.viewport.x, y: camera.viewport.y, width: camera.viewport.width, height: camera.viewport.height },');
    // A mono panel keeps the last stereo frame's split, so a reader has to be
    // able to tell a live number from a stale one.
    expect(patched).toContain('at: Date.now(),');
    // Recorded after the swap, so cross-eyed and swap-eyes report the slots
    // the draw actually uses rather than the ones before the exchange.
    expect(patched.indexOf('__stereoStructureViewportXSwap')).toBeLessThan(patched.indexOf('__stereoStructureEyeViewports'));
  });

  it('refuses a Mol* source whose eye-enable call site has moved', () => {
    const sourcePath = fileURLToPath(new URL('../node_modules/molstar/lib/mol-canvas3d/camera/stereo.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8').replace('left.disabled = false;', 'left.disabled = !!0;');
    expect(() => patchMolstarStereoSource(source)).toThrow(/was not applied/iu);
  });

  it('refuses a Mol* source whose eye-translation call site has moved', () => {
    const sourcePath = fileURLToPath(new URL('../node_modules/molstar/lib/mol-canvas3d/camera/stereo.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8')
      .replace('Mat4.mul(left.view, left.view, tmpEyeLeft);', 'Mat4.mul(left.view, left.view, someOtherMatrix);');
    expect(() => patchMolstarStereoSource(source)).toThrow(/was not applied/iu);
  });
});
