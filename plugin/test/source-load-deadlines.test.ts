import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { agentTimeoutMs } from '../scripts/local-agent.js';
import { expect, it, vi } from 'vitest';
import { sceneCallTimeoutMs, SCENE_HOST_START_TIMEOUT_MS } from '../src/scene-service.js';

const source = (path:string) => readFileSync(new URL(path,import.meta.url),'utf8');
const evaluate = (text:string, context:Record<string,unknown>) => {
  const scope=vm.createContext(context);
  vm.runInContext(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
  return scope;
};

it('the actual launcher MCP call outlives 60 seconds of preparation but still cancels at its source ceiling',async()=>{
  vi.useFakeTimers();
  try {
    const serve=source('../scripts/serve-inspection.ts');
    const body=serve.slice(serve.indexOf('const raw=async('),serve.indexOf('\nconst page=',serve.indexOf('const raw=async(')));
    const timers:ReturnType<typeof setTimeout>[]=[];
    const requests:any[]=[];
    const h=evaluate(body+'\nglobalThis.invoke=raw;', {clientConnected:true,sceneCallTimeoutMs,
      client:{callTool:(_request:unknown,_schema:unknown,options:any)=>{
        requests.push(options);
        return new Promise((_resolve,reject)=>timers.push(setTimeout(()=>reject(Error('source deadline')),options.timeout)));
      }}, childUnavailable:()=>Error('disconnected')});
    let settled=false;
    const pending=h.invoke('inspect_file',{filePath:'/private/fixture.cif'}).catch((error:Error)=>{settled=true;return error;});
    await vi.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(55_000);
    expect((await pending).message).toBe('source deadline');
    expect(requests).toEqual([{timeout:120_000}]);
    expect(SCENE_HOST_START_TIMEOUT_MS).toBeGreaterThan(requests[0].timeout);
    timers.forEach(clearTimeout);
  } finally {vi.useRealTimers();}
});

it('the actual outer agent transport allows the inner source deadline and keeps reads bounded',async()=>{
  const quest=source('../scripts/quest-share.ts');
  const start=quest.indexOf('async function agentCall('),end=quest.indexOf('\nconst binding =',start);
  const deadlines:number[]=[];
  const h=evaluate(quest.slice(start,end), {sceneCallTimeoutMs,
    AbortSignal:{timeout:(ms:number)=>{deadlines.push(ms);return undefined;}},
    fetch:async()=>({ok:true,json:async()=>({ok:true})})});
  for(const [name,args] of [['replace_inspection_source',{waitForRenderMs:40_000}],['inspect_lesson',{}],['get_inspection_state',{}],
    ['grow_structure',{}],['open',{pdbId:'1CRN'}],['control',{action:'load_pdb'}],['control',{action:'fit'}]] as const)
    await h.agentCall({origin:'http://127.0.0.1',token:'test',sessionId:'test'},name,args);
  expect(deadlines).toEqual([165_000,125_000,75_000,245_000,125_000,125_000,75_000]);
});


it('the shared CLI transport uses the same bounded source deadline as the launcher',()=>{
  expect(agentTimeoutMs({waitForRenderMs:40_000},'replace_inspection_source')).toBe(165_000);
  expect(agentTimeoutMs({},'inspect_experience')).toBe(125_000);
  expect(agentTimeoutMs({waitForRenderMs:1e9},'replace_inspection_source')).toBe(425_000);
  expect(agentTimeoutMs({},'grow_structure')).toBe(245_000);
  expect(agentTimeoutMs({pdbId:'1CRN'},'open')).toBe(125_000);
  expect(agentTimeoutMs({action:'load_pdb'},'control')).toBe(125_000);
  expect(agentTimeoutMs({action:'fit'},'control')).toBe(75_000);
});

it('the walkthrough stops on the renderer refusal instead of waiting three minutes',async()=>{
  const text=source('../scripts/record-walkthrough.ts');
  const ast=ts.createSourceFile('walkthrough.ts',text,ts.ScriptTarget.Latest,true);
  const command=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='command')!;
  let reads=0;
  const h=evaluate(command.getText(ast),{randomUUID:()=> 'test',sessionId:'session',Date,Error,String,
    call:async()=>({structuredContent:{sourceRenderReceipt:{status:'failed',rendered:false,failureReason:'Over the supported geometry budget.'}}}),
    state:async()=>{reads++;throw Error('must not poll');}});
  await expect(h.command('replace_inspection_source',{})).rejects.toThrow('Over the supported geometry budget.');
  expect(reads).toBe(0);
});
