/**
 * The microtubule tiers' colour key, read as voice nouns.
 *
 * `stereo_structure.emphasize` and the wearer's push-to-talk both reach a
 * lesson's parts by the same matcher, so the ids and labels a manifest writes
 * ARE the grammar. A tier that renames beta tubulin between sizes silently
 * takes "show me the beta tubulin" away from the wearer in the middle of a
 * growth run, and nothing in the page would report it.
 *
 * These run the real runner entry point over the checked-in manifests rather
 * than over a fixture, so the grammar is tested against what actually ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spatialVoiceAction } from './voice-command-runner.mjs';
import { planLessonEmphasis, resolveEmphasisPartId, resolveEmphasisPartIds } from './lesson-emphasis.mjs';

const demos = resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin/demos/microtubule-growth');
const TIERS = ['monomer', 'dimer', 'protofilament', 'wall', 'tube', 'tip'];
const tier = (id) => JSON.parse(readFileSync(resolve(demos, `${id}.json`), 'utf8'));
/** Every chapter of a tier repeats the same key, so the first chapter is the key. */
const keyOf = (id) => tier(id).chapters[0].immersive.emphasis.parts;

test('every tier that contains beta tubulin answers to its name', () => {
  // monomer is 5SYF entity 1, the alpha chain alone: there is no beta tubulin
  // in those coordinates, and a part naming an absent chain would throw the
  // chapter's whole emphasis away rather than politely light nothing.
  for (const id of TIERS.filter(name => name !== 'monomer')) {
    const parts = keyOf(id);
    const heard = spatialVoiceAction('show me the beta tubulin', { lessonParts: parts });
    assert.equal(heard?.action.kind, 'emphasize-part', id);
    assert.equal(heard.action.part, 'beta-tubulin', id);
    assert.equal(heard.say, 'Beta tubulin.', id);
  }
  assert.equal(spatialVoiceAction('show me the beta tubulin', { lessonParts: keyOf('monomer') }), undefined);
});

test('alpha tubulin answers to its name in all six tiers, monomer included', () => {
  for (const id of TIERS) {
    const heard = spatialVoiceAction('show me the alpha tubulin', { lessonParts: keyOf(id) });
    assert.equal(heard?.action.part, 'alpha-tubulin', id);
  }
});

test('EB3 answers in the one tier that deposits it, and nowhere else', () => {
  const parts = keyOf('tip');
  for (const phrase of ['show me EB3', 'where is the EB3']) {
    const heard = spatialVoiceAction(phrase, { lessonParts: parts });
    assert.deepEqual(heard.action, { kind: 'emphasize-part', parts: ['eb3', 'eb3-second'], framing: 'context' });
    assert.ok(heard.say.split(/\s+/).length <= 12);
    const plan = planLessonEmphasis({ parts, focus: heard.action.parts }, ({ chain }) => [chain], parts.map(p => p.chain));
    assert.deepEqual(plan.explained.map(p => p.id), ['eb3', 'eb3-second']);
  }
  for (const [phrase, id] of [['the first EB3', 'eb3'], ['EB3 one', 'eb3'],
    ['the second EB3', 'eb3-second'], ['EB3 two', 'eb3-second']]) {
    assert.deepEqual(resolveEmphasisPartIds(parts, phrase), [id]);
    assert.equal(spatialVoiceAction(`show me ${phrase}`, { lessonParts: parts }).action.part, id);
  }
  for (const id of ['eb3', 'eb3-second']) assert.equal(resolveEmphasisPartId(parts, id), id);
  for (const id of TIERS.filter(name => name !== 'tip')) {
    assert.equal(spatialVoiceAction('show me EB3', { lessonParts: keyOf(id) }), undefined, id);
  }
});

test('the deposited small molecules are nouns too, where the entry carries them', () => {
  for (const [id, said, part] of [
    ['dimer', 'show me the Taxol', 'taxol'],
    ['dimer', 'show me the GTP', 'gtp'],
    ['dimer', 'show me the GDP', 'gdp'],
    ['wall', 'show me the Taxol', 'taxol'],
    ['tube', 'show me the GDP', 'gdp'],
  ]) {
    assert.equal(spatialVoiceAction(said, { lessonParts: keyOf(id) })?.action.part, part, `${id}: ${said}`);
  }
  // 3JAK carries GTPgammaS rather than the GDP of the Taxol entry, and the key
  // says so rather than offering a noun the coordinates cannot answer.
  assert.equal(spatialVoiceAction('show me the GDP', { lessonParts: keyOf('tip') }), undefined);
  assert.equal(spatialVoiceAction('show me the GTP gamma S', { lessonParts: keyOf('tip') })?.action.part, 'gtpgammas');
});

