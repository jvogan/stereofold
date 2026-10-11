import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MENU_LABEL_BUDGET_CHARACTERS, menuResetActions, nextRenderQuality, RENDER_QUALITY_LEVELS, MOLECULAR_REPRESENTATIONS, nextMolecularRepresentation, shouldShowRoomWelcome, spatialToolbarRows, spatialToolbarRowIndex } from './spatial-toolbar-content.mjs';
import { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, hitToolbarPanel, toolbarDensity } from './spatial-toolbar-geometry.mjs';

import { menuAlpha, toolbarTextProps } from './spatial-toolbar-contrast.mjs';
import { COMPACT_TOUR_CASES, compactTourVariants, MID_CHAPTER_TOUR, FINAL_CHAPTER_TOUR } from './fixtures/tour-toolbar-contract.mjs';

// The identity head the emulated acceptance harness lays its targets out from.
const HEAD = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
const CONTROLLER_Z = -0.3;

const compact = state => spatialToolbarRows({ collapsed: true, mode: 'move', paused: true, tour: state });
const expanded = state => spatialToolbarRows({ collapsed: false, mode: 'move', paused: true, tour: state });

test('one molecular style row cycles live coordinate representations and skips unsupported choices', () => {
  const labels = ['Atoms', 'Ribbons', 'Spacefill', 'Surface'];
  for (const [index, representation] of MOLECULAR_REPRESENTATIONS.entries()) {
    assert.equal(nextMolecularRepresentation(representation), MOLECULAR_REPRESENTATIONS[(index + 1) % 4]);
    const rows = spatialToolbarRows({ appearance: { representation } });
    const row = rows.find(entry => entry.id === 'appearance');
    assert.equal(row.label, labels[index]);
    assert.deepEqual(row.action, { kind: 'appearance-cycle' });
    assert.equal(row.state, undefined);
    assert.ok(row.label.length <= MENU_LABEL_BUDGET_CHARACTERS);
    assert.ok(rows.indexOf(row) < rows.findIndex(entry => entry.id === 'molstar'));
  }
  const supported = ['molecular-surface', 'cartoon'];
  assert.equal(nextMolecularRepresentation('cartoon', supported), 'molecular-surface');
  assert.equal(nextMolecularRepresentation('molecular-surface', supported), 'cartoon');
  assert.equal(nextMolecularRepresentation('ball-and-stick', supported), 'cartoon');
  assert.equal(nextMolecularRepresentation('cartoon', []), undefined);
  const unavailable = spatialToolbarRows({ appearance: { representation: 'cartoon' }, representations: [] })
    .find(row => row.id === 'appearance');
  assert.equal(unavailable.state, true);
  const soleStyle = spatialToolbarRows({ appearance: { representation: 'cartoon' }, representations: ['cartoon'] })
    .find(row => row.id === 'appearance');
  assert.equal(soleStyle.state, true, 'the only supported style has no next choice');
});

test('density and unavailable history remain readable but cannot be pressed', () => {
  const rows = spatialToolbarRows({ collapsed: false, appearance: { representation: 'isosurface' },
    history: { canUndo: false, undoCount: 4, canRedo: false, redoCount: 3 } });
  const close = rows.findIndex(row => row.id === 'menu');
  assert.deepEqual(rows.slice(close + 1, close + 4).map(row => row.id), ['appearance', 'undo', 'redo']);
  assert.equal(rows.find(row => row.id === 'appearance').label, 'Density');
  const panel = createToolbarPanel({ rows, head: HEAD });
  for (const id of ['appearance', 'undo', 'redo']) {
    const button = panel.buttons.find(entry => entry.id === id);
    assert.equal(button.state, true);
    assert.equal(button.targetable, false);
    assert.equal(hitToolbarPanel(panel, {
      origin: [button.point[0], button.point[1], CONTROLLER_Z], direction: [0, 0, -1],
    }), undefined);
  }
  for (const history of [{ undoCount: 1, redoCount: 2 }, { canUndo: true, canRedo: true, undoCount: 0, redoCount: 0 }]) {
    const activeRows = spatialToolbarRows({ collapsed: false, history });
    for (const kind of ['undo', 'redo']) {
      assert.deepEqual(activeRows.find(row => row.id === kind).action, { kind });
      assert.equal(activeRows.find(row => row.id === kind).state, undefined);
    }
  }
});

