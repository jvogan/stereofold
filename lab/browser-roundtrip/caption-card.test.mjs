import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenCaptionCardRows } from './growth-caption.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';

// A lesson may ask (`presentation.captionCard: 'hidden'` on
// the manifest) to be shown as a plain labelled structure with no tour
// chrome: no chapter title, no `Scene n / m` counter, no narration line on
// the caption plate above the menu. `spatial-toolbar.mjs` `tourReadout`
// routes that case to `hiddenCaptionCardRows`, which is pure and Mol*-free,
// so `node --test` can hold it here.

test('a hidden caption card draws no tour chrome rows', () => {
  assert.deepEqual(hiddenCaptionCardRows(), []);
  assert.deepEqual(hiddenCaptionCardRows({}), []);
  assert.deepEqual(hiddenCaptionCardRows({ growthSpoken: '' }), []);
  assert.deepEqual(hiddenCaptionCardRows({ growthSpoken: '   ' }), []);
  assert.deepEqual(hiddenCaptionCardRows({ growthSpoken: 42 }), []);
});

test('a live growth sentence still draws alone on the plate of a card-less lesson', () => {
  // The host answering the wearer's own press is not tour chrome. No growth
  // tier lesson hides its card, so this is the safety net branch.
  assert.deepEqual(hiddenCaptionCardRows({ growthSpoken: 'Grown to a dimer.' }),
    [{ text: 'Grown to a dimer.' }]);
  assert.deepEqual(hiddenCaptionCardRows({ growthSpoken: '  Too big for this headset. Staying here. ' }),
    [{ text: 'Too big for this headset. Staying here.' }]);
});

import { createStructureSubjectReader, displayTitle, structureDescriptionPages, structureReadout } from './structure-subject.mjs';
import { READOUT_PAGE_LINE_WIDTH, SPATIAL_TOOLBAR_LAYOUT, boundStatusLines, createToolbarPanel } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';

const runtime = await toolbarFrameRuntime();
const subject = { pdbId: '4HHB', title: 'Hemoglobin tetramer', chains: 4, assembly: 'asymmetric_unit',
  selectionCount: 5, representation: 'cartoon', color: 'chain-id' };

test('idle caption names the loaded structure and live selection, not an unstarted journey', () => {
  const rows = runtime.tourReadout({ active: false, menuOpen: false, selectedId: 'old', title: 'Molecular journeys' }, subject);
  assert.deepEqual(rows.map(row => row.text), ['Hemoglobin tetramer', '4HHB · 4 chains · asymmetric unit', 'cartoon by chain · 5 selected']);
  assert.deepEqual(runtime.tourReadout(undefined, subject), rows);
});

test('active journey and explicit chooser own the caption only while in use; failure reaches the plate', () => {
  const active = { active: true, selectedId: 'hemoglobin', title: 'Meet the tetramer', progress: 'Scene 1 / 20', bodyPage: 'Four subunits.', autoplay: true };
  assert.equal(runtime.tourReadout(active, subject)[0].text, 'Meet the tetramer');
  assert.equal(runtime.tourReadout({ ...active, menuOpen: true, selectedTitle: 'Green fluorescent protein' }, subject)[0].text, 'Green fluorescent protein');
  assert.deepEqual(runtime.tourReadout({ ...active, feedbackError: true, feedback: 'Journey could not render: atom budget exceeded.' }, subject),
    [{ text: 'Journey could not render: atom budget exceeded.', maxLines: 2 }, ...structureReadout(subject)]);
});

test('deposited titles lose their method prefix and resolution suffix so the plate names the molecule', async () => {
  const { displayTitle } = await import('./structure-subject.mjs');
  assert.equal(displayTitle('THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN AT 1.74 A RESOLUTION'), 'Human deoxyhaemoglobin');
  assert.equal(displayTitle('CRYSTAL STRUCTURE OF CRAMBIN AT 0.83 A RESOLUTION'), 'Crambin');
  assert.equal(displayTitle('Cryo-EM structure of the SARS-CoV-2 spike glycoprotein'), 'SARS-CoV-2 spike glycoprotein');
  assert.equal(displayTitle('Hemoglobin tetramer'), 'Hemoglobin tetramer');
  assert.equal(displayTitle('4HHB'), '4HHB');
});

