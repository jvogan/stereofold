import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSelectionAdapter } from './selection.mjs';
import * as selectionModule from './selection.mjs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import extraction from '../identity/extract.cjs';
import identity from '../identity/identity.cjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { CIF } = require('molstar/lib/commonjs/mol-io/reader/cif.js');
const { trajectoryFromMmCIF } = require('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
const { Structure } = require('molstar/lib/commonjs/mol-model/structure/structure/structure.js');
const { StructureSymmetry } = require('molstar/lib/commonjs/mol-model/structure/structure/symmetry.js');
const { StructureElement } = require('molstar/lib/commonjs/mol-model/structure/structure/element.js');
const { Bond } = require('molstar/lib/commonjs/mol-model/structure/structure/unit/bonds.js');
const { OrderedSet } = require('molstar/lib/commonjs/mol-data/int.js');
const { extractBytes } = extraction;
const { atomKey, residueKey, copyKey } = identity;
const fixtures = {};

async function prepare(name, assemblyId = '1') {
  const bytes = await readFile(new URL(`../../fixtures/${name}.cif`, import.meta.url));
  const parsed = await CIF.parse(bytes.toString('utf8')).run();
  assert.equal(parsed.isError, false);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const models = [], structures = [];
  for (let i = 0; i < trajectory.frameCount; i++) {
    const frame = trajectory.getFrameAtIndex(i);
    const model = typeof frame.run === 'function' ? await frame.run() : frame;
    models.push(model);
    const base = Structure.ofModel(model);
    structures.push(assemblyId === 'asymmetric_unit' ? base : await StructureSymmetry.buildAssembly(base, assemblyId).run());
  }
  const catalog = await extractBytes(bytes, { sourceLabel: name, assemblyId });
  return { bytes, catalog, models, structures, adapters: structures.map(s => createSelectionAdapter(s, catalog)) };
}

before(async () => {
  for (const name of ['1CRN', 'identity-edge', 'voice-ligand', 'voice-ambiguity']) fixtures[name] = await prepare(name);
  fixtures.asymmetric = await prepare('identity-edge', 'asymmetric_unit');
});

function row(adapter, chain, position, operator = '1') {
  const matches = adapter.rows.filter(r => r.identity.labelChain === chain && r.identity.labelSequenceId === position
    && r.identity.operatorIds.join(',') === operator);
  assert.equal(matches.length, 1, 'The test target must identify one canonical residue.');
  return matches[0];
}

function picked(structure, unit, ...indices) {
  return StructureElement.Loci(structure, [{ unit, indices: OrderedSet.ofSortedArray(Int32Array.from(indices)) }]);
}

test('public 1CRN exposes 46 residues and all 327 atom sites through real Mol* Loci', () => {
  const { adapters: [a], structures: [s] } = fixtures['1CRN'];
  assert.equal(a.rows.length, 46);
  const loci = a.toLoci(a.rows.map(r => r.key));
  assert(StructureElement.Loci.is(loci));
  assert.equal(loci.structure, s);
  assert.equal(StructureElement.Loci.size(loci), 327);
  assert.deepEqual(a.fromLoci(loci), a.rows.map(r => r.key));
  assert.equal(a.rows[0].identity.componentId, 'THR');
  assert.equal(a.rows[45].identity.componentId, 'ASN');
});

test('each model exposes only its 16 sequence/copy rows, including six missing positions', () => {
  const { adapters } = fixtures['identity-edge'];
  for (let i = 0; i < adapters.length; i++) {
    const a = adapters[i];
    assert.equal(a.rows.length, 16);
    assert(a.rows.every(r => r.identity.modelNumber === i + 1));
    assert.equal(a.rows.filter(r => r.coordinateState === 'unresolved').length, 6);
    assert.equal(StructureElement.Loci.size(a.toLoci(a.rows.map(r => r.key))), 12);
    assert.equal(new Set(a.rows.map(r => r.identity.copyId)).size, 2);
  }
});

test('canonical keys distinguish author 15 from insertion 15A and retain both alternate sites', () => {
  const a = fixtures['identity-edge'].adapters[0];
  const plain = row(a, 'A', 1), inserted = row(a, 'A', 2);
  assert.equal(plain.identity.authorResidue, 15);
  assert.equal(inserted.identity.authorResidue, 15);
  assert.equal(plain.identity.insertionCode, '');
  assert.equal(inserted.identity.insertionCode, 'A');
  assert.equal(inserted.identity.authorChain, 'X');
  const loci = a.toLoci([inserted.key]);
  assert.equal(StructureElement.Loci.size(loci), 2);
  const unit = loci.elements[0].unit;
  const rawIndices = OrderedSet.toArray(loci.elements[0].indices).map(i => unit.elements[i]);
  assert.deepEqual(rawIndices.map(i => unit.model.atomicHierarchy.atoms.label_alt_id.value(i)), ['A', 'B']);
  for (const index of OrderedSet.toArray(loci.elements[0].indices)) {
    assert.deepEqual(a.fromLoci(picked(loci.structure, unit, index)), [inserted.key]);
  }
  assert.deepEqual(a.fromLoci(a.toLoci([inserted.key, plain.key])), [plain.key, inserted.key]);
});

test('unit-local indices identify chain B atoms and transformed copies independently', () => {
  const { adapters: [a], structures: [s] } = fixtures['identity-edge'];
  for (const operator of ['1', '2']) {
    const r = row(a, 'B', 1, operator);
    const loci = a.toLoci([r.key]);
    const element = loci.elements[0];
    assert.deepEqual(OrderedSet.toArray(element.indices), [0]);
    assert.equal(element.unit.elements[0], 4);
    assert.equal(element.unit.conformation.operator.assembly.operList[0], operator);
    assert.deepEqual(a.fromLoci(picked(s, element.unit, 0)), [r.key]);
    assert.deepEqual(r.atomSites[0].assemblyCoordinatesAngstrom, operator === '1' ? [10, 0, 0] : [20, 10, 0]);
  }
  const both = [row(a, 'B', 1, '1').key, row(a, 'B', 1, '2').key];
  assert.deepEqual(a.fromLoci(a.toLoci(both)), both);
});

test('model 2 follows conformation atom ids despite shared hierarchy source indices', () => {
  const { adapters: [a, b], models } = fixtures['identity-edge'];
  assert.equal(models[1].atomicHierarchy.atomSourceIndex.value(0), 0);
  assert.equal(models[1].atomicConformation.atomId.value(0), 7);
  const first = row(a, 'A', 1), second = row(b, 'A', 1);
  assert.equal(first.atomSites[0].identity.sourceAtomId, '1');
  assert.equal(second.atomSites[0].identity.sourceAtomId, '7');
  assert.deepEqual(second.atomSites[0].sourceCoordinatesAngstrom, [0, 0, 2]);
  assert.deepEqual(b.fromLoci(b.toLoci([second.key])), [second.key]);
  assert.throws(() => a.toLoci([second.key]), /outside this structure/u);
});

test('missing positions retain sequence identity and never acquire atom indices', () => {
  const a = fixtures['identity-edge'].adapters[0];
  const missing = row(a, 'A', 3), present = row(a, 'A', 1);
  assert.equal(missing.identity.authorResidue, 16);
  assert.equal(missing.atomSites.length, 0);
  const description = a.describe([missing.key])[0];
  assert.equal(description.coordinateState, 'unresolved');
  assert.equal(description.atomSiteCount, 0);
  assert.equal(description.representedAtomSiteCount, 0);
  assert(StructureElement.Loci.isEmpty(a.toLoci([missing.key])));
  assert.deepEqual(a.fromLoci(a.toLoci([missing.key, present.key])), [present.key]);
});

test('nonpolymer atoms preserve null sequence numbering while mapping all ligand sites', () => {
  const { adapters: [a], models: [model] } = fixtures['voice-ligand'];
  const ligand = a.rows.find(r => r.identity.componentId === 'LIG1');
  assert(ligand);
  assert.equal(ligand.identity.labelChain, 'L');
  assert.equal(ligand.identity.authorResidue, 501);
  assert.equal(ligand.identity.labelSequenceId, null);
  assert.equal(model.atomicHierarchy.residues.label_seq_id.value(4), 0);
  const loci = a.toLoci([ligand.key]);
  assert.equal(StructureElement.Loci.size(loci), 3);
  assert.deepEqual(a.fromLoci(loci), [ligand.key]);
});

test('author-chain and author-versus-label ambiguities remain separate canonical residues', () => {
  const a = fixtures['voice-ambiguity'].adapters[0];
  const first = row(a, 'X', 1), fifteenth = row(a, 'X', 15), other = row(a, 'Y', 1);
  assert.equal(first.identity.authorChain, 'A');
  assert.equal(other.identity.authorChain, '8');
  assert.equal(first.identity.authorResidue, 15);
  assert.equal(fifteenth.identity.authorResidue, 50);
  assert.deepEqual(a.fromLoci(a.toLoci([first.key, fifteenth.key, other.key])), [first.key, fifteenth.key, other.key]);
});

test('both endpoints of a bond pick return their residue identities', () => {
  const { adapters: [a], structures: [s] } = fixtures['identity-edge'];
  const unit = s.units[0];
  const bond = Bond.Location(s, unit, 0, s, unit, 1);
  const loci = Bond.Loci(s, [bond]);
  assert.deepEqual(a.fromLoci(loci), [row(a, 'A', 1).key, row(a, 'A', 2).key]);
});

test('a component subset maps its unit-local indices back to the parent structure', () => {
  const { adapters: [a], structures: [s] } = fixtures['identity-edge'];
  const target = row(a, 'A', 4);
  const subset = Structure.create([s.units[0].getChild(Int32Array.of(3))], { parent: s });
  assert.equal(subset.units[0].elements.length, 1);
  assert.equal(subset.units[0].elements[0], 3);
  assert.equal(subset.root, s.root);
  assert.deepEqual(a.fromLoci(picked(subset, subset.units[0], 0)), [target.key]);
  const subsetAdapter = createSelectionAdapter(subset, fixtures['identity-edge'].catalog);
  assert.deepEqual(subsetAdapter.rows.filter(r => r.coordinateState === 'resolved').map(r => r.key), [target.key]);
  assert.equal(subsetAdapter.rows.filter(r => r.coordinateState === 'unresolved').length, 1);
  assert.throws(() => subsetAdapter.toLoci([row(a, 'A', 1).key]), /outside this structure/u);
});

test('asymmetric-unit and assembly selections cannot be exchanged', () => {
  const asymmetric = fixtures.asymmetric.adapters[0];
  const assembly = fixtures['identity-edge'].adapters[0];
  assert.equal(asymmetric.rows.length, 8);
  assert.equal(StructureElement.Loci.size(asymmetric.toLoci(asymmetric.rows.map(r => r.key))), 6);
  assert.throws(() => asymmetric.toLoci([assembly.rows[0].key]), /outside this structure/u);
  assert.throws(() => createSelectionAdapter(fixtures.asymmetric.structures[0], fixtures['identity-edge'].catalog), /assembly copy/u);
});

test('foreign roots, forged units and malformed picks cannot resolve against local unit ids', () => {
  const { adapters: [a, b], structures: [s, other] } = fixtures['identity-edge'];
  assert.throws(() => a.fromLoci(b.toLoci([b.rows[0].key])), /different structure root/u);
  assert.throws(() => a.fromLoci(picked(s, other.units[0], 0)), /foreign or unsupported/u);
  for (const indices of [[-1], [1, 0], [0, 0], [0.5], new Array(1), [NaN], [999]]) {
    assert.throws(() => a.fromLoci(StructureElement.Loci(s, [{ unit: s.units[0], indices }])));
  }
  assert.deepEqual(a.fromLoci({ kind: 'empty-loci' }), []);
  assert.throws(() => a.fromLoci({ kind: 'every-loci' }), /not an atom or bond/u);
});

test('keys reject missing, wrong-source and malformed values and snapshot a getter once', () => {
  const a = fixtures['1CRN'].adapters[0];
  const key = a.rows[0].key;
  for (const input of [null, key, [null], new Array(1), ['unknown'], [fixtures['voice-ligand'].adapters[0].rows[0].key], [() => key]]) {
    assert.throws(() => a.toLoci(input));
    assert.throws(() => a.describe(input));
  }
  let reads = 0;
  const changing = [key];
  Object.defineProperty(changing, 0, { enumerable: true, get: () => ++reads === 1 ? key : 'unknown' });
  assert.deepEqual(a.fromLoci(a.toLoci(changing)), [key]);
  assert.equal(reads, 1);
  assert.equal(StructureElement.Loci.size(a.toLoci([key, key])), a.rows[0].atomSites.length);
});

test('a copied catalog cannot change the adapter after creation', () => {
  const { catalog, structures: [s] } = fixtures['1CRN'];
  const copy = structuredClone(catalog);
  const a = createSelectionAdapter(s, copy);
  const original = a.rows[0].identity.authorResidue;
  copy.rows[0].identity.authorResidue = 99;
  copy.rows[0].atomSites.length = 0;
  assert.equal(a.rows[0].identity.authorResidue, original);
  assert.equal(StructureElement.Loci.size(a.toLoci([a.rows[0].key])), 7);
  assert(Object.isFrozen(a.rows[0].identity));
});

test('inconsistent catalogs reject changed atom identity, source coordinates and assembly coordinates', () => {
  const { catalog, structures: [s] } = fixtures['identity-edge'];
  for (const mutate of [
    c => { c.rows[0].atomSites[0].sourceCoordinatesAngstrom[0] += 1; },
    c => { c.rows[0].atomSites[0].assemblyCoordinatesAngstrom[0] += 1; },
    c => { const r = c.rows[0]; r.identity.authorResidue = 999; r.key = residueKey(r.identity);
      for (const atom of r.atomSites) { atom.identity.authorResidue = 999; atom.key = atomKey(atom.identity); } },
    c => { c.copies[0].matrix = new Array(16); },
    c => { c.rows.push(c.rows[0]); },
  ]) {
    const copy = structuredClone(catalog);
    mutate(copy);
    assert.throws(() => createSelectionAdapter(s, copy));
  }
});

test('identical operator and chain candidates from two generators require an explicit mapping rule', () => {
  const { catalog, structures: [s] } = fixtures['identity-edge'];
  const copy = structuredClone(catalog);
  const duplicate = structuredClone(copy.copies[0]);
  duplicate.generatorIndex = 999;
  duplicate.copyId = copyKey(duplicate);
  copy.copies.push(duplicate);
  assert.throws(() => createSelectionAdapter(s, copy), /unambiguous catalog assembly copy/u);
});

// Assert the dependency pin used for all parser/Loci checks, without a browser.
test('the scientific adapter checks run against installed Mol* 5.11.0', () => {
  assert.equal(require('molstar/package.json').version, '5.11.0');
  assert(fileURLToPath(new URL('./selection.mjs', import.meta.url)).endsWith('/lab/browser-roundtrip/selection.mjs'));
});


test('atom_site-only exports bind observed residue loci without declared entity or sequence tables', async () => {
  const original = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
  const loop = original.match(/loop_\s*\n(?:_atom_site\.[^\n]+\n)+[\s\S]*?(?=\n#)/)?.[0];
  assert(loop);
  const lines = loop.split('\n'), firstAtom = lines.findIndex(line => /^(ATOM|HETATM)\s/.test(line));
  const text = ['data_observed_only', '#', ...lines.slice(0, firstAtom + 14), '#', ''].join('\n');
  const parsed = await CIF.parse(text).run(); assert.equal(parsed.isError, false);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const model = trajectory.representative, structure = Structure.ofModel(model);
  const catalog = await extractBytes(text, { assemblyId: 'asymmetric_unit' });
  const adapter = createSelectionAdapter(structure, catalog);
  assert.equal(adapter.rows.length, 2);
  assert(adapter.rows.every(row => !row.sequenceDeclared && row.coordinateState === 'resolved'));
  const keys = adapter.rows.map(row => row.key), loci = adapter.toLoci(keys);
  assert.equal(StructureElement.Loci.size(loci), 14);
  assert.deepEqual(adapter.fromLoci(loci), keys);
  const mapping = adapter.sourceAtomIdToSelectionKey(['1', '8']);
  assert.deepEqual(mapping, { '1': keys[0], '8': keys[1] });
});

test('cached selections validate edited keys and stay scoped to the represented structure', () => {
  const { adapters: [adapter], structures: [structure], catalog } = fixtures['1CRN'];
  const keys = adapter.rows.slice(0, 3).map(row => row.key);
  const first = adapter.toLoci(keys);
  assert.equal(adapter.toLoci([...keys].reverse().concat(keys)), first);
  assert.deepEqual(first, createSelectionAdapter(structure, catalog).toLoci(keys));
  keys.pop();
  const edited = adapter.toLoci(keys);
  assert.notEqual(edited, first);
  assert.deepEqual(edited, createSelectionAdapter(structure, catalog).toLoci(keys));
  keys[0] = 'unknown';
  assert.throws(() => adapter.toLoci(keys), /unknown/);
  const { adapters } = fixtures['identity-edge'];
  const a = adapters[0].toLoci(adapters[0].rows.map(row => row.key));
  const b = adapters[1].toLoci(adapters[1].rows.map(row => row.key));
  assert.notEqual(a.structure, b.structure);
  assert.throws(() => adapters[1].toLoci(adapters[0].rows.map(row => row.key)), /unknown/);
});

test('source binding resolves each unit/chain operator once, without caching across loads', () => {
  const { structures: [structure], catalog } = fixtures['1CRN'];
  let reads = 0;
  const units = structure.units.map(unit => {
    const conformation = Object.create(unit.conformation);
    Object.defineProperty(conformation, 'operator', { get() { reads++; return unit.conformation.operator; } });
    return Object.assign(Object.create(unit), { conformation });
  });
  const instrumented = Object.assign(Object.create(structure), { units });
  const chains = units.reduce((n, unit) => n + new Set(Array.from(unit.elements,
    element => unit.model.atomicHierarchy.chains.label_asym_id.value(unit.model.atomicHierarchy.chainAtomSegments.index[element]))).size, 0);
  const first = createSelectionAdapter(instrumented, catalog);
  assert.deepEqual(first.rows, fixtures['1CRN'].adapters[0].rows);
  assert.equal(reads, chains, 'operator validation is shared only within this immutable unit/chain');
  createSelectionAdapter(instrumented, catalog);
  assert.equal(reads, 2 * chains, 'a new binding checks its operators again');
});


test('a load snapshots the catalog once and keeps source and selection isolated from caller edits', async () => {
  const { structures: [structure], catalog, bytes } = fixtures['1CRN'];
  const viewer = await readFile(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const begin = viewer.indexOf('async function checkedFixture(');
  const end = viewer.indexOf('\n}\n', begin) + 2;
  const clone = globalThis.structuredClone;
  let catalogCopies = 0;
  globalThis.structuredClone = value => {
    if (value?.rows || value?.catalog?.rows) catalogCopies++;
    return clone(value);
  };
  try {
    const context = vm.createContext({
      detached: value => globalThis.structuredClone(value),
      snapshotSelectionCatalog: selectionModule.snapshotSelectionCatalog,
      isVolumeFixture: () => false, failure: (_code, message) => Error(message),
      TextEncoder, crypto: webcrypto, representationName() {},
      normalizeExperienceVisibility: value => value,
    });
    vm.runInContext(viewer.slice(begin, end), context);
    const input = clone(catalog);
    const pending = context.checkedFixture({ id: 'test', cif: bytes.toString(), sha256: input.source.sha256, catalog: input },
      { modelNumber: 1, assemblyId: '1', representation: 'cartoon' });
    input.rows[0].atomSites.length = 0;
    const { source } = await pending;
    const adapter = createSelectionAdapter(structure, source.catalog);
    assert.deepEqual(adapter.rows, fixtures['1CRN'].adapters[0].rows);
    assert.equal(catalogCopies, 1, 'source verification and selection share one private catalog snapshot');
    assert.throws(() => { source.catalog.rows[0].atomSites.length = 0; }, TypeError);
    const forged = clone(source.catalog);
    forged.rows[0].atomSites[0].assemblyCoordinatesAngstrom[0] += 10;
    assert.throws(() => createSelectionAdapter(structure, forged), /coordinates/);
  } finally { globalThis.structuredClone = clone; }
});


test('cooperative source binding keeps exact Loci and services frame work between identity checks', async () => {
  for (const name of ['1CRN', 'identity-edge', 'asymmetric', 'voice-ligand']) {
    const { structures, catalog } = fixtures[name];
    for (const structure of structures) {
      const sync = createSelectionAdapter(structure, catalog);
      let turns = 0;
      const asyncAdapter = await selectionModule.createSelectionAdapterAsync(structure, catalog, {
        budgetMs: 0, yieldTask: () => new Promise(resolve => setTimeout(() => { turns++; resolve(); }, 0)),
      });
      if (structure.elementCount > 64) assert.ok(turns > 0, 'XR work gets event-loop turns before binding completes');
      assert.deepEqual(asyncAdapter.rows, sync.rows);
      const keys = sync.rows.filter(row => row.atomSites.length).map(row => row.key);
      const loci = asyncAdapter.toLoci(keys);
      assert.deepEqual(asyncAdapter.fromLoci(loci), sync.fromLoci(sync.toLoci(keys)));
      assert.equal(StructureElement.Loci.size(loci), StructureElement.Loci.size(sync.toLoci(keys)));
      assert.deepEqual(asyncAdapter.sourceAtomIdToSelectionKey(), sync.sourceAtomIdToSelectionKey());
    }
  }
});

test('cooperative binding rejects corrupted identity and cancellation without publishing an adapter', async () => {
  const { structures: [structure], catalog } = fixtures['1CRN'];
  const corrupt = structuredClone(catalog);
  corrupt.rows.at(-1).atomSites[0].assemblyCoordinatesAngstrom[0] += 1;
  await assert.rejects(selectionModule.createSelectionAdapterAsync(structure, corrupt, { budgetMs: 0, yieldTask: async () => {} }),
    /assembly coordinates/);
  let cancelled = false, turns = 0;
  await assert.rejects(selectionModule.createSelectionAdapterAsync(structure, catalog, {
    budgetMs: 0, yieldTask: async () => { turns++; cancelled = true; },
    check() { if (cancelled) throw Error('source replaced'); },
  }), /source replaced/);
  assert.equal(turns, 1);
  const rebound = await selectionModule.createSelectionAdapterAsync(structure, catalog);
  assert.equal(rebound.rows.length, fixtures['1CRN'].adapters[0].rows.length);
});
