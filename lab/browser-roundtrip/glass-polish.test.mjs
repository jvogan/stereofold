import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT, toolbarGlassPlates } from './spatial-toolbar-geometry.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';
import { menuGlassInView, menuObstruction, visibleChapterSpheres } from './chapter-field.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { entryProducerHarness } from './fixtures/entry-standoff.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: identity() }; head.matrix[13] = 1.6;
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const tour = { active: true, selectedId: 'polish', title: 'Rotor stops', step: 6, total: 7, canNext: true, chapterStartedAt: 0,
  bodyPage: 'The shaft rotates through the catalytic head while the outer frame stays fixed.' };
const options = (extra = {}) => ({ head, constants: SPATIAL_TOOLBAR_LAYOUT,
  rows: spatialToolbarRows({ collapsed: true, quiet: true, tour }),
  readout: runtime.tourReadout(tour, undefined, 0), readoutPage: 0, measureText: runtime.toolbarTextWidth,
  assistantLines: ['No assistant connected', 'Hold A or X to talk', 'Assistant: next tour'],
  assistantGlance: ['No assistant · A/X to talk'], ...extra });

test('every status plate stays flat beneath the column, no wider than a full menu, sized to its words under a compact control', () => {
  const seats = menuRelocationCandidates(options(), head, { cardOnly: true });
  assert.ok(seats.some(seat => seat.compact && seat.panel.statusBacking), 'a compact seat keeps its status');
  for (const seat of seats) {
    const panel = seat.panel, plate = panel.statusBacking;
    if (!plate) continue;
    const menu = panel.backing ?? panel.buttons[0];
    const across = Math.abs(dot(sub(plate.point, menu.point), panel.right));
    if (seat.compact) {
      const words = Math.max(...panel.statusPoints.map(line => runtime.toolbarTextWidth(line.text))) * panel.assistantFontMeters / 2;
      assert.ok(plate.halfWidth <= Math.max(menu.halfWidth, words + SPATIAL_TOOLBAR_LAYOUT.backingPadMeters) + 1e-9,
        `${seat.id}: compact status is sized to its words`);
      assert.ok(across + menu.halfWidth <= plate.halfWidth + 1e-9, `${seat.id}: the whole control stays above its status`);
    } else {
      assert.ok(plate.halfWidth <= menu.halfWidth + 1e-9, `${seat.id}: status is wider than column`);
      assert.ok(across < 1e-9, `${seat.id}: status moved sideways`);
    }
    assert.ok(plate.point[1] + plate.halfHeight < menu.point[1] - menu.halfHeight, `${seat.id}: status is beneath column`);
    assert.ok(Math.abs(dot(plate.normal ?? panel.normal, panel.up)) < 1e-9, `${seat.id}: plate remains upright`);
    for (const line of panel.statusPoints) assert.ok(runtime.toolbarTextWidth(line.text) * panel.assistantFontMeters < 2 * plate.halfWidth);
  }
});

test('compact cards fit completely through asymmetric projections in both current eyes', () => {
  // A design-frame corner can be in the nominal 39° band but outside one
  // actual eye's narrower, asymmetric projection (rotor ch7 / turned cards).
  const views = syntheticViews().map(view => {
    view.transform.inverse.matrix[13] = -1.6;
    view.projectionMatrix[0] = 1.15;
    view.projectionMatrix[8] = view.eye === 'right' ? .12 : -.04;
    return view;
  });
  const seats = menuRelocationCandidates(options(), head, { cardOnly: true, labelViews: views, renderFromRoom: identity() });
  assert.ok(seats.some(seat => seat.compact), 'a readable compact seat remains');
  for (const seat of seats) assert.equal(menuGlassInView({ views, renderFromRoom: identity(),
    menuPoints: seat.points, menuGlass: seat.glass, fully: true }), true, `${seat.id}: every corner in both eyes`);
});

