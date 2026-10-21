import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { transformSphere } from './molecular-animation.mjs';
import { animationBodiesVisible } from './molecular-animation.mjs';
import { molecularAnimationHarness } from './fixtures/molecular-animation-harness.mjs';
import { resolveFigureLoci } from './lesson-figure.mjs';
import { motionFocusPlacement } from './motion-framing.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
test('hidden opening ligand and chain loci cannot bypass the chapter scale cap', async t => {
  const h = await molecularAnimationHarness(t);
  const value = {version:1,durationSeconds:2,tracks:[{id:'alpha',chains:['A'],keyframes:[
    {t:0,rotation:[0,0,0,1],translation:[0,0,0]}, {t:2,rotation:[0,0,0,1],translation:[10,0,0]},
  ]}]};
  let scale = 2.022824, hidden;
  const {c} = harness();
  Object.assign(c, {structure:h.structure, animationBodiesVisible,
    hiddenSceneKeySet:()=>new Set(['hidden']), selection:{toLoci:()=>hidden},
    inspectionSnapshot:()=>({placement:{scale}}), applyInspectionTransform(){},
    emphasisOrigin:'lesson',emphasisState:{focus:[]},lessonFigure:{definition:()=>undefined},
    wearerPlacement:{holdsPlacement:()=>false},molecularAnimation:h.registry});
  const from = source.indexOf('    animationFramingContext(');
  const context = vm.runInContext('({' + source.slice(from, source.indexOf('    setMolecularAnimation:',from)) + '}).animationFramingContext', c);
  vm.runInContext(pageFunction(source,'installMolecularChapter'),c);
  const install = c.installMolecularChapter;
  for (const target of [{chain:'A',componentId:'HEM'}, {chain:'A'}]) {
    hidden = resolveFigureLoci(target, h.structure.obj.data);
    assert.equal(animationBodiesVisible(h.structure.obj.data, value, hidden), false, 'old visibility gate rejects this baseline');
    for (const previous of [2.022824, 3]) {
      scale = previous; // Opening scene, then a later chapter's placement.
      const frame = context(value);
      assert.equal(frame.source, h.structure.obj.data);
      assert.equal(frame.previousScale, previous);
      let framed = false;
      c.focusSelection = async ({motionFrame}) => {
        assert.equal(motionFrame.previousScale, previous);
        const plan = motionFocusPlacement({headInRoom:Mat4.identity(),renderFromRoom:Mat4.identity(),cameraScale:.003,
          center:[0,0,0],radius:50,targetCenter:motionFrame.target.center,targetRadius:motionFrame.target.radius,
          framing:'fill',elevationDegrees:0,placement:{translation:[0,0,0],rotation:[0,0,0],scale:previous},
          previousScale:motionFrame.previousScale});
        assert.ok(plan.scale >= previous * .8 - 1e-9 && plan.scale <= previous * 1.25 + 1e-9);
        framed = true;
      };
      await install(value, 'chapter', {context:frame});
      assert.equal(framed, true);
    }
  }
});
function harness() {
  const envelope={center:[40,0,0],radius:70}, target={center:[80,10,0],radius:5};
  const loci={}, calls=[], placement={scale:2};
  const transform=Mat4.fromScaling(Mat4(),[2,2,2]); Mat4.setTranslation(transform,[3,4,5]);
  const c=vm.createContext({Mat4,Vec3,transformSphere,performance,now:()=>performance.now(),recordCost(){},
    assertReady(){}, syncInspectionPayload(){}, inspectionPayload:()=>({}), snapshot:()=>({}),
    inspectionState:{recordPayload(){},setPayload(){}}, inspectionSnapshot:()=>({placement}),
    inspectionMutation:async operation=>{await operation();return {rendered:true};},
    selectedKeys:keys=>keys,modelledFocusKeys:keys=>keys,selection:{toLoci:()=>loci},
    presentationTransform:()=>transform,
    molecularAnimation:{envelope:()=>envelope,selectionSphere:value=>{assert.equal(value,loci);return target;}},
    plugin:{managers:{camera:{focusSphere:sphere=>calls.push(plain(sphere))}}},
    canvas:{requestCameraReset(){throw Error('instantaneous bounds used');},xr:{isPresenting:{value:false}},camera:{scale:1}},
    structure:{obj:{data:{boundary:{sphere:{center:[0,0,0],radius:1}}}}}, volume:null,
  });
  for (const name of ['recordBoundingSphere','loadedSphere','focus','fitInspection']) vm.runInContext(pageFunction(source,name),c);
  return {c,calls,envelope,target};
}
test('desktop focus and Fit use animated bounds while saved placement keeps the source basis',async()=>{
  const {c,calls,envelope}=harness();
  await c.focus(['C']); assert.deepEqual(calls.pop(),{center:[163,24,5],radius:10});
  await c.fitInspection(); assert.deepEqual(calls.pop(),{center:[83,4,5],radius:140});
  assert.equal(c.loadedSphere(),c.structure.obj.data.boundary.sphere,'animation never changes saved placement units');
  const other={obj:{data:{boundary:{sphere:{center:[2,0,0],radius:3}}}}};
  assert.equal(c.recordBoundingSphere({structure:other}),other.obj.data.boundary.sphere,'an incoming source keeps its own bounds');
});
test('XR focus frames the envelope in stable source placement units',async()=>{
  const {c,envelope,target}=harness(); let received;
  Object.assign(c,{now:()=>0,recordCost(){},cancelXrPlacementFollowup(){},invalidateGesturePivot(){},
    focusPivotRequest:undefined,LESSON_FRAMING_TRAVEL_MS:0,enableXr:true,latestHeadSample:performance.now(),
    latestRoomPlacementPose:{headInRoom:Mat4.identity()},sourceRecord:{},visibleStage:undefined,
    wearerPlacement:{holdsPlacement:()=>false},
    pendingGrowthTurn:false,componentLabels:{active:()=>false},immersiveSession:undefined,pointRange:()=>undefined,
    focusPlacement:value=>{received=value;throw Error('solver reached');},state:{selectionKeys:['C']},
  });
  c.canvas.xr.isPresenting.value=true;
  vm.runInContext(pageFunction(source,'focusSelection'),c);
  await assert.rejects(c.focusSelection({liftEmphasis:false}),/solver reached/);
  assert.deepEqual(received.targetCenter,target.center); assert.equal(received.targetRadius,target.radius);
  assert.deepEqual(received.center,[0,0,0]); assert.equal(received.radius,1);
  assert.equal(received.assemblyRadius,40 + envelope.radius);
  await assert.rejects(c.focusSelection({wholeStructure:true,liftEmphasis:false}),/solver reached/);
  assert.deepEqual(received.targetCenter,envelope.center); assert.equal(received.targetRadius,envelope.radius);
});
test('desktop motion framing saves the transformed envelope after its admitted draw', async () => {
  const {c,calls,target}=harness(); let drew=false, saved=false;
  Object.assign(c,{now:()=>0,recordCost(){},cancelXrPlacementFollowup(){},invalidateGesturePivot(){},
    focusPivotRequest:undefined,LESSON_FRAMING_TRAVEL_MS:0,enableXr:false,state:{selectionKeys:['C']}});
  c.inspectionMutation=async operation=>{await operation();drew=true;};
  c.inspectionState.setPayload=()=>{assert.equal(drew,true);saved=true;};
  vm.runInContext(pageFunction(source,'focusSelection'),c);
  await c.focusSelection({liftEmphasis:false,motionFrame:{target}});
  assert.deepEqual(calls,[{center:[163,24,5],radius:10}]);
  assert.equal(saved,true);
});

