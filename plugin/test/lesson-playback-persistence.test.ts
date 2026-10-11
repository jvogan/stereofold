import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { sceneSchema, validateScene } from '../src/inspection-contract.js';
import { mountTourPlayer, savedLessonPlayback, type Tour } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { TOURS } from '../src/tour-catalog.js';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
// @ts-ignore Real player DOM boundary, no browser or device needed.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Shared renderer validators.
import { createInspectionState, DEFAULT_INSPECTION } from '../../lab/browser-roundtrip/inspection-state.mjs';
// @ts-ignore Shared renderer validators.
import { cameraSnapshot } from '../../lab/browser-roundtrip/camera-snapshot.mjs';
// @ts-ignore Shared renderer validators.
import { normalizeStyles } from '../../lab/browser-roundtrip/inspection-styles.mjs';
// @ts-ignore Shared renderer validators.
import { normalizeVisibility } from '../../lab/browser-roundtrip/inspection-visibility.mjs';
// @ts-ignore Shared renderer metadata admission guard.
import { canRestoreLessonPlaybackMetadata } from '../../lab/browser-roundtrip/lesson-playback-restore.mjs';
// @ts-ignore Production transaction publication guard.
import { createNamedPublication } from '../../lab/inspection/named-publication.mjs';
// @ts-ignore Production emphasis ownership and normalization.
import { createLessonResting } from '../../lab/browser-roundtrip/lesson-resting.mjs';
// @ts-ignore Production emphasis normalization.
import { normalizeEmphasisState } from '../../lab/browser-roundtrip/lesson-emphasis.mjs';
// @ts-ignore Production gesture pivot ownership policy.
import { createGesturePivot } from '../../lab/browser-roundtrip/gesture-pivot.mjs';