test('worker side relocations cannot place any glass beyond the current eyes', () => {
  const views = syntheticViews().map(view => { view.transform.inverse.matrix[13] = -1.6; return view; });
  const seats = menuRelocationCandidates(options(), head, { labelViews: views, renderFromRoom: identity() });
  assert.ok(seats.length > 0);
  for (const seat of seats) assert.equal(menuGlassInView({ views, renderFromRoom: identity(), menuPoints: seat.points,
    menuGlass: seat.glass, fully: true }), true, `${seat.id}: a hypothetical turned view cannot admit a clipped side plate`);
});

test('caption page cue appears only for multiple pages, in its own padded footer', () => {
  for (const bodyPage of ['One short sentence.', Array(20).fill(tour.bodyPage).join(' ')]) {
    const readout = runtime.tourReadout({ ...tour, bodyPage }, undefined, 0);
    const first = createToolbarPanel(options({ readout }));
    if (first.readoutPageCount === 1) assert.equal(first.readoutPageCue, undefined);
    else for (let page = 0; page < first.readoutPageCount; page++) {
      const panel = createToolbarPanel(options({ readout, readoutPage: page }));
      const cue = panel.readoutPageCue;
      assert.ok(cue, 'multi-page card has a page cue');
      assert.equal(cue.text, `${page + 1}/${first.readoutPageCount}`);
      assert.ok(cue.fontMeters < panel.readoutFontMeters);
      assert.ok(cue.point[1] < panel.readoutPoints.at(-1).point[1] - panel.readoutFontMeters / 2);
      assert.ok(cue.point[1] - cue.fontMeters / 2 > panel.captionBacking.point[1] - panel.captionBacking.halfHeight);
    }
  }
});

test('glucose ch4 keeps every caption line inside a generous text margin', () => {
  const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/glucose-transporter.json', import.meta.url)));
  const chapter = lesson.chapters[3];
  const readout = runtime.tourReadout({ ...tour, title: chapter.title, step: 3, total: lesson.chapters.length,
    bodyPage: chapter.immersive?.narration ?? chapter.caption }, undefined, 0);
  const first = createToolbarPanel(options({ readout }));
  const captions = [];
  for (let page = 0; page < first.readoutPageCount; page++) {
    const panel = createToolbarPanel(options({ readout, readoutPage: page }));
    for (const line of panel.readoutPoints) assert.ok(panel.captionBacking.halfWidth * 2
      - runtime.toolbarTextWidth(line.text) * panel.readoutFontMeters >= panel.readoutFontMeters * 1.6,
    `whole padded line: ${line.text}`);
    captions.push(...panel.readoutPoints.slice(1).map(line => line.text));
  }
  const words = text => text.replaceAll('…', '').split(/\s+/u).filter(Boolean);
  assert.deepEqual(words(captions.join(' ')), words(chapter.immersive?.narration ?? chapter.caption));
});

test('first chapter framing tests status-less glass before any molecular move', async () => {
  const { h, records } = tourFocusHarness();
  const panel = createToolbarPanel(options());
  const stripped = { ...panel, statusBacking: undefined, statusPoints: [], statusPoint: panel.buttons[0].point };
  const glass = toolbarGlassPlates(panel), plainGlass = toolbarGlassPlates(stripped);
  const seat = { id: 'status-blocked', band: 'top', points: glass.flat(), glass, statusGlass: glass.at(-1), panel,
    statusless: { points: plainGlass.flat(), glass: plainGlass, panel: stripped } };
  h.immersiveSession.chapterCardSeats = () => [seat];
  h.menuGlassInView = () => true;
  h.chapterFieldBounds = () => ({ center: [0, 0, 0], radius: 100 });
  const calls = [];
  h.fitChapterField = options => {
    if (!options.keepPlacement && !options.clearanceOnly) return options.placement;
    calls.push({ keep: options.keepPlacement, plates: options.menuGlass?.length });
    if (options.keepPlacement) return options.menuGlass.length === 2 ? options.placement : undefined;
    throw Error('status alone must never trigger a move');
  };
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, durationMs: 0 });
  assert.equal(records.find(r => String(r.reason).startsWith('chapter-glass'))?.reason, 'chapter-glass');
  assert.deepEqual(calls, [{ keep: true, plates: 3 }, { keep: true, plates: 2 }]);
});

