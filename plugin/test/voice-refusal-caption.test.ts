import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { sendAgentCall, type AgentCallTransport } from '../scripts/inspection-agent.js';
import { focusSelectionRequestSchema, updateInspectionSchema, withImplicitBinding } from '../src/inspection-contract.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
// @ts-ignore Shared page receipt producer.
import { recordTalkReplySeat } from '../../lab/browser-roundtrip/talk-reply-diagnostics.mjs';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
// @ts-ignore Production caption layout and existing synthetic eye fixture.
import * as geometry from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Shared browser layout.
import { menuSeatWithinView } from '../../lab/browser-roundtrip/menu-view-band.mjs';
// @ts-ignore Shared browser layout.
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from '../../lab/browser-roundtrip/reply-card-layout.mjs';
// @ts-ignore Synthetic eyes, with no physical headset access.
import { identity, syntheticViews } from '../../lab/browser-roundtrip/fixtures/component-label-diagnostics.mjs';


const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function setup(structureText = cif) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { transcriber: replyBindingTranscriber() });
  const client = new Client({ name: 'Stereofold focus test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  privateData.catalog = await decodeInspectionCatalog(privateData.catalogWire ?? privateData.catalog);
  const rows = privateData.catalog.rows as any[];
  const scene = {
    sourceSha256: privateData.catalog.source.sha256,
    modelNumber: privateData.catalog.modelNumbers[0],
    assemblyId: privateData.catalog.assemblyId,
    selectionKeys: [rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const opened = { sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision };
  const saved = (await call('sync_inspection', { ...opened, scene })).structuredContent;
  const binding = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  await call('poll_inspection', { ...binding, panelId, availability: 'ready' });
  const claim = async () => (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  return { client, call, rows, scene, binding, panelId, claim, sessionId, catalog: privateData.catalog,
    close: async () => { await client.close(); await server.close(); } };
}

function replyBindingTranscriber() {
  const entries:{utteranceId:string;text:string;receivedAt:string;durationMs:number;cursor:number}[]=[];
  return {
    enabled:true,ready:true,route:'whisper' as const,describe:()=>'test transcriber',missing:()=>[],startupLine:()=>'',dispose:async()=>{},
    async accept(input:{utteranceId:string;seq:number;final:boolean}) {
      if(!input.final) return {utteranceId:input.utteranceId,seq:input.seq,final:false,accepted:true,reason:'chunk',message:'Chunk received.'};
      entries.push({utteranceId:input.utteranceId,text:'question',receivedAt:new Date().toISOString(),durationMs:100,cursor:entries.length+1});
      return {utteranceId:input.utteranceId,seq:input.seq,final:true,accepted:true,reason:'transcribed',message:'Heard: question'};
    },
    transcripts:{get cursor(){return entries.length;},async since(after:number){return {cursor:entries.length,entries:entries.filter(entry=>entry.cursor>after)};}},
  } as any;
}

async function recordHeadsetUtterance(t:any, panelId:string, utteranceId:string) {
  const base={sessionId:t.sessionId,panelId,utteranceId,mime:'audio/webm;codecs=opus'};
  expect((await t.call('push_to_talk_audio',{...base,seq:0,data:'AAAA',final:false})).isError).not.toBe(true);
  expect((await t.call('push_to_talk_audio',{...base,seq:1,final:true})).isError).not.toBe(true);
}

async function claimHeadsetUtterance(t:any, panelId:string, utteranceId:string, cursor?:number) {
  await recordHeadsetUtterance(t,panelId,utteranceId);
  const heard=await t.call('listen_voice',{timeoutSeconds:1,...(cursor===undefined?{}:{cursor})});
  expect(heard.structuredContent.transcripts).toHaveLength(1);
  return heard.structuredContent.cursor as number;
}

const voiceId = '33333333-3333-4333-8333-333333333333';
const prefix = 'Could not apply · request refused. ';
const missingChain = '1CRN has no chain Z. Chains are A.';

async function refusal(t: Awaited<ReturnType<typeof setup>>, tool: string, args: Record<string, unknown>, voice = true) {
  if (voice) await claimHeadsetUtterance(t, t.panelId, voiceId);
  const answer = await t.call(tool, { ...t.binding, panelId: t.panelId, commandId: 'refused-command',
    ...(voice ? { utteranceId: voiceId } : {}), ...args });
  expect(answer.isError).toBe(true);
  const poll = () => t.call('poll_inspection', { ...t.binding, panelId: t.panelId, availability: 'ready' });
  const heartbeat = await poll();
  expect(heartbeat._meta[PRIVATE_KEY].delivery).toBeUndefined();
  expect((await t.call('get_inspection', {sessionId:t.sessionId}))._meta[PRIVATE_KEY].scene).toEqual(t.scene);
  return { answer, poll, caption: heartbeat._meta[PRIVATE_KEY].headsetCaption };
}

async function recordSeat(t: Awaited<ReturnType<typeof setup>>, caption: any, outcome = 'shown') {
  const entries: any[] = [];
  const scope = { __stereofoldDiagnostics: { record: (kind:string, detail:unknown) =>
    entries.push({seq:entries.length + 1, at:1000, kind, detail}) } };
  recordTalkReplySeat(caption, {outcome}, {scope});
  await t.call('poll_inspection', {...t.binding, panelId:t.panelId, availability:'ready', diagnostics:{entries}});
  return (await t.call('read_headset_log', {kind:'tool-refused'})).structuredContent.entries;
}

// Run the delivered host sentence through the shipped pager, seat solver and
// diagnostic callback. Only font/mesh/GPU boundaries and the clock are adapters.
async function drawRefusal(t: Awaited<ReturnType<typeof setup>>, caption: any, failDraw: boolean) {
  const source = await readFile(new URL('../../lab/browser-roundtrip/talk-caption.mjs',import.meta.url),'utf8');
  const metrics = JSON.parse(await readFile(new URL('../../lab/browser-roundtrip/fixtures/toolbar-font-metrics.json',import.meta.url),'utf8'));
  const entries:any[] = [], glyphDraws:string[] = [];
  const scope = {__stereofoldDiagnostics:{record:(kind:string,detail:unknown) =>
    entries.push({seq:entries.length + 1,at:1000,kind,detail})}};
  let time = 0, release!:() => void;
  const drawing = new Promise<void>(resolve => { release = resolve; });
  const context = vm.createContext({...geometry,menuSeatWithinView,measureReplyCard,measureReplyCardClearance,
    // Bind the shipped asynchronous solver and its commit-time geometry check.
    // Its pacing clock shares the controlled caption clock; a loaded test
    // runner must not introduce real timer yields into this microtask fixture.
    replyCardOffsetAsync:(args:any,pacing:any) => replyCardOffsetAsync(args,{...pacing,now:() => time}),
    connectionStatus:() => '',TALK_LINK_LOST:'',
    MeshBuilder:{createState:() => ({}),addTriangleWithNormal(){},getMesh:() => ({})},Mesh:{Utils:{}},
    TextBuilder:{create:() => { const glyphs:string[] = []; return {
      add:(glyph:string) => glyphs.push(glyph),getText:() => { glyphDraws.push(glyphs.join('')); return {}; },
    }; }},Text:{Utils:{}},getFontAtlas:() => ({buffer:0,lineHeight:1,get:(glyph:string) => ({nw:metrics.advances[glyph] ?? 0.6})}),
    Shape:{create:() => ({})},ShapeRepresentation:() => ({createOrUpdate(){},destroy(){}}),Color:(value:number) => value});
  vm.runInContext(source.replace(/^import .*;$/gm,'').replace(/\bexport /g,''),context);
  const card = context.createTalkCaption({plugin:{runTask:async () => {
    await drawing;
    if (failDraw) throw Error('Synthetic GPU failure');
  }},presentation:{add(){},remove(){}},head:() => ({position:{x:0,y:0,z:0},matrix:identity()}),
    clearance:() => ({views:syntheticViews(),renderFromRoom:identity()}),now:() => time});
  const flush = async () => { for (let index=0;index<30;index++) await Promise.resolve(); };
  try {
    const pages = Array.from(context.captionPages(caption.text)) as string[];
    expect(pages).toHaveLength(3);
    expect(pages.join(' ')).toBe(caption.text);
    for (const page of pages.slice(0,-1)) expect(page).toMatch(/[.;,:]$/);
    card.set({outcome:caption.text,holdMs:caption.holdSeconds * 1000,
      onSeat:(seat:unknown) => recordTalkReplySeat(caption,seat,{scope})});
    await flush();
    expect(entries.filter(entry => entry.kind === 'tool-refused')).toEqual([]);
    release();
    await flush();
    if (!failDraw) for (const [index,page] of pages.entries()) {
      time = index * 6000; card.frame(); await flush();
      expect(card.text()).toBe(page);
      expect(glyphDraws.at(-1)).toBe(page.replace(/\s/gu,''));
      time = (index + 1) * 6000 - 1; card.frame(); await flush();
      expect(card.text()).toBe(page);
    }
    await t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready',diagnostics:{entries}});
    return (await t.call('read_headset_log',{kind:'tool-refused'})).structuredContent.entries;
  } finally { release(); await card.dispose(); }
}

describe('voice refusals before a command reaches the renderer', () => {
  it('captions a voice focus_selection for a missing chain and records tool-refused only after its seat answers', async () => {
    const t = await setup();
    try {
      const {caption, poll} = await refusal(t, 'focus_selection', {residues:{authorChain:'Z'}});
      expect(caption).toMatchObject({text:prefix + missingChain, speak:false, holdSeconds:6, utteranceId:voiceId,
        refusal:{tool:'focus_selection'}});
      expect((await t.call('read_headset_log', {kind:'tool-refused'})).structuredContent.entries).toEqual([]);
      expect(await recordSeat(t, caption)).toEqual([expect.objectContaining({kind:'tool-refused', detail:expect.objectContaining({
        tool:'focus_selection', captionId:caption.id, utteranceId:voiceId, captioned:true, drawn:true, seatOutcome:'shown'})})]);
      expect((await poll())._meta[PRIVATE_KEY].headsetCaption).toBeUndefined();
    } finally { await t.close(); }
  });

  it.each(['correction', 'agent correction', 'newer speech', 'newer command', 'newer reply', 'failed seat', 'superseded', 'wrong panel'] as const)('early-recorded correction refusal: %s', async path => {
      const t = await setup();
      try {
        // The correction was recorded before the surface request, as in a device run.
        const correctionId = '50746912-2f13-4f13-8cf5-e6b9baf6beb6';
        const first = await claimHeadsetUtterance(t, t.panelId, correctionId);
        const cursor = await claimHeadsetUtterance(t, t.panelId, voiceId, first);
        const target = {...t.binding, panelId:t.panelId};
        if (path === 'superseded') expect((await t.call('update_inspection', {...target,
          utteranceId:voiceId, commandId:'superseding-control',
          change:{kind:'utterance',patch:{action:'correct'}}})).isError).not.toBe(true);
        expect((await t.call('update_inspection', {...target, utteranceId:voiceId, commandId:'surface',
          change:{kind:'appearance',patch:{representation:'molecular-surface'}}})).isError).not.toBe(true);
        const delivery = await t.claim();
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        const rendered = await t.call('complete_inspection', {...target, commandId:'surface',
          claimToken:delivery.claimToken, scene:surface});
        expect(rendered.structuredContent.command.status).toBe('rendered');
        t.binding.baseInspectionRevision = rendered.structuredContent.inspectionRevision;
        const poll = () => t.call('poll_inspection', {...t.binding, panelId:t.panelId, availability:'ready'});
        await poll();
        const panelId = path === 'wrong panel'
          ? (await t.call('attach_inspection', {...t.binding, surface:'companion'})).structuredContent.panelId : t.panelId;
        const calls:string[] = [];
        const refused = path === 'agent correction' ? await sendAgentCall(
          {origin:'http://127.0.0.1:12345',token:'synthetic',sessionId:t.sessionId},
          {name:'update_inspection',utterance:'correct',arguments:{utteranceId:correctionId,panelId,
            change:{kind:'appearance',patch:{representation:'cartoon'}}}}, undefined,
          async (_host,name,args={}) => {
            calls.push(name);
            const answer = await t.call(name,{...args,sessionId:t.sessionId});
            if (answer.isError) throw Error(answer.content[0].text);
            return answer;
          }).then(() => { throw Error('A stale correction must refuse.'); }, error => ({isError:true,content:[{text:error.message}]}))
          : await t.call('update_inspection', {...t.binding, panelId, utteranceId:correctionId,
            commandId:'refused-correction', change:{kind:'utterance',patch:{action:'correct'}}});
        expect(refused.isError).toBe(true);
        if (path === 'correction' || path === 'agent correction' || path === 'newer speech') expect(refused.content[0].text).toBe(
          'The scene or saved revision changed since this utterance began. Ask again; the request will not be retargeted.');
        if (path === 'newer speech') await claimHeadsetUtterance(t,t.panelId,'55555555-5555-4555-8555-555555555555',cursor);
        if (path === 'newer command') expect((await t.call('focus_selection',{...t.binding,panelId:t.panelId,
          utteranceId:voiceId,commandId:'newer-refusal',residues:{authorChain:'Z'}})).isError).toBe(true);
        if (path === 'newer reply') expect((await t.call('say_to_headset',{utteranceId:voiceId,
          text:'The surface is still here.',speak:false})).isError).not.toBe(true);
        const heartbeat = await poll();
        const caption = heartbeat._meta[PRIVATE_KEY].headsetCaption;
        expect(heartbeat._meta[PRIVATE_KEY].delivery).toBeUndefined();
        expect((await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY].scene).toEqual(surface);
        expect((await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:'surface'})).structuredContent.command.status).toBe('rendered');
        expect((await t.call('read_headset_log',{kind:'tool-refused'})).structuredContent.entries).toEqual([]);
        if (path === 'newer command' || path === 'newer reply') {
          expect(caption).toMatchObject({utteranceId:voiceId,text:path==='newer command'?prefix+missingChain:'The surface is still here.'});
          return;
        }
        if (path !== 'correction' && path !== 'agent correction' && path !== 'failed seat') { expect(caption).toBeUndefined(); return; }
        expect(caption).toMatchObject({text:prefix + refused.content[0].text, utteranceId:correctionId,
          refusal:{tool:'update_inspection'}, speak:false});
        if (path === 'agent correction') expect(calls.filter(name=>name==='say_to_headset')).toEqual([]);
        else expect(caption.commandId).toBe('refused-correction');
        expect(caption.text).not.toMatch(/update_inspection|get_inspection_state/);
        const shown = path !== 'failed seat';
        expect(await recordSeat(t,caption,shown?'shown':'failed')).toEqual([expect.objectContaining({kind:'tool-refused',detail:expect.objectContaining({
          utteranceId:correctionId,captioned:shown,drawn:shown,seatOutcome:shown?'shown':'failed'})})]);
        expect((await poll())._meta[PRIVATE_KEY].headsetCaption).toBeUndefined();
      } finally { await t.close(); }
    });

  it.each(['recorded', 'claimed', 'selection', 'placement', 'compound', 'focus',
    'newer speech', 'newer command', 'newer reply', 'failed seat', 'superseded', 'wrong panel'] as const)('recorded correction dispatched after the surface renders: %s', async path => {
      const t = await setup();
      try {
        const surfaceId = '08ae8b8c-c643-423a-a823-8b1c0fd44055';
        const correctionId = 'dc8d80ca-77ee-48ff-ada2-79a50ea9a974';
        const cursor = await claimHeadsetUtterance(t,t.panelId,surfaceId);
        // A device run: surface, then correction, both recorded before dispatch.
        // Recording alone does not claim a transcript; cover both claim schedules.
        if (path === 'claimed') await claimHeadsetUtterance(t,t.panelId,correctionId,cursor);
        else await recordHeadsetUtterance(t,t.panelId,correctionId);
        const target = {...t.binding,panelId:t.panelId};
        const queued = await t.call('update_inspection',{...target,utteranceId:surfaceId,commandId:'surface',
          change:{kind:'appearance',patch:{representation:'molecular-surface'}}});
        expect(queued.structuredContent.command.status).toBe('queued');
        const delivery = await t.claim();
        expect(delivery.commandId).toBe('surface');
        const surface = structuredClone(t.scene);
        surface.inspection.appearance.representation = 'molecular-surface';
        const rendered = await t.call('complete_inspection',{...target,commandId:'surface',
          claimToken:delivery.claimToken,scene:surface});
        expect(rendered.structuredContent.command.status).toBe('rendered');
        t.binding.baseInspectionRevision = rendered.structuredContent.inspectionRevision;
        const poll = () => t.call('poll_inspection',{...t.binding,panelId:t.panelId,availability:'ready'});
        await poll();
        if (path === 'superseded') {
          const newerId = '66666666-6666-4666-8666-666666666666';
          await claimHeadsetUtterance(t,t.panelId,newerId,cursor + 1);
          expect((await t.call('update_inspection',{...t.binding,panelId:t.panelId,
            utteranceId:newerId,commandId:'superseding-control',
            change:{kind:'utterance',patch:{action:'correct'}}})).isError).not.toBe(true);
        }
        const panelId = path === 'wrong panel'
          ? (await t.call('attach_inspection',{...t.binding,surface:'companion'})).structuredContent.panelId : t.panelId;
        const change = path === 'selection' ? {kind:'selection',patch:{selectionKeys:[]}}
          : path === 'placement' ? {kind:'placement',patch:{scale:1.2}}
          : path === 'compound' ? {kind:'compound',patch:{ops:[
            {kind:'appearance',patch:{representation:'cartoon'}},{kind:'selection',patch:{selectionKeys:[]}}]}}
          : {kind:'appearance',patch:{representation:'cartoon'}};
        const tool = path === 'focus' ? 'focus_selection' : 'update_inspection';
        // This is the follow-on scene command, with no correction lifecycle call.
        const refused = await t.call(tool,{...t.binding,panelId,utteranceId:correctionId,
          commandId:'refused-correction',...(path === 'focus' ? {residues:{authorChain:'A'}} : {change})});
        expect(refused.isError).toBe(true);
        if (path === 'superseded') expect(refused.content[0].text).toBe(
          'This utterance was superseded by a newer correction or cancellation.');
        if (path !== 'wrong panel' && path !== 'superseded') expect(refused.content[0].text).toBe(
          'The scene or saved revision changed since this utterance began. Ask again; the request will not be retargeted.');
        if (path === 'newer speech') await claimHeadsetUtterance(t,t.panelId,'55555555-5555-4555-8555-555555555555',cursor + 1);
        if (path === 'newer command') expect((await t.call('focus_selection',{...t.binding,panelId:t.panelId,
          utteranceId:surfaceId,commandId:'newer-refusal',residues:{authorChain:'Z'}})).isError).toBe(true);
        if (path === 'newer reply') expect((await t.call('say_to_headset',{utteranceId:surfaceId,
          text:'The surface is still here.',speak:false})).isError).not.toBe(true);
        const heartbeat = await poll();
        const caption = heartbeat._meta[PRIVATE_KEY].headsetCaption;
        expect(heartbeat._meta[PRIVATE_KEY].delivery).toBeUndefined();
        expect((await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY].scene).toEqual(surface);
        expect((await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:'surface'})).structuredContent.command.status).toBe('rendered');
        expect((await t.call('read_headset_log',{kind:'tool-refused'})).structuredContent.entries).toEqual([]);
        if (path === 'newer command' || path === 'newer reply') {
          expect(caption).toMatchObject({utteranceId:surfaceId,
            text:path === 'newer command' ? prefix + missingChain : 'The surface is still here.'});
          return;
        }
        if (path === 'newer speech' || path === 'superseded' || path === 'wrong panel') {
          expect(caption).toBeUndefined();
          return;
        }
        expect(caption).toMatchObject({text:prefix + refused.content[0].text,utteranceId:correctionId,
          commandId:'refused-correction',refusal:{tool},speak:false,holdSeconds:6});
        expect(caption.text).not.toMatch(/update_inspection|focus_selection|get_inspection_state/);
        const shown = path !== 'failed seat';
        expect(await drawRefusal(t,caption,!shown)).toEqual([
          expect.objectContaining({kind:'tool-refused',detail:expect.objectContaining({
            utteranceId:correctionId,captioned:shown,drawn:shown,seatOutcome:shown?'shown':'failed'})})]);
        expect((await poll())._meta[PRIVATE_KEY].headsetCaption).toBeUndefined();
      } finally { await t.close(); }
    });

  it('returns the same missing-chain model error without a voice caption', async () => {
    const t = await setup();
    try {
      const {answer, caption} = await refusal(t, 'focus_selection', {residues:{authorChain:'Z'}}, false);
      expect(answer.content[0].text).toContain('No residue in the saved model matches');
      expect(caption).toBeUndefined();
      expect((await t.call('read_headset_log', {kind:'tool-refused'})).structuredContent.entries).toEqual([]);
    } finally { await t.close(); }
  });

  it.each([
    ['unknown residue range', 'focus_selection', {residues:{authorChain:'A',authorResidueRange:[900,910]}},
      '1CRN has no residues 900–910 in chain A in the saved model.'],
    ['unknown representation', 'update_inspection', {change:{kind:'appearance',patch:{representation:'blobs'}}},
      'Cannot show representation “blobs”. Choose cartoon, sticks, surface or spheres.'],
    ['reversed residue range', 'focus_selection', {residues:{authorChain:'A',authorResidueRange:[10,1]}},
      'Cannot select residues 10–1: the start must come before the end.'],
  ])('captions a voice %s refusal', async (_label, tool, args, sentence) => {
    const t = await setup();
    try {
      const {caption} = await refusal(t, tool, args);
      expect(caption).toMatchObject({text:prefix + sentence, speak:false, holdSeconds:6});
      expect((await recordSeat(t, caption))[0].detail).toMatchObject({tool, captioned:true});
    } finally { await t.close(); }
  });

  it('preserves schema refusals for a model request without captioning', async () => {
    const t = await setup();
    try {
      const {caption} = await refusal(t, 'update_inspection', {change:{kind:'appearance',patch:{representation:'blobs'}}}, false);
      expect(caption).toBeUndefined();
    } finally { await t.close(); }
  });

  it('keeps camera arguments refused with a wearer sentence', async () => {
    const t = await setup();
    try {
      const {caption} = await refusal(t, 'focus_selection', {residues:{authorChain:'A'},camera:t.scene.camera});
      expect(caption?.text).toContain('camera');
    } finally { await t.close(); }
  });
});