const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const viewerAst=ts.createSourceFile('viewer.mjs',source,ts.ScriptTarget.Latest,true);
const inspectorSource = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const inspectorAst=ts.createSourceFile('inspector.ts',inspectorSource,ts.ScriptTarget.Latest,true);
const lesson = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/daraxonrasib.json', import.meta.url), 'utf8')));
const catalog = { source: { sha256: 'a'.repeat(64) }, modelNumbers: [1], assemblyId: '1', rows: [] };
const initial = () => ({ sourceSha256: catalog.source.sha256, modelNumber: 1, assemblyId: '1', selectionKeys: [],
  camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
    radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
  inspection: structuredClone(DEFAULT_INSPECTION),
});
const noop = () => {};
/** Execute the production viewer capture/validation/restore closures; adapt GPU work only. */
function panel() {
  const dom = tourEndHarness({ xr: false });
  const original = initial(), state = createInspectionState();
  state.replace(original.inspection);
  let graph: any, camera = original.camera;
  const calls: string[] = [], spoken: string[] = [];
  let publish = noop;
  const c: any = vm.createContext({ structuredClone, Map, Set, Object,
    detached: structuredClone, assertReady: noop, liveScene: () => ({ ...original, camera }), canRestoreLessonPlaybackMetadata,
    snapshot: () => state.snapshot(),
    selectedKeys: (v: any) => v, cameraSnapshot, normalizeStyles, normalizeVisibility,
    createInspectionState, inspectionState: state, state: { selectionKeys: [], generation: 1, status: 'ready' },
    sourceRecord: catalog.source, gesturePivot: createGesturePivot(), focusPivotRequest: undefined,
    xrPlacementFollowup: undefined, clearTimeout,
    inspectionSnapshot: () => ({ appearance: state.snapshot().appearance, placement: state.snapshot().placement }),
    lessonMotionHold: { presented: (v: any) => v, release: noop }, desktopPreviewCamera: undefined,
    savedVisibility: () => ({}), lessonPlayback: undefined,
    lessonFigure: { definition: () => structuredClone(graph), install: async (v: any) => { graph = structuredClone(v); calls.push('figure'); } },
    wearerPlacement: { holdsPlacement: () => false }, recordManipulation: noop,
    normalizeEmphasisState, emphasisState: normalizeEmphasisState({contextOpacity:1}), emphasisOrigin: 'command',
    lessonKey: { remember: noop }, visibilityState: {}, stylesState: [],
    syncInspectionPayload: noop, restoreCompanion: async () => {},
    markSelection: (v: any) => { c.state.selectionKeys = v; },
    canvas: { camera: { setState: (v: any) => { camera = structuredClone(v); calls.push('camera'); } } },
    applyInspectionAppearance: async () => { calls.push('appearance'); }, applyInspectionTransform: noop,
    fitDesktopPreview: noop, restoreXrRecoveryFrame: () => { calls.push('recovery'); }, inspectionPayload: () => ({}),
    inspectionMutation: async (fn: any) => { await fn(); publish(); },
    failure: (_code: string, message: string) => Error(message),
  });
  c.lessonResting=createLessonResting({snapshot:()=>state.snapshot(),rebuildLabels:async()=>{},
    getEmphasis:()=>c.emphasisState,getOrigin:()=>c.emphasisOrigin,
    emphasize:async(value:any)=>{c.emphasisState=normalizeEmphasisState(value);c.emphasisOrigin=value.origin??'command';}});
  for (const name of ['invalidateGesturePivot', 'cancelXrPlacementFollowup']) {
    let helper:ts.FunctionDeclaration|undefined;
    const visit=(node:ts.Node)=>{
      if(ts.isFunctionDeclaration(node)&&node.name?.text===name)helper=node;
      else ts.forEachChild(node,visit);
    };
    visit(viewerAst);
    expect(helper,`production ${name} helper must be extracted`).toBeDefined();
    vm.runInContext(helper!.getText(viewerAst),c);
  }
  for (const [start, end] of [
    ['  function completeInspectionCapture()', '\n  /**'],
    ['  function savedEmphasis()', '\n  /**'],
    ['  function validInspectionCapture(', '\n  async function configureInspection'],
    ['  async function restoreInspection(value', '\n  async function restoreTourSeat'],
  ]) {
    const from = source.indexOf(start);
    vm.runInContext(source.slice(from, source.indexOf(end, from)), c);
  }
  const capture = () => c.completeInspectionCapture();
  const inspection = {
    configure: async ({componentLabels: _plates, ...patch}: any) => state.configure(patch), place: async (patch: any) => state.place(patch),
    fit: async () => {}, resetOrientation: async () => {}, orbit: async () => {}, dolly: async () => {},
    setMotion: async () => {}, emphasize: async () => {}, clearLessonEmphasis: async () => {},
    setLessonFigure: async (value: any) => { graph = structuredClone(value); },
    setLessonPlayback: (value: any) => { c.lessonPlayback = structuredClone(value); },
    restore: async (value: any, options?: any) => c.restoreInspection(value, options),
  };
  const workspace: any = { snapshot: () => ({ ready: true, sourceSha256: catalog.source.sha256, xrPresenting: false }),
    capture, rows: () => [], runTour: async (fn: any) => fn(), setStatus: noop,
    viewer: { select: async () => {}, focus: async () => {}, inspection },
  };
  return { workspace, after: dom.after, cleanup: dom.cleanup, capture, calls, spoken,
    onMutation: (callback: () => void) => { publish = callback; },
    narrate: (line: string) => spoken.push(line), aside: noop,
    hydrate: async (scene: any, player: ReturnType<typeof mountTourPlayer>, tour: Tour = lesson) => {
      const checked = validateScene(scene, catalog);
      savedLessonPlayback(checked, [tour]);
      await inspection.restore(checked);
      await player.replaceTours([tour]); await player.select(tour.id);
      player.restorePlayback(checked);
    },
  };
}

