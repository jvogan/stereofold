import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { InspectionScene } from '../src/inspection-contract.js';
import { pairedSessionHeadset, visionProStatus } from '../src/inspection-contract.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import { createPollBackoff } from '../src/inspection-poll-backoff.js';
// @ts-ignore Shared browser detector.
import { isAppleSafariXr } from '../../lab/browser-roundtrip/xr-session-request.mjs';

const inspector=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
const server=readFileSync(new URL('../src/inspection-server.ts',import.meta.url),'utf8');
const execute=(source:string,context:vm.Context)=>vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);

it('an Apple-selected paired page reports its actual connection before Safari hardware classification',()=>{
  const start=server.indexOf('  function lanShareFacts('),end=server.indexOf('\n  type PanelSummary=',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const at=10000;
  const context=vm.createContext({lanOwner:{sessionId:'session',headset:'apple'},
    panelLanClients:new Map([['panel','client']]),CLIENT_ACTIVE_MS:5000,
    reportedPanelDeviceClass:()=>undefined,pairedSessionHeadset});
  execute(server.slice(start,end),context);
  const live={sessionExpiresAt:'2099-01-01T00:00:00.000Z',clients:[{
    id:'client',deviceClass:'unknown',lastUsedAt:new Date(at).toISOString(),createdAt:new Date(0).toISOString()}]};
  for(const current of [false,true]) {
    const share=context.lanShareFacts('session',[{panelId:'panel',surface:'companion',current}],live,at);
    expect(share.headset).toBeUndefined();
    expect(share.connected).toBe(current);
    expect(visionProStatus(share)).toBeUndefined(); // Unknown paired peer cannot inherit the Apple launch hint.
  }
  const stale={...live,clients:[{...live.clients[0],lastUsedAt:new Date(0).toISOString()}]};
  expect(context.lanShareFacts('session',[{panelId:'panel',surface:'companion',current:true}],stale,at).connected).toBe(false);
});

it('Enter VR and resume skip microphone consent on Safari and still prime Quest',()=>{
  const statements=inspector.split('\n').filter(line=>line.includes('void primePushToTalkMicrophone()'));
  expect(statements).toHaveLength(2);
  for(const [userAgent,expectedPrimes] of [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',0],
    ['Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 Chrome/132.0.0.0 OculusBrowser/38.0 Safari/537.36',2],
  ] as const) {
    let primes=0;
    const navigator={userAgent,xr:{}};
    const context=vm.createContext({navigator,isAppleSafariXr,isCompanion:true,primePushToTalkMicrophone:()=>{primes++;}});
    for(const statement of statements)execute(statement,context);
    expect(primes).toBe(expectedPrimes);
  }
});

const binding={serverEpoch:'epoch',sourceToken:'source',stateRevision:1,inspectionRevision:1};
const expected={serverEpoch:'epoch',sourceToken:'source',baseStateRevision:1,baseInspectionRevision:1};
const report=(visible:boolean)=>({phase:'idle',pending:false,reloadRequired:false,mode:null,gestureActive:null,presenting:false,visible});
function panels() {
  let now=1000;
  const commands=new InspectionCommands(()=>now);
  const attach=()=>commands.attach({...expected,surface:'companion'},binding);
  const beat=(panelId:string,visible:boolean,availability:'ready'|'busy'|'unsaved'='ready')=>{
    now+=250;return commands.poll({...expected,panelId,availability,xrStartup:report(visible) as any},binding);
  };
  return {commands,attach,beat};
}

describe('paired headset tabs',()=>{
  it('prefers the visible tab even after a hidden old tab checks in last, then retires that capability',()=>{
    const {commands,attach,beat}=panels();
    const old=attach(),visible=attach();beat(visible,true);beat(old,false,'busy');
    expect(commands.wearerPage(binding).panelId).toBe(visible);
    expect(commands.pausedWearerPanel(binding)).toBeUndefined();
    commands.retireDuplicatePanels(new Map([[old,'device'],[visible,'device']]),binding);
    expect(beat(old,false)).toEqual({attached:false,superseded:true});
    expect(commands.summary(binding).panels.map(p=>p.panelId)).toEqual([visible]);
    expect(commands.readyPanel(old,binding)).toBe(false);
  });
  it('uses the newest attachment without visibility evidence and the most recently visible tab with evidence',()=>{
    const {commands,attach,beat}=panels();
    const old=attach(),next=attach();expect(commands.wearerPage(binding).panelId).toBe(next);
    beat(old,true);beat(next,true);beat(old,true);
    expect(commands.wearerPage(binding).panelId).toBe(next);
    beat(old,false);beat(old,true);expect(commands.wearerPage(binding).panelId).toBe(old);
  });
  it('preserves other devices, unsaved work, stale bindings and source-operation owners',()=>{
    for(const protection of ['other-device','unsaved','source-operation','stale-binding']) {
      const {commands,attach,beat}=panels();const old=attach(),next=attach();
      beat(old,false,protection==='unsaved'?'unsaved':'ready');beat(next,true);
      const operation=protection==='source-operation'?commands.beginSourceOperation({...expected,panelId:old},binding):undefined;
      commands.retireDuplicatePanels(new Map([[old,'device'],[next,protection==='other-device'?'other':'device']]),
        protection==='stale-binding'?{...binding,stateRevision:2}:binding);
      expect(commands.summary(binding).panels.map(p=>p.panelId)).toContain(old);
      operation?.release();
    }
  });
  it('preserves a queued command and a claimed render fence on the original owner',()=>{
    for(const claimed of [false,true]) {
      const {commands,attach,beat}=panels();const old=attach();beat(old,true);
      commands.enqueue({...expected,panelId:old,commandId:'edit',change:{kind:'appearance',patch:{color:'chain-id'}}},binding,{sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'1',selectionKeys:[],
        camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
        inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#44aaff',background:'#071015',highlightColor:'#f2c47c',opacity:1,labels:false,clipping:0,fog:0},placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}} as InspectionScene);
      const delivery=claimed?beat(old,true).delivery:undefined;
      beat(old,false);const next=attach();beat(next,true);
      commands.retireDuplicatePanels(new Map([[old,'device'],[next,'device']]),binding);
      expect(commands.summary(binding).panels.map(p=>p.panelId)).toContain(old);
      expect(commands.summary(binding,'edit').command?.status).toBe(claimed?'rendering':'queued');
      if(claimed)expect(delivery?.claimToken).toBeTruthy();
    }
  });
});

it('implicit edit targeting uses the visible wearer and authenticated same-device correlation',()=>{
  const {commands,attach,beat}=panels();
  const old=attach(),visible=attach();beat(visible,true);beat(old,false);
  const data={attachment:{commands,shared:true}};
  const ctx=vm.createContext({binding:()=>binding,WEARER_FIRST_TOOLS:new Set(['update_inspection']),
    isWearerSurface:(surface:string)=>surface==='companion',
    panelLanClients:new Map([[old,'old-client'],[visible,'new-client']]),
    lan:{status:()=>({clients:[{id:'old-client',deviceId:'device'},{id:'new-client',deviceId:'device'}]})}});
  for(const name of ['reconcilePairedPanels','defaultPanelId']) {
    const start=server.indexOf(`  function ${name}(`),end=server.indexOf('\n  }',start)+4;
    execute(server.slice(start,end),ctx);
  }
  expect(ctx.defaultPanelId('session',data,'update_inspection')).toBe(visible);
  expect(beat(old,false)).toMatchObject({superseded:true});
});

it('reports preparation-exhausted waits with real elapsed time and a pollable operation ID',async()=>{
  const start=server.indexOf('        const budgetMs=renderBudgetMsFor(refreshed);',server.indexOf("title:'Replace or compare"));
  const end=server.indexOf('\n      } finally { releaseRetarget(); }',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const data={attachment:{commands:{readyPanel:()=>false}}};
  const context=vm.createContext({Date:{now:()=>171000},callStarted:0,renderBudgetMsFor:()=>130000,
    input:{sessionId:'session',panelId:'panel',waitForRenderMs:40000},refreshed:data,
    HOST_TOOL_WAIT_CEILING_MS:40000,OPEN_COMPANION_CALL_CEILING_MS:55000,
    sourceOperation:{commandId:'source-command'},sourceRenderWait:{wait:async(ms:number)=>{expect(ms).toBe(0);}},
    current:async()=>data,binding:()=>binding,result:(_id:unknown,_data:unknown,receipt:unknown,text:string)=>({receipt,text}),
    opened:{structuredContent:{renderToken:2}},source:{kind:'pdb',id:'4HHB'}});
  const answer=await execute(`(async()=>{${server.slice(start,end)}})()`,context);
  expect(answer.text).toContain('Host preparation used the call wait budget (171000 ms; 171000 ms elapsed)');
  expect(answer.text).toContain('Rendering continues');expect(answer.text).toContain('source-command');
  expect(answer.text).not.toContain('Timed out after 0');
  expect(answer.receipt).toMatchObject({commandId:'source-command',sourceRenderStatus:{status:'rendering',rendered:false,elapsedMs:171000},renderWait:{timedOut:false}});
  const stateStart=server.indexOf('    const sourceWait=data.attachment.sourceRenderWait;');
  const stateEnd=server.indexOf('\n    await showQueuedCommandConflicts',stateStart);
  for(const rendered of [false,true]) {
    const ctx=vm.createContext({commandId:'source-command',b:binding,commandSummary:{},data:{attachment:{commands:{readyPanel:()=>true},sourceRenderWait:{commandId:'source-command',settled:()=>rendered?{status:'rendered',panelId:'panel'}:undefined}}}});
    execute(server.slice(stateStart,stateEnd),ctx);
    expect(ctx.commandSummary.command).toMatchObject({commandId:'source-command',status:rendered?'rendered':'rendering',rendered});
  }
});

it('backs off failed polls with jitter, a subsecond first retry, a four-second cap, and reset on success',()=>{
  let now=0;
  for(const random of [0,0.5,0.999]) {
    const backoff=createPollBackoff(()=>now,()=>random);
    for(let attempt=0;attempt<8;attempt++) {
      backoff.failed();const delay=backoff.remaining();
      expect(delay).toBeGreaterThanOrEqual(250);expect(delay).toBeLessThanOrEqual(4000);
      if(attempt===0)expect(delay).toBeLessThan(1000);
      now+=delay;expect(backoff.remaining()).toBe(0);
    }
    backoff.succeeded();expect(backoff.remaining()).toBe(0);
    backoff.failed();expect(backoff.remaining()).toBeLessThan(1000);
  }
});