test('animation installation frames its envelope after admission and respects wearer placement',async()=>{
  const {c,target}=harness(); const calls=[]; let installed=false, held=false;
  Object.assign(c,{applyInspectionTransform:()=>calls.push('transform'),
    emphasisOrigin:'lesson',emphasisState:{focus:['motor']}, currentEmphasisPlan:()=>({lit:['C']}),
    lessonFigure:{definition:()=>undefined},
    wearerPlacement:{holdsPlacement:()=>held},focusSelection:async options=>{calls.push(plain(options));},
  });
  c.molecularAnimation.install=async value=>{installed=!!value;calls.push(value?'install':'clear');};
  c.molecularAnimation.snapshot=()=>installed ? {} : null;
  c.molecularAnimation.framingEnvelope=loci=>{assert.ok(loci);return target;};
  vm.runInContext(pageFunction(source,'installMolecularChapter'),c);
  const install = c.installMolecularChapter;
  await install({});
  assert.deepEqual(calls,['install','transform',{framing:'fill',liftEmphasis:false,durationMs:0,elevationDegrees:0,motionFrame:{target}}]);
  calls.length=0;await install({}, 'edit', {frame:false});assert.deepEqual(calls,['install','transform']);
  calls.length=0;await install({}, 'new-source', {frame:true});
  assert.deepEqual(calls,['install','transform',{framing:'fill',liftEmphasis:false,durationMs:0,elevationDegrees:0,motionFrame:{target}}]);
  calls.length=0;await install({}, 'closeup', {framing:'context'});
  assert.deepEqual(calls,['install','transform',{framing:'context',liftEmphasis:false,durationMs:0,elevationDegrees:0,motionFrame:{target}}]);
  calls.length=0;held=true;await install({});assert.deepEqual(calls,['install','transform']);
  calls.length=0;await install(undefined);assert.deepEqual(calls,['clear','transform']);
});

