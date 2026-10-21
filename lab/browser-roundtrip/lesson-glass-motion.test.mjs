import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { CLEARANCE_STANDOFF_FACTOR, fitChapterField, framingEnvelopeObject, menuGlassInView, menuObstruction, visibleChapterSpheres } from './chapter-field.mjs';
import { renderedMeshVertexCount } from './component-label-measurement.mjs';
import { annotationFieldBounds } from './immersive-annotations.mjs';
import { motionFocusPlacement } from './motion-framing.mjs';
import { trackPointEnvelope } from './molecular-animation.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';
import { SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { coordinates } from './fixtures/kinesin-layout.mjs';
import { prepareLabelScene } from './fixtures/motion-label-layout.mjs';

const demos = JSON.parse(readFileSync(new URL('./fixtures/motion-demo-bounds.json', import.meta.url)));
const source = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/hemoglobin-switch/motion.json', import.meta.url)));
const runtime = await toolbarFrameRuntime();
const EYE = 1.6;
const chapter = lesson.chapters[0];
const tour = { active: true, selectedId: 'hemoglobin-switch-motion', title: chapter.title, step: 0, total: lesson.chapters.length,
  bodyPage: 'Green: alpha 1 beta 1, which stays fixed. Blue: alpha 2 beta 2, which turns 14.1 degrees about one axis.', canNext: true };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };

test('density chapter glass measures the contour instead of empty GPU grid corners', () => {
  const { h } = tourFocusHarness();
  const contour = { center: [10, 20, 30], radius: 307 };
  Object.assign(h, { volume: {}, loadedSphere: () => contour, visibleChapterSpheres,
    presentationTransform: identity, scientificRepresentations: () => [{ renderObjects: [{
      type: 'texture-mesh', state: { visible: true }, values: {
        boundingSphere: { ref: { value: { center: [10, 20, 30], radius: 590 } } },
      },
    }] }] });
  vm.runInContext(pageFunction(source, 'chapterFieldBounds'), h);
  const bounds = h.chapterFieldBounds(1, { still: true, drawn: true });
  assert.equal(bounds.radius, contour.radius);
  assert.deepEqual(Array.from(bounds.center), contour.center);
});

test('an end-on density chapter keeps the nearest clear frame with its complete lesson glass', async () => {
  const { h, records } = tourFocusHarness();
  const sphere = { center: [0, 0, 0], radius: 307,
    extrema: [-150, 150].flatMap(x => [-150, 150].flatMap(y => [-221, 221].map(z => [x, y, z]))) };
  const head = identity(); head[13] = EYE;
  const views = syntheticViews().map(view => {
    view.transform.matrix[13] = EYE; view.transform.inverse.matrix[13] = -EYE; return view;
  });
  const pose = { headInRoom: head, renderFromRoom: identity(), labelViews: views };
  const shown = { ...tour, title: 'Real density', bodyPage: 'A second experiment reveals the density of an EB3-bound microtubule.' };
  const seats = menuRelocationCandidates({ stableLesson: true,
    rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour: shown }), readout: runtime.tourReadout(shown),
    assistantLines: ['No assistant'], constants: SPATIAL_TOOLBAR_LAYOUT, measureText: runtime.toolbarTextWidth },
  { matrix: head, position: { x: 0, y: EYE, z: 0 } }, { ...pose, cardOnly: true }).filter(seat => !seat.beside);
  Object.assign(h, { volume: {}, VOLUME_WHOLE_LENS_CEILING: .55, fitChapterField, visibleChapterSpheres,
    latestRoomPlacementPose: pose, loadedSphere: () => sphere, recordBoundingSphere: () => sphere,
    pivotBounds: () => ({ baseCenter: sphere.center, visibleCenter: sphere.center, radius: sphere.radius }),
    // The chapter has no farther room seat. Clearance must use another glass
    // seat or the largest contour at this distance, never an unchecked frame.
    latestSeatStandoffMeters: 1 });
  h.canvas.camera.scale = .00151539;
  h.presentationTransform = () => h.placementTransform(h.inspectionSnapshot().placement);
  h.immersiveSession = { ...h.immersiveSession, platePoints: () => seats[0].points,
    captionPoints: () => [], drawnMenuPoints: () => [], menuRows: () => [], chapterCardSeats: () => seats };
  vm.runInContext(pageFunction(source, 'chapterFieldBounds'), h);
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', enclosure: .85, elevationDegrees: 0, durationMs: 0 });
  const result = records.find(record => record.reason === 'chapter-glass');
  assert.ok(result, 'a clear glass seat is found instead of accepting the overlapping frame');
  const chosen = seats.find(seat => seat.id === result.seat);
  assert.ok(chosen);
  assert.equal(chosen.panel.buttons.length, 4);
  assert.equal(chosen.panel.statusPoints.length, 1);
  assert.ok(chosen.panel.readoutPoints.length >= 2);
  const placement = h.inspectionSnapshot().placement;
  assert.ok(fitChapterField({ placement, bounds: h.chapterFieldBounds(placement.scale, { still: true, drawn: true }),
    center: sphere.center, radius: sphere.radius, cameraScale: h.canvas.camera.scale, ...pose,
    views, menuPoints: chosen.points, menuGlass: chosen.glass, exact: true, keepPlacement: true }), 'all glass clears in both eyes');
  const resized = records.find(record => record.reason === 'contour-glass-fit');
  assert.ok(resized, 'the fixture exercises the last-resort contour fit');
  const depth = -placement.translation[2] * sphere.radius * h.canvas.camera.scale;
  assert.ok(Math.abs(depth - 3.5) < .001, 'keeps the authored reading distance');
  const contourDiameter = 2 * Math.asin(placement.scale * sphere.radius * h.canvas.camera.scale / depth) * 180 / Math.PI;
  assert.ok(contourDiameter > 45, `the measured contour stays large (${contourDiameter} degrees)`);
});