test('a clear top seat without status wins over a bottom seat or any later move', async () => {
  const { h, records } = tourFocusHarness();
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  vm.runInContext(pageFunction(viewer, 'clearChapterMenu'), h);
  h.interactionActive = () => false;
  h.chapterFieldBounds = () => ({ center: [0, 0, 0], radius: 100, spheres: [{ center: [0, 0, 0], radius: 1, kind: 'plate' }], still: true });
  const panel = createToolbarPanel(options());
  const plain = { ...panel, statusBacking: undefined, statusPoints: [], statusPoint: panel.buttons[0].point };
  const statusless = { panel: plain, points: toolbarGlassPlates(plain).flat(), glass: toolbarGlassPlates(plain) };
  const top = { id: 'top', band: 'top', panel, points: toolbarGlassPlates(panel).flat(), glass: toolbarGlassPlates(panel), statusless };
  // The view adapter isolates seat priority from projection here.
  h.menuGlassInView = () => true; h.glassPlatesOverlapInViews = () => false;
  h.fitChapterField = options => options.menuGlass?.length === 2 ? options.placement : undefined;
  const answer = await h.clearChapterMenu({ points: top.points, glass: top.glass, isCurrent: () => true,
    chapterCardCandidates: () => [top], lesson: true });
  assert.equal(answer?.kept, undefined);
  assert.equal(answer?.chapterCardSeat?.band, 'top');
  assert.equal(answer?.chapterCardSeat?.statusAside, true);
  assert.equal(records.at(-1).reason, 'chapter-card-seated');
});

test('a complete centred bottom caption wins over a narrow corner fallback', async () => {
  const { h, records } = tourFocusHarness();
  vm.runInContext(pageFunction(readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8'), 'clearChapterMenu'), h);
  h.interactionActive = () => false;
  h.chapterFieldBounds = () => ({ center: [0, 0, 0], radius: 1, still: true });
  h.menuGlassInView = () => true; h.glassPlatesOverlapInViews = () => false;
  const panel = createToolbarPanel(options());
  const glass = toolbarGlassPlates(panel);
  const corner = { id: 'corner', compact: true, beside: true, band: 'top', panel, points: glass.flat(), glass };
  const bottom = { ...corner, id: 'centred-bottom', beside: false, band: 'bottom' };
  h.fitChapterField = input => input.menuPoints?.length ? input.placement : undefined;
  const result = await h.clearChapterMenu({ points: [], glass: [], currentPoints: [], currentGlass: [],
    isCurrent: () => true, lesson: true, chapterCardCandidates: () => [corner, bottom] });
  assert.equal(result?.chapterCardSeat?.id, 'centred-bottom');
  assert.equal(records.at(-1)?.reason, 'chapter-card-seated');
});

test('spacefill clearance uses drawn atom balls, not empty space in the assembly sphere', () => {
  const cell = value => ({ ref: { value } });
  const object = { type: 'spheres', state: { visible: true }, values: {
    boundingSphere: cell({ center: [0, 0, 0], radius: 2 }),
    tPositionGroup: cell({ array: new Float32Array([-.8, 0, 0, 0, .8, 0, 0, 1, 0, 3, 0, 2]) }),
    drawCount: cell(12), instanceCount: cell(1), aTransform: cell(identity()),
    dSizeType: cell('group'), uGroupCount: cell(3), tSize: cell({ array: new Uint8Array([0, 0, 11, 0, 0, 21, 0, 0, 101]) }),
    uSizeFactor: cell(1),
  } };
  const spheres = visibleChapterSpheres([object], identity());
  assert.equal(spheres.length, 2, 'only two drawn atoms count, without the stale texture tail');
  assert.deepEqual(spheres.map(ball => ball.radius), [.1, .2]);
  const bounds = { center: [0, 0, 0], radius: 2, spheres, still: true };
  const plate = [[-.2, .6, -1], [.2, .6, -1], [.2, .9, -1], [-.2, .9, -1]];
  assert.equal(menuObstruction({ bounds, center: [0, 0, 0], radius: 1, cameraScale: 1,
    placement: { translation: [0, 0, -2], rotation: [0, 0, 0], scale: 1 },
    renderFromRoom: identity(), views: syntheticViews(), menuPoints: plate }).area, 0);
});

test('status clearance includes faded mesh groups as well as object opacity', () => {
  const cell = value => ({ ref: { value } });
  const object = { type: 'mesh', state: { visible: true }, values: {
    boundingSphere: cell({ center: [0, 0, 0], radius: 2 }),
    aPosition: cell(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])), aGroup: cell(new Float32Array([0, 0, 0])),
    elements: cell(new Uint32Array([0, 1, 2])), drawCount: cell(3), uVertexCount: cell(3),
    instanceCount: cell(1), aTransform: cell(identity()), uGroupCount: cell(1),
    dTransparency: cell(true), dTransparencyType: cell('groupInstance'),
    tTransparency: cell({ array: new Uint8Array([220]) }), uTransparencyStrength: cell(1),
  } };
  assert.equal(visibleChapterSpheres([object], identity()).length, 0, 'substantive framing may omit faded context');
  assert.equal(visibleChapterSpheres([object], identity(), { minimumAlpha: 0 }).length, 1,
    'status must clear every visible group, including the faint CRISPR strand');
});

