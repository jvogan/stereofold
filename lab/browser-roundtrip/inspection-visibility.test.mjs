import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPOUND_OP_KINDS } from './compound-change.mjs';
import { absentClassNote, absentClassRefusal, absentVisibilityClasses, availableChains, chainIdentityKey,
  chainReferent, componentClassesPresent, componentClassOf, describeVisibility, emptyVisibility,
  hiddenRowKeys, normalizeVisibility, resolveVisibility, sameVisibility, visibilityHidesEverything,
  visibilityIsEmpty, visibleRowKeys, VISIBILITY_COMPONENT_CLASSES } from './inspection-visibility.mjs';

/**
 * A two-copy assembly: chain A and chain B each present twice, plus a ligand, an
 * ion and water. This is the shape that makes a bare chain letter a guess.
 */
const row = (labelChain, copyId, componentId, entityType, index) => ({
  key: `${labelChain}:${copyId}:${componentId}:${index}`,
  entityType,
  identity: { modelNumber: 1, assemblyId: '1', copyId, labelChain, componentId },
});
const ROWS = [
  row('A', 'one', 'ALA', 'polymer', 1), row('A', 'one', 'GLY', 'polymer', 2),
  row('B', 'one', 'ALA', 'polymer', 3),
  row('A', 'two', 'ALA', 'polymer', 4), row('B', 'two', 'ALA', 'polymer', 5),
  row('C', 'one', 'HEM', 'non-polymer', 6),
  row('D', 'one', 'ZN', 'non-polymer', 7),
  row('E', 'one', 'HOH', 'water', 8),
];
const CHAINS = availableChains(ROWS, 1);
const chain = (labelChain, copyId) => ({ labelChain, copyId });

test('a chain is named by label chain and copy id, in catalog order and without repeats', () => {
  assert.deepEqual(CHAINS, [chain('A', 'one'), chain('B', 'one'), chain('A', 'two'), chain('B', 'two'),
    chain('C', 'one'), chain('D', 'one'), chain('E', 'one')]);
  // The pair is the whole point: "B" alone names two different halves here.
  assert.equal(new Set(CHAINS.map(c => c.labelChain)).size, 5);
  assert.equal(availableChains(ROWS, 2).length, 0);
});

test('an ion is told from a ligand, and a polymer from both', () => {
  assert.equal(componentClassOf(ROWS[0]), 'polymer');
  assert.equal(componentClassOf(ROWS[5]), 'ligand');
  assert.equal(componentClassOf(ROWS[6]), 'ion');
  assert.equal(componentClassOf(ROWS[7]), 'water');
  assert.deepEqual([...VISIBILITY_COMPONENT_CLASSES], ['water', 'ligand', 'ion', 'polymer']);
});

test('a hidden set has exactly one spelling, so two panels cannot describe one picture two ways', () => {
  const written = normalizeVisibility({ hiddenChains: [chain('B', 'two'), chain('A', 'one'), chain('B', 'two')],
    hiddenClasses: ['polymer', 'water', 'water'], showOnlySelection: false });
  assert.deepEqual(written.hiddenChains, [chain('A', 'one'), chain('B', 'two')]);
  assert.deepEqual(written.hiddenClasses, ['water', 'polymer']);
  assert.equal(JSON.stringify(normalizeVisibility(written)), JSON.stringify(written));
  assert.equal(sameVisibility(written, { hiddenChains: [chain('B', 'two'), chain('A', 'one')],
    hiddenClasses: ['polymer', 'water'], showOnlySelection: false }), true);
  // Absent and empty are the same picture, so neither is a change to undo.
  assert.equal(visibilityIsEmpty(undefined), true);
  assert.equal(visibilityIsEmpty(emptyVisibility()), true);
  assert.throws(() => normalizeVisibility({ hiddenChains: [{ labelChain: 'A' }] }), /copy id must be a short non-empty identifier/);
  assert.throws(() => normalizeVisibility({ hiddenChains: [{ labelChain: 'A', copyId: 'one', chain: 'A' }] }), /and nothing else/);
  assert.throws(() => normalizeVisibility({ hiddenClasses: ['lipid'] }), /component class is one of/);
  assert.throws(() => normalizeVisibility({ chains: [] }), /Unknown inspection visibility field/);
});