test('style and history controls keep the existing compact and expanded geometry budgets', () => {
  const molecular = { appearance: { representation: 'cartoon' }, history: { canUndo: true, canRedo: true } };
  for (const state of compactTourVariants()) {
    const rows = spatialToolbarRows({ ...state, ...molecular });
    assert.ok(rows.length <= SPATIAL_TOOLBAR_LAYOUT.comfortRows);
    assert.equal(toolbarDensity(rows.length), 1);
    assert.equal(rows.some(row => row.id === 'undo' || row.id === 'redo'), false);
    const expandedState = { ...state, quiet: false, collapsed: false };
    assert.equal(spatialToolbarRows({ ...expandedState, ...molecular }).length, spatialToolbarRows(expandedState).length);
    assert.ok(rows.every(row => row.label.length <= MENU_LABEL_BUDGET_CHARACTERS));
    assert.deepEqual(rows.find(row => row.id === 'move'), spatialToolbarRows(state).find(row => row.id === 'move'));
  }
  const nearBudget = { voice: { state: 'idle' }, tour: { ...MID_CHAPTER_TOUR, canBack: false }, ...molecular };
  const compactRows = spatialToolbarRows(nearBudget);
  assert.equal(compactRows.some(row => row.id === 'appearance'), true);
  assert.equal(compactRows.some(row => row.id === 'molstar'), false);
  assert.equal(spatialToolbarRows({ ...nearBudget, tour: MID_CHAPTER_TOUR }).some(row => row.id === 'appearance'), false);
  const quiet = { ...molecular, quiet: true, tour: MID_CHAPTER_TOUR };
  assert.equal(spatialToolbarRows(quiet).some(row => ['appearance', 'undo', 'redo'].includes(row.id)), false);
  const sequence = { ...molecular, sequence: { open: true, rows: [{ id: 'sequence-entry', label: 'Chain A', action: { kind: 'sequence' } }] } };
  assert.equal(spatialToolbarRows(sequence).some(row => ['appearance', 'undo', 'redo'].includes(row.id)), false);
});

test('link recovery retains readable compact controls during full tour navigation', () => {
  const connection = { line: 'Link to the Mac lost.', recovery: true };
  for (const state of compactTourVariants()) {
    const rows = spatialToolbarRows({ ...state, connection, appearance: { representation: 'cartoon' } });
    assert.ok(rows.length <= SPATIAL_TOOLBAR_LAYOUT.comfortRows);
    assert.equal(toolbarDensity(rows.length), 1);
    assert.ok(rows.some(row => row.action.kind === 'reconnect'), 'Re-pair remains available');
    assert.ok(rows.some(row => row.action.kind === 'collapse'), 'Menu remains available');
  }
  const resting = spatialToolbarRows({ voice: { state: 'idle' }, connection });
  assert.ok(resting.some(row => row.label === 'No link'), 'the state light stays when the column has space');
  const navigating = spatialToolbarRows({ voice: { state: 'idle' }, connection, tour: MID_CHAPTER_TOUR });
  assert.equal(navigating.some(row => row.label === 'No link'), false, 'only the redundant disabled row yields');
  for (const kind of ['reconnect', 'recenter-structure', 'tour-back', 'tour-next', 'tour-page', 'passthrough'])
    assert.ok(navigating.some(row => row.action.kind === kind));
});

test('a row is resolvable by its exact label', () => {
  const rows = compact();
  // Labels are wearer-facing wording and get reworded; take them from the rows
  // rather than restating them, so this asserts lookup and not today's copy.
  rows.forEach((row, index) => assert.equal(spatialToolbarRowIndex(rows, row.label), index));
  assert.equal(spatialToolbarRowIndex(rows, 'A label no row carries'), -1);
});

test('a pointable voice row appears when a controller is attached', () => {
  const rows = spatialToolbarRows({ voice: { state: 'idle' }, collapsed: true });
  assert.equal(rows[0].label, 'Talk');
  assert.deepEqual(rows[0].action, { kind: 'voice-toggle' });
  assert.equal(spatialToolbarRowIndex(rows, { kind: 'voice-toggle' }), 0);
  // The row is the microphone's state light as well as its button. The
  // floating talk orb that used to carry the same state is gone, so this row
  // and the status line above the grid are all a wearer has to read the
  // microphone by.
  const pill = state => spatialToolbarRows({ voice: { state }, collapsed: true })[0];
  assert.equal(pill('listening').label, 'Mic on…');
  assert.equal(pill('recording').label, 'Mic on…');
  assert.equal(pill('transcribing').label, 'Hearing…');
  assert.equal(pill('playing').label, 'Reply…');
  assert.equal(pill('error').label, 'No voice');
  // Every reading of this row is a row WIDTH, and a row's width is what seats
  // the whole panel: see `MENU_LABEL_BUDGET_CHARACTERS`. The state readings
  // were `Listening…`, `Hearing you…`, `Answering…` and `Voice failed`, which
  // are 10 to 12 characters, so the microphone's own state used to widen the
  // menu past every other row the moment the wearer spoke.
  for (const state of ['idle', 'listening', 'recording', 'transcribing', 'playing', 'error']) {
    assert.ok(pill(state).label.length <= MENU_LABEL_BUDGET_CHARACTERS,
      `${pill(state).label} is past the ${MENU_LABEL_BUDGET_CHARACTERS} character budget.`);
  }
  // An open microphone stays pressable, because that press is how it closes.
  assert.equal(pill('listening').state, undefined);
  assert.equal(pill('listening').accent, true);
  // Work the wearer cannot interrupt reports instead, on the recessed plate.
  assert.equal(pill('transcribing').state, true);
  assert.equal(pill('transcribing').accent, undefined);
});

