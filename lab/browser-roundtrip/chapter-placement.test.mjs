import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('installing or clearing a chapter animation cannot reinterpret a recentered placement', () => {
  const h = tourFocusHarness().h;
  const base = { center: [-6, 7, -3], radius: 184 };
  let envelope;
  h.structure = { obj: { data: { boundary: { sphere: base } } } };
  h.molecularAnimation = { envelope: () => envelope };
  for (const name of ['recordBoundingSphere', 'loadedSphere', 'placementTransform'])
    vm.runInContext(pageFunction(source, name), h);
  const placement = { translation: [.032178, .438761, -1.603064], rotation: [15, 35, 0], scale: 1.937124 };
  const before = plain(h.placementTransform(placement));
  envelope = { center: [80, 20, 0], radius: 240 };
  assert.deepEqual(plain(h.placementTransform(placement)), before);
  envelope = undefined;
  assert.deepEqual(plain(h.placementTransform(placement)), before);
});

test('stale XR tracking refuses chapter focus without writing a desktop camera', async () => {
  const h = tourFocusHarness().h;
  let cameraWrites = 0;
  h.latestHeadSample = -2000;
  h.fitInspection = async () => { cameraWrites++; };
  await assert.rejects(h.focusSelection({ wholeStructure: true, liftEmphasis: false }),
    { code: 'tracking_timeout', message: 'Wait for headset tracking before framing the chapter.' });
  assert.equal(cameraWrites, 0);
});

test('an authored chapter translation behind the wearer cannot replace the current room position', async () => {
  const h = tourFocusHarness().h;
  h.inspectionState.place({ translation: [.2, 1.1, -2], rotation: [0, 0, 0], scale: 1.9371 });
  h.clearHeldPlatePlacement = async placement => placement;
  await h.placeInspection({ translation: [8, 0, 8], scale: .5648 }, 'tour-placement');
  assert.deepEqual(plain(h.inspectionSnapshot().placement.translation), [.2, 1.1, -2]);
  assert.equal(h.inspectionSnapshot().placement.scale, .5648);
});

// The session's room: the source centre at [0, 0, 0] stands 2.4 m ahead of the
// entry head at eye height, and the entry seat sits higher and farther back.
const entrySeat = { translation: [0, .45, -1.67], rotation: [0, 0, 0], scale: 1.98 };
function enteredRoom(yawDegrees = 0) {
  const { h, hold } = tourFocusHarness();
  h.latestRoomPlacementPose.renderFromRoom = Array.from(Mat4.fromTranslation(Mat4(), Vec3.create(0, -1.1, 2.4)));
  const head = Mat4.fromRotation(Mat4(), yawDegrees * Math.PI / 180, Vec3.create(0, 1, 0));
  head[13] = 1.1;
  h.latestRoomPlacementPose.headInRoom = Array.from(head);
  h.inspectionState.place(entrySeat);
  h.clearHeldPlatePlacement = async placement => placement;
  return { h, hold };
}

test('an unheld chapter opens at its authored seat, as on the desktop', async () => {
  const { h } = enteredRoom();
  await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, 'tour-placement');
  assert.deepEqual(plain(h.inspectionSnapshot().placement), { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
});

for (const [why, yaw, translation] of [['beside a wearer who turned and pressed Reset', 90, [0, 0, 0]],
  ['beyond the room', 0, [0, 0, -12]]]) test(`an authored seat ${why} keeps the current centre`, async () => {
  const { h } = enteredRoom(yaw);
  await h.placeInspection({ translation, rotation: [0, 140, 0], scale: 1.1 }, 'tour-placement');
  assert.deepEqual(plain(h.inspectionSnapshot().placement), { ...entrySeat, rotation: [0, 140, 0], scale: 1.1 });
});

// A source swapped in during the session keeps the outgoing structure's scene
// scale and origin, so its own [0, 0, 0] stands wherever that history put it.
// The opening chapter's seat is the frame its later chapters are read in.
function seatedLesson(h, opening = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }) {
  h.authoredChapterFrame = null;
  for (const name of ['authoredFrameKey', 'recordAuthoredChapterFrame', 'chapterPlacementInSeat'])
    vm.runInContext(pageFunction(source, name), h);
  h.recordAuthoredChapterFrame(opening, entrySeat, 'nucleosome');
}
const ofLesson = { lesson: 'nucleosome' };

