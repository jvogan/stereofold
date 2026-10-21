import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { glassPlatesOverlap, seatEyeViews } from './glass-overlap.mjs';
import { CLEARANCE_STANDOFF_FACTOR, fitChapterField, framingEnvelopeObject, menuGlassInView, menuObstruction, menuOverlap, visibleChapterSpheres } from './chapter-field.mjs';
import { renderedMeshVertexCount } from './component-label-measurement.mjs';
import { XR_ROOM_MAX_METRES } from './placement-limits.mjs';
import { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, toolbarPlatePoints, toolbarCaptionPoints, toolbarDrawnMenuPoints, toolbarGlassPlates, toolbarMenuRowPoints } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';
import { entryProducerHarness } from './fixtures/entry-standoff.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { trackPointEnvelope } from './molecular-animation.mjs';
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
import { poseMatrix } from './molecular-animation.mjs';
import { motionFocusPlacement } from './motion-framing.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';
import { annotationFieldBounds } from './immersive-annotations.mjs';
import { resetEntryGeometry, resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';
import { coordinates } from './fixtures/kinesin-layout.mjs';
import { prepareLabelScene, labelFrame, demoSeats } from './fixtures/motion-label-layout.mjs';

const demos = JSON.parse(readFileSync(new URL('./fixtures/motion-demo-bounds.json', import.meta.url)));
const source = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
const runtime = await toolbarFrameRuntime();
const head = identity();
const tour = { active: true, selectedId: 'test', title: 'The motor at rest', bodyPage: 'Two heads join the neck coil. The stalk and cargo are not modelled.', canNext: true };
const panelFor = collapsed => createToolbarPanel({ head: { matrix: head, position: { x: 0, y: 0, z: 0 } },
  rows: spatialToolbarRows({ collapsed, tour }), readout: runtime.tourReadout(tour), measureText: runtime.toolbarTextWidth });
const placed = (point, placement, demo, cameraScale) => {
  const rotation = Mat4.fromEuler(Mat4(), placement.rotation.map(v => v * Math.PI / 180), 'ZYX');
  const offset = Vec3.transformMat4(Vec3(), point.map((v, i) => v - demo.source.center[i]), rotation);
  return offset.map((v, i) => (v * placement.scale + demo.source.center[i] + placement.translation[i] * demo.source.radius) * cameraScale);
};
const project = (points, view) => points.map(p => {
  const v = Vec3.transformMat4(Vec3(), p, view.transform.inverse.matrix);
  return [v[0] * view.projectionMatrix[0] / -v[2], v[1] * view.projectionMatrix[5] / -v[2]];
});
const rectangle = points => [Math.min(...points.map(p => p[0])), Math.max(...points.map(p => p[0])),
  Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[1]))];
const frontRectangle = (points, view) => {
  const eye = points.map(p => Vec3.transformMat4(Vec3(), p, view.transform.inverse.matrix));
  const front = eye.filter(p => p[2] < -.0001);
  // Conservative near-plane clipping, including side seats crossing the eye plane.
  for (const a of eye) for (const b of eye) if (a[2] < -.0001 && b[2] >= -.0001) {
    const t = (-.0001-a[2])/(b[2]-a[2]);
    front.push(a.map((v,i)=>v+t*(b[i]-v)));
  }
  return rectangle(front.map(p=>[p[0]*view.projectionMatrix[0]/-p[2],p[1]*view.projectionMatrix[5]/-p[2]]));
};
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3];

for (const collapsed of [false, true]) for (const scale of [.1, 1, 1.2, 1.726326875960911, 6, 30]) {
  test(`all walk poses clear the ${collapsed ? 'compact' : 'expanded'} glass at scale ${scale}, inside a room`, () => {
    const demo = demos[0], views = syntheticViews(), cameraScale = .00502227;
    const menuPoints = toolbarPlatePoints(panelFor(collapsed));
    const before = { translation: [-.1790201626, -.2390270261, -1.0958779423], rotation: [0, 0, 0], scale };
    // Only the room bounds this walk-out. A field it cannot hold refuses.
    let fitted;
    try {
      fitted = fitChapterField({ placement: before, bounds: demo.target, center: demo.source.center, standoff: 1e9,
        radius: demo.source.radius, cameraScale, headInRoom: head, renderFromRoom: identity(), views, menuPoints });
    } catch (error) {
      assert.equal(error.code, 'FIELD_OUT_OF_REACH');
      assert.ok(scale >= 6, `a ${scale}x walk fits in a room`);
      return;
    }
    assert.equal(fitted.scale, scale);
    if (fitted.field) assert.ok(Math.hypot(...fitted.field.center) <= XR_ROOM_MAX_METRES + 1e-6);
    for (const view of views) {
      const plates = menuPoints.plates.map(points => rectangle(project(points, view)));
      for (const body of demo.travel) for (const pose of body.poses) {
        const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z =>
          placed(pose.center.map((v, i) => v + [x, y, z][i] * pose.radius), fitted, demo, cameraScale))));
        const box = rectangle(project(corners, view));
        assert.ok(box[0] > -.88 && box[1] < .88 && box[2] > -.8 && box[3] < .8, `${body.id} stays in field`);
        for (const glass of plates) assert.equal(overlaps(box, glass), false, `${body.id} never crosses glass`);
      }
    }
  });
}

test('toolbar waits for its all-pose clearance before drawing expanded glass and rechecks a resize', async () => {
  let gate, calls = 0, adds = 0, key = 'scale-1';
  const t = toolbarFrameHarness(runtime, { state: { tour },
    getEntryGeometry: () => ({ clearanceKey: key }),
    beforeMenuDraw: async () => { calls++; if (gate) await gate; },
    presentation: { add() { adds++; } } });
  try {
    await t.toolbar.update();
    const before = adds;
    let release; gate = new Promise(resolve => { release = resolve; });
    t.toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(adds, before, 'expanded glass waits for the viewer proof');
    release(); gate = undefined;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(adds > before);
    const checked = calls;
    key = 'scale-1.2';
    await t.toolbar.update({ origin: 'wearer', recenter: true });
    assert.ok(calls > checked);
  } finally { await t.toolbar.dispose(); }
});

test('outside a lesson automatic obstructed glass hides, while wearer-opened controls remain available', async () => {
  let obstructed = true;
  const scene = { ...tour, active: false };
  const t = toolbarFrameHarness(runtime, { state: { tour: scene },
    beforeMenuDraw: async () => obstructed ? { obstructed: true } : undefined });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await t.toolbar.update();
    assert.equal(t.toolbar.isHidden(), true, 'folded glass that covers the scene is hidden');
    assert.deepEqual(t.toolbar.platePoints(), []);
    // An explicit Menu press owns expansion even when automatic clearance fails.
    t.toolbar.runAction({ kind: 'collapse', value: false }); await settle();
    assert.equal(t.toolbar.isCollapsed(), false, 'the wearer-opened expanded grid stays available');
    assert.equal(t.toolbar.isHidden(), false);
    assert.ok(t.toolbar.platePoints().length > 0);
    obstructed = false;
    t.toolbar.runAction({ kind: 'collapse', value: false }); await settle();
    assert.equal(t.toolbar.isHidden(), false, 'clear glass shows again');
    assert.ok(t.toolbar.platePoints().length > 0);
  } finally { await t.toolbar.dispose(); }
});

test('a completed plain entry can recheck controls hidden during startup without a content edit', async () => {
  let obstructed = true, checks = 0;
  const t = toolbarFrameHarness(runtime, { state: { tour: { active: false, selectedId: null } },
    beforeMenuDraw: async () => { checks++; return obstructed ? { obstructed: true } : undefined; } });
  try {
    await t.toolbar.update();
    assert.equal(t.toolbar.isHidden(), true);
    obstructed = false;
    const initialChecks = checks;
    await t.toolbar.update({ recheckClearance: true });
    assert.ok(checks > initialChecks, 'the final entry must have its own clearance proof');
    assert.equal(t.toolbar.isHidden(), false);
    assert.ok(t.toolbar.platePoints().length > 0);
  } finally { await t.toolbar.dispose(); }
});

// A lesson's menu and card stay available, including an explicit expanded Menu
// while the lesson loads its first chapter and while it shows one.
for (const phase of ['loading', 'showing']) test(`in a lesson ${phase} a chapter, obstructed glass retains wearer expansion and stays drawn`, async () => {
  const lesson = phase === 'loading' ? { ...tour, active: false, navigating: true } : tour;
  const t = toolbarFrameHarness(runtime, { state: { tour: lesson }, beforeMenuDraw: async () => ({ obstructed: true }) });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await t.toolbar.update();
    assert.equal(t.toolbar.isHidden(), false);
    assert.ok(t.toolbar.platePoints().length > 0);
    t.toolbar.runAction({ kind: 'collapse', value: false }); await settle();
    assert.equal(t.toolbar.isCollapsed(), false, 'the wearer-opened expanded grid stays available');
    assert.equal(t.toolbar.isHidden(), false, 'and stays drawn');
    // A placement check that settles on hiding the glass keeps it drawn too.
    const pose = { headInRoom: identity(), renderFromRoom: identity(), labelViews: syntheticViews() };
    const hide = t.toolbar.prepareRelocation(pose).find(candidate => candidate.hide);
    await t.toolbar.commitRelocation(hide);
    assert.equal(t.toolbar.isHidden(), false);
  } finally { await t.toolbar.dispose(); }
});

