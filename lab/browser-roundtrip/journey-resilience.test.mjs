import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { tourEndHarness } from './fixtures/tour-end-harness.mjs';
import { installSpatialMenuHook } from './spatial-menu-hook.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
const require=createRequire(new URL('../../plugin/package.json',import.meta.url));
const {tsImport}=require('tsx/esm/api');
const {mountExperiencePlayer}=await tsImport('../../plugin/src/experience-player.ts',import.meta.url);
const runtime=await toolbarFrameRuntime();
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function caption() {
  let now=0;const live=new Set(),records=[];
  const views=syntheticViews().map(view=>{
    const matrix=[...view.transform.matrix],inverse=[...view.transform.inverse.matrix];
    matrix[13]+=1.6;inverse[13]-=1.6;
    return {...view,transform:{matrix,inverse:{matrix:inverse}}};
  });
  const presentation={add:repr=>live.add(repr),remove:repr=>live.delete(repr)};
  const card=runtime.createTalkCaption({plugin:{runTask:task=>task.run()},presentation,
    head:()=>({position:{x:0,y:1.6,z:0},matrix:identity}),now:()=>now,
    clearance:()=>({views,renderFromRoom:identity}),
    record:(kind,detail)=>records.push({kind,detail})});
  return {card,records,presentation,advance:async(ms)=>{now+=ms;card.frame();await flush();}};
}

test('Menu through the real page hook and toolbar closes the chooser and draws its reply over an old outcome',async()=>{
  const dom=tourEndHarness(),create=document.createElement.bind(document);
  document.createElement=(...args)=>Object.assign(create(...args),{querySelectorAll:()=>[],remove(){}});
  document.removeEventListener=()=>{};
  const c=caption();let player;
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const start=source.indexOf("        if (action.kind === 'collapse')"),end=source.indexOf("        if (action.kind === 'tour-choice')",start);
  const h=toolbarFrameHarness(runtime,{presentation:c.presentation,onAction:action=>vm.runInNewContext(
    `(async()=>{${source.slice(start,end)}})()`,{action,spatialTour:player})});
  const sync=()=>h.setState({tour:player.getState()});
  player=mountExperiencePlayer({after:dom.after,navigate:async()=>{throw Error('This test never starts a chapter.');},finish:async()=>({status:'rendered'}),explore(){}});
  player.setCatalog([{id:'journey',title:'A journey',deviceBudget:{notice:'This device will refuse chapters 2, 7, 12, 17 because they exceed its geometry budget.'}}]);
  player.subscribe(sync);sync();
  const detach=installSpatialMenuHook({readRows:()=>h.toolbar.rows(),runAction:action=>h.toolbar.runAction(action),readState:()=>({tour:player.getState()})});
  runtime.setTalkOutcomeSink((text,holdMs)=>c.card.set({outcome:text,holdMs}));
  try {
    h.toolbar.syncPose(h.frame);await h.toolbar.update();
    await player.openMenu();await h.toolbar.update();
    assert.equal(globalThis.__stereofoldMenu.state().tour.menuOpen,true);
    assert.match(runtime.tourReadout(player.getState(),{})[1].text,/chapters 2, 7, 12, 17/);
    c.card.set({outcome:'Applied · change · r7'});await flush();
    const row=h.toolbar.rows().find(row=>row.action?.kind==='collapse');assert.ok(row);
    assert.equal(globalThis.__stereofoldMenu.press(row.id),true);
    for(let i=0;i<8;i++)await flush();
    assert.equal(globalThis.__stereofoldMenu.state().tour.menuOpen,false);
    assert.equal(c.card.text(),'Tour chooser closed');
    assert.equal(c.records.filter(entry=>entry.kind==='talk-caption'&&entry.detail.text==='Tour chooser closed').length,1);
    assert.ok(c.records.some(entry=>entry.kind==='talk-caption-seat'&&entry.detail.holdMs===6000));
    await c.advance(5999);assert.equal(c.card.text(),'Tour chooser closed');
    await c.advance(1);assert.equal(c.card.text(),'');
  } finally {detach();runtime.setTalkOutcomeSink(undefined);await c.card.dispose();await h.toolbar.dispose();player.dispose();dom.cleanup();}
});

for(const kind of ['outcome','notice','progress'])test(`a ${kind} caption with holdMs zero gets the default hold and expires`,async()=>{
  const c=caption();
  try {
    c.card.set({[kind]:'This action belongs to a different structure.',holdMs:0});await flush();
    assert.equal(c.card.text(),'This action belongs to a different structure.');
    const receipt=c.records.find(entry=>entry.kind==='talk-caption-seat');assert.ok(receipt.detail.holdMs>0);
    await c.advance(runtime.CAPTION_OUTCOME_MS-1);assert.notEqual(c.card.text(),'');
    await c.advance(1);assert.equal(c.card.text(),'');
    await c.advance(60000);assert.equal(c.card.text(),'');
  } finally {await c.card.dispose();}
});

test('idle toolbar feedback uses the expiring outcome route instead of persistent progress',async()=>{
  const c=caption(),h=toolbarFrameHarness(runtime,{presentation:c.presentation});
  h.session.requestAnimationFrame=callback=>{setImmediate(()=>callback(performance.now(),h.frame));return 1;};
  runtime.setTalkOutcomeSink((text,holdMs)=>c.card.set({outcome:text,holdMs}));
  runtime.setTalkProgressSink(state=>c.card.set(state));
  try {
    h.toolbar.syncPose(h.frame);await h.toolbar.update();
    await h.toolbar.setStatus('This action belongs to a different structure.',undefined,'idle',0);await flush();
    h.session.requestAnimationFrame=()=>1;
    assert.equal(c.card.text(),'This action belongs to a different structure.');
    await c.advance(runtime.CAPTION_OUTCOME_MS);assert.equal(c.card.text(),'');
  } finally {runtime.setTalkOutcomeSink(undefined);runtime.setTalkProgressSink(undefined);await c.card.dispose();await h.toolbar.dispose();}
});
