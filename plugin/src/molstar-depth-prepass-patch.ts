/**
 * Depth pre-pass for opaque Quest meshes.
 *
 * A mesh shader without discard or depth writes lets the GPU reject a hidden
 * fragment before shading, but only against depth already written. Within one
 * spacefill draw the atoms arrive in chain order, so a pixel is shaded once
 * per atom surface that is nearer than everything drawn before it: about four
 * times per covered pixel in the giant 9AX6 view. Adreno's low-resolution
 * depth could remove that ordering cost; when it does not engage, every extra
 * layer runs the full three-light shader.
 *
 * On the primary blended scene this patch first draws every mesh that takes
 * the no-discard colour variant with colour writes off, through a depth-only
 * program built the same way, then draws colour with `LEQUAL`. Each covered
 * pixel then runs the lighting shader once for the nearest surface. Both
 * programs declare `gl_Position` invariant, so the colour pass reproduces the
 * pre-pass depth exactly. The colour of a pixel changes only where two
 * surfaces have bit-identical depth, which `LESS` resolves to the first one
 * drawn and `LEQUAL` to the last.
 *
 * Composes after the opaque-depth transforms of the same modules; eligibility
 * is that patch's per-draw check, re-evaluated every frame.
 */

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  anchor = anchor.replaceAll('\n', nl); replacement = replacement.replaceAll('\n', nl);
  if (source.split(anchor).length !== 2) throw Error('Mol* depth pre-pass source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

/** mol-gl/renderer.js, after `patchMolstarOpaqueRendererSource`. */
export function patchMolstarDepthPrepassRendererSource(source: string): string {
  const loop = `            const { renderables } = group;
            for (let i = 0, il = renderables.length; i < il; ++i) {
                const r = renderables[i];
                if (checkOpaque(r)) {
                    const variant = primaryBlendedScene && stereofoldQuestOpaque && stereofoldCanUseOpaqueMesh(r)
                        && r.getProgram('colorOpaqueNoDiscard') ? 'colorOpaqueNoDiscard' : 'color';
                    renderObject(r, variant, Flag.None);
                }
            }
`;
  return replaceOnce(source, loop, `            const { renderables } = group;
            let stereofoldPrepassed = 0;
            if (primaryBlendedScene && stereofoldQuestOpaque) {
                state.colorMask(false, false, false, false);
                for (let i = 0, il = renderables.length; i < il; ++i) {
                    const r = renderables[i];
                    if (!checkOpaque(r) || !stereofoldCanUseOpaqueMesh(r) || !r.getProgram('colorOpaqueNoDiscard'))
                        continue;
                    // Mol*'s shader manager links only the variants a pass requires, and
                    // this program normalizes to 'depth'. Link it here without blocking;
                    // until it is ready the object is simply drawn without a pre-pass.
                    const depthProgram = r.getProgram('depthOpaqueNoDiscard');
                    if (depthProgram && (depthProgram.isReady() || depthProgram.finalize(false))) {
                        renderObject(r, 'depthOpaqueNoDiscard', Flag.None);
                        stereofoldPrepassed++;
                    }
                }
                state.colorMask(true, true, true, true);
                if (stereofoldPrepassed > 0)
                    state.depthFunc(gl.LEQUAL);
            }
            for (let i = 0, il = renderables.length; i < il; ++i) {
                const r = renderables[i];
                if (checkOpaque(r)) {
                    const variant = primaryBlendedScene && stereofoldQuestOpaque && stereofoldCanUseOpaqueMesh(r)
                        && r.getProgram('colorOpaqueNoDiscard') ? 'colorOpaqueNoDiscard' : 'color';
                    renderObject(r, variant, Flag.None);
                }
            }
            if (stereofoldPrepassed > 0)
                state.depthFunc(gl.LESS);
`);
}

/** mol-gl/webgl/render-item.js, after `patchMolstarOpaqueRenderItemSource`. */
export function patchMolstarDepthPrepassRenderItemSource(source: string): string {
  source = replaceOnce(source, `    if (variant === 'colorOpaqueNoDiscard') {
        variant = 'colorBlended';`, `    if (variant === 'depthOpaqueNoDiscard') {
        variant = 'depth';
        defineValues = { ...defineValues, dStereofoldOpaqueNoDiscard: ValueCell.create(true) };
        schema = { ...schema, dStereofoldOpaqueNoDiscard: DefineSpec('boolean') };
    }
    if (variant === 'colorOpaqueNoDiscard') {
        variant = 'colorBlended';`);
  source = replaceOnce(source, `    if (variant === 'colorOpaqueNoDiscard') return transparency === 'blended' ? variant : getRenderVariant('color', transparency);`,
    `    if (variant === 'colorOpaqueNoDiscard') return transparency === 'blended' ? variant : getRenderVariant('color', transparency);
    if (variant === 'depthOpaqueNoDiscard') return transparency === 'blended' ? variant : 'depth';`);
  return replaceOnce(source, "? [...GraphicsRenderVariants, 'colorOpaqueNoDiscard'] : GraphicsRenderVariants;",
    "? [...GraphicsRenderVariants, 'colorOpaqueNoDiscard', 'depthOpaqueNoDiscard'] : GraphicsRenderVariants;");
}

/** mol-gl/shader/mesh.vert.js: both no-discard variants share exact positions. */
export function patchMolstarDepthPrepassMeshVertSource(source: string): string {
  return replaceOnce(source, 'precision highp sampler2D;\n', `precision highp sampler2D;
#ifdef dStereofoldOpaqueNoDiscard
    invariant gl_Position;
#endif
`);
}

/** mol-gl/shader/mesh.frag.js, before the opaque-depth transform: the
 * pre-pass program writes depth only, so its fragment shader does nothing. */
export function patchMolstarDepthPrepassMeshFragSource(source: string): string {
  return replaceOnce(source, 'void main() {\n    #include fade_lod', `void main() {
    #if defined(dStereofoldOpaqueNoDiscard) && defined(dRenderVariant_depth)
        gl_FragColor = vec4(0.0);
        return;
    #endif
    #include fade_lod`);
}

/** Off unless requested; needs the opaque-depth patch, whose variants it extends. */
export function depthPrepassEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw Error('STEREOFOLD_DEPTH_PREPASS must be 0 or 1.');
}