test('hide and show move named things in and out of the set without disturbing the rest', () => {
  const hidden = resolveVisibility(undefined, { op: 'hide', chains: [chain('B', 'one')] }, CHAINS);
  assert.deepEqual(hidden.hiddenChains, [chain('B', 'one')]);
  const both = resolveVisibility(hidden, { op: 'hide', classes: ['water'] }, CHAINS);
  assert.deepEqual(both, { hiddenChains: [chain('B', 'one')], hiddenClasses: ['water'], showOnlySelection: false });
  const shown = resolveVisibility(both, { op: 'show', chains: [chain('B', 'one')] }, CHAINS);
  assert.deepEqual(shown, { hiddenChains: [], hiddenClasses: ['water'], showOnlySelection: false });
  assert.deepEqual(resolveVisibility(both, { op: 'reset' }, CHAINS), emptyVisibility());
});

test('only hides everything the request did not name, and naming both means the intersection', () => {
  // "show only the ligand" — the other three classes go, no chain is named.
  const ligand = resolveVisibility(undefined, { op: 'only', classes: ['ligand'] }, CHAINS);
  assert.deepEqual(ligand, { hiddenChains: [], hiddenClasses: ['water', 'ion', 'polymer'], showOnlySelection: false });
  assert.deepEqual(hiddenRowKeys(ROWS, ligand), ROWS.filter(r => r !== ROWS[5]).map(r => r.key));

  // "show only chain A, the first copy" — every other chain goes.
  const one = resolveVisibility(undefined, { op: 'only', chains: [chain('A', 'one')] }, CHAINS);
  // Normalized, so sorted by label chain then copy id rather than catalog order.
  assert.deepEqual(one.hiddenChains, [chain('A', 'two'), chain('B', 'one'), chain('B', 'two'),
    chain('C', 'one'), chain('D', 'one'), chain('E', 'one')]);
  assert.deepEqual(visibleRowKeys(ROWS, one), [ROWS[0].key, ROWS[1].key]);

  const both = resolveVisibility(undefined, { op: 'only', chains: [chain('C', 'one')], classes: ['ligand'] }, CHAINS);
  assert.deepEqual(visibleRowKeys(ROWS, both), [ROWS[5].key]);
  assert.throws(() => resolveVisibility(undefined, { op: 'only' }, CHAINS), /Name a chain or a component class/);
});

/**
 * "Hide the water" on a structure with no water came
 * back "Hidden the water" and drew `Applied. change. r6` over a picture that
 * had not moved. A class this model has none of is now answered the way a chain
 * it does not have already was.
 */
test('a class this structure has none of is named and refused, not folded into the hidden set', () => {
  const PROTEIN = ROWS.filter(r => r.entityType === 'polymer');
  assert.deepEqual(componentClassesPresent(ROWS, 1), ['water', 'ligand', 'ion', 'polymer']);
  assert.deepEqual(componentClassesPresent(PROTEIN, 1), ['polymer']);
  // A model number nobody asked about contributes nothing.
  assert.deepEqual(componentClassesPresent(ROWS, 2), []);

  const crambin = { classes: ['polymer'], structure: '1CRN' };
  const chains = availableChains(PROTEIN, 1);
  assert.deepEqual(absentVisibilityClasses(['water', 'polymer'], crambin.classes), ['water']);
  // Not knowing what a structure holds is not the same as knowing it holds none.
  assert.deepEqual(absentVisibilityClasses(['water'], undefined), []);

  assert.throws(() => resolveVisibility(undefined, { op: 'hide', classes: ['water'] }, chains, crambin),
    /^Error: 1CRN has no water to hide\.$/);
  assert.throws(() => resolveVisibility(undefined, { op: 'show', classes: ['water', 'ion'] }, chains, crambin),
    /^Error: 1CRN has no water or ions to show\.$/);
  // Without the structure's name the sentence still reads as one.
  assert.throws(() => resolveVisibility(undefined, { op: 'hide', classes: ['ligand'] }, chains, { classes: ['polymer'] }),
    /^Error: This structure has no ligands to hide\.$/);

  // Some of each: what is there is hidden, and what is not never reaches the
  // saved set, so no scene claims a class the panel can draw nothing for.
  const mixed = resolveVisibility(undefined, { op: 'hide', classes: ['water', 'polymer'] }, chains, crambin);
  assert.deepEqual(mixed, { hiddenChains: [], hiddenClasses: ['polymer'], showOnlySelection: false });
  assert.equal(absentClassNote(['water'], '1CRN'), '1CRN has no water.');
  assert.equal(absentClassRefusal(['water', 'ligand', 'ion'], 'hide', '4HHB'),
    '4HHB has no water, ligands or ions to hide.');

  // Naming a chain as well is a request this structure can answer, so it is
  // answered rather than refused over the half it cannot.
  const withChain = resolveVisibility(undefined, { op: 'hide', chains: [chain('A', 'one')], classes: ['water'] }, chains, crambin);
  assert.deepEqual(withChain, { hiddenChains: [chain('A', 'one')], hiddenClasses: [], showOnlySelection: false });

  // Every class named is there: byte for byte the set this has always built.
  assert.deepEqual(resolveVisibility(undefined, { op: 'hide', classes: ['water', 'ion'] }, CHAINS,
    { classes: componentClassesPresent(ROWS, 1), structure: '2ABC' }),
  resolveVisibility(undefined, { op: 'hide', classes: ['water', 'ion'] }, CHAINS));
});

