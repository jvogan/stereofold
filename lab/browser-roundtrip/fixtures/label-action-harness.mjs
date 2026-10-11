import { emptyLessonFigureBinding } from './empty-lesson-figure.mjs';
import { createSelectionBoundsCache } from '../selection-bounds.mjs';
import { normalizeStyles } from '../inspection-styles.mjs';
import { representationLayerRef } from '../scene-transition.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { updatePlacementBounds } from '../placement-bounds.mjs';
import * as facing from '../label-facing.mjs';
import * as layout from '../label-layout.mjs';
import * as componentPaint from '../component-labels.mjs';
import * as measurement from '../component-label-measurement.mjs';
import { syntheticViews } from './component-label-diagnostics.mjs';
import { emptyVisibility, normalizeVisibility } from '../inspection-visibility.mjs';
const solver = process.env.OVERPRINT_LAYOUT_BASELINE ? vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{},
  MOLSTAR_TEXT_EM_PER_SIZE: facing.MOLSTAR_TEXT_EM_PER_SIZE }) : null;
if (solver) vm.runInContext(readFileSync(process.env.OVERPRINT_LAYOUT_BASELINE, 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), solver);
const owner = process.env.OVERPRINT_OWNER_BASELINE ? vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{},}) : null;
if (owner) {
  const source = readFileSync(process.env.OVERPRINT_OWNER_BASELINE, 'utf8');
  vm.runInContext('"use strict";\n' + source.slice(source.indexOf('export function createComponentLabelSession'))
    .replace('export function', 'function'), owner);
}
const viewer = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('../viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const identity = () => Array.from(Mat4.identity());
export function pageFunction(text, name) {
  const start = text.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing ${name}`);
  return '"use strict";\n' + representationLayerRef.toString() + '\n' + text.slice(start, text.indexOf('\n  }', start) + 4);
}
// Run the complete page builder and its installed relayout closure. The adapter
// stages state-tree operations until commit and exposes committed text uniforms
// to the real per-eye measurement, without requiring a GPU.
export function labelHarness(initialLeader = false) {
  const cells = new Map(), commits = [], records = [];
  const parts = Array.from({ length: 10 }, (_, i) => ({ id: `part-${i}`, label: `Part ${i}`,
    // Four metres out at a 0.01 camera scale, so the plates'
    // fifty-unit stand-off is the half-metre push the headset draws, not a
    // fifty-metre one that would put every plate behind the eye.
    keys: [i], color: '#ffffff', center: [(i - 4.5) * 20, 0, -400], radius: 5 }));
  let leader = initialLeader, offsetX = 0, now = 0;
  // Mol* exposes a cell's committed params as `cell.transform.params`.
  const stateCell = cell => Object.defineProperty(cell, 'transform', { get: () => ({ params: cell.params }) });
  const renderObject = (params, center) => {
    const transform = identity(); transform.splice(12, 3, ...center);
    return { state: { visible: true, alphaFactor: 1 }, values: Object.fromEntries(Object.entries({
      aPosition: new Float32Array(12), aMapping: [-1, -.5, 1, -.5, 1, .5, -1, .5],
      aTexCoord: Array(8).fill(10), aDepth: [0, 0, 0, 0], aTransform: transform,
      elements: new Uint32Array([0, 1, 2, 0, 2, 3]), drawCount: 6, instanceCount: 1,
      invariantBoundingSphere: { center: [0, 0, 0], radius: 1 }, boundingSphere: { center, radius: 1 },
      dSizeType: 'uniform', uSize: 1, uSizeFactor: params.sizeFactor,
      uOffsetX: params.offsetX, uOffsetY: params.offsetY, uOffsetZ: params.offsetZ, alpha: params.alpha,
    }).map(([key, value]) => [key, ValueCell.create(value)])) };
  };
  const plugin = { state: { data: { cells } }, build() {
    const pending = [];
    let target;
    const builder = {
      toRoot() { return builder; },
      to(ref) { target = ref; return builder; },
      apply(type, params, { ref }) {
        pending.push({ type, params, ref, parent: target });
        return builder;
      },
      update(fn) { pending.push({ type: 'update', ref: target, fn }); return builder; },
      delete(ref) { pending.push({ type: 'delete', ref }); return builder; },
      async commit(options) {
        commits.push({ operations: pending.map(op => op.type), options });
        let center;
        for (const op of pending) {
          if (op.type === 'delete') {
            for (const ref of cells.keys()) if (ref === op.ref || ref.startsWith(`${op.ref}-`)) cells.delete(ref);
          } else if (op.type === 'selection') {
            center = op.params.selections[0].bundle.center;
            cells.set(op.ref, stateCell({ params: op.params }));
          } else if (op.type === 'label') {
            cells.set(op.ref, stateCell({ params: op.params,
              obj: { data: { repr: { renderObjects: [renderObject(op.params, center ?? cells.get(op.parent).params.selections[0].bundle.center)] } } } }));
          } else {
            const cell = cells.get(op.ref);
            cell.params = op.fn(cell.params);
            const values = cell.obj.data.repr.renderObjects[0].values;
            for (const [uniform, param] of Object.entries({ uSizeFactor: 'sizeFactor', alpha: 'alpha',
              uOffsetX: 'offsetX', uOffsetY: 'offsetY' })) values[uniform].ref.value = cell.params[param];
          }
        }
      },
    };
    return builder;
  } };
  const h = vm.createContext({ ...emptyLessonFigureBinding(),
    // This fixture does not paint, so drawing the selection costs it
    // nothing. `render-dedupe-harness.mjs` is the one that counts paints, and
    // its stub runs the real emphasis pass.
    currentSelectionPlan: () => undefined,
    async paintSelectionOverlay() {}, companionRecord:undefined, retiredComparisons:new Set(),
    restoreCompanion:async value=>{ if(value!==undefined) throw Error('This primary-only fixture does not carry a comparison.'); },
    paintCompanion:async()=>{}, ...facing, ...layout, ...componentPaint, ...measurement, Mat4, Vec3,
    plugin, pendingRoomSeat: false, pendingRoomLabels: false, componentLabelLayoutCache: null, componentLabelBuildSignature: null,
    componentLabelPartsSignature: () => JSON.stringify(parts.map(part => [part.id, part.label, part.keys])),
    currentEmphasisPlan: () => ({}), componentLabelPlateParts: () => parts, componentLabelsWanted: () => true,
    componentLabelKeyPlan: () => ({}), emphasisState: { parts },
    inspectionSnapshot: () => ({ placement: { scale: 1 }, appearance: { highlightColor: '#ffffff' } }),
    xrLabelSizing: () => ({ sizeFactor: .1, characterUnits: .08, pixelsPerRadian: 3000 }),
    presentationTransform: () => Mat4.identity(), applyInspectionTransform: () => {}, updatePlacementBounds,
    selection: { toLoci: keys => parts[keys[0]] },
    componentLabelBounds: createSelectionBoundsCache(loci => loci),
    StructureElement: { Loci: { isEmpty: () => false, getBoundingSphere: loci => loci },
      Bundle: { fromLoci: loci => loci } },
    StateTransforms: { Model: { MultiStructureSelectionFromBundle: 'selection' },
      Representation: { StructureSelectionsLabel3D: 'label' } },
    structure: { ref: 'structure' }, sourceRecord: { sha256: 'fixture' }, state: { generation: 1 }, loadedSphere: () => null,
    componentLabelLayout: () => new Map(parts.map((part, i) => [part.id, {
      offsetX, offsetY: 0, depth: 4, sizeScale: 1, alpha: 1, lines: [part.label],
      // Change the last plate so an early fallback must discard staged updates.
      leader: (i === parts.length - 1 && leader) ? { attachment: 'top-center', tetherLength: 1 } : false,
    }])),
    // Nothing is hidden in this fixture, and a plate rule that
    // reads the hidden set must still find one to read.
    visibilityState: emptyVisibility(), normalizeStyles, stylesState: [], styleLayers: [], emptyVisibility, normalizeVisibility, hiddenSceneKeySet: () => new Set(),
    componentLabelTextWidth: text => text.length * .55, Color: value => value,
    COMPONENT_LABEL_REF: 'plate', COMPONENT_LABEL_LIMIT: 10,
    updateMenuLabelPlates: null, repaintComponentLabelPlates: null, talkCaption: null, menuResolveReason: null, componentLabelMeasurement: null,
    labelMeasurementGate: measurement.createLabelMeasurementGate(), performance: { now: () => now }, now: () => now,
    canvas: { camera: { scale: 0.01 }, xr: { isPresenting: { value: true } } },
    representation: null, ligandOverlay: null,
    recordCost: (kind, detail) => records.push({ kind, ...plain(detail) }),
  });
  vm.runInContext(viewer.match(/function colorNumber\(value\) \{[^\n]+\}/)[0], h);
  vm.runInContext(pageFunction(viewer, 'componentLabelPartsSignature'), h);
  for (const name of ['buildComponentLabelPlates', 'deleteComponentLabelCells', 'measureDrawnComponentLabels']) {
    vm.runInContext(pageFunction(viewer, name), h);
  }
  const session = (owner?.createComponentLabelSession ?? componentPaint.createComponentLabelSession)({
    isPresenting: () => true, wantsLabels: () => true,
    buildPlates: context => h.buildComponentLabelPlates(context),
    deletePlates: refs => h.deleteComponentLabelCells(refs),
    updatePlates: (refs, reason, guard) => h.updateMenuLabelPlates(refs, reason, guard),
  });
  h.componentLabels = session;
  vm.runInContext(pageFunction(viewer, 'rebuildComponentLabels'), h);
  return { h, cells, commits, records, session,
    time(value) { now = value; },
    move(nextLeader = leader) { leader = nextLeader; offsetX = .1; },
    nudge(value) { offsetX = value; },
    measure(time) { now = time; h.measureDrawnComponentLabels({ views: syntheticViews() }); },
  };
}

/** Install real menu callbacks, projection and solver around explicit geometry.
 * Only molecular bounds, glyph advances and the state-tree renderer are adapters. */
export async function menuLayoutHarness(options) {
  const view = labelHarness(), h = view.h;
  const parts = h.emphasisState.parts;
  parts.splice(0, parts.length, ...options.plates.map((p, i) => ({ ...p,
    label: p.text, keys: [i], center: p.anchor, color: '#ffffff' })));
  Object.assign(h, {
    componentLabelViewBasis: () => ({ eye: options.eye, target: options.target, up: options.up, basis: 'head' }),
    componentLabelTextWidth: options.measureText,
    componentLabelOffsetZ: () => options.standoff ?? 0,
    xrLabelSizing: () => ({ sizeFactor: options.characterUnits / .8,
      characterUnits: options.characterUnits, minSizeScale: 1, pixelsPerRadian: 3000 }),
    loadedSphere: () => options.subject ? { center: [0, 0, -1], radius: 0,
      extrema: options.subject.points ?? [] } : null,
    PLATE_FIELD: options.field ?? layout.PLATE_FIELD,
    immersiveSession: { menuRows: () => (options.obstacles ?? []).map(r => [-1, 1].flatMap(x => [-1, 1].map(y =>
      [r.x + x * r.halfWidth, r.y + y * r.halfHeight, -1]))),
      presentation: () => ({ roomMatrix: () => identity() }) },
    applyMatrix4: p => p,
  });
  if (solver) h.layoutComponentPlates = solver.layoutComponentPlates;
  vm.runInContext(pageFunction(viewer, 'componentLabelLayout'), h);
  const start = viewer.indexOf('      onMenuPlaced: ({ reason }');
  h.onMenuPlaced = vm.runInContext('({' + viewer.slice(start, viewer.indexOf('      onPresented:', start)) + '}).onMenuPlaced', h);
  await view.session.rebuild();
  return { ...view, async press(reason = 'collapse,reseat') {
    view.records.length = 0;
    h.onMenuPlaced({ reason });
    while (view.session.busy()) await new Promise(resolve => setImmediate(resolve));
    return view.records;
  } };
}
