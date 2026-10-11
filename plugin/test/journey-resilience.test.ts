import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import { experienceGeometry, chapterBudget, catalogChapterBudget } from '../src/experience-budget.js';
import { EXPERIENCE_CATALOG_SIZES } from '../src/experience-catalog-sizes.js';
import { experienceById, stageForStep, MOLECULAR_EXPERIENCES, TUBULIN_EB3_EXPERIENCE } from '../src/molecular-experience.js';
import { inspectionRefusalCaption, shouldCaptionInspectionRefusal } from '../src/inspection-refusal-caption.js';
import { isStaleInspectionAttach } from '../src/inspection-attach-recovery.js';
// @ts-ignore Execute the production inspector navigation; only platform I/O is adapted.
import { journeyNavigationHarness } from '../../lab/browser-roundtrip/fixtures/journey-navigation-harness.mjs';

const companionRequests=vi.hoisted(()=>({dispatch:undefined as ((...args:any[])=>Promise<any>)|undefined}));
vi.mock('../src/inspection-companion-http.js',async original=>{
  const module=await original<typeof import('../src/inspection-companion-http.js')>();
  return {...module,InspectionCompanionHttp:class extends module.InspectionCompanionHttp {
    constructor(options:ConstructorParameters<typeof module.InspectionCompanionHttp>[0]) {
      super(options);companionRequests.dispatch=options.dispatch;
    }
  }};
});

