/** Mol* 5.11: opt-in lesson text, at its original binocular position.
 * Only label fragments are replayed. GREATER makes hidden pixels translucent;
 * LEQUAL preserves exposed pixels. Neither draw changes molecular depth.
 */
function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error('Mol* lesson-label anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

export function patchLessonLabelRenderer(source: string): string {
  source = replaceOnce(source, '        const renderObject = (r, variant, flag) => {', `        const renderObject = (r, variant, flag) => {
            // Ordinary passes request 'color'; the render item selects its
            // colorBlended shader later. Only the label pass requests these
            // explicit variants, keeping exposed fragments from drawing twice.
            // Keep these plates out of molecular color/depth/marking passes.
            if (r.state.stereofoldLessonLabel && variant !== 'pick'
                && variant !== 'colorLabelExposed' && variant !== 'colorLabelOccluded') return;`);
  source = replaceOnce(source, 'if (isOccluded !== null && isOccluded(boundingSphere))',
    'if (!r.state.stereofoldLessonLabel && isOccluded !== null && isOccluded(boundingSphere))');
  // Text has one instance and no spatial grid; retain frustum/visibility checks.
  // The extra pass needs current model/eye matrices even after volume rendering.
  // Reuse the renderer-owned uniform boxes, preserving version increments.
  // Stock ValueCell.update allocates a new box on every call.
  const begin = source.indexOf('        const updateInternal =');
  const end = source.indexOf('        const checkOpaque =', begin);
  if (begin < 0 || end < begin) throw Error('Mol* lesson-label uniform boundary changed.');
  const internal = source.slice(begin, end).replace('const updateInternal =', 'const updateLessonLabelInternal =')
    .replaceAll('ValueCell.updateIfChanged(', 'updateLessonLabelCell(')
    .replaceAll('ValueCell.update(', 'updateLessonLabelCell(');
  const pass = `
        const updateLessonLabelCell = (cell, value) => {
            cell.ref.value = value;
            cell.ref.version++;
        };
${internal}
        const renderLessonLabels = (group, camera) => {
            const renderables = group.renderables;
            let ready = false;
            try {
                // Preserve scene order within each phase. Exposed plates are
                // composited last so hidden ink cannot cover exposed ink.
                for (let phase = 0; phase < 2; ++phase) {
                    let phaseReady = false;
                    for (let i = 0; i < renderables.length; ++i) {
                        const r = renderables[i];
                        if (!r.state.stereofoldLessonLabel || !r.state.visible || r.state.disposed
                            || r.values.alpha.ref.value * r.state.alphaFactor <= 0) continue;
                        if (!ready) {
                            // Also invalidates the current render item once:
                            // group/eye globals and shared depth texture changed.
                            updateLessonLabelInternal(group, camera, null, Mask.All, false);
                            state.enable(gl.BLEND);
                            state.enable(gl.DEPTH_TEST);
                            state.depthMask(false);
                            if (transparentBackground) state.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                            else state.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                            ready = true;
                        }
                        if (!phaseReady) {
                            // Material identity is not keyed by program. Start
                            // each variant with its own material upload; normal
                            // render-item checks handle subsequent materials.
                            state.currentMaterialId = -1;
                            state.depthFunc(phase === 0 ? gl.GREATER : gl.LEQUAL);
                            phaseReady = true;
                        }
                        // Item/program identity already invalidates object/VAO
                        // state, including a single plate switching variants.
                        renderObject(r, phase === 0 ? 'colorLabelOccluded' : 'colorLabelExposed', Flag.None);
                    }
                }
            } catch (error) {
                // A failed submission may have only partly installed GL state.
                // Force the next draw to rebind program, material and object.
                state.currentProgramId = -1;
                state.currentMaterialId = -1;
                state.currentRenderItemId = -1;
                throw error;
            } finally {
                if (ready) {
                    state.depthFunc(gl.LEQUAL);
                }
            }
        };
`;
  source = replaceOnce(source, '        const checkOpaque =', pass + '        const checkOpaque =');
  return replaceOnce(source, '            renderBlended,', '            renderLessonLabels,\n            renderBlended,');
}

export function patchLessonLabelDraw(source: string): string {
  // Before all helpers: the headset menu deliberately clears molecular depth.
  // OIT detaches depth; reconnect the existing attachment, never clear it.
  return replaceOnce(source, '        if (helper.debug.isEnabled || helper.pointer.isEnabled) {', `        const lessonTarget = !postprocessingEnabled && antialiasingEnabled ? this.colorTarget : target;
        if (lessonTarget !== target) lessonTarget.bind();
        if (oitEnabled) this.depthTextureOpaque.attachFramebuffer(lessonTarget.framebuffer, 'depth');
        renderer.renderLessonLabels(scene.primitives, camera);
        if (oitEnabled) this.depthTextureOpaque.detachFramebuffer(lessonTarget.framebuffer, 'depth');
        if (lessonTarget !== target) target.bind();
        if (helper.debug.isEnabled || helper.pointer.isEnabled) {`);
}

export function patchLessonLabelRenderItem(source: string): string {
  source = replaceOnce(source, 'function createProgramVariant(ctx, variant, defineValues, shaderCode, schema) {', `function createProgramVariant(ctx, variant, defineValues, shaderCode, schema) {
    if (variant === 'colorLabelOccluded' || variant === 'colorLabelExposed') {
        const occluded = variant === 'colorLabelOccluded';
        variant = 'colorBlended';
        defineValues = { ...defineValues, dStereofoldLabelSdf: ValueCell.create(true), dStereofoldOccludedLabel: ValueCell.create(occluded) };
        schema = { ...schema, dStereofoldLabelSdf: DefineSpec('boolean'), dStereofoldOccludedLabel: DefineSpec('boolean') };
    }`);
  // Compose with render-item candidate patches by changing only the variant
  // argument; extra programs are created at geometry setup, never per frame.
  const create = 'export function createRenderItem(ctx, drawMode, shaderCode, schema, values, materialId, renderVariants, transparency) {';
  return replaceOnce(source, create, create + "\n    if (shaderCode.name === 'text' && values.dStereofoldUiSdf) schema = { ...schema, dStereofoldUiSdf: DefineSpec('boolean') };\n    if (shaderCode.name === 'text') renderVariants = [...renderVariants, 'colorLabelExposed', 'colorLabelOccluded'];");
}

/** Coverage is evaluated in the two explicit blended lesson variants and
 * opted-in room UI text during its existing blended pass.
 * Derivatives run before any discard or divergent branch. The transition spans
 * one framebuffer pixel, with a one-byte SDF floor for flat/quantized samples.
 * Picking, molecular depth and unflagged text retain their upstream threshold.
 */
export function patchLessonLabelFragment(source: string): string {
  // The upstream module stores GLSL as escaped CRLF inside a JS template.
  const glsl = (value: string) => value.replaceAll('\n', '\\r\\n');
  source = replaceOnce(source, 'void main(){', glsl(`#if defined(dStereofoldUiSdf) && defined(dRenderVariant_colorBlended)
    #define dStereofoldLabelSdf
#endif
void main(){
    #ifdef dStereofoldLabelSdf
        float labelSdf = texture2D(tFont, vTexCoord).a;
        float labelHalfWidth = max(0.5 * fwidth(labelSdf), 1.0 / 255.0);
        float labelCoverage = 1.0;
    #endif`));
  source = replaceOnce(source, '        rawSdf = texture2D(tFont, vTexCoord).a;', glsl(`        #ifdef dStereofoldLabelSdf
            rawSdf = labelSdf;
        #else
            rawSdf = texture2D(tFont, vTexCoord).a;
        #endif`));
  source = replaceOnce(source, '        if (sdf < 0.5) discard;', glsl(`        #ifdef dStereofoldLabelSdf
            labelCoverage = smoothstep(0.5 - labelHalfWidth, 0.5 + labelHalfWidth, sdf);
            if (labelCoverage <= 0.0) discard;
        #else
            if (sdf < 0.5) discard;
        #endif`));
  source = replaceOnce(source, '                material.xyz = uBorderColor;', glsl(`                #ifndef dStereofoldLabelSdf
                    material.xyz = uBorderColor;
                #endif`));
  return replaceOnce(source, '    #include check_transparency', glsl(`    #ifdef dStereofoldLabelSdf
        if (!isBackground) {
            if (uBorderWidth > 0.0) {
                float inkCoverage = smoothstep(0.5 - labelHalfWidth, 0.5 + labelHalfWidth, rawSdf);
                material.xyz = mix(uBorderColor, material.xyz, inkCoverage);
            }
            material.a *= labelCoverage;
        }
    #endif
    #ifdef dStereofoldOccludedLabel
        material.a *= 0.65;
    #endif
    #include check_transparency`));
}