// Md. 1CRN's deposited title is two
// sentences. Lowercasing everything after the first character put `pentagon`
// after a full stop on the Quest 2 plate. Sentence casing is per sentence; nothing else about a title moves.
test('an all-capitals title is sentence-cased at every sentence, not only the first', async () => {
  const { displayTitle, sentenceTitle } = await import('./structure-subject.mjs');
  assert.equal(displayTitle('WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. '
    + 'PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN'),
  'Water structure of a hydrophobic protein at atomic resolution. Pentagon rings of water molecules in crystals of crambin');
  assert.equal(displayTitle('THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN AT 1.74 A RESOLUTION'), 'Human deoxyhaemoglobin');
  assert.equal(sentenceTitle('PENTAGON RINGS OF WATER MOLECULES'), 'Pentagon rings of water molecules');
  assert.equal(sentenceTitle('Pentagon rings. pentagon rings'), 'Pentagon rings. pentagon rings');
  assert.equal(sentenceTitle('IS THIS CRAMBIN? YES. AND ALSO WATER!'), 'Is this crambin? Yes. And also water!');
  assert.equal(displayTitle('4HHB'), '4HHB');
});

test('subject reads mmCIF title in sentence case and caches chain counting between selection changes', () => {
  let reads = 0;
  const rows = ['A', 'B', 'C', 'D'].map(labelChain => ({ coordinateState: 'resolved', entityType: 'polymer',
    identity: { modelNumber: 1, copyId: 'asu', labelChain } }));
  rows.push({ coordinateState: 'resolved', entityType: 'water', identity: { modelNumber: 1, copyId: 'asu', labelChain: 'E' } });
  const source = { sha256: 'source', code: 'mmCIF', catalog: { assemblyId: 'asymmetric_unit', get rows() { reads++; return rows; } } };
  const model = { entryId: '4hhb', sourceData: { data: { db: { struct: { title: { value: () => 'HUMAN DEOXYHEMOGLOBIN' } } } } } };
  const reader = createStructureSubjectReader();
  const live = { ready: true, modelNumber: 1, selectionKeys: [], appearance: { representation: 'cartoon', color: 'chain-id' } };
  assert.deepEqual(reader(source, model, live), { pdbId: '4HHB', sourceSha256: 'source', title: 'Human deoxyhemoglobin', chains: 4,
    assembly: 'asymmetric_unit', modelNumber: 1, selectionCount: 0, representation: 'cartoon', color: 'chain-id' });
  assert.equal(reader(source, model, { ...live, selectionKeys: ['1', '2'] }).selectionCount, 2);
  assert.equal(reads, 1);
  assert.equal(reader(undefined, undefined, live), undefined);
});

