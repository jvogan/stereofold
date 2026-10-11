/** Production viewer functions with real Mol* CPU mesh/theme updates. Canvas,
 * label construction and frame delivery are mocked: this measures CPU work and
 * scheduling, never Quest GPU latency or an observed rendered receipt. */
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { harness, viewerSource } from './render-dedupe-harness.mjs';
import { xrColorParams } from './xr-render-budget.mjs';
import { xrBallAndStickParams } from './inspection-appearance.mjs';
import { requireGeometryBudget, geometryBudgetReceipt } from './representation-budget.mjs';

const require = createRequire(import.meta.url);
const mol = path => require(`molstar/lib/commonjs/${path}.js`);
const { CIF } = mol('mol-io/reader/cif');
const { trajectoryFromMmCIF } = mol('mol-model-formats/structure/mmcif');
const { Structure } = mol('mol-model/structure/structure/structure');
const { StructureRepresentationRegistry } = mol('mol-repr/structure/registry');
const { ColorTheme } = mol('mol-theme/color');
const { SizeTheme } = mol('mol-theme/size');
const { Theme } = mol('mol-theme/theme');
export const { createStructureRepresentationParams, createStructureColorThemeParams } = mol('mol-plugin-state/helpers/structure-representation-params');
export const { StructureElement, StructureProperties, Bond } = mol('mol-model/structure');
export const themes = { colorThemeRegistry: ColorTheme.createRegistry(), sizeThemeRegistry: SizeTheme.createRegistry() };
export const registry = new StructureRepresentationRegistry();
export const themePlugin = { representation: { structure: { themes, registry } } };
export async function loadAppearanceStructure(name = '4HHB') {
  const parsed = await CIF.parse(readFileSync(new URL(`../../fixtures/${name}.cif`, import.meta.url), 'utf8')).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  return Structure.ofModel(trajectory.representative);
}
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < a) throw Error(`Missing production function: ${start}`);
  return source.slice(a, b);
}
export async function appearanceRenderHarness(source = viewerSource, { data } = {}) {
  data ??= await loadAppearanceStructure();
  const h = harness(source), c = h.context;
  const geometry = requireGeometryBudget({ representation: 'ball-and-stick', atoms: data.elementCount,
    bonds: data.bondCount, residues: data.atomicResidueCount, deviceClass: 'quest2', presenting: true,
    quality: 'low', standalone: true });
  c.inspectionState.configure({ representation: 'ball-and-stick', labels: true });
  const params = createStructureRepresentationParams(themePlugin, data, { type: 'ball-and-stick', color: 'chain-id',
    colorParams: xrColorParams({ color: 'chain-id' }),
    typeParams: { quality: 'low', ...geometry.typeParams,
      ...(source.includes('xrBallAndStickParams') ? xrBallAndStickParams({ representation: 'ball-and-stick',
        presenting: true, atoms: data.elementCount, level: geometry.level }) : {}) } });
  const provider = registry.get('ball-and-stick');
  const repr = provider.factory(themes, provider.getParams);
  repr.setTheme(Theme.create(themes, { structure: data }, params));
  await repr.createOrUpdate(params.type.params, data).run();
  const cell = h.cells.get(c.representation.ref);
  cell.obj.data.repr = repr; cell.params.values = params;
  // The merged appearance path reads the live cell's
  // params to decide whether a staged swap is needed; a colour change never is.
  c.representation.cell = cell;
  const work = { themeUpdates: 0, fullAppearance: 0, representationUpdates: 0, companionPaints: 0,
    styleRebuilds: 0, ligandRebuilds: 0, visibilityPaints: 0, cameraWrites: 0 };
  const updateRepr = async next => {
    work.representationUpdates++;
    repr.setTheme(Theme.create(themes, { structure: data }, next));
    await repr.createOrUpdate(next.type.params, data).run();
    cell.params.values = next;
  };
  c.representation.update = next => ({ commit: () => updateRepr(next) });
  c.plugin.state.data.build = () => {
    const updates = [];
    return { to: ref => ({ update: next => { updates.push([ref, next]); } }),
      async commit(options) {
        if (!options.revertOnError) throw Error('Missing rollback guard.');
        for (const [ref, next] of updates) {
          if (ref === c.representation.ref) await updateRepr(next);
          else h.cells.get(ref).params.values = next;
        }
      } };
  };
  c.plugin.representation.structure = { themes, registry };
  c.structure.obj.data = data;
  c.canvas.xr.isPresenting.value = true;
  c.canvas.camera.getSnapshot = () => ({ baseline: true });
  c.canvas.camera.setState = () => { work.cameraWrites++; };
  Object.assign(c, { appearanceWork: undefined, Color: value => value, createStructureRepresentationParams, createStructureColorThemeParams,
    INSPECTION_COLORS: new Set(['chain-id', 'element-symbol', 'uniform', 'residue-name', 'sequence-id']),
    xrColorParams, xrBallAndStickParams, geometryBudgetReceipt,
    // The merged appearance path commits through this
    // adapter; off a staged swap it is the plain revert-on-error commit.
    commitRepresentationUpdate: builder => builder.commit({ revertOnError: true }), retainedRepresentationCount: 0,
    geometryFor: () => geometry, appliedGeometryBudget: geometryBudgetReceipt(geometry),
    representationForBudget: value => value, currentXrSession: () => undefined, sessionDeviceClass: () => 'quest2',
    structureAtomSites: () => data.elementCount, xrRepresentationQuality: () => 'low', xrRepresentationMaterial: () => null,
    ligandOverlayForBudget: () => null, ligandAtomSites: () => 0, ligandOverlay: undefined,
    recordCost: (...args) => h.diagnostics.push(args), styleLayerDefinitions: () => [],
    paintCompanion: async () => { work.companionPaints++; },
    rebuildLigandOverlay: async () => { work.ligandRebuilds++; },
    rebuildStyleLayers: async () => { work.styleRebuilds++; },
    paintVisibilityLayers: async () => { work.visibilityPaints++; },
  });
  vm.runInContext(section(source, '  async function applyInspectionAppearance(', '\n  /**\n   * The density tier')
    + (source.includes('  async function applyInspectionColorTheme(')
      ? section(source, '  async function applyInspectionColorTheme(', '\n  async function applyInspectionAppearance(') : ''), c);
  c.lessonFigure = { snapshot: () => null, refresh: async () => {}, drawn: () => true,
    molecular: () => [], annotations: () => [], count: () => 0 };
  const full = c.applyInspectionAppearance;
  c.applyInspectionAppearance = async (...args) => { work.fullAppearance++; return full(...args); };
  if (c.applyInspectionColorTheme) {
    const theme = c.applyInspectionColorTheme;
    c.applyInspectionColorTheme = async (...args) => { work.themeUpdates++; return theme(...args); };
  }
  c.builtRepresentation = 'ball-and-stick';
  await h.select([h.rows[0].key]);
  h.resetCounts();
  return { ...h, work, repr, data, dispose: () => repr.destroy() };
}
async function measure(source, data) {
  const h = await appearanceRenderHarness(source, { data }), samples = [];
  const geometryBefore = h.repr.geometryVersion;
  try {
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      await h.configureInspection({ color: i % 2 ? 'chain-id' : 'element-symbol' });
      samples.push(performance.now() - start);
    }
    const ordered = [...samples].sort((a, b) => a - b);
    return { requests: samples.length, atoms: data.elementCount, bonds: data.bondCount,
      geometryBefore, geometryAfter: h.repr.geometryVersion,
      totalMs: +samples.reduce((a, b) => a + b, 0).toFixed(3), medianMs: +ordered[20].toFixed(3),
      p95Ms: +ordered[37].toFixed(3), ...h.work, ...h.counts };
  } finally { h.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--benchmark')) {
  const at = process.argv.indexOf('--baseline');
  if (at < 0) throw Error('Supply --baseline <viewer.mjs> for a before/after measurement.');
  const baseline = readFileSync(process.argv[at + 1], 'utf8'), data = await loadAppearanceStructure();
  console.log(JSON.stringify({ note: 'Production appearance and mutation functions with real Mol* CPU meshes/themes. Labels, canvas and frame delivery mocked. No browser, GPU, headset or physical rendered receipt.',
    before: await measure(baseline, data), after: await measure(viewerSource, data) }, null, 2));
}