it('names the actual 4HHB chains for the device request', async () => {
  const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
  const t = await setup(hhb);
  try {
    const {caption} = await refusal(t, 'focus_selection', {residues:{authorChain:'Z'}});
    expect(caption.text).toBe(prefix + '4HHB has no chain Z. Chains are A, B, C, D.');
  } finally { await t.close(); }
});

it.each(['failed','unavailable','superseded','unmeasured'])('never credits a %s refusal seat as captioned', async outcome => {
  const t = await setup();
  try {
    const {caption} = await refusal(t, 'focus_selection', {residues:{authorChain:'Z'}});
    expect((await recordSeat(t, caption, outcome))[0].detail).toMatchObject({captioned:false,drawn:false,seatOutcome:outcome});
  } finally { await t.close(); }
});

it.each(['focus_selection','update_inspection'])('drops an obsolete %s refusal without discarding the newer pending caption', async tool => {
  const t = await setup();
  try {
    const cursor = await claimHeadsetUtterance(t,t.panelId,voiceId);
    const newer = '44444444-4444-4444-8444-444444444444';
    await claimHeadsetUtterance(t,t.panelId,newer,cursor);
    const input = {...t.binding,panelId:t.panelId};
    await t.call('focus_selection', {...input,utteranceId:newer,commandId:'newer',residues:{authorChain:'Y'}});
    const args = tool==='focus_selection'?{residues:{authorChain:'Z'}}:{change:{kind:'appearance',patch:{representation:'blobs'}}};
    expect((await t.call(tool,{...input,utteranceId:voiceId,commandId:'older',...args})).isError).toBe(true);
    const poll = await t.call('poll_inspection',{...input,availability:'ready'});
    expect(poll._meta[PRIVATE_KEY].headsetCaption).toMatchObject({utteranceId:newer,commandId:'newer',
      text:prefix + '1CRN has no chain Y. Chains are A.'});
    expect((await t.call('read_headset_log',{kind:'outcome'})).structuredContent.entries)
      .toContainEqual(expect.objectContaining({detail:expect.objectContaining({commandId:'older',stale:true,queued:false,drawn:false})}));
  } finally { await t.close(); }
});