// The motion refit runs once the bodies are drawn, before the figure's plates
// exist. A plate that rides a moving body only joins the chapter's field when
// the figure installs, so the chapter is framed again then, its room solve
// counting the plates and their travel.
test('a chapter whose figure installs with its motion is framed again once its plates are drawn',async()=>{
  const {c,target}=harness(); const calls=[]; let held=false;
  Object.assign(c,{applyInspectionTransform:()=>calls.push('transform'),
    emphasisOrigin:'lesson',emphasisState:{focus:[]}, currentEmphasisPlan:()=>({lit:[]}), selection:{rows:[]},
    figureTargetMatchesRow:()=>false,
    lessonFigure:{definition:()=>undefined,install:async figure=>calls.push(figure?'figure':'clear-figure'),
      snapshot:()=>({}),animationInstalled:()=>calls.push('reveal')},
    wearerPlacement:{holdsPlacement:()=>held},focusSelection:async options=>{calls.push(plain(options));},
  });
  Object.assign(c.molecularAnimation,{install:async()=>calls.push('install'),halt(){},resume(){},settled:async()=>{},
    refresh:async()=>{},snapshot:()=>({}),framingEnvelope:()=>target});
  vm.runInContext(pageFunction(source,'installMolecularChapter'),c);
  const refit={framing:'fill',liftEmphasis:false,durationMs:0,elevationDegrees:0,motionFrame:{target}};
  await c.installMolecularChapter({},'walk',{installFigure:true,figure:{labels:[]}});
  assert.deepEqual(calls,['clear-figure','install','transform',refit,'figure','reveal','transform',refit]);
  calls.length=0;held=true;
  await c.installMolecularChapter({},'walk',{installFigure:true,figure:{labels:[]}});
  assert.deepEqual(calls,['clear-figure','install','transform','figure','reveal','transform'],'a held chapter is never refitted');
});

test('a failed caption barrier cannot reveal or publish a staged animated chapter',async()=>{
  const {c}=harness(); let cleared=false, installed=false, published=false;
  Object.assign(c,{lessonFigure:{install:async figure=>{assert.equal(figure,undefined);cleared=true;}},
    molecularAnimation:{install:async(_value,_chapter,{beforeReveal})=>{await beforeReveal;installed=true;},
      halt(){}, resume(){}, settled:async()=>{}},
    inspectionMutation:async operation=>{await operation();published=true;},
  });
  vm.runInContext(pageFunction(source,'installMolecularChapter'),c);
  await assert.rejects(c.installMolecularChapter({},'opening',{
    installFigure:true,figure:{labels:[]},toolbarReady:Promise.reject(Error('caption failed')),
  }),/caption failed/);
  assert.equal(cleared,true); assert.equal(installed,false); assert.equal(published,false);
});

