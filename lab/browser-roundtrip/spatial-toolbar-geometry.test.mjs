import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { boundStatusLines, createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT, TOOLBAR_READING_RANGE_METERS, toolbarMenuPoints, toolbarBackingOutline, toolbarLayoutForOutboard, toolbarLayoutForStandoff, toolbarTextPoint } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { screenRectFromPoints } from './label-layout.mjs';
import { toolbarCaptionPoints } from './spatial-toolbar-geometry.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
// spatial-toolbar.mjs pulls molstar, which the main tree resolves only under plugin/;
// the readout tests are skipped where the package is out of reach.
let tourReadout;
try { ({ tourReadout } = await import('./spatial-toolbar.mjs')); } catch { tourReadout = undefined; }
const boldAdvances = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url))).advances;
const measureBoldText = text => [...text].reduce((sum, glyph) => sum + (boldAdvances[glyph] ?? .6), 0);
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

test('an opening map card clears unused space without shrinking or dropping its caption', () => {
  const options = { rows: menuRows(1), head: HEAD, measureText: measureBoldText,
    readout: [{ text: 'A different experiment · 1/2', whole: true, forwardView: true },
      { text: 'A different experiment reveals a whole tube in cryo-EM density.', whole: true }] };
  const normal = createToolbarPanel(options);
  const fitted = createToolbarPanel({ ...options, constants: { ...SPATIAL_TOOLBAR_LAYOUT, fitChapterCaption: true } });
  assert.deepEqual(fitted.readoutPoints.map(line => line.text), normal.readoutPoints.map(line => line.text));
  assert.equal(fitted.readoutFontMeters, normal.readoutFontMeters);
  assert.equal(fitted.readoutPageCount, normal.readoutPageCount);
  assert.deepEqual(fitted.buttons, normal.buttons);
  assert.ok(fitted.captionBacking.halfHeight < normal.captionBacking.halfHeight);
  assert.ok(fitted.captionBacking.point[1] - fitted.captionBacking.halfHeight
    > normal.captionBacking.point[1] - normal.captionBacking.halfHeight);
  assert.ok(menuSeatWithinView(toolbarCaptionPoints(fitted), HEAD), 'the whole card stays in both eyes');
  const bottom = fitted.captionBacking.point[1] - fitted.captionBacking.halfHeight;
  assert.ok(fitted.readoutPoints.every(line => line.point[1] - fitted.readoutFontMeters / 2 > bottom));
});

