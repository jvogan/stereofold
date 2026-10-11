import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from '../../plugin/node_modules/typescript/lib/typescript.js';
const source=readFileSync(new URL('./workspace.mjs',import.meta.url),'utf8');
const ast=ts.createSourceFile('workspace.mjs',source,ts.ScriptTarget.Latest,true);
function closure(name) {
  let found;const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;else ts.forEachChild(node,visit);};visit(ast);
  assert.ok(found);return found.getText(ast);
}
function fixture(options={}) {
  const snapshot={ready:true,inspection:{history:{undoCount:3,redoCount:2}}};
  const controls=new Map();const $=key=>{if(!controls.has(key))controls.set(key,{});return controls.get(key);};
  const h=vm.createContext({options,busy:false,closing:false,queue:Promise.resolve(),viewer:{snapshot:()=>snapshot,readiness:()=>({ready:snapshot.ready})},$,controls});
  vm.runInContext(['sceneHistory','syncSceneHistory','requestSceneHistory'].map(closure).join('\n'),h);return h;
}
test('desktop history uses host availability and disables for busy work, while standalone retains local counts',()=>{
  const local=fixture();local.syncSceneHistory();assert.equal(local.$('[data-action="undo"]').disabled,false);
  const host=fixture({getSceneHistory:()=>({undoCount:1,redoCount:0,canUndo:false,canRedo:false})});
  host.syncSceneHistory();assert.equal(host.$('[data-action="undo"]').disabled,true);
  host.options.getSceneHistory=()=>({undoCount:1,redoCount:1,canUndo:true,canRedo:true});host.busy=true;
  host.syncSceneHistory();assert.equal(host.$('[data-action="redo"]').disabled,true);
});
test('history getter forwards lightweight viewer readiness without requesting another snapshot',()=>{
  let observed;const h=fixture({getSceneHistory:view=>{observed=view;return {undoCount:1,redoCount:0,canUndo:true,canRedo:false};}});
  h.viewer.snapshot=()=>{throw Error('Expensive snapshot forbidden in XR getter');};
  const view={ready:true,interactionActive:false};assert.equal(h.sceneHistory(view).canUndo,true);assert.equal(observed,view);
  h.syncSceneHistory();assert.equal(h.$('[data-action="undo"]').disabled,false);
});
test('host history waits for local queue then lets normal remote drawing use that queue',async()=>{
  const order=[];let drain;const h=fixture();h.queue=new Promise(resolve=>{drain=resolve;});
  h.options.onSceneHistoryAction=async kind=>{order.push(kind);await h.queue.then(()=>order.push('remote draw'));return {command:{status:'rendered'}};};
  const request=h.requestSceneHistory('undo');await Promise.resolve();assert.deepEqual(order,[]);
  order.push('local save');drain();await request;assert.deepEqual(order,['local save','undo','remote draw']);
});
test('desktop history host branch bypasses ui queue and viewer receives optional hooks only',()=>{
  assert.match(source,/if \(options\.onSceneHistoryAction && \(name === 'undo' \|\| name === 'redo'\)\)/);
  assert.match(source,/void requestSceneHistory\(name\)/);
  assert.match(source,/options\.getSceneHistory && options\.onSceneHistoryAction/);
  assert.match(source,/getSceneHistory: view => sceneHistory\(view\), onSceneHistoryAction: requestSceneHistory/);
});
