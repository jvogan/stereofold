import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

/** Keep self-contained: embedded in vendor modules by the build transform. */
export function isQuestOpaqueDepthBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'xr' in navigator && /\bOculusBrowser\//.test(navigator.userAgent || '');
  } catch { return false; }
}

/** Re-evaluate at submission, never cache eligibility from an earlier frame.
 * Instance LOD can override uLod during a draw, so exclude it explicitly. */
export function canUseOpaqueDepthMesh(r: any): boolean {
  const v = r.values;
  const lod = v.uLod?.ref?.value;
  const alpha = v.alpha?.ref?.value * r.state.alphaFactor;
  return v.dGeometryType?.ref?.value === 'mesh' && Number.isFinite(alpha) && alpha >= 1
    && v.transparencyAverage?.ref?.value === 0 && v.dTransparency?.ref?.value === false
    && !v.dHasMaterialOpacity?.ref?.value && v.dXrayShaded?.ref?.value === 'off'
    && v.dClipObjectCount?.ref?.value === 0 && v.uDoubleSided?.ref?.value === false
    && v.hasReflection?.ref?.value === false && v.dFlipSided?.ref?.value === false
    && v.dTransparentBackfaces?.ref?.value === 'off'
    && lod?.length === 4 && Array.from(lod).every(Number.isFinite) && lod[0] === 0 && lod[1] === 0
    && (!v.lodLevels?.ref?.value || v.lodLevels?.ref?.value.length === 0);
}

