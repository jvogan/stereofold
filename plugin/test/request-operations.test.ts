import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, expectedInspection } from '../src/inspection-contract.js';
import { captureRequestReferent } from '../src/inspection-operation.js';
import { compoundConfirmation, SPOKEN_WORD_LIMIT, UNDO_CONFIRMATION } from '../src/inspection-operation-words.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

describe('shared scene redo',()=>{
  async function changeAndUndo(t:Awaited<ReturnType<typeof setup>>) {
    const changed=structuredClone(t.scene) as any;
    changed.inspection.appearance.opacity=.5;
    changed.inspection.placement.scale=2;
    expect((await t.call('sync_inspection',{...t.binding(),scene:changed})).structuredContent.saved).toBe(true);
    await t.rebind();
    await t.call('undo_last_change',{...t.binding(),panelId:t.panelId,commandId:'prepare-undo'});
    const undo=await t.claim();
    expect(undo.historyAction).toBe('undo');
    const restored=expectedInspection(changed,undo.change);
    expect((await t.render(undo,restored)).structuredContent.command.status).toBe('rendered');
    await t.rebind();
    return {changed,restored};
  }
  it('reapplies a compound manual edit once, keeps the viewpoint, and allows undo again',async()=>{
    const t=await setup();
    try {
      const {changed,restored}=await changeAndUndo(t);
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId})).structuredContent.history)
        .toEqual({undoCount:0,redoCount:1,canUndo:false,canRedo:true});
      const request={...t.binding(),panelId:t.panelId,commandId:'redo-compound'};
      const redo=await t.call('redo_last_change',request);
      expect(redo.structuredContent).toMatchObject({redone:true,redid:{origin:'manual'},restores:['appearance','placement'],
        history:{undoCount:0,redoCount:1,canUndo:false,canRedo:false}});
      const delivery=await t.claim();
      expect(delivery.historyAction).toBe('redo');
      const painted=expectedInspection(restored,delivery.change);
      expect(painted.inspection.appearance).toEqual(changed.inspection.appearance);
      expect(painted.inspection.placement).toEqual(changed.inspection.placement);
      expect(painted.camera).toEqual(restored.camera);
      const rendered=await t.render(delivery,painted);
      expect(rendered.structuredContent).toMatchObject({command:{status:'rendered'},
        history:{undoCount:1,redoCount:0,canUndo:true,canRedo:false}});
      await t.rebind();
      const replay=await t.call('redo_last_change',request);
      expect(replay.structuredContent).toMatchObject({redone:true,command:{status:'rendered'},commandReplay:{currentSource:true}});
      expect(await t.claim()).toBeUndefined();
      expect((await t.call('undo_last_change',{sessionId:t.sessionId})).structuredContent.undone).toBe(true);
    } finally {await t.close();}
  });
  it('preserves redo on a camera-only save and clears it on a fresh scene edit',async()=>{
    const t=await setup();
    try {
      const {restored}=await changeAndUndo(t);
      const looked=structuredClone(restored);looked.camera.position=[1,0,80];
      const saved=await t.call('sync_inspection',{...t.binding(),scene:looked});
      expect(saved.structuredContent.history.redoCount).toBe(1);
      await t.rebind();
      looked.inspection.appearance.opacity=.8;
      const edited=await t.call('sync_inspection',{...t.binding(),scene:looked});
      expect(edited.structuredContent.history).toEqual({undoCount:1,redoCount:0,canUndo:true,canRedo:false});
      await t.rebind();
      expect((await t.call('redo_last_change',{sessionId:t.sessionId})).structuredContent.redone).toBe(false);
    } finally {await t.close();}
  });
  it('releases a failed redo claim without consuming its entry',async()=>{
    const t=await setup();
    try {
      const {restored}=await changeAndUndo(t);
      await t.call('redo_last_change',{...t.binding(),panelId:t.panelId,commandId:'redo-failed'});
      const delivery=await t.claim();
      const failed=await t.call('complete_inspection',{...t.binding(),panelId:t.panelId,
        commandId:delivery.commandId,claimToken:delivery.claimToken,failure:'render_failed'});
      expect(failed.structuredContent).toMatchObject({command:{status:'rejected'},history:{redoCount:1,canRedo:true}});
      await t.rebind();
      await t.call('redo_last_change',{...t.binding(),panelId:t.panelId,commandId:'redo-again'});
      const retry=await t.claim();
      expect((await t.render(retry,expectedInspection(restored,retry.change))).structuredContent.history)
        .toMatchObject({undoCount:1,redoCount:0});
    } finally {await t.close();}
  });
  it('replays an empty redo answer after newer work becomes redoable',async()=>{
    const t=await setup();
    try {
      const request={sessionId:t.sessionId,commandId:'empty-redo'};
      expect((await t.call('redo_last_change',request)).structuredContent.redone).toBe(false);
      await changeAndUndo(t);
      const replay=await t.call('redo_last_change',request);
      expect(replay.structuredContent).toMatchObject({redone:false,history:{redoCount:1,canRedo:true},commandReplay:{currentSource:true}});
      expect(await t.claim()).toBeUndefined();
    } finally {await t.close();}
  });
  it('returns current history and revisions when a waited redo finishes rendering',async()=>{
    const t=await setup();
    try {
      const {restored}=await changeAndUndo(t);
      const pending=t.call('redo_last_change',{...t.binding(),panelId:t.panelId,commandId:'waited-redo',waitForRenderMs:1000});
      let delivery:any;
      for(let attempt=0;attempt<20 && !delivery;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,10));
        delivery=await t.claim();
      }
      expect(delivery).toBeDefined();
      const complete=await t.render(delivery,expectedInspection(restored,delivery.change));
      const answer=await pending;
      expect(answer.structuredContent).toMatchObject({redone:true,command:{status:'rendered'},
        inspectionRevision:complete.structuredContent.inspectionRevision,
        history:{undoCount:1,redoCount:0,canUndo:true,canRedo:false}});
    }finally{await t.close();}
  });
  it.each(['undo','redo'])('refuses a rapid second %s until the first receipt settles',async action=>{
    const t=await setup();
    try {
      const {changed,restored}=await changeAndUndo(t);
      if(action==='undo') {
        await t.call('redo_last_change',{...t.binding(),panelId:t.panelId,commandId:'prepare-redo'});
        const redo=await t.claim();await t.render(redo,expectedInspection(restored,redo.change));await t.rebind();
      }
      await t.call(`${action}_last_change`,{...t.binding(),panelId:t.panelId,commandId:`first-${action}`});
      const second={...t.binding(),panelId:t.panelId,commandId:`second-${action}`};
      const refused=await t.call(`${action}_last_change`,second);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('already in progress');
      const delivery=await t.claim();
      await t.call('complete_inspection',{...t.binding(),panelId:t.panelId,commandId:delivery.commandId,
        claimToken:delivery.claimToken,failure:'render_failed'});
      await t.rebind();
      const retry=await t.call(`${action}_last_change`,second);
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent.command.status).toBe('queued');
      const applied=await t.claim();
      expect(applied.commandId).toBe(second.commandId);
      expect((await t.render(applied,expectedInspection(action==='undo'?changed:restored,applied.change)))
        .structuredContent.command.status).toBe('rendered');
    }finally{await t.close();}
  });
  it.each(['undo','redo'])('deduplicates overlapping identical %s requests before admission finishes',async action=>{
    const t=await setup();
    try {
      const {changed,restored}=await changeAndUndo(t);
      if(action==='undo') {
        await t.call('redo_last_change',{sessionId:t.sessionId,commandId:'prepare-concurrent-redo'});
        const delivery=await t.claim();
        await t.render(delivery,expectedInspection(restored,delivery.change));await t.rebind();
      }
      const request={sessionId:t.sessionId,commandId:`overlapping-${action}`};
      const answers=await Promise.all([t.call(`${action}_last_change`,request),
        t.call(`${action}_last_change`,{commandId:request.commandId,sessionId:request.sessionId})]);
      for(const answer of answers) {
        expect(answer.isError,JSON.stringify(answer.content)).not.toBe(true);
        expect(answer.structuredContent.command).toMatchObject({commandId:request.commandId,status:'queued'});
      }
      const delivery=await t.claim();
      expect(delivery.commandId).toBe(request.commandId);
      expect(await t.claim()).toBeUndefined();
      const rendered=await t.render(delivery,expectedInspection(action==='undo'?changed:restored,delivery.change));
      expect(rendered.structuredContent.history).toMatchObject(action==='undo'
        ? {undoCount:0,redoCount:1} : {undoCount:1,redoCount:0});
    }finally{await t.close();}
  });
  it.each(['action','wait budget','binding'])('rejects overlapping history requests that reuse an ID for a different %s',async difference=>{
    const t=await setup();
    try {
      const {restored}=await changeAndUndo(t);
      const request={sessionId:t.sessionId,commandId:'overlapping-different-history'};
      const changedRequest=difference==='binding'?{...request,...t.binding(),panelId:t.panelId}:{...request,waitForRenderMs:0};
      const [redo,other]=await Promise.all([t.call('redo_last_change',request),difference==='action'
        ? t.call('undo_last_change',request) : t.call('redo_last_change',changedRequest)]);
      expect(redo.isError).not.toBe(true);
      expect(other.isError).toBe(true);
      expect(other.content[0].text).toContain('different request');
      const delivery=await t.claim();expect(delivery.historyAction).toBe('redo');
      const rendered=await t.render(delivery,expectedInspection(restored,delivery.change));
      expect(rendered.structuredContent.history).toMatchObject({undoCount:1,redoCount:0});
      const retained=await t.call(difference==='action'?'undo_last_change':'redo_last_change',difference==='action'?request:changedRequest);
      expect(retained.isError).toBe(true);expect(retained.content[0].text).toContain('different request');
      expect((await t.call('redo_last_change',request)).structuredContent.command.status).toBe('rendered');
    }finally{await t.close();}
  });
  it('shares an overlapping scene edit and its render wait without adding a second history entry',async()=>{
    const t=await setup();
    try {
      const request={sessionId:t.sessionId,commandId:'overlapping-waited-edit',waitForRenderMs:1000,
        change:{kind:'appearance',patch:{opacity:.6}}};
      const pending=[t.call('update_inspection',request),t.call('update_inspection',structuredClone(request))];
      let delivery:any;
      for(let attempt=0;attempt<20 && !delivery;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,10));delivery=await t.claim();
      }
      expect(delivery?.commandId).toBe(request.commandId);
      const completed=await t.render(delivery,expectedInspection(t.scene as any,delivery.change));
      for(const answer of await Promise.all(pending)) {
        expect(answer.isError).not.toBe(true);
        expect(answer.structuredContent).toMatchObject({command:{commandId:request.commandId,status:'rendered'},
          inspectionRevision:completed.structuredContent.inspectionRevision,history:{undoCount:1,redoCount:0}});
      }
      expect(await t.claim()).toBeUndefined();
    }finally{await t.close();}
  });
  it('keeps an expired redo available and ignores its late render receipt',async()=>{
    const t=await setup();
    try {
      const {restored}=await changeAndUndo(t);
      const queued=await t.call('redo_last_change',{...t.binding(),panelId:t.panelId,commandId:'expired-redo'});
      const expired=await t.claim(),revision=t.binding().baseInspectionRevision;
      // The source-size budget is part of the receipt; 120 seconds is only its floor.
      const budget=queued.structuredContent.command.renderBudgetMs;
      expect(Number.isSafeInteger(budget)).toBe(true);
      expect(budget).toBeGreaterThanOrEqual(120_000);
      t.clock.now+=budget-1;
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:expired.commandId}))
        .structuredContent.command.status).toBe('rendering');
      t.clock.now+=2;
      const state=(await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:expired.commandId})).structuredContent;
      expect(state).toMatchObject({inspectionRevision:revision,command:{status:'unconfirmed'},
        history:{undoCount:0,redoCount:1,canUndo:false,canRedo:true}});
      const late=await t.render(expired,expectedInspection(restored,expired.change));
      expect(late.structuredContent).toMatchObject({accepted:false,inspectionRevision:revision,
        history:{undoCount:0,redoCount:1,canRedo:true}});
      const panelId=(await t.call('attach_inspection',{...t.binding(),surface:'companion'})).structuredContent.panelId;
      await t.call('redo_last_change',{...t.binding(),panelId,commandId:'after-expiry'});
      const next=(await t.call('poll_inspection',{...t.binding(),panelId,availability:'ready'}))._meta[PRIVATE_KEY].delivery;
      const rendered=await t.call('complete_inspection',{...t.binding(),panelId,commandId:next.commandId,
        claimToken:next.claimToken,scene:expectedInspection(restored,next.change)});
      expect(rendered.structuredContent).toMatchObject({command:{status:'rendered'},history:{undoCount:1,redoCount:0}});
    }finally{await t.close();}
  });
});