test('a refused clearance leaves the last drawn glass in place', async () => {
  let fail = false, adds = 0;
  const t = toolbarFrameHarness(runtime, { state: { tour },
    beforeMenuDraw: async () => { if (fail) throw Error('no proof'); },
    presentation: { add() { adds++; } } });
  try {
    await t.toolbar.update();
    const before = adds, points = t.toolbar.platePoints(); fail = true;
    await assert.rejects(t.toolbar.update({ recenter: true, origin: 'wearer' }), /no proof/);
    assert.equal(adds, before);
    assert.deepEqual(t.toolbar.platePoints(), points);
  } finally { await t.toolbar.dispose(); }
});

// Kinesin's still "both-bound" chapter after the walk: its drawn motor and
// authored label plates, with no motion. Real labels need the demo cache.
function stillMotorAtRest(collapsed) {
  const { h, hold, records } = tourFocusHarness();
  const demo = demos[0];
  const panel = panelFor(collapsed), menuPoints = toolbarPlatePoints(panel);
  h.latestRoomPlacementPose = { headInRoom: head, renderFromRoom: identity(), labelViews: syntheticViews() };
  h.canvas.camera.scale = .00502227;
  h.recordBoundingSphere = h.loadedSphere = () => demo.source;
  h.pivotBounds = () => ({ baseCenter: demo.source.center, visibleCenter: demo.source.center, radius: demo.source.radius });
  const cache = process.env.STEREOFOLD_DEMO_CACHE;
  let scene;
  if (cache) {
    const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/motion.json', import.meta.url)));
    const atoms = coordinates(`${cache}/${demoSeats['kinesin-walk'].file}`, lesson.provenance.sourceSha256);
    scene = prepareLabelScene(lesson.chapters.find(c => c.id === 'both-bound'), atoms);
  }
  // Real shader inputs from the authored labels. Font mapping uses the same
  // conservative advance as the independent label-layout reference below.
  const cell = value => ({ ref: { value } });
  const annotations = () => (scene?.labels ?? []).map(label => {
    const gain = .02421 / h.canvas.camera.scale;
    const halfWidth = .8 * label.text.length * .55 / 2 + .3;
    return { renderObjects: [{ type: 'text', state: { visible: true }, values: {
      drawCount: cell(6), instanceCount: cell(1), elements: cell([0,1,2,0,2,3]),
      aPosition: cell(Array.from({ length: 4 }, () => label.center).flat()),
      aMapping: cell([-halfWidth,-.7,halfWidth,-.7,halfWidth,.7,-halfWidth,.7]),
      aTransform: cell(h.placementTransform(h.inspectionSnapshot().placement)),
      aTexCoord: cell([10,10,10,10,10,10,10,10]), dSizeType: cell('uniform'), uSize: cell(1),
      uSizeFactor: cell(6*(label.sizeFactor ?? 1)*gain),
      uOffsetX: cell((label.offsetX ?? 0)*gain), uOffsetY: cell((label.offsetY ?? 0)*gain),
      uOffsetZ: cell(label.radius*h.inspectionSnapshot().placement.scale+3*gain),
    } }] };
  });
  h.lessonFigure = { snapshot: () => ({}), annotations };
  h.presentationTransform = () => h.placementTransform(h.inspectionSnapshot().placement);
  h.immersiveSession = { platePoints: () => menuPoints, captionPoints: () => toolbarCaptionPoints(panel),
    drawnMenuPoints: () => toolbarDrawnMenuPoints(panel), menuRows: () => toolbarMenuRowPoints(panel) };
  Object.assign(h, { fitChapterField, framingEnvelopeObject, annotationFieldBounds, visibleChapterSpheres, renderedMeshVertexCount });
  h.scientificRepresentations = () => [{ renderObjects: [{ type: 'mesh', state: { visible: true }, values: {
    boundingSphere: cell({ center: Vec3.transformMat4(Vec3(), demo.source.center, h.presentationTransform()),
      radius: demo.source.radius * Mat4.getMaxScaleOnAxis(h.presentationTransform()) }) } }] }];
  vm.runInContext(pageFunction(source, 'chapterFieldBounds'), h);
  h.inspectionState.place({ translation: [-.1790201626, -.2390270261, -1.0958779423], rotation: [0, 0, 0], scale: 1.72632687596 });
  return { h, hold, records, demo, panel, menuPoints, scene };
}

test('a chapter drawn as a ball per atom gets its field bounds without overflowing the call stack', () => {
  // A microtubule tube draws about 177,000 atoms; each is one drawn ball.
  const { h } = stillMotorAtRest(false);
  h.visibleChapterSpheres = () => Array.from({ length: 200_000 }, (_, i) => ({ radius: 2,
    center: [i % 100, Math.floor(i / 100) % 100, Math.floor(i / 10_000)] }));
  const bounds = h.chapterFieldBounds(undefined, { drawn: true });
  assert.ok(bounds.spheres.length >= 200_000);
  assert.ok(Number.isFinite(bounds.radius) && bounds.radius > 0);
});

for (const collapsed of [false, true]) test(`Next from walk frames the still motor-at-rest by its own subject with ${collapsed ? 'compact' : 'expanded'} menu`, async t => {
  const { h, demo, panel } = stillMotorAtRest(collapsed);
  const before = structuredClone(h.inspectionSnapshot().placement);
  const toolbar = toolbarFrameHarness(runtime, { state: { tour }, onAction: async action => {
    assert.equal(action.kind, 'tour-next');
    // Next clears the animation before the static chapter's authored view:fit.
    h.molecularAnimation.envelope = () => undefined;
    await h.focusSelection({ wholeStructure: true, liftEmphasis: false, elevationDegrees: 0, durationMs: 0 });
  } });
  try {
    await toolbar.toolbar.update();
    toolbar.toolbar.runAction({ kind: 'tour-next' });
    await new Promise(resolve => setImmediate(resolve));
    const after = h.inspectionSnapshot().placement;
    assert.notDeepEqual(after, before);
    const center = placed(demo.source.center, after, demo, h.canvas.camera.scale), distance = Math.hypot(...center);
    t.diagnostic(JSON.stringify({ collapsed, translation: after.translation, scale: after.scale, center, distance }));
    // A still chapter has no field, so its plates cannot walk it out: the
    // field's seat for this chapter was 4.2 m away, the subject's own is 2.2 m.
    assert.equal(h.chapterFieldBounds(), undefined);
    assert.ok(distance < 2.5, `distance ${distance}`);
    assert.ok(Math.abs(center[0] / center[2]) < Math.tan(Math.PI / 18) && Math.abs(center[1] / center[2]) < Math.tan(Math.PI / 18),
      'in front and near level, never the top edge');
    // No menu row crosses the molecule's silhouette in either eye.
    const radius = demo.source.radius * after.scale * h.canvas.camera.scale, surface = Array.from({ length: 400 }, (_, i) => {
      const z = 1 - 2 * (i + .5) / 400, ring = Math.sqrt(1 - z * z), turn = i * 2.39996;
      return [center[0] + radius * ring * Math.cos(turn), center[1] + radius * ring * Math.sin(turn), center[2] + radius * z];
    });
    for (const view of syntheticViews()) {
      const menu = frontRectangle(toolbarDrawnMenuPoints(panel), view);
      assert.equal(project(surface, view).some(([x, y]) => x > menu[0] && x < menu[1] && y > menu[2] && y < menu[3]), false);
    }
  } finally { await toolbar.toolbar.dispose(); }
});


