'use strict';

const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { extractBytes } = require('./extract.cjs');
const { residueKey, atomKey, validateQuery, resolveIdentity } = require('./identity.cjs');
const { IDENTITY_4, displayTransform, applyOperator, toDisplayPoint, fromDisplayPoint, distance, signedVolume6 } = require('./geometry.cjs');
const { loadFixtureCatalogs, fixtureDirectory } = require('./run.cjs');

let catalogs;
before(async () => { catalogs = await loadFixtureCatalogs(); });

function copy(catalog, operator = '1', model = 1) {
  const found = catalog.copies.find(c => c.modelNumber === model && c.operatorIds.join(',') === operator);
  assert.ok(found, `Expected operator ${operator} for model ${model}.`);
  return found;
}

function scoped(catalog, extra = {}) {
  return { sourceHash: catalog.source.sha256, modelNumber: 1, assemblyId: '1', copyId: copy(catalog).copyId, ...extra };
}

function labelQuery(catalog, chain, position, extra = {}) {
  return scoped(catalog, { chain: { namespace: 'label', id: chain }, residue: { namespace: 'label', number: position }, ...extra });
}

function near(a, b, label = 'value') { assert.ok(Math.abs(a - b) <= 1e-9, `${label}: ${a} != ${b}`); }
function nearPoint(a, b) { a.forEach((value, i) => near(value, b[i], `axis ${i}`)); }

test('the pinned fixtures yield independently specified residue, atom, and unresolved counts', () => {
  for (const [name, models, residues, atoms, unresolved] of [
    ['public_1crn', [1], 46, 327, 0],
    ['identity_edge', [1, 2], 32, 24, 12],
    ['synthetic_ligand', [1], 5, 7, 0],
    ['synthetic_voice_ambiguity', [1], 30, 30, 0],
  ]) {
    const c = catalogs[name];
    assert.equal(c.molstarVersion, '5.11.0');
    assert.deepEqual(c.modelNumbers, models);
    assert.equal(c.rows.length, residues, name);
    assert.equal(c.rows.reduce((n, r) => n + r.atomSites.length, 0), atoms, name);
    assert.equal(c.rows.filter(r => r.coordinateState === 'unresolved').length, unresolved, name);
  }
});

test('canonical identities survive JSON round trip and distinguish every model, copy, and atom site', () => {
  const c = catalogs.identity_edge;
  const roundTrip = JSON.parse(JSON.stringify(c));
  assert.equal(new Set(c.rows.map(r => r.key)).size, 32);
  assert.equal(new Set(c.rows.flatMap(r => r.atomSites.map(a => a.key))).size, 24);
  for (const row of roundTrip.rows) {
    assert.equal(residueKey(row.identity), row.key);
    assert.equal(row.identity.sourceHash, c.source.sha256);
    assert.equal(residueKey({ ...row.identity, sourceLabel: 'renamed.cif' }), row.key);
    for (const site of row.atomSites) assert.equal(atomKey(site.identity), site.key);
  }
});

test('label and author chain identifiers remain distinct', () => {
  const c = catalogs.identity_edge;
  const byLabel = resolveIdentity(c.rows, labelQuery(c, 'A', 1));
  assert.equal(byLabel.status, 'resolved');
  assert.equal(byLabel.residue.identity.authorChain, 'X');
  const wrongNamespace = resolveIdentity(c.rows, scoped(c, {
    chain: { namespace: 'author', id: 'A' }, residue: { namespace: 'author', number: 15, insertionCode: '' },
  }));
  assert.equal(wrongNamespace.status, 'not_found');
});

test('author residue 15 requires an insertion choice when both 15 and 15A exist', () => {
  const c = catalogs.identity_edge;
  const q = scoped(c, { chain: { namespace: 'author', id: 'X' }, residue: { namespace: 'author', number: 15 } });
  const ambiguous = resolveIdentity(c.rows, q);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.candidates.map(r => r.identity.insertionCode), ['', 'A']);
  assert.equal(ambiguous.positionAngstrom, null);
  const exact = resolveIdentity(c.rows, { ...q, residue: { ...q.residue, insertionCode: 'A' } });
  assert.equal(exact.status, 'resolved');
  assert.equal(exact.residue.identity.labelSequenceId, 2);
});

test('an omitted model is ambiguous across two coordinate models', () => {
  const c = catalogs.identity_edge;
  const q = labelQuery(c, 'A', 1);
  delete q.modelNumber;
  const result = resolveIdentity(c.rows, q);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map(r => r.identity.modelNumber), [1, 2]);
  assert.ok(result.differingFields.includes('modelNumber'));
});

test('an omitted assembly copy returns both source operator identities', () => {
  const c = catalogs.identity_edge;
  const q = labelQuery(c, 'A', 1);
  delete q.copyId;
  const result = resolveIdentity(c.rows, q);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map(r => r.identity.operatorIds), [['1'], ['2']]);
  assert.ok(result.differingFields.includes('copyId'));
});

test('an atom query refuses to choose an alternate site', () => {
  const c = catalogs.identity_edge;
  const q = labelQuery(c, 'A', 2, { atom: { name: 'CA', namespace: 'label' } });
  const result = resolveIdentity(c.rows, q);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map(a => a.identity.alternateSite), ['A', 'B']);
  const exact = resolveIdentity(c.rows, { ...q, atom: { ...q.atom, alternateSite: 'B' } });
  assert.equal(exact.status, 'resolved');
  assert.equal(exact.kind, 'atom');
  assert.deepEqual(exact.positionAngstrom, [3, 4, 1]);
  assert.equal(exact.atom.identity.sourceAtomId, '3');
  const secondCopy = resolveIdentity(c.rows, { ...q, copyId: copy(c, '2').copyId, atom: { ...q.atom, alternateSite: 'B' } });
  assert.deepEqual(secondCopy.positionAngstrom, [16, 3, 1]);
});

test('residue selection includes its supplied sites without inventing a residue focus point', () => {
  const c = catalogs.identity_edge;
  const result = resolveIdentity(c.rows, labelQuery(c, 'A', 2));
  assert.equal(result.status, 'resolved');
  assert.equal(result.kind, 'residue');
  assert.equal(result.residue.atomSites.length, 2);
  assert.equal(result.positionAngstrom, null);
});