describe('saved lesson handoff and reconnect', () => {
  /** Run the real polling branch and serialized workspace restore with the real player. */
  function peer(h: ReturnType<typeof panel>, player: ReturnType<typeof mountTourPlayer>) {
    const workspaceSource = readFileSync(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
    const publications: any[] = [];
    const publication = createNamedPublication(() => { publications.push(h.capture()); player.notifyMutation(undefined,{agent:true}); });
    h.onMutation(() => publication.mutation(h.capture()));
    const queue: any = vm.createContext({ queue:Promise.resolve(), closing:false,busy:false,
      moleculeCanvas:{style:{}}, $$:()=>[],setStatus:noop,sync:noop,options:{onSettled:noop},
      viewer:h.workspace.viewer,captureScene:h.capture,namedPublication:publication });
    h.workspace.viewer.snapshot=h.workspace.snapshot;
    const run=workspaceSource.slice(workspaceSource.indexOf('function run('),workspaceSource.indexOf('\nfunction ui('));
    const restore=workspaceSource.slice(workspaceSource.indexOf('  restoreShared:')+'  restoreShared:'.length,workspaceSource.indexOf('\n  captureNamedView:')).trim().replace(/,$/,'');
    vm.runInContext(`${run}\nglobalThis.restoreShared=(${restore});`,queue);
    h.workspace.restoreShared=queue.restoreShared;
    const page:any=vm.createContext({workspace:h.workspace,tourPlayer:player,followable:true,privateState:{},data:{},
      generation:1,ownGeneration:1,edits:0,dirty:false,blocked:false,loading:false,remote:false,
      binding:{serverEpoch:'epoch',sourceToken:'source',stateRevision:1,inspectionRevision:1},savedScene:h.capture(),
      outcome:{textContent:''},showOutcome:noop });
    // Keep the real admission condition as it evolves. A missing string marker
    // used to silently extract an empty body and make every peer follow a no-op.
    const candidates:ts.IfStatement[]=[];
    const visit=(node:ts.Node)=>{
      if(ts.isIfStatement(node) && node.expression.getText(inspectorAst).includes('followable')
        && node.thenStatement.getText(inspectorAst).includes('workspace.restoreShared('))candidates.push(node);
      ts.forEachChild(node,visit);
    };
    visit(inspectorAst);
    expect(candidates,'one production shared-scene restore branch must be extracted').toHaveLength(1);
    const follow=candidates[0]!.getText(inspectorAst);
    vm.runInContext(ts.transpileModule(`globalThis.follow=async()=>{${follow}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,page);
    return { page,queue,publications,follow:async(scene:any)=>{page.privateState={scene};page.data={...page.binding,inspectionRevision:page.binding.inspectionRevision+1};await page.follow();} };
  }

  for(const change of ['metadata','chapter','done'] as const) it(`reconciles a live peer ${change} before capture, and does not republish the previous cursor`,async()=>{
    const h=panel(),player=mountTourPlayer({...h,tours:[lesson]});
    try {
      await player.select(lesson.id);await player.start(false,0);
      h.spoken.length=0;
      const p=peer(h,player),next=h.capture();
      if(change==='metadata') {next.inspection.lessonPlayback.stopped=true;next.inspection.lessonPlayback.narration=false;}
      if(change==='chapter') {next.inspection.lessonPlayback.chapterId=lesson.steps[1].id;next.inspection.appearance.background='#123456';}
      if(change==='done') delete next.inspection.lessonPlayback;
      await p.follow(next);
      expect(p.publications).toEqual([]);
      expect(h.capture().inspection.lessonPlayback).toEqual(next.inspection.lessonPlayback);
      expect(p.page.savedScene).toEqual(h.capture());
      expect(player.getState()).toMatchObject({step:change==='done'?-1:change==='chapter'?1:0,autoplay:false,
        ...(change==='metadata'?{stopped:true,narration:false}:{})});
      player.pause('Next peer beat.');
      expect(h.capture().inspection.lessonPlayback).toEqual(next.inspection.lessonPlayback);
      expect(h.spoken).toEqual([]);
      if(change==='metadata') expect(h.calls).toEqual([]);
      else expect(h.calls).toContain('appearance');
      if(change==='chapter') {await player.back();expect(player.getState().step).toBe(0);}
    } finally {player.pause();h.cleanup();}
  });

  it.each([false,true])('keeps saved lesson emphasis ownership across a full peer restore, then skips status geometry (stopped=%s)',async(stopped)=>{
    const h=panel(),player=mountTourPlayer({...h,tours:[lesson]});
    try {
      await player.select(lesson.id);await player.start(false,0);
      const p=peer(h,player),next=h.capture();
      next.inspection.emphasis.origin='lesson';next.inspection.lessonPlayback.stopped=stopped;
      await p.follow(next);
      expect(h.capture().inspection.emphasis).toEqual(next.inspection.emphasis);
      const painted=h.calls.length;
      const status=structuredClone(next);status.inspection.lessonPlayback.narration=false;
      expect(canRestoreLessonPlaybackMetadata(h.capture(),status)).toBe(true);
      await p.follow(status);
      expect(h.calls).toHaveLength(painted);
      expect(h.capture().inspection).toEqual(status.inspection);
      // Reload uses the same production restore and must retain chapter ownership.
      await h.hydrate(status,player);
      expect(h.capture().inspection.emphasis.origin).toBe('lesson');
      if(stopped) await player.rejoin(false);
      await player.finish();
      expect(h.capture().inspection.lessonPlayback).toBeUndefined();
      expect(h.capture().inspection.emphasis.origin).toBeUndefined();
    } finally {player.pause();h.cleanup();}
  });

  it('retains resting ownership for a plain saved scene without a lesson cursor',async()=>{
    const h=panel();
    try {
      const plain=h.capture();plain.inspection.emphasis.origin='lesson';
      await h.workspace.viewer.inspection.restore(plain);
      expect(h.capture().inspection.emphasis.origin).toBe('resting');
    } finally {h.cleanup();}
  });

  it('refuses invalid peer metadata and a lost admission before rendering or changing the cursor',async()=>{
    const h=panel(),player=mountTourPlayer({...h,tours:[lesson]});
    try {
      await player.select(lesson.id);await player.start(false,0);
      const p=peer(h,player),before=h.capture(),next=h.capture();
      next.inspection.lessonPlayback.chapterId='missing';
      await expect(p.follow(next)).rejects.toThrow();
      expect(h.capture()).toEqual(before);expect(h.calls).toEqual([]);
      next.inspection.lessonPlayback.chapterId=lesson.steps[1].id;p.page.dirty=true;
      await expect(p.follow(next)).rejects.toThrow('Local work changed');
      expect(h.capture()).toEqual(before);expect(player.getState().step).toBe(0);expect(p.page.remote).toBe(false);
    } finally {player.pause();h.cleanup();}
  });

  it('revalidates a lesson catalog changed while the shared restore waited for the queue',async()=>{
    const h=panel(),player=mountTourPlayer({...h,tours:[lesson]});
    try {
      await player.select(lesson.id);await player.start(false,0);
      const p=peer(h,player),before=h.capture(),next=h.capture();next.inspection.lessonPlayback.stopped=true;
      let release!:()=>void;p.queue.queue=new Promise<void>(done=>{release=done;});
      const pending=p.follow(next);
      await player.replaceTours([]);
      // Keep the visual capture equal, so this isolates catalog admission from
      // the existing local-scene/revision checks.
      h.workspace.viewer.inspection.setLessonPlayback(before.inspection.lessonPlayback);
      release();await expect(pending).rejects.toThrow();
      expect(h.calls).toEqual([]);expect(h.capture()).toEqual(before);expect(p.page.remote).toBe(false);
    } finally {player.pause();h.cleanup();}
  });

  function statusPanel() {
    const h = panel(), startingScene = h.capture();
    h.workspace.viewer.inspection.setLessonPlayback({ tourId: lesson.id, chapterId: lesson.steps[0].id,
      stopped: false, narration: true, startingScene });
    return h;
  }

  it('acknowledges peer stop/narration metadata through the real restore and capture without geometry work', async () => {
    const h = statusPanel();
    try {
      const next = validateScene(sceneSchema.parse(h.capture()), catalog);
      next.inspection.lessonPlayback!.stopped = true; next.inspection.lessonPlayback!.narration = false;
      await h.workspace.viewer.inspection.restore(next, { preserveCamera: true });
      expect(h.calls).toEqual([]);
      // This is the transport capture restoreShared returns to savedScene:
      // it contains the acknowledged flags, so polling cannot re-save an old cursor.
      expect(h.capture()).toEqual(next);
      expect(h.capture().inspection.placement).toEqual(next.inspection.placement);
    } finally { h.cleanup(); }
  });

  for (const change of ['appearance', 'figure', 'camera', 'placement', 'selection', 'chapter', 'baseline', 'clear'] as const)
    it(`keeps the full restore for a peer ${change} change alongside lesson status`, async () => {
      const h = statusPanel();
      try {
        const next = h.capture(); next.inspection.lessonPlayback.stopped = true;
        if (change === 'appearance') next.inspection.appearance.uniformColor = '#ff00ff';
        if (change === 'figure') next.inspection.lessonFigure = { layers: [{ id: 'chain-a', target: { chain: 'A' }, representation: 'cartoon', color: '#ff00ff' }] };
        if (change === 'camera') next.camera.position[0] += 1;
        if (change === 'placement') next.inspection.placement.scale *= 2;
        if (change === 'selection') next.selectionKeys = ['selected'];
        if (change === 'chapter') next.inspection.lessonPlayback.chapterId = lesson.steps[1].id;
        if (change === 'baseline') next.inspection.lessonPlayback.startingScene.camera.position[0] += 1;
        if (change === 'clear') delete next.inspection.lessonPlayback;
        await h.workspace.viewer.inspection.restore(next, { preserveCamera: true });
        expect(h.calls).toContain('appearance'); expect(h.calls).toContain('figure');
      } finally { h.cleanup(); }
    });

  for (const options of [{ restorePlacement: true }, { xrRecoveryFrame: {} }])
    it(`retains explicit placement/recovery work for ${Object.keys(options)[0]}`, async () => {
      const h = statusPanel();
      try {
        const next = h.capture(); next.inspection.lessonPlayback.stopped = true;
        await h.workspace.viewer.inspection.restore(next, options);
        expect(h.calls).toContain('appearance');
        if ('xrRecoveryFrame' in options) expect(h.calls).toContain('recovery');
      } finally { h.cleanup(); }
    });

  it('rechecks the live placement at restore admission before taking the metadata shortcut', async () => {
    const h = statusPanel();
    try {
      const next = h.capture(); next.inspection.lessonPlayback.stopped = true;
      await h.workspace.viewer.inspection.place({ scale: 2 });
      await h.workspace.viewer.inspection.restore(next, { preserveCamera: true });
      expect(h.calls).toContain('appearance');
    } finally { h.cleanup(); }
  });

  it('keeps pause-before-admission clean while saving a real transport change', async () => {
    const h = panel(); const player = mountTourPlayer({ ...h, tours: [lesson] });
    try {
      await player.select(lesson.id); await player.start(false, 0);
      const c: any = vm.createContext({ workspace:h.workspace, savedScene:h.capture(),
        loading:false,remote:false,closed:false,reloading:false,dirty:false,blocked:false,edits:0,timer:undefined,
        binding:{serverEpoch:'epoch',sourceToken:'source',stateRevision:1,inspectionRevision:1},
        sent:{serverEpoch:'epoch',sourceToken:'source',baseStateRevision:1,baseInspectionRevision:1},
        generation:1,ownGeneration:1,panelId:'panel',delivery:{panelId:'panel'},
        setTimeout:()=>1,clearTimeout:noop,save:async()=>{},saveRetryAdmission:createSaveRetryAdmission(),
      });
      const start=inspectorSource.indexOf('function scheduleSave()');
      vm.runInContext(inspectorSource.slice(start,inspectorSource.indexOf('\nlet saveAttempts',start)),c);
      const admission=inspectorSource.indexOf('    const localAdmission=()=>{');
      vm.runInContext(inspectorSource.slice(admission,inspectorSource.indexOf('    const admit=async()=>{',admission))+'\nglobalThis.checkAdmission=localAdmission;',c);
      player.subscribe(()=>c.scheduleLessonSave());
      // This is receive()'s production pause before it checks the local view.
      player.pause('A remote inspection command paused your tour.');
      expect(c.dirty).toBe(false); expect(c.edits).toBe(0);
      expect(()=>c.checkAdmission()).not.toThrow();
      player.notifyMutation();
      expect(c.dirty).toBe(true); expect(c.edits).toBeGreaterThan(0);
      expect(()=>c.checkAdmission()).toThrow('local view changed');
    } finally { player.pause(); h.cleanup(); }
  });
  it('retains the full snapshot through server save/hydration and rejects an unknown chapter at admission', async () => {
    const [a,b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { replyAudio: createReplyAudioSynthesizer({ enabled: false }) });
    const client = new Client({ name: 'Lesson persistence test', version: '1' });
    const call = async (name: string, args: any) => client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
    try {
      await server.connect(b); await client.connect(a);
      const opened = await call('inspect', { structureText: readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8') });
      const sessionId = opened.structuredContent.sessionId;
      const read = async () => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
      const data = await read(), scene: any = initial();
      Object.assign(scene, { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId });
      scene.inspection.lessonPlayback = { tourId: TOURS[0].id, chapterId: TOURS[0].steps[0].id,
        stopped: false, narration: false, startingScene: structuredClone(scene) };
      scene.inspection.lessonFigure = { layers: [{ id: 'chain-a', target: { chain: 'A' }, representation: 'cartoon', color: '#ff00ff' }] };
      scene.inspection.placement = { translation:[12,-20,30],rotation:[0,0,0],scale:8 };
      const saved = sceneSchema.parse(scene);
      const save = (current: any, value: any) => call('sync_inspection', { sessionId,
        serverEpoch: current.serverEpoch, sourceToken: current.sourceToken,
        baseStateRevision: current.stateRevision, baseInspectionRevision: current.inspectionRevision, scene: value });
      expect((await save(data, saved)).isError).not.toBe(true);
      const restored = await read();
      expect(restored.scene).toEqual(saved);
      const invalid = structuredClone(saved); invalid.inspection.lessonPlayback!.chapterId = 'unknown-chapter';
      expect((await save(restored, invalid)).isError).toBe(true);
      expect((await read()).scene).toEqual(saved);
    } finally { await client.close(); await server.close(); }
  });
  it('captures the real graph and resumes a fresh panel silently at the held chapter; Next and Done retain their meaning', async () => {
    vi.useFakeTimers();
    const desktop = panel(); const first = mountTourPlayer({ ...desktop, tours: [lesson] });
    let saved: any, start: any;
    try {
      await first.select(lesson.id); start = desktop.capture(); await first.start(false, 0);
      await desktop.workspace.viewer.inspection.place({ translation: [12, -20, 30], scale: 8 });
      await desktop.workspace.viewer.inspection.configure({ background: '#123456' });
      const altered = structuredClone(lesson.steps[0].figure!); altered.layers[0].color = '#ff00ff';
      await desktop.workspace.viewer.inspection.setLessonFigure(altered);
      first.notifyMutation(undefined, { agent: true });
      saved = validateScene(desktop.capture(), catalog);
      expect(saved.inspection.lessonFigure.layers[0].color).toBe('#ff00ff');
      expect(saved.inspection.lessonPlayback.chapterId).toBe('overview');
    } finally { first.pause(); desktop.cleanup(); }
    const headset = panel(); const second = mountTourPlayer({ ...headset, tours: [lesson] });
    try {
      await headset.hydrate(saved, second);
      expect(second.getState()).toMatchObject({ step: 0, active: true, autoplay: false });
      expect(headset.capture().inspection).toEqual(saved.inspection);
      expect(headset.spoken).toEqual([]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(second.getState().step).toBe(0);
      await second.next();
      expect(second.getState()).toMatchObject({ step: 1, autoplay: false });
      const closeup = headset.capture();
      expect(closeup.inspection.lessonFigure).toEqual(lesson.steps[1].figure);
      await headset.hydrate(closeup, second);
      expect(second.getState()).toMatchObject({ step: 1, autoplay: false });
      await second.finish();
      expect(headset.capture().inspection.appearance).toEqual(start.inspection.appearance);
      expect(headset.capture().inspection.placement).toEqual(start.inspection.placement);
      expect(headset.capture().inspection.lessonFigure).toBeUndefined();
      expect(headset.capture().inspection.lessonPlayback).toBeUndefined();
    } finally { second.pause(); headset.cleanup(); vi.useRealTimers(); }
  });

  it('rejects incompatible sources, absent chapters and malformed/nonrecursive baselines before hydration', async () => {
    const h = panel(); const player = mountTourPlayer({ ...h, tours: [lesson] });
    try {
      await player.select(lesson.id); await player.start(false, 0);
      const good: any = validateScene(h.capture(), catalog);
      for (const edit of [
        (v: any) => { v.inspection.lessonPlayback.startingScene.sourceSha256 = 'b'.repeat(64); },
        (v: any) => { v.inspection.lessonPlayback.startingScene.modelNumber = 2; },
        (v: any) => { v.inspection.lessonPlayback.startingScene.assemblyId = '2'; },
        (v: any) => { v.inspection.lessonPlayback.chapterId = 'missing'; },
        (v: any) => { v.inspection.lessonPlayback.tourId = 'missing'; },
        (v: any) => { v.inspection.lessonPlayback.startingScene.inspection.placement.scale = 0; },
        (v: any) => { v.inspection.lessonPlayback.startingScene.inspection.lessonPlayback = good.inspection.lessonPlayback; },
        (v: any) => { v.inspection.lessonFigure.layers = []; },
      ]) {
        const bad = structuredClone(good); edit(bad);
        const before = h.capture(), count = h.calls.length;
        await expect(h.hydrate(bad, player)).rejects.toThrow();
        expect(h.capture()).toEqual(before); expect(h.calls).toHaveLength(count);
      }
      expect(sceneSchema.safeParse(initial()).success).toBe(true);
    } finally { player.pause(); h.cleanup(); }
  });

  it('keeps narration off and preserves a saved manual takeover without replaying the chapter', async () => {
    const h = panel(); const player = mountTourPlayer({ ...h, tours: [lesson] });
    try {
      await player.select(lesson.id); await player.start(false, 0, { narration: false });
      await h.workspace.viewer.inspection.place({ translation: [2, 1, 0] });
      player.notifyMutation();
      const stopped = validateScene(h.capture(), catalog);
      expect(stopped.inspection.lessonPlayback).toMatchObject({ stopped: true, narration: false });
      await h.hydrate(stopped, player);
      expect(player.getState()).toMatchObject({ step: 0, stopped: true, active: false, autoplay: false, narration: false });
      expect(h.capture().inspection).toEqual(stopped.inspection);
      expect(h.spoken).toEqual([]);
      await player.next();
      expect(player.getState()).toMatchObject({ step: 1, narration: false, autoplay: false });
      expect(h.spoken).toEqual([]);
    } finally { player.pause(); h.cleanup(); }
  });

  it('Done after reconnect preserves a figure that already existed before the lesson', async () => {
    const h = panel(); const player = mountTourPlayer({ ...h, tours: [lesson] });
    try {
      const prior = structuredClone(lesson.steps[0].figure!); prior.layers[0].color = '#ff00ff';
      await h.workspace.viewer.inspection.setLessonFigure(prior);
      await player.select(lesson.id); await player.start(false, 1);
      await h.hydrate(h.capture(), player);
      await player.finish();
      expect(h.capture().inspection.lessonFigure).toEqual(prior);
      expect(h.capture().inspection.lessonPlayback).toBeUndefined();
    } finally { player.pause(); h.cleanup(); }
  });
});
