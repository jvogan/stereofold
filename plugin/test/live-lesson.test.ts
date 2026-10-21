import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { parseMolecularLesson } from '../src/molecular-lesson.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Real Mol* state-tree geometry with a synthetic Canvas3D adapter.
import { molecularAnimationHarness } from '../../lab/browser-roundtrip/fixtures/molecular-animation-harness.mjs';
import { mountTourPlayer } from '../src/tour-player.js';
// @ts-ignore Real player with a minimal DOM; GPU painting is adapted below.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const cif = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
function manifest(): any {
  const atom = (chain: string, residue: number) => ({ chain, residues: { from: residue, to: residue }, atomName: 'CA' });
  const chapter = (id: string) => ({ id, title: id, caption: 'An authored test path.', durationSeconds: 10,
    changes: [{ kind: 'hold', durationSeconds: 10 }], immersive: { motion: 'hold',
      figure: { layers: [{ id: 'body', target: { chain: 'A' }, representation: 'cartoon', color: '#ff8800' }],
        labels: [{ id: 'name', target: atom('A', 1), text: 'Original label', color: '#ffffff' }],
        distances: [{ id: 'distance', a: atom('A', 1), b: atom('A', 2), color: '#ffffff' }] } },
    animation: { version: 1, durationSeconds: 4,
      tracks: [{ id: 'body', chains: ['A'], keyframes: [
        { t: 0, rotation: [0, 0, 0, 1], translation: [0, 0, 0] },
        { t: 4, rotation: [0, 0, 0, 1], translation: [2, 0, 0] }] }],
      tethers: [{ id: 'tether', from: { chain: 'A', residue: 1, atom: 'CA' }, to: { chain: 'B', residue: 1, atom: 'CA' }, label: 'Connection' }] } });
  return { version: 1, id: 'live-test', title: 'Live lesson', mode: 'explore',
    provenance: { sourceRefs: [{ kind: 'public', ref: 'https://www.rcsb.org/structure/4HHB' }] },
    chapters: [chapter('first'), chapter('second')] };
}
const textState = (result: any) => Object.assign({}, ...result.content.flatMap((item: any) => {
  if (item.type !== 'text') return [];
  if (item.text.startsWith('{')) return [JSON.parse(item.text)];
  const json = item.text.match(/```json\n([\s\S]*?)\n```/);
  return json ? [JSON.parse(json[1])] : [];
}));
async function setup(lesson?: any, sourceText = cif, molecular?: any, { xr = false, now }: { xr?: boolean; now?: () => number } = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { now, sceneServiceFile: join(tmpdir(), `live-lesson-${randomUUID()}.json`) });
  const client = new Client({ name: 'text-only lesson author', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = (name: string, args: any) => client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const opened = await call(lesson ? 'inspect_lesson' : 'inspect', lesson
    ? { source: { kind: 'pasted', text: sourceText }, lesson } : { structureText: sourceText });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
  const sessionId = lesson ? textState(opened).sessionId : opened.structuredContent.sessionId;
  const hydrated = (await call('get_inspection', { sessionId }))._meta[KEY];
  let catalog = hydrated.catalog ?? await decodeInspectionCatalog(hydrated.catalogWire);
  let scene: any = { sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId,
    selectionKeys: [catalog.rows[0].key], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
      opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [.2, 0, 0], rotation: [0, 30, 0], scale: 1.2 } } };
  const bind: any = { sessionId, serverEpoch: hydrated.serverEpoch, sourceToken: hydrated.sourceToken,
    baseStateRevision: hydrated.stateRevision, baseInspectionRevision: hydrated.inspectionRevision };
  const saved = (await call('sync_inspection', { ...bind, scene })).structuredContent;
  bind.baseInspectionRevision = saved.inspectionRevision;
  let panelId = (await call('attach_inspection', { ...bind, surface: 'desktop' })).structuredContent.panelId;
  const h = tourEndHarness({ xr: false });
  const inspection = h.workspace.viewer.inspection;
  const geometry: any[] = [], framing: any[] = [];
  h.workspace.capture = () => structuredClone(scene);
  h.workspace.snapshot = () => ({ ready: true, sourceSha256: scene.sourceSha256, selectionKeys: scene.selectionKeys, inspection: scene.inspection,
    ...(xr ? { xrPresenting: true } : {}) });
  h.workspace.rows = () => catalog.rows;
  inspection.holdsWearerPlacement = () => true;
  inspection.beginChapterFraming = () => { framing.push('begin'); };
  inspection.place = () => { throw Error('Live installation moved placement'); };
  h.workspace.viewer.select = () => { throw Error('Live installation changed selection'); };
  inspection.configure = async (patch: any) => {
    const { componentLabels: _labels, ...appearance } = patch;
    Object.assign(scene.inspection.appearance, appearance);
  };
  inspection.emphasize = async () => {};
  inspection.setLessonFigure = async (figure: any, options: any) => {
    framing.push({figure:options.frame}); geometry.push(figure); scene.inspection.lessonFigure = structuredClone(figure);
    if (!figure) delete scene.inspection.lessonFigure;
    if (molecular?.figure) {
      await molecular.figure.install(figure);
      molecular.representations.splice(1,Infinity,...molecular.figure.molecular());
      molecular.refreshAnnotations();
    }
  };
  inspection.setMolecularAnimation = async (definition: any, chapterId: string, options: any) => {
    if (molecular) await molecular.registry.install(definition, chapterId);
    if (!definition) { delete scene.inspection.animation; return; }
    if (molecular) { scene.inspection.animation = molecular.registry.capture(); return; }
    framing.push({animation:options.frame});
    if (options.frame) scene.camera.position = [0, 0, 160];
    scene.inspection.animation = { definition: structuredClone(definition), playback: { id: 'clip', chapterId, state: 'playing', timeSeconds: 0,
      durationSeconds: definition.durationSeconds, loop: false, speed: 1 } };
  };
  inspection.controlMolecularAnimation = (patch: any) => {
    if (molecular) { molecular.registry.control(patch); scene.inspection.animation = molecular.registry.capture(); }
    else if (scene.inspection.animation) scene.inspection.animation.playback.state = patch.state === 'pause' ? 'paused' : 'playing';
  };
  inspection.setLessonPlayback = (playback: any) => { if (playback) scene.inspection.lessonPlayback = structuredClone(playback); else delete scene.inspection.lessonPlayback; };
  inspection.restore = async (snapshot: any) => { scene = structuredClone(snapshot); };
  const player = mountTourPlayer({ ...h, tours: lesson ? [molecularLessonToTour(lesson)] : [] });
  const poll = () => call('poll_inspection', { ...bind, panelId, availability: 'ready' });
  async function render(fail = false, targetPanelId = panelId, xrStartup?: any) {
    let delivery: any;
    for (let i = 0; i < 50 && !delivery; i++) {
      delivery = (await call('poll_inspection', { ...bind, panelId: targetPanelId, availability: 'ready', ...(xrStartup ? { xrStartup } : {}) }))._meta[KEY].delivery;
      if (!delivery) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(delivery).toBeDefined();
    const claim = { ...bind, panelId: targetPanelId, commandId: delivery.commandId, claimToken: delivery.claimToken };
    if (fail) return call('complete_inspection', { ...claim, failure: 'render_failed', failureReason: 'Test GPU failure' });
    expect((await call('complete_inspection', { ...claim, phase: 'admit' })).structuredContent.admitted).toBe(true);
    try { await player.installLesson(molecularLessonToTour(delivery.change.patch.lesson), delivery.change.patch.start, undefined, delivery.change.patch.frame); }
    catch(error) {
      const result=await call('complete_inspection',{...claim,failure:'render_failed',failureReason:(error as Error).message});
      await poll(); return result;
    }
    if (molecular) {
      molecular.inputFrames();
      expect(molecular.errors).toEqual([]);
      const objects=new Set([...molecular.representations,...molecular.registry.representations(),...molecular.figure.annotations()].flatMap((repr:any)=>repr.renderObjects));
      expect(molecular.registry.drawn(objects)).toBe(true);
      expect(molecular.figure.drawn(objects,(repr:any)=>molecular.registry.replaces(repr)||molecular.registry.owns(repr))).toBe(true);
    }
    const s = player.getState();
    const result = await call('complete_inspection', { ...claim, scene, animation: scene.inspection.animation?.playback ?? null,
      tourState: { selectedId: s.selectedId, step: s.step, total: s.total, active: s.active, autoplay: s.autoplay, navigating: s.navigating, narration: s.narration } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent.command.status, JSON.stringify(result.structuredContent)).toBe('rendered');
    bind.baseInspectionRevision = result.structuredContent.inspectionRevision;
    await poll(); return result;
  }
  return { call, client, sessionId, bind, render, player, geometry, framing, inspection, get scene() { return scene; },
    swap: async () => {
      const replaced=await call('replace_inspection_source',{sessionId,source:{kind:'pasted',text:sourceText+'\n# replaced source\n'}});
      expect(replaced.isError,JSON.stringify(replaced.content)).not.toBe(true);
      const hydration=(await call('get_inspection',{sessionId}))._meta[KEY];
      Object.assign(bind,{sourceToken:hydration.sourceToken,baseStateRevision:hydration.stateRevision,baseInspectionRevision:hydration.inspectionRevision});
      catalog=hydration.catalog ?? await decodeInspectionCatalog(hydration.catalogWire);
      scene.sourceSha256=catalog.source.sha256;
      scene.selectionKeys=[catalog.rows[0].key];
      delete scene.inspection.lessonPlayback; delete scene.inspection.animation; delete scene.inspection.lessonFigure;
      const saveReply=await call('sync_inspection',{...bind,scene});
      expect(saveReply.isError,JSON.stringify(saveReply.content)).not.toBe(true);
      const saved=saveReply.structuredContent;
      bind.baseInspectionRevision=saved.inspectionRevision;
      const attached=await call('attach_inspection',{...bind,surface:'desktop',replacesPanelId:panelId});
      expect(attached.isError,JSON.stringify(attached.content)).not.toBe(true);
      panelId=attached.structuredContent.panelId; await poll();
      const receipt=textState(await call('get_inspection_state',{sessionId})).sourceRenderReceipt;
      expect(receipt.commandId).toBe(textState(replaced).commandId);
      expect(receipt.status).toBe('rendered');
    },
    close: async () => { player.pause(); h.cleanup(); await client.close(); await server.close(); } };
}

it('installs and replaces figures, tracks and tethers through MCP without a new session, with text receipts', async () => {
  const t = await setup();
  try {
    const original = structuredClone(t.scene), lesson = manifest();
    const installing = t.call('install_lesson', { sessionId: t.sessionId, lesson, start: { chapterId: 'second', autoplay: false, narration: false }, waitForRenderMs: 5000 });
    await t.render();
    expect(textState(await installing)).toMatchObject({ sessionId: t.sessionId, sourceToken: t.bind.sourceToken, command: { status: 'rendered' } });
    lesson.chapters[1].immersive.figure.labels[0].text = 'Edited live';
    lesson.chapters[1].animation.tracks[0].keyframes[1].t = 2;
    lesson.chapters[1].animation.tethers[0].label = 'Live tether';
    const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson }));
    expect(queued.command.status).toBe('queued');
    const before = textState(await t.call('get_inspection_state', { sessionId: t.sessionId, includeLesson: true }));
    expect(before.lessonManifest.chapters[1].immersive.figure.labels[0].text).toBe('Original label');
    await t.render();
    const state = textState(await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: queued.commandId, includeLesson: true }));
    expect(state.command.status).toBe('rendered');
    expect(state.lessonManifest.chapters[1].immersive.figure.labels[0].text).toBe('Edited live');
    expect(t.scene.inspection.lessonPlayback).toMatchObject({ chapterId: 'second', narration: false });
    expect(t.scene.inspection.animation.definition.tracks[0].keyframes[1].t).toBe(2);
    expect(t.scene.inspection.animation.definition.tethers[0].label).toBe('Live tether');
    expect(t.geometry.at(-1).labels[0].text).toBe('Edited live');
    for (const key of ['sourceSha256', 'modelNumber', 'assemblyId', 'selectionKeys']) expect(t.scene[key]).toEqual(original[key]);
    expect(t.scene.inspection.placement).toEqual(original.inspection.placement);
    const hydration = (await t.call('get_inspection', { sessionId: t.sessionId }))._meta[KEY];
    expect(hydration.customTour.steps[1].figure.labels[0].text).toBe('Edited live');
  } finally { await t.close(); }
}, 20000);

