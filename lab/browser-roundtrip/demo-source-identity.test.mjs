import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createToolbarPanel } from './spatial-toolbar-geometry.mjs';
import { DEMO_DERIVED_SOURCES, demoSourceIdentity } from './demo-source-identity.mjs';
import { compositeEntryLine, countedNames, createStructureSubjectReader, structureReadout } from './structure-subject.mjs';

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
    } else if (kind === 'prepared-rigid-composite') {
      assert.equal(identity.scope, 'prepared rigid composite');
      const recipe = JSON.parse(readFileSync(new URL(identity.recipe, demos), 'utf8'));
      assert.ok(recipe.sources.some(source => source.id === identity.pdbId));
      assert.deepEqual(identity.entries, recipe.sources.filter(source => !source.file).map(source => source.id));
      assert.deepEqual(identity.sources, recipe.sources.map(source => source.file
        ? { kind: 'modelled', id: source.id, file: source.file, note: source.modelled, ...(source.label ? { label: source.label } : {}) }
        : { kind: 'deposited', id: source.id, url: source.url }));
    } else if (kind === 'bundled-file') {
      assert.equal(identity.pdbId, undefined);
      assert.equal(identity.sourceId, entry.sourceId);
      assert.deepEqual(identity.sources, entry.sources);
      assert.equal(identity.scope, 'bundled coordinates');
    } else {
      assert.equal(kind, 'deposited-chain-subset');
      assert.equal(identity.scope, 'deposited chain subset');
    }
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

test('the bundled gallery names its dataset and does not infer a PDB identity from model IDs', () => {
  const gallery = entries.find(entry => entry.coordinates.derivation?.kind === 'bundled-file');
  assert.ok(gallery);
  const subject = { ...subjectFor(gallery.coordinates.sha256, '1ABC'), hiddenChains: ['B02', 'T02'] };
  assert.equal(subject.pdbId, undefined);
  assert.equal(subject.displayProvenance.sourceId, gallery.sourceId);
  const readout = structureReadout(subject).map(line => line.text).join(' | ');
  assert.ok(readout.includes(gallery.sourceId));
  assert.ok(readout.includes('bundled coordinates'));
  assert.ok(!readout.includes('B02'));
  assert.ok(!readout.includes('1ABC'));
  assert.ok(!readout.includes('asymmetric unit'));
});

test('a prepared composite names its deposited entries and never its generated copy chains', () => {
  const sha256 = entries.find(entry => entry.coordinates.derivation?.recipe === 'hemoglobin-switch/motion-recipe.json').coordinates.sha256;
  assert.deepEqual(demoSourceIdentity(sha256).entries, ['2DN2', '2DN1']);
  const subject = { ...subjectFor(sha256), hiddenChains: ['A1_1', 'K1T_2'] };
  const readout = structureReadout(subject).map(line => line.text).join(' | ');
  assert.equal(structureReadout(subject)[1].text, '2 PDB entries: 2DN2 2DN1');
  assert.doesNotMatch(readout, /A1_1|K1T_2|hidden/u);
  const single = structureReadout(subjectFor(entries.find(entry => entry.coordinates.derivation?.recipe === 'atp-synthase-rotor/motion-recipe.json').coordinates.sha256))[1].text;
  assert.equal(single, '6N2Y · prepared from one entry');
  const kinesin = demoSourceIdentity(entries.find(entry => entry.coordinates.derivation?.recipe === 'kinesin-walk/flipbook-recipe.json').coordinates.sha256);
  assert.equal(compositeEntryLine(kinesin.entries), '5 PDB entries: 5SYF 9L7M 8RHB 1BG2 3KIN');
  const many = Array.from({ length: 12 }, (_, i) => `${i % 9 + 1}A${i < 9 ? 'B' : 'C'}${i % 10}`);
  const clipped = compositeEntryLine(many);
  const shown = clipped.match(/\b[0-9][A-Z0-9]{3}\b/gu);
  assert.ok(shown.length > 0 && shown.length < 12, clipped);
  assert.ok(shown.every((id, i) => id === many[i]), 'shown IDs are whole and in order');
  assert.match(clipped, new RegExp(` \\+${12 - shown.length} more$`, 'u'));
});