// Narration used to read `Answering…` on this row for the whole of a tour
// chapter. Nothing had been asked, so nothing was being answered, and the
// recessed plate said the microphone was busy when it was free to press.
test('tour narration is not reported as an answer to the wearer', () => {
  const row = state => spatialToolbarRows({ voice: state, collapsed: true })[0];
  const narrating = row({ state: 'playing', kind: 'narration' });
  assert.equal(narrating.label, 'Talk');
  // (`Reply…` and the other state readings are pinned, with the width rule
  // they answer to, in the test above.)
  // Pressable through the chapter: the press is how a wearer interrupts it.
  assert.equal(narrating.state, undefined);
  assert.equal(narrating.accent, true);
  // An answer the wearer did ask for still reports, and still recesses.
  assert.equal(row({ state: 'playing', kind: 'reply' }).label, 'Reply…');
  assert.equal(row({ state: 'playing', kind: 'reply' }).state, true);
  // A caller that reports no kind keeps the old behaviour.
  assert.equal(row({ state: 'playing' }).label, 'Reply…');
  // Narration never masks a real microphone state.
  assert.equal(row({ state: 'listening', kind: 'narration' }).label, 'Mic on…');
});

test('no label names the agent host, and none overruns its button plate', () => {
  // One build serves Claude Code, Codex and Claude Science. A label that
  // names one of them is wrong in the other two headsets.
  const states = [{ collapsed: true }, { collapsed: false }, { collapsed: false, mode: 'rotate' },
    { collapsed: true, paused: false }, { collapsed: false, paused: false },
    { collapsed: true, voice: { state: 'idle' } }, { collapsed: true, voice: { state: 'listening' } },
    { collapsed: true, voice: { state: 'sending' } },
    { collapsed: true, tour: { menuOpen: true } },
    { collapsed: true, passthrough: true }, { collapsed: true, passthrough: false },
    { collapsed: true, tour: { active: true, autoplay: true, selectedId: 'g', canBack: true, canNext: true, bodyPageCount: 4, bodyPageIndex: 0 } },
    // The row's width depends on the tour's page COUNT: bodyPageCount 4 draws
    // `Page 1/4` at eight characters while the crispr-cas9 lesson draws
    // `Page 1/50` at nine. Vary it, at the widest two-digit seat, so the budget
    // assertion below catches an overrun here rather than in the headset.
    { collapsed: true, tour: { active: true, autoplay: true, selectedId: 'g', canBack: true, canNext: true, bodyPageCount: 50, bodyPageIndex: 49 } },
    { collapsed: true, tour: { navigating: true, selectedId: 'g' } }];
  for (const state of states) {
    for (const row of spatialToolbarRows(state)) {
      assert.doesNotMatch(row.label, /codex|claude|anthropic|openai|chatgpt/i,
        `${row.label} names an agent host.`);
      // Not "fits a plate" any more. A row's width is what seats the whole
      // panel -- `toolbarSeatDegrees` solves the bearing from the widest
      // label, so every character past this budget drags the menu inboard
      // across the structure. Twelve characters is where the rows cleared only
      // 13.9 degrees against a 16 degree cone; eight is where they clear it.
      assert.ok(row.label.length <= MENU_LABEL_BUDGET_CHARACTERS,
        `${row.label} is ${row.label.length} characters, past the ${MENU_LABEL_BUDGET_CHARACTERS} the seat is solved for.`);
    }
  }
});