// Hemoglobin's switch chapter in the headset: its whole-turn motion envelope
// (the one the device framed: radius 48.4 Å about the pair) and, with the
// demo cache, its authored plates riding their tracks. The page's own
// `chapterFieldBounds` and `clearChapterMenu` measure it against the real
// toolbar's glass, seated from the same head 1.6 m up.
async function hemoglobinSwitch({ grow = 1, held = false, name = 'hemoglobin-switch', lesson: given = lesson, tour: shown = tour,
  cameraScale = .0240464, previousScale = .782137849783092 } = {}) {
  const lesson = given, tour = shown, chapter = lesson.chapters[0];
  const demo = demos.find(d => d.demo === name && d.chapter === chapter.id);
  const target = { center: demo.target.center, radius: demo.target.radius * grow };
  const cache = process.env.STEREOFOLD_DEMO_CACHE;
  const scene = cache ? prepareLabelScene(chapter, coordinates(`${cache}/${demo.composite}`, lesson.provenance.sourceSha256)) : undefined;
  const { h, records } = tourFocusHarness();
  const head = identity(); head[13] = EYE;
  const views = syntheticViews().map(view => {
    view.transform.matrix[13] = EYE; view.transform.inverse.matrix[13] = -EYE; return view;
  });
  // The scales the headset framed this chapter at (hemoglobin: its 0.98 m fill seat 2.5 m away).
  Object.assign(h, { motionFocusPlacement, fitChapterField, visibleChapterSpheres, annotationFieldBounds, renderedMeshVertexCount,
    framingEnvelopeObject, interactionActive: () => false,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: views },
    loadedSphere: () => demo.source, recordBoundingSphere: () => demo.source,
    pivotBounds: () => ({ baseCenter: demo.source.center, visibleCenter: demo.source.center, radius: demo.source.radius }) });
  h.canvas.camera.scale = cameraScale;
  h.inspectionState.place({ translation: [0, EYE / (cameraScale * demo.source.radius), -2], rotation: [0, 0, 0], scale: previousScale });
  h.presentationTransform = () => h.placementTransform(h.inspectionSnapshot().placement);
  Object.assign(h.molecularAnimation, { envelope: () => demo.whole, framingEnvelope: () => target, fieldEnvelope: () => target,
    snapshot: () => ({ chapterId: chapter.id }) });
  const cell = value => ({ ref: { value } });
  const gain = .02421 / cameraScale;
  h.lessonFigure = { snapshot: () => ({}), annotations: () => (scene?.labels ?? []).map(label => {
    const half = .8 * label.text.length * .55 / 2 + .3;
    return { label, renderObjects: [{ type: 'text', state: { visible: true }, values: {
      instanceCount: cell(1), aPosition: cell(label.center), aTransform: cell(h.presentationTransform()),
      aMapping: cell([-half, -.7, half, .7]), dSizeType: cell('uniform'), uSize: cell(1),
      uSizeFactor: cell(6 * (label.sizeFactor ?? 1) * gain),
      uOffsetX: cell((label.offsetX ?? 0) * gain), uOffsetY: cell((label.offsetY ?? 0) * gain),
      uOffsetZ: cell(label.radius * h.inspectionSnapshot().placement.scale + 3 * gain),
    } }] };
  }) };
  h.molecularAnimation.annotationEnvelope = (repr, point) => {
    const track = scene?.chapter.animation.tracks.find(track => track.chains.includes(repr.label?.chain));
    return track && trackPointEnvelope(track, point);
  };
  vm.runInContext('var menuClearanceMovedFor = null;', h);
  for (const name of ['chapterFieldBounds', 'clearChapterMenu']) vm.runInContext(pageFunction(source, name), h);
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', elevationDegrees: 0,
    durationMs: 0, motionFrame: { target, previousScale } });
  if (held) h.wearerPlacement = { holdsPlacement: () => true };
  const framed = structuredClone(h.inspectionSnapshot().placement);
  // The field's centre in room metres, and as the wearer sees it.
  const seen = placement => {
    const rotation = Mat4.fromEuler(Mat4(), placement.rotation.map(v => v * Math.PI / 180), 'ZYX');
    const offset = Vec3.transformMat4(Vec3(), target.center.map((v, i) => v - demo.source.center[i]), rotation);
    const c = offset.map((v, i) => (v * placement.scale + demo.source.center[i] + placement.translation[i] * demo.source.radius) * cameraScale);
    const d = [c[0], c[1] - EYE, c[2]];
    return { c, distance: Math.hypot(...d), azimuth: Math.atan2(d[0], -d[2]) * 180 / Math.PI,
      elevation: Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI };
  };
  const decisions = [], toolbarRecords = [];
  const diagnostics = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => toolbarRecords.push({ kind, ...detail }) };
  const t = toolbarFrameHarness(runtime, { state: { tour }, beforeMenuDraw: async options => {
    const answer = await h.clearChapterMenu(options);
    decisions.push(answer);
    return answer;
  } });
  const dispose = async () => { await t.toolbar.dispose(); globalThis.__stereofoldDiagnostics = diagnostics; };
  return { h, t, records, toolbarRecords, decisions, framed, seen, dispose, scene, demo, target, previousScale };
}

