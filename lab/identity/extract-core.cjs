'use strict';

const { applyCifFieldCaseCompatibility } = require('./cif-field-compat.cjs');

const { deepFreeze, copyKey, residueKey, atomKey } = require('./identity.cjs');
const { IDENTITY_4, applyOperator } = require('./geometry.cjs');

/**
 * Construct the scientific mmCIF catalog extractor from explicit runtime
 * dependencies. Keeping Mol* and hashing outside this module lets the lab use
 * its pinned package resolver while the bundled plugin uses static imports.
 */
function createCatalogExtractor({ CIF, trajectoryFromMmCIF, Symmetry, molstarVersion, sha256, yieldToHost }) {
  if (CIF == null || typeof CIF.parse !== 'function'
    || typeof trajectoryFromMmCIF !== 'function'
    || Symmetry == null || typeof Symmetry.findAssembly !== 'function'
    || typeof molstarVersion !== 'string' || !molstarVersion
    || typeof sha256 !== 'function') {
    throw new TypeError('The catalog extractor requires CIF, mmCIF trajectory, symmetry, Mol* version, and SHA-256 dependencies.');
  }
  // Optional: called between residues so a host that serves requests on the
  // same thread can answer them during a long extraction. It may return a
  // promise to wait on or nothing. The catalog does not depend on it.
  if (yieldToHost != null && typeof yieldToHost !== 'function') throw new TypeError('yieldToHost must be a function.');

  function cell(category, name, index) {
    const field = category?.getField(name);
    return field && field.valueKind(index) === 0 ? field.str(index) : null;
  }

  function integer(category, name, index, required = false) {
    const text = cell(category, name, index);
    if (text === null && !required) return null;
    if (text === null || !/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw new Error(`${category?.name ?? 'CIF'}.${name} requires an integer at row ${index + 1}.`);
    }
    return Number(text);
  }

  function requiredText(category, name, index) {
    const value = cell(category, name, index);
    if (value === null || value === '') throw new Error(`${name} is missing at source row ${index + 1}.`);
    return value;
  }

  function coordinate(category, name, index) {
    const text = cell(category, name, index);
    if (text === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      throw new Error(`${name} requires decimal coordinate syntax at row ${index + 1}.`);
    }
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`${name} is not a finite source coordinate at row ${index + 1}.`);
    return value;
  }

  function baseKey(i) {
    return JSON.stringify([i.entityId, i.labelChain, i.authorChain, i.labelSequenceId,
      i.authorResidue, i.insertionCode, i.componentId]);
  }

  function sourceTopology(frame, model) {
    // Structure Viewer selection-mmcif exports carry atom_site only. Preserve
    // their observed identities and Mol*'s parsed entity classification without
    // inventing declared sequence, missing residues, bonds or source bytes.
    // Structure Viewer exports an observed-only atom_site table with an entity
    // table, but no struct_asym or declared polymer sequence. An entity table
    // alone does not turn those coordinates into a deposited topology.
    if (!frame.categories.struct_asym && !frame.categories.entity_poly_seq) {
      const atom = frame.categories.atom_site, entities = new Map(), chainsByEntity = new Map();
      const parsedEntities = model.entities.data;
      for (let i = 0; i < parsedEntities._rowCount; i++)
        entities.set(parsedEntities.id.value(i), parsedEntities.type.value(i));
      for (let i = 0; i < (atom?.rowCount ?? 0); i++) {
        if ((integer(atom, 'pdbx_PDB_model_num', i) ?? 1) !== model.modelNum) continue;
        const labelChain = requiredText(atom, 'label_asym_id', i), entityId = requiredText(atom, 'label_entity_id', i);
        if (!entities.has(entityId)) throw new Error(`Atom refers to unknown parsed entity ${entityId}.`);
        // Observed-only exports can retain the same chain label for polymer,
        // ligand and water entities. The atom rows still identify each entity
        // explicitly; preserve that pair instead of inventing new chain IDs.
        chainsByEntity.set(JSON.stringify([labelChain, entityId]), { labelChain, entityId, entityType: entities.get(entityId) });
      }
      if (!chainsByEntity.size) throw new Error('Coordinate-only source has no observed label chains.');
      return { entities, chains: [...chainsByEntity.values()], sequences: new Map(), observedOnly: true };
    }
    const entities = new Map();
    const entity = frame.categories.entity;
    for (let i = 0; i < (entity?.rowCount ?? 0); i++) {
      entities.set(requiredText(entity, 'id', i), requiredText(entity, 'type', i));
    }
    const chains = [];
    const asym = frame.categories.struct_asym;
    for (let i = 0; i < (asym?.rowCount ?? 0); i++) {
      const id = requiredText(asym, 'id', i);
      const entityId = requiredText(asym, 'entity_id', i);
      if (!entities.has(entityId)) throw new Error(`Chain ${id} refers to an unknown entity.`);
      chains.push({ labelChain: id, entityId, entityType: entities.get(entityId) });
    }
    if (!chains.length) throw new Error('This draft requires an explicit struct_asym table.');
    const sequences = new Map();
    const seq = frame.categories.entity_poly_seq;
    for (let i = 0; i < (seq?.rowCount ?? 0); i++) {
      const entityId = requiredText(seq, 'entity_id', i);
      const position = integer(seq, 'num', i, true);
      if (position <= 0) throw new Error('Declared polymer sequence positions must be positive.');
      const entries = sequences.get(entityId) ?? [];
      entries.push({ labelSequenceId: position, componentId: requiredText(seq, 'mon_id', i) });
      sequences.set(entityId, entries);
    }
    return { entities, chains, sequences };
  }

  function sourceAtomRows(frame) {
    const atom = frame.categories.atom_site;
    const result = new Map();
    for (let i = 0; i < (atom?.rowCount ?? 0); i++) {
      const model = integer(atom, 'pdbx_PDB_model_num', i) ?? 1;
      const atomId = integer(atom, 'id', i, true);
      const key = JSON.stringify([model, atomId]);
      if (result.has(key)) throw new Error('Duplicate source atom id within one model.');
      result.set(key, i);
    }
    return result;
  }

  function observedResidues(frame, model, topology, sourceRows) {
    const atom = frame.categories.atom_site;
    const hierarchy = model.atomicHierarchy;
    const rows = new Map();
    for (let index = 0; index < hierarchy.atoms._rowCount; index++) {
      const sourceIndex = sourceRows.get(JSON.stringify([model.modelNum, model.atomicConformation.atomId.value(index)]));
      if (sourceIndex === undefined) throw new Error('The model atom has no matching source row.');
      const entityId = requiredText(atom, 'label_entity_id', sourceIndex);
      const entityType = topology.entities.get(entityId);
      if (!entityType) throw new Error(`Atom refers to unknown entity ${entityId}.`);
      const identity = {
        entityId,
        labelChain: requiredText(atom, 'label_asym_id', sourceIndex),
        authorChain: cell(atom, 'auth_asym_id', sourceIndex),
        labelSequenceId: entityType === 'polymer' ? integer(atom, 'label_seq_id', sourceIndex, true) : null,
        authorResidue: integer(atom, 'auth_seq_id', sourceIndex),
        insertionCode: cell(atom, 'pdbx_PDB_ins_code', sourceIndex) ?? '',
        componentId: requiredText(atom, 'label_comp_id', sourceIndex),
      };
      if (identity.labelSequenceId !== null && identity.labelSequenceId <= 0) throw new Error('Resolved polymer atom has an invalid sequence position.');
      const key = baseKey(identity);
      const row = rows.get(key) ?? { identity, entityType, sequenceDeclared: false, mappingOrigin: 'atom_site', atomSites: [] };
      row.atomSites.push({
        atomName: requiredText(atom, 'label_atom_id', sourceIndex),
        authorAtomName: cell(atom, 'auth_atom_id', sourceIndex),
        alternateSite: cell(atom, 'label_alt_id', sourceIndex) ?? '',
        sourceAtomId: requiredText(atom, 'id', sourceIndex),
        element: requiredText(atom, 'type_symbol', sourceIndex),
        sourceCoordinatesAngstrom: ['Cartn_x', 'Cartn_y', 'Cartn_z'].map(name => coordinate(atom, name, sourceIndex)),
      });
      rows.set(key, row);
    }
    return rows;
  }

  /**
   * The residues a declared sequence is matched against, indexed once.
   *
   * Every declared position used to scan every `pdbx_poly_seq_scheme` row and
   * every observed residue, so the work grew with the square of the residue
   * count (about 40 s of one thread for a 24 MB ribosome). The indexes below
   * return the same rows in the same order as those scans did, and rows are
   * read and validated in the same order, so the catalog and any error it
   * raises are unchanged.
   */
  const tuple = (...values) => values.map(value => `${typeof value}:${value}`).join('\u0000');

  function sequenceRows(frame, topology, observed) {
    if (topology.observedOnly) return [...observed.values()];
    const results = new Map();
    const consumedObserved = new Set();
    const scheme = frame.categories.pdbx_poly_seq_scheme;
    const schemeRowsByChain = new Map();
    for (let i = 0; i < (scheme?.rowCount ?? 0); i++) {
      const labelChain = cell(scheme, 'asym_id', i);
      const rows = schemeRowsByChain.get(labelChain);
      if (rows) rows.push(i); else schemeRowsByChain.set(labelChain, [i]);
    }
    const schemeRowsBySequence = new Map();
    const schemeRowsFor = (labelChain, labelSequenceId) => {
      let bySequence = schemeRowsBySequence.get(labelChain);
      if (!bySequence) {
        bySequence = new Map();
        for (const i of schemeRowsByChain.get(labelChain) ?? []) {
          const position = integer(scheme, 'seq_id', i);
          const rows = bySequence.get(position);
          if (rows) rows.push(i); else bySequence.set(position, [i]);
        }
        schemeRowsBySequence.set(labelChain, bySequence);
      }
      return bySequence.get(labelSequenceId) ?? [];
    };
    const observedByPosition = new Map();
    const authorsByChain = new Map();
    for (const row of observed.values()) {
      const { labelChain, entityId, labelSequenceId, componentId, authorChain } = row.identity;
      const key = tuple(labelChain, entityId, labelSequenceId, componentId);
      const rows = observedByPosition.get(key);
      if (rows) rows.push(row); else observedByPosition.set(key, [row]);
      if (authorChain !== null) {
        const authors = authorsByChain.get(labelChain);
        if (authors) authors.add(authorChain); else authorsByChain.set(labelChain, new Set([authorChain]));
      }
    }
    const chainAuthor = chain => {
      const authors = authorsByChain.get(chain.labelChain);
      return authors && authors.size === 1 ? [...authors][0] : null;
    };
    for (const chain of topology.chains.filter(c => c.entityType === 'polymer')) {
      const entries = topology.sequences.get(chain.entityId);
      if (!entries?.length) throw new Error(`Entity ${chain.entityId} lacks a declared polymer sequence.`);
      for (const entry of entries) {
        const schemes = schemeRowsFor(chain.labelChain, entry.labelSequenceId)
          .filter(i => (cell(scheme, 'mon_id', i) ?? entry.componentId) === entry.componentId);
        const sites = observedByPosition.get(tuple(chain.labelChain, chain.entityId, entry.labelSequenceId, entry.componentId)) ?? [];
        const records = schemes.length ? schemes : [null];
        for (const schemeIndex of records) {
          const declared = {
            entityId: chain.entityId, labelChain: chain.labelChain,
            authorChain: schemeIndex === null ? chainAuthor(chain) : cell(scheme, 'pdb_strand_id', schemeIndex) ?? chainAuthor(chain),
            labelSequenceId: entry.labelSequenceId,
            authorResidue: schemeIndex === null ? null : integer(scheme, 'auth_seq_num', schemeIndex),
            insertionCode: schemeIndex === null ? null : cell(scheme, 'pdb_ins_code', schemeIndex) ?? '',
            componentId: entry.componentId,
          };
          if (sites.length) {
            for (const site of sites) {
              consumedObserved.add(baseKey(site.identity));
              for (const field of ['authorChain', 'authorResidue', 'insertionCode']) {
                if (declared[field] !== null && site.identity[field] !== null && declared[field] !== site.identity[field]) {
                  throw new Error(`Sequence/atom ${field} mismatch in chain ${chain.labelChain}, position ${entry.labelSequenceId}.`);
                }
              }
              const identity = { ...site.identity };
              for (const field of ['authorChain', 'authorResidue', 'insertionCode']) {
                if (identity[field] === null) identity[field] = declared[field];
              }
              results.set(baseKey(identity), { ...site, identity, sequenceDeclared: true,
                mappingOrigin: schemeIndex === null ? 'entity_poly_seq_and_atom_site' : 'pdbx_poly_seq_scheme_and_atom_site' });
            }
          } else {
            results.set(baseKey(declared), { identity: declared, entityType: chain.entityType,
              sequenceDeclared: true, mappingOrigin: schemeIndex === null ? 'entity_poly_seq' : 'pdbx_poly_seq_scheme', atomSites: [] });
          }
        }
      }
    }
    for (const [key, row] of observed) if (!consumedObserved.has(key) && !results.has(key)) results.set(key, row);
    return [...results.values()];
  }

  function assemblyCopies(model, assemblyId, topology) {
    if (assemblyId === 'asymmetric_unit') {
      const copy = { assemblyId, generatorIndex: null, operatorIds: [], labelChains: [...new Set(topology.chains.map(c => c.labelChain))], matrix: [...IDENTITY_4] };
      return [{ ...copy, copyId: copyKey(copy) }];
    }
    const assembly = Symmetry.findAssembly(model, assemblyId);
    if (!assembly) throw new Error(`Assembly ${assemblyId} is not defined for model ${model.modelNum}.`);
    return assembly.operatorGroups.flatMap((group, generatorIndex) => group.operators.map(operator => {
      if (group.asymIds.some(id => !topology.chains.some(chain => chain.labelChain === id))) {
        throw new Error(`Assembly ${assemblyId} refers to an unknown label chain.`);
      }
      const copy = { assemblyId, generatorIndex, operatorIds: [...operator.assembly.operList],
        labelChains: [...group.asymIds], matrix: Array.from(operator.matrix) };
      return { ...copy, copyId: copyKey(copy) };
    }));
  }

  async function extractBytes(input, { sourceLabel = null, expectedHash, assemblyId = 'asymmetric_unit' } = {}) {
    const bytes = Buffer.from(input);
    const sourceHash = sha256(bytes);
    if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceHash)) throw new Error('Catalog SHA-256 dependency returned an invalid digest.');
    if (expectedHash && expectedHash !== sourceHash) throw new Error('Source SHA-256 does not match the pinned bytes.');
    if (typeof assemblyId !== 'string' || !assemblyId) throw new TypeError('An assembly identifier is required.');
    const parsed = await CIF.parse(bytes.toString('utf8')).run();
    if (parsed.isError) throw new Error(`CIF parsing failed: ${parsed.message}`);
    applyCifFieldCaseCompatibility(parsed.result);
    if (parsed.result.blocks.length !== 1) throw new Error('This draft requires one mmCIF data block.');
    const frame = parsed.result.blocks[0];
    const sourceRows = sourceAtomRows(frame);
    const trajectory = await trajectoryFromMmCIF(frame).run();
    if (!trajectory.frameCount) throw new Error('The source has no parsed coordinate model.');
    const rows = [], copies = [], modelNumbers = [], residueKeys = new Set(), atomKeys = new Set();
    for (let modelIndex = 0; modelIndex < trajectory.frameCount; modelIndex++) {
      const frameOrTask = trajectory.getFrameAtIndex(modelIndex);
      const model = typeof frameOrTask.run === 'function' ? await frameOrTask.run() : frameOrTask;
      if (modelNumbers.includes(model.modelNum)) throw new Error('Duplicate source model numbers require a separate identity rule.');
      modelNumbers.push(model.modelNum);
      const topology = sourceTopology(frame, model);
      const baseRows = sequenceRows(frame, topology, observedResidues(frame, model, topology, sourceRows));
      const modelCopies = assemblyCopies(model, assemblyId, topology);
      for (const copy of modelCopies) {
        copies.push({ ...copy, modelNumber: model.modelNum });
        const copyChains = new Set(copy.labelChains);
        for (const base of baseRows.filter(r => copyChains.has(r.identity.labelChain))) {
          if (yieldToHost) await yieldToHost();
          const identity = { sourceHash, modelNumber: model.modelNum, assemblyId,
            generatorIndex: copy.generatorIndex, operatorIds: copy.operatorIds, copyId: copy.copyId, ...base.identity };
          const key = residueKey(identity);
          if (residueKeys.has(key)) throw new Error('Duplicate canonical residue identity.');
          residueKeys.add(key);
          const atomSites = base.atomSites.map(site => {
            const atomIdentity = { ...identity, atomName: site.atomName, authorAtomName: site.authorAtomName,
              alternateSite: site.alternateSite, sourceAtomId: site.sourceAtomId };
            const siteKey = atomKey(atomIdentity);
            if (atomKeys.has(siteKey)) throw new Error('Duplicate canonical atom identity.');
            atomKeys.add(siteKey);
            return { key: siteKey, identity: atomIdentity, element: site.element,
              sourceCoordinatesAngstrom: [...site.sourceCoordinatesAngstrom],
              assemblyCoordinatesAngstrom: applyOperator(site.sourceCoordinatesAngstrom, copy.matrix) };
          });
          rows.push({ key, identity, entityType: base.entityType, sequenceDeclared: base.sequenceDeclared,
            mappingOrigin: base.mappingOrigin, coordinateState: atomSites.length ? 'resolved' : 'unresolved', atomSites });
        }
      }
    }
    return deepFreeze({ schemaVersion: 'draft-identity-1', source: { sha256: sourceHash, byteLength: bytes.length, format: 'mmcif', label: sourceLabel },
      molstarVersion, assemblyId, modelNumbers, copies, rows });
  }

  return { extractBytes };
}

module.exports = { createCatalogExtractor };
