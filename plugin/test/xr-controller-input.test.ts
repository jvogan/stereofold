import { describe, expect, it } from 'vitest';
// @ts-ignore Shared browser adapter, sampled only from active XR callbacks.
import { createXrControllerInput } from '../../lab/browser-roundtrip/xr-controller-input.mjs';
// @ts-ignore Production button and stick readers.
import { createXrButtons, createXrThumbstick } from '../../lab/browser-roundtrip/xr-buttons.mjs';
// @ts-ignore Production modifiers and manipulation state.
import { createStickModifiers, STICK_MODE } from '../../lab/browser-roundtrip/xr-locomotion.mjs';
// @ts-ignore Shared gesture state machine.
import { createXrManipulation, createTriggerDrag, TRIGGER_HOLD_MS } from '../../lab/browser-roundtrip/xr-manipulate.mjs';

const pose = (emulatedPosition: boolean | undefined, x = 0) => ({ emulatedPosition,
  transform: { position: { x, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
    matrix: [1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1] } });
type TestSource = { handedness: string; targetRayMode: string; targetRaySpace: object; gripSpace: object | null;
  gamepad: { axes: number[]; buttons: { pressed: boolean; value: number }[] } };
const source = (handedness: string): TestSource => ({ handedness, targetRayMode: 'tracked-pointer', targetRaySpace: {}, gripSpace: null,
  gamepad: { axes: [0,0,0,0], buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })) } });