test('unresolved sequence positions retain identity in each model and copy without coordinates', () => {
  const c = catalogs.identity_edge;
  for (const modelNumber of [1, 2]) for (const operator of ['1', '2']) {
    for (const [chain, sequence, author, insertion] of [['A', 3, 16, ''], ['B', 2, 15, 'A'], ['B', 3, 16, '']]) {
      const result = resolveIdentity(c.rows, labelQuery(c, chain, sequence, {
        modelNumber, copyId: copy(c, operator, modelNumber).copyId, atom: { name: 'CA' },
      }));
      assert.equal(result.status, 'unresolved_coordinates');
      assert.equal(result.residue.identity.authorResidue, author);
      assert.equal(result.residue.identity.insertionCode, insertion);
      assert.equal(result.residue.sequenceDeclared, true);
      assert.deepEqual(result.residue.atomSites, []);
      assert.equal(result.positionAngstrom, null);
    }
  }
});

test('the synthetic ligand retains a null sequence position despite Mol* placeholder zero', () => {
  const c = catalogs.synthetic_ligand;
  const q = scoped(c, { componentId: 'LIG1' });
  const result = resolveIdentity(c.rows, q);
  assert.equal(result.status, 'resolved');
  assert.equal(result.residue.identity.labelSequenceId, null);
  assert.equal(result.residue.identity.authorResidue, 501);
  assert.equal(result.residue.identity.authorChain, 'L');
  assert.equal(result.residue.entityType, 'non-polymer');
  assert.deepEqual(result.residue.atomSites.map(a => a.identity.atomName), ['C1', 'C2', 'O1']);
  assert.equal(resolveIdentity(c.rows, { ...q, residue: { namespace: 'label', number: 0 } }).status, 'invalid_query');
  assert.equal(resolveIdentity(c.rows, { ...q, residue: { namespace: 'unspecified', number: 0 } }).status, 'not_found');
});

test('chain A or eight returns the two predeclared voice candidates', () => {
  const c = catalogs.synthetic_voice_ambiguity;
  const result = resolveIdentity(c.rows, scoped(c, {
    chain: { namespace: 'author', oneOf: ['A', '8'] }, residue: { namespace: 'author', number: 15, insertionCode: '' },
  }));
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map(r => [r.identity.labelChain, r.identity.authorChain, r.identity.labelSequenceId]), [['X', 'A', 1], ['Y', '8', 1]]);
});

test('unspecified numbering returns author 15 and sequence position 15 as different residues', () => {
  const c = catalogs.synthetic_voice_ambiguity;
  const q = scoped(c, { chain: { namespace: 'author', id: 'A' }, residue: { number: 15 } });
  const result = resolveIdentity(c.rows, q);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map(r => [r.identity.labelSequenceId, r.identity.authorResidue]), [[1, 15], [15, 50]]);
  const explicit = resolveIdentity(c.rows, { ...q, residue: { namespace: 'label', number: 15 } });
  assert.equal(explicit.status, 'resolved');
  assert.equal(explicit.residue.identity.authorResidue, 50);
});

test('source scope and malformed selectors fail without a guessed target', () => {
  const c = catalogs.public_1crn;
  const valid = labelQuery(c, 'A', 1);
  for (const q of [
    { ...valid, sourceHash: undefined },
    { ...valid, unexpected: true },
    { ...valid, residue: { namespace: 'automatic', number: 1 } },
    { ...valid, atom: { name: '', alternateSite: 1 } },
  ]) {
    const result = resolveIdentity(c.rows, q);
    assert.equal(result.status, 'invalid_query');
    assert.equal(result.positionAngstrom, null);
  }
  assert.equal(resolveIdentity(c.rows, { ...valid, sourceHash: '0'.repeat(64) }).status, 'not_found');
  assert.equal(resolveIdentity(c.rows, { ...valid, residue: { namespace: 'label', number: 999 } }).status, 'not_found');
  assert.equal(resolveIdentity(c.rows, { ...valid, atom: { name: 'ATOM_THAT_DOES_NOT_EXIST' } }).status, 'not_found');
});

test('the source operator produces independent expected coordinates in both models', () => {
  const c = catalogs.identity_edge;
  const sourceModel1 = { 1: [0, 0, 0], 2: [3, 4, 0], 3: [3, 4, 1], 4: [0, 0, 12], 5: [10, 0, 0], 6: [10, 0, 12] };
  for (const row of c.rows) for (const atom of row.atomSites) {
    const id = Number(atom.identity.sourceAtomId);
    const original = sourceModel1[id - (row.identity.modelNumber === 2 ? 6 : 0)].map((v, axis) => v + (row.identity.modelNumber === 2 && axis === 2 ? 2 : 0));
    assert.deepEqual(atom.sourceCoordinatesAngstrom, original);
    const expected = row.identity.operatorIds[0] === '1' ? original : [20 - original[1], original[0], original[2]];
    assert.deepEqual(atom.assemblyCoordinatesAngstrom, expected);
  }
});

test('assembly and display transforms preserve independently defined distances and handedness', () => {
  const c = catalogs.identity_edge;
  const source = [[0, 0, 0], [3, 4, 0], [0, 0, 12], [10, 0, 0]];
  assert.equal(signedVolume6(source), 480);
  for (const operator of ['1', '2']) {
    const assembled = source.map(p => applyOperator(p, copy(c, operator).matrix));
    near(distance(assembled[0], assembled[1]), 5);
    near(distance(assembled[0], assembled[2]), 12);
    near(signedVolume6(assembled), 480);
    for (const scale of [0.001, 0.01, 0.1]) {
      const transform = displayTransform({ metresPerAngstrom: scale, rotation: [0, 1, 0, -1, 0, 0, 0, 0, 1], translationMetres: [1, 2, 3] });
      const displayed = assembled.map(p => toDisplayPoint(p, transform));
      near(distance(displayed[0], displayed[1]) / scale, 5);
      near(signedVolume6(displayed) / scale ** 3, 480);
      displayed.forEach((p, i) => nearPoint(fromDisplayPoint(p, transform), assembled[i]));
    }
  }
});

