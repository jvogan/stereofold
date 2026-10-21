import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler';
// @ts-ignore Import-free manipulation maths, shared with the browser XR layer.
import { createGripLatch, createTriggerDrag, createXrManipulation, moleculeGrabDistance, idleManipulation, isPickButton, midpointBetween, multiplyMatrix4, nextManipulation, oneHandScaleFactor, pulseController, residueCaption, rotationBetween, rotationDegrees, setHeadsetCaptionSink, showHeadsetCaption, spanBetween, travelBetween, workbenchFailureCaption, GRAB_PULSE, GRAB_REJECTED, GRIP_ENGAGE, GRIP_RELEASE, MAX_FRAME_SCALE, MAX_FRAME_TRANSLATION, ONE_HAND_SCALE_PER_SECOND, MANIPULATION_FRAME_GAP_MS, TRIGGER_HOLD_MS, TRIGGER_TRACKING_GRACE_MS, TRIGGER_TRANSLATION_GAIN, PICK_PULSE, RELEASE_PULSE, WORKBENCH_OPENED_CAPTION, XR_TRIGGER_BUTTON } from '../../lab/browser-roundtrip/xr-manipulate.mjs';
// @ts-ignore The stock XR thumbstick, retuned rather than removed.
import { createStickModifiers, xrManagerAttribs, STICK_MODE } from '../../lab/browser-roundtrip/xr-locomotion.mjs';
// @ts-ignore The same frame reader used by the viewer's two thumbsticks.
import { createXrThumbstick } from '../../lab/browser-roundtrip/xr-buttons.mjs';
import { Binding } from 'molstar/lib/mol-util/binding';
import { ModifiersKeys } from 'molstar/lib/mol-util/input/input-observer';
// @ts-ignore The toolbar's own row builder, for the rerouted Workbench row.
import { spatialToolbarRowIndex, spatialToolbarRows } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';
import { ButtonsType } from 'molstar/lib/mol-util/input/input-observer';
// @ts-ignore Execute the production placement state and centroid arithmetic.
import { createInspectionState, normalizePlacement } from '../../lab/browser-roundtrip/inspection-state.mjs';
// @ts-ignore The same scale limits used by transient drawing and saved release.
import { PLACEMENT_MAX_TRANSLATION, clampPlacementScale } from '../../lab/browser-roundtrip/placement-limits.mjs';
// @ts-ignore Shared pivot correction used by the actual bake closure.
import { pivotPreservingTranslation } from '../../lab/browser-roundtrip/presentation-pivot.mjs';
// @ts-ignore Shared production gesture ownership.
import { createGesturePivot } from '../../lab/browser-roundtrip/gesture-pivot.mjs';

const unit = (x:number, y:number, z:number) => { const l = Math.hypot(x,y,z); return [x/l, y/l, z/l]; };
const apply = (matrix:number[], point:number[]) =>
  Array.from(Vec3.transformMat4(Vec3(), Vec3.create(point[0], point[1], point[2]) as any,
    Mat4.fromArray(Mat4(), matrix as any, 0)));
const hand = (over:Record<string, unknown> = {}) =>
  ({ grip: true, claimed: false, origin: [0,0,0], direction: [0,0,-1], ...over });

describe('the XR trigger reaches the residue pick', () => {
  it('takes the button Mol* actually reports for a controller trigger', () => {
    // mol-util/input/input-observer.js emits the XR click with this flag; the
    // viewer used to compare against the desktop primary alone.
    expect(XR_TRIGGER_BUTTON).toBe(ButtonsType.Flag.Trigger);
    expect(XR_TRIGGER_BUTTON).not.toBe(ButtonsType.Flag.Primary);
    expect(isPickButton(ButtonsType.Flag.Trigger)).toBe(true);
    expect(isPickButton(ButtonsType.Flag.Primary)).toBe(true);
  });

  it('still refuses the buttons that were never a pick', () => {
    for (const button of [ButtonsType.Flag.None, ButtonsType.Flag.Secondary, ButtonsType.Flag.Auxilary,
      ButtonsType.Flag.Forth, ButtonsType.Flag.Squeeze]) expect(isPickButton(button)).toBe(false);
  });
});

describe('the trackball a grip drives', () => {
  it('carries the previous aim exactly onto the current one', () => {
    const from = unit(0, 0, -1), to = unit(0.4, 0.2, -1);
    const carried = apply(rotationBetween(from, to), from);
    to.forEach((value, index) => expect(carried[index]).toBeCloseTo(value, 12));
  });

  it('turns by the angle between the two aims and no further', () => {
    const rotation = rotationBetween([0,0,-1], unit(1, 0, -1));
    expect(rotationDegrees(rotation)).toBeCloseTo(45, 10);
  });

  it('agrees with a Mol* rotation about the same axis', () => {
    const from = unit(0, 0, -1), to = unit(0.3, -0.5, -1);
    const axis = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), Vec3.create(from[0],from[1],from[2]) as any,
      Vec3.create(to[0],to[1],to[2]) as any));
    const angle = Math.acos(from.reduce((sum, value, index) => sum + value * to[index], 0));
    const expected = Array.from(Mat4.fromRotation(Mat4(), angle, axis));
    rotationBetween(from, to).forEach((value:number, index:number) => expect(value).toBeCloseTo(expected[index], 12));
  });

  it('is the identity for an unmoved hand and for a degenerate aim', () => {
    const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    expect(rotationBetween([0,0,-1], [0,0,-1])).toEqual(identity);
    expect(rotationBetween([0,0,0], [0,0,-1])).toEqual(identity);
  });

  it('is a half turn, not a NaN, for exactly opposed aims', () => {
    const rotation = rotationBetween([0,0,-1], [0,0,1]);
    expect(rotation.every(Number.isFinite)).toBe(true);
    expect(rotationDegrees(rotation)).toBeCloseTo(180, 6);
    apply(rotation, [0,0,-1]).forEach((value, index) => expect(value).toBeCloseTo([0,0,1][index], 10));
  });

  it('composes frame by frame into the one turn the wearer made', () => {
    // Sixty frames of a slow sweep must land where a single rotation would.
    const start = unit(0, 0, -1);
    let accumulated = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    let previous = start;
    for (let frame = 1; frame <= 60; frame += 1) {
      const angle = frame * 0.5 * Math.PI / 180;
      const current = [Math.sin(angle), 0, -Math.cos(angle)];
      accumulated = multiplyMatrix4(rotationBetween(previous, current), accumulated)!;
      previous = current;
    }
    expect(rotationDegrees(accumulated)).toBeCloseTo(30, 8);
    apply(accumulated, start).forEach((value, index) => expect(value).toBeCloseTo(previous[index], 10));
  });
});

describe('the gesture the grips make', () => {
  it('starts a grab on the right grip and reports no turn on that frame', () => {
    const step = nextManipulation(idleManipulation(), { right: hand() });
    expect(step.started).toBe('grab');
    expect(step.rotation).toBeUndefined();
    expect(step.state.phase).toBe('grab');
  });

  it('never starts a grab on a hand the toolbar or orb claimed', () => {
    const step = nextManipulation(idleManipulation(), { right: hand({ claimed: true }) });
    expect(step.started).toBeUndefined();
    expect(step.state.phase).toBe('idle');
  });

  it('grabs from the left grip too, since push-to-talk no longer wants it', () => {
    // Both grips grab. The split this replaces misfired: a wearer squeezing the
    // left grip to steady a two-hand scale opened a microphone instead.
    const step = nextManipulation(idleManipulation(), { left: hand() });
    expect(step.started).toBe('grab');
    expect(step.state.phase).toBe('grab');
    expect(step.state.hand).toBe('left');
  });

  it('gives the grab to the right hand when two grips arrive on the same frame', () => {
    const step = nextManipulation(idleManipulation(), { right: hand(), left: hand({ origin: [0.4, 0, 0] }) });
    expect(step.state.hand).toBe('right');
  });

  it('turns the structure while the right grip is held', () => {
    const held = nextManipulation(idleManipulation(), { right: hand() }).state;
    const step = nextManipulation(held, { right: hand({ direction: unit(0.5, 0, -1) }) });
    expect(rotationDegrees(step.rotation!)).toBeCloseTo(Math.atan(0.5) * 180 / Math.PI, 8);
  });

  it('takes the second grip as the second hand of a scale during a grab', () => {
    const held = nextManipulation(idleManipulation(), { right: hand() }).state;
    const scaling = nextManipulation(held, { right: hand(), left: hand({ origin: [0.4,0,0] }) });
    expect(scaling.started).toBe('scale');
    expect(scaling.state.span).toBeCloseTo(0.4, 12);
    expect(scaling.scale).toBeUndefined();
  });

  it('scales by the change in the distance between the hands', () => {
    let state = nextManipulation(idleManipulation(), { right: hand() }).state;
    state = nextManipulation(state, { right: hand(), left: hand({ origin: [0.4,0,0] }) }).state;
    const step = nextManipulation(state, { right: hand(), left: hand({ origin: [0.6,0,0] }) });
    expect(step.scale).toBeCloseTo(1.25, 12);
    expect(step.rotation).toBeUndefined(); // the two-hand gesture is size only
  });

  it('bounds one frame so a tracking glitch cannot fling the size', () => {
    let state = nextManipulation(idleManipulation(), { right: hand() }).state;
    state = nextManipulation(state, { right: hand(), left: hand({ origin: [0.1,0,0] }) }).state;
    const step = nextManipulation(state, { right: hand(), left: hand({ origin: [9,0,0] }) });
    expect(step.scale).toBe(MAX_FRAME_SCALE);
  });

  it('returns to the grab when the left grip lifts, without snapping the aim', () => {
    let state = nextManipulation(idleManipulation(), { right: hand() }).state;
    state = nextManipulation(state, { right: hand(), left: hand({ origin: [0.4,0,0] }) }).state;
    state = nextManipulation(state, { right: hand({ direction: unit(0.5,0,-1) }), left: hand({ origin: [0.4,0,0] }) }).state;
    const back = nextManipulation(state, { right: hand({ direction: unit(0.5,0,-1) }) });
    expect(back.ended).toBe('scale');
    expect(back.state.phase).toBe('grab');
    expect(back.rotation).toBeUndefined(); // the baseline stayed fresh while scaling
  });

  it('hands the grab to the surviving grip when the owner lets go first', () => {
    // Release order must not matter and must not jump the structure: the
    // second hand keeps holding it, rebased on its own anchor.
    let state = nextManipulation(idleManipulation(), { right: hand() }).state;
    state = nextManipulation(state, { right: hand(), left: hand({ origin: [0.4,0,0] }) }).state;
    const ended = nextManipulation(state, { right: hand({ grip: false }), left: hand({ origin: [0.4,0,0] }) });
    expect(ended.ended).toBe('scale');
    expect(ended.state.phase).toBe('grab');
    expect(ended.state.hand).toBe('left');
    // And letting the last grip go ends the gesture for real.
    const done = nextManipulation(ended.state, { right: hand({ grip: false }), left: hand({ grip: false, origin: [0.4,0,0] }) });
    expect(done.ended).toBe('grab');
    expect(done.state.phase).toBe('idle');
  });
});

