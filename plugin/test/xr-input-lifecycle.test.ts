import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// @ts-ignore Shared production modules.
import { createXrControllerInput } from '../../lab/browser-roundtrip/xr-controller-input.mjs';
// @ts-ignore Shared production modules.
import { createXrInputReleaseGate, createXrPlacementLifecycle } from '../../lab/browser-roundtrip/xr-input-release.mjs';
// @ts-ignore Shared production modules.
import { createXrManipulation, oneHandScaleFactor, GRIP_TRACKING_GRACE_MS, TRIGGER_TRACKING_GRACE_MS, MANIPULATION_FRAME_GAP_MS } from '../../lab/browser-roundtrip/xr-manipulate.mjs';
// @ts-ignore Shared production modules.
import { createXrButtons, createXrThumbstick } from '../../lab/browser-roundtrip/xr-buttons.mjs';
// @ts-ignore Shared production modules.
import { createStickModifiers, STICK_MODE } from '../../lab/browser-roundtrip/xr-locomotion.mjs';
// @ts-ignore Shared production gesture ownership.
import { createGesturePivot } from '../../lab/browser-roundtrip/gesture-pivot.mjs';

const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const session = readFileSync(new URL('../../lab/browser-roundtrip/immersive-session.mjs', import.meta.url), 'utf8');
function fn(text: string, name: string) {
  const start = text.includes(`  async function ${name}(`) ? text.indexOf(`  async function ${name}(`) : text.indexOf(`  function ${name}(`);
  if (start < 0) throw Error(`Missing production function ${name}`);
  const lineEnd = text.indexOf('\n', start);
  return text.slice(start, text.slice(start, lineEnd).trimEnd().endsWith('}') ? lineEnd : text.indexOf('\n  }\n', start) + 5);
}
type Quality = 'tracked' | 'emulated' | 'null';
function harness(hand: string) {
  let clock = 0, position = 0, scale = 1;
  const saved: { position: number; scale: number }[] = [], actions: string[] = [], moves: number[] = [];
  const controller = { handedness: hand, targetRayMode: 'tracked-pointer', targetRaySpace: {}, gripSpace: {},
    gamepad: { axes: [0,0,0,0], buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })) } };
  const c: any = vm.createContext({ console, Set, Map, Math, Boolean,
    hostLoadDepth: 0, activeWork: undefined, xrInputBlind: false, xrDeferredGrab: undefined, xrDeferredBake: undefined, xrInputLifecycle: createXrPlacementLifecycle(), xrAimUnavailable: false, xrInputHeld: false, manualXrInputHeld: false,
    grabRotation: undefined, grabScale: 1, grabOffset: undefined,
    triggerStickIntent: undefined, xrTransformBatchDepth: 0, xrTransformPending: false, applyInspectionTransform() {},
    xrInputRelease: createXrInputReleaseGate({ now: () => clock }),
    canvas: { xr: { isPresenting: { value: false } }, webgl: { xr: { session: { inputSources: [controller] } } } },
    pointerManipulates: () => false, spatialOwnedHands: new Set(), syncPresentationMotion() {},
    state: { status: 'ready' }, recordManipulation() {}, bakeGrab: async () => { saved.push({ position, scale }); c.grabOffset = undefined; c.grabScale = 1; },
    STICK_MODE, oneHandScaleFactor, POINTER_TRIGGER: 1, POINTER_GRIP: 2,
    naturalInput: undefined, talkCaption: undefined, lastTriggerHand: undefined, lastTriggerAt: 0,
    performance: { now: () => clock }, xrInputSourceFor: () => controller,
    applyGrabDelta: ({ scale: factor }: { scale: number }) => { scale *= factor; c.grabScale *= factor; },
    applyStickTravel: () => { position += .01; c.grabOffset = [position,0,0]; },
    applyStickPush: () => { position += .01; c.grabOffset = [position,0,0]; },
  });
  const manipulation = createXrManipulation({ now: () => clock, triggerTargetDistance: () => 2, pulse() {}, record() {},
    onTranslate: (delta: number[]) => { position += delta[0]; moves.push(delta[0]); c.grabOffset = [position,0,0]; },
    onGrabEnd: (summary: any) => { if (c.xrInputBlind) c.xrDeferredGrab = summary; else void c.bakeGrab(summary); },
  });
  c.xrManipulation = manipulation;
  c.xrButtons = createXrButtons({ now: () => clock, run: (action: string) => actions.push(action), pulse() {}, record() {} });
  c.stickModifiers = createStickModifiers({ now: () => clock, gripHeld: manipulation.gripHeld,
    scaleActive: () => manipulation.phase() === 'scale', triggerOwned: manipulation.triggerOwns,
    triggerDragging: (name: string) => manipulation.triggerPhase(name) === 'drag', requiresRelease: manipulation.requiresRelease });
  vm.runInContext(['handleXrInputVisibility', 'flushXrDeferredGrab', 'applyStickForHand', 'batchXrTransforms', 'updateXrManipulationNow', 'updateXrManipulation', 'processXrPointers'].map(name => fn(viewer, name)).join('\n'), c);
  c.xrThumbstick = createXrThumbstick({ hand: 'right', now: () => clock, onMove: (d: any) => c.applyStickForHand('right', d) });
  c.xrPushStick = createXrThumbstick({ hand: 'left', now: () => clock, onMove: (d: any) => c.applyStickForHand('left', d) });
  const record = { toolbar: { blur() {} }, pushToTalk: { cancel() { c.talkCancellations = (c.talkCancellations ?? 0) + 1; } } };
  Object.assign(c, { active: record, sessionVisibility: 'visible', onInputVisibility: c.handleXrInputVisibility,
    getSpatialTour: () => undefined, recordXrFrameError: (_phase: string, error: Error) => { throw error; } });
  vm.runInContext(fn(session, 'applyVisibilityTransition'), c);
  const input = createXrControllerInput();
  const pose = (quality: Quality, x: number) => quality === 'null' ? null : { emulatedPosition: quality === 'emulated',
    transform: { position: { x, y: 0, z: 0 }, orientation: { x:0,y:0,z:0,w:1 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1] } };
  const frame = (elapsed: number, buttons: number, quality: Quality = 'tracked', x = 0, y = 0, gripQuality = quality) => {
    clock += elapsed;
    for (const [index, bit] of [[0,1],[1,2],[3,4],[4,8],[5,16]]) {
      controller.gamepad.buttons[index] = { pressed: Boolean(buttons & bit), value: buttons & bit ? 1 : 0 };
    }
    controller.gamepad.axes[3] = y;
    if (c.xrInputBlind) return;
    c.flushXrDeferredGrab();
    const pointers = input.read({ predictedDisplayTime: clock, getPose: (space: object) => pose(space === controller.gripSpace ? gripQuality : quality, x) }, {}, c.canvas.webgl.xr.session);
    c.processXrPointers(pointers);
  };
  const visibility = (blind: boolean, hidden = false) => c.applyVisibilityTransition(record, { to: blind ? hidden ? 'hidden' : 'visible-blurred' : 'visible', blind,
    cancelTalk: blind, diagnostic: { kind: 'xr-visibility', detail: {} } });
  return { c, frame, visibility, manipulation, moves, saved, actions, value: () => ({ position, scale }) };
}

