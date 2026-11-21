import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require=createRequire(new URL('../../plugin/package.json',import.meta.url));
const {tsImport}=require('tsx/esm/api');
const {transpileModule,ScriptTarget,ModuleKind}=require('typescript');
const {inspectionRefusalCaption,shouldCaptionInspectionRefusal}=await tsImport('../../plugin/src/inspection-refusal-caption.ts',import.meta.url);
const {resolveDemoName}=await tsImport('../../plugin/src/demo-names.ts',import.meta.url);
const inspector=readFileSync(new URL('../../plugin/src/inspector.ts',import.meta.url),'utf8');
const index=JSON.parse(readFileSync(new URL('../../plugin/demos/index.json',import.meta.url),'utf8'));
const refusalFor=asked=>{try{resolveDemoName(index.demos,asked);}catch(error){return error.message;}assert.fail(`${asked} opened a demo`);};

// The page's own call path, as the HTTP 409 test in tour-menu-state pins it:
// the page log keeps the host's whole sentence, the wearer reads the short one.
for(const [asked,wearerReason] of [['frobnicate','No demo is called “frobnicate”.'],['microtubule','More than one demo matches “microtubule”.']])
test(`a refused demo name "${asked}" keeps its candidates in the page log and one plain sentence on the plate`,async()=>{
  const start=inspector.indexOf('async function call('),end=inspector.indexOf('\n}\n',start)+2;
  const source=transpileModule(inspector.slice(start,end),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.None}}).outputText;
  const reason=refusalFor(asked);
  assert.match(reason,asked==='frobnicate'?/Available: .*telomerase-haca/u:/microtubule-arrival \(/u);
  const logs=[],captions=[],warnings=[];
  const context=vm.createContext({Error,tourCommandContext:undefined,loading:false,experiencePreparing:false,experiencePlayer:undefined,binding:undefined,inspectionRefusalCaption,shouldCaptionInspectionRefusal,
    sceneHistoryClient:{requestStarted:()=>1,note:()=>assert.fail('A refused call cannot publish history')},
    companionCall:async()=>{throw Object.assign(Error(reason),{status:409,code:'companion_request'});},
    thrownErrorMessage:error=>error.message,callStatus:error=>error.status,
    recordHeadsetEvent:(kind,detail)=>logs.push({kind,detail}),showHeadsetCaption:line=>captions.push(line),
    console:{warn:line=>warnings.push(line)},
  });
  vm.runInContext(source,context);
  await assert.rejects(context.call('replace_inspection_source',{demo:asked}),error=>error.message===wearerReason && error.status===409);
  assert.deepEqual(JSON.parse(JSON.stringify(logs)),[{kind:'tool-refused',detail:{tool:'replace_inspection_source',status:409,reason,
    captioned:true,journeyPending:false,staleBinding:false}}]);
  assert.deepEqual(captions,[wearerReason]);
  for(const demo of index.demos) assert.ok(!captions[0].includes(demo.name),demo.name);
  assert.deepEqual(warnings,[`replace_inspection_source: ${reason}`]);
});
