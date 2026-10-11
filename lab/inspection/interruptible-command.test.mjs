import { geometryBudgetChanged } from '../browser-roundtrip/geometry-advisory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptibleCommand } from './interruptible-command.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture() {
  let scene={selectionKeys:['X'],inspection:{appearance:{opacity:1}}},restores=0;
  const viewer={snapshot:()=>({xrPresenting:true}),inspection:{
    capture:()=>structuredClone(scene),
    restore:async(value,options)=>{assert.equal(options.preserveCamera,true);scene=structuredClone(value);restores++;},
    beginOperation:()=>({}),endOperation:()=>{},rollbackOperation:()=>{},
  }};
  return {viewer,get scene(){return scene;},set scene(value){scene=value;},get restores(){return restores;}};
}
const cancelled=()=>Object.assign(Error('Superseded by the correction.'),{code:'superseded'});
test('V22: a queued superseded command awaits admission and never mutates',async()=>{
  const t=fixture(),gate=deferred();let mutations=0;
  const running=interruptibleCommand(t.viewer,async()=>{await gate.promise;throw cancelled();},async()=>{mutations++;});
  assert.equal(mutations,0);gate.resolve();
  await assert.rejects(running,/Superseded/);
  assert.equal(mutations,0);assert.equal(t.restores,0);
});
test('V23: cancellation during render rolls back before releasing the workspace queue',async()=>{
  const t=fixture(),before=t.scene;
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{
    t.scene={selectionKeys:['Y'],inspection:{appearance:{opacity:0.2}}};throw cancelled();
  }),/Superseded/);
  assert.deepEqual(t.scene,before);assert.equal(t.restores,1);
});
test('race: late first render restores before a correction queued 100 ms later can mutate',async()=>{
  const t=fixture(),gate=deferred();let clock=0,superseded=false,confirmed=0;
  const first=interruptibleCommand(t.viewer,async()=>{},async()=>{
    await gate.promise;t.scene={selectionKeys:['old'],inspection:{appearance:{opacity:0.1}}};
    if(superseded) throw cancelled();confirmed++;
  });
  await Promise.resolve();clock+=100;superseded=true;
  const second=first.catch(()=>{}).then(()=>interruptibleCommand(t.viewer,async()=>{
    assert.equal(clock,100);assert.deepEqual(t.scene.selectionKeys,['X']);
  },async()=>{t.scene={selectionKeys:['new'],inspection:{appearance:{opacity:0.8}}};confirmed++;}));
  gate.resolve();await second;
  assert.deepEqual(t.scene.selectionKeys,['new']);assert.equal(confirmed,1);assert.equal(t.restores,1);
});
test('failed cancellation recovery remains an error and does not claim rollback',async()=>{
  const t=fixture();t.viewer.inspection.restore=async()=>{throw Error('context lost');};
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{throw cancelled();}),/could not restore the previous view/);
});
test('an unrelated render failure keeps the existing refusal and recovery semantics',async()=>{
  const t=fixture();await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{throw Error('unsupported');}),/unsupported/);
  assert.equal(t.restores,0);
});

// Execute the exported production hook so publication cannot escape the queue.
import {readFileSync} from 'node:fs';
import {createNamedPublication} from './named-publication.mjs';
const workspaceSource=readFileSync(new URL('./workspace.mjs',import.meta.url),'utf8');
const remoteSource=workspaceSource.slice(workspaceSource.indexOf('  applyRemote:')+'  applyRemote:'.length,workspaceSource.lastIndexOf('\n});')).trim().replace(/,$/,'');
test('production applyRemote holds mutation publication and rolls back a superseded confirmation',async()=>{
  const t=fixture(),events=[];
  const publication=createNamedPublication(s=>events.push(s));
  t.viewer.inspection.configure=async patch=>{t.scene.inspection.appearance={...t.scene.inspection.appearance,...patch};publication.mutation(t.scene);};
  const restore=t.viewer.inspection.restore;
  t.viewer.inspection.restore=async(...args)=>{await restore(...args);publication.mutation(t.scene);};
  const applyRemote=new Function('run','namedPublication','interruptibleCommand','viewer','geometryBudgetChanged',`return (${remoteSource});`)(
    async(_message,action,options)=>{assert.equal(options.publishSettled,false);return action();},publication,interruptibleCommand,t.viewer,geometryBudgetChanged);
  await assert.rejects(applyRemote({kind:'appearance',patch:{opacity:0.5}},async()=>{},async()=>{
    assert.deepEqual(events,[]);throw cancelled();
  }),/Superseded/);
  assert.deepEqual(events,[]);assert.equal(t.scene.inspection.appearance.opacity,1);
  await applyRemote({kind:'appearance',patch:{opacity:0.8}},async()=>{},async()=>{assert.deepEqual(events,[]);});
  assert.equal(events.length,1);assert.equal(events[0].inspection.appearance.opacity,0.8);
});

