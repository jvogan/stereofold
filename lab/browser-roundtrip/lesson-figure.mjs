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

const ink = value => Color(parseInt(value.slice(1), 16));
const typeName = value => value === 'gaussian-surface' ? 'gaussian-surface' : value;
const targetIdentity = target => [target.chain, target.residues?.from, target.residues?.to, target.componentId, target.atomName];
export function figureTargetExpression(target) {
  const p = MS.struct.atomProperty.macromolecular;
  const tests = [MS.core.rel.eq([p.auth_asym_id(), target.chain])];
  if (target.residues) tests.push(MS.core.rel.inRange([p.auth_seq_id(), target.residues.from, target.residues.to]));
  if (target.componentId) tests.push(MS.core.rel.eq([p.label_comp_id(), target.componentId]));
  if (target.atomName) tests.push(MS.core.rel.eq([p.label_atom_id(), target.atomName]));
  return MS.struct.generator.atomGroups({ 'atom-test': MS.core.logic.and(tests) });
}
export function figureTargetMatchesRow(target, row) {
  const i = row.identity;
  return i.authorChain === target.chain
    && (!target.residues || (Number(i.authorResidue) >= target.residues.from && Number(i.authorResidue) <= target.residues.to))
    && (!target.componentId || i.componentId === target.componentId);
}
export function resolveFigureLoci(target, structure) {
  return StructureSelection.toLociWithSourceUnits(Script.getStructureSelection(figureTargetExpression(target), structure));
}

