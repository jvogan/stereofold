import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../../plugin/node_modules/typescript/lib/typescript.js';

// Exercise the production refresh, queue and sequence construction together.
// Setter counters measure unnecessary DOM mutations, not browser layout time.
const source = readFileSync(new URL('./workspace.mjs', import.meta.url), 'utf8');
const ast = ts.createSourceFile('workspace.mjs', source, ts.ScriptTarget.Latest, true);
function closure(name) {
  let found;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(found, `Missing production function ${name}`);
  return found.getText(ast);
}
const functions = ['currentRows', 'selectedRows', 'visibleRows', 'sceneHistory', 'syncSceneHistory',
  'sync', 'run', 'renderSequence'].map(closure).join('\n');

function element(dataset = {}) {
  let disabled = false;
  const attributes = new Map(), events = new Map();
  return { dataset, style: {}, children: [], selectedOptions: [{ textContent: 'Chain identity' }],
    attributeWrites: [], disabledWrites: [],
    get disabled() { return disabled; },
    set disabled(value) { this.disabledWrites.push(value); disabled = value; },
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute(name, value) { this.attributeWrites.push([name, value]); attributes.set(name, value); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, action) { events.set(name, action); },
    dispatch(name, event = {}) { return events.get(name)?.(event); },
    matches: () => ['enterXr', 'resumeXr', 'leaveXr'].some(key => key in dataset),
    resetWrites() { this.attributeWrites.length = 0; this.disabledWrites.length = 0; },
  };
}
const residue = (key, number, chain = 'A') => ({ key, coordinateState: 'resolved', atomSites: [number],
  identity: { modelNumber: 1, assemblyId: 'asymmetric_unit', labelChain: chain, authorChain: chain,
    authorResidue: number, insertionCode: '', componentId: 'ALA', labelSequenceId: number, operatorIds: ['1'] } });