// Automatic compact admission clears every authored label plate. If no expanded
// seat clears, an explicit wearer Menu remains available and reports obstruction
// without claiming clearance or moving the molecule.
for (const collapsed of [false, true]) test(`the still motor-at-rest ${collapsed ? 'admits compact glass only clear of its plates' : 'reports obstruction while preserving wearer-opened expanded controls'}`, async t => {
  if (!process.env.STEREOFOLD_DEMO_CACHE) return t.skip('requires demo cache');
  const { h, demo, scene, records } = stillMotorAtRest(true);
  // The live toolbar fixture's eye is 1.6 m high. Its clearance views and
  // pre-framing glass must use that same room frame, including both eyes.
  const pose = identity(); pose[13] = 1.6;
  const views = syntheticViews().map(view => { view.transform.matrix[13] = 1.6; view.transform.inverse.matrix[13] = -1.6; return view; });
  h.latestRoomPlacementPose = { headInRoom: pose, renderFromRoom: identity(), labelViews: views };
  const initial = createToolbarPanel({ head: { matrix: pose, position: { x: 0, y: 1.6, z: 0 } },
    rows: spatialToolbarRows({ collapsed: true, tour }), readout: runtime.tourReadout(tour), measureText: runtime.toolbarTextWidth });
  h.immersiveSession = { platePoints: () => toolbarPlatePoints(initial), captionPoints: () => toolbarCaptionPoints(initial),
    drawnMenuPoints: () => toolbarDrawnMenuPoints(initial), menuRows: () => toolbarMenuRowPoints(initial) };
  h.interactionActive = () => false;
  vm.runInContext(pageFunction(source, 'clearChapterMenu'), h);
  h.molecularAnimation.envelope = () => undefined;
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, elevationDegrees: 0, durationMs: 0 });
  const framed = structuredClone(h.inspectionSnapshot().placement);
  // A still chapter has a field for its glass, never for the walk-out.
  assert.equal(h.chapterFieldBounds(), undefined);
  const field = h.chapterFieldBounds(undefined, { still: true });
  assert.equal(field.still, true);
  assert.ok(field.spheres.some(sphere => sphere.kind === 'plate'));
  const toolbar = toolbarFrameHarness(runtime, { state: { tour }, beforeMenuDraw: options => h.clearChapterMenu(options) });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await toolbar.toolbar.update();
    if (!collapsed) { toolbar.toolbar.runAction({ kind: 'collapse', value: false }); await settle(); }
    assert.deepEqual(h.inspectionSnapshot().placement, framed, 'the molecule stays');
    const glass = toolbar.toolbar.glassPlates();
    const cameraScale = h.canvas.camera.scale, metres = cameraScale * framed.scale;
    const center = placed(demo.source.center, framed, demo, cameraScale);
    const seat = { scale: cameraScale, placement: framed.scale, distance: -center[2],
      center: demo.source.center.map((v, i) => i < 2 ? v - (center[i] - (i === 1 ? 1.6 : 0)) / metres : v) };
    let covered = 0, plates = 0;
    for (const eye of [-.032, .032]) {
      const view = syntheticViews()[eye < 0 ? 0 : 1];
      const frame = labelFrame(scene, seat, 0, framed.scale, eye);
      plates += frame.labels.length;
      if (!glass.length) continue;
      const menu = glass.map(plate => frontRectangle(plate, views[eye < 0 ? 0 : 1]));
      for (const label of frame.labels) {
        const r = label.rect, box = [(r.x-r.halfWidth)*view.projectionMatrix[0], (r.x+r.halfWidth)*view.projectionMatrix[0],
          r.y-r.halfHeight, r.y+r.halfHeight];
        if (menu.some(rect => overlaps(box, rect))) covered++;
      }
    }
    t.diagnostic(JSON.stringify(records.filter(r => r.kind === 'chapter-field')));
    t.diagnostic(JSON.stringify({ collapsed, plates, covered, hidden: toolbar.toolbar.isHidden(),
      folded: toolbar.toolbar.isCollapsed(), distance: Math.hypot(...center) }));
    assert.ok(plates > 0);
    if (collapsed) {
      assert.equal(covered, 0, 'no plate lies under automatically admitted compact glass');
      assert.equal(records.some(record => record.kind === 'chapter-field' && record.reason === 'menu-obstructed'), false);
    } else {
      assert.ok(covered > 0, 'this fixture exercises expanded glass with no clear alternate seat');
      const obstruction = records.find(record => record.kind === 'chapter-field' && record.reason === 'menu-obstructed');
      assert.ok(obstruction, 'overlap is reported rather than accepted as a clear seat');
      assert.equal(obstruction.blocker.kind, 'plate');
      assert.ok(obstruction.overlap > 0);
      assert.equal(toolbar.toolbar.isCollapsed(), false, 'wearer-requested expansion remains available');
      assert.equal(toolbar.toolbar.isHidden(), false);
      assert.ok(glass.length > 0);
    }
  } finally { await toolbar.toolbar.dispose(); }
});

test('production grid provider carries the all-pose envelope and invalidates at unchanged-column resizes', () => {
  const bounds = demos[0].target;
  const transform = identity();
  const { getEntryGeometry } = entryProducerHarness({ chapterFieldBounds: () => bounds, presentationTransform: () => transform });
  const before = getEntryGeometry();
  assert.equal(before.objects.length, 1);
  assert.deepEqual(before.objects[0].values.aPosition.ref.value, framingEnvelopeObject(bounds, transform).values.aPosition.ref.value);
  transform[0] = transform[5] = transform[10] = 1.2;
  const after = getEntryGeometry();
  assert.notEqual(before.clearanceKey, after.clearanceKey);
  assert.equal(after.objects[0].values.aTransform.ref.value[0], 1.2);
});

// Execute the viewer menu admission against the real pending toolbar geometry.
function menuHarness() {
  const { h, hold, writes } = tourFocusHarness();
  h.interactionActive = () => false;
  h.latestRoomPlacementPose = { headInRoom: head, renderFromRoom: identity(), labelViews: syntheticViews() };
  h.loadedSphere = () => ({ center: [0,0,0], radius: 100 });
  h.canvas.camera.scale = .01;
  h.fitChapterField = fitChapterField;
  h.chapterFieldBounds = () => ({ center: [0,0,0], radius: 8 });
  vm.runInContext(pageFunction(source, 'clearChapterMenu'), h);
  return { h, hold, writes };
}