test('invalid display transforms and absent coordinates fail explicitly', () => {
  for (const scale of [0, -1, Infinity, NaN]) assert.throws(() => displayTransform({ metresPerAngstrom: scale }));
  assert.throws(() => displayTransform({ metresPerAngstrom: 1, rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }), /handedness/);
  assert.throws(() => displayTransform({ metresPerAngstrom: 1, rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1] }), /orthonormal/);
  assert.throws(() => applyOperator(null, IDENTITY_4));
  assert.throws(() => toDisplayPoint(null, { metresPerAngstrom: 1 }));
  assert.throws(() => toDisplayPoint([1e308, 0, 0], { metresPerAngstrom: 1e308 }));
  const projective = [...IDENTITY_4]; projective[3] = 1;
  assert.throws(() => applyOperator([0, 0, 0], projective), /affine/);
});

test('render transforms and resolver calls preserve the frozen scientific catalog', () => {
  const c = catalogs.identity_edge;
  const before = JSON.stringify(c);
  const q = labelQuery(c, 'A', 1, { atom: { name: 'CA' } });
  const selected = resolveIdentity(c.rows, q);
  const displayed = toDisplayPoint(selected.positionAngstrom, { metresPerAngstrom: 0.01 });
  displayed[0] = 999;
  selected.positionAngstrom[0] = 888;
  assert.throws(() => { selected.atom.sourceCoordinatesAngstrom[0] = 777; }, TypeError);
  assert.equal(JSON.stringify(c), before);
});

test('missing source author numbering remains null instead of borrowing another numbering column', async () => {
  const bytes = await readFile(resolve(fixtureDirectory, 'identity-edge.cif'), 'utf8');
  const changed = bytes.replace('A 1 3 SER 16 16 X .', 'A 1 3 SER ? 16 X .');
  assert.notEqual(changed, bytes);
  const c = await extractBytes(changed, { assemblyId: '1' });
  const result = resolveIdentity(c.rows, labelQuery(c, 'A', 3));
  assert.equal(result.status, 'unresolved_coordinates');
  assert.equal(result.residue.identity.authorResidue, null);
  assert.equal(result.positionAngstrom, null);
});

test('source hash and assembly validation precede any transfer claim', async () => {
  const bytes = await readFile(resolve(fixtureDirectory, 'identity-edge.cif'));
  await assert.rejects(extractBytes(bytes, { expectedHash: '0'.repeat(64), assemblyId: '1' }), /SHA-256/);
  await assert.rejects(extractBytes(bytes, { assemblyId: 'does-not-exist' }), /not defined/);
  const asu = await extractBytes(bytes, { assemblyId: 'asymmetric_unit' });
  assert.equal(asu.rows.length, 16);
  assert.equal(asu.rows.reduce((n, r) => n + r.atomSites.length, 0), 12);
  assert.ok(asu.rows.every(r => r.identity.operatorIds.length === 0));
  const commentChanged = await extractBytes(Buffer.concat([bytes, Buffer.from('# changed source bytes\n')]), { assemblyId: '1' });
  assert.notEqual(commentChanged.source.sha256, catalogs.identity_edge.source.sha256);
  assert.notEqual(commentChanged.rows[0].key, catalogs.identity_edge.rows[0].key);
  assert.deepEqual(commentChanged.rows[0].atomSites[0].sourceCoordinatesAngstrom, catalogs.identity_edge.rows[0].atomSites[0].sourceCoordinatesAngstrom);
});

test('a host that supplies yieldToHost gets a turn between residues and the same catalog', async () => {
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { createCatalogExtractor } = require('./extract-core.cjs');
  const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
  const dependencies = {
    CIF: fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js').CIF,
    trajectoryFromMmCIF: fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js').trajectoryFromMmCIF,
    Symmetry: fromPlugin('molstar/lib/commonjs/mol-model/structure/model.js').Symmetry,
    molstarVersion: fromPlugin('molstar/package.json').version,
    sha256: bytes => createHash('sha256').update(bytes).digest('hex'),
  };
  const bytes = await readFile(resolve(fixtureDirectory, 'identity-edge.cif'));
  let turns = 0;
  const yielding = createCatalogExtractor({ ...dependencies, yieldToHost: () => { turns++; return turns % 2 ? new Promise(done => setImmediate(done)) : undefined; } });
  const plain = createCatalogExtractor(dependencies);
  const withTurns = await yielding.extractBytes(bytes, { assemblyId: '1' });
  const without = await plain.extractBytes(bytes, { assemblyId: '1' });
  assert.deepEqual(withTurns, without);
  assert.equal(turns, withTurns.rows.length, 'one turn per residue row');
  assert.throws(() => createCatalogExtractor({ ...dependencies, yieldToHost: 'later' }), /yieldToHost must be a function/);
});

const ATOM_FIELDS = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
  'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
  'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'].map(field => `_atom_site.${field}`);
const OPERATOR_FIELDS = ['id', 'type', 'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'vector[1]', 'matrix[2][1]', 'matrix[2][2]',
  'matrix[2][3]', 'vector[2]', 'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[3]'].map(field => `_pdbx_struct_oper_list.${field}`);

// Every chain declares the same entity's whole sequence and one atom stands in
// each model, so the source grows with chains plus positions while its rows
// grow with chains times positions, times operators and models.
function declaredRows({ chains, positions, operators = 0, models = 1, expression = `(1-${operators})`, copied = chains }) {
  const chainIds = Array.from({ length: chains }, (_, c) => `C${c}`);
  const lines = ['data_declared_rows', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id',
    ...Array.from({ length: positions }, (_, p) => `1 ${p + 1} ALA`), '#',
    'loop_', '_struct_asym.id', '_struct_asym.entity_id', ...chainIds.map(id => `${id} 1`), '#'];
  if (operators) lines.push('loop_', '_pdbx_struct_assembly.id', '_pdbx_struct_assembly.details', "1 'translated copies'", '#',
    'loop_', '_pdbx_struct_assembly_gen.assembly_id', '_pdbx_struct_assembly_gen.oper_expression', '_pdbx_struct_assembly_gen.asym_id_list',
    `1 '${expression}' ${chainIds.slice(0, copied).join(',')}`, '#', 'loop_', ...OPERATOR_FIELDS,
    ...Array.from({ length: operators }, (_, o) => `${o + 1} 'translation' 1 0 0 ${o} 0 1 0 0 0 0 1 0`), '#');
  lines.push('loop_', ...ATOM_FIELDS,
    ...Array.from({ length: models }, (_, m) => `ATOM 1 C CA . ALA C0 1 1 ? 0 0 0 1 10 1 ALA C0 CA ${m + 1}`), '#', '');
  return lines.join('\n');
}