// What the wearer reads on the card: its first line, the title and where the
// lesson is, then at least one line of caption.
const cardLines = t => t.toolbar.readoutText().filter(text => text);

test('the hemoglobin switch keeps its card and its menu while the pair turns', async t => {
  const fixture = await hemoglobinSwitch();
  const { h, records, toolbarRecords, framed, seen } = fixture;
  try {
    await fixture.t.toolbar.update(); await settle();
    const before = seen(framed), after = seen(h.inspectionSnapshot().placement);
    t.diagnostic(JSON.stringify({ before, after, field: records.filter(r => r.kind === 'chapter-field')
      .map(({ seats, ...rest }) => rest),
    lines: cardLines(fixture.t), seat: fixture.decisions.map(d => d?.chapterCardSeat && { id: d.chapterCardSeat.id, band: d.chapterCardSeat.band, buttons: d.chapterCardSeat.panel.buttons.length }) }));
    assert.equal(fixture.t.toolbar.isHidden(), false, 'the menu and card stay drawn');
    assert.ok(!toolbarRecords.some(r => r.phase === 'seat-commit' && r.hidden), 'no glass hides itself in a lesson');
    assert.ok(fixture.t.toolbar.drawnMenuPoints().length > 0, 'the Menu control is drawn');
    const lines = cardLines(fixture.t);
    assert.equal(lines[0], `${chapter.title} · 1/${lesson.chapters.length}`, 'the card keeps its title line');
    assert.ok(lines.join(' ').includes(tour.bodyPage), 'and its whole caption on one page');
    assert.ok(lines.length >= 2, 'and a caption line under it');
    // Not shoved up: the chapter stays where the eye level band put it,
    // moved at most sideways away from the menu or set back.
    assert.ok(Math.abs(after.elevation - before.elevation) < .5, `elevation ${before.elevation} -> ${after.elevation}`);
    assert.ok(after.c[0] <= before.c[0] + 1e-6, 'never toward the menu');
    assert.ok(Math.abs(after.azimuth - before.azimuth) < 10, `not shoved aside (${after.azimuth})`);
    assert.ok(after.distance >= before.distance - 1e-6, 'never pulled closer');
    assert.ok(after.distance <= CLEARANCE_STANDOFF_FACTOR * before.distance + 1e-6, 'within the stand-off');
  } finally { await fixture.dispose(); }
});