test('a pushed name plate measures the same quad after the chapter changes distance', () => {
  const views = syntheticViews();
  const plate = distance => {
    const vector = [.032, 0, distance], length = Math.hypot(...vector), toward = vector.map(v => v / length);
    return { center: [0, 0, 0], radius: .3, kind: 'plate', quad: [[.3, 0, 0], [0, .15, 0]],
      push: .4, toward, renderOffset: toward.map(v => v * .4) };
  };
  const at = sphere => menuObstruction({ placement: { translation: [0, 0, -2], rotation: [0, 0, 0], scale: 1 },
    bounds: { center: [0, 0, 0], radius: 1, spheres: [sphere] }, center: [0, 0, 0], radius: 1,
    cameraScale: 1, renderFromRoom: identity(), views,
    menuPoints: [[-.2, -.2, -1], [.2, -.2, -1], [.2, .2, -1], [-.2, .2, -1]] });
  const first = at(plate(1)), later = at(plate(2));
  assert.ok(first.area > 0);
  assert.ok(Math.abs(first.area - later.area) < 1e-12, 'seat proof does not depend on the preceding plate distance');
});

test('a transient status uses a flat seat under the menu column, or stays off when too wide', async () => {
  const views = syntheticViews().map(view => { view.transform.inverse.matrix[13] = -1.6; return view; });
  for (const halfWidth of [.25, .03]) {
    const live = new Set(), records = [];
    const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() }, head: () => head,
      presentation: { add: r => live.add(r), remove: r => live.delete(r) },
      clearance: () => ({ views, renderFromRoom: identity() }),
      captionColumn: () => ({ top: [-.6, 1.3, -1.4], halfWidth, right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], forward: [0, 0, -1] }),
      record: (kind, detail) => records.push({ kind, ...detail }) });
    try {
      card.set({ notice: 'Applied · scale · r4' });
      for (let i = 0; i < 100; i++) await new Promise(resolve => setImmediate(resolve));
      if (halfWidth < .1) assert.equal(live.size, 0, 'an unreadable column cannot draw an independent status plate');
      else {
        const shown = records.find(r => r.kind === 'talk-caption-seat' && r.outcome === 'shown');
        assert.ok(shown, 'the status is drawn');
        assert.equal(shown.seat[0], -.6);
        assert.ok(shown.seat[1] < 1.3);
        const plate = [...live].find(r => r.shape?.name === 'Stereofold caption plate');
        const vertices = plate.shape.geometry.triangles.flatMap(t => t.points);
        assert.ok(vertices.every(p => Math.abs(p[2] + 1.4) < 1e-9), 'status glass is flat');
      }
    } finally { await card.dispose(); }
  }
});

