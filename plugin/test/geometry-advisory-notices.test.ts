import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { geometryBudgetReceiptSchema } from '../src/inspection-contract.js';
// @ts-ignore Shared renderer advisory comparison.
import { geometryBudgetChanged, sourceGeometryBudget } from '../../lab/browser-roundtrip/geometry-advisory.mjs';
const advisory={representation:'spacefill',deviceClass:'quest3',atoms:200000,budget:260000,
  requestedLevel:'high',level:'high',estimatedVertices:10000000,message:'Showing atoms at requested detail; it may run slowly.'};
const source=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('inspector.ts',source,ts.ScriptTarget.Latest,true);
function actualFunction(name:string,context:any) {
  const node=ast.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text===name)!;
  vm.runInContext(ts.transpileModule(node.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
}
it('validates every supported quality/representation exactly like the optional host receipt',()=>{
  for(const representation of ['cartoon','ball-and-stick','molecular-surface','spacefill'])
    for(const level of ['lowest','lower','low','medium','high','higher','highest']) {
      const receipt={...advisory,representation,level,requestedLevel:level};
      expect(geometryBudgetReceiptSchema.parse(sourceGeometryBudget(receipt))).toEqual(receipt);
    }
  for(const patch of [{budget:Infinity},{atoms:NaN},{estimatedVertices:-1},{message:'x'.repeat(121)},{level:'max'}])
    expect(sourceGeometryBudget({...advisory,...patch})).toBeUndefined();
});
it('compares receipt semantics rather than object identity or field order',()=>{
  expect(geometryBudgetChanged(advisory,{...advisory})).toBe(false);
  for(const patch of [{atoms:200001},{representation:'cartoon'},{level:'higher'},{message:'Another warning.'}])
    expect(geometryBudgetChanged(advisory,{...advisory,...patch})).toBe(true);
  expect(geometryBudgetChanged(advisory,undefined)).toBe(false);
});
it('source warning occurs only after a new source or changed advisory and clears below threshold',()=>{
  const events:any[]=[];
  const context=vm.createContext({workspace:undefined,sourceAdvisory:undefined,geometryBudgetChanged,GROWTH_CAPTION_EVENT:'growth',
    CustomEvent:class {constructor(public type:any,public options:any){}},dispatchEvent:(event:any)=>events.push(event)});
  actualFunction('announceSourceGeometryBudget',context);
  context.announceSourceGeometryBudget(advisory,'source-a');
  context.announceSourceGeometryBudget({...advisory},'source-a');expect(events).toHaveLength(1);
  context.announceSourceGeometryBudget(advisory,'source-b');expect(events).toHaveLength(2);
  context.announceSourceGeometryBudget(undefined,'source-b');
  context.announceSourceGeometryBudget(advisory,'source-b');expect(events).toHaveLength(3);
});
it('actual remote confirmation keeps an unchanged color or motion answer while retaining receipt data',()=>{
  const events:any[]=[];
  const context=vm.createContext({replyOnThisBeat:false,isCompanion:true,workspace:{snapshot:()=>({xrPresenting:true})},
    geometryBudgetConfirmation:(applied:any,fallback:any)=>applied?.geometryBudget?.message ?? fallback,
    scopedStyleConfirmation:()=> 'Chain colors.',recordHeadsetEvent:(_kind:any,event:any)=>events.push(event),
    narrationGeneration:0,REMOTE_CONFIRMATIONS:{},SPATIAL_VOICE_ACTIONS:{},
    GROWTH_CAPTION_EVENT:'growth',CustomEvent:class{},dispatchEvent:()=>{},
    voiceCommandSpeaker:()=>undefined});
  actualFunction('speakRemoteConfirmation',context);
  // narrated bypasses the voice transport while exercising the production answer selection.
  const applied={geometryBudget:advisory,geometryBudgetChanged:false};
  context.speakRemoteConfirmation({kind:'styles',patch:{color:'chain-id'}},applied,true);
  context.speakRemoteConfirmation({kind:'motion',patch:{state:'spin'}},applied,true);
  expect(events.map(event=>event.say)).toEqual(['Chain colors.','Spinning.']);
  expect(applied.geometryBudget).toEqual(advisory);
  context.speakRemoteConfirmation({kind:'styles',patch:{}},{geometryBudget:advisory,geometryBudgetChanged:true},true);
  expect(events[2].say).toBe(advisory.message);
});