const hands = ['left', 'right'];
const gestures = hands.flatMap(hand => [1,2].map(button => ({ hand, button })));
describe('native controller tracking and focus lifecycle', () => {
  it.each(gestures)('rebases $hand button $button through measured, computed, missing and measured poses', ({ hand, button }) => {
    const h = harness(hand);
    h.frame(0, button); h.frame(220, button); h.frame(14, button, 'tracked', .01);
    const retained = h.value(); expect(retained.position).toBeGreaterThan(0);
    h.frame(14, button, 'emulated', .5); h.frame(14, button, 'emulated', .8);
    h.frame(14, button, 'null'); h.frame(100, button, 'tracked', 1.2);
    expect(h.value()).toEqual(retained); // No inferred travel or return jump.
    h.frame(14, button, 'tracked', 1.21);
    expect(h.value().position).toBeGreaterThan(retained.position);
    h.frame(14, 0); expect(h.manipulation.phase()).toBe('idle'); expect(h.saved).toHaveLength(1);
    h.frame(14, 2, 'emulated', 1.21); h.frame(14, 2, 'emulated', 1.21, -1); h.frame(100, 2, 'emulated', 1.21, -1);
    expect(h.value().scale).toBeGreaterThan(1);
  });

  it.each(gestures)('cancels long null poses for $hand button $button, then admits a fresh resize', ({ hand, button }) => {
    const h = harness(hand);
    h.frame(0, button); h.frame(220, button); h.frame(14, button, 'tracked', .01);
    h.frame(14, button, 'null');
    const grace = button === 2 ? GRIP_TRACKING_GRACE_MS : TRIGGER_TRACKING_GRACE_MS;
    // Native frames keep arriving with an independently reported button. This
    // exercises the pose timeout, not a suspended-frame-loop cancellation.
    for (let elapsed = 0; elapsed < grace;) {
      const step = Math.min(100, grace - elapsed); h.frame(step, button, 'null'); elapsed += step;
    }
    expect(h.manipulation.requiresRelease(hand)).toBe(false);
    h.frame(1, button, 'null');
    const retained = h.value(); expect(h.manipulation.requiresRelease(hand)).toBe(true); expect(h.saved).toHaveLength(1);
    h.frame(14, button, 'tracked', 1); expect(h.value()).toEqual(retained); expect(h.manipulation.phase()).toBe('idle');
    h.frame(14, 0); h.frame(14, 2, 'null'); h.frame(14, 2, 'null', 0, -1); h.frame(100, 2, 'null', 0, -1);
    expect(h.manipulation.requiresRelease(hand)).toBe(false); expect(h.value().scale).toBeGreaterThan(retained.scale);
  });

  it.each(hands)('freezes and resumes a present %s controller grip after 600ms pose loss without regripping', hand => {
    const h = harness(hand);
    h.frame(0, 2); h.frame(14, 2, 'tracked', .01);
    const retained = h.value(), moves = h.moves.length;
    h.frame(14, 2, 'null');
    for (let i = 0; i < 3; i++) h.frame(200, 2, 'null');
    expect(h.manipulation.phase()).toBe('grab');
    expect(h.manipulation.requiresRelease(hand)).toBe(false);
    expect(h.value()).toEqual(retained); expect(h.saved).toEqual([]);
    h.frame(14, 2, 'tracked', 1);
    expect(h.value()).toEqual(retained); expect(h.moves).toHaveLength(moves);
    h.frame(14, 2, 'tracked', 1.01);
    expect(h.value().position).toBeCloseTo(retained.position + .01, 10);
    expect(h.moves).toHaveLength(moves + 1);
    h.frame(14, 0, 'tracked', 1.01);
    expect(h.manipulation.phase()).toBe('idle'); expect(h.saved).toHaveLength(1);
  });

  it.each(hands)('a suspended frame loop still cancels a present %s grip before its longer pose timeout', hand => {
    const h = harness(hand);
    h.frame(0, 2); h.frame(14, 2, 'tracked', .01);
    const retained = h.value();
    h.frame(MANIPULATION_FRAME_GAP_MS + 1, 2, 'tracked', .3);
    expect(h.manipulation.requiresRelease(hand)).toBe(true);
    expect(h.manipulation.phase()).toBe('idle'); expect(h.value()).toEqual(retained);
    expect(h.saved).toEqual([retained]);
  });

  for (const gap of [200, 600]) it.each(gestures)(`cancels $hand button $button across ${gap}ms system blur without losing placement`, async ({ hand, button }) => {
    const h = harness(hand);
    h.frame(0, button); h.frame(220, button); h.frame(14, button, 'tracked', .01);
    const retained = h.value(); h.visibility(true, gap > 500); h.visibility(true, gap > 500);
    expect(h.manipulation.phase()).toBe('idle'); expect(h.saved).toHaveLength(0);
    h.frame(gap, button, 'tracked', .3); h.visibility(false); h.frame(14, button, 'tracked', .5, -1);
    await h.c.xrDeferredBake;
    expect(h.value()).toEqual(retained); expect(h.saved).toEqual([retained]); expect(h.c.xrInputRelease.blocksPick(hand)).toBe(true);
    h.frame(14, button, 'tracked', .6, -1); expect(h.value()).toEqual(retained); expect(h.saved).toHaveLength(1);
    // The button and stick both have to rest; release under a deflected stick stays inert.
    h.frame(14, 0, 'tracked', .6, -1); expect(h.value()).toEqual(retained);
    h.frame(14, 0, 'tracked', .6); h.frame(260, 0, 'tracked', .6);
    expect(h.c.xrInputRelease.blocksPick(hand)).toBe(false); expect(h.manipulation.requiresRelease(hand)).toBe(false);
    h.frame(14, 2, 'emulated', .6); h.frame(14, 2, 'emulated', .6, -1); h.frame(100, 2, 'emulated', .6, -1);
    expect(h.value().scale).toBeGreaterThan(retained.scale); expect(h.actions).toEqual([]);
  });

  it.each(hands)('drains held menu/talk on %s without firing on focus return', hand => {
    for (const button of [8,16]) {
      const h = harness(hand); h.frame(0, button); h.visibility(true); h.frame(200, button);
      h.visibility(false); h.frame(14, button); h.frame(200, button); h.frame(14, 0);
      expect(h.actions).toEqual([]);
      h.frame(300, button); h.frame(button === 8 ? 160 : 60, button); h.frame(14, 0);
      expect(h.actions).toEqual(button === 8 ? ['push-to-talk', 'push-to-talk'] : ['menu']);
    }
  });


  it.each(hands)('retains the %s release gate through missing samples and drains its release pick', hand => {
    let clock = 0;
    const gate = createXrInputReleaseGate({ now: () => clock });
    const source = { handedness: hand };
    gate.suspend([source]);
    expect(gate.filter([])).toEqual([]);
    expect(gate.filter([], [source])).toEqual([]);
    clock = 2000;
    expect(gate.blocksPick(hand)).toBe(true);
    const pressed = { handedness: hand, buttons: 1, axes: [0,0,0,0] };
    expect(gate.filter([pressed], [source])).toEqual([]);
    const neutral = { ...pressed, buttons: 0 };
    expect(gate.filter([neutral], [source])).toEqual([neutral]);
    expect(gate.blocksPick(hand)).toBe(true);
    clock += 251; expect(gate.blocksPick(hand)).toBe(false);
    gate.suspend([source]); gate.filter([], []); expect(gate.blocksPick(hand)).toBe(false);
    gate.suspend([source]); gate.reset(); expect(gate.blocksPick(hand)).toBe(false);
  });

  it('keeps new input out until the preserved placement bake settles', async () => {
    const h = harness('right'); h.frame(0, 2); h.frame(14, 2, 'tracked', .01);
    const retained = h.value(), originalBake = h.c.bakeGrab;
    let finish!: () => void;
    h.c.bakeGrab = async () => { await new Promise<void>(resolve => { finish = resolve; }); await originalBake(); };
    h.visibility(true); h.frame(200, 2); h.visibility(false); h.frame(14, 2, 'tracked', .5);
    const pending = h.c.xrDeferredBake; expect(pending).toBeTruthy();
    h.frame(14, 0); h.frame(14, 2, 'tracked', .8, -1); h.frame(100, 2, 'tracked', .9, -1);
    expect(h.value()).toEqual(retained); expect(h.saved).toEqual([]); expect(h.manipulation.phase()).toBe('idle');
    finish(); await pending; expect(h.saved).toEqual([retained]);
    h.frame(14, 2, 'tracked', 1, -1); expect(h.value()).toEqual(retained);
    h.frame(14, 0); h.frame(14, 2); h.frame(14, 2, 'tracked', 0, -1); h.frame(100, 2, 'tracked', 0, -1);
    expect(h.value().scale).toBeGreaterThan(retained.scale);
  });

  it('actual session teardown releases the gate without letting an old completion clear a new save', async () => {
    const h = harness('right'); h.frame(0, 2); h.frame(14, 2, 'tracked', .01);
    let finish!: () => void;
    h.c.bakeGrab = () => new Promise<void>(resolve => { finish = resolve; });
    h.visibility(true); h.visibility(false); h.frame(14, 2);
    const oldWork = h.c.xrDeferredBake, oldLifecycle = h.c.xrInputLifecycle;
    Object.assign(h.c, { xrControllerInput: undefined, latestXrSpace: undefined,
      gesturePivot: createGesturePivot(), focusPivotRequest: undefined, xrPlacementFollowup: undefined,
      setTalkOutcomeSink() {}, setTalkProgressSink() {}, detachConnectionMenu: undefined, tuneXrLocomotion() {} });
    vm.runInContext(['cancelXrPlacementFollowup', 'invalidateGesturePivot', 'endXrManipulation'].map(name => fn(viewer, name)).join('\n'), h.c);
    h.c.endXrManipulation();
    expect(oldLifecycle.ended).toBe(true); expect(h.c.xrDeferredBake).toBeUndefined();
    expect(h.c.xrInputRelease.blocksPick('right')).toBe(false);
    const nextWork = Promise.resolve(); h.c.xrDeferredBake = nextWork;
    h.c.xrInputLifecycle = createXrPlacementLifecycle();
    finish(); await oldWork;
    expect(h.c.xrDeferredBake).toBe(nextWork); expect(h.c.xrInputLifecycle.ended).toBe(false);
  });

  it('stops the same input frame when a release starts saving placement', () => {
    const h = harness('left'); let laterInput = 0;
    h.c.xrManipulation = { update() { h.c.xrDeferredBake = Promise.resolve(); } };
    h.c.xrButtons = { update(_pointers: any, options: any) { expect(options.releaseOnly).toBe(true); } };
    h.c.xrPushStick = { resetTimer() {}, update() { laterInput++; } };
    h.c.updateXrManipulation([]);
    h.c.applyStickForHand('left', { y: -1, seconds: .1 });
    expect(laterInput).toBe(0); expect(h.value()).toEqual({ position: 0, scale: 1 });
  });

  it.each(hands)('closes %s talk exactly once during a pending placement and drains new face actions', async hand => {
    const h = harness(hand); h.frame(0, 8); h.frame(160, 8);
    expect(h.actions).toEqual(['push-to-talk']);
    let finish!: () => void;
    h.c.bakeGrab = () => new Promise<void>(resolve => { finish = resolve; });
    h.c.xrDeferredGrab = { phase: 'stick' }; h.c.flushXrDeferredGrab();
    const pending = h.c.xrDeferredBake;
    h.frame(14, 8); expect(h.actions).toHaveLength(1);
    h.frame(14, 0); h.frame(14, 0); expect(h.actions).toEqual(['push-to-talk', 'push-to-talk']);
    h.frame(14, 16); h.frame(600, 16); h.frame(14, 0);
    h.frame(14, 8); h.frame(600, 8);
    expect(h.actions).toHaveLength(2); expect(h.c.xrDeferredBake).toBe(pending);
    finish(); await pending;
    h.frame(14, 8); h.frame(14, 0); expect(h.actions).toHaveLength(2);
    h.frame(300, 8); h.frame(160, 8); h.frame(14, 0); expect(h.actions).toHaveLength(4);
  });

  it.each(hands)('cancels an active %s recording on blur without restarting a held button', hand => {
    const h = harness(hand); h.frame(0, 8); h.frame(160, 8);
    expect(h.actions).toEqual(['push-to-talk']);
    h.visibility(true); expect(h.c.talkCancellations).toBe(1);
    h.visibility(false); h.frame(14, 8); h.frame(600, 8); h.frame(14, 0);
    expect(h.c.talkCancellations).toBe(1); expect(h.actions).toEqual(['push-to-talk']);
    h.frame(300, 8); h.frame(160, 8); h.frame(14, 0);
    expect(h.actions).toEqual(['push-to-talk', 'push-to-talk', 'push-to-talk']);
  });

  it.each(hands)('keeps a measured aim from substituting for a missing %s grip', hand => {
    const h = harness(hand); h.frame(0, 2); h.frame(14, 2, 'tracked', .01);
    const retained = h.value(); h.frame(14, 2, 'tracked', .5, 0, 'null'); h.frame(100, 2, 'tracked', 1);
    expect(h.value()).toEqual(retained); h.frame(14, 2, 'tracked', 1.01);
    expect(h.value().position).toBeGreaterThan(retained.position);
  });
});