it('opens inline lesson/source without host files and exposes an editable manifest to text clients', async () => {
  const t = await setup(manifest());
  try {
    const state = textState(await t.call('get_inspection_state', { sessionId: t.sessionId, includeLesson: true }));
    expect(state.lessonManifest.id).toBe('live-test');
    const reply = await t.call('install_lesson', { sessionId: t.sessionId, lesson: state.lessonManifest });
    expect(textState(reply).command.status).toBe('queued');
    await t.render();
    expect(t.player.getState().active).toBe(false);
  } finally { await t.close(); }
});

it('refuses invalid targets, bounds and stale revisions without replacing the lesson', async () => {
  const t = await setup(manifest());
  try {
    const cases: [string, (v: any) => void][] = [
      ['provenance.sourceSha256', v => v.provenance.sourceSha256 = '0'.repeat(64)],
      ['chapters.0.immersive.figure.labels.0.target', v => v.chapters[0].immersive.figure.labels[0].target.chain = 'Z'],
      ['chapters.0.animation.tracks.0.chains.0', v => v.chapters[0].animation.tracks[0].chains = ['Z']],
      ['chapters.0.animation.tethers.0.to', v => v.chapters[0].animation.tethers[0].to.residue = 9999],
      ['chapters', v => v.chapters = Array.from({ length: 25 }, (_, i) => ({ ...v.chapters[0], id: `c${i}` }))],
      ['labels', v => v.chapters[0].immersive.figure.labels = Array(17).fill(v.chapters[0].immersive.figure.labels[0])],
      ['keyframes', v => v.chapters[0].animation.tracks[0].keyframes[1].t = 5],
    ];
    for (const [field, edit] of cases) {
      const lesson = manifest(); edit(lesson);
      const reply = await t.call('install_lesson', { sessionId: t.sessionId, lesson });
      expect(reply.isError, field).toBe(true);
      expect(JSON.stringify(reply.content).replaceAll('\\n', '').replaceAll('\\"', '')).toContain(field.split('.').at(-1));
    }
    const stale = await t.call('install_lesson', { sessionId: t.sessionId, lesson: manifest(), baseInspectionRevision: 0 });
    expect(stale.isError).toBe(true);
    const invalidStart = await t.call('install_lesson', { sessionId: t.sessionId, lesson: manifest(), start: { chapterId: 'missing' } });
    expect(invalidStart.content[0].text).toContain('start.chapterId');
    const failed = await t.call('install_lesson', { sessionId: t.sessionId, lesson: { ...manifest(), title: 'Never committed' } });
    await t.render(true);
    const state = textState(await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: textState(failed).commandId, includeLesson: true }));
    expect(state.command.status).toBe('rejected'); expect(state.lessonManifest.title).toBe('Live lesson');
  } finally { await t.close(); }
});

