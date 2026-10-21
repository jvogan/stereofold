/**
 * `update_inspection` with `placement {recenter:true}` is the
 * headset's own Reset, sent over the Wi-Fi share and confirmed like any edit.
 *
 * On 2026-09-28 an agent answering "I can't see it" had no such command and
 * reached the page's Reset only through Quest Browser's debugger over USB.
 * These tests hold the host half: the command reaches the headset panel as the
 * page's `recenter` change, the placement the page saves is accepted as the
 * answer while every other field must hold, and the two places it cannot work
 * (the Mac panel and a headset page on its flat view) are refused before
 * anything is queued, with the step that would make it work.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { expectedInspection, inspectionChangeSchema, matchesInspectionChange, updateInspectionSchema,
  PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';
import { TOURS } from '../src/tour-catalog.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const RECENTER = { kind: 'placement', patch: { recenter: true } } as const;
const startup = (presenting: boolean, frameCount = 0) => ({ phase: presenting ? 'active' : 'idle', pending: false, reloadRequired: false,
  mode: presenting ? 'immersive-ar' : null, gestureActive: null, presenting, visible: true,
  sessionVisibility: presenting ? 'visible' : null, frameCount });

async function setup(viewerPath?: string, pageBuild?: string,
  beforeAttach?:(call:(name:string,args:Record<string,unknown>)=>Promise<any>,bound:Record<string,unknown>)=>Promise<string|void>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  let clock = 0;
  const server = createStereoStructureServer(viewerPath, { environment: {}, now: () => clock });
  const client = new Client({ name: 'Headset recenter test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
    selectionKeys: [data.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
  const bound = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const actualPageBuild=await beforeAttach?.(call,bound) ?? pageBuild;
  const attached = (await call('attach_inspection', { ...bound, surface: 'companion', ...(actualPageBuild ? { pageBuild:actualPageBuild } : {}) })).structuredContent;
  const companion = attached.panelId as string;
  const desktop = (await call('attach_inspection', bound)).structuredContent.panelId as string;
  let frames = 0;
  const beat = async (panelId: string, presenting?: boolean, availability: 'ready' | 'busy' = 'ready') =>
    (await call('poll_inspection', { ...bound, panelId, availability,
      ...(panelId === companion && actualPageBuild ? { pageBuild:actualPageBuild } : {}),
      ...(presenting === undefined ? {} : { xrStartup: startup(presenting, presenting ? ++frames : 0) }) }))._meta[KEY];
  const close = async () => { await client.close(); await server.close(); };
  return { call, bound, scene, companion, desktop, attached, beat, advance: (ms: number) => { clock += ms; }, close };
}

async function stampedInspector() {
  const directory=await mkdtemp(join(tmpdir(),'stereofold-stale-page-'));
  const build=await writeStampedInspector(directory);
  return {directory,viewerPath:join(directory,'viewer.html'),build};
}

async function writeStampedInspector(directory:string, version='first') {
  const html=`<!doctype html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';const version='${version}';</script>`;
  const build=createHash('sha256').update(html).digest('hex');
  await writeFile(join(directory,'inspector.html'),html.replace(VIEWER_BUILD_PLACEHOLDER,build));
  return build;
}

describe('companion page build', () => {
  it('delivers a queued command with the outdated build reply and accepts its receipt', async () => {
    const fixture=await stampedInspector();
    try {
      const t=await setup(fixture.viewerPath,'b'.repeat(64));
      try {
        await t.beat(t.companion,true);
        await t.beat(t.companion,true);
        const commandId='outdated-page-appearance';
        const queued=await t.call('update_inspection',{...t.bound,panelId:t.companion,commandId,
          change:{kind:'appearance',patch:{opacity:0.5}}});
        expect(queued.structuredContent.command.status).toBe('queued');
        const polled=await t.call('poll_inspection',{...t.bound,panelId:t.companion,availability:'ready',
          pageBuild:'b'.repeat(64),xrStartup:startup(true,3)});
        expect(polled.structuredContent.outdatedHostBuild).toBe(fixture.build);
        const delivery=polled._meta[KEY].delivery;
        expect(delivery.commandId).toBe(commandId);
        const claim={...t.bound,panelId:t.companion,commandId,claimToken:delivery.claimToken};
        expect((await t.call('complete_inspection',{...claim,phase:'admit'})).structuredContent.admitted).toBe(true);
        const scene=structuredClone(t.scene);
        scene.inspection.appearance.opacity=0.5;
        expect((await t.call('complete_inspection',{...claim,scene})).structuredContent.command.status).toBe('rendered');
      } finally { await t.close(); }
    } finally { await rm(fixture.directory,{recursive:true,force:true}); }
  });

  it('compares with the HTML cached when the share opens after a build replacement', async () => {
    const fixture=await stampedInspector();
    const open=vi.spyOn(InspectionCompanionHttp.prototype,'open').mockImplementation(async function(this:InspectionCompanionHttp) {
      await this.prepareHtml();
      return {url:'http://127.0.0.1:1/#test',port:1};
    });
    try {
      let replacement='';
      const t=await setup(fixture.viewerPath,undefined,async(call,bound)=>{
        await call('get_inspection_state',{sessionId:bound.sessionId});
        replacement=await writeStampedInspector(fixture.directory,'replacement');
        expect((await call('open_companion',{...bound,connection:'loopback'})).isError).not.toBe(true);
        return replacement;
      });
      try {
        expect(t.attached.outdatedHostBuild).toBeUndefined();
        expect((await t.call('get_inspection_state',{sessionId:t.bound.sessionId})).structuredContent.wearer.pageOutdated).toBeUndefined();
        expect((await t.call('poll_inspection',{...t.bound,panelId:t.companion,availability:'ready',pageBuild:fixture.build})).structuredContent.outdatedHostBuild).toBe(replacement);
      } finally { await t.close(); }
    } finally { open.mockRestore(); await rm(fixture.directory,{recursive:true,force:true}); }
  });

  it('reports missing and different builds, and refuses recenter before queueing', async () => {
    const fixture=await stampedInspector();
    try {
      for(const pageBuild of [undefined,'b'.repeat(64)]) {
        const t=await setup(fixture.viewerPath,pageBuild);
        try {
          expect(t.attached.outdatedHostBuild).toBe(fixture.build);
          expect((await t.call('get_inspection_state',{sessionId:t.bound.sessionId})).structuredContent.wearer)
            .toMatchObject({pageOutdated:true,note:expect.stringContaining('reload the Stereofold page')});
          const beat=await t.beat(t.companion,true);
          expect((await t.call('poll_inspection',{...t.bound,panelId:t.companion,availability:'ready',
            ...(pageBuild?{pageBuild}:{})})).structuredContent.outdatedHostBuild).toBe(fixture.build);
          expect(beat.delivery).toBeUndefined();
          const refused=await t.call('update_inspection',{...t.bound,panelId:t.companion,
            commandId:`recenter-outdated-${pageBuild?'different':'missing'}`,change:RECENTER});
          expect(refused.isError).toBe(true);
          expect(refused.content[0].text).toContain('reload the Stereofold page');
          // A page that sent no build predates the self-reload; only the wearer can update it.
          expect(refused.content[0].text).toContain(pageBuild ? 'reloads itself after the wearer leaves VR' : 'cannot update itself');
          expect((await t.call('get_inspection_state',{sessionId:t.bound.sessionId})).structuredContent.pendingCommand).toEqual([]);
        } finally { await t.close(); }
      }
    } finally { await rm(fixture.directory,{recursive:true,force:true}); }
  });

  it('accepts a matching page build and treats an unstamped host as current', async () => {
    const fixture=await stampedInspector();
    try {
      const matching=await setup(fixture.viewerPath,fixture.build);
      try {
        expect(matching.attached.outdatedHostBuild).toBeUndefined();
        expect((await matching.call('get_inspection_state',{sessionId:matching.bound.sessionId})).structuredContent.wearer.pageOutdated).toBeUndefined();
        expect((await matching.call('poll_inspection',{...matching.bound,panelId:matching.companion,availability:'ready',pageBuild:fixture.build})).structuredContent.outdatedHostBuild).toBeUndefined();
      } finally { await matching.close(); }
      const unstamped=await setup(undefined,'b'.repeat(64));
      try {
        expect(unstamped.attached.outdatedHostBuild).toBeUndefined();
        expect((await unstamped.call('get_inspection_state',{sessionId:unstamped.bound.sessionId})).structuredContent.wearer.pageOutdated).toBeUndefined();
      } finally { await unstamped.close(); }
    } finally { await rm(fixture.directory,{recursive:true,force:true}); }
  });
});

describe('placement {recenter:true}', () => {
  it('confirms a rendered native Reset that stops the current lesson cursor', async () => {
    const t=await setup();
    try {
      const playing:any=structuredClone(t.scene);
      playing.inspection.lessonPlayback={tourId:TOURS[0].id,chapterId:TOURS[0].steps[0].id,stopped:false,
        narration:false,motionProgress:.2,motionPlaying:true,startingScene:structuredClone(t.scene)};
      const response=await t.call('sync_inspection',{...t.bound,scene:playing});
      expect(response.isError,response.content?.[0]?.text).not.toBe(true);
      const saved=response.structuredContent;
      expect(saved.saved).toBe(true);
      Object.assign(t.bound,{baseStateRevision:saved.stateRevision,baseInspectionRevision:saved.inspectionRevision});
      await t.beat(t.companion,true);await t.beat(t.companion,true);
      await t.call('update_inspection',{...t.bound,panelId:t.companion,commandId:'reset-stops-lesson',change:RECENTER});
      const delivery=(await t.beat(t.companion,true)).delivery;
      const claim={...t.bound,panelId:t.companion,commandId:'reset-stops-lesson',claimToken:delivery.claimToken};
      expect((await t.call('complete_inspection',{...claim,phase:'admit'})).structuredContent.admitted).toBe(true);
      const scene=structuredClone(playing);
      scene.inspection.placement={translation:[-.073,.054,-2.882],rotation:[0,0,0],scale:2.1};
      Object.assign(scene.inspection.lessonPlayback,{stopped:true,motionProgress:.3,motionPlaying:false});
      const result=await t.call('complete_inspection',{...claim,scene,recenterCompletion:{
        structureReset:true,menuReseated:true,placement:scene.inspection.placement}});
      expect(result.structuredContent.command.status).toBe('rendered');
    } finally {await t.close();}
  });
  it('reaches the headset panel as its Reset and renders on the placement the page solved', async () => {
    const t = await setup();
    try {
      await t.beat(t.companion, true);
      await t.beat(t.companion, true);
      const queued = await t.call('update_inspection', { ...t.bound, panelId: t.companion, commandId: 'recenter-1', change: RECENTER });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.command.status).toBe('queued');

      const delivery = (await t.beat(t.companion, true)).delivery;
      expect(delivery).toMatchObject({ commandId: 'recenter-1', change: RECENTER });
      const claim = { ...t.bound, panelId: t.companion, commandId: 'recenter-1', claimToken: delivery.claimToken };
      expect((await t.call('complete_inspection', { ...claim, phase: 'admit' })).structuredContent.admitted).toBe(true);

      // The page's seat: its own numbers, and a camera bound that follows the new size.
      const scene = structuredClone(t.scene);
      scene.inspection.placement = { translation: [0.4, -0.2, -1.6], rotation: [0, 35, 0], scale: 0.62 };
      scene.camera.radiusMax = 31;
      const recenterCompletion = { structureReset: true, menuReseated: true, placement: scene.inspection.placement };
      const done = await t.call('complete_inspection', { ...claim, scene, recenterCompletion });
      expect(done.structuredContent.command.status).toBe('rendered');
      const state = await t.call('get_inspection_state', { sessionId: t.bound.sessionId, commandId: 'recenter-1' });
      expect(JSON.stringify(state.structuredContent)).toContain('"status":"rendered"');
    } finally { await t.close(); }
  });

  it('does not render an unchanged or unsupported Reset receipt, and reports a menu failure', async () => {
    for (const completion of [undefined, { structureReset: true, menuReseated: true,
      placement: { translation: [1, 0, 0], rotation: [0, 0, 0], scale: 1 } }]) {
      const t = await setup();
      try {
        await t.beat(t.companion, true);
        await t.beat(t.companion, true);
        await t.call('update_inspection', { ...t.bound, panelId: t.companion, commandId: 'reset-missing', change: RECENTER });
        const delivery = (await t.beat(t.companion, true)).delivery;
        const claim = { ...t.bound, panelId: t.companion, commandId: 'reset-missing', claimToken: delivery.claimToken };
        await t.call('complete_inspection', { ...claim, phase: 'admit' });
        const done = await t.call('complete_inspection', { ...claim, scene: t.scene,
          ...(completion ? { recenterCompletion: completion } : {}) });
        expect(done.structuredContent.command.status).toBe('unconfirmed');
      } finally { await t.close(); }
    }
    const t = await setup();
    try {
      await t.beat(t.companion, true);
      await t.beat(t.companion, true);
      await t.call('update_inspection', { ...t.bound, panelId: t.companion, commandId: 'reset-partial', change: RECENTER });
      const delivery = (await t.beat(t.companion, true)).delivery;
      const claim = { ...t.bound, panelId: t.companion, commandId: 'reset-partial', claimToken: delivery.claimToken };
      await t.call('complete_inspection', { ...claim, phase: 'admit' });
      const done = await t.call('complete_inspection', { ...claim, scene: t.scene,
        recenterCompletion: { structureReset: true, menuReseated: false, placement: t.scene.inspection.placement } });
      expect(done.structuredContent.command).toMatchObject({ status: 'rendered', detail: 'The structure reset, but the menu did not move.' });
    } finally { await t.close(); }
  });

  it('refuses a headset page on its flat view and names how to enter VR', async () => {
    const t = await setup();
    try {
      await t.beat(t.companion, false);
      const refused = await t.call('update_inspection', { ...t.bound, panelId: t.companion, commandId: 'recenter-flat', change: RECENTER });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/not in VR/u);
      expect(refused.content[0].text).toContain('manage_companion action="enter-vr"');
      // Nothing was queued for the page to find.
      expect((await t.beat(t.companion, false)).delivery).toBeUndefined();
    } finally { await t.close(); }
  });

  it('refuses recenter after a busy presenting page freezes', async () => {
    const t = await setup();
    try {
      await t.beat(t.companion, true, 'busy');
      await t.beat(t.companion, true, 'busy');
      expect((await t.call('get_inspection_state', { sessionId: t.bound.sessionId })).structuredContent.wearer.state).toBe('in-vr');
      t.advance(30_000);
      expect((await t.call('get_inspection_state', { sessionId: t.bound.sessionId })).structuredContent.wearer)
        .toMatchObject({ state: 'paused', pausedBecause: 'silent' });
      const refused = await t.call('update_inspection', { ...t.bound, panelId: t.companion, commandId: 'recenter-frozen', change: RECENTER });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('wearer.state "in-vr"');
      const state = (await t.call('get_inspection_state', { sessionId: t.bound.sessionId, commandId: 'recenter-frozen' })).structuredContent;
      expect(state.command).toMatchObject({ status: 'unknown' });
      expect(state.pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it('waits for visible frame evidence before recentering', async () => {
    const t = await setup();
    try {
      await t.beat(t.companion, true);
      const noFrames = await t.call('update_inspection', { ...t.bound, panelId: t.companion,
        commandId: 'recenter-no-frames', change: RECENTER });
      expect(noFrames.isError).toBe(true);
      await t.beat(t.companion, true);
      await t.call('poll_inspection', { ...t.bound, panelId: t.companion, availability: 'busy',
        xrStartup: { ...startup(true, 2), sessionVisibility: 'hidden' } });
      const hidden = await t.call('update_inspection', { ...t.bound, panelId: t.companion,
        commandId: 'recenter-hidden', change: RECENTER });
      expect(hidden.isError).toBe(true);
      expect(hidden.content[0].text).toContain('wearer.state "in-vr"');
      const state = (await t.call('get_inspection_state', { sessionId: t.bound.sessionId })).structuredContent;
      expect(state.pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it('refuses the Mac panel, which has no wearer', async () => {
    const t = await setup();
    try {
      await t.beat(t.desktop);
      const refused = await t.call('update_inspection', { ...t.bound, panelId: t.desktop, commandId: 'recenter-mac', change: RECENTER });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/Mac panel, which has no wearer/u);
      expect((await t.beat(t.desktop)).delivery).toBeUndefined();
    } finally { await t.close(); }
  });
});

describe('the recenter contract', () => {
  const scene = {
    sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
  } as any;
  const change = inspectionChangeSchema.parse(RECENTER);

  it('expects no numbers and takes the saved placement as the answer, holding every other field', () => {
    const expected = expectedInspection(scene, change);
    expect(expected.inspection.placement).toEqual(scene.inspection.placement);
    const seated = structuredClone(scene);
    seated.inspection.placement = { translation: [1, 0, -2], rotation: [0, 90, 0], scale: 0.5 };
    expect(matchesInspectionChange(seated, expected, change)).toBe(true);
    const recoloured = structuredClone(seated);
    recoloured.inspection.appearance.color = 'uniform';
    expect(matchesInspectionChange(recoloured, expected, change)).toBe(false);
  });

  it('is a whole placement of its own: no numbers beside it, and not inside a compound', () => {
    const request = updateInspectionSchema.shape.change;
    expect(request.safeParse(RECENTER).success).toBe(true);
    expect(request.safeParse({ kind: 'placement', patch: { recenter: true, scale: 2 } }).success).toBe(false);
    expect(request.safeParse({ kind: 'compound', patch: { ops: [RECENTER, { kind: 'appearance', patch: { opacity: 0.5 } }] } }).success).toBe(false);
    expect(request.safeParse({ kind: 'placement', patch: { scale: 2 } }).success).toBe(true);
  });

  it('accepts only Reset-owned cursor changes while preserving source, chapter and baseline', () => {
    const playing=structuredClone(scene);
    playing.inspection.lessonPlayback={tourId:'lesson-gallery',chapterId:'binder-01',stopped:false,
      narration:false,motionProgress:.2,motionPlaying:true,startingScene:structuredClone(scene)};
    const expected=expectedInspection(playing,change), reset=structuredClone(playing);
    Object.assign(reset.inspection.lessonPlayback,{stopped:true,motionProgress:.3,motionPlaying:false});
    reset.inspection.placement={translation:[-.073,.054,-2.882],rotation:[0,0,0],scale:2.1};
    expect(matchesInspectionChange(reset,expected,change)).toBe(true);
    for(const alter of [
      (s:any)=>s.inspection.lessonPlayback.chapterId='binder-02',
      (s:any)=>s.inspection.lessonPlayback.startingScene.inspection.placement.scale=2,
      (s:any)=>s.inspection.lessonPlayback.stopped=false,
      (s:any)=>s.inspection.lessonPlayback.motionPlaying=true,
      (s:any)=>s.sourceSha256='b'.repeat(64),
      (s:any)=>s.inspection.appearance.opacity=.4,
    ]) {
      const wrong=structuredClone(reset);alter(wrong);
      expect(matchesInspectionChange(wrong,expected,change)).toBe(false);
    }
  });

  it('accepts Reset removing a cutaway without admitting unrelated appearance edits', () => {
    const clipped=structuredClone(scene);clipped.inspection.appearance.clipping=1;
    const reset=structuredClone(clipped);reset.inspection.appearance.clipping=0;reset.camera.radius=25;
    expect(matchesInspectionChange(reset,expectedInspection(clipped,change),change)).toBe(true);
    reset.inspection.appearance.color='uniform';
    expect(matchesInspectionChange(reset,expectedInspection(clipped,change),change)).toBe(false);
  });

  it('accepts Reset pausing a molecular clock but holds its definition and controls', () => {
    const playing=structuredClone(scene);
    playing.inspection.animation={definition:{version:1,durationSeconds:5,tracks:[]},
      playback:{id:'clip',chapterId:'binder-01',state:'playing',timeSeconds:1,durationSeconds:5,loop:true,speed:1}};
    const expected=expectedInspection(playing,change), reset=structuredClone(playing);
    Object.assign(reset.inspection.animation.playback,{state:'paused',timeSeconds:2});
    expect(matchesInspectionChange(reset,expected,change)).toBe(true);
    for(const alter of [
      (s:any)=>s.inspection.animation.playback.state='playing',
      (s:any)=>s.inspection.animation.playback.speed=2,
      (s:any)=>s.inspection.animation.definition.durationSeconds=10,
    ]) {
      const wrong=structuredClone(reset);alter(wrong);
      expect(matchesInspectionChange(wrong,expected,change)).toBe(false);
    }
  });
});