test('rollback notification and the next command wait for the final asynchronous undo rebuild',async()=>{
  const t=fixture(), rebuilding=deferred(), release=deferred(), events=[];
  t.viewer.inspection.rollbackOperation=async()=>{
    rebuilding.resolve();await release.promise;events.push('rollback-frame');
  };
  const first=interruptibleCommand(t.viewer,async()=>{},async()=>{
    t.scene.inspection.appearance.opacity=.2;throw cancelled();
  },()=>events.push('rolled-back'));
  const rejected=assert.rejects(first,/Superseded/);
  const third=first.catch(()=>{}).then(()=>events.push('third-command'));
  await rebuilding.promise;assert.deepEqual(events,[]);
  release.resolve();await rejected;await third;
  assert.deepEqual(events,['rollback-frame','rolled-back','third-command']);
});

test('a rejected asynchronous undo rebuild never reports rollback or leaks a rejection',async()=>{
  const t=fixture();let reported=false;
  t.viewer.inspection.rollbackOperation=async()=>{throw Error('undo geometry failed');};
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{throw cancelled();},()=>{reported=true;}),
    /could not restore the previous view/);
  assert.equal(reported,false);
});

test('an unadmitted superseded command reports settlement without touching the renderer',async()=>{
  const t=fixture();let reported=0;
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{throw cancelled();},()=>assert.fail('must not render'),()=>{reported++;}),/Superseded/);
  assert.equal(reported,1);assert.equal(t.restores,0);
});

test('rollback preserves unchanged motion and quality without starting redundant rebuilds',async()=>{
  const t=fixture();
  t.viewer.inspection.getMotion=()=>({paused:false});
  t.viewer.inspection.renderQuality=()=> 'balanced';
  t.viewer.inspection.setMotion=()=>assert.fail('unchanged motion');
  t.viewer.inspection.setRenderQuality=()=>assert.fail('unchanged quality');
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{throw cancelled();}),/Superseded/);
});

test('motion diagnostics changing from immersive to tool do not issue a pause command', async () => {
  const t=fixture();let reason='immersive';
  t.viewer.inspection.getMotion=()=>({paused:true,reason,rateDegreesPerSecond:6});
  t.viewer.inspection.setMotion=()=>assert.fail('Diagnostic changes are not motion edits.');
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{
    reason='tool';throw cancelled();
  }),/Superseded/);
  assert.equal(t.restores,1);
});

test('restoring changed motion sends only the setter accepted pause field', async () => {
  const t=fixture();let paused=false;const requests=[];
  t.viewer.inspection.getMotion=()=>({paused,reason:paused?'tool':'playing',rateDegreesPerSecond:6});
  t.viewer.inspection.setMotion=async value=>{
    assert.deepEqual(Object.keys(value),['paused']);requests.push(value);paused=value.paused;
  };
  await assert.rejects(interruptibleCommand(t.viewer,async()=>{},async()=>{
    paused=true;throw cancelled();
  }),/Superseded/);
  assert.deepEqual(requests,[{paused:false}]);assert.equal(paused,false);
});