test('structure caption uses the existing fitted glass and never chops alpha/beta-tubulin', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
  for (const collapsed of [true, false]) {
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }), readout: structureReadout(subject) });
    assert.ok(panel.captionBacking);
    assert.ok(panel.readoutPoints.length > 0);
    assert.ok(panel.readoutPoints.every(row => row.point.every(Number.isFinite)));
    assert.ok(!panel.readoutPoints.some(row => /Molecular journeys|Choose a journey/u.test(row.text)));
  }
  const wrapped = boundStatusLines('An alpha/beta-tubulin dimer is present', 15, 10);
  assert.equal(wrapped.join('').replace(/\s/gu, ''), 'Analpha/beta-tubulindimerispresent');
  assert.ok(wrapped.every(line => line.length <= 15));
  assert.ok(!wrapped.join(' ').includes('tubu lin'));
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('the shipped getSpatialState carries the rendered subject, appearance and changing selection count', () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const subjectStart = viewer.indexOf('  let renderedStructureSubject,');
  const getterStart = viewer.indexOf('      getSpatialState:');
  const rows = [{ coordinateState: 'resolved', entityType: 'polymer', identity: { modelNumber: 2, copyId: 'copy', labelChain: 'A' } }];
  const state = { selectionKeys: ['a', 'b'] };
  let placementMoves = 0;
  const context = vm.createContext({ ...emptyLessonFigureBinding(), readStructureSubject: createStructureSubjectReader(), state, representation: { obj: {} },
    wearerPlacement: { state: () => ({ moves: placementMoves }) },
    paintedContextOpacity: value => value, visibilityState: { hiddenClasses: [] }, VISIBILITY_LAYER_REF: {}, plugin: { state: { data: { cells: new Map() } } }, emphasisState: { parts: [], focus: [] }, styleLayers: [], volume: undefined,
    sourceRecord: { pdbId: '4HHB', sha256: 'hash', title: 'Hemoglobin tetramer', catalog: { rows, assemblyId: '1' } },
    structure: { obj: { data: { model: { modelNum: 2 } } } },
    inspectionSnapshot: () => ({ appearance: { representation: 'cartoon', color: 'chain-id' } }),
    appliedGeometryBudget: undefined, spatialRepresentations: () => ['cartoon', 'spacefill'],
    spatialSharedHistory: () => ({ history: { undoCount: 1, redoCount: 0, canUndo: true, canRedo: false } }),
    inspectionMotionSnapshot: () => ({}), sequenceNavigation: { snapshot: () => ({}) },
    passthroughOn: true, immersiveSession: undefined, spatialRenderQuality: () => ({}), spatialTour: undefined,
    voiceInteraction: undefined, growthOverlay: undefined, connectionStatus: () => ({ state: 'linked' }),
    placementNote: null });
  vm.runInContext(viewer.slice(subjectStart, viewer.indexOf('\n  let sourceRecord', subjectStart)), context);
  const getter = vm.runInContext(`({${viewer.slice(getterStart, viewer.indexOf('      // The tour controller itself', getterStart))}}).getSpatialState`, context);
  assert.equal(getter().subject, undefined, 'no subject before a rendered snapshot');
  assert.equal(getter().placementMoves, 0);
  placementMoves++;
  assert.equal(getter().placementMoves, 1, 'a grab takeover reaches the menu before molecular placement commits');
  assert.deepEqual(getter().representations, ['cartoon', 'spacefill']);
  assert.deepEqual(getter().history, { undoCount: 1, redoCount: 0, canUndo: true, canRedo: false });
  const rendered = { ready: true, modelNumber: 2, assemblyId: '1', selectionKeys: state.selectionKeys, representation: 'cartoon', color: 'chain-id' };
  context.refreshStructureSubject(rendered);
  assert.deepEqual(JSON.parse(JSON.stringify(getter().subject)), { pdbId: '4HHB', sourceSha256: 'hash', title: 'Hemoglobin tetramer', chains: 1,
    assembly: '1', modelNumber: 2, selectionCount: 2, representation: 'cartoon', color: 'chain-id' });
  state.selectionKeys = [];
  assert.equal(getter().subject.selectionCount, 2, 'a pending selection must not update the plate');
  context.refreshStructureSubject({ ...rendered, selectionKeys: [] });
  assert.equal(getter().subject.selectionCount, 0);
  context.refreshStructureSubject({ ...rendered, representation: 'spacefill', color: 'element-symbol' });
  assert.equal(getter().subject.representation, 'spacefill', 'rendered geometry wins over the requested cartoon');
  assert.equal(getter().subject.color, 'element-symbol', 'rendered colour wins over the requested chain theme');
  const committed = getter().subject;
  for (let frame = 0; frame < 72; frame++) assert.equal(getter().subject, committed, 'frame reads use the committed cache');
  // The placement sentence travels on the same shipped
  // state the menu already reads, and it is absent until a placement mints it.
  assert.equal(Object.hasOwn(getter(), 'placementNote'), false, 'no placement note before a placement receipt');
  context.placementNote = { text: 'Above you · look up' };
  assert.deepEqual(getter().placementNote, { text: 'Above you · look up' });
});

test('an unbreakable caption word is elided whole instead of spilling outside the glass', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
  const word = 'Macromolecularassemblywithoutseparators';
  for (const collapsed of [true, false]) {
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }), readout: [{ text: word }] });
    assert.deepEqual(panel.readoutPoints.map(row => row.text), ['…']);
  }
});

const captionSource = (copies = ['asu']) => ({ pdbId: '4HHB', sha256: 'hash', title: 'Human deoxyhaemoglobin',
  catalog: { assemblyId: 'asymmetric_unit', rows: copies.flatMap(copyId => ['A', 'B', 'C', 'D'].map(labelChain => ({
    key: `${copyId}-${labelChain}`, coordinateState: 'resolved', entityType: 'polymer',
    identity: { modelNumber: 1, copyId, labelChain, entityId: labelChain, operatorIds: [copyId] },
  }))) } });
const captionSnapshot = { ready: true, modelNumber: 1, selectionKeys: [], appearance: { representation: 'cartoon', color: 'chain-id' } };

test('hidden chains, entities and ligands describe the visible subset with copy-safe names', () => {
  const read = createStructureSubjectReader();
  const source = captionSource();
  const hidden = read(source, undefined, { ...captionSnapshot,
    visibility: { hiddenChains: [{ labelChain: 'A', copyId: 'asu' }], hiddenClasses: ['ligand'] } });
  assert.equal(hidden.shownChains, 3);
  assert.match(structureReadout(hidden).map(row => row.text).join(' / '), /3 of 4 chains shown.*A, ligands hidden/u);
  const copy = read(captionSource(['first', 'second']), undefined, { ...captionSnapshot,
    visibility: { hiddenChains: [{ labelChain: 'A', copyId: 'second' }] } });
  assert.deepEqual(copy.hiddenChains, ['A (copy 2)']);
  assert.equal(copy.shownChains, 7);
  const entity = read({ ...source, visible: { entityIds: ['B', 'C', 'D'] } }, undefined, captionSnapshot);
  assert.equal(entity.shownChains, 3);
  assert.match(structureReadout(entity).map(row => row.text).join(' / '), /entity A hidden/u);
  const only = read(source, undefined, { ...captionSnapshot, selectionKeys: ['asu-B'], visibility: { showOnlySelection: true } });
  assert.equal(only.shownChains, 1);
  assert.match(structureReadout(only).map(row => row.text).join(' / '), /only selection shown.*1 selected/u);
  const none = read(source, undefined, { ...captionSnapshot, visibility: { hiddenClasses: ['polymer'] } });
  assert.equal(none.shownChains, 0);
});

