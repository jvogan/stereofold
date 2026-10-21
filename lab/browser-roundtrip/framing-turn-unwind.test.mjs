import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { tourFocusHarness, framedTourScene } from './fixtures/tour-focus-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { focusTravel } from './focus-placement.mjs';
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

// A spin chapter keeps turning once it is shown, and the next scene freezes the
// angle it reached into the placement. A framing solved in that pose put
// CRISPR's nuclease close-up at whatever yaw the spin had reached, and most of
// those yaws pushed it out to three and a half metres. The framing turns the
// spin back over its travel and lands in the pose the lesson put it in.

const yaw = matrix => Math.atan2(matrix[8], matrix[0]) * 180 / Math.PI;

function turning({ shown = 0, frozen = 0 } = {}) {
  const harness = tourFocusHarness();
  const { h } = harness;
  const drawn = [], pausedAt = [];
  Object.assign(h, { motionAngle: shown, presentationFreeze: undefined, grabRotation: null, frozenTurn: undefined,
    FRAMING_UNWIND_DEGREES_PER_SECOND: 120, stopPresentationMotion() {},
    applyInspectionTransform() { drawn.push(h.grabRotation ? yaw(h.grabRotation) : 0); },
    setInspectionMotion: async () => { pausedAt.push(h.motionAngle); } });
  for (const name of ['noteFrozenTurn', 'frozenTurnDegrees', 'takeTurnForFraming']) vm.runInContext(pageFunction(source, name), h);
  if (frozen) {
    // What `freezePresentationPose` leaves: the turn in the placement, and a note of it.
    h.inspectionState.place({ rotation: [0, frozen, 0] });
    h.noteFrozenTurn(frozen, [0, 0, 0], [0, frozen, 0]);
  }
  return { ...harness, drawn, pausedAt };
}

const level = rotation => rotation.every(value => Math.abs(value) < 1e-6);

for (const pose of [{ shown: 150 }, { frozen: 150 }]) test(`the real eased unwind stays below 120 degrees/s (${Object.keys(pose)[0]})`, async () => {
  const { h } = turning(pose);
  const frames = [];
  let now = 0;
  h.focusTravel = options => focusTravel({ ...options, now: () => now, defer() {},
    frame: callback => { now += 1; queueMicrotask(callback); },
    step: (...args) => { options.step(...args); frames.push({ time: now, angle: yaw(h.grabRotation) }); } });
  await h.emphasize({ ...framedTourScene.emphasis, origin: 'lesson' });
  const peak = Math.max(...frames.slice(1).map((frame, i) =>
    Math.abs(frame.angle - frames[i].angle) * 1000 / (frame.time - frames[i].time)));
  assert.ok(peak <= 120 + 1e-6, `peak angular speed was ${peak} degrees/s`);
  assert.ok(peak > 119, 'the test sampled the peak of the actual easing');
});

test('an explicit agent orbit releases the frozen turn before a later focus', async () => {
  const { h, drawn } = turning({ frozen: 60 });
  let camera = { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0] };
  Object.assign(h.canvas.camera, { getSnapshot: () => camera, setState: next => { camera = structuredClone(next); } });
  Object.assign(h, { cameraSnapshot: structuredClone, headsetTurnPivot: () => [0, 0, 0],
    inspectionPayload: () => ({}), failure: (_code, message) => Error(message) });
  Object.assign(h.inspectionState, { recordPayload() {}, setPayload() {} });
  vm.runInContext(pageFunction(source, 'orbit'), h);
  await h.orbit('x', 30);
  const orbited = structuredClone(camera);
  assert.ok(Math.abs(camera.position[1] + 50) < 1e-6, 'the actual orbit rotated the camera');
  await h.focusSelection({ keys: ['B'], liftEmphasis: false });
  assert.ok(drawn.every(angle => angle === 0), `focus unwound the agent's orientation: ${drawn}`);
  assert.deepEqual(camera, orbited);
  assert.ok(Math.abs(h.inspectionSnapshot().placement.rotation[1] - 60) < 1e-6);
});

test('a framing turns a showing spin back over its travel instead of freezing it', async () => {
  const { h, drawn, pausedAt } = turning({ shown: 52 });
  await h.emphasize({ ...framedTourScene.emphasis, origin: 'lesson' });
  assert.deepEqual(pausedAt, [0], 'nothing was left on the turn for the pause to freeze');
  assert.ok(Math.abs(drawn[0] - 52) < 1e-9, 'the first drawn pose is the one the wearer was looking at');
  for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i] <= drawn[i - 1] + 1e-9, 'it turns back one way');
  assert.ok(Math.abs(drawn.at(-1)) < 1e-9, 'and lands with no turn left');
  assert.ok(level(h.inspectionSnapshot().placement.rotation), `${h.inspectionSnapshot().placement.rotation}`);
});

test('a framing turns back a spin the scene already froze, the short way round', async () => {
  const { h, drawn, records } = turning({ frozen: 300 });
  await h.emphasize({ ...framedTourScene.emphasis, origin: 'lesson' });
  assert.ok(drawn.every(angle => angle >= -1e-9 && angle <= 60 + 1e-9), `${drawn}`);
  // The last travel frame is the full sixty; the draw after it is the baked pose.
  assert.ok(Math.abs(drawn.at(-2) - 60) < 1e-9, `it turns on through sixty degrees, not back through three hundred: ${drawn}`);
  assert.ok(level(h.inspectionSnapshot().placement.rotation), `${h.inspectionSnapshot().placement.rotation}`);
  // Solved in the lesson's pose, so it lands where an unturned framing lands.
  const unturned = turning();
  await unturned.h.emphasize({ ...framedTourScene.emphasis, origin: 'lesson' });
  const placed = harness => harness.records.filter(record => record.kind === 'xr-focus').at(-1);
  assert.deepEqual(placed({ records }).targetRoom, placed(unturned).targetRoom);
  assert.equal(placed({ records }).scale, placed(unturned).scale);
});

test('nothing is turned back once something else has turned the structure', async () => {
  const { h, drawn } = turning({ frozen: 40 });
  h.inspectionState.place({ rotation: [0, 75, 0] });
  await h.emphasize({ ...framedTourScene.emphasis, origin: 'lesson' });
  assert.ok(drawn.every(angle => angle === 0), `${drawn}`);
  const rotation = h.inspectionSnapshot().placement.rotation;
  assert.ok([0, 75, 0].every((value, i) => Math.abs(rotation[i] - value) < 1e-6), `${rotation}`);
});

test('turns frozen one after another are owed together', () => {
  const { h } = turning();
  h.noteFrozenTurn(20, [0, 0, 0], [0, 20, 0]);
  h.noteFrozenTurn(30, [0, 20, 0], [0, 50, 0]);
  assert.equal(h.frozenTurnDegrees({ rotation: [0, 50, 0] }), 50);
  h.noteFrozenTurn(10, [0, 75, 0], [0, 85, 0]);
  assert.equal(h.frozenTurnDegrees({ rotation: [0, 85, 0] }), 10, 'a turn made in between starts the count again');
});

test('a frozen turn is recognised however its rotation is written', () => {
  const { h } = turning();
  h.noteFrozenTurn(212, [0, 0, 0], [-180, -32, -180]);
  assert.equal(h.frozenTurnDegrees({ rotation: [180, -32, 180] }), 212);
});
