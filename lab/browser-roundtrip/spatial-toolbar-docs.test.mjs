import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MOLECULAR_REPRESENTATIONS, nextMolecularRepresentation, spatialToolbarRows } from './spatial-toolbar-content.mjs';

// Operator docs name the compact menu in its displayed order. Compare those
// names and every room-state reading with an independently pinned column,
// then check the toolbar itself against the same contract. Walkthroughs also
// describe the Mol* row's placement. Read focused skill references so moving
// guidance out of an entrypoint preserves these checks.
const page = relative => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const LISTING_PAGES = {
  'plugin/QUICKSTART.md': page('plugin/QUICKSTART.md'),
  'plugin/skills/stereo-structure/references/headsets.md': page('plugin/skills/stereo-structure/references/headsets.md'),
};
const WALKTHROUGH_PAGES = {
  'docs/first-run-and-sharing.md': page('docs/first-run-and-sharing.md'),
  'docs/headset-walkthrough.md': page('docs/headset-walkthrough.md'),
};
const PAGES = { ...LISTING_PAGES, ...WALKTHROUGH_PAGES };

/**
 * The resting compact column: a microphone attached, no tour, no render-budget
 * lever. The room row is the one row whose label reads the passthrough state,
 * so it is the one position with five readings, listed in the order of
 * `PASSTHROUGH_STATES`, including the caller's unsupported/unknown states.
 */
const PASSTHROUGH_STATES = [
  {},
  { passthrough: true, passthroughSupported: true },
  { passthrough: false, passthroughSupported: true },
  { passthrough: false, passthroughSupported: false },
  { passthrough: false, passthroughSupported: null },
];
const ROOM_LABELS = ['Room', 'Room on', 'Room off', 'No room', 'Room?'];
const STYLE_LABELS = ['Atoms', 'Ribbons', 'Spacefill', 'Surface', 'Density'];
const RESTING_COLUMN = [
  { id: 'talk', labels: ['Talk'] },
  { id: 'tour', labels: ['Tour'] },
  { id: 'reset', labels: ['Reset'] },
  { id: 'room', labels: ROOM_LABELS },
  { id: 'appearance', labels: STYLE_LABELS },
  { id: 'molstar', labels: ['Mol*'] },
  { id: 'menu', labels: ['Menu'] },
];
const restingRows = state => spatialToolbarRows({ voice: { state: 'idle' }, collapsed: true,
  appearance: { representation: 'cartoon' }, history: { canUndo: false, canRedo: false }, ...state });
/** The label the pinned column reads at `index` in the state `PASSTHROUGH_STATES[stateIndex]`. */
const pinnedLabel = (index, stateIndex) => {
  const { labels } = RESTING_COLUMN[index];
  if (RESTING_COLUMN[index].id === 'appearance') return 'Ribbons';
  return labels.length === 1 ? labels[0] : labels[stateIndex];
};
const positionOf = label => RESTING_COLUMN.findIndex(slot => slot.labels.includes(label));
const readable = RESTING_COLUMN.map(slot => slot.labels.join('/')).join(', ');

/**
 * The slots of each "menu rows are …" sentence on a page: one slot per row,
 * each a list of the backticked labels the page joins with `/` for a row that
 * reads differently by state.
 */