test('appearance, partial styles, focus and selection describe the rendered subject', () => {
  const live = createStructureSubjectReader()(captionSource(), undefined, { ...captionSnapshot,
    appearance: { representation: 'ball-and-stick', color: 'element-symbol' }, selectionKeys: ['asu-B', 'asu-C'],
    styles: [{ representation: 'spacefill', color: 'uniform' }],
    emphasis: { parts: [{ id: 'beta', label: 'beta chains' }], focus: ['beta'], contextOpacity: .2 } });
  const text = structureReadout(live).map(row => row.text).join(' / ');
  assert.match(text, /sticks by element · partial: spacefill in one colour/u);
  assert.match(text, /2 selected/u);
  assert.match(text, /focus: beta chains · context 20%/u);
});

test('the compact hidden-chain plate keeps its title, visibility, appearance and selection inside the glass', () => {
  const hidden = createStructureSubjectReader()(captionSource(), undefined, { ...captionSnapshot,
    selectionKeys: ['asu-B'], visibility: { hiddenChains: [{ labelChain: 'A', copyId: 'asu' }] } });
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
  for (const collapsed of [true, false]) {
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }), readout: structureReadout(hidden), measureText: text => [...text].reduce((n, c) => n + (metrics.advances[c] ?? .6), 0) });
    const lines = panel.readoutPoints.map(row => row.text), text = lines.join(' ');
    assert.match(text, /Human deoxyhaemoglobin/u);
    assert.match(text, /3(?:\/| of )4 chains shown/u);
    assert.match(text, /A hidden/u);
    assert.match(text, /cartoon by chain/u);
    assert.match(text, /1 selected/u);
    assert.ok(lines.length <= panel.readoutLineBudget);
    assert.ok(lines.every(line => [...line].reduce((n, c) => n + (metrics.advances[c] ?? .6), 0) * panel.readoutFontMeters <= 2 * panel.captionBacking.halfWidth));
    assert.ok(panel.readoutPoints.every(row => row.point.every(Number.isFinite)));
  }
});

test('journey feedback stays available while a hidden chapter card has no replacement source card', () => {
  const rows = runtime.tourReadout({ active: false, feedbackError: true, feedback: 'Could not render.' }, subject);
  assert.equal(rows[0].text, 'Could not render.');
  assert.deepEqual(rows.slice(1), structureReadout(subject).map(line => ({ ...line, forwardViewCap: true })));
  assert.deepEqual(runtime.tourReadout({ active: true, selectedId: 'lesson', captionCard: 'hidden' }, subject), []);
});

test('hidden gallery cards stay quiet during preparation but explicit Menu and errors remain readable', () => {
  const tour = { active: true, selectedId: 'lesson', captionCard: 'hidden',
    chapterPreview: { progress: 'Scene 2 / 17', title: 'Binder 02', bodyPage: 'Published metric' } };
  assert.deepEqual(runtime.tourReadout({ ...tour, navigating: true }, subject), []);
  assert.deepEqual(runtime.tourReadout({ ...tour, active: false, navigating: true }, subject), []);
  assert.ok(runtime.tourReadout({ ...tour, chapterPreview: undefined, menuOpen: true }, subject).length > 0);
  assert.equal(runtime.tourReadout({ ...tour, feedbackError: true, feedback: 'Could not render.' }, subject)[0].text,
    'Could not render.');
  assert.ok(runtime.tourReadout({ ...tour, active: false, chapterPreview: undefined }, subject).length > 0,
    'finishing the lesson restores the ordinary source card');
});

// `Above us` moved the structure three metres over the
// wearer's head and the plate said nothing about it (a row walk,
//). The sentence rides in the same slot as the journey feedback
// above, directly over the structure readout, and it has to sit inside the
// glass the layout already fills.

