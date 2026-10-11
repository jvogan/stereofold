import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { thrownErrorMessage, toolResultError } from '../src/tool-result.js';

const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', source, ts.ScriptTarget.Latest, true);
const handoff = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handoffSpokenRequest')!.getText(ast);
const key = ast.statements.find(node => node.getText(ast).startsWith('const voiceBindingKey='))!.getText(ast);
const compiled = ts.transpileModule(`${key}\n${handoff}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const callFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['call','callStatus'].includes(node.name?.text ?? ''))
  .map(node => node.getText(ast)).join('\n');
const claim = { _meta: { inspection: { voiceIntent: { intent: { id:'intent', transcript:'explain this', sessionId:'session',panelId:'companion' }, claimToken:'claim' } } } };
function fixture() {
  const h = vm.createContext({ isCompanion:false,voiceHandoffBusy:false,closed:false,loading:false,dirty:false,blocked:false,
    generation:1,panelId:'desktop',binding:{sessionId:'session',serverEpoch:'epoch',sourceToken:'source',baseStateRevision:1,baseInspectionRevision:1},
    PRIVATE_KEY:'inspection',outcome:{textContent:''},thrownErrorMessage,recordHeadsetEvent:vi.fn(),
    app:{getHostCapabilities:()=>({message:{text:{}}}),sendMessage:vi.fn(async()=>({}))},
    call:vi.fn(async()=>claim),
  });
  h.expected=()=>({...h.binding});
  vm.runInContext(compiled,h);
  return h;
}

function bridgeFixture() {
  const h=fixture();
  Object.assign(h,{Error,toolResultError,experiencePreparing:false,experiencePlayer:undefined,tourCommandContext:undefined,
    sceneHistoryClient:{requestStarted:()=>({}),note:vi.fn()},
    companionCall:undefined,inspectionRefusalCaption:(text:string)=>text,publishModelContext(){},updateReadinessStrip(){}});
  h.app.callServerTool=vi.fn(async()=>claim);
  vm.runInContext(ts.transpileModule(callFunctions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h);
  return h;
}
const staleClaimMessage='The voice request belongs to a changed or unavailable view. Try again when the scene is ready.';
const errorResult=(text:string)=>({isError:true,content:[{type:'text',text}]});

it('ignores a known server pre-claim refusal before the local binding catches up',async()=>{
  const h=bridgeFixture();h.app.callServerTool.mockResolvedValue(errorResult(staleClaimMessage));
  await h.handoffSpokenRequest();
  expect(h.binding.sourceToken).toBe('source');expect(h.outcome.textContent).toBe('');
  expect(h.app.sendMessage).not.toHaveBeenCalled();expect(h.voiceHandoffBusy).toBe(false);
});

it('keeps a transport rejection visible even if its text resembles the server refusal',async()=>{
  const h=bridgeFixture();h.app.callServerTool.mockRejectedValue(Error(staleClaimMessage));
  await h.handoffSpokenRequest();
  expect(h.outcome.textContent).toBe('Could not confirm the spoken request. Check the view before asking again.');
  expect(h.recordHeadsetEvent).toHaveBeenCalledWith('page-error',{operation:'voice-handoff',message:staleClaimMessage});
  expect(h.app.sendMessage).not.toHaveBeenCalled();
});

it('keeps other server claim failures visible',async()=>{
  const h=bridgeFixture();h.app.callServerTool.mockResolvedValue(errorResult('Only the current desktop host may receive spoken requests.'));
  await h.handoffSpokenRequest();
  expect(h.outcome.textContent).toBe('Could not confirm the spoken request. Check the view before asking again.');
});

it('keeps the same server validation refusal visible after delivery during acknowledgement',async()=>{
  const h=bridgeFixture();h.app.callServerTool.mockResolvedValueOnce(claim).mockResolvedValueOnce(errorResult(staleClaimMessage));
  await h.handoffSpokenRequest();
  expect(h.app.sendMessage).toHaveBeenCalledOnce();
  expect(h.outcome.textContent).toBe('Could not confirm the spoken request. Check the view before asking again.');
});

it('drops an ordinary claim refusal when the source binding changed before delivery', async () => {
  const h=fixture();
  h.call=vi.fn(async()=>{h.binding.sourceToken='replacement';throw Error('The voice request belongs to a changed or unavailable view.');});
  await h.handoffSpokenRequest();
  expect(h.outcome.textContent).toBe('');expect(h.app.sendMessage).not.toHaveBeenCalled();expect(h.voiceHandoffBusy).toBe(false);
});

it.each(['generation','loading','closed','revision'])('drops a claim retired by %s before any message is sent', async changed => {
  const h=fixture();
  h.call=vi.fn(async()=>{
    if(changed==='generation')h.generation++;
    else if(changed==='revision')h.binding.baseInspectionRevision++;
    else h[changed]=true;
    return claim;
  });
  await h.handoffSpokenRequest();
  expect(h.app.sendMessage).not.toHaveBeenCalled();expect(h.outcome.textContent).toBe('');expect(h.voiceHandoffBusy).toBe(false);
});

it('keeps a real claim failure visible while its binding is still current', async () => {
  const h=fixture();h.call=vi.fn(async()=>{throw Error('Transport unavailable');});
  await h.handoffSpokenRequest();
  expect(h.outcome.textContent).toBe('Could not confirm the spoken request. Check the view before asking again.');
});

it.each(['delivery','acknowledgement'])('preserves an ambiguous %s error even when the source changes after sending starts', async phase => {
  const h=fixture();
  if(phase==='delivery')h.app.sendMessage=vi.fn(async()=>{h.binding.sourceToken='replacement';throw Error('Delivery uncertain');});
  else h.call=vi.fn(async(name:string)=>{
    if(name==='claim_voice_intent')return claim;
    h.binding.sourceToken='replacement';throw Error('Acknowledgement uncertain');
  });
  await h.handoffSpokenRequest();
  expect(h.app.sendMessage).toHaveBeenCalledOnce();expect(h.outcome.textContent).toBe('Could not confirm the spoken request. Check the view before asking again.');
});

it('sends and acknowledges a current claim normally', async () => {
  const h=fixture();await h.handoffSpokenRequest();
  expect(h.app.sendMessage).toHaveBeenCalledOnce();
  expect(h.call.mock.calls.map((entry:any[])=>entry[0])).toEqual(['claim_voice_intent','acknowledge_voice_intent']);
  expect(h.outcome.textContent).toBe('Spoken request delivered to this task.');
});

it.each(['loading','closed'])('does not start an ordinary claim while %s', async state => {
  const h=fixture();h[state]=true;await h.handoffSpokenRequest();expect(h.call).not.toHaveBeenCalled();
});