// One declared position matched by several scheme rows and several observed
// residues. Each scheme row fills the residues' missing author chain
// differently, so the rows grow with scheme rows times residues.
function schemeBySites({ schemes, sites }) {
  return ['data_scheme_sites', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id', '1 1 ALA', '#',
    'loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1', '#',
    'loop_', ...['asym_id', 'entity_id', 'seq_id', 'mon_id', 'auth_seq_num', 'pdb_strand_id', 'pdb_ins_code'].map(field => `_pdbx_poly_seq_scheme.${field}`),
    ...Array.from({ length: schemes }, (_, s) => `A 1 1 ALA ? S${s} .`), '#',
    'loop_', ...ATOM_FIELDS,
    ...Array.from({ length: sites }, (_, a) => `ATOM ${a + 1} C CA . ALA A 1 1 ? ${a} 0 0 1 10 ${a + 1} ALA ? CA 1`), '#', ''].join('\n');
}

test('a host row budget refuses a source whose declarations expand past it before building those rows', async () => {
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { createCatalogExtractor } = require('./extract-core.cjs');
  const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
  const dependencies = {
    CIF: fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js').CIF,
    trajectoryFromMmCIF: fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js').trajectoryFromMmCIF,
    Symmetry: fromPlugin('molstar/lib/commonjs/mol-model/structure/model.js').Symmetry,
    molstarVersion: fromPlugin('molstar/package.json').version,
    sha256: bytes => createHash('sha256').update(bytes).digest('hex'),
  };
  let refused = [], turns = 0;
  const budgeted = maximumRows => createCatalogExtractor({ ...dependencies, yieldToHost: () => { turns++; },
    rowBudget: { maximumRows, refuse: rows => { refused.push(rows); return new Error(`over the row budget: ${rows}`); } } });
  const check = async (text, maximumRows, options, expected) => {
    refused = []; turns = 0;
    await assert.rejects(budgeted(maximumRows).extractBytes(text, options), /over the row budget/);
    assert.deepEqual(refused, [expected.refusedAt]);
    assert.equal(turns, expected.turns, 'rows kept before the refusal');
  };

  // 30 chains by 40 positions declare 1,200 rows, counted before Mol* parses
  // the model: a parse that walked them would see the stub below throw.
  const counted = createCatalogExtractor({ ...dependencies, trajectoryFromMmCIF: () => { throw new Error('parsed the model'); },
    rowBudget: { maximumRows: 1199, refuse: rows => new Error(`over the row budget: ${rows}`) } });
  await assert.rejects(counted.extractBytes(declaredRows({ chains: 30, positions: 40 })), /over the row budget: 1200/);
  const product = declaredRows({ chains: 30, positions: 40 });
  await check(product, 1199, {}, { refusedAt: 1200, turns: 0 });
  const plain = await createCatalogExtractor(dependencies).extractBytes(product);
  assert.equal(plain.rows.length, 1200);
  assert.deepEqual(await budgeted(1200).extractBytes(product), plain, 'a source at the budget keeps the same catalog');

  // Assembly operators multiply the rows: 2 chains by 10 positions in 60 copies.
  const copies = declaredRows({ chains: 2, positions: 10, operators: 60 });
  assert.equal((await budgeted(20).extractBytes(copies)).rows.length, 20);
  await check(copies, 1199, { assemblyId: '1' }, { refusedAt: 1200, turns: 0 });

  // Every coordinate model expands the declarations again: four models of 300.
  await check(declaredRows({ chains: 10, positions: 30, models: 4 }), 1000, {}, { refusedAt: 1200, turns: 0 });

  // Scheme rows times observed residues at one declared position.
  await check(schemeBySites({ schemes: 40, sites: 40 }), 1000, {}, { refusedAt: 1001, turns: 0 });
  assert.equal((await createCatalogExtractor(dependencies).extractBytes(schemeBySites({ schemes: 4, sites: 5 }))).rows.length, 20);

  assert.throws(() => createCatalogExtractor({ ...dependencies, rowBudget: { maximumRows: 0, refuse: () => new Error('no') } }), /rowBudget requires/);
  assert.throws(() => createCatalogExtractor({ ...dependencies, rowBudget: { maximumRows: 10, maximumDeclaredRows: 9, refuse: () => new Error('no') } }), /rowBudget requires/);

  // An assembly is judged by its own rows; the chains it leaves out are held
  // to the wider declared bound. 30 chains by 40 positions, one chain copied.
  const oneChain = declaredRows({ chains: 30, positions: 40, operators: 1, copied: 1 });
  const wide = (maximumRows, maximumDeclaredRows) => createCatalogExtractor({ ...dependencies,
    rowBudget: { maximumRows, maximumDeclaredRows, refuse: (rows, maximum) => new Error(`over ${maximum}: ${rows}`) } });
  // The wider bound also holds the 3 rows Mol* walks for the model's symmetry
  // (one assembly scanning one generator, and one operator).
  assert.equal((await wide(40, 1203).extractBytes(oneChain, { assemblyId: '1' })).rows.length, 40);
  await assert.rejects(wide(40, 1202).extractBytes(oneChain, { assemblyId: '1' }), /over 1202: 1203/);
  await assert.rejects(wide(39, 1203).extractBytes(oneChain, { assemblyId: '1' }), /over 39: 40/);
  await assert.rejects(wide(40, 1199).extractBytes(oneChain, { assemblyId: '1' }), /over 1199: 1200/);
  await assert.rejects(wide(40, 1200).extractBytes(oneChain), /over 40: 1200/);
});