for (const held of [false, true]) test(`expanding the menu relocates glass while a ${held ? 'hand' : 'automatically'} placed molecule stays exactly put`, async () => {
  const { h, hold, writes } = menuHarness();
  h.latestRoomPlacementPose.headInRoom = [...head];
  h.latestRoomPlacementPose.headInRoom[13] = 1.6;
  for (const view of h.latestRoomPlacementPose.labelViews) view.transform.inverse.matrix[13] = -1.6;
  let move = false, before, expandedPoints;
  const t = toolbarFrameHarness(runtime, { state: { tour }, beforeMenuDraw: async options => {
    if (!move) return;
    expandedPoints = options.points;
    // Put the molecule behind the left half of the proposed expanded menu.
    const column = options.glass[1];
    const center = column.reduce((sum,p) => sum.map((v,i) => v+p[i]/column.length), [0,0,0]);
    h.inspectionState.place({ translation: center, rotation: [0,0,0], scale: 1 });
    before = h.inspectionSnapshot().placement;
    writes.length = 0;
    return h.clearChapterMenu(options);
  } });
  try {
    await t.toolbar.update(); if (held) hold.takeover('grab'); move = true;
    t.toolbar.runAction({ kind: 'collapse', value: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(expandedPoints);
    assert.deepEqual(h.inspectionSnapshot().placement, before);
    assert.equal(writes.length, 0);
    assert.notDeepEqual(t.toolbar.platePoints(), expandedPoints);
    assert.equal(fitChapterField({ placement: before, bounds: h.chapterFieldBounds(), center: [0,0,0],
      radius: 100, cameraScale: .01, headInRoom: head, renderFromRoom: identity(), views: h.latestRoomPlacementPose.labelViews,
      menuPoints: t.toolbar.platePoints(), keepPlacement: true, allowOffscreen: true }), before);
  } finally { await t.toolbar.dispose(); }
});

test('menu clearance defers during a grab even inside a chapter mutation', async () => {
  const { h, writes } = menuHarness();
  h.busy = true; h.interactionActive = () => true;
  const before = h.inspectionSnapshot().placement;
  h.chapterFieldBounds = () => assert.fail('a live grab has no saved-pose clearance proof');
  const result = await h.clearChapterMenu({ points: toolbarPlatePoints(panelFor(false)), isCurrent: () => true });
  assert.equal(result.unmeasured, true, 'defer the proof without aborting chapter playback');
  assert.deepEqual(h.inspectionSnapshot().placement, before);
  assert.equal(writes.length, 0);
});

test('appearance clearance compares a held pose to the original request without pre-fitting it', async () => {
  const { h, hold } = menuHarness();
  hold.takeover('grab');
  h.immersiveSession.platePoints = () => toolbarPlatePoints(panelFor(false));
  h.lessonFigure = { snapshot: () => null };
  h.framingEnvelopeObject = framingEnvelopeObject;
  h.fitChapterField = () => assert.fail('a held request must never be pre-fitted');
  h.fitAppearanceInWorker = async () => ({ translation: [2,0,-3], scale: 1 });
  const requested = { translation: [0,0,-3], rotation: [0,0,0], scale: 1 };
  await assert.rejects(h.clearHeldPlatePlacement(requested, { keepWearer: true }), /at your placement/);
  h.fitAppearanceInWorker = async () => requested;
  const accepted = await h.clearHeldPlatePlacement(requested, { keepWearer: true });
  assert.deepEqual(accepted, requested);
});

test('focused ligand with faint or hidden protein retains its close-up with expanded glass', async t => {
  const { h } = menuHarness();
  const cell = value => ({ ref: { value } });
  h.lessonFigure = { snapshot: () => ({}), annotations: () => [] };
  h.visibleChapterSpheres = visibleChapterSpheres;
  h.presentationTransform = () => h.placementTransform(h.inspectionSnapshot().placement);
  const ligand = { center: [30,0,0], radius: 4 };
  h.inspectionState.place({ translation: [0,0,-1.5], rotation: [0,0,0], scale: 3 });
  let proteinVisible = true;
  h.scientificRepresentations = () => [{ renderObjects: [ligand, h.loadedSphere()].map((sphere,i) => ({
    type: 'mesh', state: { visible: i === 0 || proteinVisible }, values: { uAlpha: cell(i === 0 ? 1 : .1),
      boundingSphere: cell({ center: Vec3.transformMat4(Vec3(), sphere.center, h.presentationTransform()),
        radius: sphere.radius * 3 }) }
  })) }];
  vm.runInContext(pageFunction(source, 'chapterFieldBounds'), h);
  const before = h.inspectionSnapshot().placement, menuPoints = toolbarPlatePoints(panelFor(false));
  // The whole source's walk-out, for the record; a room cannot hold it.
  let old;
  try { old = fitChapterField({ placement: before, bounds: h.loadedSphere(), ...h.latestRoomPlacementPose, standoff: 1e9,
    center: h.loadedSphere().center, radius: 100, cameraScale: .01, views: syntheticViews(), menuPoints }); }
  catch (error) { assert.equal(error.code, 'FIELD_OUT_OF_REACH'); }
  // A still close-up has no field: its figure framed it, and the glass leaves it be.
  assert.equal(h.chapterFieldBounds(), undefined);
  await h.clearChapterMenu({ points: menuPoints, isCurrent: () => true });
  assert.deepEqual(h.inspectionSnapshot().placement, before);
  // A moving one counts the visible ligand, never the faint or hidden protein.
  h.molecularAnimation.fieldEnvelope = () => ligand;
  for (proteinVisible of [true, false]) {
    const bounds = h.chapterFieldBounds();
    assert.ok(Math.abs(bounds.radius - ligand.radius) < 1e-8);
    await h.clearChapterMenu({ points: menuPoints, isCurrent: () => true });
    assert.deepEqual(h.inspectionSnapshot().placement, before, 'close-up pose and scale stay unchanged');
  }
  t.diagnostic(JSON.stringify({ beforeWholeSourceDistance: old ? -old.translation[2] : null, afterVisibleDistance: -before.translation[2], scale: before.scale }));
});

// The parked side seats clear this walk without travel, but they sit outside
// the wearer's view: the menu and its card would vanish. The walk takes a
// nearby move instead and the glass stays where the wearer sees it.
for (const scale of [1, 1.2]) test(`automatic kinesin walk keeps the expanded menu in view with one nearby move at scale ${scale}`, async t => {
  const { h, records } = tourFocusHarness();
  const demo = demos[0], cameraScale = .00502227;
  Object.assign(h, { interactionActive: () => false, fitChapterField,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: syntheticViews() },
    loadedSphere: () => demo.source, chapterFieldBounds: () => demo.target });
  h.canvas.camera.scale = cameraScale;
  h.inspectionState.place({ translation: [-.1790201626, -.2390270261, -3.0958779423], rotation: [0,0,0], scale });
  vm.runInContext(pageFunction(source, 'clearChapterMenu'), h);
  const before = h.inspectionSnapshot().placement;
  const panel = panelFor(false), points = toolbarPlatePoints(panel);
  const candidates = menuRelocationCandidates({ rows: spatialToolbarRows({ collapsed: false, tour }),
    readout: runtime.tourReadout(tour), measureText: runtime.toolbarTextWidth, constants: SPATIAL_TOOLBAR_LAYOUT },
    { matrix: head, position: {x:0,y:0,z:0} }, h.latestRoomPlacementPose);
  const result = await h.clearChapterMenu({ points, isCurrent: () => true, relocationCandidates: () => candidates });
  const after = h.inspectionSnapshot().placement;
  const travel = Math.hypot(...after.translation.map((v,i) => (v-before.translation[i])*demo.source.radius*cameraScale));
  t.diagnostic(JSON.stringify({ scale, travel, seat: result?.menuRelocation?.id ?? 'held' }));
  assert.ok(candidates.every(seat => menuGlassInView({ views: syntheticViews(), renderFromRoom: identity(),
    menuPoints: seat.points, menuGlass: seat.glass, fully: true })), 'every offered seat is whole in both current eyes');
  assert.notEqual(result?.menuRelocation?.parked, true);
  assert.ok(menuGlassInView({ ...h.latestRoomPlacementPose, views: syntheticViews(),
    menuPoints: result?.menuRelocation?.points ?? points, menuGlass: result?.menuRelocation?.glass }), 'the wearer sees the menu');
  assert.ok(travel > .01 && travel < 1, `one nearby move, ${travel} m`);
  assert.equal(records.filter(r => r.kind === 'chapter-field' && r.reason === 'menu').length, 1);
  assert.equal(after.scale, before.scale);
  assert.ok(fitChapterField({ placement: after, bounds: demo.target, center: demo.source.center, radius: demo.source.radius,
    cameraScale, ...h.latestRoomPlacementPose, views: result?.menuRelocation?.views ?? syntheticViews(), menuPoints: result?.menuRelocation?.points ?? points,
    keepPlacement: true, allowOffscreen: true }), 'all-pose envelope clears glass in both eyes');
});

test('hemoglobin first chapter retains devcheck-8 reading distance and scale within 10%', async t => {
  const cache = process.env.STEREOFOLD_DEMO_CACHE;
  if (!cache) return t.skip('requires demo cache');
  const demo = demos.find(d => d.demo === 'hemoglobin-switch');
  const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/hemoglobin-switch/motion.json', import.meta.url)));
  const scene = prepareLabelScene(lesson.chapters[0], coordinates(`${cache}/${demo.composite}`, lesson.provenance.sourceSha256));
  const { h } = tourFocusHarness();
  const cameraScale = .024206, previousScale = 2.022824132080879;
  Object.assign(h, { motionFocusPlacement, fitChapterField, visibleChapterSpheres, annotationFieldBounds, renderedMeshVertexCount,
    framingEnvelopeObject, interactionActive: () => false,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: syntheticViews() },
    loadedSphere: () => demo.source, recordBoundingSphere: () => demo.source,
    pivotBounds: () => ({ baseCenter: demo.source.center, visibleCenter: demo.source.center, radius: demo.source.radius }) });
  h.canvas.camera.scale = cameraScale;
  h.inspectionState.place({ translation: [0,0,-2], rotation: [0,0,0], scale: previousScale });
  h.presentationTransform = () => h.placementTransform(h.inspectionSnapshot().placement);
  h.molecularAnimation.envelope = () => demo.whole;
  h.molecularAnimation.framingEnvelope = () => demo.target;
  h.molecularAnimation.fieldEnvelope = () => demo.target;
  const cell = value => ({ ref: { value } });
  const gain = .02421 / cameraScale;
  h.lessonFigure = { snapshot: () => ({}), annotations: () => scene.labels.map(label => {
    const half = .8 * label.text.length * .55 / 2 + .3;
    return { label, renderObjects: [{ type: 'text', state: { visible: true }, values: {
      instanceCount: cell(1), aPosition: cell(label.center), aTransform: cell(h.presentationTransform()),
      aMapping: cell([-half,-.7,half,.7]), dSizeType: cell('uniform'), uSize: cell(1),
      uSizeFactor: cell(6*(label.sizeFactor ?? 1)*gain),
      uOffsetX: cell((label.offsetX ?? 0)*gain), uOffsetY: cell((label.offsetY ?? 0)*gain),
      uOffsetZ: cell(label.radius*h.inspectionSnapshot().placement.scale+3*gain),
    } }] };
  }) };
  h.molecularAnimation.annotationEnvelope = (repr, point) => {
    const track = scene.chapter.animation.tracks.find(track => track.chains.includes(repr.label?.chain));
    return track && trackPointEnvelope(track, point);
  };
  for (const name of ['chapterFieldBounds', 'clearChapterMenu']) vm.runInContext(pageFunction(source, name), h);
  const panel = panelFor(true), points = toolbarPlatePoints(panel);
  h.immersiveSession = { platePoints: () => points, captionPoints: () => toolbarCaptionPoints(panel),
    drawnMenuPoints: () => toolbarDrawnMenuPoints(panel), menuRows: () => toolbarMenuRowPoints(panel) };
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', elevationDegrees: 0,
    durationMs: 0, motionFrame: { target: demo.target, previousScale } });
  const options = { rows: spatialToolbarRows({ collapsed: true, tour }), readout: runtime.tourReadout(tour),
    measureText: runtime.toolbarTextWidth, constants: SPATIAL_TOOLBAR_LAYOUT };
  const result = await h.clearChapterMenu({ points, glass: toolbarGlassPlates(panel), isCurrent: () => true,
    relocationCandidates: pose => menuRelocationCandidates(options, { matrix: head, position: {x:0,y:0,z:0} }, pose),
    chapterCardCandidates: pose => menuRelocationCandidates(options, { matrix: head, position: {x:0,y:0,z:0} }, { ...pose, cardOnly:true }) });
  const after = h.inspectionSnapshot().placement;
  const center = placed(demo.target.center, after, demo, cameraScale), distance = Math.hypot(...center);
  t.diagnostic(JSON.stringify({ distance, scale: after.scale, relocated: !!(result?.menuRelocation || result?.chapterCardSeat) }));
  assert.ok(Math.abs(distance / 4.1153092218649014 - 1) <= .1, `distance ${distance}`);
  assert.ok(Math.abs(after.scale / 1.6182593056647032 - 1) <= .1);
  const metres = cameraScale * after.scale;
  const seat = { scale: cameraScale, placement: after.scale, distance: -center[2],
    center: demo.target.center.map((v,i) => i < 2 ? v-center[i]/metres : v) };
  // Independent authored-label reference at the retained reading distance.
  const outside = [];
  for (const seconds of [0, 3, 6, 9, 12]) for (const eye of [-.032, .032]) {
    const frame = labelFrame(scene, seat, seconds, after.scale, eye);
    const view = syntheticViews()[eye < 0 ? 0 : 1];
    const glasses = (result?.chapterCardSeat?.glass ?? result?.menuRelocation?.glass ?? points.plates).map(plate => frontRectangle(plate, view));
    for (const label of frame.labels) {
      const r = label.rect, box = [(r.x-r.halfWidth)*view.projectionMatrix[0], (r.x+r.halfWidth)*view.projectionMatrix[0],
        r.y-r.halfHeight, r.y+r.halfHeight];
      if (!(box[0] > -1 && box[1] < 1 && box[2] > -1 && box[3] < 1)) outside.push(`${label.id} at ${seconds} s`);
      for (const glass of glasses) assert.equal(overlaps(box, glass), false, `${label.id} outside glass`);
    }
  }
  // The chapter card keeps its whole caption, as it does in the first seconds
  // of a chapter, which is when this clearance runs. Boxed with the menu
  // column as one rectangle, the card pushed the shortest clearing move 1.24 m
  // sideways and `turn` (`name-b` and `name-f` in the earlier lesson) past the
  // edge of this 42 degree field. Each plate is cleared on its own, so the
  // move ducks under the card and every label stays in view.
  assert.deepEqual(outside, [], 'every label stays inside the eye field');
});