/** Stage complete 3D layers before retiring the previous figure. Source change drops all refs. */
export function createLessonFigure({ plugin, getStructure, getTransform, getGeometryOptions = () => ({}), getGeometryEntries = () => [] }) {
  let current, serial = Promise.resolve();
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
  const geometryEntries = (figure = current?.figure) => {
    if (!figure?.representationOverride) return [];
    const data = getStructure()?.obj?.data;
    if (!data) throw Error('A molecular figure needs loaded atomic coordinates.');
    return figureRepresentationLayers(figure).map(layer => {
      const loci = resolveFigureLoci(layer.target, data);
      if (StructureElement.Loci.isEmpty(loci)) throw Error(`Figure target did not resolve: ${JSON.stringify(layer.target)}`);
      const selected = StructureElement.Loci.toStructure(loci);
      return { representation: figureLayerRepresentation(layer, selected), ...structureGeometryCounts(selected) };
    });
  };
  const install = async figure => {
    const structure = getStructure(), presenting = Boolean(plugin.canvas3d?.xr?.isPresenting?.value);
    const structureData = structure?.obj?.data, epoch = sourceEpoch;
    const geometryOptions = { quality: 'low', ...getGeometryOptions(), presenting };
    const otherGeometry = figure?.representationOverride ? getGeometryEntries() : [];
    const signature = JSON.stringify([figure, presenting, geometryOptions, otherGeometry]);
    if (current && current.structure === structure && current.structureData === structureData && current.signature === signature
      && current.representations.every(cell => cell.manual || plugin.state.data.cells.has(cell.ref))
      && current.layerRecords.every(layerIntact)) return;
    if (!figure) { const old = current; await remove(old); current = undefined; return; }
    if (!structure?.obj?.data) throw Error('A molecular figure needs loaded atomic coordinates.');
    const lociFor = target => {
      const loci = resolveFigureLoci(target, structure.obj.data);
      if (StructureElement.Loci.isEmpty(loci)) throw Error(`Figure target did not resolve: ${JSON.stringify(target)}`);
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
      return { ...distance, a, b, measured };
    });
    const atomSites = layers.reduce((sum, layer) => sum + StructureElement.Loci.size(layer.loci), 0);
    if (atomSites > 20000) throw Error('A layered lesson figure is limited to 20,000 represented atom sites. Use a simpler scene for this source.');
    // Authored envelopes keep their existing mesh settings. A global wearer
    // choice may introduce thousands of atom spheres or bonds, so admit the
    // actual selected parts together with the base, comparison and scoped
    // meshes before changing any live cells. An almost transparent base still
    // builds geometry and cannot spend a second device allowance.
    const geometry = figure.representationOverride ? requireSceneGeometryBudget([...otherGeometry, ...layers.map(layer => ({
      representation: layer.representation, ...structureGeometryCounts(layer.data),
    }))], geometryOptions).slice(otherGeometry.length) : [];
    const staged = { signature, structure, structureData, figure, roots: [], representations: [], molecular: [], placement: [], layerRecords: [], atomSites,
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
    const labelParams = label => ({ customText: label.text, textColor: ink(label.color),
      textSize: 1, sizeFactor: label.sizeFactor * (presenting ? 6 : 1), scaleByRadius: false, fontQuality: 3,
      offsetX: label.offsetX, offsetY: label.offsetY, offsetZ: 3,
      background: true, backgroundColor: Color(0xffffff), backgroundOpacity: .9,
      backgroundMargin: .25, borderWidth: 0, tether: false });
    try {
      for (const [index, { layer, typeParams, alpha, key }] of layerPlans.entries()) {
        const old = index < reusePrefix ? previous.layerRecords[index] : undefined;
        if (old) {
          const retained = { ...old, opacity: alpha };
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
          componentData: component.obj.data, modifiers: [], opacity: alpha };
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
      const addSelections = (loci, label) => {
        const ref = `stereofold-figure-${crypto.randomUUID()}`;
        staged.roots.push(ref);
        return plugin.build().toRoot().apply(StateTransforms.Model.MultiStructureSelectionFromBundle, {
          selections: loci.map((value, index) => ({ key: String(index), ref: structure.ref,
            bundle: StructureElement.Bundle.fromLoci(value) })), isTransitive: true, label,
        }, { ref, dependsOn: [structure.ref] });
      };
      for (const label of labels) {
        const builder = addSelections([label.loci], label.text);
        const repr = builder.apply(StateTransforms.Representation.StructureSelectionsLabel3D,
          labelParams(label), { state: { isHidden: true } }).selector;
        await builder.commit(); staged.representations.push(repr);
      }
      for (const distance of distances) {
        if (distance.showText !== false) {
          const builder = addSelections([distance.a, distance.b], distance.id);
          const repr = builder.apply(StateTransforms.Representation.StructureSelectionsDistance3D, {
            ...labelParams({ ...distance, text: `${distance.measured.toFixed(2)} Å` }), visuals: ['text'],
          }, { state: { isHidden: true } }).selector;
          await builder.commit(); staged.representations.push(repr);
        }
        // Cylinders have actual depth in both eyes. Mol*'s screen-space line
        // quads use a desktop view direction and fan into ladders on Quest.
        const cylinders = CylindersBuilder.create(32, 32);
        cylinders.addFixedLengthDashes(StructureElement.Loci.getBoundingSphere(distance.a).center,
          StructureElement.Loci.getBoundingSphere(distance.b).center, .35, 1, true, true, false, 0);
        const geometry = cylinders.getCylinders();
        const shape = Shape.create(distance.id, {}, geometry, () => ink(distance.color), () => .07,
          () => `${distance.measured.toFixed(2)} Å`);
        const repr = ShapeRepresentation(() => shape, Cylinders.Utils);
        await repr.createOrUpdate({ alpha: 1, quality: 'low' }, {}).run();
        repr.setState({ visible: false }); plugin.canvas3d.add(repr);
        staged.representations.push({ manual: true, obj: { data: { repr } } });
      }
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
          if (cell.manual) { cell.obj.data.repr.setState({ visible: true }); plugin.canvas3d.update(cell.obj.data.repr, false); }
          else plugin.state.data.updateCellState(cell.ref, { isHidden: false });
        }
        await removeRoots(previous, retainedRoots);
        assertSource();
      }, { rethrowErrors: true }));
      assertSource();
      removeManual(previous);
      current = staged;
    } catch (error) { await remove(staged, retainedRoots); throw error; }
  };
  return {
    install(figure) { const operation = serial.then(() => install(figure)); serial = operation.catch(() => {}); return operation; },
    geometryEntries,
    // Internal stable identity for menu admission; definition() deliberately clones.
    geometryIdentity: () => current?.figure,
    molecular: () => (current?.molecular ?? []).filter(cell => plugin.state.data.cells.has(cell.ref)).map(cell => cell.obj.data.repr),
    placement: () => (current?.placement ?? []).filter(cell => plugin.state.data.cells.has(cell.ref)).map(cell => cell.obj.data.repr),
    annotations: () => liveRepresentations().filter(repr => !(current?.molecular ?? []).some(cell => cell.obj.data.repr === repr)),
    count: () => liveRepresentations().length,
    drawn: objects => liveRepresentations().every(repr => repr.state.visible && repr.renderObjects.length
      && repr.renderObjects.every(object => objects.has(object))
      && repr.renderObjects.some(object => object.values.drawCount.ref.value > 0)),
    refresh() { return current ? this.install(current.figure) : Promise.resolve(); },
    definition: () => current ? structuredClone(current.figure) : undefined,
    snapshot: () => current ? { layers: current.layers, labels: current.labels, atomSites: current.atomSites,
      distances: current.distances, representations: liveRepresentations().length,
      ...(current.representationOverride ? { representationOverride: current.representationOverride,
        layerRepresentations: current.layerRepresentations } : {}) } : null,
    forget() { sourceEpoch++; const old = current; current = undefined; for (const repr of liveRepresentations(old)) plugin.canvas3d.remove(repr);
      const operation = serial.then(() => remove(old)); serial = operation.catch(() => {}); return operation; },
  };
}
