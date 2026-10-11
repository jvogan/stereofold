import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { boundStatusLines, createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT, TOOLBAR_READING_RANGE_METERS, toolbarMenuPoints, toolbarBackingOutline, toolbarLayoutForStandoff } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { screenRectFromPoints } from './label-layout.mjs';
// spatial-toolbar.mjs pulls molstar, which the main tree resolves only under plugin/;
// the readout tests are skipped where the package is out of reach.
let tourReadout;
try { ({ tourReadout } = await import('./spatial-toolbar.mjs')); } catch { tourReadout = undefined; }
const needsReadout = { skip: tourReadout ? false : 'molstar is not resolvable from this tree' };

// The identity head the deterministic layout tests lay their panels out from.
const HEAD = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
const menuRows = count => Array.from({ length: count }, (_, index) => ({ label: `Control ${index}`, action: { index } }));
const words = value => value.replace(/…$/u, '').trimEnd().split(/\s+/u).filter(Boolean);
const REFUSAL = 'Filament tier has no atoms. Switch to an atomic tier.';
const shippedRows = spatialToolbarRows({
  tour: { selectedId: 'microtubule-growth-filament', bodyPageCount: 40, bodyPageIndex: 0 },
  voice: { state: 'replying' }, passthrough: true,
});

test('empty rows return no toolbar panel', () => {
  for (const status of ['', 'Listening…', REFUSAL]) {
    assert.equal(createToolbarPanel({ rows: [], head: HEAD, status,
      readout: [{ text: 'Tour caption' }] }), undefined,
    'empty rows return undefined before calculating geometry');
  }
});

for (const [name, status, floor] of [
  ['blank status', '', 0.4544],
  ['one status line', 'Listening…', 0.4544],
  ['multiline status', REFUSAL, 0.5224],
]) {
  test(`nine-row tour caption floor preserves the parent with ${name}`, () => {
    const panel = createToolbarPanel({ rows: menuRows(9), head: HEAD, status,
      readout: [{ text: 'Tour caption' }] });
    assert.ok(Math.abs(panel.captionEnvelope.floor - floor * TOOLBAR_READING_RANGE_METERS / .95) < 1e-12,
      `nine-row tour caption floor keeps its angular spacing with ${name}`);
  });
}

test('blank captions draw no cards, and a refusal leaves no empty backing over the menu', () => {
  for (const collapsed of [true, false]) {
    const rows = spatialToolbarRows({ collapsed, voice: { state: 'idle' },
      tour: { active: true, selectedId: 'microtubule-growth-filament', step: 0, total: 5 } });
    const empty = createToolbarPanel({ rows, head: HEAD });
    for (const text of ['', '   ', '\n\t']) {
      const blank = createToolbarPanel({ rows, head: HEAD, status: text, readout: [{ text }] });
      assert.equal(blank.captionBacking, undefined);
      assert.equal(blank.statusBacking, undefined);
      assert.deepEqual(blank.statusPoints, []);
      assert.deepEqual(blank.readoutPoints, []);
      assert.deepEqual(blank.backing, empty.backing);
    }
    // Acceptance 3 density/ring-refusal-a #803 rejects Mol*, #808 records
    // this entire reply. Its old status extent must not inflate menu glass.
    const refusal = createToolbarPanel({ rows, head: HEAD, status: REFUSAL });
    assert.deepEqual(refusal.backing, empty.backing);
    assert.deepEqual(refusal.buttons, empty.buttons);
    assert.equal(refusal.statusPoints.map(line => line.text).join(' '), REFUSAL);
    for (const eyeX of [-0.032, 0.032]) {
      const seat = { eye: [eyeX, 1.6, 0], target: [eyeX, 1.6, -1] };
      const menu = screenRectFromPoints({ points: toolbarMenuPoints(refusal), ...seat });
      const card = screenRectFromPoints({ points: toolbarBackingOutline(refusal, { plate: refusal.statusBacking }), ...seat });
      assert.ok(disjoint(menu, card), 'the reply card is outside the menu in both eyes');
    }
  }
});