describe('which hand is holding the structure', () => {
  const pointer = (handedness: string, buttons: number) =>
    ({ handedness, buttons, ray: { origin: [0, 0, 0], direction: [0, 0, -1] } });
  const grip = 2; // POINTER_GRIP

  it('names only the grabbing hand, so the other thumb keeps its stick', () => {
    const manipulation = createXrManipulation({ record: () => {}, pulse: () => true });
    manipulation.update([pointer('left', grip), pointer('right', 0)]);
    expect(manipulation.phase()).toBe('grab');
    expect(manipulation.holds('left')).toBe(true);
    expect(manipulation.holds('right')).toBe(false);
  });

  it('names both hands during a two-hand scale', () => {
    const manipulation = createXrManipulation({ record: () => {}, pulse: () => true });
    manipulation.update([pointer('right', grip)]);
    manipulation.update([pointer('right', grip), pointer('left', grip)]);
    expect(manipulation.phase()).toBe('scale');
    expect(manipulation.holds('right')).toBe(true);
    expect(manipulation.holds('left')).toBe(true);
  });

  it('names no hand while idle', () => {
    const manipulation = createXrManipulation({ record: () => {}, pulse: () => true });
    manipulation.update([pointer('right', 0), pointer('left', 0)]);
    expect(manipulation.holds('right')).toBe(false);
    expect(manipulation.holds('left')).toBe(false);
  });
});