it('retains active chapter and autoplay on replacement; a removed chapter falls back to the first', async () => {
  const t = await setup();
  try {
    const lesson = manifest();
    await t.call('install_lesson', { sessionId: t.sessionId, lesson, start: { chapterId: 'second', autoplay: true, narration: false } });
    await t.render();
    lesson.chapters.reverse();
    await t.call('install_lesson', { sessionId: t.sessionId, lesson }); await t.render();
    expect(t.player.getState()).toMatchObject({ step: 0, autoplay: true, narration: false });
    expect(t.scene.inspection.lessonPlayback.chapterId).toBe('second');
    lesson.chapters = lesson.chapters.filter((chapter: any) => chapter.id !== 'second');
    await t.call('install_lesson', { sessionId: t.sessionId, lesson }); await t.render();
    expect(t.scene.inspection.lessonPlayback.chapterId).toBe('first');
    expect(t.player.getState().autoplay).toBe(true);
  } finally { await t.close(); }
});

it('rejects an oversized otherwise valid manifest and keeps the installed definition', async () => {
  const t = await setup(manifest());
  try {
    const lesson = manifest();
    // Each keyframe stays under the existing per-track cap; aggregate JSON exceeds 256 KiB.
    lesson.chapters[0].animation.durationSeconds = 600;
    lesson.chapters[0].animation.tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, chains: [`X${i}`],
      keyframes: Array.from({ length: 512 }, (_, t) => ({ t, rotation: [0, 0, 0, 1], translation: [1, 2, 3] })) }));
    delete lesson.chapters[0].animation.tethers;
    const response = await t.call('install_lesson', { sessionId: t.sessionId, lesson });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('262144');
    expect(response.content[0].text).toContain('lesson');
  } finally { await t.close(); }
});