test('animation control waits for a frame and refuses absent or changed chapters',async()=>{
  let current=null,draw;
  const calls=[];
  const c=vm.createContext({Error,
    molecularAnimation:{snapshot:()=>current,revision:()=>1,publish(){},control:patch=>{calls.push(patch);current={...current,state:patch.state==='pause'?'paused':'playing'};return current;}},
    waitForFrame:(_record,{onDraw})=>new Promise((resolve,reject)=>{draw=()=>{try{resolve(onDraw());}catch(error){reject(error);}};}),
  });
  const start=source.indexOf('    async applyMolecularAnimationControl(');
  const control=vm.runInContext('({'+source.slice(start,source.indexOf('    setLessonPlayback(',start))+'}).applyMolecularAnimationControl',c);
  await assert.rejects(control({state:'pause'}),/This chapter has no animation/);
  current={id:'clip',chapterId:'walk',state:'playing',timeSeconds:1,durationSeconds:5,loop:true,speed:1};
  await assert.rejects(control({state:'pause'},{id:'clip',chapterId:'other'}),/chapter changed/);
  assert.equal(calls.length,0);
  let settled=false;
  const pending=control({state:'pause'},{id:'clip',chapterId:'walk'}).then(result=>{settled=true;return result;});
  await Promise.resolve();assert.equal(settled,false);
  draw();assert.equal((await pending).state,'paused');
  const replaced=control({state:'play'});current=null;draw();
  await assert.rejects(replaced,/chapter changed before it rendered/);
});

test('the workspace forwards animation controls and their frame receipt without touching tour or spin',async()=>{
  const {interruptibleCommand}=await import('../inspection/interruptible-command.mjs');
  const {createNamedPublication}=await import('../inspection/named-publication.mjs');
  const workspace=readFileSync(new URL('../inspection/workspace.mjs',import.meta.url),'utf8');
  const remote=workspace.slice(workspace.indexOf('  applyRemote:')+'  applyRemote:'.length,workspace.lastIndexOf('\n});')).trim().replace(/,$/,'');
  const scene={inspection:{placement:{scale:1,translation:[0,0,0],rotation:[0,0,0]}}};
  const animation={id:'clip',chapterId:'walk',state:'paused',timeSeconds:0,durationSeconds:10,loop:true,speed:0.5};
  let admitted=false,confirmed=false,draw;
  const viewer={snapshot:()=>({animation}),inspection:{capture:()=>structuredClone(scene),
    setMotion:()=>{throw Error('spin changed');},
    applyMolecularAnimationControl:async(patch,target)=>{
      assert.equal(admitted,true);assert.deepEqual(patch,{state:'pause',restart:true});assert.deepEqual(target,{id:'clip',chapterId:'walk'});
      await new Promise(resolve=>{draw=resolve;});return animation;
    }}};
  const apply=new Function('run','namedPublication','interruptibleCommand','viewer',`return (${remote});`)(
    async(_message,action)=>action(),createNamedPublication(()=>{}),interruptibleCommand,viewer);
  const pending=apply({kind:'animation',patch:{state:'pause',restart:true},target:{id:'clip',chapterId:'walk'}},
    async()=>{admitted=true;},async(saved,applied)=>{assert.deepEqual(saved,scene);assert.deepEqual(applied.animation,animation);confirmed=true;});
  await new Promise(setImmediate);assert.equal(typeof draw,'function');assert.equal(confirmed,false);draw();await pending;assert.equal(confirmed,true);
});

test('Play restarts an ended animation and draw receipts reject superseding controls',async()=>{
  const {createPlaybackClock} = await import('../../packages/motion/src/keyframes.mjs');
  const clock = createPlaybackClock(2); clock.patch({seekSeconds:2});
  let revision=0,draw;
  const sample=()=>({id:'clip',chapterId:'walk',durationSeconds:2,...clock.snapshot()});
  const c=vm.createContext({Error,molecularAnimation:{snapshot:sample,
    control:patch=>{revision++;clock.patch(patch,0);},revision:()=>revision,publish(){}},
    waitForFrame:(_record,{onDraw})=>new Promise((resolve,reject)=>{draw=()=>{try{clock.sample(16);resolve(onDraw());}catch(error){reject(error);}};}),
  });
  const start=source.indexOf('    async applyMolecularAnimationControl(');
  const control=vm.runInContext('({'+source.slice(start,source.indexOf('    setLessonPlayback(',start))+'}).applyMolecularAnimationControl',c);
  const pending=control({state:'play'}); draw();
  const restarted=await pending;
  assert.equal(restarted.state,'playing');
  assert.equal(restarted.timeSeconds,.016);
  const superseded=control({state:'play',restart:true}); revision++; draw();
  await assert.rejects(superseded,/control changed/);
});