describe('the manipulator the viewer drives', () => {
  const controllerSources = new Map<string,any>();
  beforeEach(() => controllerSources.clear());
  const pointer = (handedness:string, buttons:number, direction = [0,0,-1], origin = [0,0,0]) => {
    // WebXR keeps one source for a connected controller; a frame snapshot is
    // a new pointer, not a newly connected controller of the same handedness.
    if (!controllerSources.has(handedness)) controllerSources.set(handedness, {
      handedness, targetRayMode: 'tracked-pointer',
      gamepad: { hapticActuators: [{ pulse: vi.fn(() => Promise.resolve(true)) }] },
    });
    return { handedness, buttons, ray: { origin, direction }, source: controllerSources.get(handedness) };
  };

  it('pulses, pauses, turns and bakes exactly once for one press', () => {
    const events:string[] = [], rotations:number[] = [];
    const pulses:unknown[] = [];
    const manipulation = createXrManipulation({
      onGrabStart: () => events.push('start'),
      onRotate: (rotation:number[]) => rotations.push(rotationDegrees(rotation)),
      onGrabEnd: (summary:any) => events.push(`end:${summary.phase}:${summary.degrees}`),
      record: (kind:string, detail:any) => events.push(`${kind}:${detail.event}`),
      pulse: (_source:unknown, shape:unknown) => { pulses.push(shape); return true; },
    });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary, unit(0.5,0,-1))]);
    manipulation.update([pointer('right', ButtonsType.Flag.None)]);
    // Grab start and release each get their own buzz, so a wearer feels the
    // structure taken and let go without looking for a caption.
    expect(pulses).toEqual([GRAB_PULSE, RELEASE_PULSE]);
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toBeCloseTo(Math.atan(0.5) * 180 / Math.PI, 6);
    expect(events).toEqual(['xr-grab:pointers', 'start', 'xr-grab:start',
      `end:grab:${Math.round(rotations[0]! * 10) / 10}`, 'xr-grab:end']);
    expect(manipulation.phase()).toBe('idle');
  });

  it('lends its grip latch to the stick, so both read one signal', () => {
    // The stick's scale modifier used to read Mol*'s thresholded grip bit,
    // which crosses at a different squeeze than this latch: a hand relaxing to
    // about 0.5 held the structure and lost the scale stick at the same time.
    const source = { gamepad: { buttons: [{ value: 0 }, { value: 0 }] } };
    const squeezed = (value:number) => {
      source.gamepad.buttons[1]!.value = value;
      return { handedness: 'right', buttons: 0, ray: { origin: [0,0,0], direction: [0,0,-1] }, source };
    };
    const manipulation = createXrManipulation({ record: () => {}, pulse: () => true });
    expect(manipulation.gripHeld('right')).toBe(false);
    manipulation.update([squeezed(GRIP_ENGAGE)]);
    expect(manipulation.gripHeld('right')).toBe(true);
    // Relaxed below the bitmask's own threshold, still holding the structure.
    manipulation.update([squeezed(0.5)]);
    expect(manipulation.gripHeld('right')).toBe(true);
    expect(manipulation.phase()).toBe('grab');
    manipulation.update([squeezed(GRIP_RELEASE - 0.01)]);
    expect(manipulation.gripHeld('right')).toBe(false);
    expect(manipulation.phase()).toBe('idle');
  });

  it('refuses to grab on a hand the toolbar claimed, and buzzes nothing', () => {
    const events:string[] = [];
    const manipulation = createXrManipulation({
      isClaimed: (handedness:string) => handedness === 'right',
      onGrabStart: () => events.push('start'), pulse: () => { events.push('pulse'); return true; }, record: () => {},
    });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(events).toEqual([]);
    expect(manipulation.phase()).toBe('idle');
  });

  it('reports the two-grip scale on its own diagnostic kind', () => {
    const kinds:string[] = [];
    const manipulation = createXrManipulation({ record: (kind:string, detail:any) => kinds.push(`${kind}:${detail.event}`), pulse: () => true });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary), pointer('left', ButtonsType.Flag.Secondary, [0,0,-1], [0.4,0,0])]);
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary), pointer('left', ButtonsType.Flag.Secondary, [0,0,-1], [0.5,0,0])]);
    manipulation.update([pointer('right', ButtonsType.Flag.None), pointer('left', ButtonsType.Flag.None, [0,0,-1], [0.5,0,0])]);
    // Releasing the second grip leaves the first one holding the structure,
    // and the ownership move is worth its one line in the headset log.
    expect(kinds).toEqual(['xr-grab:pointers', 'xr-grab:start', 'xr-scale:start', 'xr-grab:rebased', 'xr-scale:end', 'xr-grab:end']);
  });

  it('drops a gesture the viewer can no longer bake instead of holding it open', () => {
    let ready = true;
    const ends:unknown[] = [];
    const manipulation = createXrManipulation({ canManipulate: () => ready, onGrabEnd: (summary:unknown) => ends.push(summary), record: () => {}, pulse: () => true });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    ready = false;
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(manipulation.phase()).toBe('idle');
    expect(ends).toHaveLength(1);
  });

  it('measures the span between the two ray origins', () => {
    expect(spanBetween([0,0,0], [0,0.3,0.4])).toBeCloseTo(0.5, 12);
    expect(spanBetween([0,0,0], undefined)).toBeUndefined();
  });

  it('carries the structure as far as the hand travels, and no further', () => {
    const moves:number[][] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]), record: () => {}, pulse: () => true,
    });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary, [0,0,-1], [0,0,0])]);
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary, [0,0,-1], [0.12,0.04,-0.3])]);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual([0.12, 0.04, -0.3]);
  });

  it('refuses a frame that jumps further than a hand can move', () => {
    // A tracking recovery must not teleport the molecule across the room.
    expect(travelBetween([0,0,0], [MAX_FRAME_TRANSLATION + 0.01, 0, 0])).toBeUndefined();
    expect(travelBetween([0,0,0], [1e-6, 0, 0])).toBeUndefined();
    expect(travelBetween([0,0,0], [0.2,0,0])![0]).toBeCloseTo(0.2, 12);
  });

  it.each(['left', 'right'])('rebases a %s grip position jump together with its orientation, then resumes motion', handedness => {
    const moves:number[][] = [], turns:number[] = [], records:any[] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]),
      onRotate: (rotation:number[]) => turns.push(rotationDegrees(rotation)),
      record: (_kind:string, detail:any) => records.push(detail), pulse: () => true,
    });
    const pose = (x:number, angle:number) => ({ handedness, buttons: 2, hasGripSpace: true,
      ray: { origin: [0,0,0], direction: [0,0,-1] },
      gripPose: { origin: [x,0,0], direction: [0,0,-1], emulatedPosition: false,
        orientation: [0,Math.sin(angle / 2),0,Math.cos(angle / 2)] } });
    manipulation.update([pose(0, 0)]);
    manipulation.update([pose(0.6, 1)]);
    expect(moves).toEqual([]); expect(turns).toEqual([]);
    expect(records).toContainEqual({ event: 'rebased', hand: handedness, reason: 'tracking-jump' });
    manipulation.update([pose(0.61, 1.02)]);
    expect(moves[0][0]).toBeCloseTo(0.01, 12);
    expect(turns[0]).toBeCloseTo(0.02 * 180 / Math.PI, 10);
    // Callers may recycle a pose object and mutate its arrays in place.
    const reused = pose(0.61, 1.02);
    manipulation.update([reused]);
    reused.gripPose.origin[0] = 1.3;
    reused.gripPose.orientation = [0,Math.sin(1),0,Math.cos(1)];
    manipulation.update([reused]);
    expect(moves).toHaveLength(1); expect(turns).toHaveLength(1);
  });

  it.each(['left', 'right'])('rebases two-grip scale when only the %s hand jumps, then resumes the span ratio', jumping => {
    const moves:number[][] = [], scales:number[] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]), onScale: (factor:number) => scales.push(factor),
      record: () => {}, pulse: () => true,
    });
    const pose = (handedness:string, x:number) => pointer(handedness, ButtonsType.Flag.Secondary, [0,0,-1], [x,0,0]);
    const pair = (span:number) => [pose(jumping, span), pose(jumping === 'left' ? 'right' : 'left', 0)];
    manipulation.update(pair(0.4)); manipulation.update(pair(0.4));
    // A 0.6 m single-hand jump moves the midpoint only 0.3 m, below the old guard.
    manipulation.update(pair(1));
    expect(moves).toEqual([]); expect(scales).toEqual([]);
    manipulation.update(pair(1.02));
    expect(moves[0][0]).toBeCloseTo(0.01, 12);
    expect(scales[0]).toBeCloseTo(1.02, 12);
  });

  it('is a wrist turn or a reach, never one read as the other', () => {
    const moves:number[][] = [], turns:number[] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]),
      onRotate: (rotation:number[]) => turns.push(rotationDegrees(rotation)),
      record: () => {}, pulse: () => true,
    });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary, [0,0,-1], [0,0,0])]);
    // The hand moves without turning: travel, no turn.
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary, [0,0,-1], [0.2,0,0])]);
    expect(moves).toHaveLength(1);
    expect(turns).toHaveLength(0);
    // The wrist turns without moving: turn, no travel.
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary, unit(0.3,0,-1), [0.2,0,0])]);
    expect(moves).toHaveLength(1);
    expect(turns).toHaveLength(1);
  });

  it('uses grip-space travel and full orientation instead of a changing target-ray origin', () => {
    const moves:number[][] = [], turns:number[] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]),
      onRotate: (rotation:number[]) => turns.push(rotationDegrees(rotation)),
      record: () => {}, pulse: () => true,
    });
    const pointer = (rayX:number, gripX:number, orientation = [0,0,0,1]) => ({
      handedness: 'right', buttons: ButtonsType.Flag.Secondary,
      ray: { origin: [rayX,0,0], direction: [0,0,-1] }, hasGripSpace: true,
      gripPose: { origin: [gripX,0,0], direction: [0,0,-1], orientation, emulatedPosition: false },
    });
    manipulation.update([pointer(0, 0)]);
    // Rotating the controller about its grip moves the forward target-ray
    // origin, but that offset is not hand travel. Grip orientation still
    // carries the roll that a ray direction cannot represent.
    manipulation.update([pointer(0.2, 0, [0,0,Math.SQRT1_2,Math.SQRT1_2])]);
    expect(moves).toEqual([]);
    expect(turns[0]).toBeCloseTo(90, 8);
    manipulation.update([pointer(0.3, 0.1, [0,0,Math.SQRT1_2,Math.SQRT1_2])]);
    expect(moves[0][0]).toBeCloseTo(0.1, 12);
    expect(moves[0].slice(1)).toEqual([0,0]);
  });

  it('uses grip-space tracking quality to suppress emulated grip translation', () => {
    const moves:number[][] = [], turns:number[] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]),
      onRotate: (rotation:number[]) => turns.push(rotationDegrees(rotation)),
      record: () => {}, pulse: () => true,
    });
    const pointer = (x:number, orientation:number[]) => ({ handedness: 'right', buttons: ButtonsType.Flag.Secondary,
      ray: { origin: [0.3 + x,0,0], direction: [0,0,-1] }, emulatedPosition: false,
      hasGripSpace: true, gripPose: { origin: [x,0,0], direction: [0,0,-1], orientation, emulatedPosition: true } });
    manipulation.update([pointer(0, [0,0,0,1])]);
    manipulation.update([pointer(0.2, [0,Math.sin(0.1),0,Math.cos(0.1)])]);
    expect(moves).toEqual([]);
    expect(turns[0]).toBeCloseTo(2 * 0.1 * 180 / Math.PI, 8);
  });

  it('keeps unknown native grip rotation while suppressing travel and spacing, then rebases quality changes', () => {
    const moves:number[][] = [], turns:number[] = [], scales:number[] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]),
      onRotate: (rotation:number[]) => turns.push(rotationDegrees(rotation)),
      onScale: (factor:number) => scales.push(factor), record: () => {}, pulse: () => true,
    });
    const pointer = (handedness:string, x:number, quality:'unknown'|'tracked-position', orientation = [0,0,0,1]) => ({
      handedness, buttons: ButtonsType.Flag.Secondary, poseQualitySource: 'webxr',
      tracking: quality, gripTracking: quality,
      emulatedPosition: quality === 'tracked-position' ? false : undefined,
      hasGripSpace: true,
      ray: { origin: [x + 0.3,0,0], direction: [0,0,-1] },
      gripPose: { origin: [x,0,0], direction: [0,0,-1], orientation,
        emulatedPosition: quality === 'tracked-position' ? false : undefined },
    });
    manipulation.update([pointer('right', 0, 'unknown')]);
    manipulation.update([pointer('right', 0.2, 'unknown', [0,0,Math.sin(0.1),Math.cos(0.1)]),
      pointer('left', -0.2, 'unknown')]);
    expect(manipulation.phase()).toBe('grab');
    expect(moves).toEqual([]);
    expect(scales).toEqual([]);
    expect(turns[0]).toBeCloseTo(2 * 0.1 * 180 / Math.PI, 8);

    // Unknown -> measured rebases at the current pose; only the next frame
    // may use the new measured position as travel.
    manipulation.update([pointer('right', 0.3, 'tracked-position', [0,0,Math.sin(0.1),Math.cos(0.1)]),
      pointer('left', -0.3, 'unknown')]);
    expect(moves).toEqual([]);
    expect(scales).toEqual([]);
    manipulation.update([pointer('right', 0.4, 'tracked-position', [0,0,Math.sin(0.1),Math.cos(0.1)]),
      pointer('left', -0.3, 'unknown')]);
    expect(moves).toHaveLength(1);
    expect(moves[0][0]).toBeCloseTo(0.1, 12);
    expect(moves[0].slice(1)).toEqual([0,0]);
    expect(scales).toEqual([]);
  });

  it('keeps legacy pointer shapes without a quality field position-compatible', () => {
    const moves:number[][] = [];
    const manipulation = createXrManipulation({ onTranslate: (delta:number[]) => moves.push([...delta]), record: () => {}, pulse: () => true });
    const legacy = (x:number) => ({ handedness: 'right', buttons: ButtonsType.Flag.Secondary,
      ray: { origin: [x,0,0], direction: [0,0,-1] } });
    manipulation.update([legacy(0)]);
    manipulation.update([legacy(0.1)]);
    expect(moves).toEqual([[0.1,0,0]]);
  });

  it('does not substitute the target ray when an advertised grip pose is unavailable', () => {
    const starts:any[] = [];
    const manipulation = createXrManipulation({ onGrabStart: (detail:any) => starts.push(detail), record: () => {}, pulse: () => true });
    manipulation.update([{ handedness: 'right', buttons: ButtonsType.Flag.Secondary,
      ray: { origin: [0.4,0,0], direction: [0,0,-1] }, hasGripSpace: true, gripPose: undefined }]);
    expect(manipulation.phase()).toBe('idle');
    expect(starts).toEqual([]);
  });

  it('pins a two-grip scale to the point between the hands, so it does not drag', () => {
    const moves:number[][] = [];
    const manipulation = createXrManipulation({
      onTranslate: (delta:number[]) => moves.push([...delta]), record: () => {}, pulse: () => true,
    });
    const right = (origin:number[]) => pointer('right', ButtonsType.Flag.Secondary, [0,0,-1], origin);
    const left = (origin:number[]) => pointer('left', ButtonsType.Flag.Secondary, [0,0,-1], origin);
    manipulation.update([right([0.2,0,0])]);
    manipulation.update([right([0.2,0,0]), left([-0.2,0,0])]);
    // Both hands pull straight apart by the same amount: the midpoint is still.
    manipulation.update([right([0.35,0,0]), left([-0.35,0,0])]);
    expect(moves).toHaveLength(0);
    expect(midpointBetween([0.35,0,0], [-0.35,0,0])).toEqual([0,0,0]);
  });

  it('names why a held grip did not grab, once per reason rather than per frame', () => {
    const rejections:string[] = [];
    let clock = 0;
    const manipulation = createXrManipulation({
      isClaimed: () => true,
      record: (kind:string, detail:any) => { if (detail.event === 'rejected') rejections.push(`${kind}:${detail.reason}`); },
      pulse: () => true, now: () => clock,
    });
    for (let frame = 0; frame < 5; frame += 1) manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(rejections).toEqual([`xr-grab:${GRAB_REJECTED.claimed}`]);
    // Keep rendering while testing the diagnostic throttle. A single 1.5 s
    // frame gap correctly cancels a held menu press and requires release.
    for (clock = 300; clock <= 1500; clock += 300) manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(rejections).toHaveLength(2);
  });

  it('says the viewer was not ready rather than swallowing the grip', () => {
    const rejections:string[] = [];
    const manipulation = createXrManipulation({
      canManipulate: () => false,
      record: (_kind:string, detail:any) => { if (detail.event === 'rejected') rejections.push(detail.reason); },
      pulse: () => true, now: () => 0,
    });
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(rejections).toEqual([GRAB_REJECTED.notReady]);
  });

  it('tells the wearer a grip was refused, then grabs when it clears under the same hand', () => {
    // A viewer that is not ready used to refuse a grip silently: nothing moved
    // when the wearer interacted with the structure and nothing said why. The
    // refusal is now spoken once a second, on the same throttle as the log
    // line, and a grip still held when the viewer comes back starts the grab
    // without a second squeeze.
    const refusals:string[] = [];
    let ready = false, clock = 0;
    const manipulation = createXrManipulation({
      canManipulate: () => ready,
      onGrabRefused: (reason:string) => refusals.push(reason),
      record: () => {}, pulse: () => true, now: () => clock,
    });
    for (let frame = 0; frame < 4; frame += 1) manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(refusals).toEqual([GRAB_REJECTED.notReady]);
    clock = 1200;
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(refusals).toHaveLength(2);
    // The mutation finishes. The grip never came up, so the grab starts here.
    ready = true;
    manipulation.update([pointer('right', ButtonsType.Flag.Secondary)]);
    expect(manipulation.phase()).toBe('grab');
    expect(refusals).toHaveLength(2);
  });

  it('writes down what the hardware published, because the session record is truncated', () => {
    // The headset log caps a record at 400 characters and loses session-start's
    // input sources, so a dead grip cannot be told from an absent controller.
    const details:any[] = [];
    const manipulation = createXrManipulation({ record: (_kind:string, detail:any) => details.push(detail), pulse: () => true });
    manipulation.update([pointer('right', ButtonsType.Flag.None), pointer('left', ButtonsType.Flag.None)]);
    manipulation.update([pointer('right', ButtonsType.Flag.None)]);
    const inventory = details.filter(detail => detail.event === 'pointers');
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ count: 2, hands: ['right', 'left'], ray: true, haptics: true });
  });
});

