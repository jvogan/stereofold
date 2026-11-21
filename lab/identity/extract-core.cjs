'use strict';

const { applyCifFieldCaseCompatibility } = require('./cif-field-compat.cjs');

const { deepFreeze, copyKey, residueKey, atomKey } = require('./identity.cjs');
const { IDENTITY_4, applyOperator } = require('./geometry.cjs');

/**
 * Construct the scientific mmCIF catalog extractor from explicit runtime
 * dependencies. Keeping Mol* and hashing outside this module lets the lab use
 * its pinned package resolver while the bundled plugin uses static imports.
 */
function createCatalogExtractor({ CIF, trajectoryFromMmCIF, Symmetry, molstarVersion, sha256, yieldToHost, rowBudget }) {
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
  // Optional: the most residue rows one catalog may hold, and the error to
  // raise past it. Declared sequences are counted before they are expanded and
  // every row is counted before it is kept, so a small file that declares a
  // vast table is refused without building it. Without a budget the extractor
  // builds whatever the source declares.
  //
  // An assembly can copy a few chains of an entry whose other chains hold more
  // rows than one catalog can. For an assembly, `maximumDeclaredRows` (at least
  // `maximumRows`, and `maximumRows` when absent) bounds the rows declared and
  // stored before the assembly selects its chains, and `maximumRows` judges the
  // rows the assembly produces. The asymmetric unit keeps every chain, so it
  // holds both counts to `maximumRows`.
  if (rowBudget != null && (!Number.isSafeInteger(rowBudget.maximumRows) || rowBudget.maximumRows < 1
    || typeof rowBudget.refuse !== 'function'
    || (rowBudget.maximumDeclaredRows != null && (!Number.isSafeInteger(rowBudget.maximumDeclaredRows)
      || rowBudget.maximumDeclaredRows < rowBudget.maximumRows)))) {
    throw new TypeError('rowBudget requires a positive integer maximumRows, a refuse function and no smaller maximumDeclaredRows.');
  }
  function admitRows(rows, maximum = rowBudget?.maximumRows) {
    // Written so that a count that is not a number is refused, never admitted.
    if (rowBudget && !(rows <= maximum)) throw rowBudget.refuse(rows, maximum);
  }

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

  /**
   * The declared rows the models expand to, counted from the parsed tables
   * before Mol* 5.11 builds a model: every declared sequence row times every
   * chain of its entity (at least one, since Mol* builds each declared
   * sequence whether or not a chain names its entity), times the atom_site
   * models. When a file lists no unobserved residues, Mol* walks this product
   * to find them, it builds the sequences again for every model whose atoms
   * differ from the model before, and `sequenceRows` walks the product again
   * for the catalog, so it is counted before any of these runs. When
   * `ihm_model_list` has rows, Mol* instead builds one model per row of that
   * list, each with every declared sequence row, so those are added. For a
   * well-formed file without that list it equals the declared rows of the
   * asymmetric-unit catalog. The count reads each table row once.
   */
  function declaredRowCount(frame) {
    const chainsByEntity = new Map(), asym = frame.categories.struct_asym;
    for (let i = 0; i < (asym?.rowCount ?? 0); i++) {
      const entityId = cell(asym, 'entity_id', i);
      chainsByEntity.set(entityId, (chainsByEntity.get(entityId) ?? 0) + 1);
    }
    let rowsPerModel = 0;
    const seq = frame.categories.entity_poly_seq, sequenceRows = seq?.rowCount ?? 0;
    for (let i = 0; i < sequenceRows; i++) rowsPerModel += Math.max(1, chainsByEntity.get(cell(seq, 'entity_id', i)) ?? 0);
    return rowsPerModel * Math.max(1, atomSiteModels(frame)) + sequenceRows * (frame.categories.ihm_model_list?.rowCount ?? 0);
  }

  /**
   * The models Mol* builds from atom_site: one at every run of equal
   * consecutive model numbers, or one when the column is absent. A run is
   * never fewer than the distinct numbers it holds, which bound the models
   * the missing-residue walk visits on either of Mol*'s routes.
   */
  function atomSiteModels(frame) {
    const atom = frame.categories.atom_site, rows = atom?.rowCount ?? 0;
    const number = atom?.getField('pdbx_PDB_model_num');
    let runs = rows ? 1 : 0;
    // Mol* compares the raw values the way this does, so '1' and '01' differ.
    if (number) for (let i = 1; i < rows; i++) if (!number.areValuesEqual(i - 1, i)) runs++;
    return runs;
  }

  /**
   * Rows Mol* 5.11 walks again for every model it builds besides the declared
   * sequences, never fewer than it walks. Every model reads every
   * molstar_atom_site_operator_mapping row. Every integrative model keeps one
   * entry per struct_asym row. With a pdbx_molecule prd_id column, every model
   * reads every pdbx_molecule row and keeps one value per entity. An
   * integrative model listed under an id already listed builds that id's
   * atom_site, sphere and gaussian rows again, counted here as the longest run
   * of each. Every integrative model scans every ihm_model_group_link and
   * ihm_model_group row for its group name. Models are `modelsBuilt`.
   */
  function perModelRows(frame) {
    const categories = frame.categories, rowsOf = name => categories[name]?.rowCount ?? 0;
    const listed = rowsOf('ihm_model_list'), models = modelsBuilt(frame);
    let rows = rowsOf('molstar_atom_site_operator_mapping') * models
      + (rowsOf('struct_asym') + rowsOf('ihm_model_group_link') + rowsOf('ihm_model_group')) * listed;
    if (categories.pdbx_molecule?.getField('prd_id')) {
      // Without an entity id column Mol* takes its entities from the atom and coarse rows.
      const entities = categories.entity?.getField('id') ? rowsOf('entity')
        : rowsOf('atom_site') + rowsOf('ihm_sphere_obj_site') + rowsOf('ihm_gaussian_obj_site');
      rows += (rowsOf('pdbx_molecule') + entities) * models;
    }
    if (listed) {
      // Mol* keys a listed model by the integer value of its id.
      const ids = new Set(), id = categories.ihm_model_list.getField('model_id');
      for (let i = 0; i < listed; i++) ids.add(id ? id.int(i) : 0);
      const atomModel = categories.atom_site?.getField('ihm_model_id') ? 'ihm_model_id' : 'pdbx_PDB_model_num';
      rows += (listed - ids.size) * (longestRun(categories.atom_site, atomModel)
        + longestRun(categories.ihm_sphere_obj_site, 'model_id') + longestRun(categories.ihm_gaussian_obj_site, 'model_id'));
    }
    return rows;
  }

  /** The atom_site runs plus the listed integrative models: at least the models either of Mol*'s routes builds. */
  function modelsBuilt(frame) {
    return atomSiteModels(frame) + (frame.categories.ihm_model_list?.rowCount ?? 0);
  }

  /**
   * Rows Mol* walks to build one model's symmetry, which an assembly catalog
   * reads once per model whose atoms differ: every pdbx_struct_assembly row
   * scans every pdbx_struct_assembly_gen row, then every
   * pdbx_struct_oper_list row becomes a matrix (none of these without an
   * assembly row), and every struct_ncs_oper row is read.
   */
  function assemblyRows(frame) {
    const rowsOf = name => frame.categories[name]?.rowCount ?? 0, assemblies = rowsOf('pdbx_struct_assembly');
    return (assemblies ? assemblies * (1 + rowsOf('pdbx_struct_assembly_gen')) + rowsOf('pdbx_struct_oper_list') : 0) + rowsOf('struct_ncs_oper');
  }

  /** The most consecutive rows sharing one value of `name`; all rows when the column is absent. */
  function longestRun(category, name) {
    const rows = category?.rowCount ?? 0, field = category?.getField(name);
    if (!field) return rows;
    let longest = rows ? 1 : 0;
    for (let i = 1, run = 1; i < rows; i++) {
      run = field.areValuesEqual(i - 1, i) ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    return longest;
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

  /** The rows the assembly copies take from `baseRows`, counted without building them. */
  function copyRowCount(baseRows, copies) {
    const rowsByChain = new Map();
    for (const row of baseRows) rowsByChain.set(row.identity.labelChain, (rowsByChain.get(row.identity.labelChain) ?? 0) + 1);
    let rows = 0;
    for (const copy of copies) for (const labelChain of new Set(copy.labelChains)) rows += rowsByChain.get(labelChain) ?? 0;
    return rows;
  }

  function sequenceRows(frame, topology, observed, maximumStored) {
    if (topology.observedOnly) return [...observed.values()];
    const results = new Map();
    // Counts every row stored, replacements included, so neither the kept rows
    // nor the work spent on them can pass the budget.
    let stored = 0;
    const keep = (key, row) => { admitRows(++stored, maximumStored); results.set(key, row); };
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
              keep(baseKey(identity), { ...site, identity, sequenceDeclared: true,
                mappingOrigin: schemeIndex === null ? 'entity_poly_seq_and_atom_site' : 'pdbx_poly_seq_scheme_and_atom_site' });
            }
          } else {
            keep(baseKey(declared), { identity: declared, entityType: chain.entityType,
              sequenceDeclared: true, mappingOrigin: schemeIndex === null ? 'entity_poly_seq' : 'pdbx_poly_seq_scheme', atomSites: [] });
          }
        }
      }
    }
    for (const [key, row] of observed) if (!consumedObserved.has(key) && !results.has(key)) keep(key, row);
    return [...results.values()];
  }

  /**
   * The operator names one `oper_expression` lists and the combinations they
   * form, counted the way Mol* parses it (`parseOperatorList` in its assembly
   * reader) without expanding a range or a product. Mol* lists every name of
   * every group before it forms the product, so the names are bounded too. A
   * range whose end is not a safe integer counts as unbounded: Mol* would never
   * finish listing it. Mol* then forms the product recursively from the last
   * group back to the first, one call per partial combination, so an empty
   * group stops only the groups before it; `branches` counts those calls.
   */
  function operatorCombinations(expression) {
    const groups = /\(?([^\(\)]+)\)?]*/g;
    const sizes = [];
    let combinations = 1, names = 0, group;
    while ((group = groups.exec(expression))) {
      let size = 0;
      for (const element of group[1].split(',')) {
        const dash = element.indexOf('-');
        if (dash <= 0) { size += 1; continue; }
        const from = parseInt(element.substring(0, dash)), to = parseInt(element.substr(dash + 1));
        if (!(to >= from)) continue;
        size += Number.isSafeInteger(from) && Number.isSafeInteger(to) ? to - from + 1 : Infinity;
      }
      names += size;
      // An empty group forms no combination however large the others are; kept
      // out of the product so an overflowed product times zero is not NaN.
      combinations = size === 0 || combinations === 0 ? 0 : combinations * size;
      sizes.push(size);
    }
    let partial = 1, branches = 0;
    for (let i = sizes.length - 1; i >= 0 && partial > 0; i--) {
      branches += partial;
      partial = sizes[i] && partial * sizes[i];
    }
    return { combinations: names === Infinity ? Infinity : combinations, names, branches };
  }

  /**
   * The copies and rows an assembly would add, counted from its generator
   * rows in `pdbx_struct_assembly_gen` and the chains of `baseRows`. Reading
   * the assembly's `operatorGroups` makes Mol* build every combination, so
   * this runs first.
   */
  function assemblyExpansion(frame, assembly, baseRows) {
    const gen = frame.categories.pdbx_struct_assembly_gen;
    const field = name => gen?.getField(name);
    const ids = field('assembly_id'), expressions = field('oper_expression'), chainLists = field('asym_id_list');
    const rowsByChain = new Map();
    for (const row of baseRows) rowsByChain.set(row.identity.labelChain, (rowsByChain.get(row.identity.labelChain) ?? 0) + 1);
    let copies = 0, names = 0, rows = 0, branches = 0;
    for (let i = 0; i < (gen?.rowCount ?? 0); i++) {
      if ((ids ? ids.str(i) : '') !== assembly.id) continue;
      const operators = operatorCombinations(expressions ? expressions.str(i) : ''), combinations = operators.combinations;
      names += operators.names;
      branches += operators.branches;
      // Split as Mol* splits a list column.
      const chains = new Set((chainLists ? chainLists.str(i) : '').split(',').map(id => id.trim()).filter(id => !!id));
      let chainRows = 0;
      for (const labelChain of chains) chainRows += rowsByChain.get(labelChain) ?? 0;
      copies += combinations;
      rows += chainRows && combinations * chainRows;
    }
    return { copies, names, rows, branches };
  }

  function assemblyCopies(frame, model, assemblyId, topology, baseRows, priorRows) {
    if (assemblyId === 'asymmetric_unit') {
      const copy = { assemblyId, generatorIndex: null, operatorIds: [], labelChains: [...new Set(topology.chains.map(c => c.labelChain))], matrix: [...IDENTITY_4] };
      return [{ ...copy, copyId: copyKey(copy) }];
    }
    const assembly = Symmetry.findAssembly(model, assemblyId);
    if (!assembly) throw new Error(`Assembly ${assemblyId} is not defined for model ${model.modelNum}.`);
    if (rowBudget) {
      // Each copy is a catalog record too, so a product of operators over
      // chains without rows is held to the same budget, as are the operator
      // names Mol* lists and the partial combinations it walks, which an
      // empty group leaves in place when it forms no copy.
      const expansion = assemblyExpansion(frame, assembly, baseRows);
      admitRows(priorRows + expansion.rows);
      admitRows(Math.max(expansion.copies, expansion.names, expansion.branches));
    }
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
    const maximumDeclared = assemblyId === 'asymmetric_unit' ? rowBudget?.maximumRows
      : rowBudget?.maximumDeclaredRows ?? rowBudget?.maximumRows;
    if (rowBudget) {
      const declared = declaredRowCount(frame);
      admitRows(declared, maximumDeclared);
      // The tables Mol* walks per model are held to the wider declared bound,
      // leaving the asymmetric unit's comparison with the catalog limit as it was.
      // An assembly also builds each model's symmetry.
      const symmetry = assemblyId === 'asymmetric_unit' ? 0 : modelsBuilt(frame) * assemblyRows(frame);
      admitRows(declared + perModelRows(frame) + symmetry, rowBudget.maximumDeclaredRows ?? rowBudget.maximumRows);
    }
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
      const baseRows = sequenceRows(frame, topology, observedResidues(frame, model, topology, sourceRows), maximumDeclared);
      const modelCopies = assemblyCopies(frame, model, assemblyId, topology, baseRows, rows.length);
      if (rowBudget) admitRows(rows.length + copyRowCount(baseRows, modelCopies));
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

  /**
   * Refuse mmCIF text whose declarations expand past `maximum` rows, counted
   * as `extractBytes` counts them for its declared bound (the declared rows
   * plus the tables Mol* walks per model), from the parsed tables alone: no model is
   * built. For a host that hands the text to Mol* itself, which walks the same
   * rows while it parses. Every data block is counted. Text that does not
   * parse is left for that host's own parser to report. Without a budget this
   * admits everything.
   */
  async function admitDeclaredRows(input, maximum = rowBudget?.maximumDeclaredRows ?? rowBudget?.maximumRows) {
    if (!rowBudget) return;
    const parsed = await CIF.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8')).run();
    if (parsed.isError) return;
    applyCifFieldCaseCompatibility(parsed.result);
    for (const frame of parsed.result.blocks) admitRows(declaredRowCount(frame) + perModelRows(frame), maximum);
  }

  return { extractBytes, admitDeclaredRows };
}

module.exports = { createCatalogExtractor };