/**
 * D104 taught hide and show to refuse a class the file has none of,
 * and left `only` computing its complement over all four names. So on one device session
 * "show only the ligand" on 1CRN hid water, ion and polymer, the panel drew
 * nothing, and the receipt said `Applied`. A request the wearer made in order to
 * SEE something is the last one that may end in an empty screen.
 */
test('show only a class this structure has none of is refused, and never empties the scene', () => {
  const PROTEIN = ROWS.filter(r => r.entityType === 'polymer');
  const crambin = { classes: ['polymer'], structure: '1CRN' };
  const chains = availableChains(PROTEIN, 1);

  // The defect, in one line: crambin has no ligand, so there is no such scene.
  assert.throws(() => resolveVisibility(undefined, { op: 'only', classes: ['ligand'] }, chains, crambin),
    /^Error: 1CRN has no ligands to show only\.$/);
  assert.throws(() => resolveVisibility(undefined, { op: 'only', classes: ['water', 'ion'] }, chains, crambin),
    /^Error: 1CRN has no water or ions to show only\.$/);
  // Naming a chain as well does not rescue it: the intersection of chain A and
  // a class this file has none of is empty too, so the answer is the same
  // sentence rather than a silent fall back to showing the chain.
  assert.throws(() => resolveVisibility(undefined, { op: 'only', chains: [chain('A', 'one')], classes: ['ligand'] }, chains, crambin),
    /^Error: 1CRN has no ligands to show only\.$/);

  // Some of each: the present class is what is shown, and the absent one is the
  // caller's to report through `absentVisibilityClasses`, exactly as for hide.
  // Crambin is a polymer and nothing else, so showing only its polymer hides
  // nothing, and the set says so rather than naming three classes it has none
  // of. The complement is taken over the classes this structure HAS.
  const mixed = resolveVisibility(undefined, { op: 'only', classes: ['ligand', 'polymer'] }, chains, crambin);
  assert.deepEqual(mixed, emptyVisibility());
  assert.deepEqual(visibleRowKeys(PROTEIN, mixed), PROTEIN.map(r => r.key));
  assert.deepEqual(absentVisibilityClasses(['ligand', 'polymer'], crambin.classes), ['ligand']);

  // 4HHB carries water, haems and a phosphate and no monatomic ion, so showing
  // only its ligands hides two classes and never claims the ions went too.
  const hemoglobin = { classes: ['water', 'ligand', 'polymer'], structure: '4HHB' };
  const ligands = resolveVisibility(undefined, { op: 'only', classes: ['ligand'] }, CHAINS, hemoglobin);
  assert.deepEqual(ligands.hiddenClasses, ['water', 'polymer']);
  assert.equal(describeVisibility(ligands, CHAINS), 'Hidden the water and the polymer.');

  // A caller that cannot say what the structure holds refuses nothing, so the
  // set an `only` built before this change is the set it still builds.
  assert.deepEqual(resolveVisibility(undefined, { op: 'only', classes: ['ligand'] }, CHAINS,
    { classes: componentClassesPresent(ROWS, 1), structure: '2ABC' }),
  resolveVisibility(undefined, { op: 'only', classes: ['ligand'] }, CHAINS));
  assert.deepEqual(resolveVisibility(undefined, { op: 'only', chains: [chain('A', 'one')] }, chains, crambin),
    resolveVisibility(undefined, { op: 'only', chains: [chain('A', 'one')] }, chains));
});