const crn=await readFile(new URL('../../fixtures/1CRN.cif',import.meta.url),'utf8');
const hhb=await readFile(new URL('../../fixtures/4HHB.cif',import.meta.url),'utf8');
const inspector=await readFile(new URL('../src/inspector.ts',import.meta.url),'utf8');
// Synthetic repeated 1CRN chains, labelled 4FFB solely to route to the installed
// journey. This fixture makes no claim to be the deposited 4FFB structure.
function largeFixture() {
  const lines=crn.split('\n'),first=lines.findIndex(line=>/^ATOM\s/.test(line));
  let last=first;while(/^ATOM\s/.test(lines[last]))last++;
  const atoms=lines.slice(first,last).map(line=>line.trim().split(/\s+/));
  const enlarged=Array.from({length:8859},(_,i)=>{
    const row=[...atoms[i%atoms.length]],copy=Math.floor(i/atoms.length);
    row[1]=String(i+1);row[6]=row[18]=`C${copy}`;row[10]=String(Number(row[10])+copy*35);
    return row.join(' ');
  });
  let text=[...lines.slice(0,first),...enlarged,...lines.slice(last)].join('\n').replace(/1CRN/g,'4FFB');
  const copies=28;
  text=text.replace(/_struct_asym\.id[\s\S]*?(?=\n#)/,
    'loop_\n_struct_asym.id\n_struct_asym.entity_id\n'+Array.from({length:copies},(_,i)=>`C${i} 1`).join('\n'));
  const schemeStart=text.indexOf('loop_\n_pdbx_poly_seq_scheme.asym_id'),schemeEnd=text.indexOf('\n#',schemeStart);
  const scheme=text.slice(schemeStart,schemeEnd).split('\n'),rowStart=scheme.findIndex(line=>/^A\s+1\s/.test(line));
  const rows=scheme.slice(rowStart).filter(line=>line.trim());
  text=text.slice(0,schemeStart)+scheme.slice(0,rowStart).join('\n')+'\n'+Array.from({length:copies},(_,i)=>rows.map(line=>{
    const fields=line.trim().split(/\s+/);fields[0]=fields[9]=`C${i}`;return fields.join(' ');
  }).join('\n')).join('\n')+text.slice(schemeEnd);
  return text;
}
const large=largeFixture();
const tog=experienceById('tubulin-polymerase-complex')!;
function queue() {
  let now=0;
  const commands=new InspectionCommands(()=>now);
  const binding={serverEpoch:randomUUID(),sourceToken:randomUUID(),stateRevision:0,inspectionRevision:1};
  const expected={serverEpoch:binding.serverEpoch,sourceToken:binding.sourceToken,baseStateRevision:0,baseInspectionRevision:1};
  return {commands,binding,expected,tick:(ms:number)=>{now=ms;}};
}
async function fixture(text=crn) {
  let now=0;
  const fetchPdbText=vi.fn(async (id:string)=>id==='4FFB'?large:hhb);
  const server=createStereoStructureServer(undefined,{now:()=>now,fetchPdbText,
    replyAudio:createReplyAudioSynthesizer({enabled:false})});
  const client=new Client({name:'resilience fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);
  const raw=async(name:string,args:any)=>await client.callTool({name:`stereo_structure.${name}`,arguments:args}) as any;
  const call=async(name:string,args:any)=>{const result=await raw(name,args);if(result.isError)throw Error(result.content[0].text);return result;};
  const opened=await call('inspect',{structureText:text}),sessionId=opened.structuredContent.sessionId;
  const data=()=>call('get_inspection',{sessionId}).then(async result=>{const d=result._meta[KEY];d.catalog=await decodeInspectionCatalog(d.catalogWire??d.catalog);return d;});
  const expected=(d:any)=>({sessionId,serverEpoch:d.serverEpoch,sourceToken:d.sourceToken,baseStateRevision:d.stateRevision,baseInspectionRevision:d.inspectionRevision});
  const ready=async(replacesPanelId?:string,surface='companion')=>{
    const d=await data();
    const scene=d.scene??{sourceSha256:d.catalog.source.sha256,modelNumber:1,assemblyId:d.catalog.assemblyId,selectionKeys:[],
      camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],up:[0,1,0],target:[0,0,0],radius:20,radiusMax:20,fog:50,clipFar:true,minNear:5,minFar:0},
      inspection:{appearance:{representation:'cartoon',color:'chain-id',uniformColor:'#ffffff',background:'#071015',opacity:1,labels:false,highlightColor:'#f2c47c',clipping:0,fog:0},
        placement:{translation:[0,0,0],rotation:[0,0,0],scale:1}}};
    const saved=(await call('sync_inspection',{...expected(d),scene})).structuredContent;
    const binding=expected(saved);
    const panelId=(await call('attach_inspection',{...binding,surface,...(replacesPanelId?{replacesPanelId}:{})})).structuredContent.panelId;
    return {...binding,panelId};
  };
  return {raw,call,data,expected,ready,sessionId,fetchPdbText,dispatch:companionRequests.dispatch!,tick:(ms:number)=>{now=ms;},close:async()=>{await client.close();await server.close();}};
}

describe('journey resilience',()=>{
  it('premarks cold tubulin chapters for Quest 2 before any journey starts or source loads',async()=>{
    const t=await fixture();
    try {
      const original=await t.data();
      const expected=Array.from({length:20},()=>'available');
      const check=(catalog:any[])=>{
        const budget=catalog.find(item=>item.id===tog.id).deviceBudget;
        expect(budget.deviceClass).toBe('quest2');
        expect(budget.chapters.map((chapter:any)=>chapter.status)).toEqual(expected);
        expect(budget.chapters[1].message).toBe('Chapter 2 may run slowly across the estimated quality range (8535 atoms); current settings are unknown.');
        expect(budget.notice).toContain('2, 7, 12, 17');
      };
      check(original.experienceCatalog);
      await t.ready();
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId,includeExperienceCatalog:true})).structuredContent;
      check(state.experienceCatalog);
      const after=await t.data();
      expect(after.experience).toBeUndefined();expect(after.sourceToken).toBe(original.sourceToken);
      expect(after.structureText).toBe(original.structureText);expect(t.fetchPdbText).not.toHaveBeenCalled();
    } finally {await t.close();}
  });
  it('sizes every catalog source before any journey starts, with no chapter left unchecked',async()=>{
    const t=await fixture();
    try {
      const {experienceCatalog:catalog}=await t.data();
      expect(catalog).toHaveLength(MOLECULAR_EXPERIENCES.length);
      for(const item of catalog) {
        expect(item.deviceBudget.chapters).toHaveLength(20);
        for(const chapter of item.deviceBudget.chapters)expect(chapter.status).not.toBe('unchecked');
      }
      expect(catalog.find((item:any)=>item.id==='hemoglobin-quaternary-structure').deviceBudget.chapters.every((chapter:any)=>chapter.status==='available')).toBe(true);
      expect(catalog.find((item:any)=>item.id==='cas9-ternary-complex').deviceBudget.chapters.filter((chapter:any)=>chapter.message?.includes('may run slowly')).map((chapter:any)=>chapter.stepIndex)).toEqual([1,6,11,16]);
      expect(t.fetchPdbText).not.toHaveBeenCalled();
    } finally {await t.close();}
  });
  for(const pdbId of ['4FFB','9QB3'])it(`replaces cached or unknown ${pdbId} sizing with loaded coordinates before start`,async()=>{
    // A small synthetic source with the public identifier tests cache precedence,
    // not the size or biological identity of the deposited entry.
    const t=await fixture(crn.replace(/1CRN/g,pdbId));
    try {
      const data=await t.data();
      const summary=data.experienceCatalog.find((item:any)=>item.sources[0].pdbId===pdbId);
      expect(summary.deviceBudget.chapters.every((chapter:any)=>chapter.status==='available')).toBe(true);
      expect(data.experience).toBeUndefined();expect(t.fetchPdbText).not.toHaveBeenCalled();
    } finally {await t.close();}
  });
  it('binds cached counts to the model, assembly, and device policy without discounting hidden copies',async()=>{
    expect(EXPERIENCE_CATALOG_SIZES.entries['4HHB:asymmetric_unit:1'].counts).toEqual(
      await experienceGeometry(hhb,stageForStep(experienceById('hemoglobin-quaternary-structure')!,1)));
    expect(catalogChapterBudget(tog,1,undefined,'quest3').status).toBe('available');
    const other=structuredClone(tog);
    other.stages[0].source.modelNumber=2;
    expect(catalogChapterBudget(other,1)).toMatchObject({status:'unchecked',message:expect.stringContaining('model 2')});
    other.stages[0].source.modelNumber=1;other.stages[0].assembly.assemblyId='2';
    expect(catalogChapterBudget(other,1)).toMatchObject({status:'unchecked',message:expect.stringContaining('assembly 2')});
    const slice=catalogChapterBudget(TUBULIN_EB3_EXPERIENCE,5);
    const full=catalogChapterBudget(TUBULIN_EB3_EXPERIENCE,10);
    expect(slice.status).toBe('available');expect(full.status).toBe('available');
    expect(slice.message).toContain('177268 atoms');expect(full.message).toContain('177268 atoms');
  });
  it('budgets 8,859 atoms with real bonds and preserves 4HHB sticks',async()=>{
    const counts=await experienceGeometry(large,stageForStep(tog,1));
    expect(counts.atoms).toBe(8859);expect(counts.bonds).toBeGreaterThan(8000);
    expect(chapterBudget(tog,1,counts)).toMatchObject({status:'available',message:expect.stringContaining('may run slowly')});
    expect(chapterBudget(tog,0,counts).status).toBe('available');
    const blood=experienceById('hemoglobin-quaternary-structure')!;
    expect(chapterBudget(blood,1,await experienceGeometry(hhb,stageForStep(blood,1))).status).toBe('available');
    expect(chapterBudget(tog,1,counts,'desktop').status).toBe('available');
  });
  it('counts the selected model rather than the first trajectory frame',async()=>{
    const lines=crn.split('\n'),first=lines.findIndex(line=>/^ATOM\s/.test(line));
    let last=first;while(/^ATOM\s/.test(lines[last]))last++;
    const second=lines.slice(first,first+100).map((line,index)=>{
      const fields=line.trim().split(/\s+/);fields[1]=String(328+index);fields[20]='2';return fields.join(' ');
    });
    const text=[...lines.slice(0,last),...second,...lines.slice(last)].join('\n');
    expect((await experienceGeometry(text,stageForStep(tog,1),1)).atoms).toBe(327);
    expect((await experienceGeometry(text,stageForStep(tog,1),2)).atoms).toBe(100);
    await expect(experienceGeometry(text,stageForStep(tog,1),3)).rejects.toThrow('Journey needs model 3');
  });
  it('advises costly chapters before start and renders the requested chapter without replacing its source',async()=>{
    const t=await fixture(large);
    try {
      const before=await t.ready(),original=await t.data();
      const started=await t.call('control_tour',{...before,commandId:'start',action:'start',tourId:tog.id});
      expect(started.structuredContent.journeyBudget.filter((c:any)=>c.message?.includes('may run slowly')).map((c:any)=>c.stepIndex)).toEqual([1,6,11,16]);
      expect(started.content[0].text).toContain('2, 7, 12, 17 may run slowly');
      const retry=await t.call('control_tour',{...before,commandId:'start',action:'start',tourId:tog.id});
      expect(retry.structuredContent.command).toEqual(started.structuredContent.command);
      expect((await t.raw('control_tour',{...before,commandId:'start',action:'start',tourId:'hemoglobin-quaternary-structure'})).isError).toBe(true);
      const delivery=(await t.call('poll_inspection',{...before,availability:'ready'}))._meta[KEY].delivery;
      const {sessionId:_session,...owner}=before;
      const claim={...owner,commandId:'start',claimToken:delivery.claimToken};
      await t.call('complete_inspection',{...claim,sessionId:t.sessionId,phase:'admit'});
      await t.call('navigate_experience',{...before,experienceId:tog.id,stepIndex:0,baseExperienceRevision:0,tourCommand:claim});
      // Adapt the renderer boundary: save and acknowledge only after the fixture draw.
      const drawn=await t.ready(before.panelId),chapter=await t.data();
      await t.call('acknowledge_experience_step',{...drawn,experienceId:tog.id,stepIndex:0,experienceRevision:chapter.experience.revision,tourCommand:claim});
      await t.call('control_tour',{...drawn,commandId:'next',action:'next'});
      const next=(await t.call('poll_inspection',{...drawn,availability:'ready'}))._meta[KEY].delivery;
      const {sessionId:_drawSession,...drawOwner}=drawn;
      const nextClaim={...drawOwner,commandId:'next',claimToken:next.claimToken};
      await t.call('complete_inspection',{...nextClaim,sessionId:t.sessionId,phase:'admit'});
      // The fixture pairs no LAN peer, so the panel says which headset it is.
      await t.call('navigate_experience',{...drawn,device:'quest2',experienceId:tog.id,stepIndex:1,baseExperienceRevision:chapter.experience.revision,tourCommand:nextClaim});
      const nextDrawn=await t.ready(drawn.panelId),after=await t.data();
      const acknowledged=await t.call('acknowledge_experience_step',{...nextDrawn,experienceId:tog.id,stepIndex:1,experienceRevision:after.experience.revision,tourCommand:nextClaim});
      expect(acknowledged.isError).not.toBe(true);
      expect(after.sourceToken).toBe(original.sourceToken);expect(after.structureText).toBe(original.structureText);
      expect(after.experience.stepIndex).toBe(1);expect(after.experience.revision).toBeGreaterThan(chapter.experience.revision);
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId,includeExperienceCatalog:true})).structuredContent;
      expect(state.companionLoading).toBe(false);expect(state.panels.some((p:any)=>p.panelId===nextDrawn.panelId&&p.current&&p.availability==='ready')).toBe(true);
      expect(state.modelContext.readiness.blocking).not.toContain('structure');
      expect(state.experienceCatalog.find((e:any)=>e.id===tog.id).deviceBudget.notice).toContain('2, 7, 12, 17');
    } finally {await t.close();}
  });
  it('admits an advisory-cost cross-source chapter with the requested scientific identity',async()=>{
    const t=await fixture();
    try {
      const before=await t.ready(),original=await t.data();
      await t.call('navigate_experience',{...before,device:'quest2',experienceId:tog.id,stepIndex:1,baseExperienceRevision:0});
      const after=await t.data();expect(after.sourceToken).not.toBe(original.sourceToken);
      expect(after.experience.stepIndex).toBe(1);expect(after.catalog.source.sha256).not.toBe(original.catalog.source.sha256);
      expect(after.experience.definition.steps[after.experience.stepIndex].appearance.representation).toBe('ball-and-stick');
    } finally {await t.close();}
  });
  for(const sameSource of [false,true])it(`rolls back a failed inspector chapter load and resumes ready heartbeats (same source ${sameSource})`,async()=>{
    const t=await fixture(sameSource?hhb:crn);
    try {
      let initial=await t.ready();
      if(sameSource) {
        await t.call('navigate_experience',{...initial,experienceId:'hemoglobin-quaternary-structure',stepIndex:0,baseExperienceRevision:0});
        initial=await t.ready(initial.panelId);const chapter=await t.data();
        await t.call('acknowledge_experience_step',{...initial,experienceId:'hemoglobin-quaternary-structure',stepIndex:0,experienceRevision:chapter.experience.revision});
      }
      const original=await t.data();let attempts=0;
      let page:any;
      page=journeyNavigationHarness({PRIVATE_KEY:KEY,isCompanion:false,panelId:initial.panelId,experienceView:original.experience,
        binding:{sessionId:t.sessionId,serverEpoch:initial.serverEpoch,sourceToken:initial.sourceToken,stateRevision:initial.baseStateRevision,inspectionRevision:initial.baseInspectionRevision},
        call:t.call,hydrate:async()=>{
          attempts++;
          if(attempts===1) {
            if(!page.experienceSourceChanged) {
              await t.call('detach_inspection',{...page.expected(),panelId:page.panelId,reason:'loading'});
              expect((await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent.companionLoading).toBe(true);
            }
            page.panelId=undefined;throw Error('Synthetic chapter upload failed.');
          }
          const ready=await t.ready(initial.panelId),restored=await t.data();
          Object.assign(page.binding,{sourceToken:ready.sourceToken,stateRevision:ready.baseStateRevision,inspectionRevision:ready.baseInspectionRevision});
          page.panelId=ready.panelId;page.dirty=false;page.blocked=false;
          expect(restored.scene).toEqual(original.scene);
        }});
      await expect(page.navigateExperience('hemoglobin-quaternary-structure',sameSource?2:0)).rejects.toThrow('Previous view restored.');
      expect(attempts).toBe(2);
      await page.busyBeat(page.generation);
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.companionLoading).toBe(false);expect(state.modelContext.readiness.blocking).not.toContain('structure');
      expect(state.panels.some((p:any)=>p.panelId===page.panelId&&p.current&&p.availability==='ready')).toBe(true);
      expect((await t.data()).structureText).toBe(original.structureText);
    } finally {await t.close();}
  });
  it('identifies the stale complete/attach source check after a rendered Done without weakening it',async()=>{
    const t=await fixture();
    try {
      const initial=await t.ready(),id='hemoglobin-quaternary-structure';
      await t.call('navigate_experience',{...initial,experienceId:id,stepIndex:0,baseExperienceRevision:0});
      const drawn=await t.ready(initial.panelId),chapter=await t.data();
      await t.call('acknowledge_experience_step',{...drawn,experienceId:id,stepIndex:0,experienceRevision:chapter.experience.revision});
      const done=await t.call('navigate_experience',{...drawn,experienceId:id,stepIndex:0,baseExperienceRevision:chapter.experience.revision,finish:true});
      const restored=await t.ready(drawn.panelId);
      const receipt=await t.call('acknowledge_experience_step',{...restored,experienceId:id,stepIndex:0,experienceRevision:chapter.experience.revision,
        completionToken:done.structuredContent.experienceTransition.completionToken});
      expect(receipt.structuredContent.experienceCompletion.status).toBe('rendered');
      for(const name of ['complete_inspection','attach_inspection']) {
        await expect(t.dispatch(t.sessionId,restored.sourceToken,name,drawn)).rejects.toThrow('This action belongs to a different structure.');
        expect(shouldCaptionInspectionRefusal(name,'This action belongs to a different structure.',false,drawn.sourceToken!==restored.sourceToken)).toBe(false);
      }
      const current=await t.data();expect(current.sourceToken).toBe(restored.sourceToken);expect(current.experienceCompletion.status).toBe('rendered');
      await expect(t.dispatch(t.sessionId,restored.sourceToken,'sync_inspection',drawn)).rejects.toThrow('This action belongs to a different structure.');
      expect(shouldCaptionInspectionRefusal('sync_inspection','This action belongs to a different structure.',true,true)).toBe(false);
    } finally {await t.close();}
  });
  it('keeps busy start commands queued during preflight and retains exact retries',async()=>{
    const t=await fixture(hhb);
    try {
      const before=await t.ready();await t.call('poll_inspection',{...before,availability:'busy'});
      const args={...before,commandId:'busy-start',action:'start',tourId:'hemoglobin-quaternary-structure'};
      const queued=await t.call('control_tour',args);
      expect(queued.structuredContent.command).toMatchObject({status:'queued',heldForPanel:true});
      expect((await t.call('control_tour',args)).structuredContent.command).toEqual(queued.structuredContent.command);
      expect((await t.call('poll_inspection',{...before,availability:'busy'}))._meta?.[KEY]?.delivery).toBeUndefined();
      expect((await t.call('poll_inspection',{...before,availability:'ready'}))._meta[KEY].delivery.commandId).toBe('busy-start');
    } finally {await t.close();}
  });
  it('reclaims a desktop that stops heartbeating while unsaved and publishes the reason',async()=>{
    const t=await fixture();
    try {
      const panel=await t.ready(undefined,'desktop');
      await t.call('poll_inspection',{...panel,availability:'unsaved'});
      t.tick(130000);
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent;
      expect(state.panels).toEqual([]);expect(state.reclaimedPanels).toContainEqual(expect.objectContaining({panelId:panel.panelId,inspectionRevision:panel.baseInspectionRevision,reason:expect.stringContaining('render budget')}));
      expect(state.modelContext.readiness.blocking).toContain('structure');
      expect((await t.raw('control_tour',{...panel,commandId:'stale',action:'next'})).isError).toBe(true);
    } finally {await t.close();}
  });
});