describe('the scale Mol* would otherwise apply twice', () => {
  it('retires the scale Mol* would apply a second time on the same grips', () => {
    // Squeeze is 48 and Trigger is 32, and Binding.match tests a non-zero bit
    // intersection, so the stock gestureScale binding of Trigger matches a
    // squeeze gesture. Two grips scaled camera.scale and the placement at once.
    expect(ButtonsType.Flag.Squeeze & ButtonsType.Flag.Trigger).toBe(ButtonsType.Flag.Trigger);
    expect(Binding.match(Binding([Binding.Trigger(ButtonsType.Flag.Trigger)]),
      ButtonsType.Flag.Squeeze, ModifiersKeys.None)).toBe(true);
    const bindings:any = { exit: 'stock-exit', togglePassthrough: 'stock-passthrough',
      gestureScale: Binding([Binding.Trigger(ButtonsType.Flag.Trigger)]) };
    const next:any = xrManagerAttribs(bindings, Binding.Empty);
    expect(next.gestureScale).toBe(Binding.Empty);
    // A is the stock passthrough toggle and B is the stock session exit, both
    // on buttons this viewer binds. Pressing B used to drop the wearer out of VR.
    // The toggle keeps a live binding on a code no controller sends, so the
    // menu row and the spoken phrases can still fire it.
    expect(next.exit).toBe(Binding.Empty);
    expect(next.togglePassthrough.triggers.map((trigger: any) => trigger.code)).toEqual(['StereofoldPassthrough']);
    expect(xrManagerAttribs(next, Binding.Empty)).toBeUndefined();
  });

});

describe('the one caption line', () => {
  beforeEach(() => setHeadsetCaptionSink(undefined));

  it('is dropped when no immersive session has registered a writer', () => {
    expect(showHeadsetCaption('Chain A · LYS 848')).toBe(false);
  });

  it('reaches the toolbar writer push-to-talk registers', () => {
    const written:string[] = [];
    setHeadsetCaptionSink((text:string) => written.push(text));
    expect(showHeadsetCaption('Chain A · LYS 848')).toBe(true);
    expect(written).toEqual(['Chain A · LYS 848']);
  });

  it('survives a writer that throws, because a caption never costs a press', () => {
    setHeadsetCaptionSink(() => { throw Error('the toolbar is mid-teardown'); });
    expect(showHeadsetCaption('Chain A · LYS 848')).toBe(false);
  });

  it('names the picked residue by chain and component', () => {
    expect(residueCaption({ authorChain: 'A', componentId: 'LYS', authorResidue: 848, insertionCode: '' })).toBe('Chain A · LYS 848');
    expect(residueCaption({ authorChain: 'B', componentId: 'HIS', authorResidue: 12, insertionCode: 'A' })).toBe('Chain B · HIS 12A');
    expect(residueCaption({ labelChain: 'C', componentId: 'HOH', authorResidue: null, labelSequenceId: null })).toBe('Chain C · HOH');
    expect(residueCaption(undefined)).toBeUndefined();
    expect(residueCaption({ authorChain: 'A' })).toBeUndefined();
  });

  it('says what went wrong when the Mac cannot show the full viewer', () => {
    expect(workbenchFailureCaption('not-macos')).toBe('This host cannot open a Mac browser');
    expect(workbenchFailureCaption('could not open')).toBe('The Mac browser did not open');
    expect(workbenchFailureCaption(undefined)).toBe('Could not open Mol* on the Mac');
    // The wearer cannot see the Mac monitor from inside VR, so the confirmation
    // has to name the action that finishes the switch.
    expect(WORKBENCH_OPENED_CAPTION).toBe('Mol* is open on the Mac. Lift the headset.');
  });

  // An elapsed LAN share used to fail as a dead press with a caption blaming
  // the Mac. These are the three sentences the companion client raises for 410,
  // a refused connection and a timeout.
  it('names the expired share rather than the Mac when the companion is gone', () => {
    expect(workbenchFailureCaption('This companion link expired. Open a new connection from the desktop inspection.'))
      .toBe('Share expired. Ask Claude to re-open it.');
    expect(workbenchFailureCaption('The companion connection was lost while sending the request. Reconnect from the desktop inspection.'))
      .toBe('Share expired. Ask Claude to re-open it.');
    expect(workbenchFailureCaption('The companion timed out while sending the request. Reconnect from the desktop inspection.'))
      .toBe('Share expired. Ask Claude to re-open it.');
  });
});

describe('haptics', () => {
  it('buzzes the one actuator a Touch controller exposes', () => {
    const pulse = vi.fn(() => Promise.resolve(true));
    expect(pulseController({ gamepad: { hapticActuators: [{ pulse }] } }, PICK_PULSE)).toBe(true);
    expect(pulse).toHaveBeenCalledWith(0.7, 40);
    expect(GRAB_PULSE).toEqual({ intensity: 0.25, durationMs: 20 });
  });

  it('is a silent no-op for a hand, an emulator, or a rejected pulse', () => {
    expect(pulseController(undefined, PICK_PULSE)).toBe(false);
    expect(pulseController({ gamepad: { hapticActuators: [] } }, PICK_PULSE)).toBe(false);
    expect(pulseController({ gamepad: { hapticActuators: [{ pulse: () => { throw Error('no'); } }] } }, PICK_PULSE)).toBe(false);
    expect(pulseController({ gamepad: { hapticActuators: [{ pulse: () => Promise.reject(Error('busy')) }] } }, PICK_PULSE)).toBe(true);
  });
});

describe('the menu row that used to end the session', () => {
  it('is still one open-workbench action, named for the Mac', () => {
    const rows = spatialToolbarRows({ collapsed: false });
    const index = spatialToolbarRowIndex(rows, { kind: 'open-workbench' });
    expect(index).toBeGreaterThanOrEqual(0);
    // The wording belongs to the toolbar; this test only requires that the row
    // still exists, still names Mol*, and still fits one line in a headset.
    expect(rows[index].label).toMatch(/Mol\*/u);
    expect(rows[index].label.length).toBeLessThanOrEqual(16);
    expect(rows[index].label.length).toBeLessThanOrEqual(12);
  });
});

/**
 * The viewer holds a grab as a transient transform and records it as one
 * placement when the grip comes up. These are the two formulas it uses, copied
 * from `viewer.mjs` so a change to either side has to change this test too.
 */
const placementRotation = (rotation:number[]) => {
  const radians = rotation.map(value => value * Math.PI / 180);
  const x = Mat4.fromRotation(Mat4(), radians[0], Vec3.create(1,0,0));
  const y = Mat4.fromRotation(Mat4(), radians[1], Vec3.create(0,1,0));
  const z = Mat4.fromRotation(Mat4(), radians[2], Vec3.create(0,0,1));
  return Mat4.mul(Mat4(), z, Mat4.mul(Mat4(), y, x));
};
const degreesZYX = (matrix:any) =>
  Array.from(Euler.fromMat4(Euler(), matrix, 'ZYX'), value => value * 180 / Math.PI);
const placementTransform = (placement:{rotation:number[];scale:number;translation:number[]}, centre:number[], radius:number) => {
  const scale = Mat4.fromScaling(Mat4(), Vec3.create(placement.scale, placement.scale, placement.scale));
  const local = Mat4.mul(Mat4(), placementRotation(placement.rotation), scale);
  const offset = Vec3.create(...placement.translation.map(value => value * radius) as [number,number,number]);
  const toCentre = Mat4.fromTranslation(Mat4(), Vec3.add(Vec3(), Vec3.create(centre[0],centre[1],centre[2]), offset));
  const fromCentre = Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), Vec3.create(centre[0],centre[1],centre[2])));
  return Mat4.mul3(Mat4(), toCentre, local, Mat4.mul(Mat4(), fromCentre, base(placement)));
};
const base = (_placement:unknown) => Mat4.identity();

describe('the grab the viewer composes and then records', () => {
  const centre = [12, -4, 7], radius = 21;
  const placement = { rotation: [11, -37, 63], scale: 1.4, translation: [0.2, -0.1, 0.35] };

  /** `placementTransform` alone, exactly as the viewer builds it. */
  const saved = (value:typeof placement) => placementTransform(value, centre, radius);

  /** The drawn transform while a grip is held: turn and size about the centroid. */
  const drawn = (grab:any, factor:number) => {
    const start = saved(placement);
    const positioned = Vec3.transformMat4(Vec3(), Vec3.create(centre[0],centre[1],centre[2]), start);
    const toCentre = Mat4.fromTranslation(Mat4(), positioned);
    const fromCentre = Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), positioned));
    const sized = Mat4.mul(Mat4(), grab, Mat4.fromScaling(Mat4(), Vec3.create(factor, factor, factor)));
    return Mat4.mul3(Mat4(), toCentre, sized, Mat4.mul(Mat4(), fromCentre, start));
  };

  it('rebuilds a placement rotation from its own euler angles', () => {
    // The bake reads the composite back as ZYX degrees; if that round trip were
    // lossy every released grab would land at a different angle than it drew.
    const rebuilt = placementRotation(degreesZYX(placementRotation(placement.rotation)));
    Array.from(placementRotation(placement.rotation)).forEach((value, index) =>
      expect(rebuilt[index]).toBeCloseTo(value, 10));
  });

  it('records the grabbed pose as the same transform it was drawing', () => {
    const grab = Mat4.fromArray(Mat4(), rotationBetween([0,0,-1], unit(0.6, 0.25, -1)) as any, 0);
    const factor = 1.35;
    const baked = {
      ...placement,
      rotation: degreesZYX(Mat4.mul(Mat4(), grab, placementRotation(placement.rotation))),
      scale: placement.scale * factor,
    };
    Array.from(drawn(grab, factor)).forEach((value, index) =>
      expect(Array.from(saved(baked))[index]).toBeCloseTo(value, 8));
  });

  it('leaves the structure centroid where it was, so a grab turns in place', () => {
    const grab = Mat4.fromArray(Mat4(), rotationBetween([0,0,-1], unit(-0.8, 0.4, -1)) as any, 0);
    const before = Vec3.transformMat4(Vec3(), Vec3.create(centre[0],centre[1],centre[2]), saved(placement));
    const after = Vec3.transformMat4(Vec3(), Vec3.create(centre[0],centre[1],centre[2]), drawn(grab, 2.2));
    Array.from(before).forEach((value, index) => expect(after[index]).toBeCloseTo(value, 9));
  });

  it('records the travel as the same placement offset it was drawing', () => {
    // The transient offset is applied outermost, in scene units; the saved
    // offset is the same world step in molecular radii. A release divides.
    const offset = [17, -6, 24];
    const moved = Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.create(offset[0],offset[1],offset[2])),
      drawn(Mat4.identity(), 1));
    const baked = { ...placement, translation: placement.translation.map((value, axis) => value + offset[axis] / radius) };
    Array.from(moved).forEach((value, index) => expect(Array.from(saved(baked))[index]).toBeCloseTo(value, 8));
  });

  it('moves the centroid by exactly the travel, and turns about the new one', () => {
    const offset = [17, -6, 24];
    const grab = Mat4.fromArray(Mat4(), rotationBetween([0,0,-1], unit(0.5, -0.3, -1)) as any, 0);
    const before = Vec3.transformMat4(Vec3(), Vec3.create(centre[0],centre[1],centre[2]), saved(placement));
    const after = Vec3.transformMat4(Vec3(), Vec3.create(centre[0],centre[1],centre[2]),
      Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.create(offset[0],offset[1],offset[2])), drawn(grab, 1.8)));
    Array.from(before).forEach((value, index) => expect(after[index]).toBeCloseTo(value + offset[index], 8));
  });

  it('changes only the placement, which the room lock never reads', () => {
    // room-lock.mjs builds its matrix from camera.view and camera.scale alone.
    // A grab writes neither, so the menu and the orb cannot move with it.
    const source = readFileSync(new URL('../../lab/browser-roundtrip/xr-manipulate.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/camera\s*\.\s*(view|scale)/u);
    const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const grabBody = viewer.slice(viewer.indexOf('function applyGrabDelta'), viewer.indexOf('async function bakeGrab'));
    // Reading camera.scale converts the pointer ray's units; the room lock
    // breaks only if a grab writes the camera, so assignment is what is barred.
    expect(grabBody).not.toMatch(/camera\s*\.\s*(view|scale|position|target)\s*=/u);
    expect(grabBody).not.toMatch(/camera\.setState|setProps/u);
  });

  it('wires the stick modifiers to the toolbar hover, the grip latch and the pick', () => {
    // Three of the controls fixes are one wiring each, and none of them can be
    // reached from a unit test: viewer.mjs runs only inside a session with a
    // live Mol* canvas. What is checkable here is that the modifier layer is
    // handed the signals the fixes depend on, and that the residue pick asks it
    // before selecting.
    const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const modifiers = viewer.slice(viewer.indexOf('stickModifiers = createStickModifiers('), viewer.indexOf('const stickClaimed'));
    // The toolbar's per-frame ray test, not select ownership, which is empty on
    // the frame the trigger goes down.
    expect(modifiers).toMatch(/isRayOnMenu:\s*hand\s*=>\s*immersiveSession\?\.isRayOnMenu\?\.\(hand\)/u);
    expect(modifiers).toMatch(/gripHeld:\s*hand\s*=>\s*xrManipulation\?\.gripHeld/u);
    expect(modifiers).toMatch(/scaleActive:\s*\(\)\s*=>\s*xrManipulation\?\.phase\?\.\(\)\s*===\s*'scale'/u);
    // A trigger held to push or yaw the structure is not a selection.
    const pick = viewer.slice(viewer.indexOf('function dispatchPresentationPick'), viewer.indexOf('function flushPendingPresentationPick'));
    expect(pick).toMatch(/stickModifiers\?\.engagedWithin\?\.\(undefined, pickHand\)/u);
    const click = viewer.slice(viewer.indexOf('canvas.interaction.click.subscribe'), viewer.indexOf('function contextLost'));
    expect(click).toMatch(/stickModifiers\?\.engagedWithin\?\.\(undefined, pickHand\)/u);
  });
});