// A seat clear of the name plates comes before the top band: glass over a
// plate puts text on text.
test('past the stand-off the card keeps a seat clear of the name plates and retains the complete lesson controls', async t => {
  const fixture = await hemoglobinSwitch();
  const { h, records, toolbarRecords, framed, decisions } = fixture;
  // A stand-off this short leaves the chapter no farther seat: every level
  // move that clears the glass sets it back or aside, past the reach.
  h.latestSeatStandoffMeters = 1;
  try {
    await fixture.t.toolbar.update(); await settle();
    const kept = decisions.find(answer => answer?.kept)?.chapterCardSeat;
    t.diagnostic(JSON.stringify(records.filter(r => r.kind === 'chapter-field').map(({ seats, ...rest }) => rest)));
    assert.ok(kept, 'the glass is kept although it touches the motion');
    assert.equal(records.find(r => r.reason === 'chapter-card-kept').crossesPlates, false, 'its glass crosses no name plate');
    assert.deepEqual(kept.glass.map(glass => coverage(fixture, glass, plates(fixture))), kept.glass.map(() => 0),
      `${kept.id} (${kept.band}) clears every plate`);
    assert.equal(kept.stableLesson, true);
    if (fixture.scene) {
      // With the cached structure, every full card crosses a name plate.
      assert.ok(plates(fixture).spheres.length > 0, 'the cached fixture measures name plates');
      assert.equal(kept.shortCard, true);
      assert.equal(kept.panel.readoutLineBudget, 2);
    } else {
      // Without the cache there are no name plates. The stable 2×2 controls
      // leave a full card available, so preserve its three caption lines.
      assert.equal(plates(fixture).spheres.length, 0);
      assert.equal(kept.shortCard, undefined);
      assert.equal(kept.panel.readoutLineBudget, 4);
      assert.ok(cardLines(fixture.t).join(' ').includes(tour.bodyPage), 'the full caption stays whole');
    }
    assert.equal(kept.panel.buttons.length, fixture.t.toolbar.rows().length, 'all lesson controls stay');
    assert.equal(kept.panel.statusPoints.length, 1);
    assert.deepEqual(h.inspectionSnapshot().placement, framed, 'the molecule stays');
    assert.equal(fixture.t.toolbar.isHidden(), false);
    assert.ok(!toolbarRecords.some(r => r.phase === 'seat-commit' && r.hidden));
    assert.equal(cardLines(fixture.t)[0], `${chapter.title} · 1/${lesson.chapters.length}`);
    assert.ok(fixture.t.toolbar.drawnMenuPoints().length > 0);
    assert.deepEqual(records.filter(r => r.kind === 'chapter-field').map(r => r.reason), ['chapter-card-kept']);
    // A card page later in the chapter keeps the same view: the chapter
    // had its one try.
    h.latestSeatStandoffMeters = null;
    fixture.t.setState({ tour: { ...tour, bodyPage: 'Once the turn starts, a faded copy marks where the pair began.' } });
    await fixture.t.toolbar.update(); await settle();
    assert.deepEqual(h.inspectionSnapshot().placement, framed, 'no later draw moves the chapter');
    assert.equal(fixture.t.toolbar.isHidden(), false);
  } finally { await fixture.dispose(); }
});

test('a chapter the wearer holds keeps their placement, its card and its menu', async () => {
  const fixture = await hemoglobinSwitch({ held: true });
  const { h, framed } = fixture;
  try {
    await fixture.t.toolbar.update(); await settle();
    assert.deepEqual(h.inspectionSnapshot().placement, framed);
    assert.equal(fixture.t.toolbar.isHidden(), false);
    assert.equal(cardLines(fixture.t)[0], `${chapter.title} · 1/${lesson.chapters.length}`);
    assert.ok(fixture.t.toolbar.drawnMenuPoints().length > 0);
  } finally { await fixture.dispose(); }
});

// The agent scaled a chapter 3x and turned it 90 and -60 degrees on the
// Quest, and the card and menu vanished in most demos. In a lesson, glass
// never hides itself: it folds to the compact Menu or takes the card's other
// band, and stays where nothing clears.
for (const patch of [{ scale: 3 }, { rotation: [0, 90, 0] }, { rotation: [0, -60, 0] }]) {
  test(`a lesson keeps its card and menu after the agent sets ${JSON.stringify(patch)}`, async () => {
    const fixture = await hemoglobinSwitch({ held: true });
    const { h, toolbarRecords } = fixture;
    try {
      await fixture.t.toolbar.update(); await settle();
      const placement = h.inspectionSnapshot().placement;
      h.inspectionState.place({ ...placement, ...('scale' in patch ? { scale: placement.scale * patch.scale } : patch) });
      fixture.t.setState({ tour: { ...tour, bodyPage: 'Once the turn starts, a faded copy marks where the pair began.' } });
      await fixture.t.toolbar.update(); await settle();
      assert.equal(fixture.t.toolbar.isHidden(), false, 'the glass stays drawn');
      assert.ok(!toolbarRecords.some(r => r.phase === 'seat-commit' && r.hidden), 'no draw hides it');
      assert.equal(cardLines(fixture.t)[0], `${chapter.title} · 1/${lesson.chapters.length}`, 'the card keeps its title line');
      assert.ok(fixture.t.toolbar.drawnMenuPoints().length > 0, 'and the Menu control');
    } finally { await fixture.dispose(); }
  });
}

// The chapter entered again, as the tour enters it, now that its glass is
// seated: framed from the same pose, with the card seats the toolbar offers.
async function enterAgain(fixture) {
  const { h, framed, demo } = fixture;
  h.inspectionState.place(structuredClone(framed));
  vm.runInContext('menuClearanceMovedFor = null;', h);
  h.immersiveSession.chapterCardSeats = pose => fixture.t.toolbar.chapterCardSeats(pose);
  fixture.records.length = 0; fixture.decisions.length = 0;
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', elevationDegrees: 0,
    durationMs: 0, motionFrame: { target: fixture.target, previousScale: fixture.previousScale } });
  return structuredClone(h.inspectionSnapshot().placement);
}

