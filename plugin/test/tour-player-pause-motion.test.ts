import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// @ts-ignore Production viewer closures with renderer boundaries stubbed.
import { tourFocusHarness } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';
// @ts-ignore Extract the shipped reset routes.
import { pageFunction } from '../../lab/browser-roundtrip/fixtures/label-action-harness.mjs';
import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
import { applyTourCommand, createPanelTourController } from '../src/inspection-tour-client.js';
// @ts-ignore Production player DOM boundary; no browser/GPU work.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const tour: Tour = { id: 'motion-pause', title: 'Motion pause', summary: '', presentation: { captionCard: 'shown', end: 'hold' },
  steps: [
    { id: 'orbit', title: 'Orbit', durationMs: 20_000, motion: { kind: 'orbit', axis: 'y', degrees: 100, seconds: 2 } },
    { id: 'dolly', title: 'Dolly', durationMs: 20_000, motion: { kind: 'dolly', metres: 1, seconds: 2 } },
  ] };
function harness() {
  const h = tourEndHarness({ xr: true });
  let angle = 0, zoom = 1, source = 'same';
  const originalSnapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...originalSnapshot(), sourceSha256: source });
  const move = vi.fn(async (value: any) => { if (value.kind === 'orbit') angle += value.degrees; else zoom *= value.factor; });
  h.workspace.viewer.inspection.applyLessonMotion = move;
  h.workspace.viewer.inspection.bakeLessonMotion = vi.fn();
  const events = new Map<string, () => void>();
  document.addEventListener = ((name: string, listener: () => void) => { events.set(name, listener); }) as any;
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { ...h, player, move, angle: () => angle, zoom: () => zoom, source: (value: string) => { source = value; },
    visibility: (hidden: boolean) => { Object.assign(document, { hidden }); events.get('visibilitychange')!(); },
  };
}

for (const route of ['toggle', 'command', 'visibility'] as const) it(`${route}: suspends authored motion and resumes only its remaining time`, async () => {
  vi.useFakeTimers();
  const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500);
    const held = h.angle(); expect(held).toBeGreaterThan(0); expect(held).toBeLessThan(100);
    if (route === 'toggle') await h.player.togglePlay();
    else if (route === 'command') await applyTourCommand(h.player, { action: 'pause' });
    else h.visibility(true);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: false, step: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.angle()).toBe(held);
    if (route === 'toggle') await h.player.togglePlay();
    else if (route === 'command') await applyTourCommand(h.player, { action: 'play' });
    else h.visibility(false);
    expect(h.player.getState()).toMatchObject({ autoplay: true, motionRunning: true, step: 0 });
    await vi.advanceTimersByTimeAsync(1450);
    expect(h.angle()).toBeGreaterThan(held); expect(h.angle()).toBeLessThan(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.angle()).toBeCloseTo(100, 8);
    expect(h.player.getState().motionRunning).toBe(false);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('retains dolly progress through repeated pauses without reapplying the completed factor', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 1);
    for (let cycle = 0; cycle < 3; cycle++) {
      await vi.advanceTimersByTimeAsync(400);
      h.player.pause(); const held = h.zoom();
      await vi.advanceTimersByTimeAsync(5000); expect(h.zoom()).toBe(held);
      await h.player.togglePlay();
    }
    await vi.advanceTimersByTimeAsync(800);
    expect(h.zoom()).toBeCloseTo(0.8, 8); expect(h.player.getState().motionRunning).toBe(false);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