test('a repeated focus name is shown once with its count, in first-seen order', () => {
  assert.deepEqual(countedNames(['Alpha tubulin', 'Beta tubulin', 'Alpha tubulin', 'Beta tubulin']),
    ['Alpha tubulin ×2', 'Beta tubulin ×2']);
  assert.deepEqual(countedNames(['ATP analogue']), ['ATP analogue']);
  const subject = { ...subjectFor(wall.coordinates.sha256), focus: ['Alpha tubulin', 'Beta tubulin', 'Alpha tubulin', 'Beta tubulin'] };
  assert.ok(structureReadout(subject).some(line => line.text === 'focus: Alpha tubulin ×2, Beta tubulin ×2'));
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

test('flat companion metadata identifies the drawn map and preserves atomic reference labels', async () => {
  const code = readFileSync(new URL('../inspection/workspace.mjs', import.meta.url), 'utf8');
  const start = code.indexOf('async function loadSource('), end = code.indexOf('\nasync function dispose()', start);
  for (const kind of ['map', 'atomic', 'reference']) {
    const elements = new Map();
    const $ = selector => {
      if (!elements.has(selector)) elements.set(selector, { textContent: '', children: [],
        replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } });
      return elements.get(selector);
    };
    const source = { id: 'session', sha256: '0'.repeat(64), title: 'The cryo-EM tube overhead ', code: 'mmCIF',
      caption: kind === 'reference' ? 'REFERENCE COORDINATES' : 'The cryo-EM tube overhead',
      catalog: { modelNumbers: [1], assemblyId: 'asymmetric_unit' } };
    const original = structuredClone(source), loaded = [];
    const context = vm.createContext({ $, demoSourceIdentity, options: { enableXr: true },
      document: { createTextNode: text => ({ textContent: text }), createElement: () => ({}), body: { dataset: {} } },
      viewer: { snapshot: () => ({}), load: async value => { loaded.push(value); return true; },
        inspection: { capture: () => ({ assemblyId: kind === 'map' ? 'map' : 'asymmetric_unit' }) } },
      run: async (_message, operation) => operation(), currentRows: () => kind === 'map' ? []
        : [{ atomSites: [0, 1], identity: { copyId: '1', labelChain: 'A' } }], renderSequence() {},
      fixture: null, searchValue: '', chainValue: '', anchor: null, loadedView: null, walkthrough: null,
    });
    vm.runInContext(code.slice(start, end), context);
    await context.loadSource(source);
    assert.equal($('.scene-heading h1').children[1].textContent, kind === 'map' ? 'Density map' : 'mmCIF');
    assert.equal($('.canvas-caption > span').textContent,
      `${source.caption} · ${kind === 'map' ? 'ISOSURFACE' : '1 CHAIN'}`);
    assert.equal(loaded[0], source);
    assert.deepEqual(source, original, 'display metadata does not change the source identity or geometry input');
  }
});

test('modelled parts remain disclosed within the two-line identity budget', () => {
  const entries = ['5SYF', '9L7M', '8RHB', '3KIN'];
  const modelled = [{ kind: 'modelled', id: 'linker_model', label: 'linkers', note: 'Idealised connecting residues' }];
  const text = structureReadout({ title: 'Kinesin', displayProvenance: {
    kind: 'prepared-rigid-composite', entries, sources: modelled,
  } })[1].text;
  assert.match(text, /^4 PDB entries \+ modelled linkers:/u);
  assert.doesNotMatch(text, /linker_model/u);
  const shown = text.match(/\b[0-9][A-Z0-9]{3}\b/gu) ?? [];
  assert.match(text, new RegExp(` \\+${entries.length - shown.length} more$`, 'u'));
  for (const sources of [modelled, [{ kind: 'modelled', note: 'Very long modelling notes '.repeat(20) }]]) {
    const line = compositeEntryLine(entries, sources);
    let lines = 1, width = 0;
    for (const word of line.split(' ')) {
      assert.ok(word.length <= 26);
      if (width && width + 1 + word.length > 26) { lines++; width = word.length; }
      else width += (width ? 1 : 0) + word.length;
    }
    assert.ok(lines <= 2, line);
    assert.match(line, /modelled/u);
  }
  assert.equal(compositeEntryLine([], modelled), 'Local modelled linkers');
  assert.match(compositeEntryLine(['5SYF'], [{ note: 'stalk' }]), /1 PDB entries \+ modelled stalk/u);
});

test('rendered composite identity reserves its remainder count within the measured row budget', () => {
  const entries = ['1WWW', '2WWW', '3WWW', '4WWW', '5WWW', '6WWW', '7WWW', '8WWW', '9WWW', '1WWX', '2WWX', '3WWX'];
  const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url))).advances;
  const measureText = text => [...text].reduce((sum, glyph) => sum + (metrics[glyph] ?? .6), 0);
  for (const detailed of [false, true]) for (const count of [3, 9]) {
    const subject = { title: 'Composite', displayProvenance: { kind: 'prepared-rigid-composite', entries },
      ...(detailed ? { hiddenClasses: ['water'], focus: ['Motor'], contextOpacity: .3 } : {}) };
    const readout = structureReadout(subject).map((row, index) => ({ ...row, identity: index === 1 }));
    const panel = createToolbarPanel({ rows: Array.from({ length: count }, () => ({ label: 'Control' })),
      head: { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, readout, measureText });
    const rows = panel.readoutPoints.filter(row => row.identity);
    const text = rows.map(row => row.text).join(' '), shown = text.match(/\b[0-9][A-Z0-9]{3}\b/gu) ?? [];
    assert.ok(rows.length > 0 && rows.length <= 2);
    assert.deepEqual(shown, entries.slice(0, shown.length));
    assert.match(text, new RegExp(`\\+${entries.length - shown.length} more$`, 'u'), text);
    assert.doesNotMatch(text, /…/u);
  }
});

test('empty composite metadata never exposes generated chains and names the missing metadata', () => {
  for (const entries of [undefined, []]) {
    const rows = structureReadout({ title: 'Composite', pdbId: 'XXXX', chains: 8, hiddenChains: ['A1_1'],
      displayProvenance: { kind: 'prepared-rigid-composite', entries } });
    assert.equal(rows[1].text, 'Prepared composite · source metadata unavailable');
    assert.doesNotMatch(rows.map(row => row.text).join(' '), /A1_1|XXXX|8 chains/u);
  }
});