test('the switch chapter is framed with room for its card and menu, and nothing moves it once it lands', async t => {
  const fixture = await hemoglobinSwitch();
  const { h, records, decisions, framed, seen } = fixture;
  try {
    await fixture.t.toolbar.update(); await settle();
    const landed = await enterAgain(fixture);
    fixture.t.setState({ tour: { ...tour, bodyPage: 'Once the turn starts, a faded copy marks where the pair began.' } });
    await fixture.t.toolbar.update(); await settle();
    const field = records.filter(r => r.kind === 'chapter-field');
    t.diagnostic(JSON.stringify(field.map(({ seats, bounds, ...rest }) => rest)));
    const room = field.find(r => r.reason === 'chapter-glass');
    assert.ok(room, 'the framing makes room for the glass');
    assert.equal(room.band, 'top', 'with the card in its top band');
    assert.deepEqual(h.inspectionSnapshot().placement, landed, 'nothing moves the chapter after it lands');
    assert.ok(!field.some(r => ['menu', 'chapter-card-kept', 'menu-obstructed'].includes(r.reason)),
      'the card and menu clear the chapter where it landed');
    assert.equal(fixture.t.toolbar.isHidden(), false);
    assert.equal(cardLines(fixture.t)[0], `${chapter.title} · 1/${lesson.chapters.length}`);
    assert.ok(decisions.every(d => !d?.kept));
    // It keeps its size: at most a quarter narrower, and 35 degrees at least.
    const before = seen(framed), after = seen(landed);
    const width = at => 2 * Math.atan(fixture.target.radius * at.scale * h.canvas.camera.scale / seen(at).distance) * 180 / Math.PI;
    t.diagnostic(JSON.stringify({ before: width(framed), after: width(landed), elevation: [before.elevation, after.elevation] }));
    assert.ok(width(landed) >= .75 * width(framed) - 1e-6, `${width(landed)} of ${width(framed)} degrees`);
    assert.ok(width(landed) >= 35 - 1e-6);
    assert.ok(Math.abs(after.elevation - before.elevation) < .5, 'level');
    assert.ok(Math.abs(after.azimuth - before.azimuth) <= 10 + 1e-6, `in front of the wearer (${after.azimuth})`);
  } finally { await fixture.dispose(); }
});

test('making room for glass later in a chapter never shrinks it more than a quarter', async t => {
  const fixture = await hemoglobinSwitch();
  const { h, records, framed, seen } = fixture;
  // The framing's size bound, as the chapter's entry sets it.
  const sizeAt = seen(framed).distance;
  try {
    await fixture.t.toolbar.update(); await settle();
    await enterAgain(fixture);
    const bound = vm.runInContext('chapterSizeBound', h);
    assert.ok(bound?.maxDistance > 0, 'the framing sets the size bound');
    h.inspectionState.place(structuredClone(framed));
    vm.runInContext('menuClearanceMovedFor = null;', h);
    records.length = 0;
    fixture.t.setState({ tour: { ...tour, bodyPage: 'Once the turn starts, a faded copy marks where the pair began.' } });
    await fixture.t.toolbar.update(); await settle();
    const moved = seen(h.inspectionSnapshot().placement);
    t.diagnostic(JSON.stringify({ sizeAt, moved: moved.distance, field: records.filter(r => r.kind === 'chapter-field').map(({ seats, bounds, ...rest }) => rest) }));
    assert.ok(moved.distance <= sizeAt / .75 + .02, `${moved.distance} m from ${sizeAt} m`);
    assert.equal(fixture.t.toolbar.isHidden(), false);
  } finally { await fixture.dispose(); }
});

// A drawn field of `count` small balls through the sphere, as one Mol* mesh
// with a group per ball: a large chapter draws thousands (the ATP rotor 2745,
// the kinesin walk 3416).
function drawnField(sphere, count) {
  const cell = value => ({ ref: { value } }), positions = [], groups = [], elements = [];
  let seed = 7;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  for (let n = 0; n < count; n++) {
    let p;
    do p = [0, 1, 2].map(() => 2 * random() - 1); while (Math.hypot(...p) > 1);
    const centre = p.map((v, i) => sphere.center[i] + v * sphere.radius * .9), r = sphere.radius * .03;
    for (const d of [[-r, -r, -r], [r, r, r], [r, -r, 0]]) { positions.push(...centre.map((v, i) => v + d[i])); groups.push(n); }
    elements.push(3 * n, 3 * n + 1, 3 * n + 2);
  }
  return { type: 'mesh', state: { visible: true }, values: { aPosition: cell(Float32Array.from(positions)),
    aGroup: cell(Float32Array.from(groups)), elements: cell(Uint32Array.from(elements)), drawCount: cell(elements.length),
    uVertexCount: cell(positions.length / 3), instanceCount: cell(1), aTransform: cell(new Float32Array(16)),
    boundingSphere: cell({ center: sphere.center, radius: sphere.radius }) } };
}