for (const tool of ['complete_inspection', 'attach_inspection', 'sync_inspection',
  'acknowledge_experience_step', 'voice_acknowledgement', 'claim_voice_intent', 'acknowledge_voice_intent', 'acknowledge_voice_playback']) {
  for (const reason of ['This action belongs to a different structure.',
    'The spoken line belongs to a replaced source. Read get_inspection_state.', 'The target panel is no longer available.']) {
    it(`suppresses ${tool} bookkeeping by ownership or stale binding regardless of wording: ${reason}`, () => {
      expect(shouldCaptionInspectionRefusal(tool, reason, false, true, false)).toBe(false);
      expect(shouldCaptionInspectionRefusal(tool, reason, false, false, true)).toBe(false);
      expect(shouldCaptionInspectionRefusal(tool, reason, false, false, false)).toBe(true);
      for (const command of ['replace_inspection_source', 'control_tour', 'navigate_experience', 'update_inspection']) {
        expect(shouldCaptionInspectionRefusal(command, reason, true, true, true)).toBe(true);
      }
    });
  }
}

describe('panel progress budgets',()=>{
  it('unchanged unsaved heartbeats cannot retain a stranded panel past its render budget',()=>{
    const f=queue();f.commands.setRenderBudget(120000);
    const panelId=f.commands.attach(f.expected,f.binding);
    for(let time=0;time<120000;time+=5000) {f.tick(time);expect(f.commands.poll({...f.expected,panelId,availability:'unsaved'},f.binding).attached).toBe(true);}
    f.tick(120000);expect(f.commands.poll({...f.expected,panelId,availability:'unsaved'},f.binding).attached).toBe(false);
    expect(f.commands.summary(f.binding).reclaimedPanels).toHaveLength(1);
  });
  it('saved revision progress resets the unsaved budget without making dirty work ready',()=>{
    const f=queue(),panelId=f.commands.attach({...f.expected,surface:'companion'},f.binding);
    for(let time=0;time<100000;time+=5000) {f.tick(time);f.commands.poll({...f.expected,panelId,availability:'unsaved'},f.binding);}
    f.tick(100000);f.binding.inspectionRevision=2;
    f.commands.poll({...f.expected,baseInspectionRevision:2,panelId,availability:'unsaved'},f.binding);
    f.tick(125000);expect(f.commands.summary(f.binding).panels[0]).toMatchObject({current:true,availability:'unsaved'});
    expect(f.commands.readyPanel(panelId,f.binding)).toBe(false);
  });
  it('clears abandoned companion loading at the existing render budget',()=>{
    const f=queue();f.commands.setRenderBudget(120000);
    const panelId=f.commands.attach({...f.expected,surface:'companion'},f.binding);
    f.commands.detach({...f.expected,panelId,reason:'loading'},f.binding);
    f.tick(119999);expect(f.commands.summary(f.binding).companionLoading).toBe(true);
    f.tick(120000);expect(f.commands.summary(f.binding).companionLoading).toBe(false);
  });
});