test('resting rows fit their shipped column without a clipped label', () => {
  const rows = spatialToolbarRows();
  const panel = createToolbarPanel({ rows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
  const glyphWidth = label => [...label].length * panel.fontMeters * SPATIAL_TOOLBAR_LAYOUT.glyphAspect;
  const geometryBudget = Math.floor((2 * (
    SPATIAL_TOOLBAR_LAYOUT.columnStepMeters * SPATIAL_TOOLBAR_LAYOUT.maxColumnHalfWidthFactor
    - SPATIAL_TOOLBAR_LAYOUT.rowPadMeters
  )) / (SPATIAL_TOOLBAR_LAYOUT.fontMeters * SPATIAL_TOOLBAR_LAYOUT.glyphAspect));

  assert.equal(panel.density, 1);
  assert.equal(geometryBudget, 10);
  for (const [index, row] of rows.entries()) {
    const button = panel.buttons[index];
    const available = 2 * (button.halfWidth - SPATIAL_TOOLBAR_LAYOUT.rowPadMeters);
    assert.ok(Math.max(...(row.labelLines ?? [row.label]).map(glyphWidth)) <= available + 1e-9,
      `${row.label} exceeds the ${available.toFixed(4)} m row width.`);
    assert.ok(row.label.length <= geometryBudget, `${row.label} exceeds the ${geometryBudget}-glyph budget.`);
    assert.doesNotMatch(row.label, /…$/u, `${row.label} is already ellipsized.`);
  }
});

test('the shipped status keeps the entire filament refusal and twelve-word answers', () => {
  const listening = createToolbarPanel({ rows: shippedRows, head: HEAD, status: 'Listening…' });
  for (const status of [REFUSAL,
    'Switch the molecular representation to atomic detail before selecting individual carbon atoms.',
    'Molecular-representation configuration preserves protofilament reconstruction measurements while individual molecular components remain unavailable.']) {
    const panel = createToolbarPanel({ rows: shippedRows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT, status });
    const drawn = panel.statusPoints.map(line => line.text).join(' ');
    assert.equal(drawn.includes('…'), false);
    assert.deepEqual(words(drawn), words(status));
    assert.deepEqual(panel.buttons, listening.buttons, 'display text never moves a ray target');
    assert.equal(panel.statusPoints.at(-1).point[1], listening.statusPoints[0].point[1], 'lines grow above Listening…');
    for (const line of panel.statusPoints) {
      const halfWidth = line.text.length * panel.fontMeters * SPATIAL_TOOLBAR_LAYOUT.glyphAspect / 2;
      const dx = line.point.reduce((sum, v, i) => sum + (v - panel.statusBacking.point[i]) * panel.right[i], 0);
      assert.ok(Math.abs(dx) + halfWidth < panel.statusBacking.halfWidth, 'glass covers the full glyph run');
      assert.ok(Math.abs(line.point[1] - panel.statusBacking.point[1]) + panel.fontMeters / 2 < panel.statusBacking.halfHeight);
    }
  }
});

test('the reply clears the solver menu rectangle in both eyes', () => {
  const panel = createToolbarPanel({ rows: shippedRows, head: HEAD, status: REFUSAL });
  const top = panel.statusPoints[0];
  const halfWidth = top.text.length * panel.fontMeters * SPATIAL_TOOLBAR_LAYOUT.glyphAspect / 2;
  const corners = [-1, 1].flatMap(x => [-1, 1].map(y => top.point.map((v, i) =>
    v + x * halfWidth * panel.right[i] + y * panel.fontMeters / 2 * panel.up[i] - 0.012 * panel.normal[i])));
  for (const eyeX of [-0.032, 0.032]) {
    const seat = { eye: [eyeX, 1.6, 0], target: [eyeX, 1.6, -1] };
    // Same projection and point provider that viewer.componentLabelLayout
    // hands to layoutComponentPlates; identity room-to-scene transform here.
    const menu = screenRectFromPoints({ points: toolbarMenuPoints(panel), ...seat });
    const text = screenRectFromPoints({ points: corners, ...seat });
    assert.ok(disjoint(menu, text), 'reply text is outside the menu column');
  }
});

test('the real filament lesson ends on a word and ellipsis under a shared readout budget', () => {
  const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/microtubule-growth/filament.json', import.meta.url)));
  const panel = createToolbarPanel({ rows: shippedRows, head: HEAD,
    constants: { ...SPATIAL_TOOLBAR_LAYOUT, maxReadoutLines: 3 },
    readout: [{ text: lesson.title }, { text: '5 scenes ready' }, { text: lesson.provenance.note }] });
  const drawn = panel.readoutPoints.map(line => line.text);
  assert.equal(drawn.length, 3);
  assertWholeWordCut(drawn.at(-1), lesson.provenance.note);
});

/** The kept text before an ellipsis must end on a word boundary of the source. */
const assertWholeWordCut = (line, source) => {
  assert.ok(line.endsWith('…'), `a cut line ends in an ellipsis, got ${JSON.stringify(line)}`);
  const flat = source.replace(/\s+/gu, ' ').trim();
  const kept = line.slice(0, -1).trimEnd();
  const at = flat.indexOf(kept);
  assert.notEqual(at, -1, `the cut ${JSON.stringify(kept)} is not a prefix of the source`);
  const next = flat[at + kept.length];
  assert.ok(next === undefined || /\s/u.test(next),
    `the ellipsis cut inside a word: ${JSON.stringify(line)} of ${JSON.stringify(source)}`);
};

test('a spoken line wraps to the plate width and is never cut mid-word', () => {
  // A plain width cut draws "Six copies of the / Taxol-stabilise" -- the
  // ellipsis budget spends its last character inside a hyphenated word. Every
  // cut below lands after a whole word instead.
  const line = 'As a surface, the new strand binds along the side: a patch of wall, not a closed tube.';
  const sourceWords = line.split(' ');
  for (let width = 8; width <= 30; width += 1) {
    for (let maxLines = 1; maxLines <= 6; maxLines += 1) {
      const lines = boundStatusLines(line, width, maxLines);
      assert.ok(lines.length >= 1 && lines.length <= maxLines, JSON.stringify(lines));
      // Nothing is lost out of order: the rows carry the source's words, in
      // order, up to the one place a cut may end them.
      const kept = lines.flatMap(row => words(row));
      kept.forEach((word, index) => assert.equal(word, sourceWords[index],
        `row ${index + 1} is not the source's own word order: ${JSON.stringify(lines)}`));
      // A cut lives only at the end of the block, and lands after a word.
      lines.slice(0, -1).forEach(row => assert.ok(!row.endsWith('…'), JSON.stringify(lines)));
      const last = lines.at(-1);
      if (last.endsWith('…')) assertWholeWordCut(last, line);
    }
  }
  // The exact cases from the captures: no "Taxol-stabilise", no "along the"
  // ending mid-thought on a word's middle.
  assert.deepEqual(boundStatusLines('new strand binds along the side', 15, 1), ['new strand…']);
  const hyphen = boundStatusLines('Six copies of the Taxol-stabilised dimer', 15, 2);
  for (const row of hyphen) if (row.endsWith('…')) assert.notEqual(row, 'Taxol-stabilise…');
});

test('a line the room can hold is kept whole; a lone long token is never sliced', () => {
  // A line that fits the plate is returned as it is -- the ellipsis belongs to
  // a cut, and nothing is cut here.
  assert.deepEqual(boundStatusLines('Alpha holds GTP', 15, 1), ['Alpha holds GTP']);
  assert.deepEqual(boundStatusLines('', 10, 1), []);
  assert.deepEqual(boundStatusLines('anything', 0, 3), []);
  assert.deepEqual(boundStatusLines('anything', 10, 0), []);
  // Where a cut does fire, a word longer than the room it leaves has no
  // boundary to back up to, so it is kept whole rather than sliced:
  // A hyphen is now a permitted break, while an atomic word stays whole.
  assert.deepEqual(boundStatusLines('Taxol-stabilised dimer here', 15, 1), ['Taxol-…']);
  assert.deepEqual(boundStatusLines('endsoneword again', 10, 1), ['endsoneword…']);
});

test('the tour readout feeds the wearer the spoken line and a progress without the TEXT token', needsReadout, () => {
  // With a TEXT token on the middle line the plate draws `Scene 3 / 5 · TEX…`
  // and the caption below it in pieces. The middle line is the progress alone,
  // and the spoken line is the one entry that cannot be dropped. The payload
  // line draws only inside the chapter's full caption window, so these reads
  // sit one second into a chapter stamped at 0.
  const line = 'As a surface, the new strand binds along the side: a patch of wall, not a closed tube.';
  const readout = tourReadout({ selectedId: 'x', title: 'Open sheet',
    selectedTitle: 'D. A wall three protofilaments wide', progress: 'Scene 3 / 5',
    bodyPage: line, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0 }, false, 1000);
  assert.deepEqual(readout.map(entry => entry.text), ['Open sheet', 'Scene 3 / 5', line]);
  assert.equal(readout[1].optional, true, 'the progress line yields first');
  assert.equal(readout[1].text.includes('TEXT'), false, 'no TEXT token reaches the wearer');
  assert.equal(readout[2].optional, false, 'a whole spoken line is never dropped');
  // A page also stays whole: the next page cannot recover dropped words.
  const paged = tourReadout({ selectedId: 'x', title: 'Meet your molecule', progress: 'Scene 1 / 20',
    bodyPage: 'Full cartoon view; chain colors', bodyPageIndex: 0, bodyPageCount: 6, chapterStartedAt: 0 }, false, 1000);
  assert.equal(paged[2].optional, false, 'a paginated page must remain drawn');
  assert.equal(paged[2].whole, true, 'a paginated page keeps every word');
});

test('every spoken line draws whole above the menus a chapter plays over', needsReadout, () => {
  // A chapter plays with the menu standing back -- the quiet three-to-four
  // row set -- and the wearer can also call the compact grid up over it. The
  // plate adds rows and eases the type before it cuts, so the line draws whole
  // in both states; only a line the eye itself refuses may end on a whole
  // word with an ellipsis, and then the progress line has yielded first.
  // Read one second into the chapter's full caption window, which is the state
  // this composition contract is about.
  const lines = [
    'As a surface, the new strand binds along the side: a patch of wall, not a closed tube.',
    'Green marks both nucleases, red both cut sites. HNH cuts magenta, RuvC cuts blue.',
    'Three strands side by side; thirteen close the tube.',
  ];
  for (const count of [3, 4, 9]) {
    for (const line of lines) {
      const panel = createToolbarPanel({ rows: menuRows(count), head: HEAD,
        readout: tourReadout({ selectedId: 'lesson-x', title: 'Open sheet',
          selectedTitle: 'A wall three wide', progress: 'Scene 3 / 5',
          bodyPage: line, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0 }, false, 1000) });
      const drawn = panel.readoutPoints.map(row => row.text);
      assert.equal(drawn[0], 'Open sheet', 'the scene title is never dropped');
      const sentence = drawn.filter(row => row !== 'Scene 3 / 5');
      const drawnFlat = sentence.slice(1).map(row => row.replace(/…$/u, '').trim()).join(' ');
      if (drawnFlat.replace(/\s+/gu, '') !== line.replace(/\s+/gu, '')) {
        // The eye refused the whole line: the last drawn row is a whole-word
        // cut, and the progress line has already gone.
        assert.ok(sentence.at(-1).endsWith('…'), `an unkept line is cut on a word: ${JSON.stringify(drawn)}`);
        assertWholeWordCut(sentence.at(-1), line);
        assert.equal(drawn.includes('Scene 3 / 5'), false, 'the progress line yields before the sentence is cut');
      }
    }
  }
});

test('a twelve-line reply clears the unchanged reserved menu obstacle', () => {
  for (const rows of [spatialToolbarRows(), shippedRows, spatialToolbarRows({ collapsed: false })]) {
    const empty = createToolbarPanel({ rows, head: HEAD });
    const status = Array(12).fill('M'.repeat(28)).join(' ');
    const full = createToolbarPanel({ rows, head: HEAD, status });
    assert.equal(full.statusPoints.length, 12);
    assert.deepEqual(toolbarMenuPoints(full), toolbarMenuPoints(empty));
    for (const eyeX of [-0.032, 0.032]) {
      const seat = { eye: [eyeX, 1.6, 0], target: [eyeX, 1.6, -1] };
      const obstacle = screenRectFromPoints({ points: toolbarMenuPoints(empty), ...seat });
      for (const line of full.statusPoints) {
        const halfWidth = line.text.length * full.fontMeters * SPATIAL_TOOLBAR_LAYOUT.glyphAspect / 2;
        const corners = [-1, 1].flatMap(x => [-1, 1].map(y => line.point.map((v, i) =>
          v + x * halfWidth * full.right[i] + y * full.fontMeters / 2 * full.up[i] - 0.012 * full.normal[i])));
        const text = screenRectFromPoints({ points: corners, ...seat });
        assert.ok(disjoint(obstacle, text), 'every reply line clears the obstacle');
      }
    }
  }
});

const disjoint = (a, b) => Math.abs(a.x - b.x) > a.halfWidth + b.halfWidth
  || Math.abs(a.y - b.y) > a.halfHeight + b.halfHeight;

test('reply glass is disjoint at collapsed, expanded, mirrored and standoff menu seats', () => {
  let checked = 0;
  for (const collapsed of [true, false]) for (const side of [-1, 1]) {
    for (const standoff of [0, 0.4, 1]) for (const yaw of [0, 0.6, -0.8]) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const head = { position: HEAD.position, matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 1.6, 0, 1] };
      const constants = toolbarLayoutForStandoff(standoff, { ...SPATIAL_TOOLBAR_LAYOUT,
        rightMeters: side * Math.abs(SPATIAL_TOOLBAR_LAYOUT.rightMeters) });
      const panel = createToolbarPanel({ rows: spatialToolbarRows({ collapsed }), head, constants, status: 'Tour started.' });
      for (const eyeX of [-0.032, 0.032]) {
        const eye = [c * eyeX, 1.6, -s * eyeX];
        const seat = { eye, target: [eye[0] - s, 1.6, eye[2] - c] };
        const menu = screenRectFromPoints({ points: toolbarMenuPoints(panel), ...seat });
        const card = screenRectFromPoints({ points: toolbarBackingOutline(panel, { plate: panel.statusBacking }), ...seat });
        assert.ok(disjoint(menu, card), JSON.stringify({ collapsed, side, standoff, yaw, eyeX }));
        checked++;
      }
    }
  }
  assert.equal(checked, 72);
});