test('a placement sentence rides above the structure readout, in every caption state', () => {
  const placement = { text: 'Above you · look up' };
  const idle = runtime.tourReadout({ active: false, menuOpen: false }, subject, undefined, { placement });
  assert.equal(idle[0].text, 'Above you · look up');
  assert.deepEqual(idle.slice(1), structureReadout(subject).map(line => ({ ...line, forwardViewCap: true })));
  // The journey's own feedback still comes first: it is the answer to what the
  // wearer just asked for, and the placement is context under it.
  const failed = runtime.tourReadout({ active: false, feedbackError: true, feedback: 'Could not render.' },
    subject, undefined, { placement });
  assert.deepEqual(failed.map(row => row.text).slice(0, 2), ['Could not render.', 'Above you · look up']);
  // Inside a running chapter the sentence sits under the narration, never
  // between the title line and the caption. The chapter card carries none of
  // the structure readout: that belongs to the menu readout.
  const chapter = runtime.tourReadout({ active: true, selectedId: 'lesson', title: 'Meet the tetramer',
    progress: 'Scene 1 / 20', step: 0, total: 20, bodyPage: 'Four subunits.', autoplay: true }, subject, 0, { placement });
  assert.deepEqual(chapter.map(row => row.text), ['Meet the tetramer · 1/20', 'Four subunits.', 'Above you · look up']);
  assert.equal(chapter[0].whole, true, 'the title is never cut');
  assert.equal(chapter[1].whole, true, 'the narration is never cut');
  // A lesson that has asked for a bare structure gets one: no chrome, and no
  // placement line either.
  assert.deepEqual(runtime.tourReadout({ active: true, selectedId: 'lesson', captionCard: 'hidden' },
    subject, undefined, { placement }), []);
  // No note, and the plate is byte-for-byte what it was before this change.
  assert.deepEqual(runtime.tourReadout({ active: false }, subject, undefined, {}),
    runtime.tourReadout({ active: false }, subject));
  assert.deepEqual(runtime.tourReadout({ active: false }, subject, undefined, { placement: { text: '  ' } }),
    runtime.tourReadout({ active: false }, subject));
});

test('the placement sentence stays inside the caption glass, collapsed and expanded', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
  for (const text of ['Above you · look up', 'In front of you, within reach',
    'Fitted to the right of the menu', 'Back at the start']) {
    for (const collapsed of [true, false]) {
      const readout = runtime.tourReadout({ active: false }, subject, undefined, { placement: { text } });
      const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }), readout });
      const lines = panel.readoutPoints.map(row => row.text);
      assert.ok(lines.length <= panel.readoutLineBudget, `${text} overflowed the glass`);
      assert.ok(lines.every(line => line.length <= panel.readoutWrapWidth), `${text} overran the wrap width`);
      assert.ok(panel.readoutPoints.every(row => row.point.every(Number.isFinite)));
      // The molecule's own identity is never what yields to make room for a
      // sentence about where it is standing.
      assert.match(lines.join(' '), /Hemoglobin tetramer/u);
    }
  }
});

test('spoken reply and readout coexist through refreshes and stale clears until expiry; link loss takes priority', async () => {
  let at = 0;
  const records = [];
  const views = syntheticViews().map(view => {
    const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
    matrix[13] += 1.6; inverse[13] -= 1.6;
    return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
  });
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add() {}, remove() {} }, head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] }),
    clearance: () => ({ views, renderFromRoom: identity() }),
    now: () => at, record: (kind, detail) => records.push({ kind, ...detail }) });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    card.set({ outcome: 'Chain A hidden.' });
    await settle();
    assert.equal(card.text(), 'Chain A hidden.');
    at = 2000;
    card.set({ outcome: 'Now in sticks.' });
    await settle();
    at = 3001;
    card.set({ outcome: '', sending: false }); // Older toolbar timer / chapter refresh.
    card.frame();
    await settle();
    assert.equal(card.text(), 'Now in sticks.');
    assert.equal(runtime.tourReadout(undefined, subject)[0].text, subject.title);
    at = 4999;
    card.frame(); await settle();
    assert.equal(card.text(), 'Now in sticks.');
    at = 5001;
    card.frame(); await settle();
    assert.equal(card.text(), '');
  } finally { await card.dispose(); }
  // Execute the real priority function with an explicit, mutable link adapter.
  const talk = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
  const start = talk.indexOf('export function captionText('), end = talk.indexOf('\n}', start) + 2;
  let link = { state: 'linked' };
  const context = vm.createContext({ ...emptyLessonFigureBinding(), connectionStatus: () => link, TALK_LINK_LOST: 'No link · not listening' });
  const captionText = vm.runInContext(`(${talk.slice(start, end).replace('export ', '')})`, context);
  assert.equal(captionText({ outcome: 'Now in sticks.' }), 'Now in sticks.');
  link = { line: 'Link to the Mac lost', voiceLost: true };
  assert.match(captionText({ outcome: 'Now in sticks.' }), /Link to the Mac lost/u);
});

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
const measureText = text => Array.from(text).reduce((sum, glyph) => sum + (metrics.advances[glyph] ?? .6), 0);
const measuredRuntime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });

test('Fit and every placement sentence remain whole with the toolbar atlas advances', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1] };
  const sentences = ['Fitted to the right of the menu', 'Fitted to the left of the menu', 'Back at the start',
    'Above you · look up', 'In front of you, within reach', 'In front of you, a step away'];
  for (const collapsed of [true, false]) for (const text of sentences) {
    assert.equal(measuredRuntime.toolbarTextWidth(text), measureText(text), 'the draw and wrap use identical glyph advances');
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }), measureText,
      readout: measuredRuntime.tourReadout(undefined, subject, undefined, { placement: { text } }) });
    const placement = panel.readoutPoints.filter(line => line.whole).map(line => line.text).join(' ');
    assert.ok([text, text.replace('Fitted to the ', 'Fitted ')].includes(placement), `${text}: ${placement}`);
    const width = panel.captionEnvelope.inboard - panel.captionEnvelope.outboard - 2 * .034;
    for (const line of panel.readoutPoints) assert.ok(measureText(line.text) * panel.readoutFontMeters <= width + 1e-8,
      `glyph advances must stay inside the glass: ${line.text}`);
  }
});

test('assembly phrases wrap as a unit with the toolbar font, in both menu forms', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1] };
  for (const collapsed of [true, false]) for (const assembly of ['asymmetric_unit', '1']) {
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }), measureText,
      readout: structureReadout({ ...subject, assembly }) });
    const lines = panel.readoutPoints.map(line => line.text);
    const phrase = assembly === '1' ? 'biological assembly' : 'asymmetric unit';
    assert.ok(lines.some(line => line.includes(phrase)), lines.join(' / '));
    assert.ok(!lines.some(line => /^(?:unit|assembly)\b/u.test(line)), 'neither phrase leaves its final word orphaned');
  }
});

// With 1CRN loaded, the
// resting plate read `Water structure of a hydrophobic protein at atomic
// resolution, pentagon rings of water molecules in…` and the expanded menu's
// twenty-nine rows held nothing that could reach the rest of the sentence.
// An earlier run had given the reply caption, the refusal and the lesson's prose a page
// control that same day; the source description had never had one. These hold
// the description to the same rule, at the measured glyph advances rather than
// at a character count.
const crambin = displayTitle('WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. '
  + 'PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN');
const crambinSubject = { pdbId: '1CRN', title: crambin, chains: 1, assembly: 'asymmetric_unit',
  selectionCount: 0, representation: 'cartoon', color: 'chain-id' };

test('a long source description pages instead of ending in an ellipsis', () => {
  const pages = structureDescriptionPages(crambinSubject);
  assert.ok(pages.length > 1, `a description this long must page: ${pages.length}`);
  assert.deepEqual(pages.join(' ').split(/\s+/u), crambin.split(/\s+/u),
    'every word of the description survives, in order, across the pages');
  for (const page of pages) {
    assert.ok(!page.includes('…'), `no page is elided: ${page}`);
    assert.ok(page.split('\n').length <= 2, `a page fits the description row: ${page}`);
    for (const line of page.split('\n')) assert.ok(line.length <= READOUT_PAGE_LINE_WIDTH,
      `a page line fits the promised glass: ${line}`);
  }
});

test('the description row draws the page it is asked for, and wraps around', () => {
  const pages = structureDescriptionPages(crambinSubject);
  for (let index = 0; index < pages.length; index++)
    assert.equal(structureReadout(crambinSubject, { descriptionPage: index })[0].text,
      pages[index].replaceAll('\n', ' ') + (index < pages.length - 1 ? '…' : ''));
  // A counter that only ever increments cycles rather than running off the end.
  assert.equal(structureReadout(crambinSubject, { descriptionPage: pages.length })[0].text,
    pages[0].replaceAll('\n', ' ') + '…');
  // The rows below the description are untouched by paging.
  assert.deepEqual(structureReadout(crambinSubject, { descriptionPage: 1 }).slice(1),
    structureReadout(crambinSubject).slice(1));
});

test('a description that fits keeps the readout it always had', () => {
  assert.equal(structureDescriptionPages(subject).length, 1);
  assert.deepEqual(structureReadout(subject, { descriptionPage: 3 }), structureReadout(subject));
  assert.equal(structureReadout(subject)[0].text, 'Hemoglobin tetramer');
  for (const collapsed of [true, false]) {
    const panel = createToolbarPanel({ head: { position: { x: 0, y: 1.6, z: 0 },
      matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1] }, measureText,
      rows: spatialToolbarRows({ collapsed }),
      readout: structureReadout(subject).map((row, i) => ({ ...row, description: i === 0 })) });
    assert.equal(panel.readoutPoints.filter(row => row.description).map(row => row.text).join(' '), subject.title);
  }
});

