import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore Import-free natural-input adapter, shared with the browser XR layer.
import { attachNaturalInput, naturalRayFor, naturalGripFor, NATURAL_OWNER, PINCH_DRAG_METERS } from '../../lab/browser-roundtrip/natural-input.mjs';
// @ts-ignore The Vision Pro stand-in: transient sources and frames, no device.
import { createNaturalInputEmulator } from '../../lab/browser-roundtrip/natural-input-emulator.mjs';
// @ts-ignore The gesture machine the Quest grips already drive.
import { createXrManipulation, POINTER_GRIP } from '../../lab/browser-roundtrip/xr-manipulate.mjs';

const lab = (name:string) =>
  readFileSync(new URL(`../../lab/browser-roundtrip/${name}`, import.meta.url), 'utf8');

const forward = (x = 0) => ({ origin: [x, 1.4, 0], direction: [0, 0, -1] });

/** The adapter, the emulator and the real gesture machine, wired as the viewer wires them. */
function bridge({ onMenu = (_ray:any) => false }:{ onMenu?:(ray:any)=>boolean } = {}) {
  const emulator = createNaturalInputEmulator();
  const events:string[] = [];
  const rotations:number[][] = [], translations:number[][] = [], scales:number[] = [];
  const manipulation = createXrManipulation({
    onGrabStart: () => events.push('grab-start'),
    onRotate: (rotation:number[]) => rotations.push(rotation),
    onTranslate: (translation:number[]) => translations.push(translation),
    onScale: (scale:number) => scales.push(scale),
    onGrabEnd: (summary:{phase:string}) => events.push(`grab-end:${summary.phase}`),
    record: () => {}, pulse: () => false,
  });
  const picks:any[] = [];
  const adapter = attachNaturalInput({
    session: emulator.session,
    rayFor: (frame:any, source:any) => naturalRayFor(frame, source, emulator.space),
    gripFor: (frame:any, source:any) => naturalGripFor(frame, source, emulator.space),
    onMenu,
    pick: (entry:any) => picks.push(entry),
    // The viewer's own wiring: the adapter asks for a frame, and the merge
    // reads the pinch pointers back out of it.
    onDrive: () => manipulation.update(adapter.pointers()),
    record: () => {},
  });
  return { emulator, adapter, manipulation, picks, events, rotations, translations, scales,
    frame: () => adapter.frame(emulator.frame()) };
}