const KEY = [
  { id: 'protein', label: 'protein', color: '#8899aa', chain: 'A' },
  { id: 'site', label: 'active site', color: '#ffaa33', chain: 'A', residues: { from: 22, to: 26 } },
];

const lesson = (filePath: string) => ({
  version: 1, id: 'referent-demo', title: 'Referent demo', mode: 'explore',
  provenance: { sourceRefs: [{ kind: 'local', ref: filePath }] },
  chapters: [
    { id: 'intro', title: 'Intro', caption: 'The whole complex.', durationSeconds: .5,
      changes: [{ kind: 'rotate', durationSeconds: .5, degrees: 10 }],
      immersive: { appearance: { representation: 'cartoon', color: 'chain-id' },
        emphasis: { parts: KEY, contextOpacity: 0.18 } } },
  ],
});

type Options = Parameters<typeof createStereoStructureServer>[1];

async function setup(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-referent-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // A steerable clock: the spoken route holds one voice request per panel per
  // second, and a test that says two things has to let that second pass.
  const clock = { now: 1_700_000_000_000 };
  const server = createStereoStructureServer(undefined, { now: () => clock.now, ...options });
  const client = new Client({ name: 'Stereofold request operation test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif'), lessonPath = join(root, 'lesson.json');
  await writeFile(filePath, cif);
  await writeFile(lessonPath, JSON.stringify(lesson(filePath)));
  const sessionId = (await call('inspect_lesson', { filePath, lessonPath })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
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
  let binding = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  /**
   * Re-read the revisions a later command has to be built on, then let the
   * panel report itself at them, exactly as a live page's heartbeat does.
   */
  const rebind = async () => {
    const state = (await call('get_inspection_state', { sessionId })).structuredContent;
    binding = { ...binding, baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision };
    await call('poll_inspection', { ...binding, panelId, availability: 'ready' });
    return binding;
  };
  const claim = async () => (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  /** Render a delivery by handing back the scene the panel would have drawn. */
  const render = async (delivery: any, painted: any) => call('complete_inspection', {
    ...binding, panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, scene: painted });
  return { call, rows, scene, panelId, sessionId, claim, render, rebind, clock, filePath,
    binding: () => binding,
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('the referent a request was captured with', () => {
  it('frames the selection the request began on, not the one it arrives to', async () => {
    const t = await setup();
    try {
      // The grip going down is the start of the request. The host reads what
      // the wearer is on there and hands the same thing back.
      const pressed = await t.call('push_to_talk', { sessionId: t.sessionId, state: 'down', pointing: { partId: 'site' } });
      const referent = pressed.structuredContent.referent;
      expect(referent).toMatchObject({ sourceToken: t.binding().sourceToken, selectionKeys: [t.rows[0].key], partId: 'site' });

      // Now the wearer moves on while the transcription and the model answer
      // are still running: a different residue is selected and saved.
      const moved = structuredClone(t.scene) as any;
      moved.selectionKeys = [t.rows[1].key];
      const saved = await t.call('sync_inspection', { ...t.binding(), scene: moved });
      expect(saved.structuredContent.saved).toBe(true);
      await t.rebind();

      // The answer finally lands. It names no region, so it means "the one
      // they were looking at" — and that is the first row, not the second.
      const queued = await t.call('focus_selection', { ...t.binding(), panelId: t.panelId, commandId: 'focus-referent', referent });
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      const delivery = await t.claim();
      expect(queued.structuredContent.command.appliedTo).toEqual({selectionKeys:referent.selectionKeys,capturedAt:referent.capturedAt});
      expect(delivery.change.kind).toBe('focus');
      expect(delivery.change.patch.selectionKeys).toEqual([t.rows[0].key]);
      expect(delivery.change.patch.selectionKeys).not.toEqual(moved.selectionKeys);
    } finally { await t.close(); }
  });

  it('sends a free-spoken request to the desktop agent with the referent on it', async () => {
    const t = await setup({ voice: { transcribe: async () => 'make this one orange and fade the rest' } });
    try {
      const desktop = (await t.call('attach_inspection', { ...t.binding(), surface: 'desktop' })).structuredContent.panelId as string;
      const heard = await t.call('voice_command', { ...t.binding(), panelId: t.panelId,
        audio: { pcm16leBase64: Buffer.alloc(8_640).toString('base64'), sampleRate: 24_000, durationMs: 180 } });
      expect(heard.structuredContent.intentId).toBeTruthy();

      const claimed = await t.call('claim_voice_intent', { ...t.binding(), panelId: desktop });
      const intent = claimed._meta[PRIVATE_KEY].voiceIntent.intent;
      expect(intent.transcript).toBe('make this one orange and fade the rest');
      // The words reach the Mac with what "this one" meant when they were said.
      expect(intent.referent).toMatchObject({ sourceToken: t.binding().sourceToken, selectionKeys: [t.rows[0].key] });
    } finally { await t.close(); }
  });

  it('reads "this part" as the part the request began on, and refuses one captured elsewhere', async () => {
    const t = await setup();
    try {
      const pressed = await t.call('push_to_talk', { sessionId: t.sessionId, state: 'down', pointing: { partId: 'site' } });
      const referent = pressed.structuredContent.referent;

      const queued = await t.call('emphasize', { ...t.binding(), panelId: t.panelId, commandId: 'emph-this',
        parts: ['this part'], referent });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.emphasis.focus).toEqual(['site']);
      expect(queued.structuredContent.command.appliedTo).toEqual({capturedAt:referent.capturedAt,
        selectionKeys:t.rows.filter(row=>row.identity.authorResidue>=22 && row.identity.authorResidue<=26).map(row=>row.key)});

      // A referent captured against another structure describes nothing here.
      const foreign = { ...referent, sourceToken: '00000000-0000-4000-8000-000000000000' };
      const refused = await t.call('emphasize', { ...t.binding(), panelId: t.panelId, commandId: 'emph-foreign',
        parts: ['this part'], referent: foreign });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/captured on a different structure/);

      // Without a referent the pronoun is not answerable, and says so.
      const bare = await t.call('emphasize', { ...t.binding(), panelId: t.panelId, commandId: 'emph-bare', parts: ['that'] });
      expect(bare.isError).toBe(true);
      expect(JSON.stringify(bare.content)).toMatch(/needs the referent this request started with/);
    } finally { await t.close(); }
  });
});

describe('referents on every scene edit', () => {
  async function capturedThenMoved(t:Awaited<ReturnType<typeof setup>>) {
    const referent=(await t.call('push_to_talk',{sessionId:t.sessionId,state:'down'})).structuredContent.referent;
    expect(referent).toMatchObject({modelNumber:t.scene.modelNumber,assemblyId:t.scene.assemblyId});
    const moved=structuredClone(t.scene);moved.selectionKeys=[t.rows[1].key];
    expect((await t.call('sync_inspection',{...t.binding(),scene:moved})).structuredContent.saved).toBe(true);
    await t.rebind();
    return {referent,moved};
  }
  it.each(['only', 'show', 'compound', 'existing selection', 'all five'])('binds delayed visibility %s to captured keys in one render and undo',async(kind)=>{
    const t=await setup();try {
      const {referent,moved}=await capturedThenMoved(t);
      // A pointed residue must not replace the captured selected set here.
      referent.residueKey=t.rows[2].key;
      const visibility={kind:'visibility',patch:{op:kind==='show'?'show':'only',selection:true}};
      const ops:any[]=[visibility,{kind:'appearance',patch:{fog:10}}];
      if(kind==='existing selection'||kind==='all five') ops.push({kind:'selection',patch:{selectionKeys:moved.selectionKeys}});
      if(kind==='all five') ops.push({kind:'placement',patch:{scale:2}},{kind:'emphasis',parts:[]});
      const change=kind==='only'||kind==='show'?visibility:{kind:'compound',patch:{ops}};
      const args={...t.binding(),panelId:t.panelId,commandId:'captured-visibility',referent,referentScope:'scene',change};
      const queued=await t.call('update_inspection',args);
      expect(queued.isError,JSON.stringify(queued)).not.toBe(true);
      const appliedTo={capturedAt:referent.capturedAt,selectionKeys:referent.selectionKeys,
        ...(kind==='only'||kind==='show'?{}:{scene:true})};
      expect(queued.structuredContent.command).toMatchObject({status:'queued',appliedTo});
      if(kind==='only') expect(queued.structuredContent.visibility.now).toBe('Showing only the selection.');
      expect((await t.call('update_inspection',args)).structuredContent.command).toEqual(queued.structuredContent.command);
      const delivery=await t.claim();
      expect(delivery.change.kind).toBe('compound');
      expect(delivery.change.patch.ops[0]).toEqual({kind:'selection',patch:{selectionKeys:referent.selectionKeys}});
      expect(delivery.change.patch.ops.filter((op:any)=>op.kind==='selection')).toHaveLength(1);
      expect(delivery.change.patch.ops.length).toBeLessThanOrEqual(5);
      const painted=expectedInspection(moved as any,delivery.change);
      const done=await t.render(delivery,painted);
      expect(done.structuredContent.command).toMatchObject({status:'rendered',appliedTo});
      expect((await t.call('update_inspection',args)).structuredContent.command).toEqual(done.structuredContent.command);
      expect((await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:args.commandId})).structuredContent.command)
        .toMatchObject({status:'rendered',appliedTo});
      await t.rebind();
      const undo=await t.call('undo_last_change',{...t.binding(),panelId:t.panelId,commandId:'undo-visibility'});
      expect(undo.structuredContent.restores).toContain('selection');
      if(kind!=='show') expect(undo.structuredContent.restores).toContain('visibility');
      const back=await t.claim();
      const restored=expectedInspection(painted,back.change);
      expect(restored.selectionKeys).toEqual(moved.selectionKeys);
      expect(restored.inspection.visibility).toEqual((moved.inspection as any).visibility);
      expect((await t.render(back,restored)).structuredContent.command.status).toBe('rendered');
    }finally{await t.close();}
  });
  it.each(['model', 'assembly', 'canonical key'])('validates visibility referent %s for selection and explicit class targets',async(kind)=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      if(kind==='model') referent.modelNumber=999;
      if(kind==='assembly') referent.assemblyId='foreign';
      if(kind==='canonical key') referent.selectionKeys=['unknown-key'];
      for(const [index,patch] of [{op:'only',selection:true},{op:'hide',classes:['water']}].entries()) {
        const reply=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:`invalid-visibility-${index}`,
          referent,change:{kind:'visibility',patch}});
        expect(reply.isError).toBe(true);
        expect(reply.content[0].text).toMatch(/model|assembly|canonical/);
        expect(await t.claim()).toBeUndefined();
      }
    }finally{await t.close();}
  });
  it.each(['undo_last_change','manage_inspection_view','say_to_headset'])('%s does not silently discard an unsupported molecular referent',async(tool)=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      const args=tool==='say_to_headset'?{text:'That selection.',speak:false}
        :{...t.binding(),panelId:t.panelId,commandId:'referent-audit',
          ...(tool==='manage_inspection_view'?{action:'restore',viewId:'00000000-0000-4000-8000-000000000000'}:{})};
      const reply=await t.call(tool,{...args,referent});
      expect(reply.isError).toBe(true);
      expect(reply.content[0].text).toMatch(/referent/);
      expect(await t.claim()).toBeUndefined();
    }finally{await t.close();}
  });
  it('leaves visibility without a referent on the live selection',async()=>{
    const t=await setup();try {
      const {moved}=await capturedThenMoved(t);
      const queued=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'live-visibility',
        change:{kind:'visibility',patch:{op:'only',selection:true}}});
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.command.appliedTo).toBeUndefined();
      const delivery=await t.claim();
      expect(delivery.change.kind).toBe('visibility');
      const painted=expectedInspection(moved as any,delivery.change);
      expect(painted.selectionKeys).toEqual(moved.selectionKeys);
      expect((await t.render(delivery,painted)).structuredContent.command.status).toBe('rendered');
    }finally{await t.close();}
  });
  it('selects the captured canonical keys with fresh revisions and retains appliedTo through rendered receipt and retry',async()=>{
    const t=await setup();try {
      const {referent,moved}=await capturedThenMoved(t);
      const args={...t.binding(),panelId:t.panelId,commandId:'old-selection',referent,
        change:{kind:'selection',patch:{selectionKeys:referent.selectionKeys}}};
      const queued=await t.call('update_inspection',args);
      const appliedTo={selectionKeys:referent.selectionKeys,capturedAt:referent.capturedAt};
      expect(queued.structuredContent.command).toMatchObject({status:'queued',appliedTo});
      expect((await t.call('update_inspection',args)).structuredContent.command).toEqual(queued.structuredContent.command);
      const delivery=await t.claim();expect(delivery.change.patch.selectionKeys).toEqual(referent.selectionKeys);
      moved.selectionKeys=referent.selectionKeys;
      const done=await t.render(delivery,moved);
      expect(done.structuredContent.command).toMatchObject({status:'rendered',appliedTo});
      const read=await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:args.commandId});
      expect(read.structuredContent.command).toMatchObject({status:'rendered',appliedTo});
      const altered=await t.call('update_inspection',{...args,referent:{...referent,capturedAt:referent.capturedAt+1}});
      expect(altered.isError).toBe(true);expect(altered.content[0].text).toContain('different request');
    }finally{await t.close();}
  });
  it.each([
    ['selection',{kind:'selection',patch:{selectionKeys:['LIVE']}}],
    ['color',{kind:'appearance',patch:{color:'uniform',uniformColor:'#0000ff'}}],
    ['opacity',{kind:'appearance',patch:{opacity:0.5}}],
    ['labels',{kind:'appearance',patch:{labels:true}}],
    ['highlight',{kind:'appearance',patch:{highlightColor:'#0000ff'}}],
    ['placement',{kind:'placement',patch:{scale:2}}],
    ['compound',{kind:'compound',patch:{ops:[{kind:'appearance',patch:{labels:true}},{kind:'selection',patch:{selectionKeys:['LIVE']}}]}}],
  ])('binds a delayed %s to the captured target without broadening it',async(_name,change)=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      const resolved=JSON.parse(JSON.stringify(change),(_key,value)=>value==='LIVE'?t.rows[1].key:value);
      const r=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'delayed',referent,change:resolved});
      if(_name==='color' || _name==='opacity') {
        expect(r.isError).not.toBe(true);
        expect(r.structuredContent.command.appliedTo).toEqual({selectionKeys:referent.selectionKeys,capturedAt:referent.capturedAt});
        const delivered=await t.claim();
        expect(delivered.change.kind).toBe('styles');
        expect(delivered.change.patch.styles).toEqual([{selectionKeys:referent.selectionKeys,...resolved.patch}]);
      } else {
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(_name==='placement'?/Placement moves the whole molecule/:/captured/);
        expect(await t.claim()).toBeUndefined();
      }
    }finally{await t.close();}
  });
  it('honours explicit scene scope for representation and color',async()=>{
    const t=await setup();try {
      const {referent,moved}=await capturedThenMoved(t);
      const r=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'whole',referent,referentScope:'scene',
        change:{kind:'appearance',patch:{representation:'ball-and-stick'}}});
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent.command.appliedTo).toEqual({scene:true,capturedAt:referent.capturedAt});
      const d=await t.claim();moved.inspection.appearance.representation='ball-and-stick';
      expect((await t.render(d,moved)).structuredContent.command.status).toBe('rendered');await t.rebind();
      const color=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'whole-color',referent,referentScope:'scene',
        change:{kind:'appearance',patch:{uniformColor:'#0000ff'}}});
      expect(color.isError).not.toBe(true);expect(color.structuredContent.command.appliedTo).toEqual({scene:true,capturedAt:referent.capturedAt});
    }finally{await t.close();}
  });
  it.each(['model','assembly','unknown key','duplicate key','pointed key'])('validates captured %s even on informational appearance changes',async(kind)=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      if(kind==='model') referent.modelNumber=999;
      if(kind==='assembly') referent.assemblyId='another-copy';
      if(kind==='unknown key') referent.selectionKeys=['unknown-copy-key'];
      if(kind==='duplicate key') referent.selectionKeys=[t.rows[0].key,t.rows[0].key];
      if(kind==='pointed key') referent.residueKey='unknown-copy-key';
      const r=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'invalid',referent,
        change:{kind:'appearance',patch:{representation:'cartoon'}}});
      expect(r.isError).toBe(true);expect(r.content[0].text).toMatch(/model|assembly|canonical/);
      expect(await t.claim()).toBeUndefined();
    }finally{await t.close();}
  });
  it('refuses every referent-bearing edit after actual source replacement despite fresh source bindings',async()=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      const replaced=await t.call('replace_inspection_source',{...t.binding(),panelId:t.panelId,source:{kind:'file',path:t.filePath}});
      expect(replaced.isError).not.toBe(true);
      const fresh=(await t.call('get_inspection',{sessionId:t.sessionId}))._meta[PRIVATE_KEY];
      expect(fresh.sourceToken).not.toBe(referent.sourceToken);
      const binding={sessionId:t.sessionId,serverEpoch:fresh.serverEpoch,sourceToken:fresh.sourceToken,
        baseStateRevision:fresh.stateRevision,baseInspectionRevision:fresh.inspectionRevision};
      const saved=(await t.call('sync_inspection',{...binding,scene:t.scene})).structuredContent;
      binding.baseStateRevision=saved.stateRevision;binding.baseInspectionRevision=saved.inspectionRevision;
      const panelId=(await t.call('attach_inspection',{...binding,surface:'companion'})).structuredContent.panelId;
      await t.call('poll_inspection',{...binding,panelId,availability:'ready'});
      const edits:[string,Record<string,unknown>][]=[
        ['update_inspection',{change:{kind:'appearance',patch:{representation:'cartoon'}}}],
        ['update_inspection',{change:{kind:'placement',patch:{scale:2}},referentScope:'scene'}],
        ['update_inspection',{change:{kind:'selection',patch:{selectionKeys:t.scene.selectionKeys}}}],
        ['update_inspection',{change:{kind:'compound',patch:{ops:[{kind:'appearance',patch:{fog:10}},{kind:'emphasis',parts:[]}]}}}],
        ['update_inspection',{change:{kind:'visibility',patch:{op:'only',selection:true}}}],
        ['update_inspection',{change:{kind:'visibility',patch:{op:'hide',classes:['water']}}}],
        ['update_inspection',{change:{kind:'visibility',patch:{op:'hide',chains:[{labelChain:t.rows[0].identity.labelChain,copyId:t.rows[0].identity.copyId}]}}}],
        ['update_inspection',{change:{kind:'compound',patch:{ops:[{kind:'visibility',patch:{op:'only',selection:true}},{kind:'appearance',patch:{fog:10}}]}}}],
        ['focus_selection',{selectionKeys:t.scene.selectionKeys}],
        ['focus_selection',{residues:{labelChain:'A'}}],
        ['emphasize',{parts:[]}],
      ];
      for(const [index,[tool,edit]] of edits.entries()) {
        const r=await t.call(tool,{...binding,panelId,commandId:`foreign-${index}`,referent,...edit});
        expect(r.isError,JSON.stringify(r)).toBe(true);expect(r.content[0].text).toContain('captured on a different structure');
      }
    }finally{await t.close();}
  });
  it('records label clearing as a whole-scene operation after selection changes',async()=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      const r=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'clear-labels',referent,
        change:{kind:'appearance',patch:{labels:false}}});
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent.command.appliedTo).toEqual({scene:true,capturedAt:referent.capturedAt});
    }finally{await t.close();}
  });
  it('keeps referent-less legacy edits unchanged without target metadata',async()=>{
    const t=await setup();try {
      const r=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'legacy',
        change:{kind:'appearance',patch:{opacity:0.5}}});
      expect(r.isError).not.toBe(true);expect(r.structuredContent.command.appliedTo).toBeUndefined();
      expect((await t.claim()).change).toEqual({kind:'appearance',patch:{opacity:0.5}});
    }finally{await t.close();}
  });
  it('never broadens captured residues into the currently lit lesson part',async()=>{
    const t=await setup();try {
      const lit=structuredClone(t.scene) as any;
      lit.inspection.emphasis={parts:KEY,focus:['site'],contextOpacity:0.12};
      const referent=captureRequestReferent({sourceToken:t.binding().sourceToken,scene:lit,at:t.clock.now});
      expect(referent.partId).toBeUndefined();
      const r=await t.call('emphasize',{...t.binding(),panelId:t.panelId,commandId:'residue-emphasis',parts:['this'],referent});
      expect(r.isError).toBe(true);expect(r.content[0].text).toContain('Selection-only emphasis is unsupported');
      lit.selectionKeys=[];
      expect(captureRequestReferent({sourceToken:t.binding().sourceToken,scene:lit,at:t.clock.now}).partId).toBe('site');
    }finally{await t.close();}
  });
  it('refuses explicit focus on newer keys and uses a captured pointed residue instead of live selection',async()=>{
    const t=await setup();try {
      const {referent}=await capturedThenMoved(t);
      const args={...t.binding(),panelId:t.panelId,referent:{...referent,residueKey:t.rows[2].key}};
      const bad=await t.call('focus_selection',{...args,commandId:'wrong-focus',selectionKeys:[t.rows[1].key]});
      expect(bad.isError).toBe(true);expect(bad.content[0].text).toContain('captured canonical target');
      const good=await t.call('focus_selection',{...args,commandId:'point-focus'});
      expect(good.isError).not.toBe(true);
      expect(good.structuredContent.command.appliedTo.selectionKeys).toEqual([t.rows[2].key]);
      expect((await t.claim()).change.patch.selectionKeys).toEqual([t.rows[2].key]);
    }finally{await t.close();}
  });
  it('lets the corrected utterance referent win and never admits the older target',async()=>{
    const t=await setup();try {
      const {referent,moved}=await capturedThenMoved(t);
      const control=async(commandId:string,action:string)=>(await t.call('update_inspection',{
        ...t.binding(),panelId:t.panelId,commandId,change:{kind:'utterance',patch:{action}}})).structuredContent.lifecycle;
      const old=(await control('begin-old','begin')).utterance.utteranceId;
      const oldArgs={...t.binding(),panelId:t.panelId,commandId:'edit-old',utteranceId:old,referent,
        change:{kind:'selection',patch:{selectionKeys:referent.selectionKeys}}};
      expect((await t.call('update_inspection',oldArgs)).isError).not.toBe(true);
      // A separate speech capture for the correcting utterance. Grip-edge
      // retention until final audio is covered by the transcription suite.
      const corrected=captureRequestReferent({sourceToken:t.binding().sourceToken,scene:moved as any,at:t.clock.now+1});
      expect(corrected.selectionKeys).toEqual(moved.selectionKeys);
      const lifecycle=await control('correct-new','correct');
      expect(lifecycle.commands[0]).toMatchObject({status:'superseded',fenceReleased:'pending',appliedTo:{selectionKeys:referent.selectionKeys}});
      const late=await t.call('update_inspection',{...oldArgs,commandId:'late-old'});
      expect(late.isError).toBe(true);expect(late.content[0].text).toContain('superseded');
      const r=await t.call('update_inspection',{...t.binding(),panelId:t.panelId,commandId:'edit-new',
        utteranceId:lifecycle.utterance.utteranceId,referent:corrected,change:{kind:'selection',patch:{selectionKeys:corrected.selectionKeys}}});
      expect(r.isError).not.toBe(true);
      const d=await t.claim();expect(d.commandId).toBe('edit-new');
      expect((await t.render(d,moved)).structuredContent.command).toMatchObject({status:'rendered',appliedTo:{selectionKeys:corrected.selectionKeys}});
    }finally{await t.close();}
  });
});