for (const alternate of [false,true]) test(`last-resort menu clearance takes the analytic shortest move, alternate seat ${alternate}`, async t => {
  const { h, records } = tourFocusHarness();
  const view = syntheticViews()[0];
  view.transform.matrix = view.transform.inverse.matrix = identity();
  view.projectionMatrix[0] = view.projectionMatrix[5] = 1;
  Object.assign(h, { interactionActive: () => false, fitChapterField,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: [view] },
    loadedSphere: () => ({center:[0,0,0],radius:100}), chapterFieldBounds: () => ({center:[0,0,0],radius:10}) });
  h.canvas.camera.scale = .01;
  h.inspectionState.place({translation:[0,0,-2],rotation:[0,0,0],scale:1});
  vm.runInContext(pageFunction(source, 'clearChapterMenu'), h);
  const points = [-.5,.5].flatMap(x => [-.5,.5].map(y => [x,y,-1]));
  let tried = false;
  const candidate = {id:1,points:points.map(p=>[p[0]+.25,p[1],p[2]])};
  const result = await h.clearChapterMenu({points,isCurrent:()=>true,relocationCandidates:()=>{tried=true;return alternate ? [candidate] : [];} });
  assert.equal(result?.menuRelocation, alternate ? candidate : undefined);
  assert.equal(tried,true);
  const after = h.inspectionSnapshot().placement;
  const move = Math.hypot(after.translation[0],after.translation[1],after.translation[2]+2);
  const slope = alternate ? .29 : .54;
  const expected = (.1+slope*2.1)/Math.hypot(1,slope);
  assert.ok(Math.abs(move-expected)<1e-6, `nearest plane ${expected}, actual ${move}`);
  assert.ok(Math.abs(records.find(r=>r.kind==='chapter-field').moveMetres-move)<1e-8);
  const shorter = {...after,translation:after.translation.map((v,i)=>[0,0,-2][i]+.999*(v-[0,0,-2][i]))};
  const options = {bounds:h.chapterFieldBounds(),center:[0,0,0],radius:100,cameraScale:.01,
    ...h.latestRoomPlacementPose,views:[view],menuPoints:alternate ? candidate.points : points,keepPlacement:true,allowOffscreen:true};
  assert.equal(fitChapterField({...options,placement:after}),after);
  assert.equal(fitChapterField({...options,placement:shorter}),undefined,'any shorter travel along the solution still hits glass');
  t.diagnostic(JSON.stringify({moveMetres:move,analyticMinimum:expected}));
});

// A 1 m-radius field 2 m ahead, with glass over its right half at 1 m. Its
// nearest clear seat is about 0.37 m left and 0.11 m farther away.
function clearanceFixture(depth = 2) {
  const { h, records } = tourFocusHarness();
  const view = syntheticViews()[0];
  view.transform.matrix = view.transform.inverse.matrix = identity();
  view.projectionMatrix[0] = view.projectionMatrix[5] = 1;
  Object.assign(h, { interactionActive: () => false, fitChapterField,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: [view] },
    loadedSphere: () => ({center:[0,0,0],radius:100}), chapterFieldBounds: () => ({center:[0,0,0],radius:100}) });
  h.canvas.camera.scale = .01;
  h.inspectionState.place({translation:[0,0,-depth],rotation:[0,0,0],scale:1});
  vm.runInContext(pageFunction(source, 'clearChapterMenu'), h);
  const points = [.34,1.34].flatMap(x => [-.5,.5].map(y => [x,y,-1]));
  const options = {placement:h.inspectionSnapshot().placement,bounds:h.chapterFieldBounds(),center:[0,0,0],radius:100,cameraScale:.01,
    ...h.latestRoomPlacementPose,views:[view],menuPoints:points,allowOffscreen:true,clearanceOnly:true};
  return { h, records, view, points, options };
}

test('plain entry keeps controls clear of the actual ribbon when coarse bounds touch, but rejects real overlap', async () => {
  for (const x of [0, 100]) {
    const { h } = clearanceFixture();
    const cell = value => ({ ref: { value } });
    const mesh = { type: 'mesh', state: { visible: true }, values: {
      aPosition: cell(new Float32Array([x-5,-5,-200,x+5,-5,-200,x,5,-200])),
      aTransform: cell(new Float32Array(identity())), instanceCount: cell(1), drawCount: cell(3),
    } };
    Object.assign(h, { roomEntry: { seat: h.inspectionSnapshot().placement }, inspectionLabel: null,
      resetEntryGeometry, resetEntryLateralBreakdown, presentationTransform: identity,
      scientificRepresentations: () => [{ renderObjects: [mesh] }],
      chapterFieldBounds: () => ({ center: [0,0,0], radius: 100, still: true,
        spheres: [{ center: [0,0,0], radius: 100, kind: 'drawn' }] }) });
    h.latestRoomPlacementPose.labelViews = syntheticViews();
    for (const view of h.latestRoomPlacementPose.labelViews) view.projectionMatrix[0] = view.projectionMatrix[5] = 1;
    const points = [.34,.7].flatMap(x => [-.2,.2].map(y => [x,y,-1]));
    const statusGlass = [.34,.7].flatMap(x => [-.5,-.3].map(y => [x,y,-1]));
    const before = structuredClone(h.inspectionSnapshot().placement);
    const result = await h.clearChapterMenu({ points, glass: [points, statusGlass], statusGlass, isCurrent: () => true });
    assert.equal(result?.obstructed, x === 0 ? undefined : true);
    assert.deepEqual(h.inspectionSnapshot().placement, before, 'checking controls never moves the structure');
  }
});

test('an animated chapter takes one menu-clearance move, and a later draw in it never moves the molecule again', async () => {
  const { h, records, points } = clearanceFixture();
  let chapter = 'walk';
  h.molecularAnimation = { snapshot: () => ({ chapterId: chapter }) };
  vm.runInContext('var menuClearanceMovedFor = null;', h);
  await h.clearChapterMenu({ points, isCurrent: () => true });
  const moved = structuredClone(h.inspectionSnapshot().placement);
  assert.notDeepEqual(moved.translation, [0, 0, -2]);
  // A status line or a page redraws glass that covers the moved chapter: the
  // menu folds and the molecule stays where the chapter's one move put it.
  const later = points.map(([x, y, z]) => [x - .6, y, z]);
  const result = await h.clearChapterMenu({ points: later, isCurrent: () => true });
  assert.equal(result?.obstructed, true);
  assert.deepEqual(h.inspectionSnapshot().placement, moved);
  assert.equal(records.filter(r => r.kind === 'chapter-field' && r.reason === 'menu').length, 1);
  assert.equal(records.at(-1).moved, true);
  // The next chapter takes its own move.
  chapter = 'both-bound';
  await h.clearChapterMenu({ points: later, isCurrent: () => true });
  assert.notDeepEqual(h.inspectionSnapshot().placement.translation, moved.translation);
});

test('a seat the wearer cannot see never takes the menu while they see it; the molecule moves instead', async () => {
  const { h, records, points } = clearanceFixture();
  // Parked far to the right, outside the eye's frame: it clears the chapter.
  const parked = { id: 8, parked: true, points: points.map(([x, y, z]) => [x + 5, y, z]) };
  const before = h.inspectionSnapshot().placement;
  const result = await h.clearChapterMenu({ points, isCurrent: () => true, relocationCandidates: () => [parked] });
  assert.equal(result?.menuRelocation, undefined);
  assert.notDeepEqual(h.inspectionSnapshot().placement, before);
  assert.deepEqual(records.filter(r => r.kind === 'chapter-field').map(r => [r.reason, r.seat]), [['menu', undefined]]);
});

test('an unseen current seat does not admit an unseen replacement', async () => {
  const { h, records, points } = clearanceFixture();
  // Glass behind the wearer: no eye measures it, so it proves nothing.
  const behind = points.map(([x, y]) => [x, y, 1]);
  const parked = { id: 8, parked: true, points: points.map(([x, y, z]) => [x + 5, y, z]) };
  const before = h.inspectionSnapshot().placement;
  const result = await h.clearChapterMenu({ points: behind, isCurrent: () => true, relocationCandidates: () => [parked] });
  assert.equal(result?.menuRelocation, undefined);
  assert.equal(result?.unmeasured, true);
  assert.deepEqual(h.inspectionSnapshot().placement, before);
  assert.deepEqual(records.filter(r => r.kind === 'chapter-field').map(r => [r.reason, r.seat, r.parked]), [['menu-unmeasured', undefined, undefined]]);
});

test('glass is in view when some plate reaches into an eye frame', () => {
  const { options, points } = clearanceFixture();
  const inView = menuPoints => menuGlassInView({ ...options, menuPoints, menuGlass: undefined });
  assert.equal(inView(points), true);
  assert.equal(inView(points.map(([x, y, z]) => [x + 5, y, z])), false, 'off to the side');
  assert.equal(inView(points.map(([x, y]) => [x, y, 1])), false, 'behind the eye');
  assert.equal(menuGlassInView({ ...options, menuGlass: [points.map(([x, y, z]) => [x + 5, y, z]), points] }), true, 'one plate in view');
});

