import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { normalizePlacement } from '../inspection-state.mjs';
import { requireGeometryBudget, structureGeometryCounts } from '../representation-budget.mjs';
import { syntheticViews } from './component-label-diagnostics.mjs';
import { viewerFunction, realAppearanceWorker } from './menu-invariant-harness.mjs';
import { fitAppearanceInWorker } from '../appearance-fit.mjs';
import { solveAppearanceFit } from '../appearance-fit-worker.mjs';
import { placementFitWithinEnvelope } from '../placement-fit-envelope.mjs';
import { applyMatrix4 } from '../room-lock.mjs';

// Real public coordinates and Mol* CPU representations. Only DOM/GPU and tracked
// poses are adapters. The latter deliberately include non-axis-aligned rotations:
// identity matrices would hide an exact-equality check on the inverted pose.
export async function questTourFit(id, { worker = false, degrees = 10 } = {}) {
  const document = globalThis.document;
  const dom = { addEventListener() {}, removeEventListener() {},
    createElement: () => ({ setAttribute() {} }), head: { appendChild() {}, removeChild() {} } };
  globalThis.document = dom;
  const plugin = new PluginContext(DefaultPluginSpec());
  try { await plugin.init(); } finally { globalThis.document = document; }
  const raw = await plugin.builders.data.rawData({ data: readFileSync(new URL(`../../../fixtures/${id}.cif`, import.meta.url), 'utf8') });
  const trajectory = await plugin.builders.structure.parseTrajectory(raw, 'mmcif');
  const model = await plugin.builders.structure.createModel(trajectory);
  const structure = await plugin.builders.structure.createStructure(model, { name: 'model', params: {} });
  const sphere = structure.obj.data.boundary.sphere;
  const head = Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, Vec3.create(.2, .9, .1)); head[13] = 1.6;
  const render = Mat4.fromRotation(Mat4(), .12, Vec3.create(0, 1, 0));
  const views = syntheticViews().map(view => {
    const roomEye = Mat4.mul(Mat4(), head, view.transform.matrix);
    const sceneEye = Mat4.mul(Mat4(), render, roomEye);
    return { ...view, transform: { matrix: sceneEye, inverse: { matrix: Mat4.invert(Mat4(), sceneEye) } } };
  });
  const cameraScale = .0235;
  const anchor = applyMatrix4(applyMatrix4([.35, 0, -3.6], head), render);
  let placement = { translation: anchor.map((v, i) => (v / cameraScale - sphere.center[i]) / sphere.radius), rotation: [0, 0, 0], scale: 1 };
  // A held plate with an inboard edge 0.02 tangent from the head centre.
  const points = [-.7, -.02].flatMap(x => [-.7, .3].map(y => applyMatrix4([x, y, -1], head)));
  let repr, lastInput;
  const h = vm.createContext({ Mat4, Vec3, normalizePlacement, placementFitWithinEnvelope,
    // The extracted viewer fit uses its enclosing monotonic clock for deadlines.
    now: () => performance.now(),
    canvas: { camera: { scale: cameraScale }, xr: { isPresenting: { value: true } }, webgl: { xr: { session: {} } } },
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: render, labelViews: views },
    loadedSphere: () => sphere, scientificRepresentations: () => [repr],
    inspectionSnapshot: () => ({ placement }), immersiveSession: { platePoints: () => points },
    placementViewWaiters: new Set(), wearerPlacement: { holdsPlacement: () => false },
    talkCaption: { set() {} }, state: { status: 'ready', generation: 1 }, sourceRecord: { sha256: id }, lastPlacementFitEvidence: undefined,
    fitAppearanceInWorker: (options, policy) => {
      lastInput = options;
      return worker ? fitAppearanceInWorker(options, { ...policy, makeWorker: realAppearanceWorker })
        : Promise.resolve(solveAppearanceFit(options));
    },
  });
  for (const name of ['placementTransform', 'capturePlacementFitEvidence', 'clearHeldPlatePlacement'])
    vm.runInContext(viewerFunction(name), h);
  h.presentationTransform = () => h.placementTransform(placement);
  const cache = new Map();
  let appearance = { representation: 'cartoon', color: 'chain-id' };
  return { h, sphere, cameraScale, sites: structure.obj.data.elementCount,
    async step(step) {
      appearance = { ...appearance, ...step.appearance };
      const key = JSON.stringify(appearance);
      repr = cache.get(key);
      if (!repr) {
        const geometry = requireGeometryBudget({ ...structureGeometryCounts(structure.obj.data), representation: appearance.representation,
          presenting: true, deviceClass: 'quest2', quality: 'low' });
        const cell = await plugin.state.data.build().to(structure).apply(StateTransforms.Representation.StructureRepresentation3D,
          createStructureRepresentationParams(plugin, structure.obj.data, { type: appearance.representation, color: appearance.color,
            typeParams: { quality: 'low', ...geometry.typeParams } })).commit();
        repr = cell.obj.data.repr; cache.set(key, repr);
      }
      repr.setState({ transform: h.placementTransform(placement) });
      const requested = normalizePlacement(step.placement ?? {}, placement);
      const evidence = h.capturePlacementFitEvidence(h.latestRoomPlacementPose, sphere);
      // Compute independently too, so a page rejection still exposes the exact
      // production solver output and clause in the baseline diagnostic.
      const options = { seat: requested, fit: true, keepClearSeat: true, points, headInRoom: head, renderFromRoom: render,
        cameraScale, center: sphere.center, radius: sphere.radius,
        geometry: { objects: repr.renderObjects, fromPlacement: h.presentationTransform(),
          toPlacement: h.placementTransform(requested), views } };
      const fitted = solveAppearanceFit(options);
      let actual;
      // The production appearance rebuild asks the fit to keep an already-clear seat.
      try { actual = await h.clearHeldPlatePlacement(requested, { keepClearSeat: true }); }
      catch (error) {
        const affine = { ...evidence, headFromScene: [...evidence.headFromScene] };
        affine.headFromScene[15] = 1;
        error.message += ` ${JSON.stringify({ requested, fitted, evidence,
          passesWithAffineW: placementFitWithinEnvelope(requested, fitted, affine) })}`;
        throw error;
      }
      placement = actual;
      return { requested, actual, fitted, evidence, input: lastInput,
        placementAdjusted: actual.scale !== requested.scale
          || actual.translation.some((value, axis) => value !== requested.translation[axis]) };
    },
    dispose() { const previous = globalThis.document; globalThis.document = dom;
      try { plugin.dispose(); } finally { globalThis.document = previous; } },
  };
}