describe('several edits asked for in one breath', () => {
  it('renders once, confirms once in under twelve words, and leaves one thing to undo', async () => {
    const t = await setup();
    try {
      const change = { kind: 'compound', patch: { ops: [
        { kind: 'emphasis', parts: ['active site'], context: 0.18 },
        { kind: 'appearance', patch: { opacity: 0.5 } },
        { kind: 'placement', patch: { scale: 2 } },
      ] } };
      const queued = await t.call('update_inspection', { ...t.binding(), panelId: t.panelId, commandId: 'compound-one', change });
      expect(queued.isError).not.toBe(true);
      // One command, one receipt.
      expect(queued.structuredContent.command).toMatchObject({ commandId: 'compound-one', status: 'queued' });
      expect(queued.structuredContent.compound.ops).toEqual(['emphasis', 'appearance', 'placement']);
      expect(queued.content[0].text).toContain(`If the change renders on a connected headset, its confirmation is ${queued.structuredContent.compound.confirmation}`);
      expect(queued.content[0].text).not.toContain('the wearer hears');

      // One spoken line, and it is short enough to be over before the next
      // thing happens.
      const line = queued.structuredContent.compound.confirmation;
      expect(line).toBe('Done. Active site, fade and size changed.');
      expect(line.trim().split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_WORD_LIMIT);
      expect(line).not.toContain('—');

      // One delivery, so the panel renders it once.
      const delivery = await t.claim();
      expect(delivery.change.kind).toBe('compound');
      expect(delivery.change.patch.ops.map((op: any) => op.kind)).toEqual(['emphasis', 'appearance', 'placement']);
      // The lesson colour key is expanded here, so a caller never retypes one.
      expect(delivery.change.patch.ops[0].patch.parts).toEqual(KEY);
      expect(delivery.change.patch.ops[0].patch.focus).toEqual(['site']);
      // The page speaks the same sentence the host named.
      expect(compoundConfirmation(delivery.change.patch.ops)).toBe(line);
      expect(await t.claim()).toBeUndefined();

      const painted = structuredClone(t.scene) as any;
      painted.inspection.emphasis = { parts: KEY, focus: ['site'], contextOpacity: 0.18 };
      painted.inspection.appearance.opacity = 0.5;
      painted.inspection.placement.scale = 2;
      painted.camera.radiusMax = 24;
      const receipt = await t.render(delivery, painted);
      expect(receipt.structuredContent.command).toMatchObject({ commandId: 'compound-one', status: 'rendered' });
      await t.rebind();
      const after = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent;
      expect(after.view.appearance.opacity).toBe(0.5);
      expect(after.view.placement.scale).toBe(2);
      expect(after.view.emphasis.focus).toEqual(['site']);

      // One history entry: one undo takes all three fields back, and then
      // there is nothing left to take back.
      const undo = await t.call('undo_last_change', { ...t.binding(), panelId: t.panelId, commandId: 'undo-one' });
      expect(undo.structuredContent.undone).toBe(true);
      expect(undo.structuredContent.undid).toMatchObject({ origin: 'command', surface: 'companion', change: 'compound' });
      expect(undo.structuredContent.restores.sort()).toEqual(['appearance', 'emphasis', 'placement']);
      expect(JSON.stringify(undo.content)).toContain(UNDO_CONFIRMATION);
      expect(undo.content[0].text).toContain(`If the change renders on a connected headset, its confirmation is ${UNDO_CONFIRMATION}`);
      expect(undo.content[0].text).not.toContain('The wearer hears');

      const undoDelivery = await t.claim();
      expect(undoDelivery.change.kind).toBe('compound');
      const restored = Object.fromEntries(undoDelivery.change.patch.ops.map((op: any) => [op.kind, op.patch]));
      expect(restored.appearance.opacity).toBe(1);
      expect(restored.placement.scale).toBe(1);
      expect(restored.emphasis.focus).toEqual([]);
      expect(restored.emphasis.parts).toEqual([]);

      const back = structuredClone(t.scene) as any;
      back.inspection.emphasis = { parts: [], focus: [], contextOpacity: 0.18 };
      back.camera.radiusMax = 24;
      expect((await t.render(undoDelivery, back)).structuredContent.command).toMatchObject({ status: 'rendered' });
      await t.rebind();

      const empty = await t.call('undo_last_change', { ...t.binding(), panelId: t.panelId, commandId: 'undo-two' });
      expect(empty.structuredContent.undone).toBe(false);
      expect(JSON.stringify(empty.content)).toMatch(/no operation left to take back/);
    } finally { await t.close(); }
  });

  it('refuses a compound that says the same kind twice or carries only one edit', async () => {
    const t = await setup();
    try {
      const twice = await t.call('update_inspection', { ...t.binding(), panelId: t.panelId, commandId: 'compound-twice',
        change: { kind: 'compound', patch: { ops: [
          { kind: 'appearance', patch: { opacity: 0.5 } },
          { kind: 'appearance', patch: { opacity: 0.2 } },
        ] } } });
      expect(twice.isError).toBe(true);
      const alone = await t.call('update_inspection', { ...t.binding(), panelId: t.panelId, commandId: 'compound-alone',
        change: { kind: 'compound', patch: { ops: [{ kind: 'placement', patch: { scale: 2 } }] } } });
      expect(alone.isError).toBe(true);
    } finally { await t.close(); }
  });
});

