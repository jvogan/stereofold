/**
 * Build-local fork of Mol* 5.11.0's DrawPass stereo branch.
 *
 * The source remains in node_modules untouched: the build injects this exact
 * branch into an in-memory copy. The branch renders each eye through the whole
 * pass chain into an offscreen target, copies each resolved eye into the two
 * textures owned by `@stereo/anaglyph`, and composites them.
 *
 * The eyes are rendered with `toDrawingBuffer` false on purpose. Mol* only
 * routes a `_render` result through `AntialiasingPass` into an offscreen
 * target in that case (`draw.js:421-425` passes the flag straight to
 * `PostprocessingPass.render`, which binds the default framebuffer when it is
 * true). Rendering each eye to the drawing buffer therefore let antialiasing,
 * and then `MultiSamplePass`, paint their own copy of the scene over the
 * finished composite, which is why anaglyph previously reached the screen as a
 * plain mono frame. Resolving offscreen and reading `getColorTarget` instead
 * means the composite happens after antialiasing, so anaglyph keeps it, and
 * the branch honours `toDrawingBuffer` so `MultiSamplePass`, which reads
 * `drawPass.getColorTarget(...).texture` (`multi-sample.js:106`), accumulates
 * the composite rather than the raw scene.
 */
export function forkDrawPassSource(source: string): string {
  const imports = "import { BloomPass } from './bloom.js';";
  if (!source.includes(imports)) {
    throw new Error('Mol* DrawPass imports changed; refusing to apply the local anaglyph fork.');
  }
  const branch = '        if (StereoCamera.is(camera)) {';
  if (!source.includes(branch)) {
    throw new Error('Mol* DrawPass stereo branch changed; refusing to apply the local anaglyph fork.');
  }

  const localFork = `        // Stereofold local DrawPass fork. The global is written only by
        // the embedding viewer; no Mol* file inside node_modules is modified.
        const anaglyph = globalThis.__stereoStructureAnaglyph;
        if (StereoCamera.is(camera) && anaglyph?.enabled) {
            if (!this.webgl.isWebGL2) {
                throw new Error('Stereofold anaglyph requires WebGL2.');
            }
            const gl = this.webgl.gl;
            let pass = this.__stereoStructureAnaglyphPass;
            if (!pass) {
                pass = createAnaglyphPass(gl, { width: this.colorTarget.getWidth(), height: this.colorTarget.getHeight(), glasses: anaglyph.glasses, swapEyes: anaglyph.swapEyes, variant: anaglyph.variant });
                this.__stereoStructureAnaglyphPass = pass;
            }
            pass.resize(this.colorTarget.getWidth(), this.colorTarget.getHeight());
            pass.glasses = anaglyph.glasses;
            pass.swapEyes = anaglyph.swapEyes;
            pass.variant = anaglyph.variant;
            // Mol*'s Framebuffer wrapper exposes bind() and no raw handle, and
            // the package compositor takes a raw WebGLFramebuffer. Bind, then
            // read the binding back.
            const rawFramebuffer = (renderTarget) => {
                renderTarget.framebuffer.bind();
                return gl.getParameter(gl.FRAMEBUFFER_BINDING);
            };
            const renderEye = (eye, texture) => {
                const viewport = { ...eye.viewport };
                // Mol* 5.11.0's Mat4 is a plain number array, not a typed
                // array, so it has no .set(). Snapshot and restore the eye
                // matrices with Mat4.copy; anything else throws out of the
                // draw loop every frame and leaves the anaglyph frame blank.
                const projection = Mat4.copy(Mat4(), eye.projection);
                const projectionView = Mat4.copy(Mat4(), eye.projectionView);
                const inverseProjectionView = Mat4.copy(Mat4(), eye.inverseProjectionView);
                // StereoCamera's split viewport uses half the parent aspect. For a
                // full-frame FBO, restore the parent aspect and preserve the
                // off-axis shift so the pixel disparity remains the geometry
                // package's predicted value (rather than doubling).
                eye.viewport.x = 0;
                eye.viewport.y = 0;
                eye.viewport.width = pass.width;
                eye.viewport.height = pass.height;
                eye.projection[0] *= 0.5;
                eye.projection[8] *= 0.5;
                Mat4.mul(eye.projectionView, eye.projection, eye.view);
                Mat4.invert(eye.inverseProjectionView, eye.projectionView);
                try {
                    this._render(renderer, eye, scene, helper, false, transparentBackground, props);
                    // Snapshot the resolved eye. Both eyes resolve into the
                    // same Mol* target, so the first has to be copied out
                    // before the second overwrites it.
                    this.getColorTarget(props.postprocessing).framebuffer.bind();
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, pass.width, pass.height);
                    gl.bindTexture(gl.TEXTURE_2D, null);
                } finally {
                    Object.assign(eye.viewport, viewport);
                    Mat4.copy(eye.projection, projection);
                    Mat4.copy(eye.projectionView, projectionView);
                    Mat4.copy(eye.inverseProjectionView, inverseProjectionView);
                }
            };
            renderEye(camera.left, pass.leftTexture);
            renderEye(camera.right, pass.rightTexture);
            // Stereofold: publish the eye viewport this branch actually
            // rendered into, overwriting the side-by-side split that
            // StereoCamera.update published a moment ago.
            //
            // The two are different rectangles in anaglyph and only this one
            // is drawn. renderEye widens each eye to the whole pass, renders,
            // and restores the half-width viewport in its finally, so without
            // this write diagnostics.camera.fillFromDrawPass would divide by
            // half the window anaglyph draws into and read about twice the
            // truth: a fabricated divergence in the one channel out of a live
            // webview. See plugin/src/molstar-stereo-patch.ts for the
            // side-by-side write this replaces, and
            // plugin/src/fit-diagnostics.ts for what reads it.
            globalThis.__stereoStructureEyeViewports = {
                left: { x: 0, y: 0, width: pass.width, height: pass.height },
                right: { x: 0, y: 0, width: pass.width, height: pass.height },
                parent: { x: camera.viewport.x, y: camera.viewport.y, width: camera.viewport.width, height: camera.viewport.height },
                at: Date.now(),
            };
            // The fullscreen composite draw must not inherit the scene depth or
            // blending state left by the second eye.
            this.webgl.state.disable(gl.DEPTH_TEST);
            this.webgl.state.disable(gl.BLEND);
            this.webgl.state.disable(gl.CULL_FACE);
            this.webgl.state.depthMask(false);
            pass.render(pass.leftTexture, pass.rightTexture, toDrawingBuffer ? null : rawFramebuffer(this.getColorTarget(props.postprocessing)));
            // The package compositor uses raw WebGL2 calls. Re-synchronise
            // Mol*'s cached state before its next pass.
            this.webgl.state.reset();
            this.webgl.state.currentProgramId = -1;
            this.webgl.state.currentMaterialId = -1;
            this.webgl.state.currentRenderItemId = -1;
            if (isTimingMode)
                this.webgl.timer.markEnd('DrawPass.render');
            return;
        }
        if (StereoCamera.is(camera)) {`;

  return source
    .replace(imports, `${imports}\nimport { Mat4 } from '../../mol-math/linear-algebra.js';\nimport { createAnaglyphPass } from '@stereo/anaglyph';`)
    .replace(branch, localFork);
}