test('a menu-clearance move never seats the chapter beyond 1.5 entry stand-offs or a room', () => {
  const { options } = clearanceFixture();
  const free = fitChapterField(options), reached = free.field.distance;
  assert.ok(reached > 2 && reached < 2.5, `the nearest clear seat is a little farther than the present 2 m (${reached})`);
  assert.ok(Math.abs(fitChapterField({...options,standoff:reached/CLEARANCE_STANDOFF_FACTOR+1e-3}).field.distance-reached)<1e-9);
  assert.throws(() => fitChapterField({...options,standoff:(reached-.01)/CLEARANCE_STANDOFF_FACTOR}), /No nearby seat/u);
  // Already past the cap: a move may keep the present distance but never add to it.
  assert.throws(() => fitChapterField({...options,standoff:.5}), /No nearby seat/u);
  // A room bounds even a huge entry stand-off.
  const far = clearanceFixture(XR_ROOM_MAX_METRES + 2).options;
  const over = [.05,1.05].flatMap(x => [-.5,.5].map(y => [x,y,-1]));
  assert.equal(fitChapterField({...far,menuPoints:over,keepPlacement:true}), undefined, 'the glass covers the far field');
  assert.throws(() => fitChapterField({...far,menuPoints:over,standoff:1000}), /No nearby seat/u);
});

test('past the cap no glass that covers the chapter is admitted, and the molecule stays', async () => {
  const { h, records, view, points } = clearanceFixture();
  h.latestSeatStandoffMeters = 1;
  const before = h.inspectionSnapshot().placement;
  const partial = { id: 4, points: points.map(p => [p[0]+.5,p[1],p[2]]) }, worse = { id: 5, points };
  const options = {placement:before,bounds:h.chapterFieldBounds(),center:[0,0,0],radius:100,cameraScale:.01,...h.latestRoomPlacementPose,views:[view]};
  assert.ok(menuOverlap({...options,menuPoints:partial.points}) < menuOverlap({...options,menuPoints:points}));
  assert.ok(menuOverlap({...options,menuPoints:partial.points}) > 0, 'no seat clears outright');
  // The partly clear seat is refused: the toolbar folds or hides the glass.
  const result = await h.clearChapterMenu({points,isCurrent:()=>true,relocationCandidates:()=>[worse,partial]});
  assert.equal(result?.obstructed, true); assert.equal(result?.menuRelocation, undefined);
  assert.deepEqual(h.inspectionSnapshot().placement, before);
  assert.deepEqual(records.filter(r => r.kind === 'chapter-field').map(r => [r.reason, r.held]), [['menu-obstructed', false]]);
  assert.ok(records.find(r => r.kind === 'chapter-field').overlap > 0);
  // Within the cap the shortest molecular move still wins, as before.
  h.latestSeatStandoffMeters = 10;
  await h.clearChapterMenu({points,isCurrent:()=>true,relocationCandidates:()=>[worse,partial]});
  assert.notDeepEqual(h.inspectionSnapshot().placement, before);
  assert.equal(records.filter(r => r.kind === 'chapter-field').at(-1).reason, 'menu');
});

test('every automatic walk-out stays within 1.5 entry stand-offs and a room', () => {
  const demo = demos[0], cameraScale = .00502227;
  const options = { placement: { translation: [-.1790201626, -.2390270261, -1.0958779423], rotation: [0, 0, 0], scale: 1 },
    bounds: demo.target, center: demo.source.center, radius: demo.source.radius, cameraScale, headInRoom: head,
    renderFromRoom: identity(), views: syntheticViews(), menuPoints: toolbarPlatePoints(panelFor(false)) };
  // A room alone would walk the field out to about 3.7 m beside the glass.
  const free = fitChapterField({ ...options, standoff: 1e9 });
  const reached = Math.hypot(...free.field.center);
  assert.ok(reached > 1.5 * 2.35 && reached < XR_ROOM_MAX_METRES, `room-bounded seat ${reached}`);
  // From a 2.35 m entry it may go no farther than 3.5 m: it refuses instead.
  assert.throws(() => fitChapterField({ ...options, standoff: 2.35 }), error => error.code === 'FIELD_OUT_OF_REACH');
  const near = fitChapterField({ ...options, standoff: reached / CLEARANCE_STANDOFF_FACTOR + .01 });
  assert.ok(Math.hypot(...near.field.center) <= reached / CLEARANCE_STANDOFF_FACTOR * 1.5 + .02);
});

// A moving field too large to clear the expanded glass within 1.5 entry
// stand-offs: a 1.5 m radius of motion, 2 m ahead, after a 2 m entry. A room
// alone would walk it out to 6.2 m.
function outOfReachFixture() {
  const { h, hold, records } = tourFocusHarness();
  const relocated = [], panel = panelFor(false), points = toolbarPlatePoints(panel);
  Object.assign(h, { interactionActive: () => false, fitChapterField, framingEnvelopeObject,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: syntheticViews() },
    chapterFieldBounds: () => ({ center: [0, 0, 0], radius: 150 }), latestSeatStandoffMeters: 2 });
  h.immersiveSession = { ...h.immersiveSession, platePoints: () => points, captionPoints: () => toolbarCaptionPoints(panel),
    drawnMenuPoints: () => toolbarDrawnMenuPoints(panel), menuRows: () => toolbarMenuRowPoints(panel),
    toolbarRelocationCandidates: () => [{ id: 'hidden', points: [], hide: true }],
    relocateToolbar: async candidate => { relocated.push(candidate.id); } };
  vm.runInContext(pageFunction(source, 'clearFieldGlass'), h);
  h.inspectionState.place({ translation: [0, 0, -2], rotation: [0, 0, 0], scale: 1 });
  return { h, hold, records, relocated, points };
}

test('an appearance fit past the walk-out limits keeps the seat and lets the glass yield', async () => {
  const { h, points } = outOfReachFixture();
  const requested = h.inspectionSnapshot().placement;
  const base = { placement: requested, bounds: h.chapterFieldBounds(), center: [0,0,0], radius: 100, cameraScale: .01,
    ...h.latestRoomPlacementPose, views: syntheticViews(), menuPoints: points };
  assert.equal(fitChapterField({ ...base, keepPlacement: true }), undefined, 'the glass covers the field');
  assert.ok(Math.hypot(...fitChapterField({ ...base, standoff: 1e9 }).field.center) > 3, 'clearing it walks past 3 m');
  let seen;
  h.fitAppearanceInWorker = async options => { seen = options; return options.seat; };
  const accepted = await h.clearHeldPlatePlacement(requested, {});
  assert.deepEqual(accepted, requested, 'the molecule keeps its seat');
  assert.deepEqual(seen.seat, requested);
  assert.equal(seen.allowOffscreen, true, 'the worker may move or hide the glass');
  assert.deepEqual(seen.menuCandidates.map(candidate => candidate.id), ['hidden']);
});

test('a chapter focus past the walk-out limits keeps its frame and moves or hides the glass', async t => {
  const { h, records, relocated } = outOfReachFixture();
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, elevationDegrees: 0, durationMs: 0 });
  const after = h.inspectionSnapshot().placement;
  const distance = Math.hypot(...after.translation) * 100 * .01;
  t.diagnostic(JSON.stringify({ distance, relocated, reasons: records.filter(r => r.kind === 'chapter-field').map(r => r.reason) }));
  assert.ok(distance <= 1.5 * 2 + 1e-6, `focus seat ${distance} m stays within 1.5 entry stand-offs`);
  assert.ok(records.some(r => r.kind === 'chapter-field' && r.reason === 'out-of-reach'));
  assert.deepEqual(relocated, ['hidden']);
});

test('plate anchor envelopes include the continuous rotational arc without inflating the assembly', () => {
  const track = {id:'turn',chains:['A'],keyframes:[
    {t:0,translation:[0,0,0],rotation:[0,0,0,1]},
    {t:2,translation:[3,0,0],rotation:[0,0,1,0]}]};
  const point = [10,0,0], envelope = trackPointEnvelope(track,point);
  for (let time=0;time<=2;time+=.01) {
    const pose = Vec3.transformMat4(Vec3(),point,poseMatrix(evaluateTrack(track,time)));
    assert.ok(Vec3.distance(pose,envelope.center)<=envelope.radius+1e-8);
  }
});

// A kinesin head carries its plate a step along the filament: one sphere
// round the ends of that step stands half the step above and below it.
test('a plate anchor path covers its whole travel in a band no taller than the step needs', () => {
  const track = {id:'step',chains:['A'],pivot:[0,0,0],keyframes:[
    {t:0,translation:[0,0,0],rotation:[0,0,0,1]},
    {t:1,translation:[80,0,0],rotation:[0,0,Math.sin(Math.PI / 24),Math.cos(Math.PI / 24)]},
    {t:2,translation:[160,0,0],rotation:[0,0,0,1]}]};
  const point = [0,10,0], envelope = trackPointEnvelope(track,point);
  assert.ok(envelope.path.length > 1, 'the step is cut into pieces');
  for (let time=0;time<=2;time+=.005) {
    const pose = Vec3.transformMat4(Vec3(),point,poseMatrix(evaluateTrack(track,time)));
    assert.ok(Vec3.distance(pose,envelope.center)<=envelope.radius+1e-8);
    assert.ok(envelope.path.some(piece => Vec3.distance(pose,piece.center)<=piece.radius+1e-8), `t=${time} lies on the path`);
  }
  const top = Math.max(...envelope.path.map(piece => piece.center[1]+piece.radius));
  assert.ok(envelope.center[1]+envelope.radius > 80, 'one sphere stands half the step above the head');
  assert.ok(top < 40, `the path stands ${top} above it`);
});