// One entity of `positions` declared residues and `models` models as Mol*
// builds them: contiguous model numbers, model numbers that alternate row by
// row, rows of the integrative model list, or contiguous models with no
// struct_asym table. Consecutive atoms alternate their name, so no model
// repeats the hierarchy of the one before it and Mol* builds every model's
// sequences again.
function modelRows(shape, positions, models) {
  const atom = (id, name, model) => `ATOM ${id} C ${name} . ALA A 1 1 ? 0 0 0 1 10 1 ALA A ${name} ${model}`;
  const lines = ['data_model_rows', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id',
    ...Array.from({ length: positions }, (_, p) => `1 ${p + 1} ALA`), '#'];
  if (shape !== 'no-chains') lines.push('loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1', '#');
  if (shape === 'integrative') lines.push('loop_', '_ihm_model_list.model_id', '_ihm_model_list.model_name',
    ...Array.from({ length: models }, (_, m) => `${m + 1} m${m + 1}`), '#');
  lines.push('loop_', ...ATOM_FIELDS, ...Array.from({ length: shape === 'integrative' ? 1 : models },
    (_, i) => atom(i + 1, i % 2 ? 'CB' : 'CA', shape === 'alternating' ? i % 2 + 1 : i + 1)), '#', '');
  return lines.join('\n');
}

test('the declared row count multiplies by every model Mol* builds, before it builds one', async () => {
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { createCatalogExtractor } = require('./extract-core.cjs');
  const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
  const { trajectoryFromMmCIF } = fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
  const { CIF } = fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js');
  const dependencies = { CIF, trajectoryFromMmCIF, Symmetry: fromPlugin('molstar/lib/commonjs/mol-model/structure/model.js').Symmetry,
    molstarVersion: fromPlugin('molstar/package.json').version, sha256: bytes => createHash('sha256').update(bytes).digest('hex') };
  const counted = maximumRows => {
    let built = 0;
    const extractor = createCatalogExtractor({ ...dependencies, trajectoryFromMmCIF: frame => { built++; return trajectoryFromMmCIF(frame); },
      rowBudget: { maximumRows, refuse: rows => new Error(`over the row budget: ${rows}`) } });
    return { extractor, built: () => built };
  };
  const molstarModels = async text => (await trajectoryFromMmCIF((await CIF.parse(text).run()).result.blocks[0]).run()).frameCount;

  // Each shape: 30 declared positions in 40 models Mol* builds, 1,200 rows.
  // The integrative shape adds its one atom_site model, which Mol*'s
  // missing-residue walk still visits: 1,230 declared. Its 40 models also
  // each keep the one struct_asym row, which only the wider bound counts.
  for (const [shape, declared, total] of [['alternating', 1200, 1200], ['integrative', 1230, 1270], ['no-chains', 1200, 1200], ['contiguous', 1200, 1200]]) {
    const text = modelRows(shape, 30, 40);
    assert.equal(await molstarModels(text), 40, shape);
    for (const route of ['extractBytes', 'admitDeclaredRows']) {
      const rows = route === 'extractBytes' ? declared : total, refusing = counted(rows - 1);
      await assert.rejects(refusing.extractor[route](text), new RegExp(`over the row budget: ${rows}$`), `${shape} ${route}`);
      assert.equal(refusing.built(), 0, `${shape} ${route}: refused before Mol* built a model`);
      await counted(total).extractor.admitDeclaredRows(text);
    }
  }
  // An integrative list shorter than the coordinate models still counts the
  // models the missing-residue walk visits: 30 x 40, plus 30 for the one
  // listed model, plus its one struct_asym row.
  const fewer = modelRows('contiguous', 30, 40).replace('loop_\n_atom_site.',
    'loop_\n_ihm_model_list.model_id\n_ihm_model_list.model_name\n1 m1\n#\nloop_\n_atom_site.');
  assert.equal(await molstarModels(fewer), 1);
  await assert.rejects(counted(1230).extractor.admitDeclaredRows(fewer), /over the row budget: 1231$/);
  // A contiguous ensemble keeps the count it had: 10 chains by 30 positions in four models.
  await assert.rejects(counted(1199).extractor.admitDeclaredRows(declaredRows({ chains: 10, positions: 30, models: 4 })), /over the row budget: 1200$/);
  await counted(1200).extractor.admitDeclaredRows(declaredRows({ chains: 10, positions: 30, models: 4 }));
  assert.equal((await counted(1200).extractor.extractBytes(declaredRows({ chains: 10, positions: 30, models: 4 }))).modelNumbers.length, 4);
});

