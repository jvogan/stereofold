import { yieldBrowserTask } from './browser-task-yield.mjs';
import identity from '../identity/identity.cjs';
import molstarInt from '../../plugin/node_modules/molstar/lib/commonjs/mol-data/int.js';

import { snapshotSelectionCatalog } from './catalog-snapshot.mjs';
export { snapshotSelectionCatalog } from './catalog-snapshot.mjs';

const { atomKey, copyKey, residueKey } = identity;
const { OrderedSet } = molstarInt;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function denseArray(value, predicate, name) {
  requireValue(Array.isArray(value), `${name} must be an array.`);
  for (let i = 0; i < value.length; i++) {
    requireValue(own(value, i) && predicate(value[i]), `${name} contains an invalid entry.`);
  }
  return value;
}

function text(value) { return typeof value === 'string' && value.length > 0; }
function tuple(value, length) {
  return Array.isArray(value) && value.length === length
    && Array.from({ length }, (_, i) => own(value, i) && Number.isFinite(value[i])).every(Boolean);
}
function sameArray(a, b) {
  return a?.length === b?.length && Array.from(a).every((value, i) => value === b[i]);
}
function sameMatrix(a, b) {
  return a?.length === 16 && tuple(b, 16)
    && Array.from(a).every((value, i) => Number.isFinite(value) && Math.abs(value - b[i]) <= 1e-9);
}
function scopeKey(modelNumber, copyId, labelChain) {
  return JSON.stringify([modelNumber, copyId, labelChain]);
}

function cell(category, fieldName, index) {
  const field = category?.getField(fieldName);
  return field && field.valueKind(index) === 0 ? field.str(index) : null;
}
function integer(value, description, optional = false) {
  if (value === null && optional) return null;
  requireValue(typeof value === 'string' && /^-?\d+$/u.test(value)
    && Number.isSafeInteger(Number(value)), `${description} is not an integer.`);
  return Number(value);
}
function coordinate(value) {
  requireValue(typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value),
    'The source contains an unsupported coordinate.');
  const number = Number(value);
  requireValue(Number.isFinite(number), 'The source contains a nonfinite coordinate.');
  return number;
}

function* indexSourceSteps(model) {
  requireValue(model.sourceData?.kind === 'mmCIF', 'Selection requires a parsed mmCIF model.');
  const frame = model.sourceData.data.frame;
  const atoms = frame.categories.atom_site;
  const entities = frame.categories.entity;
  const observedOnly = !entities && !frame.categories.struct_asym && !frame.categories.entity_poly_seq;
  requireValue(atoms && (entities || observedOnly), 'The model is missing source atom or entity records.');
  const entityTypes = new Map();
  if (observedOnly) {
    // Match the catalog's atom_site-only export boundary. This is Mol*'s parsed
    // classification of observed atoms, never a declared/missing sequence.
    const parsedEntities = model.entities.data;
    for (let i = 0; i < parsedEntities._rowCount; i++)
      entityTypes.set(parsedEntities.id.value(i), parsedEntities.type.value(i));
  } else for (let i = 0; i < entities.rowCount; i++) {
    entityTypes.set(cell(entities, 'id', i), cell(entities, 'type', i));
  }
  const rows = new Map();
  for (let index = 0; index < atoms.rowCount; index++) {
    const number = integer(cell(atoms, 'pdbx_PDB_model_num', index), 'Source model', true) ?? 1;
    if (number !== model.modelNum) continue;
    const id = integer(cell(atoms, 'id', index), 'Source atom id');
    requireValue(!rows.has(id), 'Source atom ids are not unique within the model.');
    rows.set(id, index);
    if ((index & 127) === 127) yield;
  }
  return { atoms, entityTypes, rows };
}