test('one noun means one thing across the whole growth run', () => {
  // The point of the rule: the id a wearer learned in the dimer still resolves
  // after two grow_structure swaps, and still carries the same colour.
  const colourOf = (id, part) => keyOf(id).find(entry => entry.id === part)?.color;
  for (const id of TIERS) {
    assert.equal(colourOf(id, 'alpha-tubulin'), '#4a90e2', id);
    assert.equal(resolveEmphasisPartId(keyOf(id), 'Alpha tubulin'), 'alpha-tubulin', id);
  }
  for (const id of TIERS.filter(name => name !== 'monomer')) {
    assert.equal(colourOf(id, 'beta-tubulin'), '#f5a623', id);
  }
  assert.equal(colourOf('tip', 'eb3'), '#35c46a');
  assert.equal(colourOf('tip', 'eb3-second'), '#35c46a');
});

test('a grown tier reveal lights every subunit, so the lit subject grows with the strand', () => {
  // An earlier growth continuity rule — the reveal lights the
  // new copy alone, ghosting the dimer the wearer already knows — is what drew
  // the new dimer as a grey ghost and shrank the lit subject (38.6 % to
  // 22.3 % of the lens) while the strand grew, against "same two colours". A
  // grown tier lights every subunit instead; only the ligand cargo fades.
  const rows = (chain) => [`${chain}:1`, `${chain}:2`];
  const resolveKeys = ({ chain }) => (chain ? rows(chain) : []);
  const every = ['A', 'B', 'A-14', 'B-14'].flatMap(rows);
  const reveal = tier('protofilament').chapters[0].immersive.emphasis;
  const plan = planLessonEmphasis(reveal, resolveKeys, every);
  assert.deepEqual(plan.lit.sort(), every.sort());
  assert.deepEqual(plan.faded, []);
  assert.deepEqual(plan.colours.map(part => part.color), ['#4a90e2', '#f5a623', '#4a90e2', '#f5a623']);
  assert.equal(plan.transparency.toFixed(2), '0.82');

  // And a chapter with no focus is the whole key at full strength.
  const orbit = tier('protofilament').chapters[1].immersive.emphasis;
  const whole = planLessonEmphasis(orbit, resolveKeys, every);
  assert.deepEqual(whole.faded, []);
  // The stub resolver above answers by chain alone, so the two ligand parts,
  // which are residue ranges on chains A and B, come back with those chains.
  assert.deepEqual(whole.colours.map(part => part.id),
    ['alpha-tubulin', 'beta-tubulin', 'new-alpha', 'new-beta', 'gtp', 'taxol']);
});

test('every part of every tier names a chain the coordinates of that tier carry', () => {
  // Written from the atom_site auth_asym_id values of the cached coordinate
  // files. An operator subset suffixes its author chains, so a key that said
  // "A" for a wall chain would resolve nothing and throw.
  const expected = {
    monomer: ['A'],
    dimer: ['A', 'B'],
    protofilament: ['A', 'A-14', 'B', 'B-14'],
    wall: ['A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6', 'B-7'],
    tube: ['A', 'B'],
    tip: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'],
  };
  for (const id of TIERS) {
    assert.deepEqual([...new Set(keyOf(id).map(part => part.chain))].sort(), expected[id], id);
  }
});

test('every chapter in the microtubule tiers declares an authored cinematic motion', () => {
  const allowedKinds = new Set(['turntable', 'orbit', 'dolly', 'hold']);
  for (const id of TIERS) {
    const manifest = tier(id);
    assert.equal(manifest.chapters.length, 5, `${id} chapter count`);
    for (const chapter of manifest.chapters) {
      const motion = chapter.immersive?.motion;
      assert.ok(motion, `${id}/${chapter.id} has motion`);
      assert.equal(typeof motion, 'object', `${id}/${chapter.id} motion is object`);
      assert.ok(allowedKinds.has(motion.kind), `${id}/${chapter.id} motion kind ${motion.kind}`);
      if (motion.kind === 'turntable') {
        assert.ok(typeof motion.degrees === 'number', `${id}/${chapter.id} turntable degrees`);
      } else if (motion.kind === 'orbit') {
        assert.ok(typeof motion.degrees === 'number', `${id}/${chapter.id} orbit degrees`);
        assert.ok(['x', 'y', 'z'].includes(motion.axis ?? 'y'), `${id}/${chapter.id} orbit axis`);
      } else if (motion.kind === 'dolly') {
        assert.ok(typeof motion.metres === 'number', `${id}/${chapter.id} dolly metres`);
      }
      if (motion.seconds !== undefined) {
        assert.ok(motion.seconds > 0, `${id}/${chapter.id} seconds`);
      }
    }
  }
});
