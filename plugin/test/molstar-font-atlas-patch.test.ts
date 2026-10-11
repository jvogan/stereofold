import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { patchMolstarFontAtlasSource, patchMolstarTextFontTextureSource, fontAtlasCachePatch, textFontTexturePatch } from '../src/molstar-font-atlas-patch.js';

// Execute the installed cache, TextBuilder, Text, LabelRepresentation and
// selection-label transformer update. Replace only DOM rasterization/storage:
// allocating hundreds of real 43 MB atlases would make the regression unsafe.
let runtimeId = 0;
async function runtime(patched = true, patchTextureVersion = true) {
  // The negative-control command runs the SAME contract on unpatched Mol*.
  // No assertion changes its expected retention count for that run.
  let load: any;
  fontAtlasCachePatch.setup({ onLoad: (_filter: unknown, callback: unknown) => { load = callback; } } as any);
  const transformer = await readFile(new URL('../node_modules/molstar/lib/mol-plugin-state/transforms/representation.js', import.meta.url), 'utf8');
  const start = transformer.indexOf('    update(', transformer.indexOf('const StructureSelectionsLabel3D ='));
  const end = transformer.indexOf('\n    },', start) + 6;
  expect(start).toBeGreaterThan(0);
  const result = await build({
    stdin: { resolveDir: new URL('..', import.meta.url).pathname, contents: `
      import { Task } from 'molstar/lib/mol-task/index.js';
      export { LabelRepresentation, LabelParams } from 'molstar/lib/mol-repr/shape/loci/label.js';
      export { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
      export { getFontAtlas, retained } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
      export let labelDataBuilds = 0;
      const getLabelDataFromStructureSelections = () => ({ infos: [], build: ++labelDataBuilds });
      const MarkerActions = { Highlighting: 1 }, MarkerAction = { None: 0 };
      const StateTransformer = { UpdateResult: { Updated: 'updated' } };
      export const update = ({${transformer.slice(start, end)}}).update;
    ` },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [
      ...(patchTextureVersion ? [textFontTexturePatch] : []),
      { name: 'count-retained-atlases', setup(api) {
      api.onLoad({ filter: /text[/\\]font-atlas\.js$/ }, async ({ path }) => {
        let source = patched ? (await load({ path })).contents : await readFile(path, 'utf8');
        const from = source.indexOf('export class FontAtlas {'), to = source.indexOf('\nlet _canvas;', from);
        expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
        source = source.slice(0, from) + `
          export const retained = () => Object.keys(TextAtlasCache).length;
          export class FontAtlas {
            constructor(props) { this.props = props; }
            buffer = 1; lineHeight = 10;
            texture = { array: new Uint8Array(1), width: 1, height: 1 };
          }
        ` + source.slice(to);
        return { contents: source, loader: 'js' };
      });
    } }],
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// isolated runtime ${runtimeId++}`).toString('base64'));
}

// This keeps FontAtlas.get itself real. Only the browser canvas is replaced,
// so the test covers its in-place pixel append and the texture wrapper added
// by the production source patch.
async function glyphRuntime(patched: boolean) {
  const result = await build({
    stdin: { resolveDir: new URL('..', import.meta.url).pathname, contents: `
      export { FontAtlas, setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
      export { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
    ` },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: patched ? [fontAtlasCachePatch, textFontTexturePatch] : [],
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// glyph runtime ${runtimeId++}`).toString('base64'));
}

function installCanvas(api: any) {
  api.setCanvasModule({ createCanvas: () => ({ getContext: () => ({
    font: '', fillStyle: '', textBaseline: '',
    measureText: () => ({ width: 4 }), clearRect() {}, fillText() {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
  }) }) });
}

describe('Mol* font atlas retention', () => {
  it('retains exactly one atlas for one font after three non-font update rounds', async () => {
    const api = await runtime(process.env.STEREOFOLD_TEST_STOCK_FONT_ATLAS !== '1');
    const plates = Array.from({ length: 30 }, () => api.LabelRepresentation({}, () => api.LabelParams));
    for (const repr of plates) await repr.createOrUpdate({ fontQuality: 1 }, { infos: [] }).run();
    expect(api.retained()).toBe(1);
    const objects = plates.map(repr => repr.renderObjects[0]);
    try {
      for (let round = 1; round <= 3; round++) {
        for (const [i, repr] of plates.entries()) {
          await api.update({ a: { data: [] }, b: { data: { repr } }, newParams: {
            offsetX: round + i / 100, offsetY: -round, alpha: 1 - round / 10,
            tetherLength: round + i / 10, customText: `Part ${i}, round ${round}`,
          } }, {}).run();
          expect(repr.renderObjects).toHaveLength(1);
          expect(repr.renderObjects[0]).toBe(objects[i]);
        }
      }
      // At 605cf76 this accepted stock's 91. The contract now always expects 1;
      // bypassing the production hook must fail here with received 91.
      expect(api.retained(), 'ONE_ATLAS_PER_FONT_AFTER_THREE_NON_FONT_ROUNDS').toBe(1);
    } finally {
      plates.forEach(repr => repr.destroy());
    }
    expect(api.retained(), 'destruction leaves the single shared CPU atlas').toBe(1);
    expect(objects.every(object => object.state.disposed)).toBe(true);
  });

  it('shares defaults and reordered props but separates every font parameter', async () => {
    const api = await runtime(true);
    const base = api.getFontAtlas({});
    expect(api.getFontAtlas({ offsetX: 20, fontQuality: 3, customText: 'Another plate' })).toBe(base);
    expect(api.getFontAtlas({ fontQuality: undefined })).toBe(base);
    for (const change of [{ fontQuality: 1 }, { fontFamily: 'serif' }, { fontWeight: 'bold' },
      { fontStyle: 'italic' }, { fontVariant: 'small-caps' }]) {
      const atlas = api.getFontAtlas(change);
      expect(atlas).not.toBe(base);
      expect(api.getFontAtlas({ alpha: .2, ...change })).toBe(atlas);
    }
    expect(api.retained()).toBe(6);
  });

  it('keeps the supported representation lifecycle for alpha, size, and changed selections', async () => {
    const api = await runtime(true);
    const repr = api.LabelRepresentation({}, () => api.LabelParams);
    await repr.createOrUpdate({ fontQuality: 1 }, { infos: [] }).run();
    const object = repr.renderObjects[0];
    const geometryBefore = repr.geometryVersion;
    const paddingVersion = object.values.padding.ref.version;
    let events = 0;
    const subscription = repr.updated.subscribe(() => { events++; });
    try {
      await api.update({ a: { data: { selection: 'first' } }, b: { data: { repr } }, newParams: {
        alpha: .4, sizeFactor: 2, customText: 'first selection', offsetX: 1,
      } }, {}).run();
      expect(api.labelDataBuilds, 'selection data is rebuilt for the first update').toBe(1);
      expect(repr.geometryVersion, 'ShapeRepresentation still creates geometry').toBeGreaterThan(geometryBefore);
      expect(events, 'ShapeRepresentation still emits updated').toBe(1);
      expect(object.values.alpha.ref.value, 'alpha still reaches BaseGeometry.updateValues').toBe(.4);
      expect(object.values.uSizeFactor.ref.value, 'size factor still reaches Text.Utils.updateValues').toBe(2);
      expect(object.values.padding.ref.version, 'Text.Utils.updateBoundingSphere still runs').toBeGreaterThan(paddingVersion);

      await api.update({ a: { data: { selection: 'changed' } }, b: { data: { repr } }, newParams: {
        alpha: .7, sizeFactor: 2, customText: 'changed selection', offsetX: 1,
      } }, {}).run();
      expect(api.labelDataBuilds, 'changed selection plus lone alpha update rebuilds source data').toBe(2);
      expect(events, 'every supported update emits an event').toBe(2);
      expect(object.values.alpha.ref.value).toBe(.7);
    } finally {
      subscription.unsubscribe();
      repr.destroy();
    }
  });

  it('rejects a build when the pinned upstream cache anchor is absent', async () => {
    const upstream = await readFile(new URL('../node_modules/molstar/lib/mol-geo/geometry/text/font-atlas.js', import.meta.url), 'utf8');
    const mutated = upstream.replace('const hash = JSON.stringify(props);', 'const hash = JSON.stringify({ ...props });');
    expect(mutated).not.toBe(upstream);
    const message = 'Mol* font atlas cache changed; Stereofold patch was not applied.';
    expect(() => patchMolstarFontAtlasSource(mutated)).toThrow(message);
    expect(patchMolstarFontAtlasSource(upstream)).toContain('this.texture = { ...this.texture };');
    // Keep the module suffix so the real production onLoad filter must match.
    const directory = join(await mkdtemp(join(tmpdir(), 'stereofold-atlas-drift-')), 'mol-geo/geometry/text');
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'font-atlas.js');
    await writeFile(entry, mutated);
    await expect(build({ entryPoints: [entry], bundle: true, write: false,
      plugins: [fontAtlasCachePatch], logLevel: 'silent' }), 'MISSING_ATLAS_ANCHOR_FAILS_BUILD')
      .rejects.toThrow(message);
  });

  it('wires the production font atlas and texture hooks into both browser builds', async () => {
    const buildSource = await readFile(new URL('../scripts/build.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('build.ts', buildSource, ts.ScriptTarget.Latest, true);
    const browserPlugins: string[][] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'plugins' && ts.isArrayLiteralExpression(node.initializer)) {
        const plugins = node.initializer.elements.map(entry => entry.getText(ast));
        if (plugins.includes('fontAtlasCachePatch')) browserPlugins.push(plugins);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(browserPlugins).toHaveLength(2);
    for (const plugins of browserPlugins) expect(plugins).toEqual(expect.arrayContaining([
      'fontAtlasCachePatch', 'textFontTexturePatch', 'labelUniformUpdatePatch',
    ]));
    // The production esbuild hook loads the installed file, without editing it.
    let hook: any;
    fontAtlasCachePatch.setup({ onLoad: (_filter: unknown, callback: unknown) => { hook = callback; } } as any);
    const source = await hook({ path: new URL('../node_modules/molstar/lib/mol-geo/geometry/text/font-atlas.js', import.meta.url).pathname });
    expect(source.contents).toContain('new FontAtlas(fontProps)');
  });

  it('keeps the font texture version when an unchanged cached atlas reaches Text.update', async () => {
    const upstream = await readFile(new URL('../node_modules/molstar/lib/mol-geo/geometry/text/text.js', import.meta.url), 'utf8');
    const patched = patchMolstarTextFontTextureSource(upstream);
    expect(patched).toContain('ValueCell.updateIfChanged(text.fontTexture, fontTexture)');
    expect(patched).toContain('ValueCell.update(text.centerBuffer, centers)');
    let hook: any;
    textFontTexturePatch.setup({ onLoad: (_filter: unknown, callback: unknown) => { hook = callback; } } as any);
    const loaded = await hook({ path: new URL('../node_modules/molstar/lib/mol-geo/geometry/text/text.js', import.meta.url).pathname });
    expect(loaded.contents).toContain('ValueCell.updateIfChanged(text.fontTexture, fontTexture)');
  });

  it('changes only the redundant texture ValueCell write versus upstream Text.update', async () => {
    const upstream = await runtime(true, false);
    const optimized = await runtime(true, true);
    const inputs = () => {
      const texture = { array: new Uint8Array(1), width: 1, height: 1 };
      const centers = new Float32Array([0, 0, 0, 0]);
      return { texture, centers, mappings: new Float32Array(8), depths: new Float32Array(4),
        indices: new Uint32Array(6), groups: new Float32Array(4), tcoords: new Float32Array(8) };
    };
    const check = (Text: any) => {
      const x = inputs();
      const text = Text.create(x.texture, x.centers, x.mappings, x.depths, x.indices, x.groups, x.tcoords, 1);
      const textureVersion = text.fontTexture.ref.version;
      const centersVersion = text.centerBuffer.ref.version;
      Text.create(x.texture, x.centers, x.mappings, x.depths, x.indices, x.groups, x.tcoords, 1, text);
      return { texture: text.fontTexture.ref.version - textureVersion, centers: text.centerBuffer.ref.version - centersVersion };
    };
    expect(check(upstream.Text)).toEqual({ texture: 1, centers: 1 });
    expect(check(optimized.Text)).toEqual({ texture: 0, centers: 1 });
  });

  it('uploads a real appended glyph once, then retains the atlas for repeated glyphs', async () => {
    const api = await glyphRuntime(true);
    installCanvas(api);
    const atlas = new api.FontAtlas({ fontQuality: 0 });
    const beforeAppend = atlas.texture;
    const firstGlyph = atlas.get('A');
    expect(atlas.texture, 'a successful real FontAtlas.get append replaces the wrapper').not.toBe(beforeAppend);
    expect(atlas.texture.array, 'the atlas pixels remain shared').toBe(beforeAppend.array);
    expect(firstGlyph).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    const buffers = () => [new Float32Array(4), new Float32Array(8), new Float32Array(4), new Uint32Array(6), new Float32Array(4), new Float32Array(8)];
    const initial = buffers();
    const text = api.Text.create(atlas.texture, ...initial, 1);
    const initialVersion = text.fontTexture.ref.version;
    const afterA = atlas.texture;
    atlas.get('\u03a9');
    expect(atlas.texture, 'a newly encountered Unicode glyph replaces the wrapper').not.toBe(afterA);
    expect(atlas.texture.array).toBe(afterA.array);
    api.Text.create(atlas.texture, ...buffers(), 1, text);
    expect(text.fontTexture.ref.version, 'the appended glyph reaches WebGL through Text.update').toBe(initialVersion + 1);
    const afterOmega = atlas.texture;
    atlas.get('\u03a9');
    expect(atlas.texture, 'a cached glyph does not replace the wrapper').toBe(afterOmega);
    const uploadedVersion = text.fontTexture.ref.version;
    api.Text.create(atlas.texture, ...buffers(), 1, text);
    expect(text.fontTexture.ref.version, 'a repeated label does not upload unchanged pixels').toBe(uploadedVersion);
  });
});