describe('the grip that starts and ends a grab', () => {
  const gripped = (value:number, buttons = 0) => ({ buttons, source: { gamepad: { buttons: [{ value: 0 }, { value }] } } });

  it('needs a firm squeeze to start and a real opening to let go', () => {
    // A hand resting on a Touch controller reads 0.05 to 0.25, and a wrist
    // rotation spikes past 0.35. One threshold either drops grabs mid-gesture
    // or starts them by itself; two with a gap between them does neither.
    const latch = createGripLatch();
    expect(GRIP_ENGAGE).toBeGreaterThan(GRIP_RELEASE);
    expect(latch.read('right', gripped(0.25))).toBe(false);
    expect(latch.read('right', gripped(GRIP_ENGAGE - 0.01))).toBe(false);
    expect(latch.read('right', gripped(GRIP_ENGAGE))).toBe(true);
    // Held: everything above the release threshold keeps the structure.
    expect(latch.read('right', gripped(0.4))).toBe(true);
    expect(latch.read('right', gripped(GRIP_RELEASE))).toBe(true);
    expect(latch.read('right', gripped(GRIP_RELEASE - 0.01))).toBe(false);
    // And the hands are independent: one grip cannot latch the other.
    expect(latch.read('left', gripped(0.4))).toBe(false);
    expect(latch.holds('left')).toBe(false);
    latch.reset();
    expect(latch.holds('right')).toBe(false);
  });

  it('falls back to the bitmask for an input source with no gamepad', () => {
    // Hand tracking and the IWER emulator publish pointers with no gamepad at
    // all. Mol* has already thresholded those, so the bitmask is the answer.
    const latch = createGripLatch();
    expect(latch.read('right', { buttons: 2 })).toBe(true);
    expect(latch.read('right', { buttons: 0 })).toBe(false);
    expect(latch.read('right', undefined)).toBe(false);
  });
});

describe('scaling with one hand, a grip and a stick', () => {
  it('grows pushing forward, shrinks pulling back and undoes itself exactly', () => {
    // The one-hand stand-in for the two-grip scale, which needs a controller in
    // each hand: either hand alone can scale the structure.
    expect(oneHandScaleFactor(1, 1)).toBeCloseTo(Math.exp(ONE_HAND_SCALE_PER_SECOND), 6);
    expect(oneHandScaleFactor(1, 0.5)).toBeGreaterThan(1);
    expect(oneHandScaleFactor(-1, 0.5)).toBeLessThan(1);
    // Exponential, so a second up and a second back leave it the size it was.
    expect(oneHandScaleFactor(1, 1) * oneHandScaleFactor(-1, 1)).toBeCloseTo(1, 12);
    // It crosses the useful range in about two seconds without making a nudge
    // unusable: one frame at 72 Hz stays under three percent at full deflection.
    expect(oneHandScaleFactor(1, 1 / 72)).toBeLessThan(1.03);
    expect(oneHandScaleFactor(1, 2)).toBeGreaterThan(4);
  });

  it('is one for a resting stick, a stalled frame or a bad reading', () => {
    for (const args of [[0, 1], [1, 0], [1, -1], [NaN, 1], [1, NaN], [undefined, 1]] as any[])
      expect(oneHandScaleFactor(args[0], args[1])).toBe(1);
  });
});