it('keeps the advertised focus and update schemas unchanged', async () => {
  const t = await setup();
  try {
    const listed = await t.client.listTools();
    // What is advertised is the request form: the binding the host fills is optional there.
    for (const [tool,schema] of [['focus_selection',focusSelectionRequestSchema],['update_inspection',withImplicitBinding(updateInspectionSchema)]] as const) {
      const expected = z.toJSONSchema(schema,{target:'draft-7',io:'input'});
      expect(listed.tools.find(item=>item.name===`stereo_structure.${tool}`)?.inputSchema).toEqual(expected);
    }
  } finally { await t.close(); }
});

it.each([true,false])('reports a binding refusal only for voice origin=%s before dispatch', async voice => {
  const calls: {name:string;args:any}[] = [];
  const control = {origin:'http://127.0.0.1:12345',token:'synthetic',sessionId:'session'};
  const request:AgentCallTransport = async (_control,name,args) => {
    calls.push({name,args});
    if(name==='say_to_headset') return {structuredContent:{queued:true}};
    expect(name).toBe('get_inspection_state');
    return {structuredContent:{serverEpoch:'epoch',sourceToken:'source',stateRevision:1,inspectionRevision:1,panels:[]}};
  };
  await expect(sendAgentCall(control,{name:'focus_selection',arguments:{residues:{authorChain:'Z'},
    ...(voice?{utteranceId:voiceId}:{})}},undefined,request)).rejects.toThrow('No panel is showing this inspection');
  expect(calls.filter(call=>call.name==='focus_selection')).toEqual([]);
  expect(calls.filter(call=>call.name==='say_to_headset')).toEqual(voice?[{name:'say_to_headset',args:expect.objectContaining({
    utteranceId:voiceId,refusal:{tool:'focus_selection',sessionId:'session'},text:expect.stringContaining('No panel is showing this inspection')})}]:[]);
});