test('explicit animation controls preserve pause, mid-clip resume, loops and seeks',async()=>{
  const {createPlaybackClock} = await import('../../packages/motion/src/keyframes.mjs');
  for (const [time,loop,patch,expected] of [
    [2,false,{state:'pause'},2],
    [1,false,{state:'play'},1.016],
    [1,true,{state:'play'},1.016],
    [2,true,{state:'play'},.016],
    [2,false,{state:'play',seekSeconds:1},1.016],
    [2,false,{state:'play',seekSeconds:2},2],
    [2,false,{state:'play',loop:true},.016],
    [1,false,{state:'play',restart:true},.016],
  ]) {
    const clock=createPlaybackClock(2,{loop}); clock.patch({seekSeconds:time});
    const sample=()=>({id:'clip',chapterId:'walk',durationSeconds:2,...clock.snapshot()});
    const c=vm.createContext({Error,molecularAnimation:{snapshot:sample,
      control:patch=>clock.patch(patch,0),revision:()=>1,publish(){}},
      waitForFrame:async(_record,{onDraw})=>{clock.sample(16);return onDraw();},
    });
    const start=source.indexOf('    async applyMolecularAnimationControl(');
    const control=vm.runInContext('({'+source.slice(start,source.indexOf('    setLessonPlayback(',start))+'}).applyMolecularAnimationControl',c);
    const result=await control(patch);
    assert.ok(Math.abs(result.timeSeconds-expected)<1e-9,JSON.stringify({time,loop,patch,result}));
    assert.equal(result.state,patch.state==='pause' || expected===2 ? 'paused' : 'playing');
  }
});

test('metadata-only peer restore reconciles the molecular clock and waits for its draw',async()=>{
  const {canRestoreLessonPlaybackMetadata}=await import('./lesson-playback-restore.mjs');
  const lessonPlayback={tourId:'lesson',chapterId:'walk',stopped:false,startingScene:{inspection:{}}};
  const playback={id:'clip',chapterId:'walk',state:'playing',timeSeconds:1,speed:1,loop:true,durationSeconds:5};
  const current={inspection:{lessonPlayback,animation:{definition:{version:1},playback}}};
  const incoming=structuredClone(current); Object.assign(incoming.inspection.animation.playback,{state:'paused',timeSeconds:3,speed:.5,loop:false});
  let restored,drawn=false;
  const c=vm.createContext({assertReady(){},validInspectionCapture:value=>value,
    lessonPlayback,canRestoreLessonPlaybackMetadata,completeInspectionCapture:()=>current,detached:structuredClone,
    molecularAnimation:{restore:async value=>{restored=value;return true;}},waitForFrame:async()=>{drawn=true;},snapshot:()=>({}),
  });
  vm.runInContext(pageFunction(source,'restoreInspection'),c);
  await c.restoreInspection(incoming);
  assert.deepEqual(restored,incoming.inspection.animation); assert.equal(drawn,true);
});

test('an animation input fault rejects outstanding draw waits immediately with the original error', () => {
  const calls=[],diagnostics=[],error=Error('Broken animation endpoint');
  const c=vm.createContext({frameWaiters:new Set([value=>calls.push(value),value=>calls.push(value)]),
    recordCost:(kind,detail)=>diagnostics.push({kind,...detail})});
  const start=source.indexOf('    onError: error =>',source.indexOf('const molecularAnimation = createMolecularAnimation'));
  const handler=vm.runInContext('({'+source.slice(start,source.indexOf('    getStructure:',start))+'}).onError',c);
  handler(error);
  assert.deepEqual(calls,[error,error]);
  assert.equal(diagnostics[0].error,error.message);
});