// Daraxonrasib's chapter-1 card corner sat inside the box round the KRAS
// sphere, though every sight line through the card passed the sphere by a
// wide margin, so the menu left the forward view for a turned-head seat.
test('glass set diagonally off a ball clears it by its silhouette, not by its box', () => {
  const ball = { center: [0, 0, -2], radius: .3 };
  // Glass at 1.5 m from the tangent corner (left, bottom) to (-0.5, 0.5).
  const glassAt = (left, bottom) => [[left, bottom], [-.5, bottom], [-.5, .5], [left, .5]].map(([x, y]) => [x * 1.5, y * 1.5, -1.5]);
  const field = menuPoints => ({ placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    bounds: { center: ball.center, radius: ball.radius, spheres: [{ ...ball }], still: true },
    center: ball.center, radius: ball.radius, cameraScale: 1, headInRoom: identity(), renderFromRoom: identity(),
    views: syntheticViews(), menuPoints });
  // The ball spans 0.15 of a tangent each side of the gaze. With the 0.04
  // gap its box still reaches a glass corner at (-0.18, 0.18), while every
  // sight line through that glass passes outside its silhouette.
  const diagonal = field(glassAt(-.18, .18));
  // Its box, the measure for a field that may walk, does reach the glass.
  assert.equal(fitChapterField({ ...diagonal, exact: false, keepPlacement: true, allowOffscreen: true }), undefined);
  assert.deepEqual(fitChapterField({ ...diagonal, keepPlacement: true, allowOffscreen: true }), diagonal.placement);
  assert.equal(menuObstruction(diagonal).area, 0);
  // Glass whose corner does reach the ball is still refused.
  const over = field(glassAt(-.07, .07));
  assert.equal(fitChapterField({ ...over, keepPlacement: true, allowOffscreen: true }), undefined);
  assert.ok(menuObstruction(over).area > 0);
});

// Mol* keeps spare capacity in a text buffer. Its unused tail read as an
// anchor at the structure's origin, so each label added an invisible plate
// there: ten on telomerase, three on daraxonrasib, blocking the left seats.
test('a still chapter field counts only the label anchors that are drawn', () => {
  const { h } = stillMotorAtRest(true);
  const cell = value => ({ ref: { value } });
  const anchor = [40, 10, 0], spare = 4;
  const label = { renderObjects: [{ type: 'text', state: { visible: true }, values: {
    drawCount: cell(6), instanceCount: cell(1), elements: cell([0,1,2,0,2,3]), uVertexCount: cell(4),
    aPosition: cell([...Array.from({ length: 4 }, () => anchor).flat(), ...new Array(spare * 3).fill(0)]),
    aMapping: cell([-2,-.7,2,-.7,2,.7,-2,.7, ...new Array(spare * 2).fill(0)]),
    aTransform: cell(h.placementTransform(h.inspectionSnapshot().placement)),
    aTexCoord: cell(new Array(8 + spare * 2).fill(10)), dSizeType: cell('uniform'), uSize: cell(1), uSizeFactor: cell(6),
    uOffsetX: cell(0), uOffsetY: cell(0), uOffsetZ: cell(3) } }] };
  h.lessonFigure = { snapshot: () => ({}), annotations: () => [label] };
  h.renderedMeshVertexCount = renderedMeshVertexCount;
  const plates = h.chapterFieldBounds(undefined, { still: true }).spheres.filter(sphere => sphere.kind === 'plate');
  assert.equal(plates.length, 1, 'one label, one plate');
  assert.ok(Vec3.distance(plates[0].center, anchor) < 1e-6, 'at the label, never at the origin');
});

function scaledCardFixture() {
  const { h } = clearanceFixture(2);
  h.latestRoomPlacementPose.labelViews = [-1, 1].map(side => {
    const view = structuredClone(h.latestRoomPlacementPose.labelViews[0]);
    view.eye = side < 0 ? 'left' : 'right';
    view.transform.inverse.matrix = identity();
    view.transform.inverse.matrix[12] = -side * .032;
    view.transform.inverse.matrix[13] = -1.6;
    return view;
  });
  h.chapterFieldBounds = () => ({ center: [0, 0, 0], radius: 38, still: true });
  h.wearerPlacement = { holdsPlacement: () => true };
  h.inspectionState.place({ translation: [0, 1.6, -2], rotation: [0, 0, 0], scale: 3 });
  const before = structuredClone(h.inspectionSnapshot().placement);
  const decisions = [];
  const t = toolbarFrameHarness(runtime, { state: { tour }, beforeMenuDraw: async options => {
    const answer = await h.clearChapterMenu(options);
    decisions.push(answer);
    return answer;
  } });
  return { h, t, before, decisions };
}

test('scaled held field keeps a whole chapter card and every lesson control', async t => {
  const { h, t: harness, before, decisions } = scaledCardFixture();
  try {
    await harness.toolbar.update();
    const answer = decisions.find(answer => answer?.chapterCardSeat), seat = answer?.chapterCardSeat;
    t.diagnostic(JSON.stringify({ seat: seat?.id, band: seat?.band, kept: answer?.kept === true }));
    assert.ok(seat, 'a separate chapter card seat is admitted');
    // The narrow side card held `The motor` over `at rest`, a title cut in
    // two with no caption under it. It is no card, and is never offered.
    assert.notEqual(seat.beside, true);
    assert.equal(seat.panel.readoutPoints[0].text, runtime.tourReadout(tour)[0].text, 'the title line is whole');
    assert.ok(seat.panel.readoutPoints.length >= 2, 'with a caption line under it');
    assert.ok(menuGlassInView({ views: h.latestRoomPlacementPose.labelViews, renderFromRoom: identity(), menuPoints: seat.points, fully: true }));
    assert.equal(harness.toolbar.isCollapsed(), true);
    assert.equal(harness.toolbar.isHidden(), false, 'the card remains visible');
    assert.ok(harness.toolbar.captionPoints().length);
    assert.ok(harness.toolbar.drawnMenuPoints().length > 0, 'compact Menu control remains drawn');
    assert.equal(seat.panel.buttons.length, harness.toolbar.rows().length);
    assert.equal(seat.panel.statusPoints.length, 1);
    assert.deepEqual(h.inspectionSnapshot().placement, before, 'the agent pose is untouched');
    assert.ok(menuGlassInView({ views: h.latestRoomPlacementPose.labelViews, renderFromRoom: identity(), menuPoints: harness.toolbar.platePoints() }));
    if (!answer.kept) assert.equal(menuOverlap({ placement: before, bounds: h.chapterFieldBounds(), center: [0,0,0], radius: 100,
      cameraScale: .01, renderFromRoom: identity(), views: h.latestRoomPlacementPose.labelViews,
      menuGlass: harness.toolbar.glassPlates(), exact: true }), 0);
    const candidates = menuRelocationCandidates({ head: seat.head, rows: spatialToolbarRows({ collapsed: true, tour }),
      constants: SPATIAL_TOOLBAR_LAYOUT, readout: runtime.tourReadout(tour), measureText: runtime.toolbarTextWidth },
      { matrix: head, position: { x: 0, y: 1.6, z: 0 } }, { ...h.latestRoomPlacementPose, cardOnly: true });
    assert.equal(candidates.filter(value => value.beside).length, 0, 'no side card cuts this title');
    assert.ok(candidates.some(value => value.compact && value.band === 'top'), 'the centred top card is offered');
    assert.equal(glassPlatesOverlap(seat.glass, seatEyeViews(seat.head)), false, 'the admitted seat keeps its plates apart');
  } finally { await harness.toolbar.dispose(); }
});

test('scaling down restores the normal column after a separate chapter card seat', async () => {
  const { h, t, decisions } = scaledCardFixture();
  try {
    await t.toolbar.update();
    assert.ok(decisions.some(answer => answer?.chapterCardSeat), 'begins with the separate card');
    h.inspectionState.place({ scale: .3 });
    t.toolbar.runAction({ kind: 'recenter-menu', reason: 'placement' });
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.toolbar.isHidden(), false);
    assert.ok(t.toolbar.drawnMenuPoints().length, 'normal compact controls return');
    assert.ok(t.toolbar.captionPoints().length);
    assert.equal(decisions.at(-1)?.chapterCardSeat, undefined);
  } finally { await t.toolbar.dispose(); }
});

for (const edge of ['top', 'bottom']) test(`wide field uses the ${edge} view band when beside seats are blocked`, async () => {
  const { h, t, decisions, before } = scaledCardFixture();
  // A wide shallow field leaves only a vertical gap. Shift it toward the
  // opposite edge so both fallback orders are exercised in stereo.
  h.chapterFieldBounds = () => ({ center: [0,0,0], radius: 100, still: true,
    spheres: [{ center: [0, edge === 'top' ? -45 : 45, 0], radius: 100,
      quad: [[300,0,0],[0,40,0]] }] });
  try {
    await t.toolbar.update();
    const answer = decisions.at(-1);
    const band = answer?.chapterCardSeat?.band ?? (answer?.menuRelocation ? answer.menuRelocation.constants.chapterCardBelow ? 'bottom' : 'top' : 'top');
    assert.equal(band, edge);
    assert.ok(t.toolbar.drawnMenuPoints().length > 0);
    assert.equal(t.toolbar.isHidden(), false);
    assert.deepEqual(h.inspectionSnapshot().placement, before);
  } finally { await t.toolbar.dispose(); }
});