function atomIdentity(unit, element, source) {
  const model = unit.model;
  // atomicHierarchy may be shared by two models. Conformation atom ids identify
  // the correct source rows when their atomSourceIndex arrays are shared.
  const sourceAtomId = model.atomicConformation.atomId.value(element);
  const index = source.rows.get(sourceAtomId);
  requireValue(index !== undefined, 'The model atom has no corresponding source atom.');
  const read = name => cell(source.atoms, name, index);
  const entityId = read('label_entity_id');
  const entityType = source.entityTypes.get(entityId);
  requireValue(text(entityId) && text(entityType), 'The atom has no declared entity.');
  const i = {
    entityId,
    labelChain: read('label_asym_id'),
    authorChain: read('auth_asym_id'),
    labelSequenceId: entityType === 'polymer' ? integer(read('label_seq_id'), 'Polymer sequence position') : null,
    authorResidue: integer(read('auth_seq_id'), 'Author residue', true),
    insertionCode: read('pdbx_PDB_ins_code') ?? '',
    componentId: read('label_comp_id'),
    atomName: read('label_atom_id'),
    authorAtomName: read('auth_atom_id'),
    alternateSite: read('label_alt_id') ?? '',
    sourceAtomId: String(sourceAtomId),
  };
  requireValue(text(i.labelChain) && text(i.componentId) && text(i.atomName), 'A source atom identifier is missing.');
  const h = model.atomicHierarchy;
  const chain = h.chainAtomSegments.index[element];
  const residue = h.residueAtomSegments.index[element];
  requireValue(h.chains.label_asym_id.value(chain) === i.labelChain
    && h.chains.label_entity_id.value(chain) === i.entityId
    && h.atoms.label_comp_id.value(element) === i.componentId
    && h.atoms.label_atom_id.value(element) === i.atomName
    && h.atoms.label_alt_id.value(element) === i.alternateSite
    && h.residues.pdbx_PDB_ins_code.value(residue) === i.insertionCode,
  'The parsed atomic hierarchy differs from its source identity.');
  for (const [expected, column, position] of [
    [i.authorChain, h.chains.auth_asym_id, chain],
    [i.authorResidue, h.residues.auth_seq_id, residue],
    [i.authorAtomName, h.atoms.auth_atom_id, element],
    [i.labelSequenceId, h.residues.label_seq_id, residue],
  ]) {
    if (expected !== null) requireValue(column.value(position) === expected,
      'The parsed atomic hierarchy differs from a supplied source identifier.');
  }
  const coordinates = ['Cartn_x', 'Cartn_y', 'Cartn_z'].map(name => coordinate(read(name)));
  for (const [axis, name] of ['x', 'y', 'z'].entries()) {
    requireValue(Number.isFinite(model.atomicConformation[name][element])
      && model.atomicConformation[name][element] === Math.fround(coordinates[axis]),
      'The parsed model coordinates differ from its source.');
  }
  return { identity: i, coordinates, entityType, element: read('type_symbol') };
}

function* snapshotCatalogSteps(input) {
  const catalog = snapshotSelectionCatalog(input);
  requireValue(catalog?.schemaVersion === 'draft-identity-1' && catalog.molstarVersion === '5.11.0',
    'Selection requires the pinned Mol* 5.11 identity catalog.');
  requireValue(/^[a-f0-9]{64}$/u.test(catalog.source?.sha256 ?? '') && text(catalog.assemblyId),
    'The identity catalog needs an explicit source and assembly.');
  denseArray(catalog.modelNumbers, Number.isSafeInteger, 'Catalog model numbers');
  requireValue(new Set(catalog.modelNumbers).size === catalog.modelNumbers.length, 'Catalog model numbers repeat.');
  const copies = new Map();
  denseArray(catalog.copies, copy => copy && typeof copy === 'object', 'Catalog copies');
  for (const copy of catalog.copies) {
    denseArray(copy.operatorIds, text, 'Copy operator ids');
    denseArray(copy.labelChains, text, 'Copy label chains');
    requireValue(copy.assemblyId === catalog.assemblyId && catalog.modelNumbers.includes(copy.modelNumber)
      && copy.copyId === copyKey(copy) && tuple(copy.matrix, 16), 'A catalog copy is inconsistent.');
    const key = JSON.stringify([copy.modelNumber, copy.copyId]);
    requireValue(!copies.has(key), 'A canonical assembly copy appears twice.');
    copies.set(key, copy);
  }
  const residueKeys = new Set();
  const sites = new Map();
  denseArray(catalog.rows, row => row && typeof row === 'object', 'Catalog residues');
  let checkedSites = 0;
  for (const row of catalog.rows) {
    const i = row.identity;
    requireValue(i && row.key === residueKey(i) && i.sourceHash === catalog.source.sha256
      && i.assemblyId === catalog.assemblyId && !residueKeys.has(row.key), 'A canonical residue is inconsistent or repeated.');
    const copy = copies.get(JSON.stringify([i.modelNumber, i.copyId]));
    requireValue(copy && copy.labelChains.includes(i.labelChain)
      && copy.generatorIndex === i.generatorIndex && sameArray(copy.operatorIds, i.operatorIds),
    'A residue has an inconsistent assembly copy.');
    residueKeys.add(row.key);
    denseArray(row.atomSites, site => site && typeof site === 'object', 'Residue atom sites');
    requireValue(row.coordinateState === (row.atomSites.length ? 'resolved' : 'unresolved'),
      'Residue coordinate availability disagrees with its atom sites.');
    for (const site of row.atomSites) {
      requireValue(site.identity && residueKey(site.identity) === row.key && site.key === atomKey(site.identity)
        && site.identity.assemblyId === i.assemblyId && site.identity.generatorIndex === i.generatorIndex
        && sameArray(site.identity.operatorIds, i.operatorIds) && !sites.has(site.key)
        && tuple(site.sourceCoordinatesAngstrom, 3) && tuple(site.assemblyCoordinatesAngstrom, 3),
      'A canonical atom site is inconsistent or repeated.');
      sites.set(site.key, { site, row });
      if ((++checkedSites & 63) === 0) yield;
    }
  }
  return { catalog, sites };
}