test('a later chapter is read against the seat its lesson opened at, not the source origin', async () => {
  const { h } = enteredRoom();
  seatedLesson(h);
  await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 140, 0], scale: 1.1 }, 'tour-placement', ofLesson);
  const placed = plain(h.inspectionSnapshot().placement);
  assert.deepEqual(placed.translation, entrySeat.translation);
  assert.deepEqual(placed.rotation, [0, 140, 0]);
  assert.ok(Math.abs(placed.scale - entrySeat.scale * 1.1) < 1e-9, `scale ${placed.scale}`);
});

test('an authored size and offset keep their proportion to the opening chapter', async () => {
  const { h } = enteredRoom();
  seatedLesson(h, { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1.5 });
  await h.placeInspection({ translation: [.1, 0, 0], scale: 3 }, 'tour-placement', ofLesson);
  const placed = plain(h.inspectionSnapshot().placement);
  assert.ok(Math.abs(placed.scale - entrySeat.scale * 2) < 1e-9, `scale ${placed.scale}`);
  assert.ok(Math.abs(placed.translation[0] - .1 * entrySeat.scale / 1.5) < 1e-9, `x ${placed.translation[0]}`);
  assert.deepEqual(placed.translation.slice(1), entrySeat.translation.slice(1));
});

for (const [what, change] of [['source', h => { h.state.sourceSha256 = 'b'.repeat(64); }],
  ['session', h => { h.canvas.webgl.xr.session = {}; }]]) test(`a seat from another ${what} does not frame the chapter`, async () => {
  const { h } = enteredRoom();
  seatedLesson(h);
  change(h);
  await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, 'tour-placement', ofLesson);
  assert.deepEqual(plain(h.inspectionSnapshot().placement), { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
});

test('a new lesson on the same source is not read against the previous lesson\'s seat', async () => {
  const { h } = enteredRoom();
  seatedLesson(h);
  Object.assign(h, { siteViewReturn: undefined, lessonResting: { install: async () => {} } });
  vm.runInContext(pageFunction(source, 'setLessonRestingState'), h);
  await h.setLessonRestingState(undefined);
  await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, 'tour-placement', ofLesson);
  assert.deepEqual(plain(h.inspectionSnapshot().placement), { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
});

test('another lesson started on the same source is not read against this lesson\'s seat', async () => {
  const { h } = enteredRoom();
  seatedLesson(h, { translation: [0, 0, 0], rotation: [0, 0, 0], scale: .5 });
  await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, 'tour-placement', { lesson: 'fold-detective' });
  assert.deepEqual(plain(h.inspectionSnapshot().placement), { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
});

// The wearer turned, and Reset or Fit seated the molecule afresh in front of them.
const wearerSeat = { translation: [1.2, .3, -.4], rotation: [0, 90, 0], scale: 1.5 };
for (const [what, options] of [['Reset', { resetMenu: true }], ['Fit', {}]])
  test(`after the wearer's ${what}, the next chapter keeps the new seat's centre`, async () => {
    const { h } = enteredRoom(90);
    seatedLesson(h);
    Object.assign(h, { roomAnchor: undefined, notePlacement() {}, releaseWearerPlacement() {},
      roomAnchorPlacement: () => ({ ...wearerSeat, mode: 'auto', metersAcross: 2.4, roomPoint: [0, 0, 0] }) });
    vm.runInContext(pageFunction(source, 'seatStructureForEntry'), h);
    await h.seatStructureForEntry(options);
    assert.deepEqual(plain(h.inspectionSnapshot().placement.translation), wearerSeat.translation);
    await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 140, 0], scale: 1.1 }, 'tour-placement', ofLesson);
    assert.deepEqual(plain(h.inspectionSnapshot().placement), { translation: wearerSeat.translation, rotation: [0, 140, 0], scale: 1.1 });
  });

test('a starting pose restored as it stood is not read against the lesson\'s seat', async () => {
  const { h } = enteredRoom();
  seatedLesson(h, { translation: [0, 0, 0], rotation: [0, 0, 0], scale: .5 });
  const start = { translation: [.2, .4, -1.5], rotation: [0, 0, 0], scale: 1.9 };
  await h.placeInspection(start, 'tour-placement');
  assert.deepEqual(plain(h.inspectionSnapshot().placement), start);
});

