import { lessonLabelInk, LESSON_LABEL_BACKGROUND_OPACITY } from './lesson-label-style.mjs';
import { registerImmersiveAnnotation, copyImmersiveAnnotation, sizeImmersiveAnnotation, surfaceAnchorCandidates } from './immersive-annotations.mjs';
import { OrderedSet } from 'molstar/lib/mol-data/int.js';
import { selectAnimationTrack } from './animation-selection.mjs';
import { evaluateTrackVisibility } from '../../packages/motion/src/keyframes.mjs';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder.js';
import { Script } from 'molstar/lib/mol-script/script.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { StructureSelection } from 'molstar/lib/mol-model/structure/query.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { CylindersBuilder } from 'molstar/lib/mol-geo/geometry/cylinders/cylinders-builder.js';
import { Cylinders } from 'molstar/lib/mol-geo/geometry/cylinders/cylinders.js';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation.js';
import { figureRepresentationLayers, figureLayerRepresentation } from './lesson-figure-appearance.mjs';
import { requireSceneGeometryBudget, structureGeometryCounts } from './representation-budget.mjs';

const NO_ANNOTATIONS = [];
const ink = value => Color(parseInt(value.slice(1), 16));
const typeName = value => value === 'sticks' ? 'ball-and-stick' : value;
const targetIdentity = target => [target.chain, target.residues?.from, target.residues?.to,
  target.residueNumbers ? [...target.residueNumbers].sort((a, b) => a - b) : undefined, target.componentId, target.atomName];
export function figureTargetExpression(target) {
  const p = MS.struct.atomProperty.macromolecular;
  const tests = [MS.core.rel.eq([p.auth_asym_id(), target.chain])];
  if (target.residues) tests.push(MS.core.rel.inRange([p.auth_seq_id(), target.residues.from, target.residues.to]));
  if (target.residueNumbers) tests.push(MS.core.set.has([MS.set(...target.residueNumbers), p.auth_seq_id()]));
  if (target.componentId) tests.push(MS.core.rel.eq([p.label_comp_id(), target.componentId]));
  if (target.atomName) tests.push(MS.core.rel.eq([p.label_atom_id(), target.atomName]));
  return MS.struct.generator.atomGroups({ 'atom-test': MS.core.logic.and(tests) });
}
export function figureTargetMatchesRow(target, row) {
  const i = row.identity;
  return i.authorChain === target.chain
    && (!target.residues || (Number(i.authorResidue) >= target.residues.from && Number(i.authorResidue) <= target.residues.to))
    && (!target.residueNumbers || i.authorResidue != null && target.residueNumbers.includes(Number(i.authorResidue)))
    && (!target.componentId || i.componentId === target.componentId);
}
export function resolveFigureLoci(target, structure) {
  return StructureSelection.toLociWithSourceUnits(Script.getStructureSelection(figureTargetExpression(target), structure));
}

/** Atom positions of a selection, in the frame its plate is anchored in. */
export function lociPositions(loci) {
  const out = [], p = Vec3();
  for (const { unit, indices } of loci.elements) for (let i = 0, n = OrderedSet.size(indices); i < n; i++) {
    unit.conformation.position(unit.elements[OrderedSet.getAt(indices, i)], p);
    out.push(p[0], p[1], p[2]);
  }
  return out;
}

// Track loci are fixed per animation definition and source; resolve once.
const trackLoci = new WeakMap();
function startHiddenTracks(definition, data) {
  if (!definition?.tracks?.length || !data) return [];
  let bySource = trackLoci.get(definition);
  if (!bySource) trackLoci.set(definition, bySource = new WeakMap());
  if (!bySource.has(data)) bySource.set(data, definition.tracks.map(track => ({ id: track.id,
    visible: evaluateTrackVisibility(track, 0), loci: selectAnimationTrack(data, track) })));
  return bySource.get(data);
}
/** Whether every animation track that moves this selection is hidden at t=0. */
export function hiddenAtAnimationStart(definition, data, loci) {
  let owned = false;
  for (const track of startHiddenTracks(definition, data)) {
    if (StructureElement.Loci.isEmpty(StructureElement.Loci.intersect(loci, track.loci))) continue;
    if (track.visible) return false;
    owned = true;
  }
  return owned;
}