function copyFor(unit, labelChain, copies) {
  const operator = unit.conformation.operator;
  const assembly = operator.assembly;
  const matches = copies.filter(copy => copy.modelNumber === unit.model.modelNum && copy.labelChains.includes(labelChain)
    && (assembly
      ? copy.assemblyId === assembly.id && sameArray(copy.operatorIds, assembly.operList)
      : copy.assemblyId === 'asymmetric_unit' && !copy.operatorIds.length
        && operator.spgrOp === -1 && operator.ncsId === -1 && sameMatrix(operator.matrix, IDENTITY))
    && sameMatrix(operator.matrix, copy.matrix));
  requireValue(matches.length === 1, 'The loaded unit has no unambiguous catalog assembly copy.');
  return matches[0];
}

function selectionKeys(input, byKey) {
  let keys;
  try { keys = structuredClone(input); }
  catch { throw new Error('Selection keys cannot be copied as structured data.'); }
  denseArray(keys, text, 'Selection keys');
  for (const key of keys) requireValue(byKey.has(key), 'A selection key is unknown or outside this structure.');
  return [...new Set(keys)];
}

/**
 * Bind canonical residue keys to one loaded, atomic mmCIF structure.
 * The caller verifies source bytes against catalog.source.sha256 before parsing.
 * This adapter verifies parsed identities, source coordinates and copy operators.
 * Recreate it after replacing the model, assembly or represented structure.
 */
