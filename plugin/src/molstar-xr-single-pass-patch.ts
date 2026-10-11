/**
 * One render pass per immersive Quest frame.
 *
 * Mol* 5.11 draws a stereo frame as two complete passes into the same XR
 * framebuffer: each eye clears its own half through a scissor and ends with
 * `gl.flush()`. On a tiled GPU the mid-frame flush closes the render pass, so
 * the first eye's colour and depth are stored to memory and the second eye's
 * pass loads them back. A scissored clear is also a partial clear, which keeps
 * the driver from treating the pass as starting from a cleared surface.
 *
 * On the direct blended path this patch clears the union of both eye
 * viewports once, skips the per-eye clears, and keeps only the final flush.
 * Each eye still draws only inside its own scissor, so the pixels match the
 * stock two-pass frame. Paths with offscreen targets keep Mol*'s behaviour.
 *
 * The qualified Quest 2 path can also defer its final flush to the XR frame
 * boundary. A matched native trace measured about 0.874 ms less depth-store
 * work per submission without changing FFR bin scale or pixel content. This
 * is scoped to the tested device/path, not a guarantee for every scene.
 */
/** Keep self-contained: embedded in the vendor module by the build transform. */
export function isQuestSinglePassBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'xr' in navigator && /\bOculusBrowser\//.test(navigator.userAgent || '');
  } catch { return false; }
}

/** Keep self-contained for serialized build insertion. Unmeasured headsets
 * retain their final flush, including Quest 3 and unknown Oculus devices. */
export function isQuest2FinalFlushBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'xr' in navigator
      && /\bOculusBrowser\//.test(navigator.userAgent || '') && /\bQuest 2\b/i.test(navigator.userAgent || '');
  } catch { return false; }
}

/** XR eye rectangles must be disjoint: stock clears the second eye before
 * drawing it. A disabled eye also cannot supply the final explicit flush.
 * Keep self-contained for the build transform, including under tsx keepNames. */
export function canUseSinglePassEyes(left: { disabled?: boolean; viewport: { x: number; y: number; width: number; height: number } },
  right: { disabled?: boolean; viewport: { x: number; y: number; width: number; height: number } }): boolean {
  if (left.disabled || right.disabled) return false;
  const l = left.viewport, r = right.viewport;
  return Number.isSafeInteger(l.x) && Number.isSafeInteger(l.y) && Number.isSafeInteger(l.width) && Number.isSafeInteger(l.height)
    && Number.isSafeInteger(r.x) && Number.isSafeInteger(r.y) && Number.isSafeInteger(r.width) && Number.isSafeInteger(r.height)
    && l.x >= 0 && l.y >= 0 && r.x >= 0 && r.y >= 0 && l.width > 0 && l.height > 0 && r.width > 0 && r.height > 0
    && Number.isSafeInteger(l.x + l.width) && Number.isSafeInteger(l.y + l.height)
    && Number.isSafeInteger(r.x + r.width) && Number.isSafeInteger(r.y + r.height)
    && (l.x + l.width <= r.x || r.x + r.width <= l.x || l.y + l.height <= r.y || r.y + r.height <= l.y);
}

function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error('Mol* XR single-pass source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

/** The build supplies its default-on setting explicitly; false preserves the
 * prior transform exactly for diagnostic comparisons and existing callers. */
export function patchMolstarXrSinglePassDrawSource(source: string, skipFinalFlush = false): string {
  source = replaceOnce(source, '            this.drawTarget.bind();\n            renderer.clear(false);\n',
    '            this.drawTarget.bind();\n            if (!this.stereofoldSinglePassEye)\n                renderer.clear(false);\n');
  source = replaceOnce(source, '        renderer.clear(true);\n        if (scene.hasOpaque) {\n            renderer.renderOpaque(',
    '        if (!(toDrawingBuffer && this.stereofoldSinglePassEye))\n            renderer.clear(true);\n        if (scene.hasOpaque) {\n            renderer.renderOpaque(');
  source = replaceOnce(source, '        this.webgl.gl.flush();\n    }\n    render(ctx, props, toDrawingBuffer) {',
    `        if (this.stereofoldSinglePassEye !== 1${skipFinalFlush ? ` && (this.stereofoldSinglePassEye !== 2 || !(${isQuest2FinalFlushBrowser.toString()})())` : ''})\n            this.webgl.gl.flush();\n    }\n    render(ctx, props, toDrawingBuffer) {`);
  const left = '            this._render(renderer, camera.left, scene, helper, toDrawingBuffer, transparentBackground, props);';
  const right = '            this._render(renderer, camera.right, scene, helper, toDrawingBuffer, transparentBackground, props);';
  source = replaceOnce(source, left, `            const stereofoldSinglePass = (${isQuestSinglePassBrowser.toString()})() && !!this.webgl.xr.session
                && (${canUseSinglePassEyes.toString()})(camera.left, camera.right)
                && toDrawingBuffer && scene.volumes.renderables.length === 0
                && !PostprocessingPass.isEnabled(props.postprocessing) && !AntialiasingPass.isEnabled(props.postprocessing)
                && !DofPass.isEnabled(props.postprocessing) && !(MarkingPass.isEnabled(props.marking) && scene.markerAverage > 0)
                && !(this.transparencyMode === 'wboit' && this.wboit.supported) && !(this.transparencyMode === 'dpoit' && this.dpoit.supported);
            if (stereofoldSinglePass) {
                const l = camera.left.viewport, r = camera.right.viewport;
                const x = Math.min(l.x, r.x), y = Math.min(l.y, r.y);
                renderer.setViewport(x, y, Math.max(l.x + l.width, r.x + r.width) - x, Math.max(l.y + l.height, r.y + r.height) - y);
                this.drawTarget.bind();
                renderer.clear(true);
                this.stereofoldSinglePassEye = 1;
            }
            try {
${left}`);
  return replaceOnce(source, right, `                if (stereofoldSinglePass)
                    this.stereofoldSinglePassEye = 2;
    ${right}
            } finally {
                this.stereofoldSinglePassEye = 0;
            }`);
}

/** Qualified Quest path; disabling it is a scratch-build comparison control. */
export function xrSinglePassEnabled(value: string | undefined): boolean {
  if (value === '0') return false;
  if (value === undefined || value === '1') return true;
  throw Error('STEREOFOLD_XR_SINGLE_PASS must be 0 or 1.');
}

/** Qualified Quest 2 optimization; flag0 remains a scratch baseline. */
export function xrSkipFinalFlushEnabled(value: string | undefined): boolean {
  if (value === '0') return false;
  if (value === undefined || value === '1') return true;
  throw Error('STEREOFOLD_XR_SKIP_FINAL_FLUSH must be 0 or 1.');
}