describe('one controller trigger placement', () => {
  const pointer = (handedness: string, buttons = 1, origin = [0, 0, 0], direction = [0, 0, -1], axes = [0, 0, 0, 0]) =>
    ({ handedness, buttons, ray: { origin, direction }, axes });
  const harness = (over: Record<string, unknown> = {}) => {
    let clock = 0;
    const translations: number[][] = [], rotations: number[][] = [], starts: any[] = [], ends: any[] = [];
    const manipulation = createXrManipulation({
      triggerTargetDistance: () => 2,
      now: () => clock, record: () => {}, pulse: () => true,
      onTranslate: (delta: number[]) => translations.push(delta),
      onRotate: (delta: number[]) => rotations.push(delta),
      onGrabStart: (detail: any) => starts.push(detail), onGrabEnd: (detail: any) => ends.push(detail),
      ...over,
    });
    return { manipulation, translations, rotations, starts, ends, tick: (ms: number) => { clock += ms; } };
  };

  it('keeps unknown native ray aiming while suppressing origin travel and rebasing quality changes', () => {
    let clock = 0;
    const translations:number[][] = [];
    const manipulation = createXrManipulation({ now: () => clock, triggerTargetDistance: () => 4,
      onTranslate: (delta:number[]) => translations.push([...delta]), record: () => {}, pulse: () => true });
    const yaw = [Math.sin(0.1),0,-Math.cos(0.1)];
    const native = (x:number, tracking:'unknown'|'tracked-position', direction = [0,0,-1]) => ({
      handedness: 'right', buttons: 1, poseQualitySource: 'webxr', tracking,
      emulatedPosition: tracking === 'tracked-position' ? false : undefined,
      ray: { origin: [x,0,0], direction },
    });
    manipulation.update([native(0, 'unknown')]);
    clock = 300;
    manipulation.update([native(0.2, 'unknown')]);
    expect(translations).toEqual([]);
    clock += 14;
    manipulation.update([native(0.3, 'unknown', yaw)]);
    expect(translations.length).toBe(1); // Moving the aim still moves the held target.
    const aimed = translations.length;
    clock += 14;
    manipulation.update([native(0.3, 'tracked-position', yaw)]);
    expect(translations).toHaveLength(aimed); // Quality transition is a no-motion rebase.
    clock += 14;
    manipulation.update([native(0.31, 'tracked-position', yaw)]);
    expect(translations).toHaveLength(aimed + 1);
    expect(Math.hypot(...translations.at(-1)!)).toBeGreaterThan(0.02);
  });

  it('preserves position-compatible legacy ray snapshots with no quality field', () => {
    let clock = 0;
    const drag = createTriggerDrag({ now: () => clock, targetDistance: () => 4 });
    const legacy = (x:number) => ({ buttons: 1, ray: { origin: [x,0,0], direction: [0,0,-1] } });
    drag.read('right', legacy(0));
    clock = 300;
    expect(drag.read('right', legacy(0.2)).anchor[0]).toBeCloseTo(0.5);
  });

  it.each(['left', 'right'])('keeps a quick %s trigger tap as a residue pick', hand => {
    const h = harness();
    h.manipulation.update([pointer(hand)]);
    h.tick(100);
    h.manipulation.update([pointer(hand, 0)]);
    expect(h.starts).toEqual([]);
    expect(h.ends).toEqual([]);
    expect(h.manipulation.consumesPick(hand)).toBe(false);
  });

  it.each([0.5, 2, 12, 100])('keeps small hand and aim drift a tap at %s metres', depth => {
    for (const hand of ['left', 'right']) for (const motion of ['yaw', 'axial', 'lateral']) {
      const h = harness({ triggerTargetDistance: () => depth });
      h.manipulation.update([pointer(hand)]);
      for (const [ms, degrees, metres] of [[28, 0.1, 0.00065], [14, 0.15, 0.0008]]) {
        h.tick(ms);
        const angle = motion === 'yaw' ? degrees * Math.PI / 180 : 0;
        const origin = motion === 'axial' ? [0, 0, metres] : motion === 'lateral' ? [metres, 0, 0] : [0, 0, 0];
        h.manipulation.update([pointer(hand, 1, origin, [Math.sin(angle), 0, -Math.cos(angle)])]);
      }
      h.tick(14); h.manipulation.update([pointer(hand, 0)]);
      expect(h.starts).toEqual([]);
      expect(h.translations).toEqual([]);
      expect(h.ends).toEqual([]);
      expect(h.manipulation.consumesPick(hand)).toBe(false);
    }
  });

  it.each([0.5, 2, 12, 100])('admits intentional movement equally at %s metres and retains its ray gain', depth => {
    for (const motion of ['yaw', 'axial', 'lateral']) {
      const h = harness({ triggerTargetDistance: () => depth });
      const pose = (amount: number) => {
        const angle = motion === 'yaw' ? amount * Math.PI / 180 : 0;
        const origin = motion === 'axial' ? [0, 0, amount] : motion === 'lateral' ? [amount, 0, 0] : [0, 0, 0];
        return pointer('right', 1, origin, [Math.sin(angle), 0, -Math.cos(angle)]);
      };
      h.manipulation.update([pose(0)]);
      h.tick(28); h.manipulation.update([pose(motion === 'yaw' ? 0.5 : 0.01)]);
      expect(h.starts).toEqual([]);
      h.tick(14); h.manipulation.update([pose(motion === 'yaw' ? 1.1 : 0.02)]);
      expect(h.starts).toEqual([{ hand: 'right', kind: 'ray' }]);
      expect(h.translations).toEqual([]); // Admission rebases; no accumulated tap jump.
      h.tick(14); h.manipulation.update([pose(motion === 'yaw' ? 1.2 : 0.025)]);
      expect(h.translations).toHaveLength(1);
      if (motion === 'axial') expect(h.translations[0][2]).toBeCloseTo(0.005 * Math.max(TRIGGER_TRANSLATION_GAIN, depth / 0.5), 10);
      else if (motion === 'lateral') expect(h.translations[0][0]).toBeCloseTo(0.005 * TRIGGER_TRANSLATION_GAIN, 10);
      else expect(h.translations[0][0]).toBeCloseTo(depth * (Math.sin(1.2 * Math.PI / 180) - Math.sin(1.1 * Math.PI / 180)), 10);
      h.manipulation.update([pointer('right', 0)]);
      expect(h.ends).toHaveLength(1);
      expect(h.manipulation.consumesPick('right')).toBe(true);
    }
  });

  it('does not interpret recovered tracking, arm-model movement, or tracking jumps as drag intent', () => {
    let clock = 0;
    const drag = createTriggerDrag({ now: () => clock, targetDistance: () => 12 });
    const read = (origin: number[], direction = [0, 0, -1], tracking = 'tracked-position') => {
      clock += 14;
      return drag.read('right', { ...pointer('right', 1, origin, direction), poseQualitySource: 'webxr', tracking });
    };
    expect(read([0, 0, 0]).phase).toBe('pending');
    expect(read([1, 0, 0]).phase).toBe('pending'); // Raw jump is a rebase.
    expect(read([1.001, 0, 0]).phase).toBe('pending');
    drag.read('right', { buttons: 1 }); // A missing ray starts a fresh intent reference.
    expect(read([2, 0, 0], [0.1, 0, -1]).phase).toBe('pending');
    expect(read([3, 0, 0], [0.1, 0, -1], 'unknown').phase).toBe('pending');
    expect(read([3.1, 0, 0], [0.1, 0, -1], 'unknown').phase).toBe('pending');
    expect(read([3.1, 0, 0], [0.15, 0, -1], 'unknown').phase).toBe('drag'); // Aim works without tracked position.
  });

  it.each(['left', 'right'])('holds and carries with the %s controller, then commits once', hand => {
    const h = harness();
    h.manipulation.update([pointer(hand)]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer(hand)]);
    expect(h.starts).toEqual([{ hand, kind: 'ray' }]);
    expect(h.translations).toEqual([]);
    h.manipulation.update([pointer(hand, 1, [0.04, 0.03, 0.02])]);
    expect(h.translations).toHaveLength(1);
    [0.04, 0.03].forEach((value, axis) => expect(h.translations[0][axis]).toBeCloseTo(value * TRIGGER_TRANSLATION_GAIN, 10));
    expect(h.translations[0][2]).toBeCloseTo(0.02 * 4, 10); // Two-metre target, half-metre pull.
    expect(h.rotations).toEqual([]);
    h.manipulation.update([pointer(hand, 0)]);
    h.manipulation.update([pointer(hand, 0)]);
    expect(h.ends).toHaveLength(1);
    expect(h.manipulation.consumesPick(hand)).toBe(true);
    expect(h.manipulation.consumesPick(hand === 'left' ? 'right' : 'left')).toBe(false);
    // An immediately following deliberate tap gets a fresh pick intent.
    h.manipulation.update([pointer(hand)]);
    h.manipulation.update([pointer(hand, 0)]);
    expect(h.manipulation.consumesPick(hand)).toBe(false);
  });

  it('promotes by deliberate movement or stick use and rebases the first drag frame', () => {
    const h = harness();
    h.manipulation.update([pointer('left')]);
    h.manipulation.update([pointer('left', 1, [0.03, 0, 0])]);
    expect(h.starts).toHaveLength(1);
    expect(h.translations).toEqual([]); // No accumulated tap motion jumps on promotion.
    h.manipulation.update([pointer('left', 0)]);
    h.manipulation.update([pointer('right', 1, [0, 0, 0], [0, 0, -1], [0, 0, 0, -0.8])]);
    h.manipulation.update([pointer('right', 1, [0, 0, 0], [0, 0, -1], [0, 0, 0, -0.8])]);
    expect(h.starts).toHaveLength(2);
  });

  it('uses target depth to follow wrist aim as placement rather than molecule rotation', () => {
    const h = harness();
    h.manipulation.update([pointer('left')]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    const angle = 0.05;
    h.manipulation.update([pointer('left', 1, [0, 0, 0], [Math.sin(angle), 0, -Math.cos(angle)])]);
    expect(h.translations[0][0]).toBeCloseTo(2 * Math.sin(angle), 10);
    expect(h.rotations).toEqual([]);
  });

  it.each(['left', 'right'])('keeps the full amplified %s pull on a slow frame and becomes precise nearby', hand => {
    const h = harness({ triggerTargetDistance: () => 4 });
    h.manipulation.update([pointer(hand)]);
    h.tick(TRIGGER_HOLD_MS); h.manipulation.update([pointer(hand)]);
    h.tick(100); h.manipulation.update([pointer(hand, 1, [0, 0, 0.21])]);
    expect(h.translations[0][2]).toBeCloseTo(1.68, 10); // Previously discarded as >0.5m.
    h.tick(100); h.manipulation.update([pointer(hand, 1, [0, 0, 0.4])]);
    expect(h.translations.reduce((sum, delta) => sum + delta[2], 0)).toBeCloseTo(3.2, 10);
    const angle = 0.1;
    h.tick(14); h.manipulation.update([pointer(hand, 1, [0, 0, 0.4], [Math.sin(angle), 0, -Math.cos(angle)])]);
    // The target is now 1.2m from this controller, not the original 4m arc.
    expect(h.translations.at(-1)![0]).toBeCloseTo(1.2 * Math.sin(angle), 10);
    expect(h.rotations).toEqual([]);
  });

  it.each(['left', 'right'])('lets the %s hand regrab and pull through the controller plane without a near wall', hand => {
    let clock = 0, targetZ = -4;
    const ends: any[] = [];
    const manipulation = createXrManipulation({ now: () => clock, record() {}, pulse() {},
      triggerTargetDistance: (p: any) => moleculeGrabDistance(p.ray, { center: [0, 0, targetZ], radius: 0.2 }),
      onTranslate: (delta: number[]) => { targetZ += delta[2]; }, onGrabEnd: (end: any) => ends.push(end),
    });
    const frame = (z: number, buttons = 1, elapsed = 100) => {
      clock += elapsed; manipulation.update([pointer(hand, buttons, [0, 0, z])]);
    };
    frame(0); frame(0, 1, TRIGGER_HOLD_MS);
    for (const z of [0.1, 0.2, 0.3, 0.4]) frame(z);
    expect(targetZ).toBeCloseTo(-0.8, 10);
    frame(0.4, 0); expect(ends).toHaveLength(1);
    frame(0, 0); frame(0); frame(0, 1, TRIGGER_HOLD_MS);
    for (const z of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) frame(z);
    expect(targetZ).toBeCloseTo(0.7, 10);
    frame(0.6, 0); expect(ends).toHaveLength(2);
    // The controller is now inside the molecule, with its centre behind it.
    // Its forward envelope is still a usable grab target.
    frame(0.6); frame(0.6, 1, TRIGGER_HOLD_MS);
    expect(manipulation.phase()).toBe('grab');
  });

  it('rebases raw tracking loss and large raw jumps without discarding valid amplified travel', () => {
    const records: any[] = [];
    const h = harness({ triggerTargetDistance: () => 4, record: (_kind: string, detail: any) => records.push(detail) });
    h.manipulation.update([pointer('right')]);
    h.tick(TRIGGER_HOLD_MS); h.manipulation.update([pointer('right')]);
    h.manipulation.update([pointer('right', 1, [0, 0, 0.2])]);
    expect(h.translations[0][2]).toBeCloseTo(1.6, 10);
    h.manipulation.update([]);
    h.tick(14); h.manipulation.update([pointer('right', 1, [0, 0, 0.5])]);
    expect(h.translations).toHaveLength(1);
    h.manipulation.update([pointer('right', 1, [0, 0, 0.51])]);
    expect(h.translations.at(-1)![2]).toBeCloseTo(0.08, 10);
    h.manipulation.update([pointer('right', 1, [0, 0, 2])]);
    expect(h.translations).toHaveLength(2);
    expect(records).toContainEqual({ event: 'rebased', hand: 'right', reason: 'tracking-jump' });
    h.manipulation.update([pointer('right', 1, [0, 0, 2.01])]);
    expect(h.translations.at(-1)![2]).toBeCloseTo(0.08, 10);
  });

  it('keeps a menu-started or empty-space press blocked after its ray moves', () => {
    let onMenu = true, target: number | undefined = 2;
    const h = harness({ isRayOnMenu: () => onMenu, triggerTargetDistance: () => target });
    h.manipulation.update([pointer('left')]);
    onMenu = false;
    h.tick(1000);
    h.manipulation.update([pointer('left', 1, [0.1, 0, 0])]);
    expect(h.starts).toEqual([]);
    h.manipulation.update([pointer('left', 0)]);
    target = undefined;
    h.manipulation.update([pointer('left')]);
    target = 2;
    h.tick(1000);
    h.manipulation.update([pointer('left')]);
    expect(h.starts).toEqual([]);
  });

  it('yields a pending press to a toolbar claim received later in the frame', () => {
    let claimed = false;
    const h = harness({ isClaimed: () => claimed });
    h.manipulation.update([pointer('left')]);
    claimed = true;
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    claimed = false;
    h.manipulation.update([pointer('left')]);
    expect(h.starts).toEqual([]);
  });

  it('keeps the molecule target when the held ray later crosses the menu', () => {
    let onMenu = false;
    const h = harness({ isRayOnMenu: () => onMenu });
    h.manipulation.update([pointer('left')]);
    onMenu = true;
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    h.manipulation.update([pointer('left', 1, [0.02, 0, 0])]);
    expect(h.starts).toHaveLength(1);
    expect(h.translations[0][0]).toBeCloseTo(0.05, 10);
  });

  it('rebases after a missing tracked frame and cancels a controller that stays absent', () => {
    const h = harness();
    h.manipulation.update([pointer('left')]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    h.manipulation.update([]);
    expect(h.ends).toEqual([]);
    h.tick(15);
    h.manipulation.update([pointer('left', 1, [0.1, 0, 0])]);
    expect(h.translations).toEqual([]);
    h.manipulation.update([pointer('left', 1, [0.11, 0, 0])]);
    expect(h.translations[0][0]).toBeCloseTo(0.025, 10);
    h.manipulation.update([]);
    h.tick(TRIGGER_TRACKING_GRACE_MS + 1);
    h.manipulation.update([]);
    expect(h.ends).toHaveLength(1);
    h.tick(1000);
    h.manipulation.update([pointer('left', 1, [0.11, 0, 0])]);
    expect(h.starts).toHaveLength(1); // Tracking return while still down cannot reacquire.
    expect(h.manipulation.consumesPick('left')).toBe(true);
    h.manipulation.update([pointer('left', 0)]);
    expect(h.manipulation.consumesPick('left')).toBe(true);
    h.manipulation.update([pointer('left')]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    expect(h.starts).toHaveLength(2);
  });

  it.each(['left', 'right'])('freezes two-grip scale when the %s pose drops and rebases on return', missing => {
    const h = harness();
    const right = pointer('right', 2, [0.2, 0, 0]), left = pointer('left', 2, [-0.2, 0, 0]);
    h.manipulation.update([right]);
    h.manipulation.update([right, left]);
    h.manipulation.update([right, left]);
    h.manipulation.update([missing === 'left' ? right : left]);
    expect(h.translations).toEqual([]);
    h.manipulation.update([pointer('right', 2, [0.25, 0, 0]), pointer('left', 2, [-0.25, 0, 0])]);
    expect(h.translations).toEqual([]);
    h.manipulation.update([pointer('right', 2, [0.26, 0, 0]), pointer('left', 2, [-0.24, 0, 0])]);
    expect(h.translations[0][0]).toBeCloseTo(0.01, 10);
  });

  it.each(['pending', 'drag'])('cancels a %s trigger across a suspended frame loop and requires release', phase => {
    const h = harness();
    h.manipulation.update([pointer('left')]);
    if (phase === 'drag') {
      h.tick(TRIGGER_HOLD_MS);
      h.manipulation.update([pointer('left')]);
    }
    h.tick(MANIPULATION_FRAME_GAP_MS + 1);
    h.manipulation.update([pointer('left', 1, [0.15, 0, 0])]);
    expect(h.translations).toEqual([]);
    expect(h.manipulation.phase()).toBe('idle');
    h.manipulation.update([pointer('left')]);
    expect(h.starts).toHaveLength(phase === 'drag' ? 1 : 0);
    expect(h.manipulation.consumesPick('left')).toBe(true);
    h.manipulation.update([pointer('left', 0)]);
    h.manipulation.update([pointer('left')]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    expect(h.starts).toHaveLength(phase === 'drag' ? 2 : 1);
  });

  it('uses a bounded global guard when two trigger presses make click handedness ambiguous', () => {
    const h = harness();
    h.manipulation.update([pointer('left')]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left')]);
    h.manipulation.update([pointer('left'), pointer('right')]);
    expect(h.manipulation.pickAmbiguous()).toBe(true);
    h.manipulation.update([pointer('left', 0), pointer('right')]);
    const clickHand = h.manipulation.pickAmbiguous() ? undefined : 'right';
    expect(h.manipulation.consumesPick(clickHand)).toBe(true);
    h.tick(251);
    expect(h.manipulation.pickAmbiguous()).toBe(false);
    expect(h.manipulation.consumesPick('right')).toBe(false);
  });

  it('gives a simultaneous grip/trigger one owner and rebases on trigger release', () => {
    const h = harness();
    h.manipulation.update([pointer('left')]);
    h.tick(TRIGGER_HOLD_MS);
    h.manipulation.update([pointer('left', 3)]);
    h.manipulation.update([pointer('left', 3, [0.01, 0, 0])]);
    expect(h.translations).toHaveLength(1);
    expect(h.translations[0][0]).toBeCloseTo(0.025, 10);
    h.manipulation.update([pointer('left', 2, [0.01, 0, 0])]);
    expect(h.translations).toHaveLength(1);
    h.manipulation.update([pointer('left', 2, [0.02, 0, 0])]);
    expect(h.translations[1][0]).toBeCloseTo(0.01, 10);
    h.manipulation.update([pointer('left', 0)]);
    expect(h.ends).toHaveLength(1);
  });

  it('keeps a grip-first press precise when the trigger joins', () => {
    const h = harness();
    h.manipulation.update([pointer('right', 2)]);
    h.manipulation.update([pointer('right', 3, [0.02, 0, 0])]);
    expect(h.starts).toEqual([{ hand: 'right', kind: 'grip' }]);
    expect(h.translations[0][0]).toBeCloseTo(0.02, 10);
    expect(h.manipulation.triggerOwns('right')).toBe(false);
  });
});

describe('cancelled gestures stop the viewer thumbstick dispatch', () => {
  const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const viewerFunction = (name: string) => {
    const start = source.indexOf(`  function ${name}(`);
    return source.slice(start, source.indexOf('\n  }\n', start) + 5);
  };
  const cases = ['left', 'right'].flatMap(hand => [1, 2].flatMap(buttons =>
    ['frame-gap', 'missing-source'].map(cancellation => ({ hand, buttons, cancellation }))));

  it.each(cases)('stops $hand button $buttons after $cancellation and accepts a fresh gesture', ({ hand, buttons, cancellation }) => {
    let clock = 0, liveScale = 1;
    const retained: number[] = [], moves: string[] = [];
    const manipulation = createXrManipulation({
      now: () => clock, triggerTargetDistance: () => 2, record() {}, pulse() {},
      onGrabEnd: () => retained.push(liveScale),
    });
    const modifiers = createStickModifiers({
      now: () => clock, gripHeld: (name: string) => manipulation.gripHeld(name),
      scaleActive: () => manipulation.phase() === 'scale',
      triggerOwned: (name: string) => manipulation.triggerOwns(name),
      triggerDragging: (name: string) => manipulation.triggerPhase(name) === 'drag',
      requiresRelease: (name: string) => manipulation.requiresRelease(name),
    });
    const context = vm.createContext({
      xrManipulation: manipulation, stickModifiers: modifiers, STICK_MODE, oneHandScaleFactor, xrInputBlind: false, xrDeferredBake: undefined,
      POINTER_TRIGGER: 1, POINTER_GRIP: 2, naturalInput: undefined, xrButtons: undefined, talkCaption: undefined,
      lastTriggerHand: undefined, lastTriggerAt: 0, performance: { now: () => clock },
      triggerStickIntent: undefined, xrTransformBatchDepth: 0, xrTransformPending: false, applyInspectionTransform() {},
      xrInputSourceFor: () => undefined,
      applyGrabDelta: ({ scale }: { scale: number }) => { moves.push('scale'); liveScale *= scale; },
      applyStickTravel: () => moves.push('slide'), applyStickPush: () => moves.push('depth-yaw'),
    });
    vm.runInContext(['applyStickForHand', 'batchXrTransforms', 'updateXrManipulationNow', 'updateXrManipulation'].map(viewerFunction).join('\n'), context);
    context.xrThumbstick = createXrThumbstick({ hand: 'right', now: () => clock,
      onMove: (delta: any) => context.applyStickForHand('right', delta) });
    context.xrPushStick = createXrThumbstick({ hand: 'left', now: () => clock,
      onMove: (delta: any) => context.applyStickForHand('left', delta) });
    const frame = (elapsed: number, pressed: number | undefined, y = -1) => {
      clock += elapsed;
      context.updateXrManipulation(pressed === undefined ? [] : [{ handedness: hand, buttons: pressed,
        axes: [0, 0, 0, y], ray: { origin: [0, 0, 0], direction: [0, 0, -1] } }]);
    };
    frame(0, buttons, 0);
    frame(TRIGGER_HOLD_MS, buttons);
    frame(14, buttons);
    expect(moves).toContain(buttons === 1 ? 'depth-yaw' : 'scale');
    if (buttons === 2) expect(liveScale).toBeGreaterThan(1);
    if (cancellation === 'frame-gap') frame(MANIPULATION_FRAME_GAP_MS + 1, buttons);
    else { frame(14, undefined); frame(TRIGGER_TRACKING_GRACE_MS + 1, undefined); }
    expect(manipulation.phase()).toBe('idle');
    expect(manipulation.requiresRelease(hand)).toBe(true);
    expect(retained).toHaveLength(1);
    expect(liveScale).toBe(retained[0]);
    moves.length = 0;
    frame(14, buttons);
    frame(14, buttons);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.inert);
    expect(moves).toEqual([]);
    expect(liveScale).toBe(retained[0]);
    // Releasing the button under a still-pushed thumb must not turn a cancelled
    // resize into a bare-stick slide. Centre it before beginning another move.
    frame(14, 0);
    expect(manipulation.requiresRelease(hand)).toBe(false);
    expect(moves).toEqual([]);
    frame(14, 0, 0);
    frame(14, buttons, 0);
    frame(TRIGGER_HOLD_MS, buttons);
    frame(14, buttons);
    expect(manipulation.phase()).toBe('grab');
    expect(moves).toContain(buttons === 1 ? 'depth-yaw' : 'scale');
    if (buttons === 2) expect(liveScale).toBeGreaterThan(retained[0]);
    // The viewer must lend the cancellation latch to the modifiers, just as it
    // lends the analog grip latch and trigger ownership in this harness.
    expect(source).toMatch(/requiresRelease:\s*hand\s*=>\s*xrManipulation\?\.requiresRelease\?\.\(hand\)/u);
  });
});

describe('molecule target envelope and large/gentle scale response', () => {
  it('uses a forward sphere hit and refuses empty, behind and nonfinite targets', () => {
    const ray = { origin: [0, 0, 0], direction: [0, 0, -2] };
    expect(moleculeGrabDistance(ray, { center: [0.5, 0, -3], radius: 1 })).toBe(3);
    expect(moleculeGrabDistance(ray, { center: [2, 0, -3], radius: 1 })).toBeUndefined();
    expect(moleculeGrabDistance(ray, { center: [0, 0, 3], radius: 1 })).toBeUndefined();
    expect(moleculeGrabDistance(ray, { center: [0, 0, NaN], radius: 1 })).toBeUndefined();
  });

  it('gives full deflection a dramatic change while a quarter push stays gentle', () => {
    expect(oneHandScaleFactor(1, 1)).toBeGreaterThan(7);
    expect(oneHandScaleFactor(0.25, 1)).toBeLessThan(1.15);
    expect(oneHandScaleFactor(0.25, 1)).toBeGreaterThan(1.1);
    for (const y of [0.1, 0.25, 0.5, 1]) {
      expect(oneHandScaleFactor(y, 1) * oneHandScaleFactor(-y, 1)).toBeCloseTo(1, 12);
      const at30 = oneHandScaleFactor(y, 1 / 30) ** 30;
      const at72 = oneHandScaleFactor(y, 1 / 72) ** 72;
      expect(at30).toBeCloseTo(at72, 10);
    }
  });
});

describe('the actual viewer grab release preserves wearer placement', () => {
  function installGestureHelpers(source: string, context: any) {
    Object.assign(context, { AbortController, setTimeout, clearTimeout, now: () => performance.now(),
      sourceRecord: {}, visibleStage: undefined, gesturePivot: createGesturePivot(), focusPivotRequest: undefined,
      xrPlacementFollowup: undefined, talkCaption: undefined });
    context.state ??= { status: 'ready' };
    context.state.generation = 1;
    context.canvas.webgl ??= { isContextLost: false };
    context.canvas.webgl.xr = { session: {} };
    for (const name of ['pivotCenter', 'pivotBounds', 'gesturePivotContext', 'beginGesturePivot', 'invalidateGesturePivot',
      'gesturePivotCenter', 'grabPivotBounds', 'cancelXrPlacementFollowup', 'startXrPlacementFollowup']) {
      const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
      expect(start).toBeGreaterThan(0);
      const lineEnd = source.indexOf('\n', start);
      const end = source.slice(start, lineEnd).trimEnd().endsWith('}') ? lineEnd : source.indexOf('\n  }', start) + 4;
      vm.runInContext(source.slice(start, end), context);
    }
  }

  it('returns the applied room travel after clamping and returns no travel when refused', () => {
    const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  function applyGrabDelta(');
    const end = source.indexOf('\n  }\n', start) + 5;
    const inspectionState = createInspectionState();
    inspectionState.place({ scale: 1, translation: [PLACEMENT_MAX_TRANSLATION - 0.1, 0, 0] }, 'fixture');
    const context:any = vm.createContext({
      Mat4, Vec3, PLACEMENT_MAX_TRANSLATION, clampPlacementScale, GRAB_REJECTED,
      canManipulateNow: () => true,
      inspectionSnapshot: () => inspectionState.snapshot(),
      loadedSphere: () => ({ radius: 1 }),
      inspectionState, xrTransformBatchDepth: 0, xrTransformPending: false,
      canvas: { camera: { scale: 2 } },
      state: { status: 'ready' },
      grabScale: 1, grabOffset: undefined, grabRotation: undefined,
      applyInspectionTransform() {}, recordManipulation() {},
    });
    installGestureHelpers(source, context);
    vm.runInContext(source.slice(start, end), context);
    const applied = context.applyGrabDelta({ translation: [1, 0, 0] });
    expect(applied[0]).toBeCloseTo(0.2, 6);
    expect(context.grabOffset[0]).toBeCloseTo(0.1, 6);
    context.canManipulateNow = () => false;
    expect(context.applyGrabDelta({ translation: [1, 0, 0] })).toBeUndefined();
    expect(context.grabOffset[0]).toBeCloseTo(0.1, 6);
  });

  it('moves a held ray anchor by the viewer-applied stick delta', () => {
    const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  function applyStickAxis(');
    const end = source.indexOf('\n  function applyStickTravel', start);
    const pushStart = source.indexOf('  function applyStickPush(', end);
    const pushEnd = source.indexOf('\n  /**\n   * One hand\'s stick', pushStart);
    const offsets:any[] = [];
    const context:any = vm.createContext({
      Number, STICK_METRES_PER_SECOND: 1.8, STICK_DEGREES_PER_SECOND: 90,
      wearerAxes: () => ({ forward: [0,0,-1], up: [0,1,0] }),
      applyGrabDelta: () => [0,0,-0.2],
      xrManipulation: { offsetRayAnchor: (hand:string, delta:number[]) => offsets.push([hand, Array.from(delta)]) },
    });
    expect(start).toBeGreaterThan(0);
    expect(pushStart).toBeGreaterThan(end);
    vm.runInContext(`${source.slice(start, end)}\n${source.slice(pushStart, pushEnd)}`, context);
    context.applyStickPush({ x: 0, y: 1, seconds: 1 }, 'left');
    expect(offsets).toEqual([['left', [0, 0, -0.2]]]);
  });

  it('bounds held resizing to five times entry size while preserving wearer travel', () => {
    const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  function applyGrabDelta(');
    const end = source.indexOf('\n  }\n', start) + 5;
    expect(start).toBeGreaterThan(0);
    const inspectionState = createInspectionState();
    inspectionState.place({ scale: 4, translation: [9, 0, -9] }, 'fixture');
    const drawn: any[] = [];
    const context: any = vm.createContext({
      Mat4, Vec3, PLACEMENT_MAX_TRANSLATION, clampPlacementScale, roomEntry: { seat: { scale: 4 } },
      canManipulateNow: () => true,
      inspectionSnapshot: () => inspectionState.snapshot(),
      loadedSphere: () => ({ radius: 2 }),
      inspectionState, xrTransformBatchDepth: 0, xrTransformPending: false,
      canvas: { camera: { scale: 0.1 } },
      grabScale: 1, grabOffset: undefined, grabRotation: undefined,
      applyInspectionTransform: () => drawn.push({ scale: context.grabScale, offset: Array.from(context.grabOffset) }),
    });
    installGestureHelpers(source, context);
    vm.runInContext(source.slice(start, end), context);
    for (let step = 0; step < 3; step += 1) {
      context.applyGrabDelta({ translation: [0.4, 0, -0.4], scale: 2 });
    }
    expect(drawn.map(frame => frame.scale * 4)).toEqual([8, 16, 20]);
    const translation = inspectionState.snapshot().placement.translation.map((value: number, axis: number) => value + context.grabOffset[axis] / 2);
    expect(translation).toEqual([15, 0, -15]);
    expect(normalizePlacement({ scale: context.grabScale * 4, translation }).scale).toBe(20);
  });

  it.each([
    { outcome: 'clear', scaleFactor: 2 },
    { outcome: 'stale', scaleFactor: 2 },
    { outcome: 'failed', scaleFactor: 2 },
    { outcome: 'clear', scaleFactor: 1 },
    { outcome: 'clear', scaleFactor: 8 },
  ])('retains size, translation and viewpoint with $scaleFactor× scale and $outcome menu clearance', async ({ outcome, scaleFactor }) => {
    const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('  async function bakeGrab(');
    const end = source.indexOf('\n  }\n', start) + 5;
    expect(start).toBeGreaterThan(0);
    const inspectionState = createInspectionState();
    const original = { translation: [0.5, -0.2, -1.4], rotation: [10, 20, 30], scale: 1.2 };
    inspectionState.place(original, 'fixture');
    const offset = [2, -4, 6], radius = 20;
    const camera = { scale: 0.05, position: [0, 0, 80], target: [0, 0, 0] };
    const cameraBefore = structuredClone(camera);
    const requestedTranslation = original.translation.map((value, axis) => value + offset[axis] / radius);
    const cleared: any[] = [], records: any[] = [];
    let wearerOwns = false, context: any;
    context = vm.createContext({
      Mat4, Vec3, inspectionState, normalizePlacement, pivotPreservingTranslation, clampPlacementScale,
      inspectionSnapshot: () => inspectionState.snapshot(),
      rotationFromPlacement: (placement: any) => placementRotation(placement.rotation), rotationDegreesZYX: degreesZYX,
      pivotBounds: () => ({ baseCenter: [0, 0, 0], visibleCenter: [0, 0, 0], radius }),
      grabRotation: undefined, grabOffset: offset, grabScale: scaleFactor, busy: false, state: { status: 'ready' },
      canvas: { xr: { isPresenting: { value: true } }, webgl: { isContextLost: false }, camera },
      latestRoomPlacementPose: { labelViews: [{ eye: 'left' }, { eye: 'right' }] },
      // The old release path moved the molecule to make room for glass. A
      // deliberately different answer makes any return to that path visible.
      loadedSphere: () => ({ center: [0, 0, 0], radius }),
      resetViewPlacement: () => ({ translation: [8, 7, 6] }),
      syncInspectionPayload() {}, applyInspectionTransform() {},
      mutate: async (_kind: string, operation: () => void) => operation(),
      takeWearerPlacement: () => { wearerOwns = true; },
      componentLabels: { active: () => false },
      recordManipulation: (_kind: string, detail: any) => records.push(detail),
      clearHeldPlatePlacement: async (requested: any, options: any) => {
        expect(options.isCurrent()).toBe(true);
        expect(options.signal.aborted).toBe(false);
        expect(wearerOwns).toBe(true);
        expect(context.grabScale).toBe(1);
        expect(context.grabOffset).toBeUndefined();
        expect(requested.translation).toEqual(requestedTranslation);
        expect(requested.scale).toBeCloseTo(original.scale * scaleFactor, 10);
        cleared.push(options);
        if (outcome !== 'clear') throw Object.assign(Error(`menu ${outcome}`), { code: outcome === 'stale' ? 'FIT_STALE' : 'FIT_REFUSED' });
        return requested;
      },
    });
    installGestureHelpers(source, context);
    context.beginGesturePivot();
    vm.runInContext(source.slice(start, end), context);
    expect(await context.bakeGrab({ gesture: scaleFactor === 1 ? 'grip' : 'one-hand-scale' })).toBe(true);
    expect(inspectionState.snapshot().placement.translation).toEqual(requestedTranslation);
    expect(inspectionState.snapshot().placement.scale).toBeCloseTo(original.scale * scaleFactor, 10);
    original.rotation.forEach((value, axis) => expect(inspectionState.snapshot().placement.rotation[axis]).toBeCloseTo(value, 10));
    expect(camera).toEqual(cameraBefore);
    expect(cleared).toEqual([{ allowOffscreen: true, keepWearer: true, kind: 'retained-pose', announce: false,
      signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }]);
    expect(cleared[0].isCurrent(), 'completed followup relinquishes ownership').toBe(false);
    expect(records.some(record => record.event === 'menu-clearance-deferred')).toBe(outcome !== 'clear');
  });
});
