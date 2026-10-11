import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { installSpatialMenuHook, menuHookRows, menuHookState } from './spatial-menu-hook.mjs';
import { createSequenceNavigation } from './sequence-navigation.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

afterEach(() => { delete globalThis.__stereofoldMenu; });

test('the page hook reports the toolbar rows with stable ids and pressability', () => {
  const toolbarRows = spatialToolbarRows({ collapsed: true, voice: { state: 'idle' } });
  const dispose = installSpatialMenuHook({ readRows: () => toolbarRows, runAction: () => {} });
  assert.deepEqual(globalThis.__stereofoldMenu.rows(), menuHookRows(toolbarRows));
  assert.ok(globalThis.__stereofoldMenu.rows().some(row => row.id === 'menu' && row.label === 'Menu' && row.active));
  assert.ok(!globalThis.__stereofoldMenu.rows().some(row => row.id === 'move'));
  assert.ok(spatialToolbarRows({ collapsed: false }).some(row => row.id === 'move' && row.label === 'Re-seat'));
  dispose();
  assert.equal(globalThis.__stereofoldMenu, undefined);
});

test('press dispatches the expanded Re-seat action exactly once', () => {
  const toolbarRows = spatialToolbarRows({ collapsed: false });
  const dispatched = [];
  installSpatialMenuHook({ readRows: () => toolbarRows, runAction: action => dispatched.push(action) });
  assert.equal(globalThis.__stereofoldMenu.press('move'), true);
  assert.deepEqual(dispatched, [{ kind: 'recenter-menu' }]);
});

test('press refuses an unknown id and names every id that is currently known', () => {
  const toolbarRows = spatialToolbarRows({ collapsed: true });
  installSpatialMenuHook({ readRows: () => toolbarRows, runAction: () => assert.fail('unknown row dispatched') });
  assert.throws(() => globalThis.__stereofoldMenu.press('missing'), error => {
    assert.match(error.message, /Unknown menu row "missing"/);
    for (const row of menuHookRows(toolbarRows)) assert.match(error.message, new RegExp(`\\b${row.id}\\b`));
    return true;
  });
});

/**
 * The driver reads the scene through this reducer and nothing else. It
 * published `{open, index}`, `index` is a field no build writes, and the row
 * ids a Find-pad press leaves untouched, so on the Quest 2 ten
 * presses that each advanced the drawn value by one digit were all UNVERIFIED
 * after a 12.5 s timeout. This drives the real browser rather than a
 * hand-written object, so the two ends cannot drift apart again.
 */
const padResidue = n => ({ key: `one:${n}:`, coordinateState: 'resolved',
  identity: { modelNumber: 1, assemblyId: '1', copyId: 'one', entityId: '1', labelChain: 'A', authorChain: 'X',
    operatorIds: ['one'], componentId: 'ALA', authorResidue: n, labelSequenceId: n, insertionCode: '' } });

function padFixture() {
  const source = { binding: 'source:1', rows: Array.from({ length: 40 }, (_, n) => padResidue(n + 1)),
    available: true, modelNumber: 1, assemblyId: '1', selectionKeys: [] };
  const navigation = createSequenceNavigation(() => source);
  const run = (op, extra = {}) => navigation.act({ kind: 'sequence', ...navigation.snapshot(), op, ...extra });
  return { navigation, run, reading: () => menuHookState({ sequence: navigation.snapshot() }).sequence };
}

test('the hook publishes the Find pad reading a driver verifies a press by', () => {
  const { run, reading } = padFixture();
  run('open'); run('tools'); run('find');
  const before = reading();
  assert.equal(before.open, true);
  assert.equal(before.find.editing, true);
  assert.equal(before.find.label, 'A000000');
  assert.equal(before.find.value, 0);
  assert.equal(before.find.digit, 5);
  assert.equal(before.find.numbering, 'author');
  assert.equal(before.find.negative, false);
  // One `Value +`. The pad stays on the same sub-page and every row id is
  // identical, so the published value is the only proof the press landed.
  run('value', { delta: 1 });
  const after = reading();
  assert.equal(after.find.label, 'A000001');
  assert.equal(after.find.value, 1);
  assert.notDeepEqual(after, before);
  // Each of the other pad rows moves a published field of its own.
  run('digit', { delta: -1 });
  assert.equal(reading().find.digit, 4);
  run('sign');
  assert.equal(reading().find.negative, true);
  assert.equal(reading().find.label, 'A-000001');
  run('numbering');
  assert.equal(reading().find.numbering, 'sequence');
  assert.equal(reading().find.label, 'S-000001');
});