test('a hidden set that would draw nothing is recognised, chains and classes only', () => {
  const crambin = { classes: ['polymer'], structure: '1CRN' };
  const PROTEIN = ROWS.filter(r => r.entityType === 'polymer');

  // The empty scene no class name announces: chain D is the zinc, and its
  // intersection with the ligands is nothing at all. Both halves name something
  // this model has, so `resolveVisibility` has nothing to refuse by name.
  const empty = resolveVisibility(undefined, { op: 'only', chains: [chain('D', 'one')], classes: ['ligand'] }, CHAINS,
    { classes: componentClassesPresent(ROWS, 1), structure: '2ABC' });
  assert.deepEqual(visibleRowKeys(ROWS, empty), []);
  assert.equal(visibilityHidesEverything(ROWS, empty, 1), true);

  // An intersection with something in it is not empty: chain C holds the haem.
  const haem = resolveVisibility(undefined, { op: 'only', chains: [chain('C', 'one')], classes: ['ligand'] }, CHAINS);
  assert.equal(visibilityHidesEverything(ROWS, haem, 1), false);
  assert.equal(visibilityHidesEverything(ROWS, emptyVisibility(), 1), false);

  // A hide that names the whole of a one-class structure is still allowed: the
  // wearer asked for the empty screen, was told what was hidden, and has one
  // undo back. Only a request to SHOW something is refused for drawing nothing.
  const all = resolveVisibility(undefined, { op: 'hide', classes: ['polymer'] }, availableChains(PROTEIN, 1), crambin);
  assert.equal(visibilityHidesEverything(PROTEIN, all, 1), true);

  // Showing only a selection nobody made draws nothing as well, and that is a
  // state the wearer switched on rather than a request that misread the file.
  assert.equal(visibilityHidesEverything(ROWS, { hiddenChains: [], hiddenClasses: [], showOnlySelection: true }, 1), false);
  // Rows of another model are not this model's picture.
  assert.equal(visibilityHidesEverything(ROWS, empty, 2), false);
});

test('showing only the selection is a state, and a show turns it back off', () => {
  const only = resolveVisibility(undefined, { op: 'only', selection: true }, CHAINS);
  assert.deepEqual(only, { hiddenChains: [], hiddenClasses: [], showOnlySelection: true });
  assert.deepEqual(hiddenRowKeys(ROWS, only, [ROWS[2].key]), ROWS.filter(r => r !== ROWS[2]).map(r => r.key));
  // A selection nobody made hides everything, which is honest rather than a no-op.
  assert.equal(hiddenRowKeys(ROWS, only, []).length, ROWS.length);
  assert.deepEqual(resolveVisibility(only, { op: 'show', selection: true }, CHAINS), emptyVisibility());
});

test('an identity this model does not have is refused, with the ones it does', () => {
  assert.throws(() => resolveVisibility(undefined, { op: 'hide', chains: [chain('Z', 'one')] }, CHAINS),
    /no chain Z with copy id one[\s\S]*A \(copy one\)/);
  // The copy matters as much as the letter: chain B exists, this copy does not.
  assert.throws(() => resolveVisibility(undefined, { op: 'hide', chains: [chain('B', 'three')] }, CHAINS),
    /no chain B with copy id three/);
  assert.throws(() => resolveVisibility(undefined, { op: 'hide', chains: [chain('A', 'one')] }, []),
    /use one of: none/);
});

test('a hidden row is hidden by chain, by class, or by not being selected', () => {
  const set = { hiddenChains: [chain('A', 'two')], hiddenClasses: ['water'], showOnlySelection: false };
  assert.deepEqual(hiddenRowKeys(ROWS, set), [ROWS[3].key, ROWS[7].key]);
  assert.deepEqual(hiddenRowKeys(ROWS, undefined), []);
  // The union, not a precedence: a row in a hidden chain stays hidden whatever
  // class it is, and undo restores the one saved set rather than three rules.
  const all = { hiddenChains: CHAINS, hiddenClasses: [], showOnlySelection: false };
  assert.equal(hiddenRowKeys(ROWS, all).length, ROWS.length);
});

