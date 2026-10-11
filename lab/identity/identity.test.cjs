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
