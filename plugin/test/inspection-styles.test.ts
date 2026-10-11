import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, COMPOUND_MAX_OPS, expectedInspection,
  inspectionChangeSchema, matchesInspectionChange, sceneSchema, updateInspectionSchema,
  validateScene } from '../src/inspection-contract.js';
import { movedFields, undoChangeFor } from '../src/inspection-operation.js';
// @ts-ignore The page's own hidden-set builder, so the shape the panel saves and
// the schema that has to accept it are checked against each other.
import { normalizeVisibility } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

import { sceneStylesSchema, applyScopedStyle } from '../src/inspection-contract.js';
import { scopedStyleConfirmation } from '../src/inspection-operation-words.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-styles-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold styles test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif');
  await writeFile(filePath, cif);
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const catalog = privateData.catalog;
  const rows = catalog.rows as any[];
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
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
  // Every rendered command moves the inspection revision, and a command bound to
  // a stale one is refused. These tests run several changes in a row, so the
  // binding is re-read rather than captured once.
  const live = { ...binding };
  const advance = (value: any) => {
    if (typeof value?.stateRevision === 'number') live.baseStateRevision = value.stateRevision;
    if (typeof value?.inspectionRevision === 'number') live.baseInspectionRevision = value.inspectionRevision;
    return value;
  };
  const claim = async () => (await call('poll_inspection', { ...live, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  const state = async () => advance((await call('get_inspection_state', { sessionId })).structuredContent);
  /**
   * Answer a queued command with the scene the panel would have rendered, then
   * heartbeat. A panel that has not said `ready` since its last render is busy
   * as far as the host is concerned, and the next command is refused.
   */
  const render = async (delivery: any, rendered: any) => {
    const receipt = advance((await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: rendered })).structuredContent);
    await call('poll_inspection', { ...live, panelId, availability: 'ready' });
    return receipt;
  };
  return { call, catalog, rows, scene, panelId, claim, render, state, sessionId,
    get binding() { return { ...live }; },
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

/** What get_inspection_state reports for saved styles: each layer counted, never its keys. */
const reported=(styles:readonly any[]=[])=>styles.map(({selectionKeys,...style})=>({...style,residueCount:selectionKeys.length,
  labelChains:expect.any(Array),componentIds:expect.any(Array)}));
const scoped = (patch:unknown) => ({kind:'appearance',scope:'selection',patch});
const queue = (t:any,id:string,change:any,extra={}) => t.call('update_inspection', {...t.binding,panelId:t.panelId,commandId:id,change,...extra});
const undo = (t:any,id:string) => t.call('undo_last_change', {...t.binding,panelId:t.panelId,commandId:id});

describe('saved scoped appearance contract',()=>{
  it('admits old scenes and styles, omits an explicit empty array, and binds every key to the source',async()=>{
    const t=await setup();
    try {
      expect(validateScene(t.scene,t.catalog).inspection.styles).toBeUndefined();
      const withStyles:any=structuredClone(t.scene);
      withStyles.inspection.styles=[];
      expect(validateScene(withStyles,t.catalog).inspection).not.toHaveProperty('styles');
      withStyles.inspection.styles=[{selectionKeys:[t.rows[0].key],representation:'ball-and-stick',opacity:0.5}];
      expect(validateScene(withStyles,t.catalog).inspection.styles).toEqual(withStyles.inspection.styles);
      withStyles.inspection.styles[0].selectionKeys=['foreign'];
      expect(()=>validateScene(withStyles,t.catalog)).toThrow(/canonical identities from this model/);
    } finally {await t.close();}
  });
  it('keeps the eight-entry, 20000-key, unique-key and appearance bounds',()=>{
    const entries=Array.from({length:8},(_,i)=>({selectionKeys:['k'+i],opacity:i/8}));
    expect(sceneStylesSchema.safeParse(entries).success).toBe(true);
    expect(sceneStylesSchema.safeParse([...entries,{selectionKeys:['x'],opacity:1}]).success).toBe(false);
    const keys=Array.from({length:20000},(_,i)=>'k'+i);
    expect(sceneStylesSchema.safeParse([{selectionKeys:keys,color:'uniform'}]).success).toBe(true);
    expect(sceneStylesSchema.safeParse([{selectionKeys:[...keys,'overflow'],color:'uniform'}]).success).toBe(false);
    for(const bad of [[{selectionKeys:['a','a'],opacity:1}], [{selectionKeys:[],opacity:1}],
      [{selectionKeys:['a']}], [{selectionKeys:['a'],representation:'isosurface'}],
      [{selectionKeys:['a'],opacity:1.1}], [{selectionKeys:['a'],color:'orange'}]])
      expect(sceneStylesSchema.safeParse(bad).success).toBe(false);
  });
  it('merges partial overlapping edits and clears only the addressed keys',()=>{
    const old=[{selectionKeys:['a','b'],representation:'ball-and-stick',opacity:0.5}];
    const changed=applyScopedStyle(old,['b','c'],{color:'uniform',uniformColor:'#ff8800'});
    expect(changed).toEqual([
      {selectionKeys:['a'],representation:'ball-and-stick',opacity:0.5},
      {selectionKeys:['b'],representation:'ball-and-stick',color:'uniform',uniformColor:'#ff8800',opacity:0.5},
      {selectionKeys:['c'],color:'uniform',uniformColor:'#ff8800'},
    ]);
    expect(applyScopedStyle(changed,['b'],{clear:true})).toEqual([changed[0],changed[2]]);
    expect(applyScopedStyle(changed,['a','b','c'],{clear:true})).toEqual([]);
    expect(old[0].selectionKeys).toEqual(['a','b']);
    const overlapping=[{selectionKeys:['a'],opacity:0.2},{selectionKeys:['a'],representation:'spacefill'}];
    expect(sceneStylesSchema.safeParse(overlapping).success).toBe(true);
    expect(applyScopedStyle(overlapping,['a'],{color:'uniform'})).toEqual([{selectionKeys:['a'],representation:'spacefill',color:'uniform',opacity:0.2}]);
    expect(applyScopedStyle(overlapping,['a'],{clear:true})).toEqual([]);
    expect(()=>applyScopedStyle([],[],{opacity:1})).toThrow(/Select residues/);
  });
  it('admits selection appearance and clear in compounds, with scene appearance as a separate field',()=>{
    const schema=updateInspectionSchema.shape.change;
    expect(schema.safeParse(scoped({representation:'ball-and-stick'})).success).toBe(true);
    expect(schema.safeParse(scoped({clear:true})).success).toBe(true);
    for(const patch of [{background:'#ffffff'},{labels:true},{clear:true,opacity:0.2},{}])
      expect(schema.safeParse(scoped(patch)).success).toBe(false);
    expect(schema.safeParse({kind:'appearance',patch:{clear:true}}).success).toBe(false);
    expect(schema.safeParse({kind:'compound',patch:{ops:[scoped({opacity:0.5}),{kind:'appearance',patch:{background:'#ffffff'}}]}}).success).toBe(true);
    expect(schema.safeParse({kind:'compound',patch:{ops:[scoped({opacity:0.5}),scoped({opacity:0.8})]}}).success).toBe(false);
    expect(COMPOUND_MAX_OPS).toBe(7);
  });
});

describe('selection style commands and rendered receipts',()=>{
  it('queues the selected keys, leaves the scene unchanged until rendering, and rejects a false receipt',async()=>{
    const t=await setup();
    try {
      const result=await queue(t,'sticks',scoped({representation:'ball-and-stick'}));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.command.status).toBe('queued');
      expect(result.structuredContent.style.confirmation).toBe('Sticks on 1 residue.');
      expect((await t.state()).view.styles).toBeUndefined();
      const delivery=await t.claim(), expected=expectedInspection(t.scene as any,delivery.change);
      expect(delivery.change.kind).toBe('styles');
      expect(expected.inspection.styles).toEqual([{selectionKeys:t.scene.selectionKeys,representation:'ball-and-stick'}]);
      expect(expected.inspection.appearance).toEqual(t.scene.inspection.appearance);
      expect(expected.selectionKeys).toEqual(t.scene.selectionKeys);
      const rendered=structuredClone(expected); rendered.camera.radiusMax=26;
      expect(matchesInspectionChange(rendered,expected,delivery.change)).toBe(true);
      const moved=structuredClone(rendered); moved.inspection.placement.scale=2;
      expect(matchesInspectionChange(moved,expected,delivery.change)).toBe(false);
      expect((await t.render(delivery,t.scene)).command.status).toBe('unconfirmed');
      expect((await t.state()).view.styles).toBeUndefined();
      await queue(t,'sticks-again',scoped({representation:'ball-and-stick'}));
      const retry=await t.claim();
      expect((await t.render(retry,rendered)).command.status).toBe('rendered');
      expect((await t.state()).view.styles).toEqual(reported(expected.inspection.styles));
    } finally {await t.close();}
  });
  it('restores the earlier styles whole through undo, including absent styles',async()=>{
    const t=await setup();
    try {
      await queue(t,'first',scoped({representation:'ball-and-stick'}));
      const first=await t.claim(), before=expectedInspection(t.scene as any,first.change);
      await t.render(first,before);
      await queue(t,'second',scoped({color:'uniform',uniformColor:'#ff8800'}));
      const second=await t.claim(), after=expectedInspection(before,second.change);
      await t.render(second,after);
      expect(movedFields(before,after)).toEqual(['styles']);
      expect((await undo(t,'undo-colour')).structuredContent.restores).toEqual(['styles']);
      const back=await t.claim();
      expect(back.change.patch.styles).toEqual(before.inspection.styles);
      expect((await t.state()).view.styles).toEqual(reported(after.inspection.styles));
      await t.render(back,before);
      await undo(t,'undo-sticks');
      const empty=await t.claim();
      expect(empty.change.patch.styles).toEqual([]);
      await t.render(empty,t.scene);
      expect((await t.state()).view.styles).toBeUndefined();
    } finally {await t.close();}
  });
  it('honours a captured referent rather than the live selection and preserves explicit scene scope',async()=>{
    const t=await setup();
    try {
      const referent={sourceToken:t.binding.sourceToken,capturedAt:1,modelNumber:t.scene.modelNumber,assemblyId:t.scene.assemblyId,selectionKeys:[t.rows[2].key]};
      const result=await queue(t,'captured',{kind:'appearance',patch:{representation:'ball-and-stick',opacity:0.5}},{referent});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.command.appliedTo).toEqual({capturedAt:1,selectionKeys:referent.selectionKeys});
      const delivery=await t.claim();
      expect(delivery.change.patch.styles[0].selectionKeys).toEqual(referent.selectionKeys);
      const styled=expectedInspection(t.scene as any,delivery.change);
      await t.render(delivery,styled);
      await queue(t,'whole',{kind:'appearance',patch:{opacity:0.3}},{referent,referentScope:'scene'});
      const whole=await t.claim();
      expect(whole.change).toEqual({kind:'appearance',patch:{opacity:0.3}});
      const scene=expectedInspection(styled,whole.change);
      await t.render(whole,scene);
      const bad=await queue(t,'wrong-source',scoped({opacity:0.5}),{referent:{...referent,sourceToken:'00000000-0000-4000-8000-000000000001'}});
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toMatch(/different structure/);
      for(const referentPatch of [{modelNumber:2},{assemblyId:'wrong'},{selectionKeys:['foreign']}]) {
        const invalid=await queue(t,'invalid',scoped({opacity:0.5}),{referent:{...referent,...referentPatch}});
        expect(invalid.isError).toBe(true);
      }
      await queue(t,'pointed',scoped({clear:true}),{referent:{...referent,selectionKeys:[],residueKey:t.rows[2].key}});
      const pointed=await t.claim();
      expect(pointed.change.patch.selectionKeys).toEqual([t.rows[2].key]);
      expect(pointed.change.patch.styles).toEqual([]);
    } finally {await t.close();}
  });
  it('carries styles through named save/restore and refuses a view receipt that loses them',async()=>{
    const t=await setup();
    try {
      await queue(t,'sticks',scoped({representation:'ball-and-stick'}));
      const first=await t.claim(), styled=expectedInspection(t.scene as any,first.change);
      await t.render(first,styled);
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'save',action:'save',name:'Active site sticks'});
      const saved=await t.render(await t.claim(),styled);
      expect(saved.savedView.viewIntent.styledCount).toBe(1);
      await queue(t,'clear',scoped({clear:true}));
      await t.render(await t.claim(),t.scene);
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'restore',action:'restore',viewId:saved.savedView.id});
      const restore=await t.claim();
      expect(restore.change.patch.scene.inspection.styles).toEqual(styled.inspection.styles);
      expect((await t.render(restore,styled)).command.status).toBe('rendered');
      await t.call('manage_inspection_view',{...t.binding,panelId:t.panelId,commandId:'restore-wrong',action:'restore',viewId:saved.savedView.id});
      expect((await t.render(await t.claim(),t.scene)).command.status).toBe('unconfirmed');
    } finally {await t.close();}
  });
  it('resolves a compound in order and undoes style and selection together',async()=>{
    const t=await setup();
    try {
      const keys=[t.rows[2].key,t.rows[3].key];
      const result=await queue(t,'compound',{kind:'compound',patch:{ops:[
        {kind:'selection',patch:{selectionKeys:keys}},scoped({representation:'ball-and-stick'}),
        {kind:'appearance',patch:{background:'#ffffff'}}]}});
      expect(result.isError).not.toBe(true);
      const delivery=await t.claim();
      expect(delivery.change.patch.ops[1].patch.selectionKeys).toEqual(keys);
      const expected=expectedInspection(t.scene as any,delivery.change);
      expect((await t.render(delivery,expected)).command.status).toBe('rendered');
      expect((await undo(t,'undo-compound')).structuredContent.restores).toEqual(['appearance','selection','styles']);
      const back=await t.claim();
      expect(inspectionChangeSchema.safeParse(back.change).success).toBe(true);
      expect((await t.render(back,t.scene)).command.status).toBe('rendered');
      const all=structuredClone(expected);
      all.inspection.placement.scale=2;
      all.inspection.emphasis={parts:[],focus:[],contextOpacity:0.2};
      all.inspection.visibility={hiddenChains:[],hiddenClasses:['water'],showOnlySelection:false};
      const six=undoChangeFor({id:'all',at:0,origin:'manual',surface:'desktop',label:'all',before:t.scene as any,after:all});
      expect(six.kind==='compound' && six.patch.ops.length).toBe(6);
      expect(inspectionChangeSchema.safeParse(six).success).toBe(true);
    } finally {await t.close();}
  });
  it('keeps an exact retry bound after the live selection changes and refuses an altered request',async()=>{
    const t=await setup();
    try {
      const args={...t.binding,panelId:t.panelId,commandId:'retry-style',change:scoped({representation:'ball-and-stick'})};
      const queued=await t.call('update_inspection',args);
      expect((await t.call('update_inspection',args)).structuredContent.command).toEqual(queued.structuredContent.command);
      const first=await t.claim(), styled=expectedInspection(t.scene as any,first.change);
      const rendered=await t.render(first,styled);
      await queue(t,'clear-selection',{kind:'selection',patch:{selectionKeys:[]}});
      await t.render(await t.claim(),{...styled,selectionKeys:[]});
      const retry=await t.call('update_inspection',args);
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent.command).toEqual(rendered.command);
      const different=await t.call('update_inspection',{...args,change:scoped({opacity:0.5})});
      expect(different.isError).toBe(true);
      expect(JSON.stringify(different.content)).toMatch(/different request/);
      expect(await t.claim()).toBeUndefined();
    } finally {await t.close();}
  });
  it('separates scene-only fields from captured appearance in a single request',async()=>{
    const t=await setup();
    try {
      const referent={sourceToken:t.binding.sourceToken,capturedAt:1,selectionKeys:[t.rows[2].key]};
      const result=await queue(t,'mixed',{kind:'appearance',patch:{opacity:0.4,background:'#ffffff'}},{referent});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.command.appliedTo).toEqual({scene:true,selectionKeys:referent.selectionKeys,capturedAt:1});
      const delivery=await t.claim();
      expect(delivery.change.patch.ops).toMatchObject([{kind:'appearance',patch:{background:'#ffffff'}},
        {kind:'styles',patch:{styles:[{selectionKeys:referent.selectionKeys,opacity:0.4}]}}]);
      const expected=expectedInspection(t.scene as any,delivery.change);
      expect(expected.inspection.appearance.opacity).toBe(1);
      expect((await t.render(delivery,expected)).command.status).toBe('rendered');
    } finally {await t.close();}
  });
  it('speaks a short scoped caption',()=>{
    expect(scopedStyleConfirmation({selectionKeys:Array(12).fill('k'),style:{representation:'ball-and-stick'}})).toBe('Sticks on 12 residues.');
    expect(scopedStyleConfirmation({selectionKeys:['k'],style:{clear:true}})).toBe('Style cleared on 1 residue.');
  });
});
