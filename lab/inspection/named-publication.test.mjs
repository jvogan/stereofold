import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createNamedPublication} from './named-publication.mjs';
import {captureNamedView,restoreNamedView} from './named-view.mjs';

// Execute the production workspace queue, callback and exported hook bodies.
// A callback-free renderer stub would miss the original pre-confirmation leak.
const source=readFileSync(new URL('./workspace.mjs',import.meta.url),'utf8');
const runSource=source.slice(source.indexOf('function run('),source.indexOf('\nfunction ui('));
const mutation=source.match(/onMutation: snapshot => (\{ sync\(snapshot\);[\s\S]*?namedPublication\.mutation\(snapshot\); \})/)[1];
const capture=source.match(/^  captureNamedView:([^\n]+),$/m)[1];
const restore=source.match(/^  restoreNamedView:([^\n]+),$/m)[1];
function fixture(failure) {
  const events=[],initial={sourceSha256:'x',modelNumber:1,assemblyId:'1',selectionKeys:['a'],inspection:{appearance:{color:'blue'},placement:{scale:1}}};
  const target=structuredClone(initial);target.inspection.placement.scale=2;
  let current=structuredClone(initial),calls=0,hooks;
  const viewer={snapshot:()=>({xrPresenting:true}),inspection:{capture:()=>structuredClone(current),beginOperation:()=>0,endOperation:()=>{},rollbackOperation:()=>{},
    restore:async(scene)=>{calls++;if(failure==='rollback'&&calls===2)throw Error('context lost');current=structuredClone(scene);
      if(failure==='mismatch'&&calls===1)current.inspection.placement.scale=3;
      hooks.onMutation(structuredClone(current));},
  }};
  const options={onMutation:s=>events.push(['mutation',s.inspection.placement.scale]),onSettled:()=>events.push(['settled'])};
  hooks=new Function('viewer','options','createNamedPublication','captureNamedView','restoreNamedView',`
    let queue=Promise.resolve(),closing=false,busy=false;
    const $$=()=>[],moleculeCanvas={style:{}},setStatus=()=>{},sync=()=>{};
    const namedPublication=createNamedPublication(snapshot=>options.onMutation?.(snapshot));
    ${runSource}
    return {onMutation:snapshot=>${mutation},capture:${capture},restore:${restore},ordinary:()=>run('ordinary',()=>{})};
  `)(viewer,options,createNamedPublication,captureNamedView,restoreNamedView);
  return {hooks,target,events};
}
for(const failure of ['mismatch','confirmation','rollback']) test(`production named transaction never publishes on ${failure} failure`,async()=>{
  const {hooks,target,events}=fixture(failure);
  await assert.rejects(hooks.restore(target,()=>{},()=>{assert.deepEqual(events,[]);throw Error('unconfirmed');}));
  assert.deepEqual(events,[],'neither intermediate mutation nor onSettled can schedule a save');
  await hooks.ordinary();assert.deepEqual(events,[['settled']],'normal queue publication recovers');
});
test('production named restore publishes one final snapshot only after confirmation',async()=>{
  const {hooks,target,events}=fixture();let confirmed=false;
  await hooks.restore(target,()=>{},()=>{assert.deepEqual(events,[]);confirmed=true;});
  assert.ok(confirmed);assert.deepEqual(events,[['mutation',2]]);
});
test('production named capture publishes neither mutation nor settled save callback',async()=>{
  const {hooks,events}=fixture();await hooks.capture(()=>{},()=>{});assert.deepEqual(events,[]);
});