test('the hook publishes the page and the chain the browser is showing', () => {
  const { run, reading } = padFixture();
  run('open');
  const first = reading();
  assert.equal(first.page, 0);
  assert.ok(first.pageCount > 1, 'forty residues are more than one page');
  assert.equal(first.chain, 'A');
  assert.equal(first.chains, 1);
  run('page', { delta: 1 });
  assert.equal(reading().page, 1);
  // The pad's reading rides along whether or not the pad is open, so a build
  // that never opened Find still publishes a `find` object rather than nothing.
  assert.equal(reading().find.editing, false);
  assert.equal(reading().find.label, 'A000000');
});

test('a page with no sequence at all still reduces to null rather than a shape', () => {
  assert.equal(menuHookState({}).sequence, null);
  assert.equal(menuHookState(null), null);
  // A build too old to publish the pad answers null on `find`, which the
  // driver reads as "this page cannot prove the press" rather than as a pass.
  assert.deepEqual(menuHookState({ sequence: { open: true } }).sequence,
    { open: true, index: null, page: null, pageCount: null, chain: null, chains: null, find: null });
});

/**
 * The description paging counter lives in the toolbar closure, so it reached no
 * driver at all and six `description-page` presses that turned the page on the
 * Quest 2 each reported UNVERIFIED. The row list is byte-identical
 * across a press, so the index and the `Pg n/m` label are the whole outcome.
 */
test('the hook publishes which page of the source description the plate is showing', () => {
  const paging = index => ({ descriptionPageCount: 6, descriptionPageIndex: index });
  assert.deepEqual(menuHookState({ readout: paging(0) }).readout, { descriptionPageIndex: 0, descriptionPageCount: 6 });
  assert.deepEqual(menuHookState({ readout: paging(5) }).readout, { descriptionPageIndex: 5, descriptionPageCount: 6 });
  // The published index is the one the row label is drawn from, so the two
  // cannot disagree about which page the wearer is reading.
  for (const index of [0, 1, 5]) {
    const row = spatialToolbarRows({ collapsed: false, readout: paging(index) }).find(entry => entry.id === 'description-page');
    assert.equal(row.label, `Pg ${menuHookState({ readout: paging(index) }).readout.descriptionPageIndex + 1}/6`);
  }
  // A build too old to publish the paging answers null, which the driver reads
  // as "this page cannot prove the press" rather than as a pass.
  assert.equal(menuHookState({}).readout, null);
  assert.deepEqual(menuHookState({ readout: {} }).readout, { descriptionPageIndex: null, descriptionPageCount: null });
});

test('read-only menu state publishes a detached copy of the actual admitted representation cycle', () => {
  let representations = ['cartoon', 'spacefill', 'molecular-surface'];
  let dispatched = 0;
  installSpatialMenuHook({ readRows: () => [], runAction: () => { dispatched++; }, readState: () => ({ representations }) });
  const reading = globalThis.__stereofoldMenu.state();
  assert.deepEqual(reading.representations, representations);
  reading.representations.push('ball-and-stick');
  assert.deepEqual(globalThis.__stereofoldMenu.state().representations, ['cartoon', 'spacefill', 'molecular-surface']);
  representations = [];
  assert.deepEqual(globalThis.__stereofoldMenu.state().representations, []);
  assert.equal(menuHookState({}).representations, null, 'missing telemetry differs from a scene with no molecular choices');
  assert.equal(dispatched, 0);
});