describe('a Vision Pro pinch reaches the molecule', () => {
  it('drives the same grab, turn and bake a Quest grip drives', () => {
    const scene = bridge();
    const pinch = scene.emulator.pinch({ ray: forward() });
    pinch.start();
    scene.frame();
    expect(scene.events).toEqual([]);
    // Past the drag threshold, so the pinch is carrying the structure.
    pinch.aimAt(forward(PINCH_DRAG_METERS * 3));
    scene.frame();
    expect(scene.events).toEqual(['grab-start']);
    expect(scene.manipulation.phase()).toBe('grab');
    expect(scene.manipulation.holds('right')).toBe(true);
    // A further reach carries the structure with the hand.
    pinch.aimAt(forward(0.3));
    scene.frame();
    expect(scene.translations.length).toBe(1);
    expect(scene.translations[0][0]).toBeCloseTo(0.3 - PINCH_DRAG_METERS * 3, 10);
    // A turn of the aim turns the structure.
    pinch.aimAt({ origin: [0.3, 1.4, 0], direction: [0.2, 0, -1] });
    scene.frame();
    expect(scene.rotations.length).toBe(1);
    pinch.select().end();
    scene.frame();
    expect(scene.events).toEqual(['grab-start', 'grab-end:grab']);
    expect(scene.manipulation.phase()).toBe('idle');
    expect(scene.picks.length).toBe(0);
  });

  it('scales from two pinches the way two grips do', () => {
    const scene = bridge();
    const left = scene.emulator.pinch({ ray: forward(-0.2) }).start();
    left.aimAt(forward(-0.3));
    scene.frame();
    expect(scene.manipulation.phase()).toBe('grab');
    const right = scene.emulator.pinch({ ray: forward(0.2) }).start();
    right.aimAt(forward(0.3));
    scene.frame();
    expect(scene.manipulation.phase()).toBe('scale');
    left.aimAt(forward(-0.6));
    right.aimAt(forward(0.6));
    scene.frame();
    expect(scene.scales.length).toBe(1);
    expect(scene.scales[0]).toBeGreaterThan(1);
  });

  it('picks on a tap and publishes a pointer whose grip a gamepadless source still reports', () => {
    const scene = bridge();
    const pinch = scene.emulator.pinch({ ray: forward(0.05) });
    pinch.start().select().end();
    scene.frame();
    expect(scene.picks.length).toBe(1);
    expect(scene.picks[0].ray.origin).toEqual([0.05, 1.4, 0]);
    expect(scene.manipulation.phase()).toBe('idle');
    const held = bridge();
    const drag = held.emulator.pinch({ ray: forward() }).start();
    drag.aimAt(forward(0.3));
    held.frame();
    expect(held.adapter.pointers()[0].buttons).toBe(POINTER_GRIP);
    expect(held.adapter.pointers()[0].source.gamepad).toBeUndefined();
  });

  it('gives a pinch that started on the menu nothing at all', () => {
    const scene = bridge({ onMenu: (ray:any) => ray.origin[0] > 0.5 });
    const pinch = scene.emulator.pinch({ ray: forward(0.9) }).start();
    expect(scene.adapter.owner(pinch.source)).toBe(NATURAL_OWNER.menu);
    pinch.aimAt(forward(0));
    scene.frame();
    pinch.select().end();
    scene.frame();
    expect(scene.events).toEqual([]);
    expect(scene.picks).toEqual([]);
    expect(scene.manipulation.phase()).toBe('idle');
  });
});

