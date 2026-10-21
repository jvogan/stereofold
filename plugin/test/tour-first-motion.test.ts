import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Tour } from '../src/tour-player.js';
// @ts-ignore Shared production playback clock and keyframe evaluator.
import { createPlaybackClock, evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
// @ts-ignore Real player DOM and diagnostics; GPU/I/O costs are adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// Also runs against an unmodified source copy to measure the scheduling delta.
const { mountTourPlayer } = await import(process.env.FIRST_MOTION_PLAYER ?? '../src/tour-player.js');
it.each([{atomic:false,scale:1},{atomic:true,scale:1},{atomic:true,scale:.5}])('first animated chapter phase costs: $atomic, cost scale $scale; waits for draw and save', async ({atomic,scale}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness();
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const animation = JSON.parse(readFileSync(new URL('../demos/kinesin-walk/motion.json', import.meta.url), 'utf8')).chapters[0].animation;
  const lesson: Tour = { id: 'first-motion', title: 'Motion first', summary: '', steps: [
    { id: 'walk', title: 'Walk', durationMs: 30000, animation, figure: { layers: [], labels: [], distances: [] } },
  ] };
  let preparation: Promise<void> | undefined, toolbarDrawn = false, saved = false, saveWaiting = false;
  let clears = 0;
  let movingAt = -1, installedAt = -1, releaseSave: () => void = () => {};
  const prepare = () => preparation ??= sleep(628 * scale);
  // Devcheck-7 costs: 2,383 chapter paint = 888 caption + 193 emphasis
  // + 1,302 figure (542 construction, 760 draw/publication). Animation 667.
  // Independent asynchronous phases overlap; these are scheduling, not GPU timings.
  h.workspace.viewer.xr = { refreshToolbar: async () => { await sleep(888 * scale); toolbarDrawn = true; } };
  Object.assign(h.workspace.viewer.inspection, {
    emphasize: async () => { await sleep(193 * scale); },
    setLessonFigure: async () => { await sleep(1302 * scale); },
    prepareMolecularAnimation: prepare,
    setMolecularAnimation: async (value: unknown, _chapter?: string, options?: any) => {
      if (!value) { clears++; return; }
      await prepare(); await sleep(667 * scale); await options?.beforeReveal;
      expect(toolbarDrawn).toBe(true); installedAt = performance.now();
      // Detect actual head displacement using the shipped walk and evaluator,
      // including its opening hold; advancing clock time alone is not motion.
      // The rear head lets go at 0.35 s as its ADP copy, which then swings.
      const clock = createPlaybackClock(animation.durationSeconds, animation.playback);
      const head = animation.tracks.find((track: any) => track.id === 'k1d');
      const opening = evaluateTrack(head, 0).translation;
      clock.sample(performance.now());
      const sample = () => {
        const pose = evaluateTrack(head, clock.sample(performance.now()).timeSeconds);
        if (pose.visible && pose.translation.some((v: number, i: number) => Math.abs(v - opening[i]) > 1e-6)) movingAt = performance.now();
        else setTimeout(sample, 14);
      };
      setTimeout(sample, 14);
    },
  });
  if (atomic) {
    const viewer=readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs',import.meta.url),'utf8');
    const a=viewer.indexOf('  async function installMolecularChapter('),b=viewer.indexOf('  async function setLessonFigure(',a);
    const install=vm.runInNewContext(viewer.slice(a,b)+';installMolecularChapter',{
      molecularAnimation:{install:h.workspace.viewer.inspection.setMolecularAnimation,refresh:async()=>{},halt(){},resume(){},settled:async()=>{}},
      lessonFigure:{install:async(value:unknown)=>{if(value) await sleep(542 * scale);},snapshot:()=>({}),animationInstalled(){}},
      inspectionMutation:async(action:()=>Promise<void>)=>{await action();return {};},
      applyInspectionTransform(){},wearerPlacement:{holdsPlacement:()=>true},now:()=>performance.now(),recordCost(){},
    });
    h.workspace.viewer.inspection.setAnimatedChapter=(value:unknown,chapter:string,figure:unknown,options:any)=>
      install(value,chapter,{...options,figure,installFigure:true});
  }
  h.workspace.runTour = async (action: () => Promise<void>) => {
    await action();
    if (installedAt >= 0) { saveWaiting = true; await new Promise<void>(resolve => { releaseSave = resolve; }); saved = true; }
  };
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  try {
    await player.select(lesson.id);
    const started = performance.now(); let settled = false;
    const start = player.start(true, 0, { narration: false }).then(() => { settled = true; });
    for (let timer = 0; !saveWaiting && timer < 200; timer++) await vi.advanceTimersToNextTimerAsync();
    expect(installedAt).toBeGreaterThan(0);
    expect(settled).toBe(false); expect(saved).toBe(false);
    expect(h.records.all().some((r: any) => r.detail?.outcome === 'shown')).toBe(false);
    releaseSave(); await start;
    const shown = h.records.all().find((r: any) => r.detail?.phase === 'start-to-shown').detail.elapsedMs;
    await vi.advanceTimersByTimeAsync(400);
    const timing = { clock: scale===1?'simulated Quest phase costs':'half-cost lab scheduling model', atomic,
      startToShownMs: shown, startToDrawnMs: installedAt - started, startToMovingMs: movingAt - started };
    console.log(JSON.stringify(timing));
    expect(timing.startToDrawnMs).toBe(Math.floor((atomic && !process.env.FIRST_MOTION_PLAYER ? 1295 : 2162) * scale));
    expect(timing.startToShownMs).toBe(Math.floor((atomic && !process.env.FIRST_MOTION_PLAYER ? 1837 : 2162) * scale));
    expect(timing.startToMovingMs).toBe(Math.floor((atomic && !process.env.FIRST_MOTION_PLAYER ? 1295 : 2162) * scale) + 364);
    if(scale===.5) expect(timing.startToMovingMs).toBeLessThan(1400);
    expect(saved).toBe(true);
    expect(clears).toBe(atomic ? 0 : 1); // Keep a reloaded walk posed until replacement.
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('a failed concurrent toolbar draw cannot install motion or report the chapter shown', async () => {
  const h = tourEndHarness(); let installs = 0;
  const lesson: Tour = { id: 'failed-preview', title: 'Preview', summary: '', steps: [
    { id: 'walk', title: 'Walk', animation: {version:1,durationSeconds:2,tracks:[]} },
  ] };
  h.workspace.viewer.xr = { refreshToolbar: async () => { throw Error('toolbar draw failed'); } };
  Object.assign(h.workspace.viewer.inspection, {
    prepareMolecularAnimation: async () => {},
    setMolecularAnimation: async (value: unknown, _chapter?: string, options?: any) => { if (value) installs++; },
  });
  const player = mountTourPlayer({...h, tours:[lesson]});
  try {
    await player.select(lesson.id);
    await expect(player.start(true, 0, {narration:false})).rejects.toThrow('toolbar draw failed');
    expect(installs).toBe(0);
    expect(h.records.all().some((r: any) => r.detail?.outcome === 'shown')).toBe(false);
  } finally { player.pause(); h.cleanup(); }
});

it('explicit chapter framing still waits for the toolbar bounds before molecular paint', async () => {
  const h = tourEndHarness(); let toolbarDrawn = false, painted = false;
  const lesson: Tour = {id:'authored-frame',title:'Frame',summary:'',steps:[
    {id:'walk',title:'Walk',emphasis:{parts:[],framing:'fill'},animation:{version:1,durationSeconds:2,tracks:[]}},
  ]};
  h.workspace.viewer.xr = {refreshToolbar:async () => {
    await new Promise(resolve => setTimeout(resolve, 1)); toolbarDrawn = true;
  }};
  Object.assign(h.workspace.viewer.inspection, {
    emphasize:async () => { expect(toolbarDrawn).toBe(true); painted = true; },
    setAnimatedChapter:async () => { throw Error('authored framing must keep its own figure/frame order'); },
    prepareMolecularAnimation:async () => {}, setMolecularAnimation:async () => {},
  });
  const player = mountTourPlayer({...h,tours:[lesson]});
  try {
    await player.select(lesson.id); await player.start(true,0,{narration:false});
    expect(painted).toBe(true);
  } finally { player.pause(); h.cleanup(); }
});

it('restart keeps the old animation posed and caches only the completed replacement', async () => {
  const h=tourEndHarness();
  let liveChapter='reloaded', clears=0;
  const captures:string[]=[],restored:string[]=[];
  const capture=h.workspace.capture,restore=h.workspace.viewer.inspection.restore;
  h.workspace.capture=()=>{captures.push(liveChapter);return {...capture(),installedChapter:liveChapter};};
  Object.assign(h.workspace.viewer.inspection,{
    setMolecularAnimation:async(value:unknown,chapter:string)=>{
      if(!value) {clears++;liveChapter='cleared';} else liveChapter=chapter;
    },
    setAnimatedChapter:async(_value:unknown,chapter:string)=>{
      expect(liveChapter).not.toBe('cleared');liveChapter=chapter;
    },
    restore:async(scene:any,options:any)=>{
      restored.push(scene.installedChapter);liveChapter=scene.installedChapter;await restore(scene,options);
    },
  });
  const lesson:Tour={id:'restart',title:'Restart',summary:'',steps:['walk','later'].map(id=>({id,title:id,
    animation:{version:1,durationSeconds:2,tracks:[]}}))};
  const player=mountTourPlayer({...h,tours:[lesson]});
  try {
    await player.select(lesson.id);await player.start(false,0,{narration:false});
    expect(clears).toBe(0);expect(captures.at(-1)).toBe('walk');
    await player.next();expect(clears).toBe(0);expect(captures.at(-1)).toBe('later');
    await player.back();expect(restored).toEqual(['walk']);
  } finally {player.pause();h.cleanup();}
});
