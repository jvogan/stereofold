import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { applyCifFieldCaseCompatibility } from '../../lab/identity/cif-field-compat.cjs';
import { CIF } from '../src/compatible-cif.js';
import { parseCompatibleMmcifTrajectory, COMPATIBLE_MMCIF_TRAJECTORY_SOURCE } from '../src/compatible-mmcif-trajectory.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';
import { comparisonRadius } from '../src/inspection-comparison.js';
import { cifFieldBuildPatch, patchMolstarCifFieldSource } from '../src/molstar-cif-field-patch.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const text = readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const lower = text.replaceAll('_atom_site.Cartn_', '_atom_site.cartn_');
const mixed = text.replaceAll('_atom_site.Cartn_x', '_atom_site.cArTn_X').replaceAll('_atom_site.Cartn_y', '_atom_site.CARTN_Y');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizeCatalog = (value: any) => JSON.parse(JSON.stringify(value).replaceAll(value.source.sha256, 'SOURCE_SHA'));
const geometry = (model: any) => ['x', 'y', 'z'].map(axis => Array.from(model.atomicConformation[axis]));

async function parser(layout: 'lib' | 'lib/commonjs', patched: boolean) {
  const result = await build({
    stdin: { contents: `export { CIF } from 'molstar/${layout}/mol-io/reader/cif.js';
      export { trajectoryFromMmCIF } from 'molstar/${layout}/mol-model-formats/structure/mmcif.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: patched ? [cifFieldBuildPatch] : [], logLevel: 'silent',
  });
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}
async function parsedModel(reader: any, value: string) {
  const parsed = await reader.CIF.parse(value).run();
  expect(parsed.isError).toBe(false);
  const trajectory = await reader.trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  return { parsed: parsed.result, model: trajectory.representative };
}

describe('upstream field-name compatibility, pinned text parser', () => {
  it('fails closed on changed anchors, repeated application and unreviewed versions', () => {
    const source = readFileSync(new URL('../node_modules/molstar/lib/mol-io/reader/cif/data-model.js', import.meta.url), 'utf8');
    expect(() => patchMolstarCifFieldSource(source, '5.12.0')).toThrow('reviewed 5.11.0');
    expect(() => patchMolstarCifFieldSource('different', '5.11.0')).toThrow('anchor changed');
    expect(() => patchMolstarCifFieldSource(source + source, '5.11.0')).toThrow('anchor changed');
    expect(() => patchMolstarCifFieldSource(patchMolstarCifFieldSource(source, '5.11.0'), '5.11.0')).toThrow('anchor changed');
  });

  it.each(['lib', 'lib/commonjs'] as const)('uses the real %s parser/trajectory: field cases preserve all atom coordinates', async layout => {
    const stock = await parser(layout, false), fixed = await parser(layout, true);
    const canonical = await parsedModel(stock, text);
    const broken = await parsedModel(stock, lower);
    expect(geometry(broken.model)).not.toEqual(geometry(canonical.model));
    expect(geometry(broken.model).every(axis => axis.every(v => v === 0))).toBe(true);
    for (const source of [text, lower, mixed]) {
      const actual = await parsedModel(fixed, source);
      expect(geometry(actual.model)).toEqual(geometry(canonical.model));
      expect(actual.model.atomicHierarchy.atoms._rowCount).toBe(327);
      expect(actual.parsed.blocks[0].categories.atom_site.fieldNames).toContain(source === lower ? 'cartn_x' : source === mixed ? 'cArTn_X' : 'Cartn_x');
    }
    const result = await fixed.CIF.parse('data_t\nloop_\n_atom_site.Cartn_x\n_atom_site.cartn_x\n_atom_site.Cartn_y\n1 2 3\n').run();
    const atom = result.result.blocks[0].categories.atom_site;
    expect(atom.getField('Cartn_x').float(0)).toBe(1);
    expect(atom.getField('cartn_x').float(0)).toBe(2);
    expect(atom.getField('CARTN_X').float(0)).toBe(2);
    expect(atom.getField('missing')).toBeUndefined();
    const categories = await fixed.CIF.parse('data_t\n_Atom_Site.cartn_x 1\n').run();
    expect(categories.result.blocks[0].categories.atom_site).toBeUndefined();
    expect(categories.result.blocks[0].categoryNames).toEqual(['Atom_Site']);
  });

  it('retains parsed object/field identities and save frames, with exact-name preference', async () => {
    const stock = require('molstar/lib/commonjs/mol-io/reader/cif.js').CIF;
    const result = await stock.parse('data_t\n_a.Foo 1\n_a.foo 2\nsave_s\n_a.BAR 3\nsave_\n').run();
    expect(result.isError).toBe(false);
    const file = result.result, frame = file.blocks[0], cat = frame.categories.a;
    const metadata = { names: cat.fieldNames, field: cat.getField('Foo'), header: frame.header, categories: frame.categories };
    expect(applyCifFieldCaseCompatibility(file)).toBe(file);
    expect(cat.getField('Foo')).toBe(metadata.field);
    expect(cat.getField('FOO').str(0)).toBe('2');
    expect(cat.fieldNames).toBe(metadata.names);
    expect(frame.categories).toBe(metadata.categories);
    expect(frame.header).toBe(metadata.header);
    expect(frame.saveFrames[0].categories.a.getField('bar').str(0)).toBe('3');
    expect(cat.getField('missing')).toBeUndefined();
  });

  it('keeps source/lab catalog science identical and original-byte identities distinct', async () => {
    const lab = require('../../lab/identity/extract.cjs');
    const canonical: any = await extractInspectionCatalogBytes(text, { assemblyId: '1' });
    for (const source of [text, lower, mixed]) {
      const catalog: any = await extractInspectionCatalogBytes(source, { assemblyId: '1', expectedHash: sha(source) });
      expect(catalog).toEqual(await lab.extractBytes(source, { assemblyId: '1', expectedHash: sha(source) }));
      expect(catalog.source.sha256).toBe(sha(source));
      expect(catalog.source.byteLength).toBe(Buffer.byteLength(source));
      expect(normalizeCatalog(catalog)).toEqual(normalizeCatalog(canonical));
      expect(await comparisonRadius(source, 1, '1')).toBe(await comparisonRadius(text, 1, '1'));
    }
    expect(new Set([text, lower, mixed].map(sha)).size).toBe(3);
    await expect(extractInspectionCatalogBytes(lower, { expectedHash: sha(text) })).rejects.toThrow('SHA-256');
  });

  it('still rejects absent and nonfinite/invalid coordinates after case fallback', async () => {
    await expect(extractInspectionCatalogBytes(lower.replace('_atom_site.cartn_x', '_atom_site.missing_x'))).rejects.toThrow('decimal coordinate syntax');
    for (const value of ['?', '.', 'NaN', 'Infinity', '0x10', '1e400']) {
      const source = lower.replace(/^ATOM\s+[^\n]+/m, line => {
        const values = line.trim().split(/\s+/); values[10] = value; return values.join(' ');
      });
      expect(source).not.toBe(lower);
      await expect(extractInspectionCatalogBytes(source)).rejects.toThrow(/decimal coordinate syntax|finite source coordinate/);
    }
    await expect(extractInspectionCatalogBytes(lower.replaceAll('_atom_site.', '_Atom_Site.'))).rejects.toThrow();
  });

  it('preserves the real parser Task error and observable progress interface', async () => {
    const task = CIF.parse(lower);
    expect(task.runInContext).toBeTypeOf('function');
    const parsed = await task.run();
    expect(parsed.isError).toBe(false);
    if (!parsed.isError) expect(parsed.result.blocks[0].categories.atom_site.getField('Cartn_x')?.float(0)).toBe(17.047);
    const bad = await CIF.parse('data_t\nloop_\n_a.x\n_a.y\n1\n').run();
    expect(bad.isError).toBe(true);
  });

  it('loads the stock detailed-provider transforms and serialized adapter without changing raw data', async () => {
    const previousDocument = globalThis.document;
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement() { return { setAttribute() {} }; }, head: { appendChild() {}, removeChild() {} } };
    const plugin = new PluginContext(DefaultPluginSpec());
    try {
      await plugin.init();
      const loadSerialized = new Function(`return ${COMPATIBLE_MMCIF_TRAJECTORY_SOURCE}`)();
      let expected: any;
      for (const [source, load] of [[text, parseCompatibleMmcifTrajectory], [lower, loadSerialized], [mixed, loadSerialized]] as const) {
        const data = await plugin.builders.data.rawData({ data: source });
        const trajectory = await load(plugin, data, StateTransforms);
        const actual = geometry(trajectory.obj.data.representative);
        if (!expected) expected = actual;
        expect(actual).toEqual(expected);
        expect(data.obj?.data).toBe(source);
      }
      // A trajectory error must remove the intermediate parsed-format cell.
      const data = await plugin.builders.data.rawData({ data: 'data_empty\n_entry.id TEST\n' });
      const before = [...plugin.state.data.cells.keys()];
      await expect(loadSerialized(plugin, data, StateTransforms)).rejects.toThrow();
      expect([...plugin.state.data.cells.keys()]).toEqual(before);
    } finally {
      plugin.dispose();
      if (previousDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = previousDocument;
    }
  });
});