test('the caption page row fits the label budget at any page count', () => {
  // The row sits under the caption glass it pages, so the wearer reads `Pg`
  // as the caption's own page: `Pg 1/50` is page one of fifty. Every count a
  // lesson reaches, widest seat included, stays inside the budget the panel
  // seat is solved for.
  for (const bodyPageCount of [2, 9, 10, 50, 99]) {
    for (const bodyPageIndex of [0, bodyPageCount - 1]) {
      const rows = spatialToolbarRows({ collapsed: true,
        tour: { active: true, selectedId: 'g', canBack: true, canNext: true, bodyPageCount, bodyPageIndex } });
      const index = spatialToolbarRowIndex(rows, { kind: 'tour-page' });
      assert.ok(index >= 0, `no caption page row at count ${bodyPageCount}.`);
      assert.ok(rows[index].label.length <= MENU_LABEL_BUDGET_CHARACTERS,
        `${rows[index].label} is ${rows[index].label.length} characters, past the ${MENU_LABEL_BUDGET_CHARACTERS} the seat is solved for.`);
    }
  }
  assert.equal(spatialToolbarRowIndex(
    spatialToolbarRows({ collapsed: true, tour: { active: true, selectedId: 'g', bodyPageCount: 50, bodyPageIndex: 0 } }),
    { kind: 'tour-page' }) >= 0, true);
});

test('caption paging stays off plain entry and returns with a visible card or tour', () => {
  const plain = spatialToolbarRows({ collapsed: true, tour: {
    selectedId: 'g', active: false, captionCard: 'hidden', bodyPageCount: 8, bodyPageIndex: 0,
  } });
  assert.equal(spatialToolbarRowIndex(plain, { kind: 'tour-page' }), -1);

  const card = spatialToolbarRows({ collapsed: true, tour: {
    selectedId: 'g', active: false, captionCard: 'shown', bodyPageCount: 8, bodyPageIndex: 0,
  } });
  assert.equal(card.find(row => row.action.kind === 'tour-page')?.label, 'Pg 1/8');

  const tour = spatialToolbarRows({ collapsed: true, tour: {
    selectedId: 'g', active: true, captionCard: 'shown', bodyPageCount: 8, bodyPageIndex: 0,
  } });
  assert.equal(tour.find(row => row.action.kind === 'tour-page')?.label, 'Pg 1/8');
});

test('entry actions name the tour and the menu movement', () => {
  const rows = compact();
  assert.deepEqual(rows.map(row => row.label), ['Tour', 'Reset', 'Room', 'Mol*', 'Menu']);
  assert.equal(rows.find(row => row.action.kind === 'tour-play')?.label, 'Tour');
  assert.equal(rows.some(row => row.action.kind === 'recenter-menu'), false);
  assert.equal(expanded().find(row => row.action.kind === 'recenter-menu')?.label, 'Re-seat');
  assert.ok('Move menu'.length <= MENU_LABEL_BUDGET_CHARACTERS,
    'The menu movement names its target within the measured label budget.');
  assert.equal(spatialToolbarRows({ collapsed: true,
    tour: { selectedId: 'g', active: true, autoplay: false, canNext: true } })
    .find(row => row.action.kind === 'tour-play')?.label, 'Play');
});

test('the primary action of a state is marked for the brighter plate', () => {
  const accents = state => spatialToolbarRows(state).filter(row => row.accent).map(row => row.action.kind);
  assert.deepEqual(accents({ collapsed: true, voice: { state: 'idle' } }), ['voice-toggle', 'tour-play', 'collapse']);
  assert.deepEqual(accents({ collapsed: false }), ['tour-play', 'collapse']);
  // A row that only reports state is never also an accent: it is not a button.
  for (const row of spatialToolbarRows({ collapsed: true, voice: { state: 'sending' } })) {
    assert.ok(!(row.state && row.accent), `${row.label} is both a status row and a primary action.`);
  }
});

test('a row is resolvable by a subset of its action fields', () => {
  const rows = expanded();
  const action = query => rows[spatialToolbarRowIndex(rows, query)]?.action;
  assert.deepEqual(action({ kind: 'scale', direction: 1 }), { kind: 'scale', direction: 1 });
  assert.deepEqual(action({ kind: 'scale', direction: -1 }), { kind: 'scale', direction: -1 });
  assert.deepEqual(action({ kind: 'nudge', axis: 'x', direction: 1 }), { kind: 'nudge', axis: 'x', direction: 1, mode: 'move' });
  assert.deepEqual(action({ kind: 'collapse', value: true }), { kind: 'collapse', value: true });
  assert.deepEqual(action({ kind: 'fit' }), { kind: 'fit' });
  // A partial query matches the first row carrying every field it names.
  assert.equal(spatialToolbarRowIndex(rows, { kind: 'nudge' }), spatialToolbarRowIndex(rows, { kind: 'nudge', axis: 'x', direction: -1 }));
});

test('an absent row reports -1 rather than a neighbouring control', () => {
  const rows = compact();
  for (const query of [{ kind: 'tour-back' }, { kind: 'tour-next' }, { kind: 'tour-page' }, { kind: 'scale', direction: 1 },
    'Scale +', {}, null, undefined, 7, { kind: 'nudge', axis: 'x', direction: 9 }]) {
    assert.equal(spatialToolbarRowIndex(rows, query), -1, `${JSON.stringify(query)} resolved to a row it does not name.`);
  }
  assert.equal(spatialToolbarRowIndex(undefined, { kind: 'fit' }), -1);
});