// One declared residue on chain A, and a table Mol* walks again for every
// model it builds:
//  operator-mapping: `models` contiguous models, `rows` molstar_atom_site_operator_mapping rows;
//  integrative-chains: `models` listed integrative models, `rows` more struct_asym rows;
//  molecule: `models` contiguous models, `rows` entities and `rows` pdbx_molecule rows;
//  repeated-model: `models` listed integrative models all named 1, `rows` atoms in model 1.
// Returns the text and the rows the count is expected to reach.
function perModelTables(term, models, rows) {
  const atom = (id, name, model) => `ATOM ${id} C ${name} . ALA A 1 1 ? 0 0 0 1 10 1 ALA A ${name} ${model}`;
  const entities = term === 'molecule' ? rows : term === 'integrative-chains' ? 2 : 1;
  const lines = ['data_per_model_tables', 'loop_', '_entity.id', '_entity.type',
    ...Array.from({ length: entities }, (_, e) => `${e + 1} ${e ? 'non-polymer' : 'polymer'}`), '#',
    'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id', '1 1 ALA', '#',
    'loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1'];
  if (term === 'integrative-chains') lines.push(...Array.from({ length: rows }, (_, a) => `X${a} 2`));
  lines.push('#');
  if (term === 'operator-mapping') lines.push('loop_', ...['label_asym_id', 'auth_asym_id', 'operator_name', 'suffix', 'assembly_id',
    'assembly_operator_id', 'symmetry_operator_index', 'symmetry_hkl', 'ncs_id'].map(field => `_molstar_atom_site_operator_mapping.${field}`),
  ...Array.from({ length: rows }, (_, r) => `Q${r} Q${r} op${r} s${r} 1 ${r + 1} ? '0 0 0' ?`), '#');
  if (term === 'molecule') lines.push('loop_', '_pdbx_molecule.instance_id', '_pdbx_molecule.prd_id', '_pdbx_molecule.asym_id',
    ...Array.from({ length: rows }, (_, p) => `${p + 1} PRD_${String(p).padStart(6, '0')} A`), '#');
  if (term === 'group-names') lines.push('loop_', '_ihm_model_group.id', '_ihm_model_group.name',
    ...Array.from({ length: rows }, (_, g) => `${g + 1} g${g + 1}`), '#', 'loop_', '_ihm_model_group_link.group_id', '_ihm_model_group_link.model_id',
    ...Array.from({ length: rows }, (_, k) => `${k + 1} ${k + 1}`), '#');
  if (term === 'assembly') lines.push('loop_', '_pdbx_struct_assembly.id', '_pdbx_struct_assembly.details', "1 'copies'", '#',
    'loop_', '_pdbx_struct_assembly_gen.assembly_id', '_pdbx_struct_assembly_gen.oper_expression', '_pdbx_struct_assembly_gen.asym_id_list',
    ...Array.from({ length: rows }, () => "1 '1' A"), '#', 'loop_', ...['id', 'type', 'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'vector[1]',
      'matrix[2][1]', 'matrix[2][2]', 'matrix[2][3]', 'vector[2]', 'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[3]'].map(field => `_pdbx_struct_oper_list.${field}`),
    ...Array.from({ length: rows }, (_, o) => `${o + 1} 'translation' 1 0 0 ${o} 0 1 0 0 0 0 1 0`), '#');
  const listed = term === 'integrative-chains' || term === 'repeated-model' || term === 'group-names';
  if (listed) lines.push('loop_', '_ihm_model_list.model_id', '_ihm_model_list.model_name',
    ...Array.from({ length: models }, (_, m) => `${term === 'repeated-model' ? 1 : m + 1} m${m + 1}`), '#');
  const atoms = term === 'repeated-model' ? Array.from({ length: rows }, (_, i) => atom(i + 1, 'CA', 1))
    : term === 'integrative-chains' || term === 'group-names' ? [atom(1, 'CA', 1)] : Array.from({ length: models }, (_, i) => atom(i + 1, i % 2 ? 'CB' : 'CA', i + 1));
  lines.push('loop_', ...ATOM_FIELDS, ...atoms, '#', '');
  const expected = { 'operator-mapping': models + rows * models, 'integrative-chains': 1 + models + (rows + 1) * models,
    molecule: models + 2 * rows * models, 'repeated-model': 1 + 2 * models + (models - 1) * rows,
    'group-names': 1 + 2 * models + 2 * rows * models, assembly: 2 * models + 2 * rows * models }[term];
  return { text: lines.join('\n'), expected };
}

test('the declared row count adds the tables Mol* walks again for every model, before it builds one', async () => {
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { createCatalogExtractor } = require('./extract-core.cjs');
  const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
  const { trajectoryFromMmCIF } = fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
  const { CIF } = fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js');
  const dependencies = { CIF, trajectoryFromMmCIF, Symmetry: fromPlugin('molstar/lib/commonjs/mol-model/structure/model.js').Symmetry,
    molstarVersion: fromPlugin('molstar/package.json').version, sha256: bytes => createHash('sha256').update(bytes).digest('hex') };
  const counted = maximumRows => {
    let built = 0;
    const extractor = createCatalogExtractor({ ...dependencies, trajectoryFromMmCIF: frame => { built++; return trajectoryFromMmCIF(frame); },
      rowBudget: { maximumRows, refuse: rows => new Error(`over the row budget: ${rows}`) } });
    return { extractor, built: () => built };
  };
  const molstarModels = async text => (await trajectoryFromMmCIF((await CIF.parse(text).run()).result.blocks[0]).run()).frameCount;

  for (const [term, models, rows] of [['operator-mapping', 4, 10], ['integrative-chains', 4, 9], ['molecule', 4, 5], ['repeated-model', 5, 10], ['group-names', 4, 10]]) {
    const { text, expected } = perModelTables(term, models, rows);
    assert.equal(await molstarModels(text), models, term);
    for (const route of ['extractBytes', 'admitDeclaredRows']) {
      const refusing = counted(expected - 1);
      await assert.rejects(refusing.extractor[route](text), new RegExp(`over the row budget: ${expected}$`), `${term} ${route}`);
      assert.equal(refusing.built(), 0, `${term} ${route}: refused before Mol* built a model`);
      await counted(expected).extractor.admitDeclaredRows(text);
    }
  }
  // An assembly catalog builds each model's symmetry: 4 models, 10 generators, 10 operators.
  const assembly = perModelTables('assembly', 4, 10), refusing = counted(assembly.expected - 1);
  await assert.rejects(refusing.extractor.extractBytes(assembly.text, { assemblyId: '1' }), new RegExp(`over the row budget: ${assembly.expected}$`));
  assert.equal(refusing.built(), 0, 'assembly: refused before Mol* built a model');
  assert.equal((await counted(4).extractor.extractBytes(assembly.text)).rows.length, 4, 'the asymmetric unit does not build symmetry');
  // A contiguous ensemble without these tables keeps its count: 10 chains by 30 positions in four models.
  await assert.rejects(counted(1199).extractor.extractBytes(declaredRows({ chains: 10, positions: 30, models: 4 })), /over the row budget: 1200$/);
  assert.equal((await counted(1200).extractor.extractBytes(declaredRows({ chains: 10, positions: 30, models: 4 }))).modelNumbers.length, 4);
});