// These integration fixtures use the installed demo cache when present; no download is implicit.
for (const [demo, coordinate] of [['hemoglobin-switch', 'hemoglobin-tr-motion.cif'], ['atp-synthase-rotor', 'atp-synthase-rotor-motion.cif'], ['kinesin-walk', 'kinesin-walk-motion.cif']]) {
  it(`edits ${demo} live through install_lesson`, async context => {
    const { demoCoordinatePath, readGrowthIndex } = await import('../src/molecular-growth.js');
    const { readAddressedDemoFile } = await import('../src/addressed-demo-cache.js');
    let source: string;
    const index = await readGrowthIndex();
    const coordinates = index.demos.find(entry => entry.name === demo)!.stages!.find(stage => stage.id === 'motion')!.coordinates;
    try {
      const cached = await readAddressedDemoFile(demoCoordinatePath, coordinate, coordinates.sha256);
      if (!cached) { context.skip(); return; }
      source = cached.bytes.toString('utf8');
    }
    catch { context.skip(); return; }
    const lesson = JSON.parse(await readFile(new URL(`../demos/${demo}/motion.json`, import.meta.url), 'utf8'));
    const t = await setup(lesson, source);
    try {
      const readback = textState(await t.call('get_inspection_state', { sessionId:t.sessionId, includeLesson:true }));
      expect(readback.lessonManifest).toEqual(JSON.parse(JSON.stringify(parseMolecularLesson(lesson))));
      const unchanged = await t.call('install_lesson', {sessionId:t.sessionId, lesson:readback.lessonManifest});
      expect(unchanged.isError, JSON.stringify(unchanged.content)).not.toBe(true);
      await t.render();
      const chapter = lesson.chapters.find((entry: any) => entry.animation);
      await t.call('install_lesson', { sessionId: t.sessionId, lesson, start: { chapterId: chapter.id, autoplay: false, narration: false } });
      await t.render();
      if (chapter.animation.tethers?.length) chapter.animation.tethers[0].label = 'Edited live tether';
      else chapter.caption = 'Edited live motion caption.';
      const frame = chapter.animation.tracks[0].keyframes[1];
      frame.t /= 2;
      const edit = await t.call('install_lesson', { sessionId: t.sessionId, lesson });
      expect(edit.isError, JSON.stringify(edit.content)).not.toBe(true);
      await t.render();
      expect(t.scene.inspection.animation.definition.tracks[0].keyframes[1].t).toBe(frame.t);
      if (chapter.animation.tethers?.length) expect(t.scene.inspection.animation.definition.tethers[0].label).toBe('Edited live tether');
      const data = (await t.call('get_inspection', { sessionId: t.sessionId }))._meta[KEY];
      expect(data.sessionId).toBe(t.sessionId);
      expect(data.customTour.steps.find((step: any) => step.id === chapter.id).body).toBe(chapter.caption);
    } finally { await t.close(); }
  }, 60000);
}