describe('the wiring that carries it', () => {
  it('is bound to the session and torn down with it', () => {
    const viewer = lab('viewer.mjs');
    expect(viewer).toContain("import { attachNaturalInput, naturalRayFor, naturalGripFor, transformNaturalPointer } from './natural-input.mjs';");
    expect(viewer).toContain('naturalInput = attachNaturalInput({');
    expect(viewer).toContain('naturalInput?.dispose(); naturalInput = undefined;');
    // The frame hook is the only clock the adapter has.
    expect(viewer).toContain('naturalInput?.frame(frame)');
    expect(viewer).toContain('latestXrSpace = space;');
  });

  it('merges pinch pointers into the gesture machine and nothing else', () => {
    const viewer = lab('viewer.mjs');
    const merge = viewer.slice(viewer.indexOf('function updateXrManipulation'));
    expect(merge).toContain('const natural = naturalInput?.pointers?.() ?? [];');
    // Naturals go last, so a granted hand on the same side cannot outrank the
    // pinch that is actually holding the structure.
    expect(merge).toContain('[...(pointers ?? []), ...natural.map(pointer => transformNaturalPointer(pointer, xrRenderPose))]');
    expect(merge).toContain('const sourced = manipulated.map(');
    expect(merge).toContain('xrManipulation.update(sourced)');
    // The face buttons, both sticks and the trigger modifier keep reading only
    // what Mol* published, because a pinch has no gamepad for them to read.
    for (const reader of ['xrButtons?.update(pointers ?? [])', 'stickModifiers?.update(pointers ?? [])',
      'xrThumbstick?.update(pointers ?? [])', 'xrPushStick?.update(pointers ?? [])']) {
      expect(merge).toContain(reader);
    }
  });

  it('runs the pick through the viewer\'s own dispatch, by ray', () => {
    const viewer = lab('viewer.mjs');
    const pick = viewer.slice(viewer.indexOf('function pickAlongRay'));
    expect(pick).toContain('Ray3D.create(');
    // The same inverse-view move Mol* makes for a controller ray, so both aims
    // are read against one pick pass.
    expect(pick).toContain('Ray3D.transform(scene, scene, Mat4.invert(Mat4(), canvas.camera.view))');
    expect(pick).toContain('canvas.identify(scene)');
    expect(pick).toContain('dispatchPresentationPick({ button: XR_TRIGGER_BUTTON');
  });

  it('asks the menu itself whether a ray started on its currently drawn glass', async () => {
    const toolbar = lab('spatial-toolbar.mjs');
    expect(toolbar).toContain('isRayOnPanel: ray => {');
    const session = lab('immersive-session.mjs');
    expect(session).toContain('isRayOnPanel: ray => active?.toolbar?.isRayOnPanel?.(ray) === true');
    const viewer = lab('viewer.mjs');
    expect(viewer).toContain('onMenu: ray => immersiveSession?.isRayOnPanel?.(ray) === true');
    // Run the shipped toolbar/input logic, with only Mol*'s GPU boundary stubbed.
    // @ts-ignore Browser test fixture is shared with the Node menu regressions.
    const { toolbarFrameRuntime, toolbarFrameHarness, identity } = await import('../../lab/browser-roundtrip/fixtures/toolbar-frame-runtime.mjs');
    const runtime = await toolbarFrameRuntime();
    const h = toolbarFrameHarness(runtime, { presentation: { setRoomOffset() {} } });
    try {
      await h.toolbar.update();
      const original = h.toolbar.menuRows()[0][0];
      const origin = [0, 1.6, 0], matrix = [...identity];
      original.forEach((v: number, i: number) => { matrix[8 + i] = -(v - origin[i]); });
      const position = { x: 0, y: 1.6, z: 0 };
      const source = { handedness: 'right', targetRaySpace: { pose: { emulatedPosition: false,
        transform: { matrix, position: { ...position } } } },
        gripSpace: { pose: { emulatedPosition: false, transform: { position } } } };
      const rayAt = (point: number[]) => ({ origin: [...origin], direction: point.map((v, i) => v - origin[i]) });
      expect(h.toolbar.isRayOnPanel(rayAt(original))).toBe(true);
      h.session.inputSources = [source];
      h.session.dispatchEvent(Object.assign(new Event('squeezestart'), { inputSource: source, frame: h.frame }));
      position.x = -.4; h.toolbar.syncInput(h.frame);
      const drawn = h.toolbar.menuRows()[0][0];
      expect(Math.hypot(...drawn.map((v: number, i: number) => v - original[i]))).toBeGreaterThan(.4);
      expect(h.toolbar.isRayOnPanel(rayAt(drawn))).toBe(true);
      expect(h.toolbar.isRayOnPanel(rayAt(original))).toBe(false);
      const scene = bridge({ onMenu: ray => h.toolbar.isRayOnPanel(ray) });
      try {
        const pinch = scene.emulator.pinch({ ray: rayAt(drawn) }); pinch.start(); scene.frame();
        expect(scene.adapter.owner(pinch.source)).toBe(NATURAL_OWNER.menu);
        expect(scene.events).toEqual([]);
      } finally { scene.adapter.dispose(); }
    } finally { await h.toolbar.dispose(); }
  });

  it('leaves the controller and hand paths where they were', () => {
    const source = lab('natural-input.mjs');
    // The one gate: everything in the adapter is behind a transient pointer.
    expect(source).toContain("source.targetRayMode === TRANSIENT_RAY_MODE");
    for (const entry of ['selectStart', 'select', 'selectEnd']) {
      expect(source).toContain(`if (!isNaturalInputSource(source))`);
      expect(source).toContain(entry);
    }
    // No hand joints are read anywhere: denied hand tracking must cost
    // nothing; gripSpace is provided independently of the hand-joint permission. (`gesture.hand` is
    // a slot name in the gesture machine, not a tracked hand.)
    expect(source).toContain('source.gripSpace');
    for (const joint of ['source.hand', 'jointSpace', 'getJointPose', '.gamepad']) {
      expect(source).not.toContain(joint);
    }
  });
});