describe('taking a change back across surfaces', () => {
  it('undoes an agent edit when the wearer says it in the headset', async () => {
    const spoken: string[] = [];
    const t = await setup({
      voice: {
        transcribe: async () => 'undo that',
        acknowledge: async (message: string) => { spoken.push(message); return { wavBase64: Buffer.from(`RIFF${message}`).toString('base64') }; },
      },
    });
    try {
      // The agent, on the Mac, repaints the wearer's molecule.
      const queued = await t.call('emphasize', { ...t.binding(), panelId: t.panelId, commandId: 'agent-emph', parts: ['active site'] });
      expect(queued.isError).not.toBe(true);
      const delivery = await t.claim();
      const painted = structuredClone(t.scene) as any;
      painted.inspection.emphasis = { parts: KEY, focus: ['site'], contextOpacity: 0.18 };
      painted.camera.radiusMax = 24;
      expect((await t.render(delivery, painted)).structuredContent.command).toMatchObject({ status: 'rendered' });
      await t.rebind();
      expect((await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent.view.emphasis.focus).toEqual(['site']);

      // The wearer, in the headset, says two words. Nothing about that phrase
      // knows the change came from an agent tool; the history is the scene's.
      const heard = await t.call('voice_command', { ...t.binding(), panelId: t.panelId,
        audio: { pcm16leBase64: Buffer.alloc(8_640).toString('base64'), sampleRate: 24_000, durationMs: 180 } });
      expect(heard.isError).not.toBe(true);
      expect(heard.structuredContent).toMatchObject({ command: 'undo', handled: true, message: UNDO_CONFIRMATION });

      // The restoring command is queued for the wearer's own panel.
      const undoDelivery = await t.claim();
      expect(undoDelivery.change.kind).toBe('emphasis');
      expect(undoDelivery.change.patch.focus).toEqual([]);
      const back = structuredClone(t.scene) as any;
      back.inspection.emphasis = { parts: [], focus: [], contextOpacity: 0.18 };
      back.camera.radiusMax = 24;
      expect((await t.render(undoDelivery, back)).structuredContent.command).toMatchObject({ status: 'rendered' });
      await t.rebind();
      const after = (await t.call('get_inspection_state', { sessionId: t.sessionId })).structuredContent;
      expect(after.view.emphasis.focus).toEqual([]);

      // And the same phrase again finds nothing, because the entry it took
      // back is gone rather than toggling on and off.
      t.clock.now += 2_000;
      const again = await t.call('voice_command', { ...t.binding(), panelId: t.panelId,
        audio: { pcm16leBase64: Buffer.alloc(8_640).toString('base64'), sampleRate: 24_000, durationMs: 180 } });
      expect(again.structuredContent.message).toBe('Nothing to undo.');
    } finally { await t.close(); }
  });

  it('takes back an edit the person made by hand in a panel', async () => {
    const t = await setup();
    try {
      // A manual save is an operation too: the wearer dragged the molecule.
      const moved = structuredClone(t.scene) as any;
      moved.inspection.placement.scale = 3;
      expect((await t.call('sync_inspection', { ...t.binding(), scene: moved })).structuredContent.saved).toBe(true);
      await t.rebind();

      const undo = await t.call('undo_last_change', { ...t.binding(), panelId: t.panelId, commandId: 'undo-manual' });
      expect(undo.structuredContent.undone).toBe(true);
      expect(undo.structuredContent.undid).toMatchObject({ origin: 'manual' });
      const delivery = await t.claim();
      expect(delivery.change.kind).toBe('placement');
      expect(delivery.change.patch.scale).toBe(1);
    } finally { await t.close(); }
  });

  it('leaves the history alone when an undo never renders', async () => {
    const t = await setup();
    try {
      const moved = structuredClone(t.scene) as any;
      moved.inspection.placement.scale = 3;
      await t.call('sync_inspection', { ...t.binding(), scene: moved });
      await t.rebind();

      const undo = await t.call('undo_last_change', { ...t.binding(), panelId: t.panelId, commandId: 'undo-lost' });
      expect(undo.structuredContent.undone).toBe(true);
      const delivery = await t.claim();
      const refused = await t.call('complete_inspection', { ...t.binding(), panelId: t.panelId,
        commandId: delivery.commandId, claimToken: delivery.claimToken, failure: 'render_failed' });
      expect(refused.structuredContent.command).toMatchObject({ status: 'rejected' });

      // The change is still there to take back, so the wearer can ask again.
      const retry = await t.call('undo_last_change', { ...t.binding(), panelId: t.panelId, commandId: 'undo-retry' });
      expect(retry.structuredContent.undone).toBe(true);
      expect((await t.claim()).change.patch.scale).toBe(1);
    } finally { await t.close(); }
  });
});