it('rolls back a renderer failure to the prior chapter and figure', async () => {
  const t=await setup();
  try {
    const lesson=manifest();
    await t.player.installLesson(molecularLessonToTour(lesson),{autoplay:false,narration:false});
    const before=structuredClone(t.scene);
    lesson.chapters[0].immersive.figure.labels[0].text='Failed figure';
    const original=t.inspection.setLessonFigure;
    t.inspection.setLessonFigure=async()=>{throw Error('GPU draw refused');};
    await expect(t.player.installLesson(molecularLessonToTour(lesson))).rejects.toThrow('GPU draw refused');
    t.inspection.setLessonFigure=original;
    expect(t.scene).toEqual(before);
    expect(t.player.getState()).toMatchObject({step:0,active:true,autoplay:false});
  } finally {await t.close();}
});

it('reinstalls a playing lesson with a new label and speed, runs real Mol* input ticks, and saves its rendered receipt', async () => {
  const {setCanvasModule}=await import('molstar/lib/mol-geo/geometry/text/font-atlas.js');
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x:number,_y:number,w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})} as any);
  const cleanup: (() => any)[] = [], errors: Error[] = [];
  const molecular = await molecularAnimationHarness({after:(fn:()=>any)=>cleanup.push(fn)}, {isImmersive:()=>true,onError:(error:Error)=>errors.push(error)});
  // Real figure and text geometry, with only Canvas3D/GPU and font rasterization adapted.
  // @ts-ignore Shared production browser geometry.
  const {createLessonFigure}=await import('../../lab/browser-roundtrip/lesson-figure.mjs');
  const {StructureElement}=await import('molstar/lib/mol-model/structure.js');
  molecular.plugin.canvas3d={xr:{isPresenting:{value:false}},update(){},add(){},remove(){},mark(){},syncVisibility(){},getRenderObjects:()=>[]};
  molecular.figure=createLessonFigure({plugin:molecular.plugin,getStructure:()=>molecular.structure,getTransform:()=>molecular.presentation});
  molecular.refreshAnnotations=()=>{
    const wanted=new Set(molecular.figure.annotations()), entries:any[]=[];
    for(const cell of molecular.plugin.state.data.cells.values()) {
      const repr=cell.obj?.data?.repr, data=cell.obj?.data?.sourceData;
      if(!wanted.has(repr))continue;
      const loci=[...(data?.infos??[]).map((info:any)=>info.loci),...(data?.pairs??[]).flatMap((pair:any)=>pair.loci)];
      if(loci.length) entries.push({repr,loci:loci.reduce((a:any,b:any)=>StructureElement.Loci.union(a,b))});
    }
    molecular.annotations.splice(0,Infinity,...entries,...molecular.figure.motionAnnotations());
  };
  let time=0, duringBuild=0;
  const tick=()=>{duringBuild++;molecular.registry.tick(time=Math.max(time+14,performance.now()));};
  const subscriptions=['created','removed'].map(kind=>molecular.plugin.state.data.events.cell[kind].subscribe(tick));
  molecular.errors=errors; molecular.inputFrames=()=>{for(let i=0;i<20;i++) tick();};
  const t=await setup(undefined,cif,molecular);
  try {
    const lesson=manifest();
    lesson.chapters[1].animation.playback={autoplay:true,loop:true,speed:1};
    await t.call('install_lesson',{sessionId:t.sessionId,lesson,start:{chapterId:'second',autoplay:true,narration:false}});
    await t.render(); expect(molecular.registry.snapshot().state).toBe('playing');
    lesson.chapters[1].immersive.figure.labels[0].text='Leading head';
    lesson.chapters[1].animation.playback.speed=2;
    // A manifest's initial autoplay default must not stop an already playing visit.
    lesson.chapters[1].animation.playback.autoplay=false;
    const request=await t.call('install_lesson',{sessionId:t.sessionId,lesson});
    await t.render();
    expect(molecular.registry.snapshot()).toMatchObject({state:'playing',speed:2});
    const renderedTime=molecular.registry.snapshot().timeSeconds;
    molecular.inputFrames();
    expect(molecular.registry.snapshot().timeSeconds).toBeGreaterThan(renderedTime);
    expect(duringBuild).toBeGreaterThan(40);
    expect(t.geometry.at(-1).labels[0].text).toBe('Leading head');
    expect(molecular.figure.definition().labels[0].text).toBe('Leading head');
    expect(molecular.figure.annotations()[0].renderObjects.some((object:any)=>object.values.drawCount.ref.value>0)).toBe(true);
    const state=textState(await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:textState(request).commandId,includeLesson:true}));
    expect(state.command.status).toBe('rendered');
    expect(state.lessonManifest.chapters[1].animation.playback.speed).toBe(2);
    expect(state.lessonManifest.chapters[1].immersive.figure.labels[0].text).toBe('Leading head');
  } finally {
    subscriptions.forEach(subscription=>subscription.unsubscribe());
    await t.close(); await molecular.registry.forget(); await molecular.figure.forget(); molecular.plugin.canvas3d=undefined;
    for(const fn of cleanup.reverse()) await fn();
  }
}, 20000);