for(const tool of ['complete_inspection','attach_inspection']) it(`keeps ${tool} stale-source rejection diagnostic while a successful journey owns the caption`,async()=>{
  const start=inspector.indexOf('async function call('),end=inspector.indexOf('\n}\n',start)+2;
  const captions:string[]=[],records:any[]=[];
  const page:any=vm.createContext({Error,isCompanion:false,tourCommandContext:undefined,loading:true,experiencePreparing:false,experiencePlayer:undefined,
    sceneHistoryClient:{requestStarted:vi.fn(()=>1)},
    binding:{sourceToken:'restored'},inspectionRefusalCaption,shouldCaptionInspectionRefusal,isStaleInspectionAttach,
    companionCall:async()=>{throw Object.assign(Error('This action belongs to a different structure.'),{status:409,code:'companion_request'});},
    thrownErrorMessage:(error:Error)=>error.message,callStatus:(error:any)=>error.status,
    recordHeadsetEvent:(kind:string,detail:any)=>records.push({kind,detail}),showHeadsetCaption:(text:string)=>captions.push(text),console:{warn:()=>{}}});
  vm.runInContext(ts.transpileModule(inspector.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,page);
  await expect(page.call(tool,{sourceToken:'chapter'})).rejects.toMatchObject({status:409});
  expect(records).toHaveLength(1);expect(records[0].detail.reason).toBe('This action belongs to a different structure.');expect(captions).toEqual([]);
  page.loading=false;page.binding.sourceToken='chapter';
  await expect(page.call(tool,{sourceToken:'chapter'})).rejects.toMatchObject({status:409});
  expect(captions).toEqual(['This action belongs to a different structure.']);
});