test('only the first map chapter fits its caption; atomic and later chapters keep their card', async () => {
  const { toolbarFrameRuntime, toolbarFrameHarness } = await import('./fixtures/toolbar-frame-runtime.mjs');
  const runtime = await toolbarFrameRuntime();
  const state = { densityMap: false, tour: { selectedId: 'local-map', active: true, step: 0, total: 2, chapterStartedAt: 1,
    title: 'Density', bodyPage: 'A different experiment reveals a whole tube in cryo-EM density.' } };
  const h = toolbarFrameHarness(runtime, { state });
  // captionPoints also carries the assistant card below the controls.
  // Measure the chapter plate, not the unchanged status card's lower edge.
  const floor = () => {
    const points = h.toolbar.captionPoints();
    return Math.min(...(points.plates?.[0] ?? points).map(point => point[1]));
  };
  try {
    await h.toolbar.update(); const normal = floor();
    h.setState({ ...state, densityMap: true });
    await h.toolbar.update(); const fitted = floor();
    assert.ok(fitted > normal, 'the opening card leaves more space beneath its text');
    await h.toolbar.update(); assert.equal(floor(), fitted, 'a redraw retains the chapter card');
    h.setState({ densityMap: true, tour: { ...state.tour, navigating: true } });
    await h.toolbar.update(); assert.equal(floor(), normal, 'a transition measures the original field');
    h.setState({ densityMap: true, tour: { ...state.tour, step: 1, chapterStartedAt: 2 } });
    await h.toolbar.update(); assert.equal(floor(), normal, 'the next chapter uses its original card');
  } finally { await h.toolbar.dispose(); }
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

test('the tour readout feeds the wearer the spoken line under one title line that carries the counter', needsReadout, () => {
  // The scene counter had a line of its own, and a card of three lines kept
  // one for the caption. The title and the counter share the first line, so
  // the caption has the other three, and no TEXT token reaches the wearer.
  const line = 'As a surface, the new strand binds along the side: a patch of wall, not a closed tube.';
  const readout = tourReadout({ selectedId: 'x', title: 'Open sheet', step: 2, total: 5,
    selectedTitle: 'D. A wall three protofilaments wide', progress: 'Scene 3 / 5',
    bodyPage: line, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0 }, false, 1000);
  assert.deepEqual(readout.map(entry => entry.text), ['Open sheet · 3/5', line]);
  assert.equal(readout[0].compactText, 'Open sheet', 'a title too long to share its line keeps the line alone');
  assert.equal(readout.some(entry => entry.text.includes('TEXT')), false, 'no TEXT token reaches the wearer');
  assert.equal(readout[1].optional, false, 'a whole spoken line is never dropped');
  // A page also stays whole: the next page cannot recover dropped words.
  const paged = tourReadout({ selectedId: 'x', title: 'Meet your molecule', progress: 'Scene 1 / 20',
    bodyPage: 'Full cartoon view; chain colors', bodyPageIndex: 0, bodyPageCount: 6, chapterStartedAt: 0 }, false, 1000);
  assert.equal(paged[1].optional, false, 'a paginated page must remain drawn');
  assert.equal(paged[1].whole, true, 'a paginated page keeps every word');
});

test('every spoken line draws whole above the menus a chapter plays over', needsReadout, () => {
  // A chapter plays with the menu standing back -- the quiet three-to-four
  // row set -- and the wearer can also call the compact grid up over it. The
  // plate adds rows and eases the type before it cuts, so the line draws whole
  // in both states; only a line the eye itself refuses may end on a whole
  // word with an ellipsis, and then the progress line has yielded first.
  const lines = [
    'As a surface, the new strand binds along the side: a patch of wall, not a closed tube.',
    'Green marks both nucleases, red both cut sites. HNH cuts magenta, RuvC cuts blue.',
    'Three strands side by side; thirteen close the tube.',
  ];
  for (const count of [3, 4, 9]) {
    for (const line of lines) {
      const panel = createToolbarPanel({ rows: menuRows(count), head: HEAD, measureText: measureBoldText,
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

// The deposited titles of the shipped demos, from one word to the longest.
const entry = { pdbId: '4HHB', chains: 4, assembly: 'asymmetric_unit', selectionCount: 0, representation: 'cartoon', color: 'chain-id' };
const demoSubjects = [
  { ...entry, title: 'Crambin' },
  { ...entry, title: 'Human deoxyhaemoglobin' },
  { ...entry, pdbId: '9KJ6', title: 'SpCas9 ternary complex, amino acids (1242-1263) replaced with Gly-Ser linker' },
  { ...entry, pdbId: '8OUE', chains: 10, title: 'The H/ACA RNP lobe of human telomerase with the dyskerin thumb loop in a semi-closed conformation' },
];
const glyphRun = rows => rows.join('').replace(/\s+/gu, '');

// What a chapter card may draw: its title line (`Title · 1/5`, or the title
// alone when the two cannot share a line), then the whole caption. Nothing
// else, and nothing cut.
function assertChapterCard(drawn, { title, counter, caption }, label) {
  const run = glyphRun(drawn);
  assert.ok(run === glyphRun([`${title} · ${counter}`, caption]) || run === glyphRun([title, caption]),
    `the card is the title and the whole caption: ${label}`);
}

// The chapter card used to hold its caption for a four-second reading window and
// then settle on the structure's own lines: `SpCas9 ternary` over `complex,…` on
// the CRISPR card, `Human` over `…` on the hemoglobin one. Settled, it is still
// the chapter, under every structure and above every menu.
test('a settled chapter card keeps its whole caption and none of the structure lines', needsReadout, () => {
  const chapter = { title: 'CAS9 COMPLEX', progress: 'Scene 1 / 9', counter: '1/9',
    caption: 'Cas9 in grey, its guide RNA in orange, and the two DNA strands it holds.' };
  for (const count of [3, 4, 9]) for (const subject of demoSubjects) {
    // 1 s into a chapter stamped at 0, then well after the scene has settled.
    for (const nowMs of [1000, 10_000, 600_000]) {
      const readout = tourReadout({ selectedId: 'lesson-x', active: true, step: 0, total: 9, title: chapter.title, selectedTitle: 'A lesson',
        progress: chapter.progress, bodyPage: chapter.caption, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0 }, subject, nowMs);
      const label = `${count} rows, ${subject.title.slice(0, 12)}, ${nowMs} ms`;
      assert.deepEqual(readout.map(line => line.text), [`${chapter.title} · ${chapter.counter}`, chapter.caption], label);
      const panel = createToolbarPanel({ rows: menuRows(count), head: HEAD, measureText: measureBoldText, readout });
      const drawn = panel.readoutPoints.map(row => row.text);
      assertChapterCard(drawn, chapter, `${label}: ${JSON.stringify(drawn)}`);
    }
  }
});

// Every chapter of every shipped lesson, settled, on the card a wearer reads it
// on. The caption arrives whole and the card wraps it at its own width; a
// caption longer than three lines draws a page at a time, each page under the
// chapter's title line, and only a page that continues ends on the mark. The
// menu runs from the quiet compact grid to the expanded one, and the seat from
// the entry bearing to its widest outboard swing. A stand-off scales the whole
// seat and keeps its angles, so it adds no case.
const DEMOS = new URL('../../plugin/demos/', import.meta.url);
const demoLessons = readdirSync(DEMOS, { recursive: true }).filter(name => String(name).endsWith('.json'))
  .map(file => ({ file: String(file), lesson: JSON.parse(readFileSync(new URL(String(file), DEMOS), 'utf8')) }))
  .filter(({ lesson }) => Array.isArray(lesson.chapters));
test('every shipped chapter caption draws whole on its card, or in whole pages', needsReadout, () => {
  assert.ok(demoLessons.length >= 10, `found ${demoLessons.length} lessons`);
  const layouts = [SPATIAL_TOOLBAR_LAYOUT, toolbarLayoutForOutboard(3.5)];
  let chapters = 0, paged = 0;
  for (const { file, lesson } of demoLessons) lesson.chapters.forEach((chapter, step) => {
    chapters++;
    const caption = chapter.immersive?.narration?.trim() || chapter.caption;
    const counter = `${step + 1}/${lesson.chapters.length}`;
    const tour = { active: true, selectedId: 'lesson-x', selectedTitle: lesson.title, title: chapter.title,
      progress: `Scene ${counter.replace('/', ' / ')}`, step, total: lesson.chapters.length, canBack: step > 0, canNext: true,
      bodyPage: caption, bodyPageIndex: 0, bodyPageCount: 1, chapterStartedAt: 0 };
    const readout = tourReadout(tour, demoSubjects[3], 60_000);
    for (const constants of layouts) for (const collapsed of [true, false]) {
      const rows = spatialToolbarRows({ collapsed, tour });
      const options = { rows, head: HEAD, constants, measureText: measureBoldText, readout, readoutPage: 0 };
      const first = createToolbarPanel(options);
      const pages = Array.from({ length: first.readoutPageCount }, (_, readoutPage) =>
        createToolbarPanel({ ...options, readoutPage }).readoutPoints.map(row => row.text));
      if (pages.length > 1 && constants === SPATIAL_TOOLBAR_LAYOUT && collapsed) paged++;
      const label = `${file} / ${chapter.id}, ${collapsed ? 'compact' : 'expanded'}: ${JSON.stringify(pages)}`;
      for (const [index, drawn] of pages.entries()) {
        assert.ok(drawn.length <= first.readoutLineBudget, label);
        assert.ok([`${chapter.title} · ${counter}`, chapter.title].includes(drawn[0]), `every page opens on the title line: ${label}`);
        assert.ok(drawn.every((row, at) => !row.endsWith('…') || (at === drawn.length - 1 && index < pages.length - 1)),
          `only a page that continues ends on the mark: ${label}`);
      }
      assert.equal(glyphRun(pages.flatMap(page => page.slice(1)).map(row => row.replace(/…$/u, ''))), glyphRun([caption]),
        `the pages keep every word: ${label}`);
    }
  });
  assert.ok(chapters > 100 && paged > 0, `${chapters} chapters, ${paged} paged`);
});

test('a structure line that wraps on its separator drops the dot at the break', needsReadout, () => {
  // `cartoon by chain · 0 selected` broke as `cartoon by chain` over
  // `· 0 selected`; the break says the two facts are apart.
  const panel = createToolbarPanel({ rows: menuRows(4), head: HEAD, measureText: text => text.length * 1.5,
    readout: [{ text: 'Wide reveal', whole: true, forwardView: true },
      { text: 'cartoon by chain · 0 selected', maxLines: 2, optional: true }] });
  const drawn = panel.readoutPoints.map(row => row.text);
  assert.equal(drawn.at(0), 'Wide reveal');
  assert.ok(drawn.length >= 3, JSON.stringify(drawn));
  assert.deepEqual(drawn.slice(1).join(' ').replace(/\s+/gu, ' '), 'cartoon by chain 0 selected');
});

// Text stands in front of its plate, with the glass a further stretch behind it.
// Pushed along the normal alone, a card 17 degrees off the normal showed its text
// flush with the glass's right edge and its title over the top edge. Along the
// sight line from the seat it covers the part of the glass it labels.
test('text stands in front of its plate on the sight line from the seat to the glass', () => {
  const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const subv = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const panel = createToolbarPanel({ rows: shippedRows, head: HEAD, measureText: measureBoldText,
    readout: [{ text: 'Wide reveal', whole: true, forwardView: true }, { text: 'Four chains in four colours.', whole: true }] });
  const outward = panel.normal.map(value => -value);
  const clearance = 0.025, behind = 0.03;
  assert.ok(panel.readoutPoints.length >= 2);
  const points = [...panel.readoutPoints.map(line => line.point), ...panel.buttons.map(button => button.point), panel.captionBacking.point];
  for (const point of points) {
    const text = toolbarTextPoint(panel, point, clearance, behind);
    assert.ok(Math.abs(dotv(subv(text, point), outward) - clearance) < 1e-9, 'its normal offset is the clearance');
    // Collinear with the seat and the glass face: no sideways slide as seen from there.
    const glass = subv(point, outward.map(value => value * behind));
    assert.ok(Math.hypot(...crossv(subv(text, glass), subv(panel.seatOrigin, glass))) < 1e-9, 'text, glass point and seat are on one line');
  }
  // The caption card sits well off the normal, which is where the plain offset slid.
  const cardPoint = panel.captionBacking.point;
  const card = toolbarTextPoint(panel, cardPoint, clearance, behind);
  const slide = Math.hypot(...subv(card, cardPoint.map((value, axis) => value + outward[axis] * clearance)));
  assert.ok(slide > 0.01, `the sight line moves the text ${slide} m off the plain offset`);
  // No sight line to give: a seat behind the plate, far off to the side, or none at all.
  const plain = panel.anchor.map((value, axis) => Math.round((value + outward[axis] * clearance) * 1e9));
  for (const seatOrigin of [panel.anchor.map((value, axis) => value - outward[axis]), panel.anchor.map((value, axis) => value + outward[axis] * 0.2 + panel.right[axis] * 3), undefined]) {
    const text = toolbarTextPoint({ ...panel, seatOrigin }, panel.anchor, clearance, behind);
    assert.deepEqual(text.map(value => Math.round(value * 1e9)), plain);
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