test('the final chapter keeps quiet navigation and menu movement, with Done hittable', () => {
  // Gemini's 91bdaff review: wall-05 dropped Next and the menu jumped from
  // Talk/Play/Next/Menu to Talk/Play/Menu. The last chapter keeps the seat
  // as an actionable Done so the footprint does not change.
  const mid = MID_CHAPTER_TOUR;
  const last = FINAL_CHAPTER_TOUR;
  const voice = { state: 'idle' };
  const midRows = spatialToolbarRows({ collapsed: true, quiet: true, voice, tour: mid });
  const lastRows = spatialToolbarRows({ collapsed: true, quiet: true, voice, tour: last });
  assert.equal(midRows.length, lastRows.length);
  assert.deepEqual(midRows.map(row => row.label), ['Talk', 'Play', 'Next', 'Menu']);
  assert.deepEqual(lastRows.map(row => row.label), ['Talk', 'Play', 'Done', 'Menu']);
  const done = lastRows.find(row => row.label === 'Done');
  assert.equal(done.state, undefined);
  assert.deepEqual(done.action, { kind: 'tour-done' });
  assert.equal(done.accent, undefined);
  assert.ok(done.label.length <= MENU_LABEL_BUDGET_CHARACTERS);
  const next = midRows.find(row => row.label === 'Next');
  assert.equal(next.state, undefined);
  assert.deepEqual(next.action, { kind: 'tour-next' });
  const lastPanel = createToolbarPanel({ rows: lastRows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
  const doneButton = lastPanel.buttons.find(button => button.label === 'Done');
  assert.equal(doneButton.targetable, true);
  assert.equal(doneButton.style, 'action');
  const hit = hitToolbarPanel(lastPanel, {
    origin: [doneButton.point[0], doneButton.point[1], CONTROLLER_Z], direction: [0, 0, -1],
  });
  assert.equal(hit?.action.kind, 'tour-done', 'a ray at Done can end the tour');
  // Compact (not quiet) last chapter keeps the same Next-sized seat.
  const compactLast = spatialToolbarRows({ collapsed: true, tour: last });
  assert.ok(compactLast.some(row => row.label === 'Done' && row.state !== true && row.action.kind === 'tour-done'));
  assert.equal(compactLast.some(row => row.action.kind === 'tour-next'), false);
});

test('a full tier row and a refusal row wrap inside the unchanged caption glass', () => {
  // `Protofilament 1/5` and `Wall · Quest 2 limit` are caption rows, not menu
  // rows, so the eight-character menu budget never
  // trims them. The caption glass wraps them instead, and the plate width
  // never changes. Same rows under all three, so only the readout varies.
  const rows = compact({ active: true, selectedId: 'g', canBack: true, canNext: true });
  const panelFor = readout => createToolbarPanel({ rows, head: HEAD,
    constants: SPATIAL_TOOLBAR_LAYOUT, readout });
  const short = panelFor([{ text: 'Three wide', maxLines: 1 },
    { text: 'Wall 1/5', maxLines: 2, optional: true, dropRank: 4 },
    { text: 'Beta tubulin joins in amber.' }]);
  const proto = panelFor([{ text: 'Two across', maxLines: 1 },
    { text: 'Protofilament 1/5', maxLines: 2, optional: true, dropRank: 4 },
    { text: 'Beta tubulin joins in amber.' }]);
  const limit = panelFor([{ text: 'Limit reached', maxLines: 1 },
    { text: 'Wall · Quest 2 limit', maxLines: 2, optional: true, dropRank: 4 },
    { text: 'Too big for this headset. Staying here.' }]);
  assert.equal(proto.captionBacking.halfWidth, short.captionBacking.halfWidth);
  assert.equal(limit.captionBacking.halfWidth, short.captionBacking.halfWidth);
  for (const line of [...proto.readoutPoints, ...limit.readoutPoints]) {
    assert.ok(!line.text.endsWith('…'), `${line.text} was clipped.`);
  }
  assert.ok(proto.readoutPoints.map(line => line.text).join(' ').includes('Protofilament 1/5'));
  assert.ok(limit.readoutPoints.map(line => line.text).join(' ').includes('Wall · Quest 2 limit'));
  assert.ok(limit.readoutPoints.map(line => line.text).join(' ').includes('Limit reached'));
});

test('the resolved index survives rows appearing and disappearing with tour state', () => {
  // Every one of these is a state the wearer reaches through the tour rows, and
  // each adds or removes a row above the controls beneath it.
  const states = [
    undefined,
    { menuOpen: true },
    { selectedId: 'guided', bodyPageCount: 2, bodyPageIndex: 0 },
    { active: true, selectedId: 'guided', canBack: false, canNext: true, bodyPageCount: 3, bodyPageIndex: 0 },
    { active: true, selectedId: 'guided', canBack: true, canNext: true, bodyPageCount: 1, bodyPageIndex: 0 },
    { active: true, selectedId: 'guided', canBack: true, canNext: false, bodyPageCount: 2, bodyPageIndex: 1 },
  ];
  const seen = new Set();
  for (const tour of states) {
    for (const rows of [compact(tour), expanded(tour)]) {
      seen.add(rows.length);
      const panel = createToolbarPanel({ rows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
      assert.equal(panel.buttons.length, rows.length);
      // Both controls are present in every state, so a caller that pins an
      // index instead of resolving one presses the wrong row as rows shift.
      for (const query of [{ kind: 'tour-play' }, { kind: 'collapse' }]) {
        const index = spatialToolbarRowIndex(rows, query);
        assert.ok(index >= 0, `${JSON.stringify(query)} is missing from ${JSON.stringify(rows.map(row => row.label))}.`);
        const button = panel.buttons[index];
        const hit = hitToolbarPanel(panel, { origin: [button.point[0], button.point[1], CONTROLLER_Z], direction: [0, 0, -1] });
        assert.equal(hit, button, `A ray at the resolved ${button.label} target hits ${hit?.label ?? 'nothing'}.`);
      }
    }
  }
  assert.ok(seen.size > 1, 'These tour states must produce differing row counts for this test to mean anything.');
});

test('the room welcome is a first-run hint and ends at the first press', () => {
  assert.equal(shouldShowRoomWelcome(), true);
  assert.equal(shouldShowRoomWelcome({ voice: { state: 'idle' } }), true);
  // A claimed menu press, a held A or X, or any tour of its own.
  assert.equal(shouldShowRoomWelcome({ engaged: true }), false);
  for (const state of ['starting', 'listening', 'sending', 'playing']) {
    assert.equal(shouldShowRoomWelcome({ voice: { state } }), false, `${state} left the welcome up.`);
  }
  for (const tour of [{ menuOpen: true }, { selectedId: 'guided' }, { active: true }]) {
    assert.equal(shouldShowRoomWelcome({ tour }), false, `${JSON.stringify(tour)} left the welcome up.`);
  }
});

test('the passthrough row reads the session the wearer is in', () => {
  // The two blend modes are separate WebXR sessions, and crossing
  // between them drops immersion for a moment. A wearer deciding whether to
  // press has to be able to see which one they are already in first.
  const passthroughRow = passthrough => {
    const rows = spatialToolbarRows({ collapsed: true, ...(passthrough === undefined ? {} : { passthrough }) });
    return rows[rows.findIndex(row => row.action?.kind === 'passthrough')];
  };
  const on = passthroughRow(true);
  const off = passthroughRow(false);
  assert.equal(on.label, 'Room on');
  assert.equal(off.label, 'Room off');
  // Both readings are row WIDTHS before they are words. `Room shown` and
  // `Room hidden` were 10 and 11 characters, and the widest row is what
  // `toolbarSeatDegrees` solves the panel's bearing from, so this row alone
  // used to decide how far across the structure the whole menu sat.
  for (const row of [on, off]) {
    assert.ok(row.label.length <= MENU_LABEL_BUDGET_CHARACTERS,
      `${row.label} is ${row.label.length} characters, past the ${MENU_LABEL_BUDGET_CHARACTERS} the seat is solved for.`);
  }
  // The press is still the opposite of the state, carried explicitly so a
  // repeated command cannot flip it back.
  assert.deepEqual(on.action, { kind: 'passthrough', on: false });
  assert.deepEqual(off.action, { kind: 'passthrough', on: true });
  // A caller that knows no state gets the feature name and a plain toggle.
  const unknown = passthroughRow(undefined);
  assert.equal(unknown.label, 'Room');
  assert.deepEqual(unknown.action, { kind: 'passthrough' });
});

test('the room row is honest when immersive AR is unavailable', () => {
  const unsupported = spatialToolbarRows({ collapsed: true, passthrough: false, passthroughSupported: false })
    .find(row => row.action?.kind === 'passthrough');
  assert.deepEqual(unsupported, { id: 'room', label: 'No room', action: { kind: 'passthrough', on: true }, state: true });
  const unknown = spatialToolbarRows({ collapsed: true, passthrough: false, passthroughSupported: null })
    .find(row => row.action?.kind === 'passthrough');
  assert.deepEqual(unknown, { id: 'room', label: 'Room?', action: { kind: 'passthrough', on: true }, state: true });
});

test('one row reads the render budget and cycles it', () => {
  // A coarse molecular surface has to be fixable from inside the headset, so
  // the render budget is a menu setting.
  const qualityRow = quality => {
    const rows = spatialToolbarRows({ collapsed: false, ...(quality === undefined ? {} : { quality }) });
    return rows[rows.findIndex(row => row.action?.kind === 'render-quality')];
  };
  assert.deepEqual(RENDER_QUALITY_LEVELS, ['fast', 'balanced', 'best']);
  // The label reads the level the renderer is on; the press carries the next
  // one explicitly, so a tap cycles while a repeated spoken or agent command
  // stays idempotent.
  const cycle = { fast: 'balanced', balanced: 'best', best: 'fast' };
  for (const [level, next] of Object.entries(cycle)) {
    const row = qualityRow(level);
    assert.ok(row, `no quality row at ${level}`);
    // The level is a NUMBER, not a word, because `Quality: Balanced` is
    // seventeen characters and `Quality: mid` twelve: this row's width is one
    // of the inputs `toolbarSeatDegrees` seats the panel from. The desktop
    // select and the spoken confirmation say the level in full.
    assert.equal(row.label, { fast: 'Detail 1', balanced: 'Detail 2', best: 'Detail 3' }[level]);
    assert.ok(row.label.length <= MENU_LABEL_BUDGET_CHARACTERS,
      `${row.label} is ${row.label.length} characters, past the ${MENU_LABEL_BUDGET_CHARACTERS} the seat is solved for.`);
    assert.deepEqual(row.action, { kind: 'render-quality', level: next });
    assert.equal(nextRenderQuality(level), next);
  }
  // Three taps come back to where they started, and only one quality row ever
  // exists: the panel is not the place to grow a settings screen.
  assert.equal(nextRenderQuality(nextRenderQuality(nextRenderQuality('fast'))), 'fast');
  assert.equal(spatialToolbarRows({ collapsed: false, quality: 'best' })
    .filter(row => row.action?.kind === 'render-quality').length, 1);
  // A level this module does not know resolves to the default rather than to
  // the cheapest tier.
  assert.equal(nextRenderQuality('ultra'), 'balanced');
  assert.equal(nextRenderQuality(undefined), 'balanced');
  // A viewer with no render-budget lever passes no level, and gets no row: an
  // unwired setting is worse than no setting. The compact panel never carries
  // it either — those rows are the ones a lost wearer presses.
  assert.equal(qualityRow(undefined), undefined);
  assert.equal(spatialToolbarRows({ collapsed: false, quality: 'ultra' })
    .some(row => row.action?.kind === 'render-quality'), false);
  assert.equal(spatialToolbarRows({ collapsed: true, quality: 'best' })
    .some(row => row.action?.kind === 'render-quality'), false);
  // And it does not name a host or overrun the plate in any of its states.
  for (const level of RENDER_QUALITY_LEVELS) for (const row of spatialToolbarRows({ collapsed: false, quality: level })) {
    assert.ok(row.label.length <= 12, `${row.label} is too long for one button plate.`);
  }
  // The extra row still lays out and is still pressable: a control a ray
  // cannot claim is a control the wearer does not have.
  for (const level of RENDER_QUALITY_LEVELS) {
    const rows = spatialToolbarRows({ collapsed: false, quality: level });
    const panel = createToolbarPanel({ rows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
    assert.equal(panel.buttons.length, rows.length);
    const button = panel.buttons[spatialToolbarRowIndex(rows, { kind: 'render-quality' })];
    const hit = hitToolbarPanel(panel, { origin: [button.point[0], button.point[1], CONTROLLER_Z], direction: [0, 0, -1] });
    assert.equal(hit, button, `A ray at the ${button.label} target hits ${hit?.label ?? 'nothing'}.`);
  }
});

test('a reset view shows the menu without opening the expanded grid', () => {
  // The reset used to force `collapse: false`, and the two-column grid landed
  // over the structure it had just re-seated and ran off the left eye.
  const expandedMenu = menuResetActions({ hidden: false, collapsed: false });
  const compactMenu = menuResetActions({ hidden: false, collapsed: true });
  for (const actions of [expandedMenu, compactMenu]) {
    assert.deepEqual(actions, [{ kind: 'recenter-menu' }], 'a visible menu keeps the form the wearer chose');
  }
  // A menu that was hidden has no form the wearer chose, so it comes back in
  // the one a wearer who is already lost can read.
  assert.deepEqual(menuResetActions({ hidden: true, collapsed: false }),
    [{ kind: 'collapse', value: true }, { kind: 'recenter-menu' }]);
  assert.deepEqual(menuResetActions({ hidden: true, collapsed: true }), [{ kind: 'recenter-menu' }]);
  // Whatever the state, the reset never opens the grid, and it always re-seats.
  for (const hidden of [true, false]) for (const collapsed of [true, false]) {
    const actions = menuResetActions({ hidden, collapsed });
    assert.equal(actions.at(-1).kind, 'recenter-menu');
    assert.ok(!actions.some(action => action.kind === 'collapse' && action.value === false),
      `hidden=${hidden} collapsed=${collapsed} expanded the menu`);
  }
  // The default is a caller with no menu state at all: re-seat, nothing else.
  assert.deepEqual(menuResetActions(), [{ kind: 'recenter-menu' }]);
});


test('final Done uses active-button paint and only waits during navigation', () => {
  for (const quiet of [false, true]) {
    const button = (tour, label) => createToolbarPanel({ head: HEAD,
      rows: spatialToolbarRows({ quiet, voice: { state: 'idle' }, tour }) }).buttons.find(row => row.label === label);
    const done = button(FINAL_CHAPTER_TOUR, 'Done'), next = button(MID_CHAPTER_TOUR, 'Next');
    assert.equal(done.style, 'action');
    assert.equal(done.style, next.style);
    assert.equal(done.state, undefined);
    assert.equal(done.accent, undefined);
    const props = toolbarTextProps(menuAlpha(quiet).labels);
    assert.equal(props.alpha, quiet ? 0.55 : 1);
    assert.equal(props.borderWidth, 0);
    assert.equal(props.background, false);
    const navigating = button({ ...FINAL_CHAPTER_TOUR, navigating: true }, 'Done');
    assert.equal(navigating.style, 'state');
    assert.equal(navigating.targetable, false);
  }
});

test('every compact tour state keeps the full-size row budget', () => {
  for (const { tour, labels } of COMPACT_TOUR_CASES)
    assert.deepEqual(spatialToolbarRows({ tour, voice: { state: 'idle' }, collapsed: true }).map(row => row.label), labels);
  for (const state of compactTourVariants()) {
    const rows = spatialToolbarRows(state);
    assert.ok(rows.length <= SPATIAL_TOOLBAR_LAYOUT.comfortRows);
    assert.equal(toolbarDensity(rows.length), 1);
    assert.ok(SPATIAL_TOOLBAR_LAYOUT.fontMeters >= 0.050);
  }
});

test('early Done stays under Menu without adding an expanded column', () => {
  const rows = spatialToolbarRows({ collapsed: false, voice: { state: 'idle' }, tour: MID_CHAPTER_TOUR });
  assert.equal(rows.filter(row => row.action.kind === 'tour-done').length, 1);
  assert.equal(rows.find(row => row.action.kind === 'tour-done').state, undefined);
  assert.ok(rows.some(row => row.action.kind === 'tour-next'));
  assert.ok(rows.length <= 2 * SPATIAL_TOOLBAR_LAYOUT.maxRows);
  assert.ok(spatialToolbarRows({ collapsed: false }).some(row => row.action.kind === 'tour-menu'));
});

test('plain sessions keep Tour available for a matching journey or a truthful no-match response', () => {
  const tour = { active: false, menuOpen: false, feedbackError: true, feedback: 'No journey for 2XYZ yet' };
  const rows = spatialToolbarRows({ tour, collapsed: true });
  assert.equal(rows.find(row => row.id === 'tour').label, 'Tour');
  assert.equal(rows.find(row => row.id === 'tour').state, undefined);
  assert.ok(!rows.some(row => ['back', 'next', 'done', 'page', 'tours'].includes(row.id)));
  assert.equal(spatialToolbarRows({ tour, collapsed: false }).find(row => row.id === 'tours').label, 'Tours');
});


test('authored mixed figures report Figure until a wearer chooses a global representation', () => {
  const state = { appearance: { representation: 'spacefill', opacity: .02 }, lessonFigure: { layers: 3 } };
  const authored = spatialToolbarRows(state).find(row => row.id === 'appearance');
  assert.equal(authored.label, 'Figure');
  assert.deepEqual(authored.action, { kind: 'appearance-cycle' });
  for (const [representationOverride, label] of [['ball-and-stick', 'Atoms'], ['cartoon', 'Ribbons'], ['spacefill', 'Spacefill'], ['molecular-surface', 'Surface']]) {
    const row = spatialToolbarRows({ ...state, lessonFigure: { ...state.lessonFigure, representationOverride } }).find(row => row.id === 'appearance');
    assert.equal(row.label, label, 'visible figure override wins over the faint base representation');
  }
});