it('a partial install failure promptly rejects with its error, restores the drawn manifest and permits the next command', async()=>{
  const t=await setup();
  try {
    const lesson=manifest();
    await t.call('install_lesson',{sessionId:t.sessionId,lesson,start:{chapterId:'second',autoplay:false,narration:false}}); await t.render();
    const before=structuredClone(t.scene), draw=t.inspection.setLessonFigure;
    lesson.chapters[1].immersive.figure.labels[0].text='Failed label';
    t.inspection.setLessonFigure=async(...args:any[])=>{await draw(...args);throw Error('Input frame body failed');};
    const request=await t.call('install_lesson',{sessionId:t.sessionId,lesson});
    const failed=await t.render();
    expect(failed.structuredContent.command).toMatchObject({status:'rejected',reason:'render_failed',detail:'Input frame body failed'});
    expect(t.player.getState().navigating).toBe(false); expect(t.scene).toEqual(before);
    const state=textState(await t.call('get_inspection_state',{sessionId:t.sessionId,commandId:textState(request).commandId,includeLesson:true}));
    expect(state.lessonManifest.chapters[1].immersive.figure.labels[0].text).toBe('Original label');
    t.inspection.setLessonFigure=draw;
    const next=await t.call('install_lesson',{sessionId:t.sessionId,lesson});
    expect(next.isError).not.toBe(true); await t.render();
  }finally{await t.close();}
});


it('frames the first lesson after a source swap, preserves later placement, and honors frame:true', async () => {
  const t=await setup(manifest());
  try {
    await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),start:{autoplay:false,narration:false}}); await t.render();
    expect(t.framing).not.toContain('begin');
    await t.swap();
    // The desktop frames a new source's first lesson even over a held placement.
    t.framing.length=0;
    await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),start:{autoplay:false,narration:false}}); await t.render();
    expect(t.framing).toContain('begin'); expect(t.framing).toContainEqual({animation:true});
    const position=structuredClone(t.scene.camera.position); t.framing.length=0;
    await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest()}); await t.render();
    expect(t.framing).not.toContain('begin'); expect(t.framing).toContainEqual({animation:false});
    expect(t.scene.camera.position).toEqual(position);
    t.framing.length=0;
    await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),frame:true}); await t.render();
    expect(t.framing).toContain('begin'); expect(t.framing).toContainEqual({animation:true});
  } finally {await t.close();}
});


it('keeps a placement the wearer holds in the headset through the first lesson on a new source', async () => {
  const t=await setup(manifest(),cif,undefined,{xr:true});
  try {
    await t.swap();
    const before=structuredClone(t.scene); t.framing.length=0;
    const installed=await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),start:{autoplay:true,narration:false}});
    expect(installed.isError,JSON.stringify(installed.content)).not.toBe(true);
    await t.render();
    expect(t.framing).not.toContain('begin'); expect(t.framing).toContainEqual({animation:false});
    expect(t.scene.camera).toEqual(before.camera); expect(t.scene.inspection.placement).toEqual(before.inspection.placement);
    expect(t.player.getState()).toMatchObject({active:true,step:0});
  } finally {await t.close();}
});

it('a failed explicit reframe restores the prior camera and placement', async () => {
  const t=await setup(manifest());
  try {
    await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),start:{autoplay:false,narration:false}}); await t.render();
    const before=structuredClone(t.scene), animate=t.inspection.setMolecularAnimation, restore=t.inspection.restore;
    t.inspection.setMolecularAnimation=async(...args:any[])=>{await animate(...args);if(args[0])throw Error('Failed framed draw');};
    t.inspection.restore=async(scene:any,options:any)=>{expect(options).toEqual({preserveCamera:false,preservePlacement:false});return restore(scene,options);};
    await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),frame:true});
    const failed=await t.render();
    expect(failed.structuredContent.command).toMatchObject({status:'rejected',detail:'Failed framed draw'});
    expect(t.scene).toEqual(before);
  } finally {await t.close();}
});