function* createSelectionAdapterSteps(structure, inputCatalog) {
  requireValue(structure?.units?.length && structure.unitMap && structure.root,
    'Selection requires a nonempty Mol* structure.');
  const { catalog, sites } = yield* snapshotCatalogSteps(inputCatalog);
  const sources = new Map();
  const modelByNumber = new Map();
  const units = new Map();
  const positions = new Map();
  const scopes = new Set();
  const representedSites = new Set();
  for (const unit of structure.units) {
    requireValue(unit.kind === 0 && unit.elements.length, 'Selection supports nonempty atomic units only.');
    requireValue(!units.has(unit.id), 'Loaded unit ids are not unique.');
    requireValue(catalog.modelNumbers.includes(unit.model.modelNum), 'The loaded model is outside the identity catalog.');
    const existing = modelByNumber.get(unit.model.modelNum);
    requireValue(!existing || existing === unit.model, 'One model number refers to multiple loaded models.');
    modelByNumber.set(unit.model.modelNum, unit.model);
    if (!sources.has(unit.model)) sources.set(unit.model, yield* indexSourceSteps(unit.model));
    const atoms = new Map();
    // Mol* units have one immutable operator, but can contain several chains.
    // Validate each chain's copy once within this binding, including ambiguity.
    const copiesByChain = new Map();
    units.set(unit.id, { unit, atoms });
    for (let localIndex = 0; localIndex < unit.elements.length; localIndex++) {
      const element = unit.elements[localIndex];
      const raw = atomIdentity(unit, element, sources.get(unit.model));
      let copy = copiesByChain.get(raw.identity.labelChain);
      if (!copy) {
        copy = copyFor(unit, raw.identity.labelChain, catalog.copies);
        copiesByChain.set(raw.identity.labelChain, copy);
      }
      const key = atomKey({ sourceHash: catalog.source.sha256, modelNumber: unit.model.modelNum,
        assemblyId: copy.assemblyId, generatorIndex: copy.generatorIndex, operatorIds: copy.operatorIds,
        copyId: copy.copyId, ...raw.identity });
      const match = sites.get(key);
      requireValue(match && match.row.entityType === raw.entityType && match.site.element === raw.element
        && sameArray(match.site.sourceCoordinatesAngstrom, raw.coordinates),
      'The loaded atom does not match the catalog source identity and coordinates.');
      const [x, y, z] = raw.coordinates;
      const m = copy.matrix;
      const assembled = [m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      requireValue(assembled.every((value, i) => Number.isFinite(value)
        && Math.abs(value - match.site.assemblyCoordinatesAngstrom[i]) <= 1e-9),
      'Catalog assembly coordinates disagree with the selected operator.');
      requireValue(!atoms.has(element) && !representedSites.has(key), 'The loaded atom maps to more than one unit or identity.');
      representedSites.add(key);
      atoms.set(element, { localIndex, rowKey: match.row.key, atomKey: key });
      const rowPositions = positions.get(match.row.key) ?? [];
      rowPositions.push({ unit, localIndex });
      positions.set(match.row.key, rowPositions);
      scopes.add(scopeKey(unit.model.modelNum, copy.copyId, raw.identity.labelChain));
      if ((localIndex & 63) === 63) yield;
    }
  }
  // An unresolved position belongs to a represented chain/copy, without having
  // a 3D point. Atom-bearing residues removed by a structure subset stay absent.
  const rows = Object.freeze(catalog.rows.filter(row => positions.has(row.key)
    || (row.coordinateState === 'unresolved'
      && scopes.has(scopeKey(row.identity.modelNumber, row.identity.copyId, row.identity.labelChain)))));
  const byKey = new Map(rows.map(row => [row.key, row]));

  // The adapter belongs to one immutable represented structure. Validate and
  // copy keys even on a hit, so edited arrays and invalid requests cannot reuse
  // an old selection. Keep several parts alongside the snapshot selection.
  const lociCache = new Map();
  function toLoci(input) {
    const keys = selectionKeys(input, byKey);
    const cacheKey = JSON.stringify(keys.sort());
    if (lociCache.has(cacheKey)) {
      const loci = lociCache.get(cacheKey);
      lociCache.delete(cacheKey);
      lociCache.set(cacheKey, loci);
      return loci;
    }
    const grouped = new Map();
    for (const key of keys) for (const position of positions.get(key) ?? []) {
      const indices = grouped.get(position.unit.id) ?? new Set();
      indices.add(position.localIndex);
      grouped.set(position.unit.id, indices);
    }
    // Mol*'s StructureElement.Loci constructor returns this tagged record.
    // Typed sorted indices are a supported OrderedSet representation.
    const loci = { kind: 'element-loci', structure, elements: structure.units.filter(unit => grouped.has(unit.id))
      .map(unit => ({ unit, indices: Int32Array.from([...grouped.get(unit.id)].sort((a, b) => a - b)) })) };
    lociCache.set(cacheKey, loci);
    if (lociCache.size > 32) lociCache.delete(lociCache.keys().next().value);
    return loci;
  }

  function fromLoci(loci) {
    if (loci?.kind === 'empty-loci') return [];
    requireValue(loci && ['element-loci', 'bond-loci'].includes(loci.kind), 'The pick is not an atom or bond Loci.');
    const pickedStructure = loci.structure;
    requireValue(pickedStructure?.root === structure.root, 'The pick belongs to a different structure root.');
    const selected = new Set();
    function collect(unit, localIndex) {
      const target = units.get(unit?.id);
      requireValue(target && pickedStructure.unitMap.get(unit.id) === unit && unit.model === target.unit.model
        && unit.conformation.operator === target.unit.conformation.operator,
      'The pick refers to a foreign or unsupported unit.');
      requireValue(Number.isSafeInteger(localIndex) && localIndex >= 0 && localIndex < unit.elements.length,
        'The pick contains an invalid unit-local atom index.');
      const mapped = target.atoms.get(unit.elements[localIndex]);
      requireValue(mapped, 'The picked atom is outside this represented structure.');
      selected.add(mapped.rowKey);
    }
    if (loci.kind === 'element-loci') {
      denseArray(loci.elements, element => element && typeof element === 'object', 'Picked elements');
      for (const element of loci.elements) {
        const set = element.indices;
        requireValue(typeof set === 'number' || Array.isArray(set) || set instanceof Int32Array || set instanceof Uint32Array,
          'The pick has an unsupported OrderedSet.');
        const count = OrderedSet.size(set);
        requireValue(Number.isSafeInteger(count) && count >= 0 && count <= (element.unit?.elements.length ?? -1),
          'The pick has an invalid OrderedSet size.');
        let previous = -1;
        for (let i = 0; i < count; i++) {
          if (Array.isArray(set)) requireValue(own(set, i), 'The pick contains a sparse OrderedSet.');
          const value = OrderedSet.getAt(set, i);
          requireValue(value > previous, 'The pick indices must be sorted and unique.');
          collect(element.unit, value);
          previous = value;
        }
      }
    } else {
      denseArray(loci.bonds, bond => bond && typeof bond === 'object', 'Picked bonds');
      for (const bond of loci.bonds) {
        requireValue(bond.aStructure?.root === structure.root && bond.bStructure?.root === structure.root,
          'A bond endpoint belongs to a different structure root.');
        collect(bond.aUnit, bond.aIndex);
        collect(bond.bUnit, bond.bIndex);
      }
    }
    return rows.filter(row => selected.has(row.key)).map(row => row.key);
  }

  function describe(input) {
    return selectionKeys(input, byKey).map(key => {
      const row = byKey.get(key);
      return Object.freeze({ key, identity: row.identity, coordinateState: row.coordinateState,
        atomSiteCount: row.atomSites.length, representedAtomSiteCount: positions.get(key)?.length ?? 0 });
    });
  }

  // Standard Structure Viewer selection exports identify source atoms by their
  // mmCIF atom_site.id. Expose only an unambiguous source-id -> canonical
  // residue-key map for the app-only scene handoff; assembly copies that reuse
  // an atom id are omitted so a selected ambiguous ID fails closed.
  function sourceAtomIdToSelectionKey(requestedAtomIds) {
    const requested = requestedAtomIds === undefined ? undefined : new Set(requestedAtomIds);
    if (requested?.size === 0) return {};
    const map = new Map();
    const ambiguous = new Set();
    for (const target of units.values()) {
      for (const [element, mapped] of target.atoms) {
        const sourceAtomId = String(target.unit.model.atomicConformation.atomId.value(element));
        if (requested && !requested.has(sourceAtomId)) continue;
        if (ambiguous.has(sourceAtomId)) continue;
        const previous = map.get(sourceAtomId);
        if (previous !== undefined && previous !== mapped.rowKey) {
          map.delete(sourceAtomId);
          ambiguous.add(sourceAtomId);
          continue;
        }
        map.set(sourceAtomId, mapped.rowKey);
      }
    }
    return Object.fromEntries(map);
  }

  return Object.freeze({ rows, toLoci, fromLoci, describe, sourceAtomIdToSelectionKey });
}


/** Synchronous compatibility path for desktop and existing tools. */
export function createSelectionAdapter(structure, inputCatalog) {
  const work = createSelectionAdapterSteps(structure, inputCatalog);
  for (;;) { const step = work.next(); if (step.done) return step.value; }
}

/** Same source, coordinate, identity and assembly checks, with bounded work
 * slices so XR can submit fresh head poses while a replacement is verified.
 * Nothing is published until the complete adapter passes every check. */
export async function createSelectionAdapterAsync(structure, inputCatalog, {
  check = () => {}, now = () => performance.now(), budgetMs = 4,
  yieldTask = yieldBrowserTask,
} = {}) {
  check();
  const work = createSelectionAdapterSteps(structure, inputCatalog);
  let started = now();
  try {
    for (;;) {
      const step = work.next();
      if (step.done) { check(); return step.value; }
      if (now() - started < budgetMs) continue;
      await yieldTask();
      check(); started = now();
    }
  } finally { work.return(); }
}