test('a held placement keeps its seat, size and turn through an authored chapter', async () => {
  const { h, hold } = enteredRoom();
  hold.takeover('grab');
  await h.placeInspection({ translation: [0, 0, 0], rotation: [0, 140, 0], scale: 1 }, 'tour-placement');
  assert.deepEqual(plain(h.inspectionSnapshot().placement), entrySeat);
});

for (const held of [false, true]) test(`shared chapter cannot import the recorded offscreen placement (manual hold=${held})`, async () => {
  const h = tourFocusHarness().h;
  const placement = { translation: [.032178041693483, .43876074196535464, -1.6030642019945036], rotation: [0, 0, 0], scale: 1.937124232289878 };
  const offscreen = { translation: [.05468692264830238, .3301468440301175, .16295393976105377], rotation: [0, 0, 0], scale: .5648257703723718 };
  h.inspectionState.place(placement);
  if (held) h.wearerPlacement.takeover('grab');
  let cameraWrites = 0, appearanceOptions;
  Object.assign(h, { validInspectionCapture: v => v, canRestoreLessonPlaybackMetadata: () => false, completeInspectionCapture: () => ({}), lessonPlayback: undefined, detached: structuredClone,
    normalizeStyles: v => v ?? [], normalizeVisibility: v => v ?? {}, lessonMotionHold: { release() {} },
    restoreCompanion: async () => {}, markSelection() {},
    applyInspectionAppearance: async options => { appearanceOptions = options; },
    fitDesktopPreview: () => { cameraWrites++; }, inspectionPayload: () => ({}),
  });
  Object.assign(h.lessonFigure, { definition: () => undefined, install: async () => {} });
  Object.assign(h.molecularAnimation, { checkpoint: () => undefined, restore: async () => {},
    supersededBy: () => false, halt() {}, resume() {}, settled: async () => {} });
  Object.assign(h.inspectionState, { replace: v => h.inspectionState.place(v.placement), setPayload() {} });
  h.canvas.camera.setState = () => { cameraWrites++; };
  vm.runInContext(pageFunction(source, 'restoreInspection'), h);
  const incoming = { keys: [], camera: {}, inspection: { placement: offscreen, lessonPlayback: { chapterId: 'two-steps' } } };
  await h.restoreInspection(incoming, { preserveCamera: true });
  assert.deepEqual(plain(h.inspectionSnapshot().placement), placement);
  assert.equal(cameraWrites, 0);
  assert.equal(appearanceOptions.preservePlacement, true);
  // An explicit placement restore remains available to named views/recovery.
  await h.restoreInspection(incoming, { preserveCamera: true, restorePlacement: true });
  assert.deepEqual(plain(h.inspectionSnapshot().placement), offscreen);
});

test('a save recovery asks the menu fit to prove the restored pose as it stands', async () => {
  const h = tourFocusHarness().h, seen = [];
  Object.assign(h, { validInspectionCapture: v => v, canRestoreLessonPlaybackMetadata: () => false, completeInspectionCapture: () => ({}), lessonPlayback: undefined, detached: structuredClone,
    normalizeStyles: v => v ?? [], normalizeVisibility: v => v ?? {}, lessonMotionHold: { release() {} },
    restoreCompanion: async () => {}, markSelection() {}, fitDesktopPreview() {}, inspectionPayload: () => ({}),
    applyInspectionAppearance: async options => { seen.push(options); },
  });
  Object.assign(h.lessonFigure, { definition: () => undefined, install: async () => {} });
  Object.assign(h.molecularAnimation, { checkpoint: () => undefined, restore: async () => {},
    supersededBy: () => false, halt() {}, resume() {}, settled: async () => {} });
  Object.assign(h.inspectionState, { replace: v => h.inspectionState.place(v.placement), setPayload() {} });
  vm.runInContext(pageFunction(source, 'restoreInspection'), h);
  const pose = { translation: [.1, .2, -1.4], rotation: [0, 0, 0], scale: .8 };
  await h.restoreInspection({ keys: [], camera: {}, inspection: { placement: pose } }, { preserveCamera: true, exactPlacement: true });
  await h.restoreInspection({ keys: [], camera: {}, inspection: { placement: pose } }, { preserveCamera: true, menuMustMove: true });
  await h.restoreInspection({ keys: [], camera: {}, inspection: { placement: pose } }, { preserveCamera: true });
  assert.deepEqual(seen.map(({ preservePlacement, explicitPlacement, fixedMenu, glassMustMove }) => ({ preservePlacement, explicitPlacement, fixedMenu, glassMustMove })), [
    { preservePlacement: false, explicitPlacement: true, fixedMenu: true, glassMustMove: false },
    { preservePlacement: false, explicitPlacement: false, fixedMenu: false, glassMustMove: true },
    { preservePlacement: false, explicitPlacement: false, fixedMenu: false, glassMustMove: false }]);
  assert.deepEqual(plain(h.inspectionSnapshot().placement), pose);
});