it('delivers a lesson install to a busy molecular drag without waiting for release',async()=>{
  const t=await setup();
  try {
    const state=textState(await t.call('get_inspection_state',{sessionId:t.sessionId}));
    const panelId=state.panels[0].panelId;
    const beat=()=>t.call('poll_inspection',{...t.bind,panelId,availability:'busy'});
    await beat();
    const installed=await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),start:{autoplay:false,narration:false}});
    expect(installed.isError).not.toBe(true);
    const delivery=(await beat())._meta[KEY].delivery;
    expect(delivery?.change.kind).toBe('lesson');
    const failure=await t.call('complete_inspection',{...t.bind,panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,
      failure:'render_failed',failureReason:'Test cleanup'});
    expect(failure.isError).not.toBe(true);
  }finally{await t.close();}
});

it.each(['headset-hidden','page-hidden'])('keeps a lesson install queued while %s and delivers it on waking',async hidden=>{
  const t=await setup();
  try {
    const state=textState(await t.call('get_inspection_state',{sessionId:t.sessionId}));
    // Register the actual companion surface; a hidden desktop has no wearer.
    const panelId=(await t.call('attach_inspection',{...t.bind,surface:'companion'})).structuredContent.panelId;
    const report={phase:'active',pending:false,reloadRequired:false,mode:'immersive-ar',gestureActive:null,
      presenting:hidden==='headset-hidden',visible:hidden!=='page-hidden',sessionVisibility:hidden==='headset-hidden'?'hidden':'visible'};
    await t.call('poll_inspection',{...t.bind,panelId,availability:'busy',xrStartup:report});
    const installed=await t.call('install_lesson',{sessionId:t.sessionId,lesson:manifest(),start:{autoplay:false,narration:false}});
    expect(installed.isError,JSON.stringify(installed.content)).not.toBe(true);
    expect(textState(installed).command.status).toBe('queued');
    const sleeping=await t.call('poll_inspection',{...t.bind,panelId,availability:'busy',xrStartup:report});
    expect(sleeping._meta[KEY].delivery).toBeUndefined();
    const awake=await t.call('poll_inspection',{...t.bind,panelId,availability:'ready',xrStartup:{...report,presenting:true,visible:true,sessionVisibility:'visible',frameCount:20}});
    expect(awake._meta[KEY].delivery?.change.kind).toBe('lesson');
  }finally{await t.close();}
});


// Host reads and a replacement page's polls are not heartbeats from the owner.
it.each(['ready', 'busy'] as const)('settles a vanished hidden %s page lesson and accepts the next edit and source', async availability => {
  let now = 1_000_000;
  const t = await setup(undefined, cif, undefined, { now: () => now });
  try {
    const panelId = (await t.call('attach_inspection', { ...t.bind, surface: 'companion' })).structuredContent.panelId;
    await t.call('poll_inspection', { ...t.bind, panelId, availability, xrStartup: {
      phase: 'idle', pending: false, reloadRequired: false, mode: null, gestureActive: null, presenting: false, visible: false } });
    const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson: manifest() }));
    expect(queued.command).toMatchObject({ panelId, status: 'queued' });
    // Crash/discard: no more calls from panelId, and no detach.
    const replacement = (await t.call('attach_inspection', { ...t.bind, surface: 'companion' })).structuredContent.panelId;
    const grace = availability === 'busy' ? 180_000 : 60_000;
    for (let elapsed = 1_000; elapsed < grace; elapsed += 1_000) {
      now += 1_000;
      const reply = await t.call('poll_inspection', { ...t.bind, panelId: replacement, availability: 'ready' });
      expect(reply._meta[KEY].delivery).toBeUndefined();
    }
    expect(textState(await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: queued.command.commandId })).command.status).toBe('queued');
    now += 1_000;
    const settled = textState(await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: queued.command.commandId }));
    expect(settled.command).toMatchObject({ status: 'expired', reason: 'panel_lost' });
    expect(settled.panels.map((p: any) => p.panelId)).not.toContain(panelId);
    // A late old page cannot take the dead command back.
    expect((await t.call('poll_inspection', { ...t.bind, panelId, availability: 'ready' }))._meta[KEY].delivery).toBeUndefined();
    const edit = await t.call('update_inspection', { ...t.bind, panelId: replacement, commandId: 'after-crash',
      change: { kind: 'appearance', patch: { opacity: 0.7 } } });
    expect(edit.isError, JSON.stringify(edit.content)).not.toBe(true);
    const delivery = (await t.call('poll_inspection', { ...t.bind, panelId: replacement, availability: 'ready' }))._meta[KEY].delivery;
    const scene = structuredClone(t.scene); scene.inspection.appearance.opacity = 0.7;
    const saved = await t.call('complete_inspection', { ...t.bind, panelId: replacement, commandId: delivery.commandId, claimToken: delivery.claimToken, scene });
    expect(saved.structuredContent.command.status).toBe('rendered');
    t.bind.baseInspectionRevision = saved.structuredContent.inspectionRevision;
    const load = await t.call('replace_inspection_source', { ...t.bind, panelId: replacement,
      source: { kind: 'pasted', text: cif + '\n# next source\n' } });
    expect(load.isError, JSON.stringify(load.content)).not.toBe(true);
    expect(load.structuredContent.sourceTransition.sourceChanged).toBe(true);
  } finally { await t.close(); }
});

