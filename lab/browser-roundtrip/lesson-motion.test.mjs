import test from 'node:test';
import assert from 'node:assert/strict';
import { createLessonMotionHold, lessonCameraMove, lessonMotionApplies, normalizeLessonMotion } from './lesson-motion.mjs';

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${message}: expected ${expected}, got ${actual}`);
const closeVec = (actual, expected, message) => {
  assert.equal(actual.length, expected.length, `${message}: component count`);
  for (let index = 0; index < expected.length; index += 1) close(actual[index], expected[index], `${message}[${index}]`);
};

/** The pose the wall lesson's chapter 1 opened from (ring 83ad4e9 seq 70-71). */
const framed = { position: [3.2, 0.9, 0.4], target: [0, 0, 0], up: [0, 1, 0] };

test('a chapter tick normalises only the two moves a chapter may ask for', () => {
  assert.deepEqual(normalizeLessonMotion({ kind: 'orbit', axis: 'y', degrees: 0.125 }), { kind: 'orbit', axis: 'y', degrees: 0.125 });
  assert.deepEqual(normalizeLessonMotion({ kind: 'dolly', factor: 0.999 }), { kind: 'dolly', factor: 0.999 });
  // Everything else a caller could smuggle through is refused, so the lesson's
  // path stays a camera move and nothing more.
  assert.equal(normalizeLessonMotion(undefined), undefined);
  assert.equal(normalizeLessonMotion('orbit'), undefined);
  assert.equal(normalizeLessonMotion({ kind: 'orbit', axis: 'w', degrees: 1 }), undefined);
  assert.equal(normalizeLessonMotion({ kind: 'orbit', axis: 'y', degrees: Number.NaN }), undefined);
  assert.equal(normalizeLessonMotion({ kind: 'dolly', factor: 0 }), undefined);
  assert.equal(normalizeLessonMotion({ kind: 'dolly', factor: -2 }), undefined);
  assert.equal(normalizeLessonMotion({ kind: 'grab', degrees: 30 }), undefined);
});

test('a held grip outranks the chapter, and so does a lost context', () => {
  assert.equal(lessonMotionApplies({ ready: true }), true);
  assert.equal(lessonMotionApplies({}), false, 'No ready scene, no chapter turn.');
  assert.equal(lessonMotionApplies({ ready: true, interactionActive: true }), false,
    'While the wearer holds the structure the tick no-ops; the release bake still reaches the tour.');
  assert.equal(lessonMotionApplies({ ready: true, contextLost: true }), false);
});

test('an orbit tick turns the eye about the target and never moves the target', () => {
  // 90 degrees about room up, from straight ahead, lands on the +X side —
  // the same arithmetic Mol*'s own `Mat4.fromRotation` + transform apply in
  // `viewer.mjs orbit`, held here so the silent path cannot drift from it.
  const next = lessonCameraMove({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] },
    { kind: 'orbit', axis: 'y', degrees: 90 });
  closeVec(next.position, [10, 0, 0], 'A quarter orbit about up carries the eye to +X');
  closeVec(next.target, [0, 0, 0], 'The target is never the lesson\'s to move');
  closeVec(next.up, [0, 1, 0], 'Up is unchanged by a turn about itself');

  const pitched = lessonCameraMove({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] },
    { kind: 'orbit', axis: 'x', degrees: 90 });
  closeVec(pitched.position, [0, -10, 0], 'A quarter orbit about x carries the eye to -y');
  closeVec(pitched.up, [0, 0, 1], 'Up turns with the eye');

  // The real tick shape: a fraction of a degree every 50 ms. It must stay a
  // finite, tiny delta — nothing here normalises it into a half-turn.
  const tick = lessonCameraMove(framed, { kind: 'orbit', axis: 'y', degrees: 0.125 });
  const distance = Math.hypot(...framed.position);
  const ticked = Math.hypot(tick.position[0], tick.position[1], tick.position[2]);
  close(ticked, distance, 'An orbit preserves the eye distance');
  close(tick.target[0] + tick.target[1] + tick.target[2], 0, 'Target still at the origin');
});

test('a dolly tick scales the eye distance and refuses to enter the target', () => {
  const closer = lessonCameraMove({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] }, { kind: 'dolly', factor: 0.5 });
  closeVec(closer.position, [0, 0, 5], 'Half the distance, same direction');
  closeVec(closer.up, [0, 1, 0], 'Up is untouched by a dolly');
  closeVec(closer.target, [0, 0, 0], 'Target untouched by a dolly');

  const farther = lessonCameraMove(framed, { kind: 'dolly', factor: 1.01 });
  const distance = Math.hypot(...framed.position);
  const moved = Math.hypot(farther.position[0], farther.position[1], farther.position[2]);
  close(moved, distance * 1.01, 'A dolly multiplies the eye distance');

  assert.throws(() => lessonCameraMove({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] },
    { kind: 'dolly', factor: 0.00001 }), /inside its target/u);
  assert.throws(() => lessonCameraMove(framed, { kind: 'orbit', axis: 'y', degrees: Number.NaN }),
    /needs an orbit/u, 'An invalid move is refused, not half-applied');
});

test('the chapter move is presentation: it carries no placement to bake', () => {
  // The takeover this guards against came from the
  // chapter's ticks travelling as inspection mutations — writes that bake a
  // placement and take the wearer's hold. The pure entry's whole output is a
  // camera pose, and its keys are exactly the ones a camera owns. If a
  // placement, scale or translation ever appears here, the lesson is writing
  // the molecule again and this test must fail.
  for (const move of [{ kind: 'orbit', axis: 'y', degrees: 5 }, { kind: 'dolly', factor: 0.99 }]) {
    const next = lessonCameraMove(framed, move);
    assert.deepEqual(Object.keys(next).sort(), ['position', 'target', 'up'],
      'A lesson motion returns a camera pose and nothing else');
  }
});

/**
 * The chapter's turn must not look like a wearer's edit.
 *
 * The panel compares its live capture with the scene the Mac holds on every
 * heartbeat (`plugin/src/inspector.ts:1092`). A camera that turns 160 times a
 * chapter therefore read as unsaved work: the panel answered `unsaved` and the
 * agent's commands were refused with "No panel is ready for a command right
 * now (companion unsaved)" for the whole lesson (Quest 2 chain 16; headless on
 * the wall lesson the saved revision climbed 1 -> 25 in 80 s with no edit of
 * any kind). The hold is the grab's contract for a camera: pin, present the
 * pin, bake once.
 */
test('a chapter hold pins the saved camera and bakes it exactly once', () => {
  const hold = createLessonMotionHold();
  const saved = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
  const turned = { position: [10, 0, 0], target: [0, 0, 0], up: [0, 1, 0] };

  // Before a chapter turns, a capture reports the live camera unchanged.
  assert.equal(hold.holding(), false);
  assert.deepEqual(hold.presented(saved), saved);

  // The first tick pins; every later tick leaves the pin where it is, so a
  // whole chapter of ticks reports one camera.
  assert.equal(hold.hold(saved), true);
  assert.equal(hold.holding(), true);
  assert.deepEqual(hold.presented(turned), saved, 'A turning camera is not reported as saved work');
  hold.hold(turned);
  assert.deepEqual(hold.presented(turned), saved, 'Only the first tick of a chapter pins');

  // The chapter ends: the live camera becomes the saved one, in one save.
  assert.equal(hold.bake(), true);
  assert.equal(hold.holding(), false);
  assert.deepEqual(hold.presented(turned), turned);
  assert.equal(hold.bake(), false, 'A second bake has nothing to commit');
});

test('an explicit camera write outranks a chapter hold', () => {
  const hold = createLessonMotionHold();
  const saved = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
  const written = { position: [0, 5, 5], target: [0, 0, 0], up: [0, 1, 0] };
  hold.hold(saved);
  // A restore, a saved view, or the agent's own camera command names the
  // camera the panel is about to save. The pin cannot outlive it; the next
  // chapter tick pins again from there.
  hold.release();
  assert.equal(hold.holding(), false);
  assert.deepEqual(hold.presented(written), written);
  assert.equal(hold.hold(written), true);
  assert.deepEqual(hold.presented(saved), written);
});

test('a hold pins nothing it cannot pin', () => {
  const hold = createLessonMotionHold();
  assert.equal(hold.hold(undefined), false, 'A missing camera does not start a hold');
  assert.equal(hold.holding(), false);
  assert.deepEqual(hold.presented(null), null);
});