test('a host row budget counts assembly operator combinations before Mol* expands them', async () => {
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { createCatalogExtractor } = require('./extract-core.cjs');
  const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
  const { Symmetry } = fromPlugin('molstar/lib/commonjs/mol-model/structure/model.js');
  let expanded = 0;
  // Reports each read of an assembly's operator groups, the read that makes
  // Mol* expand every operator combination.
  const watched = { ...Symmetry, findAssembly(model, id) {
    const assembly = Symmetry.findAssembly(model, id);
    return assembly && new Proxy(assembly, { get(target, key) {
      if (key === 'operatorGroups') expanded++;
      return Reflect.get(target, key, target);
    } });
  } };
  const dependencies = {
    CIF: fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js').CIF,
    trajectoryFromMmCIF: fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js').trajectoryFromMmCIF,
    Symmetry: watched, molstarVersion: fromPlugin('molstar/package.json').version,
    sha256: bytes => createHash('sha256').update(bytes).digest('hex'),
  };
  const refused = [];
  const budgeted = maximumRows => createCatalogExtractor({ ...dependencies,
    rowBudget: { maximumRows, refuse: rows => { refused.push(rows); return new Error(`over the row budget: ${rows}`); } } });

  // One declared row and 20 operators combined three deep: 8,000 copies.
  const cubed = declaredRows({ chains: 1, positions: 1, operators: 20, expression: '(1-20)(1-20)(1-20)' });
  await assert.rejects(budgeted(7999).extractBytes(cubed, { assemblyId: '1' }), /over the row budget: 8000/);
  assert.deepEqual(refused, [8000]);
  assert.equal(expanded, 0, 'operator combinations were expanded before the budget refused them');
  // The same count admits the assembly at the budget, with the same catalog.
  const plain = await createCatalogExtractor(dependencies).extractBytes(cubed, { assemblyId: '1' });
  assert.equal(plain.rows.length, 8000);
  assert.deepEqual(await budgeted(8000).extractBytes(cubed, { assemblyId: '1' }), plain);

  // Ranges and lists in one group, and a range whose end is not a safe integer.
  refused.length = 0; expanded = 0;
  await assert.rejects(budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 20, expression: '(1-10,12,15-20)(1-20)' }),
    { assemblyId: '1' }), /over the row budget: 340/);
  await assert.rejects(budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 2, expression: '(1-2)(100000000000000000-100000000000000000)' }),
    { assemblyId: '1' }), /over the row budget: Infinity/);
  // Mol* lists every name in every group before forming the product, so an
  // empty group does not excuse a long range beside it.
  await assert.rejects(budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 2, expression: '(1-100000)(5-1)' }),
    { assemblyId: '1' }), /over the row budget: 100000/);
  await assert.rejects(budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 2, expression: '(5-1)(100000000000000000-100000000000000000)' }),
    { assemblyId: '1' }), /over the row budget: Infinity/);
  // Mol* forms the product from the last group back to the first, so an empty
  // group stops only the groups before it: this one forms no copy but walks
  // 1 + 12 + 144 + 1,728 partial combinations first.
  await assert.rejects(budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 12, expression: '(5-1)(1-12)(1-12)(1-12)' }),
    { assemblyId: '1' }), /over the row budget: 1885/);
  await assert.rejects(budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 12, expression: '(1-12)(5-1)(1-12)(1-12)' }),
    { assemblyId: '1' }), /over the row budget: 157/);
  // Six groups of 100 behind the empty group would walk about 10^12.
  await assert.rejects(budgeted(1_000_000).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 100,
    expression: '(5-1)(1-100)(1-100)(1-100)(1-100)(1-100)(1-100)' }), { assemblyId: '1' }), /over the row budget: 1010101010101/);
  // A product that overflows before the empty group must not turn the counts
  // into NaN, which no budget comparison refuses.
  await assert.rejects(budgeted(1_000_000).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 100,
    expression: '(1-100)'.repeat(155) + '(5-1)' + '(1-100)'.repeat(6) }), { assemblyId: '1' }), /over the row budget: 1010101010101/);
  // The same across two generator rows of one assembly: the first forms no
  // copy and must not hide the second.
  const twoRows = declaredRows({ chains: 1, positions: 1, operators: 100, expression: '(1-100)'.repeat(155) + '(5-1)' })
    .replace(/^(1 '[^']*' C0)$/mu, `$1\n1 '${'(1-100)'.repeat(6)}' C0`);
  assert.equal(twoRows.split('(1-100)(1-100)(1-100)(1-100)(1-100)(1-100)\' C0').length, 2, 'the fixture holds the second generator row');
  await assert.rejects(budgeted(1_000_000).extractBytes(twoRows, { assemblyId: '1' }), /over the row budget: 1000000000000/);
  assert.equal(expanded, 0);
  // An empty last group stops the walk at once: admitted, with no copies.
  assert.equal((await budgeted(100).extractBytes(declaredRows({ chains: 1, positions: 1, operators: 12, expression: '(1-12)(1-12)(5-1)' }),
    { assemblyId: '1' })).rows.length, 0);
});

test('sparse geometry tuples and inherited elements cannot produce NaN results', () => {
  const sparsePoint = [0, 0, 0];
  delete sparsePoint[1];
  const inheritedPoint = new Array(3);
  Object.setPrototypeOf(inheritedPoint, [0, 0, 0]);
  for (const point of [new Array(3), sparsePoint, inheritedPoint]) {
    assert.throws(() => distance(point, [0, 0, 0]), /dense/);
    assert.throws(() => distance([0, 0, 0], point), /dense/);
    assert.throws(() => applyOperator(point, IDENTITY_4), /dense/);
    assert.throws(() => toDisplayPoint(point, { metresPerAngstrom: 1 }), /dense/);
    assert.throws(() => fromDisplayPoint(point, { metresPerAngstrom: 1 }), /dense/);
  }
  assert.throws(() => displayTransform({ metresPerAngstrom: 1, rotation: new Array(9) }), /dense/);
  assert.throws(() => displayTransform({ metresPerAngstrom: 1, translationMetres: new Array(3) }), /dense/);
  assert.throws(() => applyOperator([0, 0, 0], new Array(16)), /dense/);
});

test('signed volume requires four dense points and rejects numeric overflow', () => {
  const tetrahedron = [[0, 0, 0], [3, 4, 0], [0, 0, 12], [10, 0, 0]];
  const missingPoint = [...tetrahedron]; delete missingPoint[2];
  const missingCoordinate = tetrahedron.map(p => [...p]); delete missingCoordinate[1][1];
  assert.throws(() => signedVolume6(new Array(4)), /dense/);
  assert.throws(() => signedVolume6(missingPoint), /dense/);
  assert.throws(() => signedVolume6(missingCoordinate), /dense/);
  assert.throws(() => distance([1e308, 0, 0], [-1e308, 0, 0]), /finite numeric range/);
  assert.throws(() => signedVolume6([[0, 0, 0], [1e308, 0, 0], [0, 1e308, 0], [0, 0, 1e308]]), /finite numeric range/);
  assert.equal(signedVolume6(tetrahedron), 480);
});