test('temporary status clearance includes the drawn lesson bodies after an agent scale', () => {
  const { h } = tourFocusHarness();
  vm.runInContext(pageFunction(readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8'), 'replyCardClearance'), h);
  const body = { type: 'mesh', id: 'scaled-lesson-body' };
  const inspected = [];
  Object.assign(h, { componentLabelMeasurement: undefined, plugin: { state: { data: { cells: new Map() } } },
    componentLabels: { refs: () => [] }, scientificRepresentations: () => [{ renderObjects: [body] }],
    renderedSubjectSpheres: object => { inspected.push(object.id); return [{ center: [0, 0, -1], radius: 1 }]; },
    measureComponentLabels: options => options.subject, representation: undefined, ligandOverlay: undefined });
  const result = h.replyCardClearance();
  assert.deepEqual(inspected, ['scaled-lesson-body']);
  assert.equal(result.measured.spheres.length, 1);
});


test('a narrow assistant plate shows whole presence text or stays off', () => {
  const seats = menuRelocationCandidates(options(), head, { cardOnly: true });
  for (const { panel } of seats) for (const line of panel.statusPoints) {
    assert.ok(!line.text.includes('…'), 'status never consists of clipped fragments');
  }
});

test('status yields to a drawn faint context strand without moving the chapter', async () => {
  const { h, records } = tourFocusHarness();
  vm.runInContext(pageFunction(readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8'), 'clearChapterMenu'), h);
  const bright = { center: [0, 0, 0], radius: 1, still: true };
  const faint = { ...bright, includesFaint: true };
  h.chapterFieldBounds = (_scale, options) => !options.drawn ? undefined : options.allDrawn ? faint : bright;
  h.interactionActive = () => false;
  h.menuGlassInView = () => true; h.glassPlatesOverlapInViews = () => false;
  const panel = createToolbarPanel(options({ assistantLines: ['Ready'], assistantGlance: ['Ready'] }));
  const plain = { ...panel, statusBacking: undefined, statusPoints: [], statusPoint: panel.buttons[0].point };
  const glass = toolbarGlassPlates(panel), statusGlass = glass.at(-1);
  const seat = { id: 'faint-context', band: 'top', panel, glass, points: glass.flat(), statusGlass,
    statusless: { panel: plain, glass: toolbarGlassPlates(plain), points: toolbarGlassPlates(plain).flat() } };
  h.fitChapterField = options => options.bounds.includesFaint && options.menuPoints === statusGlass ? undefined : options.placement;
  const result = await h.clearChapterMenu({ points: seat.points, glass, statusGlass, lesson: true, isCurrent: () => true,
    chapterCardCandidates: () => [seat] });
  assert.equal(result?.chapterCardSeat?.statusAside, true, 'the bright subject clears but faint drawn context blocks the status');
  assert.equal(records.at(-1)?.reason, 'chapter-card-seated');
});

test('an unillustrated chapter invalidates glass clearance after its drawn source or pose changes', () => {
  const fixture = entryProducerHarness();
  const object = fixture.getEntryGeometry().objects[0];
  object.state = { visible: true, alphaFactor: .1 };
  fixture.page.scientificRepresentations = () => [{ renderObjects: [object] }];
  const first = fixture.getEntryGeometry().clearanceKey;
  assert.ok(first, 'a plain chapter needs a clearance key too');
  object.state.alphaFactor = 1;
  const second = fixture.getEntryGeometry().clearanceKey;
  assert.notEqual(second, first, 'a newly visible strand invalidates the status proof');
  fixture.page.presentationTransform = () => { const matrix = identity(); matrix[12] = 1; return matrix; };
  assert.notEqual(fixture.getEntryGeometry().clearanceKey, second, 'a placement edit invalidates the proof');
});


const flushCaption = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
async function columnCaption() {
  runtime.assistantStatus.update({ microphone: 'idle' });
  const menu = toolbarFrameHarness(runtime, { state: { tour } });
  await menu.toolbar.update();
  let clock = 0, pose = head;
  const live = new Set(), records = [];
  const views = () => syntheticViews().map(view => {
    const yaw = Math.atan2(pose.matrix[8], pose.matrix[10]), c = Math.cos(yaw), s = Math.sin(yaw);
    const m = view.transform.inverse.matrix;
    m[0] = c; m[2] = s; m[8] = -s; m[10] = c; m[13] = -1.6;
    return view;
  });
  const clearance = () => ({ views: views(), renderFromRoom: identity() });
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add: r => live.add(r), remove: r => live.delete(r) }, head: () => pose,
    menuPoints: () => menu.toolbar.menuPoints(), captionColumn: () => menu.toolbar.captionColumn(), clearance,
    now: () => clock, record: (kind, detail) => records.push({ kind, ...detail }) });
  return { menu, card, live, records, clearance,
    advance: async time => { clock = time; card.frame(); await flushCaption(); },
    turn: degrees => { const a = degrees * Math.PI / 180, m = identity();
      m[0] = m[10] = Math.cos(a); m[8] = Math.sin(a); m[2] = -Math.sin(a); m[13] = 1.6;
      pose = { ...head, matrix: m }; },
    dispose: async () => { await card.dispose(); await menu.toolbar.dispose(); } };
}

test('Listening clears a normal collapsed lesson column with the actual menuPoints', async () => {
  const h = await columnCaption();
  try {
    assert.ok(h.menu.toolbar.menuPoints().length);
    h.card.set({ talking: true }); await flushCaption();
    assert.equal(h.card.text(), 'Listening…');
    assert.equal(h.records.filter(r => r.kind === 'talk-caption-seat').at(-1)?.outcome, 'shown');
  } finally { await h.dispose(); }
});

for (const reply of ['Watch the molecule change shape while the binding site stays still.',
  'Watch the molecule change shape while the binding site stays still. Follow the moving domain as it closes around the ligand, then compare the contacts in the open and closed structures.']) {
  test(`a reply under the menu column preserves every word and each reading window: ${reply}`, async () => {
    const h = await columnCaption(), receipts = [], pages = [];
    // A reply wider than the column takes the ordinary reply seat, whose
    // search yields to the event loop between candidates.
    const until = async done => { for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
    runtime.setTalkOutcomeSink((text, holdMs, complete, onSeat) => h.card.set({ outcome: text, holdMs, complete, onSeat }));
    try {
      assert.equal(runtime.showTalkOutcome(reply, 6000, true, receipt => receipts.push(receipt)), true);
      await until(() => h.card.text());
      for (let time = 0; time < 120000 && h.card.text(); time += 6000) {
        const page = h.card.text(); pages.push(page);
        await h.advance(time + 5999);
        assert.equal(h.card.text(), page, 'the page holds its full six seconds');
        await h.advance(time + 6000);
        await until(() => h.card.text() !== page);
      }
      assert.equal(receipts[0]?.outcome, 'shown');
      assert.deepEqual(pages, runtime.captionPages(reply), 'paged as the ordinary reply, not to the column');
      assert.equal(pages.join(' '), reply);
      assert.equal(h.card.text(), '');
    } finally { runtime.setTalkOutcomeSink(undefined); await h.dispose(); }
  });
}

test('a visible column caption stops rebuilding after a held 20 degree head turn', async () => {
  let time = 0, pose = head;
  const records = [];
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add() {}, remove() {} }, head: () => pose, now: () => time,
    clearance: () => ({ views: syntheticViews().map(view => {
      const m = view.transform.inverse.matrix, p = pose.matrix;
      m[0] = p[0]; m[2] = p[8]; m[8] = p[2]; m[10] = p[10]; m[13] = -1.6;
      return view;
    }), renderFromRoom: identity() }),
    captionColumn: () => ({ top: [-.1, 1.3, -.9], halfWidth: .25, right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], forward: [0, 0, -1] }),
    record: (kind, detail) => records.push({ kind, ...detail }) });
  try {
    card.set({ talking: true }); await flushCaption();
    assert.equal(card.text(), 'Listening…');
    const builds = runtime.counts.ShapeRepresentation, points = card.platePoints();
    const a = 20 * Math.PI / 180, m = identity(); m[0] = m[10] = Math.cos(a); m[8] = Math.sin(a); m[2] = -Math.sin(a);
    pose = { ...head, matrix: m };
    for (time = 200; time <= 2000; time += 200) { card.frame(); await flushCaption(); }
    assert.equal(runtime.counts.ShapeRepresentation, builds);
    assert.deepEqual(card.platePoints(), points);
  } finally { await card.dispose(); }
});