// The ATP rotor's chapters each took about 130 s to frame on the device: the
// room solve searched every card seat (up to 44), each over every drawn part.
test('a chapter of thousands of drawn parts makes room for its glass in few steps', async t => {
  const fixture = await hemoglobinSwitch();
  const { h, records } = fixture;
  const mesh = drawnField(fixture.demo.source, 3000);
  h.scientificRepresentations = () => {
    mesh.values.aTransform.ref.value = Float32Array.from(h.presentationTransform());
    return [{ renderObjects: [mesh] }];
  };
  const fit = h.fitChapterField, calls = [];
  h.fitChapterField = options => { calls.push(options.keepPlacement ? 'keep' : options.clearanceOnly ? 'search' : 'fit'); return fit(options); };
  try {
    await fixture.t.toolbar.update(); await settle();
    calls.length = 0;
    await enterAgain(fixture);
    const seats = fixture.t.toolbar.chapterCardSeats(h.latestRoomPlacementPose);
    const room = records.find(r => r.kind === 'chapter-field' && String(r.reason).startsWith('chapter-glass'));
    const count = kind => calls.filter(call => call === kind).length;
    t.diagnostic(JSON.stringify({ seats: seats.length, keep: count('keep'), search: count('search'), room }));
    const parts = h.chapterFieldBounds(undefined, { still: true, drawn: true }).spheres.length;
    assert.ok(parts >= 3000);
    assert.ok(room, 'the framing makes room for the glass');
    assert.ok(seats.length > 8);
    // Each complete lesson seat may be searched: its vertical position is
    // part of the clearance proof, rather than a different compact shape.
    assert.ok(count('keep') <= seats.length);
    assert.ok(count('search') <= seats.length, `${count('search')} seats searched`);
    // Each tested position measures groups of parts, and the parts of the
    // few groups the glass meets, not every part.
    assert.ok(room.steps > 0 && room.steps <= 1800, `${room.steps} positions`);
    assert.ok(room.tests <= room.steps * parts / 10, `${room.tests} part tests`);
  } finally { h.fitChapterField = fit; await fixture.dispose(); }
});

// The kinesin walk's heads carry their name plates a step along the filament.
// Each plate's travel was one sphere round its push and the ends of its step,
// half a metre above and below the heads it names, so the card covered it
// wherever it sat and the chapter kept its glass over them (0.31 on the
// device). A plate is its quad, pushed toward each eye from where it stands,
// carried along its path.
const kinesin = JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/motion.json', import.meta.url)));
test('the kinesin walk makes room for its card and menu clear of the plates riding its heads',
  { skip: !process.env.STEREOFOLD_DEMO_CACHE && 'needs STEREOFOLD_DEMO_CACHE' }, async t => {
    const first = kinesin.chapters[0];
    const walk = { active: true, selectedId: 'kinesin-walk-motion', title: first.title, step: 0, total: kinesin.chapters.length,
      bodyPage: 'Each head binds the filament, then swings past its partner.', canNext: true };
    // The scales the headset framed the walk at.
    const fixture = await hemoglobinSwitch({ name: 'kinesin-walk', lesson: kinesin, tour: walk,
      cameraScale: .00503, previousScale: .9313518360015975 });
    const { h, records } = fixture;
    try {
      assert.ok(fixture.scene.labels.length >= 5, 'the walk names its heads');
      await fixture.t.toolbar.update(); await settle();
      const landed = await enterAgain(fixture);
      fixture.t.setState({ tour: { ...walk, bodyPage: 'The rear head unbinds and swings forward 16 nm.' } });
      await fixture.t.toolbar.update(); await settle();
      const field = records.filter(r => r.kind === 'chapter-field');
      t.diagnostic(JSON.stringify(field.map(({ seats, bounds, ...rest }) => rest)));
      const room = field.find(r => r.reason === 'chapter-glass');
      assert.ok(room, 'the framing makes room for the glass');
      assert.equal(room.band, 'top', 'with its card on top');
      assert.ok(!field.some(r => ['chapter-card-kept', 'menu-obstructed', 'menu'].includes(r.reason)),
        'the card and menu clear the chapter and its moving plates where it landed');
      for (const glass of fixture.t.toolbar.glassPlates())
        assert.equal(coverage(fixture, glass), 0, 'the actual drawn glass clears the complete motion');
      assert.equal(fixture.t.toolbar.isHidden(), false);
      const bounds = h.chapterFieldBounds(undefined, { still: true });
      assert.ok(bounds.spheres.filter(sphere => sphere.kind === 'plate').length > fixture.scene.labels.length,
        'a moving plate counts along its path');
      // Framed again once its plates are drawn, it stays where it landed.
      vm.runInContext('menuClearanceMovedFor = null;', h);
      await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', elevationDegrees: 0,
        durationMs: 0, motionFrame: { target: fixture.target, previousScale: fixture.previousScale } });
      assert.deepEqual(h.inspectionSnapshot().placement, landed, 'a second framing moves nothing');
    } finally { await fixture.dispose(); }
  });

