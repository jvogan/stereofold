/** Quest-only late/early fragment culling for exact opaque Mol* sphere impostors.
 * The runtime owns the depth texture lifecycle and only supplies it for the
 * eligible primary draw. Other variants keep Mol*'s original fragment path. */
export function isQuestSphereOcclusionBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'xr' in navigator && /\bOculusBrowser\//.test(navigator.userAgent || '');
  } catch { return false; }
}

function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error('Mol* sphere-occlusion source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

const COMMON_DEPTH_DECLARATION = `#if __VERSION__ >= 300 && defined(dStereofoldSphereCull)
uniform highp sampler2D tDepth;
#else
uniform sampler2D tDepth;
#endif`;

/** Add high precision only to the candidate's existing shared depth sampler.
 * This leaves all non-Quest common chunks byte-identical and does not change
 * precision defaults for any other sampler. */
export function patchSphereOcclusionCommonFragSource(source: string): string {
  if (source.includes('stereofoldSphereCull')) throw Error('Mol* common fragment sphere-occlusion patch already applied.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const declaration = COMMON_DEPTH_DECLARATION.replaceAll('\n', nl);
  const route = `const stereofoldQuestSphereCull = (${isQuestSphereOcclusionBrowser.toString()})();\n`;
  source = replaceOnce(source, 'export const common_frag_params = `', `${route}export const common_frag_params = \``);
  return replaceOnce(source, 'uniform sampler2D tDepth;', '${stereofoldQuestSphereCull ? ' + JSON.stringify(declaration) + " : 'uniform sampler2D tDepth;'}");
}

const SPHERE_CULL_EARLY = `
#if __VERSION__ >= 300 && defined(dStereofoldSphereCull) && defined(dRenderVariant_colorBlended)
    bool stereofoldSphereCullEligible = false;
    float stereofoldSphereCullProxyDepth = 1.0;
    // A whole-sphere nearest-Z bound is conservative and avoids changing
    // Mol*'s camera-inside and near-plane interior behavior.
    float stereofoldSphereCullFront = -vPointViewPosition.z + vRadius;
    if (stereofoldSphereCullFront < -uNear) {
        stereofoldSphereCullEligible = true;
        stereofoldSphereCullProxyDepth = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
        float stereofoldSphereCullFrontDepth = calcDepth(vec3(0.0, 0.0, stereofoldSphereCullFront));
        if (stereofoldSphereCullProxyDepth + 0.00002 < stereofoldSphereCullFrontDepth) discard;
    }
#endif
`;

const SPHERE_CULL_LATE = `
#if __VERSION__ >= 300 && defined(dStereofoldSphereCull) && defined(dRenderVariant_colorBlended)
        // Reject only after Mol*'s exact analytic sphere hit and depth checks.
        if (stereofoldSphereCullEligible && fragmentDepth > stereofoldSphereCullProxyDepth + 0.00002) discard;
#endif
`;

/** Compose after impostor scaling/frustum transforms. The inserted GLSL only
 * exists in the Quest module, and only its alternate color variant executes it. */
export function patchSphereOcclusionFragmentSource(source: string, version: string): string {
  if (version !== '5.11.0') throw Error('Mol* sphere occlusion patch requires reviewed 5.11.0.');
  if (source.includes('stereofoldSphereCullEligible')) throw Error('Mol* sphere occlusion fragment patch already applied.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const normalize = (value: string) => value.replaceAll('\n', nl);
  const route = 'const stereofoldQuestSphereCull = (' + isQuestSphereOcclusionBrowser.toString() + ')();';
  source = replaceOnce(source, 'export const spheres_frag = `', `${route}\nexport const spheres_frag = \``);
  const insertion = (value: string) => '${stereofoldQuestSphereCull ? ' + JSON.stringify(normalize(value)) + " : ''}";
  source = replaceOnce(source, '    float fragmentDepth;', '    float fragmentDepth;' + insertion(SPHERE_CULL_EARLY));
  source = replaceOnce(source, '        if (fragmentDepth > 1.0) discard;', '        if (fragmentDepth > 1.0) discard;' + insertion(SPHERE_CULL_LATE));
  return source;
}

/** Add a separate shader/program variant after the opaque-depth transform.
 * Mol* owns its normal program, VAO, update, transparency, and destroy lifecycle. */
export function patchSphereOcclusionRenderItemSource(source: string): string {
  if (!source.includes('dStereofoldOpaqueNoDiscard')) throw Error('Apply the reviewed opaque-depth render-item patch before sphere occlusion.');
  if (source.includes('dStereofoldSphereCull')) throw Error('Mol* sphere-occlusion render-item patch already applied.');
  source = replaceOnce(source, 'function createProgramVariant(ctx, variant, defineValues, shaderCode, schema) {', `function createProgramVariant(ctx, variant, defineValues, shaderCode, schema) {
    if (variant === 'colorSphereCull') {
        variant = 'colorBlended';
        defineValues = { ...defineValues, dStereofoldSphereCull: ValueCell.create(true) };
        schema = { ...schema, dStereofoldSphereCull: DefineSpec('boolean') };
    }`);
  source = replaceOnce(source, 'function getRenderVariant(variant, transparency) {', `function getRenderVariant(variant, transparency) {
    if (variant === 'colorSphereCull') return transparency === 'blended' ? variant : getRenderVariant('color', transparency);`);
  // The opaque-depth transform is the source owner before this transform.
  const start = '    const variants = shaderCode.name ===';
  const end = '    return createRenderItem(ctx, drawMode, shaderCode, schema, values, materialId, variants, transparency);';
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Mol* opaque render-item variant anchor changed; sphere variant was not added.');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  const oldBlock = source.slice(a, b + end.length);
  if (b <= a || !oldBlock.includes("shaderCode.name === 'mesh'") || !oldBlock.includes("'colorOpaqueNoDiscard'"))
    throw Error('Mol* opaque render-item variant body changed; sphere variant was not added.');
  const priorExtraVariants = oldBlock.match(/\[\.\.\.GraphicsRenderVariants,\s*([^\]]+)\]/)?.[1]?.trim();
  if (!priorExtraVariants) throw Error('Mol* opaque render-item variant list changed; refusing to drop composed variants.');
  const replacement = `    const variants = [
        ...GraphicsRenderVariants,
        ...(shaderCode.name === 'mesh' && values.dGeometryType?.ref.value === 'mesh' && (${isQuestSphereOcclusionBrowser.toString()})() ? [${priorExtraVariants}] : []),
        ...(shaderCode.name === 'spheres' && values.dGeometryType?.ref.value === 'spheres' && (${isQuestSphereOcclusionBrowser.toString()})() ? ['colorSphereCull'] : [])
    ];
    return createRenderItem(ctx, drawMode, shaderCode, schema, values, materialId, variants, transparency);`;
  return source.slice(0, a) + replacement + source.slice(b + end.length);
}

/** Defensive per-renderable gate. The runtime also validates the whole primary
 * graph and the proxy provenance before it passes a depth texture. */
export function canUseSphereOcclusionRenderable(r: any): boolean {
  const v = r?.values;
  const lod = v?.uLod?.ref?.value;
  const lodLevels = v?.lodLevels?.ref?.value;
  return !!v && v.dGeometryType?.ref?.value === 'spheres' && v.dApproximate?.ref?.value === false
    && v.dClipObjectCount?.ref?.value === 0 && v.dTransparency?.ref?.value === false && v.transparencyAverage?.ref?.value === 0
    && v.alpha?.ref?.value === 1 && r.state?.alphaFactor === 1 && v.uAlpha?.ref?.value === 1
    && v.dXrayShaded?.ref?.value === 'off' && v.dClipping?.ref?.value !== true && v.dClipPrimitive?.ref?.value !== true
    && v.dWiggle?.ref?.value !== true && !(v.uWiggleAmplitude?.ref?.value > 0) && !(v.uTumbleAmplitude?.ref?.value > 0)
    && lod?.length === 4 && Number.isFinite(lod[0]) && Number.isFinite(lod[1]) && lod[0] === 0 && lod[1] === 0
    && (!lodLevels || lodLevels.length === 0);
}

function sphereOcclusionProgramReady(program: any): boolean {
  if (!program) return false;
  try {
    return !!program.isReady?.() || !!program.finalize?.(false);
  } catch { return false; }
}

/** Compose after patchMolstarOpaqueRendererSource. The optional fourth
 * argument is the runtime-owned per-eye proxy depth texture. */
export function patchSphereOcclusionRendererSource(source: string): string {
  if (!source.includes('stereofoldCanUseOpaqueMesh')) throw Error('Apply the opaque-depth renderer patch before sphere occlusion.');
  if (source.includes('stereofoldCanUseSphereOcclusion')) throw Error('Mol* sphere-occlusion renderer patch already applied.');
  const start = '        const renderOpaque = (group, camera, primaryBlendedScene = false) => {';
  const end = '        const renderBlendedTransparent = (group, camera) => {';
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Mol* sphere-occlusion opaque pass boundary changed.');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (b <= a) throw Error('Mol* sphere-occlusion opaque pass ordering changed.');
  let pass = source.slice(a, b);
  pass = replaceOnce(pass, start, `        const stereofoldQuestSphereCull = (${isQuestSphereOcclusionBrowser.toString()})();
        const stereofoldCanUseSphereOcclusion = ${canUseSphereOcclusionRenderable.toString()};
        const stereofoldSphereOcclusionProgramReady = ${sphereOcclusionProgramReady.toString()};
        const renderOpaque = (group, camera, primaryBlendedScene = false, sphereCullDepthTexture = null) => {`);
  pass = replaceOnce(pass, 'updateInternal(group, camera, null, Mask.Opaque, false);',
    'updateInternal(group, camera, primaryBlendedScene && stereofoldQuestSphereCull ? sphereCullDepthTexture : null, Mask.Opaque, false);');
  const stockVariant = `                    const variant = primaryBlendedScene && stereofoldQuestOpaque && stereofoldCanUseOpaqueMesh(r)
                        && r.getProgram('colorOpaqueNoDiscard') ? 'colorOpaqueNoDiscard' : 'color';`;
  const count = pass.split(stockVariant).length - 1;
  if (count < 1 || count > 2) throw Error('Mol* opaque color variant block changed; sphere variant was not added.');
  const finalColorVariant = `                    const sphereCullProgram = primaryBlendedScene && stereofoldQuestSphereCull && sphereCullDepthTexture
                        && stereofoldCanUseSphereOcclusion(r) ? r.getProgram('colorSphereCull') : null;
                    const useSphereCull = sphereCullProgram && stereofoldSphereOcclusionProgramReady(sphereCullProgram);
                    const variant = useSphereCull ? 'colorSphereCull'
                        : primaryBlendedScene && stereofoldQuestOpaque && stereofoldCanUseOpaqueMesh(r)
                            && r.getProgram('colorOpaqueNoDiscard') ? 'colorOpaqueNoDiscard' : 'color';`;
  const last = pass.lastIndexOf(stockVariant);
  pass = pass.slice(0, last) + finalColorVariant + pass.slice(last + stockVariant.length);
  return source.slice(0, a) + pass + source.slice(b);
}
