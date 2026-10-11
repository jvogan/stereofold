import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { DEMO_DERIVED_SOURCES, demoSourceIdentity } from './demo-source-identity.mjs';
import { createStructureSubjectReader, structureReadout } from './structure-subject.mjs';

const demos = new URL('../../plugin/demos/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', demos), 'utf8'));
const entries = index.demos.flatMap(demo => [demo, ...(demo.stages ?? [])]);
const wall = entries.find(entry => entry.coordinates.file === '5SYF-lattice-op2-7.cif');

test('every derived display record matches the shipped coordinate index and checked lesson digest', () => {
  const checked = new Set();
  for (const entry of entries) {
    const coordinates = entry.coordinates, identity = demoSourceIdentity(coordinates.sha256);
    if (!coordinates.derivation) { assert.equal(identity, undefined, `${entry.lesson} is not a derived subset`); continue; }
    assert.ok(identity, `${entry.lesson} has explicit derived-source metadata`);
    assert.equal(identity.pdbId, entry.pdbId);
    const { kind, ...derivation } = coordinates.derivation;
    assert.equal(identity.kind, kind);
    for (const [key, value] of Object.entries(derivation)) assert.deepEqual(identity[key], value);
    if (kind === 'assembly-operator-subset') {
      assert.equal(coordinates.download, `https://files.rcsb.org/download/${identity.pdbId}-assembly${identity.assemblyId}.cif`);
      assert.equal(identity.scope, `assembly ${identity.assemblyId} subset`);
    } else assert.equal(identity.scope, 'deposited chain subset');
    const lesson = JSON.parse(readFileSync(new URL(entry.lesson, demos), 'utf8'));
    assert.equal(lesson.provenance.sourceSha256, coordinates.sha256);
    checked.add(coordinates.sha256);
  }
  assert.deepEqual([...checked].sort(), Object.keys(DEMO_DERIVED_SOURCES).sort());
});

const subjectFor = (sha256, entryId = 'XXXX') => {
  const rows = ['2', '3', '4', '5', '6', '7'].flatMap(operator => ['A', 'B'].map(chain => ({
    coordinateState: 'resolved', entityType: 'polymer',
    identity: { modelNumber: 1, copyId: 'asu', labelChain: `${chain}-${operator}` },
  })));
  const source = { sha256, code: 'mmCIF', catalog: { assemblyId: 'asymmetric_unit', rows } };
  const before = structuredClone(source);
  const subject = createStructureSubjectReader()(source, { entryId }, { ready: true, modelNumber: 1, selectionKeys: [] });
  assert.deepEqual(source, before, 'display correction leaves scientific source and chain IDs unchanged');
  return subject;
};

test('the real 5SYF wall digest overrides XXXX with derived provenance without claiming a full assembly', () => {
  const subject = subjectFor(wall.coordinates.sha256);
  assert.equal(subject.pdbId, '5SYF');
  assert.equal(subject.title, 'Microtubule wall');
  assert.equal(subject.chains, 12);
  assert.equal(subject.assembly, 'asymmetric_unit', 'runtime assembly state is unchanged');
  assert.equal(structureReadout(subject)[1].text, '5SYF · 12 chains · assembly 1 subset');
  assert.equal(subject.displayProvenance.operators.length, 6);
  assert.equal(subject.displayProvenance.ofOperators, 26);
});

test('unverified generic XXXX bytes receive no guessed PDB identity or asymmetric-unit claim', () => {
  const subject = subjectFor('0'.repeat(64));
  assert.equal(subject.pdbId, undefined);
  assert.equal(subject.displayProvenance, undefined);
  assert.equal(structureReadout(subject)[1].text, '12 chains · local coordinates');
  assert.equal(demoSourceIdentity('constructor'), undefined);
});

test('a raw public entry retains its source identity and ordinary assembly display', () => {
  const raw = entries.find(entry => entry.coordinates.file === '5SYF.cif');
  const subject = subjectFor(raw.coordinates.sha256, '5SYF');
  assert.equal(subject.pdbId, '5SYF');
  assert.equal(subject.displayProvenance, undefined);
  assert.equal(structureReadout(subject)[1].text, '5SYF · 12 chains · asymmetric unit');
});

test('desktop load displays the same verified title, ID and subset without changing its source', async () => {
  const code = readFileSync(new URL('../inspection/workspace.mjs', import.meta.url), 'utf8');
  const start = code.indexOf('async function loadSource('), end = code.indexOf('\nasync function dispose()', start);
  for (const verified of [true, false]) {
    const elements = new Map();
    const $ = selector => {
      if (!elements.has(selector)) elements.set(selector, { textContent: '', children: [],
        replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } });
      return elements.get(selector);
    };
    const source = { id: 'session', sha256: verified ? wall.coordinates.sha256 : '0'.repeat(64),
      title: 'Deposited title ', code: 'XXXX', caption: 'Lesson', catalog: { modelNumbers: [1], assemblyId: 'asymmetric_unit' } };
    const original = structuredClone(source), loaded = [];
    const context = vm.createContext({ $, demoSourceIdentity, options: { enableXr: false },
      document: { createTextNode: text => ({ textContent: text }), createElement: () => ({}), body: { dataset: {} } },
      viewer: { snapshot: () => ({}), load: async value => { loaded.push(value); return true; }, inspection: { capture: () => ({}) } },
      run: async (_message, operation) => operation(), currentRows: () => [], renderSequence() {},
      fixture: null, searchValue: '', chainValue: '', anchor: null, loadedView: null, walkthrough: null,
    });
    vm.runInContext(code.slice(start, end), context);
    await context.loadSource(source);
    assert.equal($('.scene-heading h1').children[0].textContent, verified ? 'Microtubule wall ' : 'Deposited title ');
    assert.equal($('.scene-heading h1').children[1].textContent, verified ? '5SYF' : '');
    assert.equal($('.canvas-caption > span').textContent, verified ? 'Lesson · assembly 1 subset' : 'Lesson');
    assert.equal(loaded[0], source);
    assert.deepEqual(source, original);
  }
});
