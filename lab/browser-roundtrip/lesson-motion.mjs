/**
 * The lesson's own chapter motion, as pure camera arithmetic and one admission
 * gate.
 *
 * cinetour's chapter ticks used to reach the viewer through `orbit` and
 * `dolly` — the same admitted inspection mutations a wearer's toolbar rows and
 * the agent's commands use. Every tick therefore committed a scene revision,
 * emitted `onMutation`, and read — through the tour player's `notifyMutation`
 * — as the wearer grabbing the structure. On the Quest 2, in the wall tier, the
 * wall lesson's opening chapter was interrupted by its own first orbit tick:
 * `tour {action:"motion", outcome:"stopped", reason:"workspace-takeover"}`
 * 0.2 s after the scene was shown, then `tour interrupted`, then the chapter's
 * colour key stripped, and the driver timed out waiting for a chapter 2 that
 * never came.
 *
 * A chapter's turn is presentation, not a saved edit. It moves the camera the
 * way the wearer's own head already does; it bakes no placement, takes no
 * wearer-placement hold, records no `wearer-placement`, bumps no revision and
 * emits no mutation — so the tour keeps playing through it, while a real grip
 * still reaches the tour through the bake it always used.
 *
 * `viewer.mjs` keeps the privileged half (the live camera, the draw). These
 * exports are the half a Node test can hold without a Mol* bundle, in the same
 * spirit as `wearer-axes.mjs` and `wearer-placement.mjs`.
 */

/** The chapter moves a tick may ask for. Anything else is refused. */
export const LESSON_MOTION_KINDS = Object.freeze(['orbit', 'dolly']);

/**
 * Validate one chapter tick. Degrees and factors are taken as authored: an
 * orbit delta is a fraction of a degree at 50 ms ticks, so there is nothing to
 * normalise into a signed half-turn here — the guard is only that the numbers
 * exist and the dolly keeps the camera outside its target.
 */
export function normalizeLessonMotion(move) {
  if (!move || typeof move !== 'object') return undefined;
  if (move.kind === 'orbit' && ['x', 'y', 'z'].includes(move.axis) && Number.isFinite(move.degrees)) {
    return { kind: 'orbit', axis: move.axis, degrees: move.degrees };
  }
  if (move.kind === 'dolly' && Number.isFinite(move.factor) && move.factor > 0) {
    return { kind: 'dolly', factor: move.factor };
  }
  return undefined;
}

/**
 * Whether the viewer may apply a chapter tick right now.
 *
 * A held grip outranks the chapter the same way it outranks a mutation: while
 * the wearer's hand (or a held pointer) is on the structure the tick no-ops,
 * and the bake at release still reaches the tour as the wearer's own takeover.
 * A lost context has no camera to move.
 */
export function lessonMotionApplies({ ready = false, interactionActive = false, contextLost = false } = {}) {
  return Boolean(ready) && !interactionActive && !contextLost;
}

/**
 * The chapter's turn as a transient, so the panel stays saved.
 *
 * `lessonCameraMove` below already keeps a tick out of the mutation path, but
 * the camera it moves is still part of `inspection.capture()`. The panel
 * compares its live capture with the scene the Mac holds on every heartbeat
 * (`plugin/src/inspector.ts:1092`), so a turning camera looked exactly like a
 * wearer editing the view: `scheduleSave` set `dirty`, `panelAvailability`
 * answered `unsaved`, and `enqueue` refused every agent command with "No panel
 * is ready for a command right now (companion unsaved)". On the headless wall
 * lesson the saved inspection revision climbed 1 -> 25 in 80 s with no edit of
 * any kind, and a placement command queued mid-chapter came back `conflict`.
 *
 * A grab already solves this shape: the hand moves the structure as a
 * transient and `bakeGrab` commits one placement on release. This is the same
 * contract for a chapter's camera. `hold` pins the camera the scene was saved
 * with, `presented` is what a capture reports while the chapter turns — the
 * pinned camera, never the moving one — and `bake` lets the live camera become
 * the saved one once, at the end of the chapter or when the lesson pauses.
 * `release` is for an explicit camera write (a restore, an agent camera
 * command) that outranks the chapter: the next tick pins again from there.
 */
export function createLessonMotionHold() {
  let held, heldSource;
  const identity = source => source ? JSON.stringify([source.sourceSha256, source.modelNumber, source.assemblyId]) : undefined;
  return Object.freeze({
    /** Pin the saved camera before a chapter's first tick. Later ticks no-op. */
    hold(camera, source) {
      const key = identity(source);
      if ((held === undefined || heldSource !== key) && camera && typeof camera === 'object') { held = camera; heldSource = key; }
      return held !== undefined;
    },
    /** The camera a capture reports: the pinned one while a chapter turns. */
    // A pinned camera may only describe the source, model and assembly that saved it.
    presented(live, source) { return held === undefined || heldSource !== identity(source) ? live : held; },
    holding() { return held !== undefined; },
    /** Chapter over. The live camera becomes the saved one, in one save. */
    bake() { const was = held !== undefined; held = undefined; return was; },
    /** An explicit camera write wins; the next tick pins again from it. */
    release() { held = undefined; },
  });
}

const AXIS_VECTORS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const magnitude = a => Math.hypot(a[0], a[1], a[2]);

/** Rodrigues' rotation of `v` about the unit `axis` — what Mol*'s own
 * `Mat4.fromRotation` + `Vec3.transformMat4` produce for the same input, in
 * plain numbers so a Node test can hold the chapter's turn without a bundle. */
function rotateAboutAxis(v, axis, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const kxv = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return [
    v[0] * c + kxv[0] * s + axis[0] * dot * (1 - c),
    v[1] * c + kxv[1] * s + axis[1] * dot * (1 - c),
    v[2] * c + kxv[2] * s + axis[2] * dot * (1 - c),
  ];
}

/**
 * One chapter tick's next camera pose, from the live pose alone.
 *
 * Same arithmetic as the viewer's `orbit`/`dolly` — the eye vector turns about
 * the target (or scales along itself) and `up` turns with it — minus the
 * mutation: nothing here is a saved edit, so nothing here may reach the tour
 * as a takeover. Returns only the fields a chapter is allowed to move;
 * `target` is never the lesson's to change.
 */
export function lessonCameraMove(camera, move) {
  const norm = normalizeLessonMotion(move);
  if (!norm) throw Error('A lesson motion needs an orbit (axis x, y or z, finite degrees) or a positive dolly factor.');
  const target = Array.isArray(camera?.target) ? [...camera.target] : [0, 0, 0];
  const position = Array.isArray(camera?.position) ? [...camera.position] : [0, 0, 1];
  const up = Array.isArray(camera?.up) ? [...camera.up] : [0, 1, 0];
  const eye = subtract(position, target);
  if (!Number.isFinite(magnitude(eye)) || magnitude(eye) <= 0) {
    throw Error('The live camera has no usable eye vector for a lesson motion.');
  }
  if (norm.kind === 'orbit') {
    const radians = norm.degrees * Math.PI / 180;
    return {
      target,
      position: add(target, rotateAboutAxis(eye, AXIS_VECTORS[norm.axis], radians)),
      up: rotateAboutAxis(up, AXIS_VECTORS[norm.axis], radians),
    };
  }
  const next = magnitude(eye) * norm.factor;
  // The same inside-the-target bound the viewer's own dolly refuses at.
  if (next <= 0.001) throw Error('A lesson dolly would place the camera inside its target.');
  return { target, position: add(target, scale(eye, next / magnitude(eye))), up };
}