describe('host loads preempt molecular input',()=>{
  it.each(gestures)('cancels $hand button $button, pauses motion and requires neutral input before another gesture',async({hand,button})=>{
    const h=harness(hand);
    Object.assign(h.c,{mouseHeld:true,touchHeld:true,inputInteraction:true,
      cancelXrPlacementFollowup(){},invalidateGesturePivot(){},createXrPlacementLifecycle,
      molecularAnimation:{revision:()=>0,control(){},resume(){},halt(){h.c.halted=true;},async settled(){}},motionToolPaused:false,
    });
    vm.runInContext(fn(viewer,'prepareHostLoad'),h.c);
    h.frame(0,button);h.frame(220,button);h.frame(14,button,'tracked',.02);
    expect(h.manipulation.phase()).not.toBe('idle');
    const lifecycle=h.c.xrInputLifecycle;
    const release=await h.c.prepareHostLoad();
    expect(lifecycle.ended).toBe(true);
    expect(h.c.xrInputLifecycle.ended).toBe(false);
    expect(h.manipulation.phase()).toBe('idle');
    expect(h.c.halted).toBe(true);expect(h.c.motionToolPaused).toBe(true);
    expect([h.c.mouseHeld,h.c.touchHeld,h.c.inputInteraction,h.c.xrInputHeld]).toEqual([false,false,false,false]);
    expect(h.c.grabOffset).toBeUndefined();expect(h.c.grabScale).toBe(1);
    h.frame(14,button,'tracked',.3);expect(h.manipulation.phase()).toBe('idle');
    release();release();expect(h.c.hostLoadDepth).toBe(0);
    h.frame(14,button,'tracked',.4);expect(h.manipulation.phase()).toBe('idle');
    h.frame(14,0,'tracked',.4);h.frame(260,0,'tracked',.4);
    expect(h.saved).toEqual([]);
    h.frame(14,button,'tracked',.4);h.frame(240,button,'tracked',.42);
    expect(h.manipulation.phase()).not.toBe('idle');
  });
  it('cancels a two-handed scale without baking it into the replacement',async()=>{
    const h=harness('right');
    Object.assign(h.c,{mouseHeld:false,touchHeld:false,inputInteraction:false,cancelXrPlacementFollowup(){},invalidateGesturePivot(){},
      createXrPlacementLifecycle,molecularAnimation:{revision:()=>0,control(){},resume(){},halt(){},async settled(){}}});
    vm.runInContext(fn(viewer,'prepareHostLoad'),h.c);
    const pointer=(handedness:string,x:number)=>({handedness,buttons:2,emulatedPosition:false,
      ray:{origin:[x,0,0],direction:[0,0,-1],orientation:[0,0,0,1]},
      grip:{origin:[x,0,0],direction:[0,0,-1],orientation:[0,0,0,1]}});
    h.c.xrManipulation.update([pointer('left',-.2),pointer('right',.2)]);
    h.c.xrManipulation.update([pointer('left',-.2),pointer('right',.21)]);
    expect(h.manipulation.phase()).toBe('scale');
    const release=await h.c.prepareHostLoad();
    expect(h.manipulation.phase()).toBe('idle');expect(h.saved).toEqual([]);release();
  });
});