describe('controller snapshots with reduced position tracking', () => {
  it.each(['left', 'right'])('retains %s menu and reset controls without a target-ray or grip pose', hand => {
    let clock = 0;
    const controller = source(hand), actions: string[] = [];
    const input = createXrControllerInput();
    const buttons = createXrButtons({ now: () => clock, run: (action: string) => actions.push(action), pulse() {} });
    const sample = () => buttons.update(input.read({ predictedDisplayTime: clock, getPose: () => null }, {}, { inputSources: [controller] }));
    sample(); clock = 20; controller.gamepad.buttons[5].pressed = true; sample();
    clock = 70; controller.gamepad.buttons[5].pressed = false; sample();
    expect(actions).toEqual(['menu']);
    clock = 400; controller.gamepad.buttons[3].pressed = true; sample();
    expect(actions).toEqual(['menu', 'recenter-structure']);
  });

  it('samples each XR timestamp once and preserves pose quality without retaining a pose', () => {
    const controller = source('right'), records: any[] = [];
    const input = createXrControllerInput({ record: (_kind: string, detail: any) => records.push(detail) });
    let reads = 0;
    const frame = { predictedDisplayTime: 10, getPose: () => { reads++; return pose(true); } };
    const session = { inputSources: [controller] };
    expect(input.read(frame, {}, session)[0]).toMatchObject({ emulatedPosition: true, tracking: 'emulated-position' });
    expect(input.read({ ...frame }, {}, session)).toBeUndefined();
    expect(reads).toBe(1);
    expect(input.read({ ...frame, predictedDisplayTime: 20, getPose: () => null }, {}, session)[0]).toMatchObject({ ray: undefined, tracking: 'unavailable' });
    expect(records.map(record => record.tracking)).toEqual(['emulated-position', 'unavailable']);
  });

  it('keeps the target ray and grip transform separate and reports grip-space quality', () => {
    const controller = source('right'), raySpace = controller.targetRaySpace, gripSpace = {};
    controller.gripSpace = gripSpace;
    const target = pose(false, 1), grip = pose(true, 2);
    const input = createXrControllerInput({ transformPose: (value: any) => ({ ...value,
      origin: value.origin.map((coordinate: number) => coordinate + 10) }) });
    const [pointer] = input.read({ predictedDisplayTime: 5,
      getPose: (space: object) => space === raySpace ? target : space === gripSpace ? grip : null }, {}, { inputSources: [controller] });
    expect(pointer.ray.origin).toEqual([11, 10, 10]);
    expect(pointer.gripPose.origin).toEqual([12, 10, 10]);
    expect(pointer.gripPose.direction[0]).toBeCloseTo(0);
    expect(pointer.gripPose.direction[1]).toBeCloseTo(0);
    expect(pointer.gripPose.direction[2]).toBeCloseTo(-1);
    expect(pointer.gripPose.emulatedPosition).toBe(true);
    expect(pointer.emulatedPosition).toBe(false);
    expect(pointer.gripEmulatedPosition).toBe(true);
    expect(pointer.hasGripSpace).toBe(true);
    expect(pointer.poseQualitySource).toBe('webxr');
    expect(pointer.tracking).toBe('tracked-position');
    expect(pointer.gripTracking).toBe('emulated-position');
  });

  it('marks native unknown ray and grip quality explicitly', () => {
    const controller = source('right'); controller.gripSpace = {};
    const raySpace = controller.targetRaySpace, gripSpace = controller.gripSpace;
    const input = createXrControllerInput();
    const [pointer] = input.read({ predictedDisplayTime: 5,
      getPose: (space: object) => space === raySpace ? pose(undefined) : space === gripSpace ? pose(undefined) : null },
    {}, { inputSources: [controller] });
    expect(pointer).toMatchObject({ poseQualitySource: 'webxr', tracking: 'unknown', gripTracking: 'unknown' });
    expect(pointer.emulatedPosition).toBeUndefined();
    expect(pointer.gripPose.emulatedPosition).toBeUndefined();
  });

  it('records grip-quality changes even when target-ray quality stays measured', () => {
    const controller = source('right'); controller.gripSpace = {};
    const raySpace = controller.targetRaySpace, gripSpace = controller.gripSpace;
    const records: any[] = [];
    const input = createXrControllerInput({ record: (_kind: string, detail: any) => records.push(detail) });
    const sample = (predictedDisplayTime: number, gripEmulated: boolean) => input.read({ predictedDisplayTime,
      getPose: (space: object) => space === raySpace ? pose(false) : space === gripSpace ? pose(gripEmulated) : null },
    {}, { inputSources: [controller] });
    sample(10, true);
    sample(20, false);
    expect(records).toEqual([
      expect.objectContaining({ tracking: 'tracked-position', gripTracking: 'emulated-position' }),
      expect.objectContaining({ tracking: 'tracked-position', gripTracking: 'tracked-position' }),
    ]);
  });

  it('does not invent a grip transform when gripSpace exists but its pose is absent', () => {
    const controller = source('right'); controller.gripSpace = {};
    const input = createXrControllerInput();
    const [pointer] = input.read({ predictedDisplayTime: 6,
      getPose: (space: object) => space === controller.gripSpace ? null : pose(false, 1) }, {}, { inputSources: [controller] });
    expect(pointer.ray.origin).toEqual([1, 0, 0]);
    expect(pointer.hasGripSpace).toBe(true);
    expect(pointer.gripPose).toBeUndefined();
  });

  it.each(['left', 'right'])('moves depth and resizes with a stationary emulated %s controller', hand => {
    let clock = 0;
    const input = createXrControllerInput(), controller = source(hand), moves: string[] = [];
    const manipulation = createXrManipulation({ now: () => clock, triggerTargetDistance: () => 4, record() {}, pulse() {} });
    const modifiers = createStickModifiers({ now: () => clock,
      gripHeld: (name: string) => manipulation.gripHeld(name), triggerOwned: (name: string) => manipulation.triggerOwns(name),
      triggerDragging: (name: string) => manipulation.triggerPhase(name) === 'drag', scaleActive: () => manipulation.phase() === 'scale' });
    const stick = createXrThumbstick({ hand, now: () => clock, onMove: () => moves.push(modifiers.mode(hand)) });
    const sample = (elapsed: number) => {
      clock += elapsed;
      const pointers = input.read({ predictedDisplayTime: clock, getPose: () => pose(true) }, {}, { inputSources: [controller] });
      manipulation.update(pointers); modifiers.update(pointers); stick.update(pointers);
    };
    sample(0);
    controller.gamepad.buttons[0].pressed = true;
    sample(20); sample(TRIGGER_HOLD_MS);
    controller.gamepad.axes[3] = 1; sample(14);
    expect(moves).toContain(STICK_MODE.depthYaw);
    controller.gamepad.axes[3] = 0; sample(14);
    controller.gamepad.buttons[1] = { pressed: true, value: 1 }; sample(14);
    controller.gamepad.axes[3] = -1; sample(14);
    expect(moves.at(-1)).toBe(STICK_MODE.scale);
  });

  it('ignores computed hand travel and rebases when measured tracking returns', () => {
    let clock = 0;
    const drag = createTriggerDrag({ now: () => clock, targetDistance: () => 4 });
    const pointer = (x: number, emulatedPosition: boolean) => ({ buttons: 1, emulatedPosition, ray: { origin: [x,0,0], direction: [0,0,-1] } });
    drag.read('right', pointer(0, true)); clock = 300;
    expect(drag.read('right', pointer(.2, true)).anchor).toEqual([0,0,-4]);
    clock += 14;
    expect(drag.read('right', pointer(.3, false))).toMatchObject({ anchor: [0,0,-4], rebased: 'tracking-mode' });
    clock += 14;
    expect(drag.read('right', pointer(.31, false)).anchor[0]).toBeCloseTo(.025);
  });

  it('shortens the held ray after a stick pull without replaying that translation', () => {
    let clock = 0;
    const translations: number[][] = [];
    const manipulation = createXrManipulation({ now: () => clock, triggerTargetDistance: () => 4,
      onTranslate: (v: number[]) => translations.push(v), pulse() {}, record() {} });
    const pointer = (direction = [0,0,-1]) => ({ handedness: 'right', buttons: 1, emulatedPosition: true,
      ray: { origin: [0,0,0], direction } });
    manipulation.update([pointer()]); clock = 300; manipulation.update([pointer()]);
    manipulation.offsetRayAnchor('right', [0,0,3]);
    clock += 14; manipulation.update([pointer()]);
    expect(translations).toEqual([]);
    clock += 14; manipulation.update([pointer([Math.sin(.1), 0, -Math.cos(.1)])]);
    expect(translations[0][0]).toBeCloseTo(Math.sin(.1));
  });

  it('freezes a missing aim, cancels a long loss, and leaves new pose-less stick controls available', () => {
    let clock = 0;
    const translations: number[][] = [], ends: any[] = [];
    const manipulation = createXrManipulation({ now: () => clock, onTranslate: (v: number[]) => translations.push(v),
      onGrabEnd: (v: any) => ends.push(v), pulse() {}, record() {} });
    const pointer = (buttons: number, x?: number) => ({ handedness: 'right', buttons,
      ray: x === undefined ? undefined : { origin: [x,0,0], direction: [0,0,-1] } });
    manipulation.update([pointer(2,0)]);
    clock = 10; manipulation.update([pointer(2)]);
    clock = 100; manipulation.update([pointer(2,.2)]);
    expect(translations).toEqual([]);
    clock = 120; manipulation.update([pointer(2)]);
    clock = 400; manipulation.update([pointer(2)]);
    expect(manipulation.requiresRelease('right')).toBe(true); expect(ends).toHaveLength(1);
    clock = 410; manipulation.update([pointer(0)]);
    clock = 420; manipulation.update([pointer(2)]);
    expect(manipulation.requiresRelease('right')).toBe(false);
    expect(manipulation.phase()).toBe('idle'); expect(manipulation.gripHeld('right')).toBe(true);
  });

  it('uses orientation without inferred grip translation or two-hand span scale', () => {
    const translations: any[] = [], scales: number[] = [], rotations: any[] = [];
    const manipulation = createXrManipulation({ onTranslate: (v: any) => translations.push(v), onScale: (v: number) => scales.push(v), onRotate: (v: any) => rotations.push(v), pulse() {}, record() {} });
    const pointer = (handedness: string, x: number, direction = [0,0,-1]) => ({ handedness, buttons: 2, emulatedPosition: true, ray: { origin: [x,0,0], direction } });
    manipulation.update([pointer('right', 0)]);
    manipulation.update([pointer('right', .1, [.2,0,-1])]);
    expect(translations).toEqual([]); expect(rotations).toHaveLength(1);
    manipulation.update([pointer('right', .2), pointer('left', -.2)]);
    manipulation.update([pointer('right', .4), pointer('left', -.4)]);
    expect(manipulation.phase()).toBe('grab'); expect(scales).toEqual([]); expect(translations).toEqual([]);
  });
});