test('description pages retain every word and mark continuation at the measured advances', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1] };
  const pages = structureDescriptionPages(crambinSubject);
  for (const collapsed of [true, false]) for (let index = 0; index < pages.length; index++) {
    const readout = measuredRuntime.tourReadout(undefined, crambinSubject, undefined, { descriptionPage: index })
      .map((row, i) => ({ ...row, description: i === 0 }));
    const panel = createToolbarPanel({ head, measureText,
      rows: spatialToolbarRows({ collapsed, readout: { descriptionPageCount: pages.length, descriptionPageIndex: index } }),
      readout });
    const drawn = panel.readoutPoints.filter(line => line.description).map(line => line.text);
    assert.equal(drawn.join(' '), pages[index].replaceAll('\n', ' ') + (index < pages.length - 1 ? '…' : ''),
      'the continuation mark never replaces a word on the page');
  }
});

for (const [pdbId, deposited] of [
  ['1CRN', 'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. '
    + 'PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN'],
  ['1EMA', 'GREEN FLUORESCENT PROTEIN'],
]) test(`${pdbId} marks the visible title continuation and pages every word at the plate width`, () => {
  const subject = { ...crambinSubject, pdbId, title: displayTitle(deposited) };
  const pages = structureDescriptionPages(subject);
  assert.ok(pages.length > 1);
  for (const collapsed of [true, false]) {
    const words = [];
    for (let page = 0; page < pages.length; page++) {
      const rows = spatialToolbarRows({ collapsed,
        readout: { descriptionPageCount: pages.length, descriptionPageIndex: page } });
      assert.equal(rows.find(row => row.id === 'description-page')?.label, `Pg ${page + 1}/${pages.length}`);
      const panel = createToolbarPanel({ head: { position: { x: 0, y: 1.6, z: 0 },
        matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1] }, rows, measureText,
        readout: structureReadout(subject, { descriptionPage: page }).map((row, i) => ({ ...row, description: i === 0 })) });
      const lines = panel.readoutPoints.filter(row => row.description).map(row => row.text);
      assert.equal(lines.at(-1).endsWith('…'), page < pages.length - 1, lines.join(' / '));
      const plain = lines.join(' ').replace(/…$/u, '');
      assert.equal(plain, pages[page].replaceAll('\n', ' '), 'the mark follows a complete word');
      words.push(...plain.split(' '));
      const width = panel.captionBacking.halfWidth * 2 - SPATIAL_TOOLBAR_LAYOUT.backingPadMeters * .8 * 2;
      for (const line of lines) assert.ok(measureText(line) * panel.readoutFontMeters <= width + 1e-8);
    }
    assert.deepEqual(words, subject.title.split(' '));
  }
});

test('a paging description gets a Pg row, and only when a lesson caption is not already using it', () => {
  const pages = structureDescriptionPages(crambinSubject);
  const idOf = rows => rows.filter(row => row.id === 'description-page').map(row => row.label);
  const paging = { descriptionPageCount: pages.length, descriptionPageIndex: 1 };
  assert.deepEqual(idOf(spatialToolbarRows({ collapsed: false, readout: paging })), [`Pg 2/${pages.length}`]);
  assert.deepEqual(idOf(spatialToolbarRows({ collapsed: false, readout: { descriptionPageCount: 1, descriptionPageIndex: 0 } })), []);
  assert.deepEqual(idOf(spatialToolbarRows({ collapsed: false })), []);
  // One page row on the plate. A lesson caption that is paging keeps it.
  const tour = { selectedId: 'lesson', bodyPageCount: 4, bodyPageIndex: 0 };
  const withTour = spatialToolbarRows({ collapsed: false, tour, readout: paging });
  assert.deepEqual(idOf(withTour), []);
  assert.deepEqual(withTour.filter(row => row.id === 'page').map(row => row.label), ['Pg 1/4']);
  // The row carries its own action kind, so the toolbar can tell them apart.
  assert.deepEqual(spatialToolbarRows({ collapsed: false, readout: paging })
    .filter(row => row.action.kind === 'readout-page').length, 1);
});

/**
 * The chooser opens with two lines of its own on the plate and used to shut in
 * silence: pressing Menu with it open set `menuOpen` false and `selectedId`
 * null, and the plate went straight back to the resting caption. Read at 20 fps
 * across the whole transition on the Quest 2, and again 13 s
 * later, no sentence about it was ever drawn.
 */