function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error('Mol* opaque-depth source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

/** Compose after the existing blended-transparent renderer transform. */
export function patchMolstarOpaqueRendererSource(source: string): string {
  const start = '        const renderOpaque = (group, camera) => {';
  const end = '        const renderBlendedTransparent = (group, camera) => {';
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Mol* opaque pass boundary changed.');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (b <= a) throw Error('Mol* opaque pass ordering changed.');
  let pass = source.slice(a, b);
  pass = replaceOnce(pass, start, `        const stereofoldQuestOpaque = (${isQuestOpaqueDepthBrowser.toString()})();
        const stereofoldCanUseOpaqueMesh = ${canUseOpaqueDepthMesh.toString()};
        const renderOpaque = (group, camera, primaryBlendedScene = false) => {`);
  pass = replaceOnce(pass, "                    renderObject(r, 'color', Flag.None);", `                    const variant = primaryBlendedScene && stereofoldQuestOpaque && stereofoldCanUseOpaqueMesh(r)
                        && r.getProgram('colorOpaqueNoDiscard') ? 'colorOpaqueNoDiscard' : 'color';
                    renderObject(r, variant, Flag.None);`);
  source = source.slice(0, a) + pass + source.slice(b);
  // renderObject binds the program before render-item can see the transition.
  // Per-item variant selection breaks Mol*'s stock program/material grouping:
  // invalidate both caches when switching programs so material uniforms and
  // textures cannot carry over from a different representation. Do this in
  // renderObject, after culling, so skipped objects do not change cache state.
  return replaceOnce(source, '            if (state.currentProgramId !== program.id) {',
    `            if (state.currentProgramId !== program.id) {
                if (stereofoldQuestOpaque) {
                    state.currentMaterialId = -1;
                    state.currentRenderItemId = -1;
                }`);
}

/** Only the primary blended scene opts in. Helpers and every other pass keep
 * calling renderOpaque with its default false third argument. */
export function patchMolstarOpaqueDrawSource(source: string): string {
  const start = '    _renderBlended(renderer, camera, scene, toDrawingBuffer, transparentBackground, postprocessingProps) {';
  const end = '    _render(renderer, camera, scene, helper, toDrawingBuffer, transparentBackground, props) {';
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Mol* blended draw boundary changed.');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (b <= a) throw Error('Mol* blended draw ordering changed.');
  const pass = replaceOnce(source.slice(a, b), '            renderer.renderOpaque(scene.primitives, camera);',
    '            renderer.renderOpaque(scene.primitives, camera, true);');
  return source.slice(0, a) + pass + source.slice(b);
}

export function patchMolstarOpaqueRenderItemSource(source: string): string {
  source = replaceOnce(source, 'function createProgramVariant(ctx, variant, defineValues, shaderCode, schema) {', `function createProgramVariant(ctx, variant, defineValues, shaderCode, schema) {
    if (variant === 'colorOpaqueNoDiscard') {
        variant = 'colorBlended';
        defineValues = { ...defineValues, dStereofoldOpaqueNoDiscard: ValueCell.create(true) };
        schema = { ...schema, dStereofoldOpaqueNoDiscard: DefineSpec('boolean') };
    }`);
  source = replaceOnce(source, "function getRenderVariant(variant, transparency) {", `function getRenderVariant(variant, transparency) {
    if (variant === 'colorOpaqueNoDiscard') return transparency === 'blended' ? variant : getRenderVariant('color', transparency);`);
  return replaceOnce(source, '    return createRenderItem(ctx, drawMode, shaderCode, schema, values, materialId, GraphicsRenderVariants, transparency);',
    `    const variants = shaderCode.name === 'mesh' && values.dGeometryType?.ref.value === 'mesh' && (${isQuestOpaqueDepthBrowser.toString()})()
        ? [...GraphicsRenderVariants, 'colorOpaqueNoDiscard'] : GraphicsRenderVariants;
    return createRenderItem(ctx, drawMode, shaderCode, schema, values, materialId, variants, transparency);`);
}

export function patchMolstarOpaqueMeshSource(source: string): string {
  const original = source;
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  for (const name of ['fade_lod', 'check_transparency']) {
    const anchor = `    #include ${name}`;
    source = replaceOnce(source, anchor, ['    #if !defined(dStereofoldOpaqueNoDiscard)', anchor, '    #endif'].join(nl));
  }
  return replaceOnce(original, 'export const mesh_frag =', 'const stereofoldStockOpaqueMesh =')
    + '\n' + replaceOnce(source, 'export const mesh_frag =', 'const stereofoldFastOpaqueMesh =')
    + `\nexport const mesh_frag = (${isQuestOpaqueDepthBrowser.toString()})() ? stereofoldFastOpaqueMesh : stereofoldStockOpaqueMesh;`;
}

/** Only unowned modules; the build owner composes renderer/draw pure transforms. */
/** Optional transforms of the same two modules: `meshFrag` runs before this
 * patch's mesh transform and `renderItem` after its render-item transform,
 * since one esbuild plugin owns each vendor module. */
export interface OpaqueDepthComposition { meshFrag?: (source: string) => string; renderItem?: (source: string) => string }
export function opaqueDepthPatch(extra: OpaqueDepthComposition = {}): Plugin {
  return {
    name: 'stereofold-quest-opaque-depth',
    setup(api) {
      let items = 0, meshes = 0;
      api.onStart(() => { items = 0; meshes = 0; });
      api.onLoad({ filter: /molstar[/\\]lib[/\\]mol-gl[/\\](webgl[/\\]render-item|shader[/\\]mesh\.frag)\.js$/ }, async ({ path }) => {
        const { version } = JSON.parse(await readFile(resolve(dirname(path), '../../../package.json'), 'utf8'));
        if (version !== '5.11.0') throw Error('Opaque-depth candidate requires reviewed Mol* 5.11.0.');
        const source = await readFile(path, 'utf8');
        const mesh = /mesh\.frag\.js$/.test(path);
        if (mesh) meshes++; else items++;
        const contents = mesh ? patchMolstarOpaqueMeshSource(extra.meshFrag ? extra.meshFrag(source) : source)
          : (extra.renderItem ?? (item => item))(patchMolstarOpaqueRenderItemSource(source));
        return { contents, loader: 'js' };
      });
      api.onEnd(result => {
        if (!result.errors.length && (items !== 1 || meshes !== 1))
          return { errors: [{ text: `Expected one opaque-depth render-item and mesh shader; got ${items}, ${meshes}.` }] };
      });
    },
  };
}

/** Enabled after exact Quest GPU pixel and live fallback validation.
 * Non-Quest browsers retain their original programs; off is for scratch controls. */
export function opaqueDepthBuildPlugins(value: string | undefined, extra: OpaqueDepthComposition = {}): Plugin[] {
  if (value === '0') return [];
  if (value === undefined || value === '1') return [opaqueDepthPatch(extra)];
  throw Error('STEREOFOLD_OPAQUE_DEPTH_PATCH must be 0 or 1.');
}
