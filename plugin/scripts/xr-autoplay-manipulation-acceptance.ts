import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { waitControllerFrames } from './xr-controller-acceptance.js';
import { xrToolbarControllerPose } from './xr-toolbar-controller-pose.js';

const closeVector = (actual: number[], expected: number[], label: string) => {
  assert.ok(actual?.length === expected?.length && actual.every((value,i)=>Math.abs(value-expected[i]) < 1e-5),
    `${label}: ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
};

/** Caption text can reflow vertically. Its lower edge is the seat attachment;
 * compare that edge in its actual plane, so resizing does not mask relocation. */
export function assertUntouchedMenuPose(actual: any, baseline: any, label: string) {
  closeVector(actual.anchor,baseline.anchor,`${label}: menu anchor jumped`);
  for (const axis of ['right','up','normal']) closeVector(actual.plane[axis],baseline.plane[axis],`${label}: menu ${axis} turned`);
  for (const original of baseline.geometry.plates) {
    const plate=actual.geometry.plates.find((plate:any)=>plate.kind===original.kind);
    assert.ok(plate,`${label}: ${original.kind} surface disappeared`);
    const seat=(surface:any)=>surface.kind==='caption'
      ? surface.point.map((value:number,axis:number)=>value-surface.up[axis]*surface.halfHeight) : surface.point;
    closeVector(seat(plate),seat(original),`${label}: ${original.kind} attachment moved`);
    for (const axis of ['right','up','normal']) closeVector(plate[axis],original[axis],`${label}: ${original.kind} ${axis} turned`);
  }
}

/** Isolated IWER input only. The production menu/placement/action APIs are
 * read, never used to move the molecule. Dwell is accelerated by the caller;
 * production scene admission, caption holds and frame safety remain enabled. */
export async function runAutoplayManipulationAcceptance(page: Page, options: {
  readSaved: () => Promise<any>; play: () => Promise<any>; capture: (name: string) => Promise<any>;
  chapterCount: number; evidence: any;
}) {
  assert.ok(options.chapterCount >= 5, 'Autoplay manipulation acceptance needs five chapters to cross all three held gestures and one released boundary.');
  const evidence = options.evidence;
  Object.assign(evidence, { scope: 'Real Chromium, IWER two-eye production viewer and controller adapter; no physical-device or tracking-quality claim.',
    dwellOverrideMs: 4000, cases: [], checkpoints: [], chapterCount: options.chapterCount });
  await page.evaluate(() => {
    const g = globalThis as any, test = g.__companionXrTest;
    const original = g.IWER.XRFrame.prototype.getPose;
    const control: any = { events: [], frameGaps: [], lastFrame: undefined, lastAt: undefined };
    g.__controllerAcceptance = control;
    g.IWER.XRFrame.prototype.getPose = function(space: any, base: any) {
      if (this.predictedDisplayTime !== control.lastFrame) {
        const now = performance.now();
        if (control.lastAt !== undefined && now - control.lastAt > 500)
          control.frameGaps.push({ at: Date.now(), milliseconds: now - control.lastAt });
        control.lastAt = now; control.lastFrame = this.predictedDisplayTime;
      }
      const pose = original.call(this, space, base);
      const source = [...test.active.session.inputSources].find((source: any) => source.targetRaySpace === space || source.gripSpace === space);
      if (pose && source) Object.defineProperty(pose, 'emulatedPosition', { value: false });
      return pose;
    };
    const diagnostics = g.__stereofoldDiagnostics, record = diagnostics.record;
    diagnostics.record = function(kind: string, detail: any) {
      const entry = record.call(this, kind, detail);
      if (['tour', 'xr-grab', 'xr-scale', 'toolbar-action', 'xr-tracking'].includes(kind)) control.events.push(entry);
      return entry;
    };
    control.restore = () => { g.IWER.XRFrame.prototype.getPose = original; diagnostics.record = record; };
    for (const hand of ['left', 'right']) {
      const controller = test.device.controllers[hand];
      controller.connected = true; controller.position.set(hand === 'left' ? -.25 : .25, 1.3, -.3);
      controller.quaternion.set(0, 0, 0, 1);
      controller.updateAxes('thumbstick', 0, 0);
      for (const button of ['trigger', 'squeeze', 'thumbstick']) controller.updateButtonValue(button, 0);
    }
  });
  const frames = (duration = 0) => waitControllerFrames(page, duration);
  const button = (hand: string, name: string, value: number) => page.evaluate(({hand,name,value}) =>
    (globalThis as any).__companionXrTest.device.controllers[hand].updateButtonValue(name,value), {hand,name,value});
  const pose = (hand: string, position: number[], yaw = 0) => page.evaluate(({hand,position,yaw}) => {
    const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
    controller.position.set(...position); controller.quaternion.set(0, Math.sin(yaw/2), 0, Math.cos(yaw/2));
  }, {hand,position,yaw});
  const read = () => page.evaluate(async () => {
    const g = globalThis as any, state = g.__stereofoldMenu.state();
    const drag = await g.__stereofoldAim.dragState();
    const root = document.querySelector<HTMLElement>('.tour-player:not([hidden]), .experience-player:not([hidden])');
    const geometry = g.__stereofoldReadGeometry();
    const renderTransform = Array.from(geometry.objects[0].values.aTransform.ref.value as ArrayLike<number>);
    return { renderTransform, at: Date.now(), frame: g.__companionXrTest.active.rafCount, tour: state.tour, placement: state.placement,
      menu: { anchor: drag.current.anchor, plane: drag.current.plane, geometry: drag.current.geometry,
        holding: drag.current.holding, hidden: drag.current.hidden, pending: drag.current.pending }, status: root?.querySelector('[data-tour-status], [data-experience-status]')?.textContent ?? '',
      progress: root?.querySelector('[data-tour-progress], [data-experience-progress]')?.textContent ?? '',
      events: g.__controllerAcceptance.events.slice(-40) };
  });
  let menuBaseline: any;
  const observe = async (label: string, requirePlaying = true) => {
    const state = await read();
    if (evidence.checkpoints.at(-1)?.tour.step !== state.tour.step) console.log(`Autoplay manipulation: chapter ${state.tour.step+1}/${options.chapterCount}, ${label}`);
    evidence.checkpoints.push({ label, ...state });
    assert.ok(!state.menu.hidden && !state.menu.holding, `${label}: molecule input claimed or hid the untouched menu`);
    if (menuBaseline) assertUntouchedMenuPose(state.menu, menuBaseline, label);
    assert.ok(!/release.*molecular drag|failed|rollback|interrupted/i.test(state.status), `${label}: ${state.status}`);
    assert.ok(!state.events.some((entry: any)=>entry.kind === 'tour' && (['scene-error','action-error'].includes(entry.detail.event ?? entry.detail.phase ?? entry.detail.action) || ['error','rolled-back','rollback-failed'].includes(entry.detail.outcome))),
      `${label}: a production tour error was recorded`);
    if (requirePlaying) assert.equal(state.tour.autoplay, true, `${label}: autoplay stopped: ${state.status}`);
    return state;
  };
  const holdAcrossChapter = async (label: string, start: any) => {
    const admission = [...start.events].reverse().find((entry:any)=>(entry.kind==='xr-grab'||entry.kind==='xr-scale') && entry.detail.event==='start');
    assert.ok(admission, `${label}: missing held gesture admission`);
    const until = Date.now()+120_000;
    do {
      await frames(200);
      const current = await observe(label);
      const ended = (await events()).find((entry:any)=>entry.seq>admission.seq && (entry.kind==='xr-grab'||entry.kind==='xr-scale') && entry.detail.event==='end');
      if (!label.includes('after release')) assert.ok(!ended, `${label}: production gesture ended before its held chapter boundary: ${JSON.stringify(ended)}`);
      if (current.tour.step > start.tour.step && !current.tour.navigating) return current;
    } while (Date.now() < until);
    throw Error(`${label}: no chapter advance while molecule remained held`);
  };
  const events = () => page.evaluate(() => (globalThis as any).__controllerAcceptance.events);
  const release = async () => {
    for (const hand of ['left','right']) for (const name of ['trigger','squeeze']) await button(hand,name,0);
    await frames(80);
  };
  try {
    await frames(100); evidence.playPress = await options.play();
    await page.waitForFunction(() => {
      const tour = (globalThis as any).__stereofoldMenu.state().tour;
      return tour.active && tour.autoplay && !tour.navigating;
    }, undefined, {timeout:120_000});
    // Capture before admission: readPixels can create a long software frame.
    evidence.initialImage = await options.capture('autoplay-molecule-before');
    const before = await observe('before first molecule grab'); menuBaseline = before.menu;
    await frames();
    // Aim down a native ray through the production molecular framing bounds.
    const target = await page.evaluate(() => {
      const g = globalThis as any, geometry = g.__stereofoldReadGeometry();
      const source = geometry.sourceBoundary?.center;
      const matrix = geometry.objects[0]?.values.aTransform?.ref.value;
      if (!source || matrix?.length !== 16) throw Error('Production molecular source/transform unavailable');
      const center = [0,1,2].map(i => (matrix[i]*source[0]+matrix[4+i]*source[1]+matrix[8+i]*source[2]+matrix[12+i])*geometry.cameraScale);
      return { center, renderFromRoom: Array.from(geometry.renderFromRoom), frame: g.__controllerAcceptance.viewerFrame };
    });
    // Invert the rigid render-from-room transform independently in the test.
    const { Mat4, Vec3 } = await import('molstar/lib/commonjs/mol-math/linear-algebra.js');
    const inverse = Mat4.invert(Mat4(), Mat4.fromArray(Mat4(), target.renderFromRoom as number[], 0));
    const room = Vec3.transformMat4(Vec3(), Vec3.create(...target.center as [number,number,number]), inverse);
    const aimed = xrToolbarControllerPose({x:room[0],y:room[1],z:room[2]}, target.frame.viewerFromRoom, target.frame.viewerPose);
    await page.evaluate(aimed => {
      const c = (globalThis as any).__companionXrTest.device.controllers.right;
      c.position.set(aimed.position.x,aimed.position.y,aimed.position.z);
      c.quaternion.set(aimed.quaternion.x,aimed.quaternion.y,aimed.quaternion.z,aimed.quaternion.w);
    },aimed);
    await frames(80);
    const firstSeq = (await events()).at(-1)?.seq ?? -1;
    await button('right','trigger',1); await frames(350);
    assert.ok((await events()).some((entry:any)=>entry.seq>firstSeq && entry.kind==='xr-grab' && entry.detail.event==='start' && entry.detail.kind==='ray'),
      'Pointed trigger did not admit a production molecule ray grab');
    const rayStart = await observe('ray grab admitted');
    for (let step=1;step<=6;step++) {
      await pose('right',[aimed.position.x+.006*step,aimed.position.y,aimed.position.z]); await frames(40);
      await observe(`ray translate ${step}`);
    }
    const rayEnd = await holdAcrossChapter('held ray translation boundary',rayStart);
    assert.ok(Math.hypot(...rayEnd.renderTransform.slice(12,15).map((value:number,i:number)=>value-rayStart.renderTransform[12+i])) > .001,
      'Native ray translation did not move the molecule');
    evidence.cases.push({kind:'pointed-ray-translation',before:rayStart,after:rayEnd,heldAcrossBoundary:true});
    await release(); await observe('ray release');

    await pose('right',[.25,1.3,-.3]); await frames(80);
    const rotationSeq = (await events()).at(-1)?.seq ?? -1;
    await button('right','squeeze',1); await frames(80);
    assert.ok((await events()).some((entry:any)=>entry.seq>rotationSeq && entry.kind==='xr-grab' && entry.detail.event==='start'), 'Squeeze did not admit molecule rotation');
    const rotationStart=await observe('grip rotation admitted');
    for(let step=1;step<=6;step++){await pose('right',[.25,1.3,-.3],step*.04);await frames(40);await observe(`grip rotate ${step}`);}
    const rotationEnd=await holdAcrossChapter('held grip rotation boundary',rotationStart);
    assert.ok(Math.hypot(...rotationEnd.renderTransform.slice(0,12).map((value:number,i:number)=>value-rotationStart.renderTransform[i])) > .01,'Native grip did not rotate the molecule');
    evidence.cases.push({kind:'grip-rotation',before:rotationStart,after:rotationEnd,heldAcrossBoundary:true});
    await release();await observe('rotation release');

    await pose('left',[-.15,1.3,-.3]);await pose('right',[.15,1.3,-.3]);await frames(80);
    const scaleSeq=(await events()).at(-1)?.seq??-1;
    await button('left','squeeze',1);await button('right','squeeze',1);await frames(100);
    assert.ok((await events()).some((entry:any)=>entry.seq>scaleSeq&&entry.kind==='xr-scale'&&entry.detail.event==='start'),'Two native squeezes did not admit production bimanual scale');
    const scaleStart=await observe('bimanual scale admitted');
    for(let step=1;step<=6;step++){
      await pose('left',[-.15-.01*step,1.3,-.3]);await pose('right',[.15+.01*step,1.3,-.3]);await frames(40);await observe(`bimanual scale ${step}`);
    }
    const scaleEnd=await holdAcrossChapter('held bimanual scale boundary',scaleStart);
    assert.ok(Math.abs(Math.hypot(...scaleEnd.renderTransform.slice(0,3))/Math.hypot(...scaleStart.renderTransform.slice(0,3))-1) > .01,'Native two-hand separation did not scale the molecule');
    evidence.cases.push({kind:'bimanual-scale',before:scaleStart,after:scaleEnd,heldAcrossBoundary:true});
    await release();const released=await observe('bimanual release');
    const following=await holdAcrossChapter('following chapter after release',released);
    assert.ok(following.tour.step>released.tour.step,'Autoplay did not continue after release');
    closeVector(following.placement.translation,released.placement.translation,'Following chapter lost wearer translation');
    closeVector(following.placement.rotation,released.placement.rotation,'Following chapter lost wearer rotation');
    assert.ok(Math.abs(following.placement.scale-released.placement.scale)<1e-5,'Following chapter lost wearer scale');
    const end=Date.now()+options.chapterCount*90_000;
    while(Date.now()<end){
      await frames(300);const current=await observe('remaining autoplay',false);
      if(!current.tour.autoplay){
        assert.ok(current.tour.step===options.chapterCount-1 || !current.tour.active,`Tour stopped early at ${current.tour.step}: ${current.status}`);
        evidence.completed=current;break;
      }
    }
    assert.ok(evidence.completed,'Full authored slideshow did not complete');
    evidence.observedChapters=[...new Set(evidence.checkpoints.map((point:any)=>point.tour.step))];
    assert.deepEqual(evidence.observedChapters,Array.from({length:options.chapterCount},(_,index)=>index),'Autoplay must show every authored chapter');
    evidence.finalImage=await options.capture('autoplay-molecule-after');evidence.saved=await options.readSaved();
    evidence.result='passed';
  } finally {
    await release();
    Object.assign(evidence,await page.evaluate(()=>{
      const c=(globalThis as any).__controllerAcceptance;
      return {events:c.events,frameGaps:c.frameGaps,frames:(globalThis as any).__companionXrTest.active.rafCount};
    }));
    await page.evaluate(()=>(globalThis as any).__controllerAcceptance.restore());
  }
}
