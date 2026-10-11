import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tourEndHarness } from './fixtures/tour-end-harness.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

const require=createRequire(new URL('../../plugin/package.json',import.meta.url));
const {tsImport}=require('tsx/esm/api');
const {transpileModule,ScriptTarget,ModuleKind}=require('typescript');
const {mountTourPlayer}=await tsImport('../../plugin/src/tour-player.ts',import.meta.url);
const {TOURS}=await tsImport('../../plugin/src/tour-catalog.ts',import.meta.url);
const {applyTourCommand,createPanelTourController,tourHeartbeat}=await tsImport('../../plugin/src/inspection-tour-client.ts',import.meta.url);
const {inspectionRefusalCaption,shouldCaptionInspectionRefusal}=await tsImport('../../plugin/src/inspection-refusal-caption.ts',import.meta.url);
const runtime=await toolbarFrameRuntime();
const inspector=readFileSync(new URL('../../plugin/src/inspector.ts',import.meta.url),'utf8');

test('model-started Fold Detective drives the drawn transport rows, chapter, narration and menu Done',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=tourEndHarness(),spoken=[];
  const lesson=mountTourPlayer({...h,tours:TOURS,narrate:line=>spoken.push(line)});
  const idle={...lesson,getState:()=>({...lesson.getState(),tours:[],active:false,step:-1,total:0}),subscribe:()=>()=>{}};
  const panel=createPanelTourController(lesson,idle);
  try{
    const baseline=h.capture();
    await applyTourCommand(panel,{action:'start',tourId:'fold-detective'});
    await applyTourCommand(panel,{action:'pause'});
    const state=panel.getState();
    assert.equal(state.active,true);assert.equal(state.selectedId,'fold-detective');
    assert.deepEqual(tourHeartbeat(panel),tourHeartbeat(lesson));
    let rows=spatialToolbarRows({tour:state,voice:{state:'idle'},collapsed:false});
    const kinds=rows.map(row=>row.action.kind);
    assert.ok(kinds.includes('tour-next'));assert.ok(kinds.includes('tour-done'));assert.ok(kinds.includes('tour-page'));
    assert.equal(rows.find(row=>row.action.kind==='tour-play').label,'Play');
    const readout=runtime.tourReadout(state,{},state.chapterStartedAt);
    assert.ok(readout.some(row=>row.text.includes(state.title)));
    assert.ok(readout.some(row=>row.text.includes(state.bodyPage)));
    assert.ok(spoken.length>0);assert.equal(spoken.at(-1),TOURS[0].steps[state.step].body);
    await panel.next();
    rows=spatialToolbarRows({tour:panel.getState(),voice:{state:'idle'},collapsed:false});
    assert.ok(rows.some(row=>row.action.kind==='tour-back'));
    await h.dispatchDone(panel);
    assert.equal(tourHeartbeat(panel).active,false);
    assert.deepEqual(h.capture(),baseline);
    assert.equal(h.restores.at(-1).preserveCamera,true);
    assert.match(inspector,/setSpatialTour\(panelTour\)/);
    assert.doesNotMatch(inspector,/tourHeartbeat\(tourPlayer\)/);
  }finally{panel.pause();panel.dispose();h.cleanup();}
});

