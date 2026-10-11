import { build, type Plugin } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fontAtlasCachePatch, textFontTexturePatch } from '../../src/molstar-font-atlas-patch.js';

let runtimeId = 0;
/** Installed Mol* pipeline, with only browser rasterization replaced. No WebGL. */
export async function labelRuntime(extraPlugins: Plugin[] = []) {
  const source = await readFile(new URL('../../node_modules/molstar/lib/mol-plugin-state/transforms/representation.js', import.meta.url), 'utf8');
  const start = source.indexOf('    update(', source.indexOf('const StructureSelectionsLabel3D ='));
  const end = source.indexOf('\n    },', start) + 6;
  if (start < 0 || end < start) throw Error('Selection-label update anchor changed');
  const result = await build({
    stdin: { resolveDir: new URL('../..', import.meta.url).pathname, contents: `
      import { Task } from 'molstar/lib/mol-task/index.js';
      import { getLabelDataFromStructureSelections } from 'molstar/lib/mol-plugin-state/transforms/helpers.js';
      import { MarkerActions, MarkerAction } from 'molstar/lib/mol-util/marker-action.js';
      import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
      export { LabelRepresentation, LabelParams } from 'molstar/lib/mol-repr/shape/loci/label.js';
      export { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
      export { DataLoci } from 'molstar/lib/mol-model/loci.js';
      export { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
      export { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
      const StateTransformer = { UpdateResult: { Updated: 'updated' } };
      export const update = ({${source.slice(start, end)}}).update;
      export let shapeBuilds = 0;
      const create = TextBuilder.create;
      TextBuilder.create = (...args) => { shapeBuilds++; return create(...args); };
    ` },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [fontAtlasCachePatch, textFontTexturePatch, ...extraPlugins],
  });
  const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text + `\n// runtime ${runtimeId++}`).toString('base64'));
  api.setCanvasModule({ createCanvas: () => ({ getContext: () => ({
    font: '', fillStyle: '', textBaseline: '', measureText: () => ({ width: 4 }),
    clearRect() {}, fillText() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
  }) }) });
  return api;
}

export function labelSource(api: any, x = 1) {
  const loci = api.DataLoci('label-perf', { source: {} }, [0], () => ({ center: [x, 2, 3], radius: 2 }), () => 'Part');
  return { data: [{ key: 'a', structureRef: 'structure', loci }] };
}

export async function labelCell(api: any, a = labelSource(api), props = {}) {
  const repr = api.LabelRepresentation({}, () => api.LabelParams);
  const data = { infos: [{ loci: a.data[0]!.loci }] };
  await repr.createOrUpdate({ fontQuality: 0, customText: 'Part', scaleByRadius: false, ...props }, data).run();
  return { a, b: { data: { repr, sourceData: data } } };
}

export async function updateLabel(api: any, cell: any, patch: object) {
  const oldParams = { ...cell.b.data.repr.props };
  return api.update({ ...cell, oldParams, newParams: { ...oldParams, ...patch } }, {}).run();
}

/** Capture updates from the actual viewer builder/repaint/relayout closures.
 * The existing lab adapter supplies synthetic layout and molecular inputs;
 * staging, committed-param diffing and selection/appearance reasons are real.
 */
export async function viewerLabelWorkload() {
  const { labelHarness } = await import(new URL('../../../lab/browser-roundtrip/fixtures/label-action-harness.mjs', import.meta.url).href);
  const view = labelHarness();
  let step = 0;
  view.h.componentLabelLayout = () => new Map(view.h.emphasisState.parts.map((part: any) => [part.id, {
    offsetX: step ? 1 : 3, offsetY: step ? 2 : 4, depth: 4, sizeScale: step ? 1 : 2,
    alpha: 1, lines: [part.label], leader: { attachment: 'top-center', tetherLength: step ? 2 : 3 },
  }]));
  view.h.componentLabelKeyPlan = () => ({ colours: view.h.emphasisState.parts.map((part: any) => ({ id: part.id, opacity: step ? .4 : 1 })) });
  await view.h.rebuildComponentLabels('initial');
  const initial: [string, any][] = [...view.cells].filter(([, cell]: any) => cell.obj).map(([ref, cell]: any) => [ref, cell.params]);
  return {
    initial,
    async updates(scenario: string, round: number): Promise<[string, any][]> {
      const before = new Map([...view.cells].map(([ref, cell]: any) => [ref, cell.params]));
      if (scenario === 'viewer-appearance') {
        const snapshot = view.h.inspectionSnapshot();
        view.h.inspectionSnapshot = () => ({ ...snapshot, appearance: { ...snapshot.appearance, opacity: round % 2 ? .4 : .8 } });
        await view.h.rebuildComponentLabels('appearance');
      } else if (scenario === 'viewer-selection') {
        await view.h.rebuildComponentLabels('selection');
      } else {
        step = round % 2;
        await view.h.rebuildComponentLabels(scenario === 'viewer-tour' ? 'emphasis+placement' : 'emphasis');
      }
      return [...view.cells].filter(([ref, cell]: any) => cell.obj && cell.params !== before.get(ref))
        .map(([ref, cell]: any) => [ref, cell.params]);
    },
  };
}
