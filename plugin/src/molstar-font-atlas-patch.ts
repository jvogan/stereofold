import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

/** Mol* 5.11 passes all Text props to this process-lifetime cache. A plate's
 * new offset must not retain another atlas (and scratch canvas) forever.
 * Keep both cache identity and construction limited to the font parameters.
 * This changes no geometry, shader, or glyph metrics.
 */
export function patchMolstarFontAtlasSource(source: string): string {
  const needle = `    const hash = JSON.stringify(props);
    if (TextAtlasCache[hash] === undefined) {
        TextAtlasCache[hash] = new FontAtlas(props);`;
  if (source.split(needle).length !== 2) {
    throw Error('Mol* font atlas cache changed; Stereofold patch was not applied.');
  }
  const cached = source.replace(needle, `    const defaults = PD.getDefaultValues(FontAtlasParams);
    const fontProps = Object.fromEntries(Object.keys(defaults).map(key =>
        [key, props[key] === undefined ? defaults[key] : props[key]]));
    const hash = JSON.stringify(fontProps);
    if (TextAtlasCache[hash] === undefined) {
        TextAtlasCache[hash] = new FontAtlas(fontProps);`);
  const glyphWrite = `            this.currentX += this.scratchW;\n`;
  if (cached.split(glyphWrite).length !== 2) {
    throw Error('Mol* font atlas glyph write changed; Stereofold patch was not applied.');
  }
  // `get` extends the Uint8Array in place. Give TextBuilder a new texture
  // wrapper after a successful append so Text.updateIfChanged uploads it; the
  // array itself stays shared with all existing atlas consumers.
  return cached.replace(glyphWrite, `${glyphWrite}            this.texture = { ...this.texture };\n`);
}

export const fontAtlasCachePatch: Plugin = {
  name: 'stereofold-font-atlas-cache',
  setup(api) {
    api.onLoad({ filter: /mol-geo[/\\]geometry[/\\]text[/\\]font-atlas\.js$/ }, async ({ path }) => ({
      contents: patchMolstarFontAtlasSource(await readFile(path, 'utf8')),
      loader: 'js',
    }));
  },
};

/**
 * A label relayout rebuilds its ShapeRepresentation through Mol*'s supported
 * update path. Text.update used to bump the font ValueCell even when a
 * relayout used an already-complete atlas, forcing WebGL to upload unchanged
 * pixels. FontAtlas creates a fresh texture wrapper after each successful
 * glyph append, so object identity distinguishes an append from a repeated
 * glyph while every geometry/state/bounds update remains upstream.
 */
export function patchMolstarTextFontTextureSource(source: string): string {
  const needle = '        ValueCell.update(text.fontTexture, fontTexture);';
  if (source.split(needle).length !== 2) {
    throw Error('Mol* text font update changed; Stereofold texture patch was not applied.');
  }
  return source.replace(needle, '        ValueCell.updateIfChanged(text.fontTexture, fontTexture);');
}

export const textFontTexturePatch: Plugin = {
  name: 'stereofold-text-font-texture-version',
  setup(api) {
    api.onLoad({ filter: /mol-geo[/\\]geometry[/\\]text[/\\]text\.js$/ }, async ({ path }) => ({
      contents: patchMolstarTextFontTextureSource(await readFile(path, 'utf8')),
      loader: 'js',
    }));
  },
};

/** Opt in only loci labels. MultiRepresentation always forwards its retained
 * data, even for createOrUpdate(props), so eligibility must be decided at the
 * ShapeRepresentation boundary, before currentProps is mutated. Every other
 * shape builder keeps the upstream path. Unknown properties fail closed.
 */
export function patchMolstarLabelUniformSource(source: string): string {
  const needle = "    'text': (ctx, getParams) => ShapeRepresentation(getTextShape, Text.Utils),";
  if (source.split(needle).length !== 2) {
    throw Error('Mol* label visual changed; Stereofold uniform patch was not applied.');
  }
  return `import { deepEqual as stereofoldEqual } from '../../../mol-util/index.js';\n` + source.replace(needle, `    'text': (ctx, getParams) => ShapeRepresentation(getTextShape, Text.Utils, {
        canReuseGeometry(data, props, shape, previous) {
            if (!shape || !data || !shape.sourceData) return false;
            const before = shape.sourceData.infos, after = data.infos;
            // Upstream selections are immutable loci. A replacement loci (even
            // with identical coordinates), structure or label must rebuild.
            if (!before || !after || before.length !== after.length) return false;
            for (let i = 0; i < before.length; i++) {
                const keys = new Set([...Object.keys(before[i]), ...Object.keys(after[i])]);
                for (const key of keys) if (before[i][key] !== after[i][key]) return false;
            }
            const uniforms = new Set(['sizeFactor', 'alpha', 'offsetX', 'offsetY', 'offsetZ', 'borderWidth', 'backgroundOpacity']);
            for (const key of new Set([...Object.keys(previous), ...Object.keys(props)])) {
                const next = key in props ? props[key] : previous[key];
                if (uniforms.has(key) && Number.isFinite(next)) continue;
                if (!stereofoldEqual(previous[key], next)) return false;
            }
            return true;
        },
    }),`);
}

export function patchMolstarShapeUniformSource(source: string): string {
  const update = `            const newProps = Object.assign(currentProps, props);
            const shape = data ? await getShape(runtime, data, newProps, _shape) : undefined;`;
  const bounds = '                if (updateState.updateTransform || updateState.createGeometry) {';
  const finish = '            currentProps = newProps;';
  for (const needle of [update, bounds, finish]) {
    if (source.split(needle).length !== 2) {
      throw Error('Mol* shape update changed; Stereofold uniform patch was not applied.');
    }
  }
  return source.replace(update, `            const reuseGeometry = !!builder.canReuseGeometry?.(data, props, _shape, currentProps);
            const newProps = Object.assign(currentProps, props);
            // Run the supported props-only path, including state and events.
            const shape = data && !reuseGeometry ? await getShape(runtime, data, newProps, _shape) : undefined;`)
    .replace(bounds, '                if (updateState.updateTransform || updateState.createGeometry || reuseGeometry) {')
    .replace(finish, `            // Keep picking/source identity synchronized before emitting updated.
            if (reuseGeometry) _shape.sourceData = data;
${finish}`);
}

/** Third browser patch: selection-label geometry reuse plus upstream bounds
 * refresh. One hook owns both anchors so a Mol* upgrade cannot apply half.
 */
export const labelUniformUpdatePatch: Plugin = {
  name: 'stereofold-label-uniform-update',
  setup(api) {
    api.onLoad({ filter: /mol-repr[/\\]shape[/\\](?:loci[/\\]label|representation)\.js$/ }, async ({ path }) => ({
      contents: /loci[/\\]label\.js$/.test(path)
        ? patchMolstarLabelUniformSource(await readFile(path, 'utf8'))
        : patchMolstarShapeUniformSource(await readFile(path, 'utf8')),
      loader: 'js',
    }));
  },
};