test('the plate says the journey chooser closed, and takes the sentence back down', () => {
  const closedAt = 4_000;
  const shut = { active: false, menuOpen: false, selectedId: null,
    feedback: runtime.CHOOSER_CLOSED_LINE, chapterStartedAt: closedAt };
  const drawn = runtime.tourReadout(shut, subject, closedAt + 250);
  assert.equal(drawn[0].text, 'Tour chooser closed');
  assert.deepEqual(drawn.slice(1), structureReadout(subject).map(line => ({ ...line, forwardViewCap: true })));
  // A reading window, not a state: the resting caption comes back on its own.
  assert.deepEqual(runtime.tourReadout(shut, subject, closedAt + runtime.CHOOSER_CLOSED_WINDOW_MS),
    runtime.tourReadout({ active: false, menuOpen: false }, subject));
  assert.equal(runtime.tourReadout(shut, subject, closedAt + runtime.CHOOSER_CLOSED_WINDOW_MS - 1)[0].text,
    'Tour chooser closed');
});

test('the chooser sentence never covers the chooser itself, a running chapter, or an unstamped close', () => {
  const line = runtime.CHOOSER_CLOSED_LINE, at = 4_000;
  // Still open: the chooser's own two lines win.
  assert.equal(runtime.tourReadout({ active: false, menuOpen: true, selectedTitle: 'Fold Detective',
    feedback: line, chapterStartedAt: at }, subject, at + 100)[0].text, 'Fold Detective');
  // A running lesson keeps its chapter; closing the chooser hands that back.
  assert.equal(runtime.tourReadout({ active: true, selectedId: 'lesson', menuOpen: false, title: 'Meet the tetramer',
    feedback: line, chapterStartedAt: at }, subject, at + 100)[0].text, 'Meet the tetramer');
  // A build that stamps no clock, or a wall clock, draws the resting caption
  // rather than pinning the sentence to the plate forever.
  for (const stamp of [undefined, Date.now() * 2, at + 5_000])
    assert.deepEqual(runtime.tourReadout({ active: false, menuOpen: false, feedback: line, chapterStartedAt: stamp }, subject, at),
      runtime.tourReadout({ active: false, menuOpen: false }, subject));
  // An error the chooser close did not cause still outranks it.
  assert.equal(runtime.tourReadout({ active: false, menuOpen: false, feedbackError: true,
    feedback: 'No journey for 2XYZ yet', chapterStartedAt: at }, subject, at + 100)[0].text, 'No journey for 2XYZ yet');
});

test('both players write the sentence the plate draws, and stamp the clock it reads', () => {
  const line = runtime.CHOOSER_CLOSED_LINE;
  for (const name of ['tour-player.ts', 'experience-player.ts']) {
    const source = readFileSync(new URL(`../../plugin/src/${name}`, import.meta.url), 'utf8');
    const at = source.indexOf(`'${line}'`);
    assert.ok(at > 0, `${name} writes the sentence the plate draws`);
    // The sentence and its stamp belong to the same close, so they are written
    // together: a player that says it without stamping draws nothing at all.
    const close = source.slice(at - 200, at + 200);
    assert.ok(close.includes('menuOpen = false'), `${name} writes it where the chooser shuts`);
    assert.ok(/chapterStartedAt = (readoutClock\(\)|globalThis\.performance)/u.test(close),
      `${name} stamps the clock the caption window is measured on`);
  }
});

/**
 * The description page counter is toolbar-local by design — nothing outside the
 * plate has an opinion about which page of a sentence the wearer is on — so it
 * never reached `getSpatialState` and the driver had nothing to check a
 * `description-page` press against. Six presses turned the page on the display
 * and all six reported UNVERIFIED. Three seams carry it out to the menu hook,
 * and each one is a line a refactor could quietly drop.
 */
test('the description paging is published to the menu hook, from the plate through to the driver', () => {
  const toolbar = readFileSync(new URL('./spatial-toolbar.mjs', import.meta.url), 'utf8');
  assert.match(toolbar, /readout: \(\) => \{ const state = presentationState\(\); return \{ \.\.\.readoutPaging\(state\), cardHoldMs: cardHoldMs\(state\) \}; \}/u,
    'the toolbar publishes the same paging call its Pg row label is drawn from, with the card\'s reading hold');
  const session = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
  assert.match(session, /toolbarReadout: \(\) =>/u, 'the session forwards it');
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const hook = viewer.slice(viewer.indexOf('detachSpatialMenuHook = installSpatialMenuHook'));
  assert.match(hook.slice(0, 1_200), /toolbarReadout\?\.\(\)/u, 'the menu hook reads it beside the scene state');
});