test('explicit recenter replaces a held pose and releases framing for the next chapter', async () => {
  const { h, hold } = tourFocusHarness();
  hold.takeover('grab');
  h.runFaceAction = async action => {
    assert.equal(action, 'recenter-structure');
    hold.release('reset-view');
    h.inspectionState.place({ translation: [0, 1, -2], rotation: [0, 0, 0], scale: 1.9371 });
    return h.snapshot();
  };
  vm.runInContext(pageFunction(source, 'recenterInspection'), h);
  await h.recenterInspection(); hold.chapterStart();
  assert.equal(hold.holdsPlacement(), false);
  assert.equal(hold.state().reason, 'reset-view');
  assert.deepEqual(plain(h.inspectionSnapshot().placement.translation), [0, 1, -2]);
});

test('authored view motion cannot overwrite a desktop orbit after release', async () => {
  const h = tourFocusHarness().h;
  h.canvas.xr.isPresenting.value = false;
  h.wearerPlacement.takeover('pointer');
  h.normalizeLessonMotion = value => value;
  h.canvas.camera.getSnapshot = () => { throw Error('camera moved after manual orbit'); };
  vm.runInContext(pageFunction(source, 'applyLessonMotion'), h);
  await h.applyLessonMotion({ kind: 'orbit', axis: 'y', degrees: 2 });
});

test('desktop placement controls own scale before publishing the mutation', async () => {
  const { h, hold } = tourFocusHarness(); h.canvas.xr.isPresenting.value = false;
  h.clearHeldPlatePlacement = async placement => placement;
  h.inspectionMutation = async operation => { await operation(); assert.equal(hold.holdsPlacement(), true); return h.snapshot(); };
  await h.placeInspection({ scale: 2.2, translation: [.1, .2, -2] });
  assert.equal(h.inspectionSnapshot().placement.scale, 2.2);
});

test('a grip arriving during an authored placement solve wins without failing the chapter', async () => {
  const { h, hold } = tourFocusHarness();
  const before = plain(h.inspectionSnapshot().placement);
  h.clearHeldPlatePlacement = async () => {
    hold.takeover('grab'); h.grabOffset = [1, 2, 3]; h.grabScale = 1.2;
    throw Object.assign(Error('placement changed during fit'), { code: 'FIT_STALE' });
  };
  await h.placeInspection({ scale: .5 }, 'tour-placement');
  assert.deepEqual(plain(h.inspectionSnapshot().placement), before);
  assert.deepEqual(plain(h.grabOffset), [1, 2, 3]); assert.equal(h.grabScale, 1.2);
});

test('a size the wearer asks for by voice is held as theirs past the chapter end', async () => {
  // In the headset, the host's typed "larger" is the wearer speaking. An agent's size change
  // ends with its chapter; the wearer's stays, as a menu size step does.
  const { h, hold } = tourFocusHarness();
  h.clearHeldPlatePlacement = async placement => placement;
  vm.runInContext(pageFunction(source, 'scaleInspectionForWearer'), h);
  await h.scaleInspectionForWearer(1.2);
  assert.equal(h.inspectionSnapshot().placement.scale, 1.2);
  assert.equal(hold.state().reason, 'voice-scale');
  assert.equal(hold.endChapter('chapter-ended'), undefined);
  assert.equal(hold.holdsPlacement(), true);
  // The same size through the agent's route is the chapter's alone.
  const agent = tourFocusHarness();
  agent.h.clearHeldPlatePlacement = async placement => placement;
  await agent.h.placeInspection({ scale: 1.2 });
  assert.equal(agent.hold.state().reason, 'agent-placement');
  agent.hold.endChapter('chapter-ended');
  assert.equal(agent.hold.holdsPlacement(), false);
});