test('a chapter step restores the column and steady frames do not rebuild the separate card', async () => {
  const { h, t, decisions } = scaledCardFixture();
  try {
    await t.toolbar.update();
    assert.ok(decisions.at(-1)?.chapterCardSeat);
    runtime.reset();
    await t.frames(72);
    assert.equal(runtime.counts.createToolbarPanel ?? 0, 0);
    assert.equal(runtime.counts.toolbarRepresentationUpdates ?? 0, 0);
    h.chapterFieldBounds = () => ({ center: [0,0,0], radius: 5, still: true });
    t.setState({ tour: { ...tour, step: 1, title: 'Space returns' } });
    await t.toolbar.update();
    assert.ok(t.toolbar.drawnMenuPoints().length);
    assert.equal(t.toolbar.isHidden(), false);
  } finally { await t.toolbar.dispose(); }
});

test('restoring the column cannot trade a visible separate card for off-view glass', async () => {
  const { h, points } = clearanceFixture();
  h.wearerPlacement = { holdsPlacement: () => true };
  const behind = points.map(([x, y]) => [x, y, 1]);
  const parked = { id: 8, parked: true, points: points.map(([x, y, z]) => [x + 5, y, z]) };
  const result = await h.clearChapterMenu({ points: behind, currentPoints: points,
    isCurrent: () => true, relocationCandidates: () => [parked] });
  assert.equal(result?.menuRelocation, undefined);
});

test('a clipped side seat is refused even when part of it is visible in both eyes', async () => {
  const { h } = clearanceFixture();
  h.wearerPlacement = { holdsPlacement: () => true };
  const glass = (left, right) => [left, right].flatMap(x => [.8, .9].map(y => [x, y, -1]));
  const clipped = { id: 'clipped', points: glass(-1.1, -.8) };
  const whole = { id: 'whole', points: glass(.65, .8) };
  const view = { views: h.latestRoomPlacementPose.labelViews, renderFromRoom: identity() };
  assert.equal(menuGlassInView({ ...view, menuPoints: clipped.points }), true);
  assert.equal(menuGlassInView({ ...view, menuPoints: clipped.points, fully: true }), false);
  const before = structuredClone(h.inspectionSnapshot().placement);
  const answer = await h.clearChapterMenu({ points: [[-.2,-.2,-1],[.2,.2,-1]],
    isCurrent: () => true, relocationCandidates: () => [clipped, whole] });
  assert.equal(answer.menuRelocation.id, 'whole');
  assert.deepEqual(h.inspectionSnapshot().placement, before);
});

test('a lesson seats its card at the top before any seat that puts it below', async () => {
  const { h } = clearanceFixture();
  const glass = (left, right, bottom, top) => [left, right].flatMap(x => [bottom, top].map(y => [x, y, -1]));
  const below = { id: 'below', constants: { chapterCardBelow: true }, points: glass(.65, .8, -.9, -.8) };
  const top = { id: 'card-top', band: 'top', compact: true, points: glass(.65, .8, .8, .9) };
  const ask = lesson => h.clearChapterMenu({ points: [[-.2, -.2, -1], [.2, .2, -1]], isCurrent: () => true, lesson,
    relocationCandidates: () => [below], chapterCardCandidates: () => [top] });
  assert.equal((await ask(true))?.chapterCardSeat, top, 'the top card, with the compact menu');
  assert.equal((await ask(false))?.menuRelocation, below, 'outside a lesson the whole column comes first');
});

test('CRISPR-style drawn parts clear diagonal menu rays during a chapter without a bounding-box refusal', async () => {
  const { h, records } = clearanceFixture();
  h.chapterFieldBounds = () => ({ center: [0,0,0], radius: 30,
    spheres: [{ center: [0,0,0], radius: 30, kind: 'drawn' }] });
  const points = [-.5, -.18].flatMap(x => [.18, .5].map(y => [x * 1.5, y * 1.5, -1.5]));
  const before = structuredClone(h.inspectionSnapshot().placement);
  const options = { placement: before, bounds: h.chapterFieldBounds(), center: [0,0,0], radius:100,
    cameraScale:.01, ...h.latestRoomPlacementPose, views:h.latestRoomPlacementPose.labelViews, menuPoints:points };
  assert.ok(menuObstruction({ ...options, bounds: { ...options.bounds,
    spheres: [{ center:[0,0,0],radius:30,kind:'motion' }] }, exact:false }).area > 0, 'the bounding box covers the glass');
  assert.equal(menuObstruction({ ...options, exact:false }).area, 0, 'every glass ray misses the drawn part');
  assert.equal(await h.clearChapterMenu({ points, isCurrent:()=>true }), undefined);
  assert.deepEqual(h.inspectionSnapshot().placement, before);
  assert.equal(records.filter(record=>record.reason==='menu-obstructed').length, 0);
});

test('a chapter drawn as a ball per atom is measured without overflowing the call stack', () => {
  // A microtubule tube draws about 177,000 atoms; each is one drawn ball.
  const { h } = clearanceFixture();
  const spheres = Array.from({ length: 200_000 }, (_, i) => ({ radius: 2, kind: 'drawn',
    center: [(i % 100 - 50) * 2.4, (Math.floor(i / 100) % 100 - 50) * 2.4, Math.floor(i / 10_000) - 10] }));
  const points = [-.5, -.18].flatMap(x => [.18, .5].map(y => [x * 1.5, y * 1.5, -1.5]));
  const options = { placement: structuredClone(h.inspectionSnapshot().placement),
    bounds: { center: [0,0,0], radius: 170, spheres }, center: [0,0,0], radius: 100, cameraScale: .01,
    ...h.latestRoomPlacementPose, views: h.latestRoomPlacementPose.labelViews, menuPoints: points };
  assert.ok(Number.isFinite(menuObstruction({ ...options, exact: false }).area));
  assert.ok(menuObstruction({ ...options, exact: false }).area > 0, 'the field stands behind the menu glass');
  // Clearing the menu searches every ball's corners for the nearest seat.
  try { fitChapterField({ ...options, clearanceOnly: true, allowOffscreen: true }); }
  catch (error) { assert.ok(!(error instanceof RangeError), error.message); }
});

test('CRISPR-style separated drawn lobes leave their empty gap clear instead of using the whole mesh sphere', () => {
  const cell = value => ({ ref: { value, version: 0 } });
  const mesh = { type:'mesh', state:{visible:true}, values:{
    boundingSphere:cell({center:[0,0,-2],radius:1}),
    aPosition:cell([-.8,-.1,-2, -.6,-.1,-2, -.7,.1,-2, .6,-.1,-2, .8,-.1,-2, .7,.1,-2]),
    aGroup:cell([0,0,0,1,1,1]), elements:cell([0,1,2,3,4,5]),
    aTransform:cell(identity()), instanceCount:cell(1), drawCount:cell(6), uVertexCount:cell(6),
  } };
  const spheres = visibleChapterSpheres([mesh], identity());
  assert.equal(spheres.length, 2, 'one conservative ball per drawn lobe');
  const options = { placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}, center:[0,0,-2],radius:1,
    cameraScale:1,renderFromRoom:identity(),views:syntheticViews(),
    menuPoints:[-.08,.08].flatMap(x=>[-.05,.05].map(y=>[x,y,-1])) };
  const bounds = balls => ({center:[0,0,-2],radius:1,still:true,spheres:balls});
  assert.ok(menuObstruction({...options,bounds:bounds([{center:[0,0,-2],radius:1}])}).area > 0);
  assert.equal(menuObstruction({...options,bounds:bounds(spheres)}).area, 0);
  assert.ok(menuObstruction({...options,bounds:bounds(spheres),menuPoints:options.menuPoints.map(([x,y,z])=>[x-.35,y,z])}).area > 0,
    'glass over a drawn lobe is still refused');
  // A geometry edit invalidates the cache; the new triangle fills the gap.
  mesh.values.aPosition.ref.value = [0,-.1,-2,.1,-.1,-2,0,.1,-2,.6,-.1,-2,.8,-.1,-2,.7,.1,-2];
  mesh.values.aPosition.ref.version++;
  assert.ok(menuObstruction({...options,bounds:bounds(visibleChapterSpheres([mesh],identity()))}).area > 0);
});

test('a blocked lesson caption cannot hide an independently clear control seat', async () => {
  const { h } = clearanceFixture();
  h.wearerPlacement = { holdsPlacement: () => true };
  const rectangle = (left, right, bottom, top) => [left, right].flatMap(x => [bottom, top].map(y => [x, y, -1]));
  const caption = rectangle(-.2, .2, -.2, .2), status = rectangle(.8, .9, -.7, -.6);
  const seat = (id, menu) => ({ id, band: 'top', stableLesson: true, glance: true,
    points: [...caption, ...menu, ...status], glass: [caption, menu, status], statusGlass: status });
  const blocked = seat('blocked', rectangle(.4, .45, .1, .15));
  const clear = seat('clear-controls', rectangle(.8, .9, -.1, .1));
  const result = await h.clearChapterMenu({ points: blocked.points, glass: blocked.glass,
    statusGlass: status, isCurrent: () => true, lesson: true, chapterCardCandidates: () => [blocked, clear] });
  assert.equal(result?.kept, true, 'the fixed caption intersects both choices');
  assert.equal(result.chapterCardSeat.id, clear.id, 'the menu takes its independently clear seat');
});