for (const action of ['next', 'done', 'select', 'replace', 'source'] as const) it(`${action} discards suspended motion before later Play`, async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500); h.player.pause();
    const held = h.angle();
    if (action === 'next') await h.player.next();
    else if (action === 'done') await h.player.finish();
    else if (action === 'select') await h.player.select(tour.id);
    else if (action === 'replace') await h.player.replaceTours([tour]);
    else h.source('other');
    await vi.advanceTimersByTimeAsync(1000); expect(h.angle()).toBe(held);
    if (action === 'next' || action === 'source') {
      await h.player.togglePlay(); await vi.advanceTimersByTimeAsync(1000); expect(h.angle()).toBe(held);
    } else expect(h.player.getState()).toMatchObject({ active: false, motionRunning: false });
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('manual XR edits keep the lesson active and its held placement until an explicit rejoin', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500); h.player.pause();
    await h.workspace.viewer.inspection.place({ scale: 3 }); h.player.notifyMutation(h.workspace.snapshot());
    const held = h.angle(), before = h.capture();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.angle()).toBe(held); expect(h.capture()).toEqual(before);
    expect(h.player.getState()).toMatchObject({ stopped: false, active: true, motionRunning: false });
    // Rejoin is the explicit request to restore the chapter. Its animation
    // starts a fresh visit instead of reviving the old visit's remainder.
    await h.player.rejoin(false); await vi.advanceTimersByTimeAsync(500);
    expect(h.angle() - held).toBeCloseTo(6.25, 8);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('suspends a held chapter while hidden without enabling autoplay, and honors a manual pause', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    await vi.advanceTimersByTimeAsync(500); h.visibility(true);
    const held = h.angle(); await vi.advanceTimersByTimeAsync(5000); expect(h.angle()).toBe(held);
    h.visibility(false);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: true });
    await vi.advanceTimersByTimeAsync(500); h.player.pause(); h.player.pause();
    h.visibility(true); await vi.advanceTimersByTimeAsync(5000); h.visibility(false);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: false });
    await h.player.togglePlay(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.angle()).toBeCloseTo(100, 8);
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('a manual pause while hidden cancels the automatic motion resume', async () => {
  vi.useFakeTimers(); const h = harness();
  try {
    await h.player.select(tour.id); await h.player.start(true, 0);
    await vi.advanceTimersByTimeAsync(500); h.visibility(true); h.player.pause();
    const held = h.angle(); h.visibility(false); await vi.advanceTimersByTimeAsync(5000);
    expect(h.angle()).toBe(held);
    expect(h.player.getState()).toMatchObject({ autoplay: false, motionRunning: false });
  } finally { h.player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('the headset tour row pauses and resumes molecular time while animation-only pause leaves the tour running',async()=>{
  const {createPlaybackClock}=await import('../../packages/motion/src/keyframes.mjs');
  vi.useFakeTimers();
  const h=tourEndHarness({xr:true});let clock:ReturnType<typeof createPlaybackClock>|undefined;
  const installed=vi.fn(async(animation:any,chapterId:string)=>{
    if(animation) expect(chapterId).toBe('walk');clock=animation?createPlaybackClock(animation.durationSeconds,animation.playback):undefined;
  });
  h.workspace.viewer.inspection.setMolecularAnimation=installed;
  h.workspace.viewer.inspection.controlMolecularAnimation=(patch:any)=>clock?.patch(patch,performance.now());
  const animation={version:1 as const,durationSeconds:10,playback:{autoplay:true,loop:true},tracks:[{id:'head',chains:['A'],keyframes:[{t:0,translation:[0,0,0],rotation:[0,0,0,1]}]}]};
  const lesson:Tour={id:'animated',title:'Animated',summary:'',steps:[{id:'walk',title:'Walk',durationMs:20000,animation}]};
  const player=mountTourPlayer({...h,tours:[lesson]});
  try {
    await player.select(lesson.id);await player.start(true,0);
    expect(installed).toHaveBeenCalledWith(animation,'walk', expect.objectContaining({ context: undefined, frame: true, framing: undefined }));
    clock!.sample(performance.now());
    h.workspace.viewer.inspection.controlMolecularAnimation({state:'pause'});
    expect(player.getState().autoplay).toBe(true);
    expect(clock!.snapshot().state).toBe('paused');
    // This is the same togglePlay used by the headset tour row.
    await player.togglePlay();expect(player.getState().autoplay).toBe(false);
    const time=clock!.snapshot().timeSeconds;
    expect(clock!.sample(performance.now()+5000).timeSeconds).toBe(time);
    await player.togglePlay();expect(clock!.snapshot().state).toBe('playing');
    player.pause();expect(clock!.snapshot().state).toBe('paused');
  }finally{player.pause();h.cleanup();vi.useRealTimers();}
});

for (const autoplay of [true,false]) it(`visibility leaves independent animation intent intact with tour autoplay=${autoplay}`,async()=>{
  vi.useFakeTimers(); const h=harness();
  let intent='paused';
  const control=vi.fn((patch:any)=>{if(patch.state)intent=patch.state==='play'?'playing':'paused';});
  h.workspace.viewer.inspection.controlMolecularAnimation=control;
  try {
    await h.player.select(tour.id); await h.player.start(autoplay,0);
    control({state:autoplay?'pause':'play'}); control.mockClear();
    const before=intent;
    h.visibility(true); await vi.advanceTimersByTimeAsync(1000); h.visibility(false);
    expect(intent).toBe(before); expect(control).not.toHaveBeenCalled();
    expect(h.player.getState().autoplay).toBe(autoplay);
  }finally{h.player.pause();h.cleanup();vi.useRealTimers();}
});

for (const agent of [false, true]) it(`${agent ? 'agent' : 'wearer'} Reset bakes a carried cameraSpin despite held placement`, async () => {
  vi.useFakeTimers();
  const h = harness(), view = tourFocusHarness(), page = view.h;
  const panel = createPanelTourController(h.player, { ...h.player,
    getState: () => ({ ...h.player.getState(), active: false, tours: [] }) });
  panel.setDefault(true);
  const carried: Tour = { ...tour, steps: [{ id: 'carried', title: 'Carried', durationMs: 60_000,
    cameraSpin: { axis: [0, 1, 0], degrees: 90, seconds: 8, delaySeconds: 0, easing: 'linear' } }] };
  const seat = { translation: [0, 0, -2], rotation: [0, 0, 0], scale: 1, roomPoint: [0, 0, -2], metersAcross: 1 };
  const notify = () => h.player.notifyMutation(h.workspace.snapshot(), { agent });
  h.workspace.viewer.inspection.holdsWearerPlacement = () => view.hold.holdsPlacement();
  Object.assign(page, { spatialTour: panel, roomAnchor: null, roomAnchorPlacement: () => seat,
    showHeadsetCaption() {}, notePlacement() {}, retainedPoseHidden: true,
    showRetainedPose: () => { page.retainedPoseHidden = false; },
    releaseWearerPlacement: () => view.hold.release('reset-view'),
    setInspectionMotion: vi.fn(async () => { notify(); }),
    mutate: async (_kind: string, action: () => void) => { action(); notify(); },
  });
  const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  for (const name of ['seatStructureForEntry', 'runFaceAction', 'recenterInspection', 'resetOrientation'])
    vm.runInContext(pageFunction(source, name), page);
  try {
    await h.player.replaceTours([carried]); await h.player.select(carried.id);
    view.hold.takeover('grab');
    await h.player.start(false, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.angle()).toBeGreaterThan(0);
    if (agent) await page.recenterInspection(); else await page.resetOrientation();
    expect(page.retainedPoseHidden).toBe(false);
    expect(view.snapshot().placement).toEqual({ translation: seat.translation, rotation: seat.rotation, scale: seat.scale });
    expect(page.setInspectionMotion).toHaveBeenCalledWith({ paused: true });
    expect(h.workspace.viewer.inspection.bakeLessonMotion).toHaveBeenCalledTimes(1);
    expect(h.player.getState().motionRunning).toBe(false);
    const angle = h.angle(), placement = view.snapshot().placement;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.angle()).toBe(angle); expect(view.snapshot().placement).toEqual(placement);
  } finally { h.player.pause(); panel.dispose(); h.cleanup(); vi.useRealTimers(); }
});