// How much of the chapter (or of `bounds`), as the page measures it, this glass covers.
function coverage(fixture, glass, bounds = fixture.h.chapterFieldBounds(undefined, { still: true })) {
  const { h } = fixture, pose = h.latestRoomPlacementPose, sphere = h.loadedSphere();
  return menuObstruction({ placement: h.inspectionSnapshot().placement, bounds,
    center: sphere.center, radius: sphere.radius, cameraScale: h.canvas.camera.scale, renderFromRoom: pose.renderFromRoom,
    views: pose.labelViews, menuPoints: glass, menuGlass: [glass], exact: true }).area;
}

// The chapter's name plates alone, still and moving.
function plates(fixture) {
  const bounds = fixture.h.chapterFieldBounds(undefined, { still: true });
  return { ...bounds, spheres: bounds.spheres.filter(sphere => sphere.kind === 'plate') };
}

test('the status card never covers the turning pair: it moves with the Menu control or drops to one line', async t => {
  const fixture = await hemoglobinSwitch();
  const { h, records, decisions } = fixture;
  h.latestSeatStandoffMeters = 1;
  runtime.assistantStatus.update({ action: { status: 'rendered', source: 'Assistant', text: 'started tour' } });
  try {
    await fixture.t.toolbar.update(); await settle();
    const kept = decisions.find(answer => answer?.kept)?.chapterCardSeat;
    t.diagnostic(JSON.stringify(records.filter(r => r.kind === 'chapter-field').map(({ seats, bounds, ...rest }) => rest)));
    assert.ok(kept, 'the glass is kept although the card touches the motion');
    assert.equal(records.find(r => r.reason === 'chapter-card-kept').crossesPlates, false, 'the card crosses no name plate');
    // Drawn, the status card covers nothing; where no seat of it clears, even
    // at one line, it is set aside for the chapter.
    const record = records.find(r => r.reason === 'chapter-card-kept');
    if (kept.statusGlass.length) assert.equal(coverage(fixture, kept.statusGlass), 0, 'the status card covers nothing of the chapter');
    else assert.equal(record.status, 'aside');
    const status = kept.panel.statusPoints.map(line => line.text);
    assert.ok([0, 3].includes(status.length) || (status.length === 1 && ['No assistant · A/X to talk', 'No assistant'].includes(status[0])), JSON.stringify(status));
    // The one-line card is still offered, and says who is there and how to talk.
    assert.deepEqual(runtime.assistantStatus.panelGlance(), ['No assistant · A/X to talk']);
    assert.equal(fixture.t.toolbar.isHidden(), false);
  } finally { await fixture.dispose(); }
});

test('a kept card does not lay its glass over a still name plate', async t => {
  const fixture = await hemoglobinSwitch({ held: true });
  const { h, records, decisions } = fixture;
  try {
    await fixture.t.toolbar.update(); await settle();
    const first = decisions.find(answer => answer?.kept)?.chapterCardSeat;
    assert.ok(first);
    // A still plate, as a still chapter draws one, behind the middle of that card.
    const eye = [0, EYE, 0], card = first.panel.captionBacking.point, sphere = h.loadedSphere();
    const placement = h.inspectionSnapshot().placement, scale = h.canvas.camera.scale;
    const depth = seen => Math.hypot(...seen.map((v, i) => v - eye[i]));
    const room = card.map((v, i) => eye[i] + (v - eye[i]) * 2.5 / depth(card));
    const local = room.map((v, i) => sphere.center[i] + (v / scale - sphere.center[i] - placement.translation[i] * sphere.radius) / placement.scale);
    const quad = [[.12 / scale, 0, 0], [0, .03 / scale, 0]];
    const measured = h.chapterFieldBounds;
    h.chapterFieldBounds = (...args) => {
      const bounds = measured(...args);
      return bounds && { ...bounds, spheres: [...bounds.spheres, { center: local, radius: .13 / scale / placement.scale, kind: 'plate', renderOffset: [0, 0, 0], quad }] };
    };
    decisions.length = 0;
    fixture.t.setState({ tour: { ...tour, bodyPage: 'Once the turn starts, a faded copy marks where the pair began.' } });
    await fixture.t.toolbar.update(); await settle();
    const kept = decisions.find(answer => answer?.kept)?.chapterCardSeat;
    t.diagnostic(JSON.stringify(records.filter(r => r.kind === 'chapter-field').map(({ seats, bounds, ...rest }) => rest)));
    assert.ok(kept, 'the glass is kept');
    const plate = { ...h.chapterFieldBounds(undefined, { still: true }) };
    plate.spheres = plate.spheres.filter(sphere => sphere.quad && !sphere.sweep);
    assert.equal(plate.spheres.length, 1, 'the still plate, beside the moving ones');
    assert.equal(menuObstruction({ placement, bounds: plate, center: sphere.center, radius: sphere.radius, cameraScale: scale,
      renderFromRoom: h.latestRoomPlacementPose.renderFromRoom, views: h.latestRoomPlacementPose.labelViews,
      menuPoints: kept.points, menuGlass: kept.glass, exact: true }).area, 0, `${kept.id} (${kept.band}) clears the plate`);
    assert.equal(kept.panel.statusPoints.length, 1, 'clearing the name plate retains the lesson status line');
    assert.ok(kept.panel.statusBacking && kept.statusGlass.length, 'the complete status card stays drawn');
    assert.equal(fixture.t.toolbar.isHidden(), false);
    assert.equal(cardLines(fixture.t)[0], `${chapter.title} · 1/${lesson.chapters.length}`);
  } finally { await fixture.dispose(); }
});