test('autoplay refreshes its saved binding before navigation and never detaches an already replaced source',async()=>{
  const start=inspector.indexOf('async function navigateExperience(');
  const end=inspector.indexOf('\n}\n',start)+2;
  const source=transpileModule(inspector.slice(start,end),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.None}}).outputText;
  const posts=[];
  const context=vm.createContext({Promise,Error,Date,
    binding:{sessionId:'session',sourceToken:'source-1',serverEpoch:'epoch',stateRevision:1,inspectionRevision:1},panelId:'owner',
    dirty:false,blocked:false,loading:false,remote:false,generation:0,tourCommandContext:undefined,experienceSourceChanged:false,experiencePreparing:false,journeySave:undefined,sourceReplacement:false,
    thrownErrorMessage:error=>error.message,
    panelTour:undefined,tourHeartbeat:()=>undefined,experienceView:undefined,PRIVATE_KEY:'private',
    // No XR session here, so there is no recovery frame to capture.
    workspace:{snapshot:()=>({interactionActive:false}),viewer:{inspection:{}}},save:async()=>{},attach:async()=>{},
    rendering:Promise.resolve(),expected:()=>({sourceToken:context.binding.sourceToken,baseStateRevision:1,baseInspectionRevision:context.binding.inspectionRevision}),
    call:async(name,args)=>{
      posts.push(name);
      assert.equal(args.sourceToken,context.binding.sourceToken);
      if(name==='poll_inspection')return {structuredContent:{attached:true,sourceToken:args.sourceToken,stateRevision:1,inspectionRevision:args.baseInspectionRevision}};
      assert.equal(name,'navigate_experience');
      return {structuredContent:{experienceTransition:{sourceChanged:true}}};
    },
    hydrate:async()=>{
      // Execute the inspector's actual detach decision after the host has
      // retargeted its bearer. Posting an old-source detach would be HTTP 409.
      const branchStart=inspector.indexOf('    if((journeySave && panelId===journeySave.panelId)');
      const branchEnd=inspector.indexOf("  else await detach('loading');",branchStart)+"  else await detach('loading');".length;
      assert.ok(branchStart>=0);
      context.document={body:{dataset:{panelId:'owner'}}};
      context.detach=()=>assert.fail('old-source detach would always be refused');
      await vm.runInContext(`(async()=>{${inspector.slice(branchStart,branchEnd)}})()`,context);
      context.panelId='owner';context.binding.sourceToken=`source-${posts.length}`;context.binding.inspectionRevision++;
    },
  });
  vm.runInContext(source,context);
  for(let step=0;step<20;step++)await context.navigateExperience('journey',step);
  assert.equal(posts.length,40);
  assert.deepEqual(posts,Array.from({length:20},()=>['poll_inspection','navigate_experience']).flat());
});

test('a legitimate HTTP 409 keeps the host hint in the page log and plain language in the wearer caption',async()=>{
  const start=inspector.indexOf('async function call('),end=inspector.indexOf('\n}\n',start)+2;
  const source=transpileModule(inspector.slice(start,end),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.None}}).outputText;
  const reason='The spoken line belongs to a replaced source. Read get_inspection_state.';
  const wearerReason='The spoken line belongs to a replaced source. Try again with the current view.';
  const logs=[],captions=[],warnings=[];
  const context=vm.createContext({Error,tourCommandContext:undefined,loading:false,experiencePreparing:false,experiencePlayer:undefined,binding:undefined,inspectionRefusalCaption,shouldCaptionInspectionRefusal,
    sceneHistoryClient:{requestStarted:()=>1,note:()=>assert.fail('A refused call cannot publish history')},
    companionCall:async()=>{throw Object.assign(Error(reason),{status:409,code:'companion_request'});},
    thrownErrorMessage:error=>error.message,callStatus:error=>error.status,
    recordHeadsetEvent:(kind,detail)=>logs.push({kind,detail}),showHeadsetCaption:line=>captions.push(line),
    console:{warn:line=>warnings.push(line)},
  });
  vm.runInContext(source,context);
  await assert.rejects(context.call('voice_acknowledgement',{}),error=>error.message===wearerReason && error.status===409);
  assert.deepEqual(JSON.parse(JSON.stringify(logs)),[{kind:'tool-refused',detail:{tool:'voice_acknowledgement',status:409,reason,
    captioned:true,journeyPending:false,staleBinding:false}}]);
  assert.deepEqual(captions,[wearerReason]);assert.deepEqual(warnings,[`voice_acknowledgement: ${reason}`]);
});