function page() {
  const nodes = new Map();
  const $ = selector => {
    if (selector === '.sequence-items') return nodes.get('.sequence')?.children.find(child => child.className === 'sequence-items') ?? null;
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const sequence = $('.sequence'), ordinary = element();
  const exempt = [element({ workspace: 'sequence' }), element({ tab: 'view' }), element({ layout: 'sequence' }),
    element({ enterXr: '' }), element({ resumeXr: '' }), element({ leaveXr: '' })];
  const buttons = () => sequence.children.flatMap(child => child.dataset.key ? [child] : child.children.filter(node => node.dataset.key));
  const controls = () => [...buttons(), ordinary, ...exempt];
  const snapshot = { ready: true, status: 'ready', generation: 1, modelNumber: 1,
    assemblyId: 'asymmetric_unit', selectionKeys: [], inspection: {
      appearance: { color: 'chain-id', labels: false },
      placement: { scale: 1, translation: [0, 0, 0], rotation: [0, 0, 0] },
      history: { undoCount: 1, redoCount: 0 }, savedViews: [],
    } };
  const fixture = { catalog: { rows: [residue('a1', 1), residue('a2', 2), residue('b3', 3, 'B')] } };
  const viewer = { snapshot: () => snapshot, select: keys => { snapshot.selectionKeys = keys; },
    inspection: { hover: async () => {} } };
  const h = vm.createContext({ $, $$: selector => selector === '.sequence button' ? buttons()
    : selector === '#app button, #app input, #app select' ? controls() : [],
    viewer, fixture, options: {}, PLACEMENT_MIN_SCALE: .000001, PLACEMENT_MAX_SCALE: 100000,
    demoSourceIdentity: () => undefined, moleculeCanvas: element(),
    queue: Promise.resolve(), busy: false, closing: false, anchor: null, lastGeneration: 1,
    lastSavedSignature: '{"tab":[]}', searchValue: '', chainValue: 'all', sequenceSelectionJsonBytes: 2,
    hostDriven: () => false, syncSearchAction() {}, syncWalkthrough() {}, syncMotion() {}, syncRenderQuality() {},
    setStatus() {}, ui: (_message, action) => action(),
    label: row => `${row.identity.authorChain} · ${row.identity.componentId} ${row.identity.authorResidue}`,
    amino: { ALA: 'A' }, TextEncoder,
    document: { createElement: () => element() }, Option: function (text, value) { return { text, value }; },
  });
  vm.runInContext(functions, h);
  h.renderSequence();
  const resetWrites = () => controls().forEach(node => node.resetWrites());
  resetWrites();
  return { h, snapshot, fixture, buttons, sequence, items: () => $('.sequence-items'), ordinary, exempt, resetWrites };
}

test('unchanged workspace refreshes do not rewrite sequence selection or bulk disabled state', () => {
  const p = page();
  p.h.sync(); p.h.sync();
  for (const button of [...p.buttons(), p.ordinary]) {
    assert.deepEqual(button.attributeWrites, []);
    assert.deepEqual(button.disabledWrites, []);
  }
});

test('agent and manual selection refresh only changed residues and repair actual DOM state', () => {
  const p = page();
  p.snapshot.selectionKeys = ['a2']; p.h.sync();
  assert.deepEqual(p.buttons().map(button => button.attributeWrites.length), [0, 1, 0]);
  assert.deepEqual(p.buttons().map(button => button.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  p.resetWrites();
  p.buttons()[0].dispatch('click', { ctrlKey: true }); p.h.sync();
  assert.deepEqual(p.buttons().map(button => button.attributeWrites.length), [1, 0, 0]);
  p.resetWrites();
  p.buttons()[1].setAttribute('aria-pressed', 'false'); p.buttons()[1].resetWrites();
  p.h.sync();
  assert.deepEqual(p.buttons()[1].attributeWrites, [['aria-pressed', 'true']], 'Repair the DOM even when the model selection is unchanged');
  p.snapshot.selectionKeys = []; p.resetWrites(); p.h.sync();
  assert.deepEqual(p.buttons().map(button => button.attributeWrites.length), [1, 1, 0]);
});

for (const fail of [false, true]) test(`queued ${fail ? 'failed' : 'successful'} work disables controls and restores them without redundant writes`, async () => {
  const p = page();
  p.buttons()[0].disabled = true; p.resetWrites();
  p.exempt.forEach((control, index) => { control.disabled = index % 2 === 0; control.resetWrites(); });
  const action = p.h.run('Changed', async () => {
    assert.ok([...p.buttons(), p.ordinary].every(control => control.disabled));
    assert.equal(p.items().dataset.disabled, 'true');
    assert.deepEqual(p.buttons().map(button => button.disabledWrites.length), [0, 1, 1]);
    p.h.sync(); p.h.sync();
    assert.deepEqual(p.buttons().map(button => button.disabledWrites.length), [0, 1, 1]);
    if (fail) throw Error('Expected render failure');
  });
  if (fail) await assert.rejects(action, /Expected render failure/); else await action;
  assert.equal(p.h.busy, false);
  assert.equal(p.items().dataset.disabled, 'false');
  assert.ok([...p.buttons(), p.ordinary].every(control => !control.disabled));
  assert.deepEqual(p.buttons().map(button => button.disabledWrites), [[false], [true, false], [true, false]]);
  assert.deepEqual(p.exempt.map(control => control.disabled), [true, false, true, false, true, false]);
  assert.ok(p.exempt.every(control => control.disabledWrites.length === 0));
});

test('source-generation and search rebuilds create correctly selected buttons without stale selection caches', () => {
  const p = page(), previous = p.buttons();
  p.fixture.catalog.rows = [residue('c10', 10, 'C'), residue('c11', 11, 'C')];
  p.snapshot.generation++; p.snapshot.selectionKeys = ['c11']; p.h.sync();
  assert.deepEqual(p.buttons().map(button => button.dataset.key), ['c10', 'c11']);
  assert.ok(p.buttons().every(button => !previous.includes(button)));
  assert.deepEqual(p.buttons().map(button => button.getAttribute('aria-pressed')), ['false', 'true']);
  p.h.searchValue = '11'; p.h.renderSequence();
  assert.deepEqual(p.buttons().map(button => button.dataset.key), ['c11']);
  assert.equal(p.buttons()[0].getAttribute('aria-pressed'), 'true');
  p.resetWrites(); p.h.sync();
  assert.deepEqual(p.buttons()[0].attributeWrites, []);
  p.snapshot.selectionKeys = []; p.h.sync();
  assert.equal(p.buttons()[0].getAttribute('aria-pressed'), 'false');
  p.h.searchValue = ''; p.h.renderSequence();
  assert.deepEqual(p.buttons().map(button => button.getAttribute('aria-pressed')), ['false', 'false']);
});

test('a busy source/search rebuild is natively disabled and dims as one group until recovery', async () => {
  const p = page();
  await assert.rejects(p.h.run('Replacing source', async () => {
    p.fixture.catalog.rows = [residue('d20', 20, 'D'), residue('d21', 21, 'D')];
    p.snapshot.generation++; p.snapshot.selectionKeys = ['d21']; p.h.sync();
    assert.equal(p.items().dataset.disabled, 'true');
    assert.ok(p.buttons().every(button => button.disabled));
    p.h.searchValue = '21'; p.h.renderSequence();
    assert.deepEqual(p.buttons().map(button => button.dataset.key), ['d21']);
    assert.equal(p.buttons()[0].getAttribute('aria-pressed'), 'true');
    assert.equal(p.buttons()[0].disabled, true);
    assert.equal(p.items().dataset.disabled, 'true');
    assert.equal(p.h.sequenceSelectionJsonBytes, new TextEncoder().encode(JSON.stringify(['d21'])).byteLength);
    throw Error('Expected replacement failure');
  }), /Expected replacement failure/);
  assert.equal(p.items().dataset.disabled, 'false');
  assert.equal(p.buttons()[0].disabled, false);
  assert.equal(p.buttons()[0].getAttribute('aria-pressed'), 'true');
});

test('not-ready and closing state preserve native sequence disabling while enabled selection and range work', () => {
  const p = page();
  p.snapshot.ready = false; p.h.sync();
  assert.equal(p.items().dataset.disabled, 'true');
  assert.ok(p.buttons().every(button => button.disabled));
  p.h.renderSequence();
  assert.ok(p.buttons().every(button => button.disabled));
  p.snapshot.ready = true; p.h.sync();
  assert.equal(p.items().dataset.disabled, 'false');
  assert.ok(p.buttons().every(button => !button.disabled));
  p.buttons()[0].dispatch('click');
  p.buttons()[1].dispatch('click', { shiftKey: true }); p.h.sync();
  assert.deepEqual(p.buttons().map(button => button.getAttribute('aria-pressed')), ['true', 'true', 'false']);
  p.h.closing = true; p.h.sync();
  assert.equal(p.items().dataset.disabled, 'true');
  assert.ok(p.buttons().every(button => button.disabled));
});

test('empty search messages stay outside opacity grouping and companion still creates no buttons', () => {
  const p = page();
  p.h.busy = true; p.h.searchValue = 'no-match'; p.h.renderSequence();
  assert.equal(p.items(), null);
  assert.equal(p.buttons().length, 0);
  assert.equal(p.sequence.children.length, 1);
  assert.match(p.sequence.children[0].textContent, /No matching residues/);
  assert.equal(p.h.sequenceSelectionJsonBytes, 2);
  p.h.sync();
  p.h.searchValue = ''; p.h.renderSequence();
  assert.equal(p.items().dataset.disabled, 'true');
  assert.equal(p.buttons().length, 3);
  p.h.options.enableXr = true; p.h.renderSequence();
  assert.equal(p.items(), null);
  assert.equal(p.sequence.children.length, 0);
  assert.equal(p.h.sequenceSelectionJsonBytes, 2);
});