test('what the wearer is told, in the words both ends say', () => {
  assert.equal(describeVisibility(undefined, CHAINS), 'Everything is showing.');
  assert.equal(describeVisibility({ hiddenChains: [chain('B', 'one')], hiddenClasses: [], showOnlySelection: false }, CHAINS),
    'Hidden chain B (copy 1).');
  assert.equal(describeVisibility({ hiddenChains: [chain('B', 'two')], hiddenClasses: [], showOnlySelection: false }, CHAINS),
    'Hidden chain B (copy 2).');
  // One copy of a chain needs no copy number; saying one is a distinction the
  // listener has to work out means nothing.
  assert.equal(describeVisibility({ hiddenChains: [chain('C', 'one')], hiddenClasses: [], showOnlySelection: false }, CHAINS),
    'Hidden chain C.');
  assert.equal(describeVisibility({ hiddenChains: [chain('B', 'one')], hiddenClasses: ['water'], showOnlySelection: false }, CHAINS),
    'Hidden chain B (copy 1) and the water.');
  assert.equal(describeVisibility({ hiddenChains: [], hiddenClasses: [], showOnlySelection: true }, CHAINS),
    'Showing only the selection.');
});

test('the panel runs every op kind the host can put in a compound', () => {
  assert.equal(COMPOUND_OP_KINDS.includes('visibility'), true);
  assert.equal(chainIdentityKey(chain('A', 'one')), chainIdentityKey({ copyId: 'one', labelChain: 'A' }));
});

/**
 * A chain named the way a person names one.
 *
 * `{"kind":"visibility","patch":{"op":"hide","chains":["A"]}}` was refused on
 * with a zod issue list, and the same hide written as the pair
 * rendered in 559 ms. A letter
 * that can only mean one chain now resolves to that chain; a letter that
 * cannot is refused in a sentence, and the sentence names the chains there are.
 */
test('a bare letter names the one chain it can only mean', () => {
  const single = [chain('C', 'one'), chain('D', 'one')];
  for (const written of ['C', 'c', 'chain C', 'Chain  C ', { labelChain: 'C' }])
    assert.deepEqual(chainReferent(written, single), chain('C', 'one'), JSON.stringify(written));
  assert.deepEqual(resolveVisibility(emptyVisibility(), { op: 'hide', chains: ['C'] }, single),
    { hiddenChains: [chain('C', 'one')], hiddenClasses: [], showOnlySelection: false });
  // The canonical pair is untouched and still the only thing a receipt carries.
  assert.deepEqual(chainReferent(chain('D', 'one'), single), chain('D', 'one'));
});

test('a letter this structure does not have is refused in a sentence naming the ones it has', () => {
  for (const written of ['Z', 'chain Z', { labelChain: 'Z' }]) {
    assert.throws(() => chainReferent(written, CHAINS), error => {
      assert.match(error.message, /^This structure has no chain Z: its chains are A, B, C, D and E\.$/u);
      assert.ok(!/labelChain|copyId|invalid_type|expected/u.test(error.message), error.message);
      return true;
    }, JSON.stringify(written));
  }
  assert.throws(() => resolveVisibility(emptyVisibility(), { op: 'hide', chains: ['Z'] }, CHAINS),
    /This structure has no chain Z: its chains are A, B, C, D and E\./u);
});

test('a letter two copies answer to is refused with the copies, not with a guess', () => {
  assert.throws(() => chainReferent('A', CHAINS), error => {
    assert.match(error.message, /^This assembly holds 2 copies of chain A, so the letter alone does not say which; name one of chain A \(copy 1\) with copy id one and chain A \(copy 2\) with copy id two\.$/u);
    assert.ok(!/invalid_type|expected|path/u.test(error.message), error.message);
    return true;
  });
  // Refused before anything is hidden, so no half-applied picture is queued.
  assert.throws(() => resolveVisibility(emptyVisibility(), { op: 'hide', chains: ['C', 'A'] }, CHAINS),
    /2 copies of chain A/u);
});

test('an empty or malformed chain referent still refuses in plain language', () => {
  for (const written of ['', '   ', 'chain ']) assert.throws(() => chainReferent(written, CHAINS),
    /^Error: Name a chain by its letter, or by its label chain and copy id\. This structure has A, B, C, D and E\.$/u);
  assert.throws(() => chainReferent({ labelChain: 'A', copy: 'one' }, CHAINS),
    /^Error: A hidden chain names labelChain and copyId and nothing else\.$/u);
  assert.throws(() => chainReferent(7, CHAINS), /^Error: A hidden chain names labelChain and copyId\.$/u);
});
