import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fixture } from './fixtures/appearance-transaction-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
const viewer = readFileSync(process.env.APPEARANCE_VIEWER_SOURCE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
const noop = () => {};
const figure = { layers: [{ id: 'protein', target: { chain: 'A', residues: { from: 1, to: 20 } }, representation: 'cartoon', color: '#25859b', opacity: 1 }, { id: 'envelope', target: { chain: 'A', residues: { from: 1, to: 20 } }, representation: 'gaussian-surface', color: '#60b4c1', opacity: .14 }], labels: [], distances: [] };
test('real appearance restore preserves authored figure through a staged base replacement',async()=>fixture(async c=>{
  await c.lessonFigure.install(figure);
  await c.applyInspectionAppearance({preservePlacement:true});
  assert.equal(c.representation.cell.status,'ok');
  assert.equal(c.lessonFigure.count(),2);
  assert.equal(c.lessonFigure.molecular()[1].props.alpha,.14);
}));


test('source rollback waits for the rebuilt live selector while preserving the retained source',async()=>fixture(async c=>{
  await c.lessonFigure.install(figure);
  const previous={structure:c.structure,representation:c.representation,styles:[],visibility:{}};
  Object.assign(c,{ normalizeStyles:v=>v,normalizeVisibility:v=>v,deleteRecord:async()=>{},removeFrameCover:noop,
    adopt:record=>{c.structure=record.structure;c.representation=record.representation;},restoreRecord:async()=>{},
  });
  c.state.contextLossCount=0;
  vm.runInContext(pageFunction(viewer,'rollbackLoad'),c);
  await c.rollbackLoad({previous,contextLossCount:0,inspectionCheckpoint:c.inspectionState.checkpoint()},Error('candidate source rejected'));
  assert.throws(()=>previous.representation.checkValid(),/Not created at all/);
  assert.notEqual(c.representation.ref,previous.representation.ref);
  assert.equal(c.structure,previous.structure);
  assert.equal(c.representation.checkValid(),true);
  assert.equal(c.state.status,'ready');
  assert.equal(c.state.lastLoadFailure.recovered,true);
  assert.equal(c.lessonFigure.molecular()[1].props.alpha,.14);
}));

test('frame validation diagnoses a stale selector without losing the original error',async()=>fixture(async c=>{
  const stale={structure:c.structure,representation:c.representation};
  await c.applyInspectionAppearance({preservePlacement:true});
  const events=[];
  c.__stereofoldDiagnostics={record:(kind,detail)=>events.push({kind,detail})};
  await assert.rejects(c.waitForFrame(stale),/Not created at all/);
  assert.equal(events.length,1);
  assert.equal(events[0].kind,'frame-record-failure');
  assert.equal(events[0].detail.expectedRepresentationRef,stale.representation.ref);
  assert.equal(events[0].detail.expectedRepresentationPresent,false);
  assert.equal(events[0].detail.currentRepresentationRef,c.representation.ref);
  assert.equal(events[0].detail.currentRepresentationPresent,true);
}));

test('context recovery validates the rebuilt selector rather than its deleted pre-loss representation',async()=>fixture(async c=>{
  await c.lessonFigure.install(figure);
  const previous={structure:c.structure,representation:c.representation};
  Object.assign(c,{recoveryRecord:previous,activeWork:undefined,recoveryPromise:undefined,candidateRecords:new Set(),motionContextPaused:true,
    // XR is already closed during recovery. Rebuild the retired selector in
    // restoreRecord, as production does, rather than relying on XR staging
    // inside the later appearance update to happen to replace it.
    removeInspectionLabels:async()=>{},removeLigandOverlay:async()=>{},removeComponentLabels:async()=>{},restoreRecord:async record=>{
      c.canvas.remove(record.representation.obj.data.repr);
      await c.plugin.build().delete(record.representation.ref).commit();
      c.representation=await c.plugin.build().to(c.structure).apply(c.StateTransforms.Representation.StructureRepresentation3D,
        c.createStructureRepresentationParams(c.plugin,c.structure.obj.data,{type:'spacefill',color:'uniform',typeParams:{quality:'low'}})).commit();
      c.canvas.add(c.representation.obj.data.repr);
      return {...record,representation:c.representation};
    },
    syncPresentationMotion:noop,removeFrameCover:noop,emit:noop,onMutation:noop,
  });
  c.canvas.webgl.xr ??= { session: undefined };
  c.immersiveSession = { ...c.immersiveSession, end: async () => { c.canvas.xr.isPresenting.value=false; c.canvas.webgl.xr.session=undefined; } };
  c.plugin.animationLoop = { isAnimating: true, stop() {} }; c.canvas.requestResize=()=>{};
  c.state.contextLossCount=1;c.state.contextRestorationCount=0;
  vm.runInContext(pageFunction(viewer,'contextRestored'),c);
  c.contextRestored();
  await c.recoveryPromise;
  assert.throws(()=>previous.representation.checkValid(),/Not created at all/);
  assert.equal(c.representation.checkValid(),true);
  assert.equal(c.structure,previous.structure);
  assert.equal(c.state.status,'ready');
  assert.equal(c.state.contextRestorationCount,1);
  assert.equal(c.lessonFigure.count(),2);
}));

for (const route of ['frame', 'appearance']) {
  test(`${route} failure diagnostics redact authenticated URLs but retain causal stack locations`,async()=>fixture(async c=>{
    const events=[];
    c.__stereofoldDiagnostics={record:(kind,detail)=>events.push({kind,detail})};
    const error=Error('Failed at https://user:secret@example.test/view?token=private#session');
    error.stack='Error: failed\n    at selector (https://user:secret@example.test/view?token=private#session:13:579)\n    at renderer (wss://example.test/socket?token=private:92:17)';
    let operation;
    if(route==='frame') {
      c.checkDrawnRecord=()=>{throw error;};
      operation=c.waitForFrame();
    } else {
      c.prepareUploads=async()=>{throw error;};
      operation=c.applyInspectionAppearance({preservePlacement:true});
    }
    await assert.rejects(operation, actual=>actual===error, 'the original error remains the caller outcome');
    assert.equal(events.length,1);
    assert.equal(events[0].kind,route==='frame'?'frame-record-failure':'appearance-failure');
    assert.equal(events[0].detail.message,'Failed at <runtime>');
    assert.match(events[0].detail.stack,/selector \(<runtime>:13:579\)/u);
    assert.match(events[0].detail.stack,/renderer \(<runtime>:92:17\)/u);
    assert.doesNotMatch(JSON.stringify(events),/secret|token=|private|example\.test|https:|wss:/u);
    assert.equal(c.representation.checkValid(),true, 'diagnostic failure does not retire the live base');
  }));
}

test('native re-entry draws the complete figure without counting the withheld old primary',async()=>fixture(async c=>{
  await c.lessonFigure.install(figure);
  const previous=c.representation;
  Object.assign(c,{retainedPoseHidden:false,scientificRepresentations:()=>[c.representation.obj.data.repr,...c.lessonFigure.molecular()],
    awaitPlacementViews:async()=>{},clearHeldPlatePlacement:async p=>p,recordManipulation:noop,
  });
  c.immersiveSession.platePoints=()=>[{}];
  for(const name of ['hideRetainedPose','showRetainedPose']) vm.runInContext(pageFunction(viewer,name),c);
  c.hideRetainedPose();
  assert.equal(c.canvas.reprCount.value,0,'entry withholds the actual old primary and figure');
  const counts=[];
  const drawn=c.canvas.requestDraw;
  c.canvas.requestDraw=()=>{counts.push([c.scientificRepresentationCount(),c.canvas.reprCount.value]);drawn();};
  await c.onXrPresented();
  assert.deepEqual(counts,[[3,3],[3,3],[3,3]],'both staging gates and entry completion require the complete actual scene');
  assert.equal(c.lessonFigure.count(),2);
  assert.equal(c.lessonFigure.molecular()[1].props.alpha,.14);
  assert.equal(c.representation.checkValid(),true);
  assert.throws(()=>previous.checkValid(),/Not created at all/);
  assert.equal(c.retainedRepresentationCount,0);
  assert.equal(c.retainedPoseHidden,false);
}));

test('entry appearance owns admission and release work until its final draw',async()=>fixture(async c=>{
  let resume, entered;
  const preparing=new Promise(r=>{entered=r;});
  c.prepareUploads=async()=>{entered();await new Promise(r=>{resume=r;});};
  const operation=c.onXrPresented();
  await preparing;
  assert.equal(c.busy,true);
  assert.equal(c.canManipulateNow(),false,'even ready/mutating status cannot admit a grip against temporary selectors');
  c.state.status='mutating';assert.equal(c.canManipulateNow(),false);c.state.status='ready';
  assert.throws(()=>c.assertReady(),e=>e.code==='viewer_busy');
  await assert.rejects(c.applyInspectionAppearance(),e=>e.code==='viewer_busy');
  const work=c.activeWork;
  let released=false;work.done.then(()=>{released=true;});
  await Promise.resolve();assert.equal(released,false);
  resume();await operation;await work.done;
  assert.equal(c.busy,false);assert.equal(c.appearanceWork,undefined);
  assert.equal(c.canManipulateNow(),true);assert.equal(c.activeWork,undefined);
  assert.doesNotThrow(()=>c.assertReady());
}));

test('rollback cancels candidate-bound frame waiters before deleting their real Molstar selector',async()=>fixture(async c=>{
  const previous=c.representation, cause=Error('clearance rejected');
  let staged, waiter;
  c.paintVisibilityLayers=async()=>{
    staged=c.representation;
    c.canvas.requestDraw=noop;
    waiter=c.waitForFrame().catch(error=>error);
    throw cause;
  };
  await assert.rejects(c.applyInspectionAppearance(),e=>e===cause);
  const outcome=await waiter;
  assert.equal(outcome.code,'appearance_cancelled');
  assert.doesNotMatch(outcome.message,/Not created/);
  assert.throws(()=>staged.checkValid(),/Not created at all/);
  assert.equal(c.representation,previous);
  assert.equal(previous.checkValid(),true);
  assert.equal(c.retainedRepresentationCount,0);
  assert.equal(c.frameWaiters.size,0);
  assert.equal(c.busy,false);
  assert.equal(c.canManipulateNow(),true);
}));

test('a preexisting mutation waiter receives rollback cancellation without poisoning the retained viewer',async()=>fixture(async c=>{
  const previous=c.representation;
  let published, fail, releaseDelete;
  const deleting=new Promise(resolve=>{releaseDelete=resolve;});
  const originalBuild=c.plugin.state.data.build.bind(c.plugin.state.data);
  c.plugin.state.data.build=()=>{
    const builder=originalBuild(), remove=builder.delete.bind(builder), commit=builder.commit.bind(builder);
    builder.delete=(...args)=>{remove(...args);builder.commit=async options=>{await deleting;return commit(options);};return builder;};
    return builder;
  };
  const stagedReady=new Promise(r=>{published=r;});
  const failStage=new Promise(r=>{fail=r;});
  c.paintVisibilityLayers=async()=>{published();await failStage;throw Error('staging rejected');};
  Object.assign(c,{interactionActive:()=>false,motionMutationPaused:false,motionToolPaused:false,syncPresentationMotion:noop,
    recordRenderCost:noop,emit:noop,onMutation:noop});
  vm.runInContext(pageFunction(viewer,'mutate'),c);
  let appearance;
  const mutation=c.mutate('inspection',async()=>{
    // Exercise an already-owned operation with an independent candidate waiter,
    // the overlap that existed before session-edge admission was serialized.
    appearance=c.applyInspectionAppearance().catch(error=>error);
    await stagedReady;
    c.canvas.requestDraw=noop;
    const waiter=c.waitForFrame();
    fail();
    return waiter;
  });
  await assert.rejects(mutation,e=>e.code==='appearance_cancelled');
  assert.ok(c.appearanceWork,'rollback retains ownership after the canceled mutation releases busy');
  assert.equal(c.canManipulateNow(),false);
  assert.throws(()=>c.assertReady(),e=>e.code==='viewer_busy');
  releaseDelete();
  assert.match((await appearance).message,/staging rejected/);
  assert.equal(c.state.status,'ready');
  assert.equal(c.state.error,undefined);
  assert.equal(c.representation,previous);
  assert.equal(previous.checkValid(),true);
  assert.equal(c.frameWaiters.size,0);
  assert.equal(c.canManipulateNow(),true);
}));

for (const volume of [false,true]) test(`standalone ${volume?'density':'unchanged molecular'} appearance keeps admission closed through its final draw`,async()=>fixture(async c=>{
  if(!volume) await c.applyInspectionAppearance({preservePlacement:true});
  let release, entered;
  const waiting=new Promise(r=>{entered=r;});
  const frame=new Promise(r=>{release=r;});
  c.waitForFrame=async()=>{entered();await frame;};
  if(volume){c.volume={};c.applyVolumeAppearance=async()=>{};}
  const operation=c.applyInspectionAppearance({preservePlacement:true});
  await waiting;
  assert.equal(c.busy,true);assert.equal(c.canManipulateNow(),false);
  assert.throws(()=>c.assertReady(),e=>e.code==='viewer_busy');
  release();await operation;
  assert.equal(c.busy,false);assert.equal(c.canManipulateNow(),true);
}));

test('a retained pose revealed before staged adoption remains counted until the replacement-only draw',async()=>fixture(async c=>{
  await c.lessonFigure.install(figure);
  Object.assign(c,{scientificRepresentations:()=>[c.representation.obj.data.repr,...c.lessonFigure.molecular()]});
  for(const name of ['hideRetainedPose','showRetainedPose'])vm.runInContext(pageFunction(viewer,name),c);
  c.hideRetainedPose();
  c.prepareUploads=async()=>{c.showRetainedPose();};
  const counts=[],drawn=c.canvas.requestDraw;
  c.canvas.requestDraw=()=>{counts.push([c.scientificRepresentationCount(),c.canvas.reprCount.value]);drawn();};
  await c.onXrPresented();
  assert.deepEqual(counts,[[4,4],[3,3],[3,3]]);
  assert.equal(c.retainedRepresentationCount,0);
}));

test('actual upload pacing waits for a fresh draw without requiring a captured representation record',async()=>fixture(async c=>{
  vm.runInContext(pageFunction(viewer,'yieldUploadFrame'),c);
  await c.yieldUploadFrame(performance.now()+1000);
  assert.equal(c.frameWaiters.size,0);
  assert.ok(c.state.drawCount>0);
}));