test('geometry reads each caller coordinate once before arithmetic', () => {
  let reads = 0;
  const point = [0, 0, 0];
  Object.defineProperty(point, 0, { enumerable: true, get() { reads++; return reads === 1 ? 3 : NaN; } });
  assert.equal(distance(point, [0, 4, 0]), 5);
  assert.equal(reads, 1);
});

test('present malformed selectors are rejected even when a unique component is supplied', () => {
  const c = catalogs.synthetic_ligand;
  const base = scoped(c, { componentId: 'LIG1' });
  for (const field of ['chain', 'residue', 'atom']) {
    for (const value of [null, false, 0, '', undefined, []]) {
      const q = { ...base, [field]: value };
      const result = resolveIdentity(c.rows, q);
      assert.equal(result.status, 'invalid_query', `${field}: ${String(value)}`);
      assert.deepEqual(result.candidates, []);
      assert.equal(result.positionAngstrom, null);
      assert.equal(typeof validateQuery(q), 'string');
    }
  }
  const sparseCandidates = scoped(c, { componentId: 'LIG1', chain: { oneOf: new Array(1) } });
  assert.equal(resolveIdentity(c.rows, sparseCandidates).status, 'invalid_query');
});

test('namespace omission is supported but explicit invalid namespace values are rejected', () => {
  const c = catalogs.synthetic_ligand;
  const base = scoped(c, { componentId: 'LIG1' });
  const selectors = { chain: { id: 'L' }, residue: { number: 501 }, atom: { name: 'C1' } };
  const omitted = resolveIdentity(c.rows, { ...base, ...selectors });
  assert.equal(omitted.status, 'resolved');
  assert.equal(omitted.kind, 'atom');
  assert.deepEqual(omitted.positionAngstrom, [6, 3, 0]);
  for (const [field, selector] of Object.entries(selectors)) {
    for (const namespace of [null, false, 0, '', undefined, [], {}]) {
      const result = resolveIdentity(c.rows, { ...base, ...selectors, [field]: { ...selector, namespace } });
      assert.equal(result.status, 'invalid_query', `${field} namespace: ${String(namespace)}`);
      assert.equal(result.positionAngstrom, null);
    }
  }
});

test('resolver validation and selection use one snapshot of changing caller getters', () => {
  const c = catalogs.synthetic_ligand;
  let nameReads = 0, selectorReads = 0;
  const atom = {};
  Object.defineProperty(atom, 'name', { enumerable: true, get() { nameReads++; return nameReads === 1 ? 'C1' : 'O1'; } });
  const q = scoped(c, { componentId: 'LIG1' });
  Object.defineProperty(q, 'atom', { enumerable: true, get() { selectorReads++; return selectorReads === 1 ? atom : null; } });
  const result = resolveIdentity(c.rows, q);
  assert.equal(result.status, 'resolved');
  assert.equal(result.atom.identity.atomName, 'C1');
  assert.deepEqual(result.positionAngstrom, [6, 3, 0]);
  assert.equal(nameReads, 1);
  assert.equal(selectorReads, 1);
});

test('noncloneable queries and throwing getters produce invalid_query', () => {
  const c = catalogs.synthetic_ligand;
  const q = scoped(c, { componentId: 'LIG1', atom: { name() { return 'C1'; } } });
  assert.equal(resolveIdentity(c.rows, q).status, 'invalid_query');
  assert.equal(typeof validateQuery(q), 'string');
  const throwing = scoped(c, { componentId: 'LIG1' });
  Object.defineProperty(throwing, 'atom', { enumerable: true, get() { throw new Error('caller getter failed'); } });
  assert.equal(resolveIdentity(c.rows, throwing).status, 'invalid_query');
});

test('source coordinate syntax rejects hexadecimal and nonfinite decimal input', async () => {
  const bytes = await readFile(resolve(fixtureDirectory, 'identity-edge.cif'), 'utf8');
  const original = 'ATOM 1 C CA . GLY A 1 1 ? 0.000 0.000 0.000';
  for (const [coordinate, reason] of [['0x10', /decimal coordinate syntax/], ['0b10', /decimal coordinate syntax/], ['1e400', /finite source coordinate/]]) {
    const changed = bytes.replace(original, `ATOM 1 C CA . GLY A 1 1 ? ${coordinate} 0.000 0.000`);
    assert.notEqual(changed, bytes);
    await assert.rejects(extractBytes(changed, { assemblyId: '1' }), reason);
  }
});

test('signed decimal and exponent coordinates agree with the pinned Mol* reader', async () => {
  const { createRequire } = require('node:module');
  const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
  const { CIF } = fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js');
  const { trajectoryFromMmCIF } = fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
  const bytes = await readFile(resolve(fixtureDirectory, 'identity-edge.cif'), 'utf8');
  const changed = bytes.replace('ATOM 1 C CA . GLY A 1 1 ? 0.000 0.000 0.000', 'ATOM 1 C CA . GLY A 1 1 ? +1.25E+1 -.5 0e0');
  assert.notEqual(changed, bytes);
  const parsed = await CIF.parse(changed).run();
  assert.equal(parsed.isError, false);
  const frame = parsed.result.blocks[0];
  const trajectory = await trajectoryFromMmCIF(frame).run();
  const molstarPoint = ['x', 'y', 'z'].map(axis => trajectory.representative.atomicConformation[axis][0]);
  assert.deepEqual(molstarPoint, [12.5, -0.5, 0]);
  assert.deepEqual(['Cartn_x', 'Cartn_y', 'Cartn_z'].map(name => frame.categories.atom_site.getField(name).float(0)), molstarPoint);
  const catalog = await extractBytes(changed, { assemblyId: '1' });
  const result = resolveIdentity(catalog.rows, labelQuery(catalog, 'A', 1, { atom: { name: 'CA' } }));
  assert.deepEqual(result.atom.sourceCoordinatesAngstrom, molstarPoint);
  assert.deepEqual(result.positionAngstrom, molstarPoint);
});