test('history delivery preserves placement through appearance, placement and compound rendering',async()=>{
  const t=fixture(),seen=[];
  t.scene.inspection.placement={translation:[1,2,3],rotation:[4,5,6],scale:2};
  t.viewer.inspection.configure=async(patch,options)=>{seen.push(['appearance',options]);};
  t.viewer.inspection.place=async(patch,action,options)=>{seen.push(['placement',options]);t.scene.inspection.placement=patch;};
  t.viewer.inspection.compound=async(change,options)=>{seen.push(['compound',options]);};
  const applyRemote=new Function('run','namedPublication','interruptibleCommand','viewer','geometryBudgetChanged',`return (${remoteSource});`)(
    async(_message,action)=>action(),createNamedPublication(()=>{}),interruptibleCommand,t.viewer,geometryBudgetChanged);
  const options={preservePlacement:true};
  for(const change of [{kind:'appearance',patch:{opacity:.5}},
    {kind:'placement',patch:{translation:[4,3,2],rotation:[1,2,3],scale:1.5}},
    {kind:'compound',patch:{ops:[{kind:'appearance',patch:{opacity:.8}},{kind:'placement',patch:{scale:1.4}}]}}])
    await applyRemote(change,async()=>{},async()=>{},undefined,options);
  assert.deepEqual(seen,[['appearance',options],['placement',options],['compound',options]]);
});

test('unscoped remote representation choices explicitly reach the visible scene and retain history placement options',async()=>{
  const t=fixture(),seen=[];
  t.viewer.inspection.configure=async(patch,options)=>{seen.push(['appearance',options]);};
  t.viewer.inspection.compound=async(change,options)=>{seen.push(['compound',options]);};
  const applyRemote=new Function('run','namedPublication','interruptibleCommand','viewer','geometryBudgetChanged',`return (${remoteSource});`)(
    async(_message,action)=>action(),createNamedPublication(()=>{}),interruptibleCommand,t.viewer,geometryBudgetChanged);
  const options={preservePlacement:true};
  await applyRemote({kind:'appearance',patch:{representation:'spacefill'}},async()=>{},async()=>{},undefined,options);
  await applyRemote({kind:'compound',patch:{ops:[{kind:'appearance',patch:{representation:'ball-and-stick'}},
    {kind:'selection',patch:{selectionKeys:[]}}]}},async()=>{},async()=>{},undefined,options);
  assert.deepEqual(seen,[['appearance',{...options,sceneRepresentation:true}],['compound',{...options,sceneRepresentation:true}]]);
});

test('production applyRemote retains advisory state but marks unchanged color confirmations without warning',async()=>{
  const t=fixture(),receipt={representation:'spacefill',atoms:200000,budget:260000,estimatedVertices:10000000,
    deviceClass:'quest3',requestedLevel:'high',level:'high',message:'Showing atoms at requested detail; it may run slowly.'};
  let budget=receipt;
  t.viewer.snapshot=()=>({xrPresenting:true,applied:{geometryBudget:budget}});
  t.viewer.inspection.configure=async patch=>{if(patch.representation==='cartoon')budget={...receipt,representation:'cartoon'};};
  const applyRemote=new Function('run','namedPublication','interruptibleCommand','viewer','geometryBudgetChanged',`return (${remoteSource});`)(
    async(_message,action)=>action(),createNamedPublication(()=>{}),interruptibleCommand,t.viewer,geometryBudgetChanged);
  const outcomes=[];
  await applyRemote({kind:'appearance',patch:{color:'chain-id'}},async()=>{},async(_scene,applied)=>{outcomes.push(applied);});
  await applyRemote({kind:'appearance',patch:{representation:'cartoon'}},async()=>{},async(_scene,applied)=>{outcomes.push(applied);});
  assert.equal(outcomes[0].geometryBudgetChanged,false);assert.deepEqual(outcomes[0].geometryBudget,receipt);
  assert.equal(outcomes[1].geometryBudgetChanged,true);assert.equal(outcomes[1].geometryBudget.representation,'cartoon');
});