function citedSlots(text) {
  return [...text.matchAll(/menu rows are ((?:`[^`]+`(?:\/`[^`]+`)*[^`.;]*)+)[.;]/gu)]
    .map(sentence => [...sentence[1].matchAll(/`[^`]+`(?:\/`[^`]+`)*/gu)]
      .map(slot => [...slot[0].matchAll(/`([^`]+)`/gu)].map(label => label[1])));
}

/** Every formatted label row (including "menu row") and bare Talk row. */
function citedRows(text) {
  return [...text.matchAll(/(?:`([^`]+)`|\*\*([^\n]+?)\*\*|\b(Talk))\s+(?:menu\s+)?row\b/gu)]
    .map(cited => cited[1] ?? cited[2] ?? cited[3]);
}

/** Rows a page names that are not menu rows: SKILL.md names the `unresolved` row of a `residues` page. */
const NOT_MENU_ROWS = new Set(['unresolved']);

// One entry per citation, in prose order: [zero-based position, stable id,
// resting reading]. Independent expectations make substituting another valid
// row fail, and additions/removals must be reviewed instead of silently skipped.
const ROW_CITATIONS = {
  'plugin/QUICKSTART.md': [[0, 'talk', 'Talk'], [5, 'molstar', 'Mol*']],
  'plugin/skills/stereo-structure/references/headsets.md': [[4, 'appearance', 'Density']],
  'docs/first-run-and-sharing.md': [[5, 'molstar', 'Mol*'], [5, 'molstar', 'Mol*']],
  'docs/headset-walkthrough.md': [
    [4, 'appearance', 'Density'], [0, 'talk', 'Talk'], [0, 'talk', 'Talk'], [0, 'talk', 'Talk'],
  ],
};

test('the toolbar produces the pinned resting column: position, id and reading, in every passthrough state', () => {
  PASSTHROUGH_STATES.forEach((state, stateIndex) => {
    const rows = restingRows(state);
    assert.deepEqual(rows.map(row => [row.id, row.label]),
      RESTING_COLUMN.map((slot, index) => [slot.id, pinnedLabel(index, stateIndex)]),
      `the resting column with ${JSON.stringify(state)}`);
    for (const row of rows) {
      assert.equal(row.state === true, row.id === 'room' && stateIndex >= 3,
        `${row.label}: only unsupported/unknown room readings are disabled state chips at rest`);
    }
  });
});

test('the "menu rows are" sentences list the pinned column exactly: every position, every reading, in order', () => {
  const expected = RESTING_COLUMN.map(slot => slot.labels);
  for (const [name, text] of Object.entries(LISTING_PAGES)) {
    const listings = citedSlots(text);
    assert.ok(listings.length >= 1, `${name} lists the compact menu rows`);
    for (const slots of listings) {
      assert.deepEqual(slots, expected,
        `${name} lists the compact menu rows as ${slots.map(slot => slot.join('/')).join(', ')}; the pinned column reads ${readable}`);
    }
  }
});

test('every row citation has its exact position, id and reading, and the walkthrough placements are true', () => {
  for (const [name, text] of Object.entries(PAGES)) {
    const citations = citedRows(text).filter(label => !NOT_MENU_ROWS.has(label)).map(label => {
      const position = positionOf(label);
      return [position, RESTING_COLUMN[position]?.id, label];
    });
    assert.deepEqual(citations, ROW_CITATIONS[name],
      `${name}: every citation must name its intended slot [position, id, reading] in document order`);
  }
  // Mol* follows the style control at rest and remains accessible under Menu
  // when tour navigation fills the compact column.
  for (const [name, text] of Object.entries(WALKTHROUGH_PAGES)) {
    assert.doesNotMatch(text, /directly\s+under the room\s+row/u, `${name} uses the current Mol* placement`);
    assert.match(text.replace(/\s+/gu, ' '), /tour navigation fills the column, open \*\*Menu\*\*|open \*\*Menu\*\* to find it when tour navigation fills the column/u,
      `${name} explains the full-menu route when compact navigation needs the space`);
  }
  assert.equal(positionOf('Mol*'), positionOf('Ribbons') + 1, 'the Mol* row follows the current molecular style');
  assert.equal(positionOf('Menu'), positionOf('Mol*') + 1, 'Menu is directly under the Mol* row');
  // first-run-and-sharing.md names the room row by every reading it has.
  for (const label of ROOM_LABELS) {
    assert.ok(WALKTHROUGH_PAGES['docs/first-run-and-sharing.md'].includes(`**${label}**`),
      `docs/first-run-and-sharing.md names the room row reading ${JSON.stringify(label)}`);
  }
});

test('operator guides describe the live style cycle, density and shared scene history', () => {
  assert.deepEqual(MOLECULAR_REPRESENTATIONS.map(representation =>
    restingRows({ appearance: { representation } }).find(row => row.id === 'appearance').label), STYLE_LABELS.slice(0, 4));
  assert.equal(nextMolecularRepresentation(MOLECULAR_REPRESENTATIONS.at(-1)), MOLECULAR_REPRESENTATIONS[0]);
  const density = restingRows({ appearance: { representation: 'isosurface' } }).find(row => row.id === 'appearance');
  assert.equal(density.label, 'Density');
  assert.equal(density.state, true);
  const expanded = restingRows({ collapsed: false });
  const close = expanded.findIndex(row => row.id === 'menu');
  assert.deepEqual(expanded.slice(close + 1, close + 4).map(row => row.id), ['appearance', 'undo', 'redo']);
  for (const [name, text] of Object.entries(PAGES)) {
    const prose = text.replace(/\s+/gu, ' ');
    assert.match(prose, /\*\*Atoms\*\*.*\*\*Ribbons\*\*.*\*\*Spacefill\*\*.*\*\*Surface\*\*.*\*\*Atoms\*\*/u, name);
    assert.match(prose, /disabled \*\*Density\*\*/u, name);
    assert.match(prose, /\*\*Undo\*\* and \*\*Redo\*\*/u, name);
    assert.match(prose, /32.*source attachment|source attachment.*32/u, name);
  }
});

test('every passage naming room readings covers the exact room slot, including support states', () => {
  // Count complete room-state descriptions independently of paragraph wording.
  // QUICKSTART combines a listing and explanation; the headset reference
  // separates them; first-run describes the placement step.
  const expectedPassages = {
    'plugin/QUICKSTART.md': [2],
    'plugin/skills/stereo-structure/references/headsets.md': [1, 1],
    'docs/first-run-and-sharing.md': [1],
    'docs/headset-walkthrough.md': [],
  };
  for (const [name, text] of Object.entries(PAGES)) {
    const passages = text.split(/\n\s*\n/u).map(paragraph =>
      [...paragraph.matchAll(/`([^`]+)`|\*\*([^\n]+?)\*\*/gu)]
        .map(match => match[1] ?? match[2])
        .filter(label => /^(?:Room\b|No room\b)/u.test(label)))
      .filter(labels => labels.length > 0);
    const roomSlots = ROOM_LABELS.map(label => [3, 'room', label]);
    assert.deepEqual(passages.map(labels => labels.map(label => {
      const position = positionOf(label);
      return [position, RESTING_COLUMN[position]?.id, label];
    })), expectedPassages[name].map(count => Array.from({ length: count }, () => roomSlots).flat()),
    `${name}: each room-reading passage must include Room/Room on/Room off/No room/Room? at slot 3`);
  }
});

test('the tour row reads Tour, Play, Pause and Loading… by state, and no page calls it Start', () => {
  const label = tour => spatialToolbarRows({ collapsed: true, tour }).find(row => row.action.kind === 'tour-play').label;
  assert.equal(label(undefined), 'Tour');
  assert.equal(label({ active: true }), 'Play');
  assert.equal(label({ active: true, autoplay: true }), 'Pause');
  assert.equal(label({ active: true, navigating: true }), 'Loading…');
  for (const [name, text] of Object.entries(PAGES)) {
    assert.ok(!/`Start`|\*\*Start\*\* row/u.test(text), `${name} still names a Start row`);
  }
});

test('operator pages distinguish loaded-structure Tour from the explicit Tours chooser and describe the idle subject', () => {
  for (const [name, text] of Object.entries(PAGES)) {
    const prose = text.replace(/\s+/gu, ' ');
    assert.match(prose, /\*\*Tour\*\* (?:control )?starts the journey for the loaded structure/u, name);
    assert.match(prose, /4HHB starts the hemoglobin journey/u, name);
    assert.match(prose, /\*\*Tours\*\* opens the explicit chooser/u, name);
    assert.match(prose, /failed stage reports its reason and restores the previous source/u, name);
    assert.match(prose, /caption plate shows the loaded structure's title/u, name);
  }
});


test('the skill entrypoint directs headset operations to the checked reference', () => {
  const skill = page('plugin/skills/stereo-structure/SKILL.md');
  assert.match(skill, /\[Headset operation\]\(references\/headsets\.md\)/u);
});