// Each seat a draw tests is measured by its own glass. The device record gave
// every seat of a chapter the same worst overlap (0.2325, 0.0074): the card
// all of them share, never the seat's own menu column.
test('each seat a lesson tests is recorded by its own card, menu and status plates', async t => {
  const fixture = await hemoglobinSwitch({ held: true });
  const { h, records } = fixture;
  let offered = [];
  const clear = h.clearChapterMenu;
  h.clearChapterMenu = options => { offered = options.chapterCardCandidates(h.latestRoomPlacementPose); return clear(options); };
  try {
    await fixture.t.toolbar.update(); await settle();
    const record = records.find(r => r.reason === 'chapter-card-kept');
    assert.ok(record, 'the held chapter keeps its glass');
    t.diagnostic(JSON.stringify(record.seats.slice(0, 6)));
    const variants = [...offered, ...offered.filter(seat => seat.statusless).map(seat =>
      ({ ...seat, ...seat.statusless, id: `${seat.id}-statusless` }))];
    const byId = new Map(variants.map(seat => [seat.id, seat]));
    assert.ok(record.seats.length >= 2);
    const pose = h.latestRoomPlacementPose, sphere = h.loadedSphere();
    const own = plate => menuObstruction({ placement: h.inspectionSnapshot().placement, bounds: h.chapterFieldBounds(undefined, { still: true }),
      center: sphere.center, radius: sphere.radius, cameraScale: h.canvas.camera.scale, renderFromRoom: pose.renderFromRoom,
      views: pose.labelViews, menuPoints: plate, menuGlass: [plate], exact: true }).area;
    const columns = new Set();
    for (const entry of record.seats) {
      const [name, areas] = entry.split(':');
      const seat = byId.get(name.split(' ')[0]);
      assert.ok(seat, `${name} is a seat this draw tested`);
      assert.deepEqual(areas.split('/').map(Number), seat.glass.map(plate => Math.round(own(plate) * 1e4) / 1e4), `${name} by its own plates`);
      columns.add(areas.split('/')[1]);
    }
    assert.ok(columns.size > 1, 'seats whose menu columns stand apart are not all reported alike');
  } finally { h.clearChapterMenu = clear; await fixture.dispose(); }
});

// The ATP rotor's sites and epsilon chapters drew a narrow side card that held
// `Three catalytic sites` over `One site holds…`, without the `· 4/7`.
for (const [title, step] of [['Three catalytic sites', 3], ['Epsilon may block', 4], ['Sites', 3]]) {
  test(`a side card is offered only when it holds the whole "${title}" line over a caption line`, () => {
    const chapterTour = { active: true, selectedId: 'atp-synthase-rotor-motion', title, step, total: 7, canNext: true,
      bodyPage: 'One site holds ATP, one holds ADP and one is empty; each turn of the rotor moves them on.' };
    const readout = runtime.tourReadout(chapterTour);
    const head = { matrix: identity(), position: { x: 0, y: EYE, z: 0 } };
    const views = syntheticViews().map(view => { view.transform.inverse.matrix[13] = -EYE; return view; });
    const candidates = menuRelocationCandidates({ rows: spatialToolbarRows({ collapsed: true, tour: chapterTour }), readout,
      constants: SPATIAL_TOOLBAR_LAYOUT, measureText: runtime.toolbarTextWidth }, head,
      { headInRoom: head.matrix, renderFromRoom: identity(), labelViews: views, cardOnly: true });
    assert.ok(candidates.some(seat => seat.id.startsWith('compact') && seat.band === 'top' && !seat.beside));
    for (const seat of candidates.filter(seat => seat.beside)) {
      assert.equal(seat.panel.readoutPoints[0].text, readout[0].text, `${seat.id} keeps the title line`);
      assert.ok(seat.panel.readoutPoints.length >= 2, `${seat.id} keeps a caption line`);
    }
    for (const seat of candidates.filter(seat => !seat.beside && seat.panel.readoutPoints?.length))
      assert.equal(seat.panel.readoutPoints[0].text, readout[0].text, `${seat.id} keeps the title line`);
  });
}