it.each(['page-hidden', 'headset-hidden'].flatMap(hidden =>
  (['ready', 'busy'] as const).map(availability => ({ hidden, availability }))))(
  'keeps a slowly polling $availability $hidden lesson for ten minutes and renders on wake', async ({ hidden, availability }) => {
  let now = 1_000_000;
  const t = await setup(undefined, cif, undefined, { now: () => now });
  try {
    const panelId = (await t.call('attach_inspection', { ...t.bind, surface: 'companion' })).structuredContent.panelId;
    const report = { phase: 'active', pending: false, reloadRequired: false, mode: 'immersive-ar', gestureActive: null,
      presenting: hidden === 'headset-hidden', visible: hidden !== 'page-hidden', sessionVisibility: hidden === 'headset-hidden' ? 'hidden' : 'visible' };
    await t.call('poll_inspection', { ...t.bind, panelId, availability, xrStartup: report });
    const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson: manifest() }));
    // A second mounted page is not proof this still-polling page has gone.
    await t.call('attach_inspection', { ...t.bind, surface: 'companion' });
    const interval = availability === 'busy' ? 100_000 : 30_000;
    for (let elapsed = 0; elapsed < 600_000; elapsed += interval) {
      now += interval;
      const reply = await t.call('poll_inspection', { ...t.bind, panelId, availability, xrStartup: report });
      expect(reply.structuredContent.attached).toBe(true);
      expect(reply._meta[KEY].delivery).toBeUndefined();
      expect(textState(await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: queued.command.commandId })).command.status).toBe('queued');
    }
    const rendered = await t.render(false, panelId, { ...report,
      presenting: true, visible: true, sessionVisibility: 'visible', frameCount: 20 });
    expect(rendered.structuredContent.command.status).toBe('rendered');
    expect(t.geometry.length).toBeGreaterThan(0);
  } finally { await t.close(); }
});

it.each(['detach', 'replacement'])('settles a hidden lesson immediately on explicit %s', async departure => {
  const t = await setup();
  try {
    const panelId = (await t.call('attach_inspection', { ...t.bind, surface: 'companion' })).structuredContent.panelId;
    await t.call('poll_inspection', { ...t.bind, panelId, availability: 'ready', xrStartup: {
      phase: 'idle', pending: false, reloadRequired: false, mode: null, gestureActive: null, presenting: false, visible: false } });
    const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson: manifest() }));
    if (departure === 'detach') await t.call('detach_inspection', { ...t.bind, panelId });
    const replacement = (await t.call('attach_inspection', { ...t.bind, surface: 'companion',
      ...(departure === 'replacement' ? { replacesPanelId: panelId } : {}) })).structuredContent.panelId;
    expect(textState(await t.call('get_inspection_state', { sessionId: t.sessionId, commandId: queued.command.commandId })).command.status).toBe('conflict');
    const next = await t.call('install_lesson', { ...t.bind, panelId: replacement, lesson: manifest() });
    expect(next.isError, JSON.stringify(next.content)).not.toBe(true);
    expect(textState(next).command.status).toBe('queued');
  } finally { await t.close(); }
});


it('settles a vanished lesson on the first host read even with no replacement page or intervening polls', async () => {
  let now = 1_000_000;
  const t = await setup(undefined, cif, undefined, { now: () => now });
  try {
    const panelId = (await t.call('attach_inspection', { ...t.bind, surface: 'companion' })).structuredContent.panelId;
    await t.call('poll_inspection', { ...t.bind, panelId, availability: 'busy', xrStartup: {
      phase: 'idle', pending: false, reloadRequired: false, mode: null, gestureActive: null, presenting: false, visible: false } });
    const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson: manifest() }));
    now += 240_000;
    const read = () => t.call('get_inspection_state', { sessionId: t.sessionId, commandId: queued.command.commandId });
    expect(textState(await read()).command).toMatchObject({ status: 'expired', reason: 'panel_lost' });
    expect((await read()).structuredContent.pendingCommand).toEqual([]);
  } finally { await t.close(); }
});