/** Depth-bearing dashes shared by measurements and transform-only tethers. */
export async function createDashedLineRepresentation(name, from, to, color, label = '', dashLength = .35) {
  const cylinders = CylindersBuilder.create(32, 32);
  cylinders.addFixedLengthDashes(from, to, dashLength, 1, true, true, false, 0);
  const shape = Shape.create(name, {}, cylinders.getCylinders(), () => ink(color), () => .07, () => label);
  const repr = ShapeRepresentation(() => shape, Cylinders.Utils);
  try { await repr.createOrUpdate({ alpha: 1, quality: 'low' }, {}).run(); }
  catch (error) { repr.destroy(); throw error; }
  return repr;
}

/** Stage complete 3D layers before retiring the previous figure. Source change drops all refs.
 * `plateGate(figure)` returns a predicate that says whether a target is drawn
 * by the scene (chapter visibility and fade); `animationOwns(repr)` names the
 * plates a running animation shows and hides by its own clock; `getAnimation`
 * names the running animation for a figure installed without a chapter. */
export function createLessonFigure({ plugin, getStructure, getTransform, getGeometryOptions = () => ({}), getGeometryEntries = () => [],
  plateGate = () => () => true, animationOwns = () => false, getAnimation = () => undefined, getCoordinateFrame = () => undefined }) {
  let lociSource, lociCache = new Map();
  // Only an authored shared coordinate frame may carry label offsets between
  // distinct source objects. Tokens belong to this viewer registry, not a
  // process-wide string cache; ordinary sources retain weak object identity.
  const coordinateFrames = new Map();
  // The animation of the chapter on screen, also while it has no figure: its
  // t=0 state is the static scene before, during and after its installation.
  let current, context, serial = Promise.resolve(), pending = 0;
  const enqueue = work => {
    pending++;
    const operation = serial.then(work).finally(() => { pending--; });
    serial = operation.catch(() => {});
    return operation;
  };
  let sourceEpoch = 0;
  // Canvas removals may lag several installs; weak ownership must outlive a
  // figure generation without keeping retired geometry alive.
  const ownedRenderObjects = new WeakSet();
  const liveRepresentations = (record = current) => (record?.representations ?? [])
    .filter(cell => cell.manual || plugin.state.data.cells.has(cell.ref)).map(cell => cell.obj.data.repr);
  const rememberOwned = record => {
    for (const repr of liveRepresentations(record)) for (const object of repr.renderObjects) ownedRenderObjects.add(object);
  };
  const removeRoots = async (record, retained = new Set()) => {
    rememberOwned(record);
    const refs = (record?.roots ?? []).filter(ref => !retained.has(ref) && plugin.state.data.cells.has(ref));
    if (!refs.length) return;
    const builder = plugin.build();
    for (const ref of refs) builder.delete(ref);
    await builder.commit({ revertOnError: true });
    if (plugin.state.data.reverted) throw Error('Could not retire the previous molecular figure.');
  };
  const removeManual = record => {
    for (const cell of record?.representations ?? []) if (cell.manual) {
      plugin.canvas3d.remove(cell.obj.data.repr); cell.obj.data.repr.destroy();
    }
  };
  const remove = async (record, retained) => { await removeRoots(record, retained); removeManual(record); };
  const layerIntact = layer => plugin.state.data.cells.get(layer.root)?.obj?.data === layer.componentData
    && plugin.state.data.cells.get(layer.cell.ref)?.obj?.data?.repr === layer.repr
    && layer.modifiers.every(ref => plugin.state.data.cells.has(ref));
  const labelIntact = label => plugin.state.data.cells.get(label.root)?.obj?.data === label.selectionData
    && plugin.state.data.cells.get(label.cell.ref)?.obj?.data?.repr === label.repr
    && JSON.stringify(plugin.state.data.cells.get(label.cell.ref)?.params?.values) === label.params;
  const externalGeometryIdentity = (...records) => {
    const owned = new Set(records.flatMap(record => liveRepresentations(record)));
    for (const repr of owned) for (const object of repr.renderObjects) ownedRenderObjects.add(object);
    const identity = [];
    for (const cell of plugin.state.data.cells.values()) {
      const repr = cell.obj?.data?.repr;
      if (repr && !owned.has(repr)) identity.push(repr, ...repr.renderObjects);
    }
    // Main-scene objects include manual/third-party scientific meshes; menu
    // presentation objects live in a separate scene. State cells above also
    // cover new molecular objects not yet committed to the canvas scene.
    for (const object of plugin.canvas3d.getRenderObjects?.() ?? []) {
      if (!ownedRenderObjects.has(object)) identity.push(object);
    }
    return [...new Set(identity)];
  };
  const sameIdentity = (a, b) => a?.length === b.length && b.every((value, index) => a[index] === value);
  const applyTransform = record => {
    for (const repr of liveRepresentations(record)) {
      repr.setState({ transform: getTransform() });
      plugin.canvas3d.update(repr, false);
    }
  };
  // Every plate, static or attached to a moving body, follows one rule: it
  // shows only while the part it names is drawn. `gate.shown` is the scene's
  // part (chapter visibility and fade); a running animation adds its track.
  // `gate.rest` adds the track at t=0, for a scene with no clock. Copies of a
  // part on exclusive tracks therefore name only the copy on screen.
  const decidePlates = (record, plan) => {
    for (const layer of record?.layerRecords ?? [])
      layer.startHidden = Boolean(layer.loci) && hiddenAtAnimationStart(record.animation, record.structureData, layer.loci);
    if (!record?.plates?.length) return;
    const gate = plateGate(record.figure, plan);
    for (const plate of record.plates) {
      plate.gate.shown = plate.targets.every(target => gate(target));
      plate.gate.rest = plate.gate.shown && !hiddenAtAnimationStart(record.animation, record.structureData, plate.loci);
    }
  };
  const showPlates = (record, deferReveal) => {
    let changed = false;
    // A static figure draws one state: layers of copies hidden at t=0 wait for their track.
    if (!deferReveal) for (const layer of record?.layerRecords ?? []) {
      if (animationOwns(layer.repr) || !plugin.state.data.cells.has(layer.cell.ref)) continue;
      if (plugin.state.data.cells.get(layer.cell.ref).state.isHidden === layer.startHidden) continue;
      plugin.state.data.updateCellState(layer.cell.ref, { isHidden: layer.startHidden }); changed = true;
    }
    for (const plate of record?.plates ?? []) for (const cell of plate.cells) {
      const repr = cell.obj.data.repr;
      if (!deferReveal && animationOwns(repr)) continue;
      const visible = !deferReveal && plate.gate.rest;
      if (cell.manual) {
        if (repr.state.visible === visible) continue;
        repr.setState({ visible }); plugin.canvas3d.update(repr, false); changed = true;
      } else if (plugin.state.data.cells.get(cell.ref)?.state.isHidden !== !visible || repr.state.visible !== visible) {
        plugin.state.data.updateCellState(cell.ref, { isHidden: !visible }); changed = true;
      }
    }
    return changed;
  };
  // A plate the rule keeps hidden is still drawn evidence of this figure.
  const ruledOut = repr => !current?.deferredReveal
    && ((current?.plates ?? []).some(plate => !plate.gate.rest && plate.cells.some(cell => cell.obj.data.repr === repr))
      || (current?.layerRecords ?? []).some(layer => layer.startHidden && layer.repr === repr));
  const geometryEntries = (figure = current?.figure) => {
    if (!figure?.representationOverride) return [];
    const data = getStructure()?.obj?.data;
    if (!data) throw Error('A molecular figure needs loaded atomic coordinates.');
    return figureRepresentationLayers(figure).map(layer => {
      const loci = resolveFigureLoci(layer.target, data);
      if (StructureElement.Loci.isEmpty(loci)) throw Error(`Figure target did not resolve: ${JSON.stringify(layer.target)}`);
      const selected = StructureElement.Loci.toStructure(loci);
      const representation = figureLayerRepresentation(layer, selected);
      return { representation, ...structureGeometryCounts(selected, representation) };
    });
  };
  const install = async (figure, options = {}) => {
    const { deferReveal = false } = options;
    const started = performance.now();
    const structure = getStructure(), presenting = Boolean(plugin.canvas3d?.xr?.isPresenting?.value);
    const structureData = structure?.obj?.data, epoch = sourceEpoch;
    // The chapter's animation decides which state copies the static figure
    // names. A rebuild of the same figure keeps it; a new figure states it.
    const animation = 'animation' in options ? options.animation
      : current && JSON.stringify(current.figure) === JSON.stringify(figure) ? context : getAnimation();
    const geometryOptions = { quality: 'low', ...getGeometryOptions(), presenting };
    const otherGeometry = figure?.representationOverride ? getGeometryEntries() : [];
    const signature = JSON.stringify([figure, presenting, geometryOptions, otherGeometry]);
    if (current && current.structure === structure && current.structureData === structureData && current.signature === signature
      && current.representations.every(cell => cell.manual || plugin.state.data.cells.has(cell.ref))
      && current.layerRecords.every(layerIntact) && current.labelRecords.every(labelIntact)) {
      context = current.animation = animation;
      decidePlates(current);
      showPlates(current, deferReveal);
      current.deferredReveal = deferReveal;
      return;
    }
    if (!figure) { const old = current; await remove(old); current = undefined; context = animation; return; }
    if (!structure?.obj?.data) throw Error('A molecular figure needs loaded atomic coordinates.');
    if (lociSource !== structureData) { lociSource = structureData; lociCache.clear(); }
    const lociFor = target => {
      const key = JSON.stringify(targetIdentity(target));
      if (lociCache.has(key)) return lociCache.get(key);
      const loci = resolveFigureLoci(target, structure.obj.data);
      if (StructureElement.Loci.isEmpty(loci)) throw Error(`Figure target did not resolve: ${JSON.stringify(target)}`);
      lociCache.set(key, loci);
      return loci;
    };
    // Resolve all targets and measured endpoints before changing any live cells.
    const layers = figureRepresentationLayers(figure).map(layer => {
      const loci = lociFor(layer.target), data = StructureElement.Loci.toStructure(loci);
      return { ...layer, loci, representation: figureLayerRepresentation(layer, data), data,
        overrides: (layer.colorOverrides ?? []).map(override => ({ ...override, loci: lociFor(override.target) })) };
    });
    const labels = figure.labels.map(label => ({ ...label, loci: lociFor(label.target) }));
    const distances = figure.distances.map(distance => {
      const a = lociFor(distance.a), b = lociFor(distance.b);
      if (StructureElement.Loci.size(a) !== 1 || StructureElement.Loci.size(b) !== 1)
        throw Error('A figure distance must resolve to exactly one atom at each end.');
      const measured = Vec3.distance(StructureElement.Loci.getBoundingSphere(a).center, StructureElement.Loci.getBoundingSphere(b).center);
      if (distance.expectedAngstrom != null && Math.abs(measured - distance.expectedAngstrom) > .02)
        throw Error(`Figure distance ${distance.id} does not match its source-backed measurement.`);
      return { ...distance, targets: [distance.a, distance.b], a, b, measured };
    });
    const atomSites = layers.reduce((sum, layer) => sum + StructureElement.Loci.size(layer.loci), 0);
    if (atomSites > 20000) throw Error('A layered lesson figure is limited to 20,000 represented atom sites. Use a simpler scene for this source.');
    // Authored envelopes keep their existing mesh settings. A global wearer
    // choice may introduce thousands of atom spheres or bonds, so admit the
    // actual selected parts together with the base, comparison and scoped
    // meshes before changing any live cells. An almost transparent base still
    // builds geometry and cannot spend a second device allowance.
    const geometry = figure.representationOverride ? requireSceneGeometryBudget([...otherGeometry, ...layers.map(layer => ({
      representation: layer.representation, ...structureGeometryCounts(layer.data, layer.representation),
    }))], geometryOptions).slice(otherGeometry.length) : [];
    const resolvedAt = performance.now();
    let layersAt, annotationsAt;
    const staged = { signature, structure, structureData, figure, animation, plates: [], roots: [], representations: [], molecular: [], placement: [], motionAnnotations: [], layerRecords: [], labelRecords: [], annotationRepresentations: [], atomSites,
      layers: layers.length, labels: labels.length, distances: distances.map(d => ({ id: d.id, angstrom: d.measured })),
      ...(figure.representationOverride ? { representationOverride: figure.representationOverride,
        layerRepresentations: layers.map(layer => ({ id: layer.id, representation: layer.representation })) } : {}) };
    const retainedRoots = new Set(), alphaUpdates = [];
    const previous = current;
    staged.externalGeometry = externalGeometryIdentity(previous);
    const layerPlans = layers.map((layer, index) => {
      const typeParams = { alpha: layer.opacity, quality: 'low',
        ...(layer.representation === 'gaussian-surface' ? { resolution: 1.5, smoothness: 1.5 } : {}),
        ...(layer.sizeFactor != null ? { sizeFactor: layer.sizeFactor } : {}),
        ...(layer.representation === 'ball-and-stick' ? { sizeFactor: layer.sizeFactor ?? .22, sizeAspectRatio: .7 } : {}),
        ...(layer.representation === 'sticks' ? { sizeFactor: layer.sizeFactor ?? .14, sizeAspectRatio: 1,
          visuals: ['intra-bond', 'inter-bond'], adjustCylinderLength: false } : {}),
        ...(geometry[index]?.typeParams ?? {}),
      };
      const { alpha, ...geometryParams } = typeParams;
      const key = JSON.stringify([targetIdentity(layer.target), layer.representation, geometryParams, ink(layer.color),
        (layer.colorOverrides ?? []).map(value => [targetIdentity(value.target), ink(value.color)])]);
      return { layer, typeParams, alpha, key };
    });
    // Mol* transparent order depends on material/render-object IDs. Retain
    // only the unchanged authored prefix: all new layers must follow it. New
    // external molecular objects also force rebuilding after those objects.
    let reusePrefix = 0;
    if (previous?.structure === structure && previous.structureData === structureData
      && sameIdentity(previous.externalGeometry, staged.externalGeometry)) {
      while (reusePrefix < layerPlans.length) {
        const { layer, key } = layerPlans[reusePrefix], old = previous.layerRecords[reusePrefix];
        if (!old || old.id !== layer.id || old.key !== key || !layerIntact(old)) break;
        reusePrefix++;
      }
    }
    // Opaque layers are depth-tested; their material IDs need not track author
    // order. Keep the conservative prefix rule for translucent compositions.
    const opaqueReuse = previous?.structure === structure && previous.structureData === structureData
      && previous.layerRecords.every(layer => layer.opacity === 1)
      && layerPlans.every(plan => plan.alpha === 1);
    const usedLayers = new Set();
    const labelParams = label => ({ customText: label.text, textColor: Color(lessonLabelInk(ink(label.color))),
      textSize: 1, sizeFactor: label.sizeFactor * (presenting ? 6 : 1), scaleByRadius: false, fontQuality: 3,
      offsetX: label.offsetX, offsetY: label.offsetY, offsetZ: 3,
      background: true, backgroundColor: Color(0xffffff), backgroundOpacity: LESSON_LABEL_BACKGROUND_OPACITY,
      backgroundMargin: .25, borderWidth: 0, tether: false });
    try {
      for (const [index, { layer, typeParams, alpha, key }] of layerPlans.entries()) {
        const old = index < reusePrefix ? previous.layerRecords[index] : opaqueReuse
          ? previous.layerRecords.find(record => record.key === key && !usedLayers.has(record) && layerIntact(record)) : undefined;
        if (old) usedLayers.add(old);
        if (old) {
          const retained = { ...old, id: layer.id, opacity: alpha, loci: layer.loci };
          retainedRoots.add(old.root); staged.roots.push(old.root);
          staged.layerRecords.push(retained); staged.representations.push(old.cell); staged.molecular.push(old.cell);
          if (!layer.context) staged.placement.push(old.cell);
          if (old.opacity !== alpha) alphaUpdates.push(retained);
          continue;
        }
        const ref = `stereofold-figure-${crypto.randomUUID()}`;
        staged.roots.push(ref);
        const component = await plugin.builders.structure.tryCreateComponentFromExpression(structure,
          figureTargetExpression(layer.target), ref, { label: layer.id, tags: ['stereofold-lesson-figure'] });
        if (!component) throw Error(`Figure layer ${layer.id} could not be built.`);
        // tryCreateComponent keys are deterministic hashes, not the requested key itself.
        staged.roots[staged.roots.length - 1] = component.ref;
        const repr = await plugin.builders.structure.representation.addRepresentation(component, {
          type: typeName(layer.representation), color: 'uniform', colorParams: { value: ink(layer.color) },
          typeParams,
        }, { initialState: { isHidden: true }, tags: ['stereofold-lesson-figure'] });
        if (!repr?.obj) throw Error(`Figure layer ${layer.id} did not produce geometry.`);
        staged.representations.push(repr); staged.molecular.push(repr);
        if (!layer.context) staged.placement.push(repr);
        const record = { id: layer.id, key, root: component.ref, cell: repr, repr: repr.obj.data.repr,
          componentData: component.obj.data, modifiers: [], opacity: alpha, loci: layer.loci };
        staged.layerRecords.push(record);
        if (layer.overrides.length) {
          const builder = plugin.build().to(repr.ref).apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle, {
            layers: layer.overrides.map(override => ({
              bundle: StructureElement.Bundle.fromLoci(StructureElement.Loci.remap(override.loci, component.obj.data)),
              color: ink(override.color), clear: false,
            })),
          });
          record.modifiers.push(builder.selector.ref);
          await builder.commit();
        }
      }
      layersAt = performance.now();
      const addSelections = (loci, label) => {
        const ref = `stereofold-figure-${crypto.randomUUID()}`;
        staged.roots.push(ref);
        return plugin.build().toRoot().apply(StateTransforms.Model.MultiStructureSelectionFromBundle, {
          selections: loci.map((value, index) => ({ key: String(index), ref: structure.ref,
            bundle: StructureElement.Bundle.fromLoci(value) })), isTransitive: true, label,
        }, { ref, dependsOn: [structure.ref] });
      };
      const usedLabels = new Set();
      for (const label of labels) {
        const key = JSON.stringify([targetIdentity(label.target), labelParams(label), label.maxOffsetEm ?? 2, label.desktopSizePx, label.placement]);
        const old = previous?.structure === structure && previous.structureData === structureData
          ? previous.labelRecords.find(record => record.key === key && !usedLabels.has(record)
            && labelIntact(record)) : undefined;
        const plate = { targets: [label.target], loci: label.loci, gate: { shown: true, rest: true } };
        if (old) {
          usedLabels.add(old); retainedRoots.add(old.root); staged.roots.push(old.root);
          staged.representations.push(old.cell); staged.labelRecords.push(old);
          staged.plates.push({ ...plate, cells: [old.cell] }); continue;
        }
        const builder = addSelections([label.loci], label.text);
        const repr = builder.apply(StateTransforms.Representation.StructureSelectionsLabel3D,
          labelParams(label), { state: { isHidden: true } }).selector;
        await builder.commit(); staged.representations.push(repr);
        const sphere = StructureElement.Loci.getBoundingSphere(label.loci);
        registerImmersiveAnnotation(repr.obj.data.repr, {size:label.sizeFactor, radius:sphere.radius, maxOffsetEm:label.maxOffsetEm, desktopSizePx:label.desktopSizePx, placement:label.placement, anchorKey:label.id,
          anchors:surfaceAnchorCandidates(lociPositions(label.loci), sphere.center, sphere.radius)});
        staged.labelRecords.push({key, root:staged.roots.at(-1), cell:repr, repr:repr.obj.data.repr,
          params:JSON.stringify(plugin.state.data.cells.get(repr.ref).params.values),
          selectionData:plugin.state.data.cells.get(staged.roots.at(-1)).obj.data});
        staged.plates.push({ ...plate, cells: [repr] });
      }
      for (const distance of distances) {
        const plate = { targets: distance.targets, loci: StructureElement.Loci.union(distance.a, distance.b),
          gate: { shown: true, rest: true }, cells: [] };
        staged.plates.push(plate);
        if (distance.showText !== false) {
          const builder = addSelections([distance.a, distance.b], distance.id);
          const repr = builder.apply(StateTransforms.Representation.StructureSelectionsDistance3D, {
            ...labelParams({ ...distance, text: `${distance.measured.toFixed(2)} Å` }), textColor: Color(0x303840), visuals: ['text'],
          }, { state: { isHidden: true } }).selector;
          await builder.commit(); staged.representations.push(repr);
          registerImmersiveAnnotation(repr.obj.data.repr, {size:distance.sizeFactor});
          plate.cells.push(repr);
        }
        // Cylinders have actual depth in both eyes. Mol*'s screen-space line
        // quads use a desktop view direction and fan into ladders on Quest.
        const repr = await createDashedLineRepresentation(distance.id,
          StructureElement.Loci.getBoundingSphere(distance.a).center,
          StructureElement.Loci.getBoundingSphere(distance.b).center, distance.color, `${distance.measured.toFixed(2)} Å`,
          presenting ? Math.max(.35, distance.measured / 40) : .35);
        // Keep the diameter at least 1/150 of the line length and 20 mm
        // in XR (about 2.4 native pixels at the default 4.6 m seat).
        // Sizing changes a uniform; motion never rebuilds these cylinders.
        registerImmersiveAnnotation(repr, {stroke:true, length:distance.measured, minDiameter:.02});
        repr.setState({ visible: false }); plugin.canvas3d.add(repr);
        const cell = { manual: true, obj: { data: { repr } } };
        staged.representations.push(cell); plate.cells.push(cell);
        staged.motionAnnotations.push({repr, loci:plate.loci});
      }
      annotationsAt = performance.now();
      decidePlates(staged);
      const plateCells = new Map(staged.plates.flatMap(plate => plate.cells.map(cell => [cell, plate])));
      const layerCells = new Map(staged.layerRecords.map(layer => [layer.cell, layer]));
      applyTransform(staged);
      rememberOwned(staged);
      // Nothing borrowed changes until every new molecular/annotation object
      // exists. A failed alpha update or retirement restores the previous tree,
      // including the previous opacity, before newly staged cells are removed.
      const assertSource = () => {
        if (epoch !== sourceEpoch || getStructure() !== structure || structure.obj.data !== structureData)
          throw Error('The molecular figure source changed while preparing its layers.');
        if (!sameIdentity(staged.externalGeometry, externalGeometryIdentity(previous, staged)))
          throw Error('The molecular figure surroundings changed while preparing its layers.');
      };
      await plugin.runTask(plugin.state.data.transaction(async () => {
        assertSource();
        if (alphaUpdates.length) {
          const builder = plugin.build();
          for (const layer of alphaUpdates) builder.to(layer.cell.ref).update(params => ({ ...params,
            type: { ...params.type, params: { ...params.type.params, alpha: layer.opacity } } }));
          await builder.commit({ revertOnError: true });
          if (plugin.state.data.reverted) throw Error('Could not update molecular figure opacity.');
          for (const layer of alphaUpdates) layer.cell.checkValid();
        }
        assertSource();
        for (const cell of staged.representations) {
          const plate = plateCells.get(cell), layer = layerCells.get(cell);
          // A moving body's plate or layer keeps its animation-owned state.
          if ((plate || layer) && !deferReveal && animationOwns(cell.obj.data.repr)) continue;
          const visible = !deferReveal && (plate ? plate.gate.rest : !layer?.startHidden);
          if (cell.manual) { cell.obj.data.repr.setState({ visible }); plugin.canvas3d.update(cell.obj.data.repr, false); }
          else plugin.state.data.updateCellState(cell.ref, { isHidden: !visible });
        }
        await removeRoots(previous, retainedRoots);
        assertSource();
      }, { rethrowErrors: true }));
      assertSource();
      removeManual(previous);
      staged.annotationCells = staged.representations.filter(cell => !staged.molecular.includes(cell));
      staged.annotationRepresentations = staged.annotationCells.map(cell => cell.obj.data.repr);
      for (const repr of staged.annotationRepresentations) sizeImmersiveAnnotation(repr, plugin.canvas3d);
      staged.preparation = {totalMs:performance.now()-started, resolveMs:resolvedAt-started,
        layersMs:layersAt-resolvedAt, annotationsMs:annotationsAt-layersAt, commitMs:performance.now()-annotationsAt, reusedLayers:usedLayers.size,
        builtLayers:layerPlans.length-usedLayers.size, reusedLabels:usedLabels.size, builtLabels:labels.length-usedLabels.size};
      current = staged; context = animation;
      current.deferredReveal = deferReveal;
    } catch (error) { await remove(staged, retainedRoots); throw error; }
  };
  return {
    install(figure, options) { return enqueue(() => install(figure, options)); },
    // A plain chapter may repeat an empty clear after its appearance has
    // already drawn. Absence of public intent alone is insufficient: queued
    // builds, retiring objects and clockless animation masks still need work.
    isEmptyFor(structure) {
      if (!structure?.obj?.data || getStructure() !== structure || pending || current || context !== undefined
        || getAnimation() !== undefined) return false;
      const owned = object => ownedRenderObjects.has(object);
      for (const cell of plugin.state.data.cells.values()) {
        if (cell.obj?.data?.repr?.renderObjects?.some(owned)) return false;
      }
      return !(plugin.canvas3d.getRenderObjects?.() ?? []).some(owned);
    },
    // The animation now owns visibility. A failed install leaves this marker
    // for ordinary figure restoration to reveal the previous static labels.
    animationInstalled() { if (current) current.deferredReveal = false; },
    /** The animation of the chapter this figure belongs to, known or not yet installed. */
    animationContext: () => context,
    /** Name this chapter's animation; its t=0 state decides the static plates. */
    setAnimation(definition) {
      if (context === definition) return false;
      context = definition;
      if (!current) return false;
      current.animation = definition;
      decidePlates(current);
      return showPlates(current, current.deferredReveal);
    },
    /** Re-decide every plate after visibility, fade or ownership changed. */
    applyVisibility(plan) {
      if (!current) return false;
      decidePlates(current, plan);
      return showPlates(current, current.deferredReveal);
    },
    /** The live decision an animation reads for an attached plate. */
    plateGate(repr) {
      for (const plate of current?.plates ?? []) if (plate.cells.some(cell => cell.obj.data.repr === repr)) return plate.gate;
      return undefined;
    },
    geometryEntries,
    // Internal stable identity for menu admission; definition() deliberately clones.
    geometryIdentity: () => current?.figure,
    molecular: () => (current?.molecular ?? []).filter(cell => plugin.state.data.cells.has(cell.ref)).map(cell => cell.obj.data.repr),
    notifyAnnotationMoved: repr => plugin.canvas3d.update(repr, true),
    annotationSourceIdentity: () => {
      const frame=getCoordinateFrame();
      if(typeof frame!=='string' || !frame)return current?.structureData;
      if(!coordinateFrames.has(frame))coordinateFrames.set(frame,{});
      return coordinateFrames.get(frame);
    },
    placement: () => (current?.placement ?? []).filter(cell => plugin.state.data.cells.has(cell.ref)).map(cell => cell.obj.data.repr),
    annotations: () => {
      if (!current) return NO_ANNOTATIONS;
      // A state transaction rollback can recreate representations under the
      // retained selectors. Reuse the array between such scene boundaries.
      for (let i = 0; i < current.annotationCells.length; i++) {
        if (current.annotationCells[i].obj.data.repr === current.annotationRepresentations[i]) continue;
        current.annotationRepresentations = current.annotationCells.map((cell, index) => {
          const repr = cell.obj.data.repr;
          if (repr !== current.annotationRepresentations[index]) copyImmersiveAnnotation(current.annotationRepresentations[index], repr);
          return repr;
        }); break;
      }
      return current.annotationRepresentations;
    },
    count: () => liveRepresentations().length,
    motionAnnotations: () => current?.motionAnnotations ?? [],
    drawn: (objects, animated = () => false) => liveRepresentations().every(repr => (animated(repr) || repr.state.visible || ruledOut(repr)) && repr.renderObjects.length
      && repr.renderObjects.every(object => objects.has(object))
      && repr.renderObjects.some(object => object.values.drawCount.ref.value > 0)),
    refresh() { return current ? this.install(current.figure) : Promise.resolve(); },
    definition: () => current ? structuredClone(current.figure) : undefined,
    snapshot: () => current ? { layers: current.layers, labels: current.labels, atomSites: current.atomSites,
      preparation: current.preparation, distances: current.distances, representations: liveRepresentations().length,
      ...(current.representationOverride ? { representationOverride: current.representationOverride,
        layerRepresentations: current.layerRepresentations } : {}) } : null,
    forget() { sourceEpoch++; lociSource = undefined; lociCache.clear(); const old = current; current = undefined; context = undefined; for (const repr of liveRepresentations(old)) plugin.canvas3d.remove(repr);
      return enqueue(() => remove(old)); },
  };
}
