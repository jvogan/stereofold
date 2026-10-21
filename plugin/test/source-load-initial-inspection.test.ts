import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { ModelSymmetry } from 'molstar/lib/mol-model-formats/structure/property/symmetry.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { Task } from 'molstar/lib/mol-task/index.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';
import { lessonFigureSchema } from '../src/lesson-figure.js';
// @ts-ignore Production atomic figure registry.
import { createLessonFigure } from '../../lab/browser-roundtrip/lesson-figure.mjs';
// @ts-ignore Production source-bound selection adapter.
import { createSelectionAdapter } from '../../lab/browser-roundtrip/selection.mjs';
// @ts-ignore Shared appearance/visibility contracts.
import { normalizeAppearance } from '../../lab/browser-roundtrip/inspection-state.mjs';
// @ts-ignore Shared visibility resolver.
import { availableChains, emptyVisibility, hiddenRowKeys, normalizeVisibility, resolveVisibility } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
function pageFunction(name: string) {
  const start = source.indexOf(`  async function ${name}(`);
  expect(start).toBeGreaterThan(0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

// Real Mol* parsing, canonical identity resolution and CPU representation
// geometry; the canvas boundary records the candidate's first two frames.
// This establishes alpha/mask ordering, not GPU or physical-device pixels.
for (const initialized of [false, true]) it(`the candidate's first frames never expose an unmasked lesson composite (initialized=${initialized})`, async () => {
  const previousDocument = globalThis.document;
  (globalThis as any).document = { addEventListener() {}, removeEventListener() {},
    createElement() { return { setAttribute() {} }; }, head: { appendChild() {}, removeChild() {} } };
  const plugin = new PluginContext(DefaultPluginSpec());
  try {
    await plugin.init();
    const cif = readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
    const catalog: any = await extractInspectionCatalogBytes(cif, { assemblyId: 'asymmetric_unit' });
    (plugin as any).canvas3d = { add() {}, remove() {}, update() {}, mark() {}, syncVisibility() {} };
    const initialInspection = initialized ? { appearance: normalizeAppearance({ background: '#ffffff', opacity: 0 }), frameVisibleFigureOnce: true,
      visibilityPatch: { op: 'only', chains: ['A'], classes: ['polymer'] } } : undefined;
    const settings = { representation: 'cartoon', modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [], initialInspection,
      preserveRoomPlacement: true };
    const backgrounds: number[] = [], frames: number[] = [];
    const context = vm.createContext({ plugin, crypto: webcrypto, Task, ModelSymmetry, StateTransforms, StructureElement, hiddenRowKeys,
      candidateRecords: new Set(), createSelectionAdapter, availableChains, emptyVisibility, normalizeVisibility, resolveVisibility,
      selectedKeys: (keys: string[]) => keys,
      now: () => performance.now(), state: {}, assertContext() {}, assertLoad() {}, recordCost() {},
      buildTransitionCell: (builder: any) => builder.commit(), commitRepresentationUpdate: (builder: any) => builder.commit(),
      asViewerRepresentation: (value: any) => value,
      geometryFor: () => ({ typeParams: {}, level: 'light' }), geometryBudgetReceipt: () => ({}),
      xrRepresentationQuality: () => null, xrRepresentationMaterial: () => null,
      xrBallAndStickParams: () => ({}), xrColorParams: () => null, MolScriptBuilder: {}, experienceVisibilityExpression: () => undefined,
      prepareUploads: async () => {}, liveScene: () => ({ modelNumber: 1, assemblyId: 'asymmetric_unit' }),
      checkpoint: async () => {}, markRecord() {}, Color: (value: number) => value,
      colorNumber: (value: string) => Number.parseInt(value.slice(1), 16),
      retainedRepresentationCount: 0, styleLayers: [],
      canvas: { xr: { isPresenting: { value: false } }, commit() {}, remove() {},
        setProps(value: any) { backgrounds.push(value.renderer.backgroundColor); } },
      waitForFrame: async (candidate: any) => {
        frames.push(candidate.representation.obj.data.repr.props.alpha);
        if (initialized) expect(candidate.visibility.hiddenChains.length).toBeGreaterThan(0);
      },
    });
    vm.runInContext(`${pageFunction('buildCandidate')}\n${pageFunction('showCandidate')}`, context);
    const candidate = await context.buildCandidate({ id: 'private-composite', cif, catalog, sha256: catalog.source.sha256 }, settings);
    if (initialized) {
      expect(candidate.initialFigureFrame.target.radius).toBeLessThan(candidate.structure.obj.data.boundary.sphere.radius);
      expect(candidate.initialFigureFrame.fitted).toEqual({ desktop: false, xr: false });
    }
    expect(candidate.representation.obj.data.repr.renderObjects.some((object: any) => object.values.drawCount.ref.value > 0)).toBe(true);
    await context.showCandidate(candidate, undefined, settings, {});
    expect(frames).toEqual(initialized ? [0, 0] : [1, 1]);
    expect(backgrounds).toEqual(initialized ? [0xffffff] : []);
    if (initialized) {
      let transform = Mat4.identity();
      const renderer = createLessonFigure({ plugin, getStructure: () => candidate.structure, getTransform: () => transform });
      const figure = (chain: string) => lessonFigureSchema.parse({ layers: [
        { id: 'target', target: { chain }, representation: 'gaussian-surface', color: '#b0b0b0' },
        { id: 'binder', target: { chain: chain === 'A' ? 'B' : 'D' }, representation: 'cartoon', color: '#2366ce' },
        { id: 'binder-envelope', target: { chain: chain === 'A' ? 'B' : 'D' }, representation: 'gaussian-surface', color: '#2366ce', opacity: .12 },
      ] });
      await renderer.install(figure('A'));
      const outgoing = renderer.molecular();
      // The wearer keeps moving while the incoming figure awaits geometry.
      // Its final placement must read the latest pose, rather than an entry
      // capture made before the build yielded.
      const add = plugin.builders.structure.representation.addRepresentation;
      const latest = Mat4.fromTranslation(Mat4.identity(), Vec3.create(12, 4, -7));
      plugin.builders.structure.representation.addRepresentation = async (...args: any[]) => {
        const built = await (add as any).apply(plugin.builders.structure.representation, args);
        transform = latest;
        return built;
      };
      await renderer.install(figure('C'));
      expect(renderer.molecular()).toHaveLength(3);
      for (const repr of renderer.molecular()) {
        expect(outgoing).not.toContain(repr);
        expect(Array.from(repr.state.transform)).toEqual(Array.from(latest));
      }
      await renderer.forget();
    }
  } finally {
    (plugin as any).canvas3d = undefined; plugin.dispose();
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
});
