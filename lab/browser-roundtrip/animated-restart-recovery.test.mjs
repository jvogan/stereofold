import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { createLessonFigure } from './lesson-figure.mjs';
import { molecularAnimationHarness } from './fixtures/molecular-animation-harness.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const surroundings = 'The molecular figure surroundings changed while preparing its layers.';

// Mol*'s scene adds and removes render objects at frame commits, not at the call.
function queuedCanvas() {
  const committed = new Map(), owned = new Map(), queue = [];
  return { queue, xr: { isPresenting: { value: true } }, camera: { scale: .005 }, update() {}, mark() {}, syncVisibility() {},
    add(repr) {
      const old = owned.get(repr) ?? new Set(), next = new Set(repr.renderObjects);
      for (const object of old) if (!next.has(object)) queue.push(['remove', object]);
      for (const object of next) if (!old.has(object)) queue.push(['add', object]);
      owned.set(repr, next);
    },
    remove(repr) { for (const object of owned.get(repr) ?? []) queue.push(['remove', object]); owned.delete(repr); },
    commit(synchronous) {
      for (let n = 0; queue.length && (synchronous || n < 2); n++) {
        const [op, object] = queue.shift();
        if (op === 'add') committed.set(object, true); else committed.delete(object);
      }
    },
    getRenderObjects: () => [...committed.keys()] };
}

test('restarting a playing animated chapter stops its motion and lands its work before the figure rebuilds', async t => {
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const value = {version:1, durationSeconds:2, playback:{autoplay:true, loop:true}, tracks:[
    {id:'head', chains:['C'], keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},{t:2,rotation:[0,0,0,1],translation:[10,0,0]}]},
    {id:'copy', chains:['D'], keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},{t:2,rotation:[0,0,0,1],translation:[0,10,0]}]}]};
  const chapter = {distances:[], layers:[{id:'heme', target:{chain:'C', componentId:'HEM'}, representation:'ball-and-stick', color:'#ffffff', opacity:1}],
    labels:['C','D'].map(chain => ({id:chain, text:'Head', target:{chain}, color:'#ffffff', offsetX:0, offsetY:0, sizeFactor:1}))};
  let figure, h, annotations = () => [];
  const canvas = queuedCanvas();
  h = await molecularAnimationHarness(t, {canvas, getRepresentations:()=>[h.repr, ...figure.molecular()], getAnnotations:()=>annotations()});
  h.plugin.canvas3d = canvas; canvas.add(h.repr); canvas.commit(true);
  figure = createLessonFigure({plugin:h.plugin, getStructure:()=>h.structure, getTransform:()=>h.presentation});
  const start = source.indexOf('    getAnnotations: () => {');
  annotations = vm.runInNewContext('({'+source.slice(start, source.indexOf('    // Immersion uses', start))+'}).getAnnotations',
    {plugin:h.plugin, componentLabelRepresentations:()=>[], lessonFigure:figure, StructureElement});
  // XR frames commit a little queued work and tick the clock between awaits.
  let time = 0;
  const frames = setInterval(() => { canvas.commit(false); h.registry.tick(time += 14); }, 0);
  t.after(() => clearInterval(frames));
  let refreshing = 0;
  const registry = Object.create(h.registry);
  registry.refresh = () => { refreshing++; return h.registry.refresh().finally(() => refreshing--); };
  const stagedAgainst = [];
  const install = figure.install;
  const checked = {...figure, install: (definition, options) => {
    // The running chapter's work and its queued canvas changes have landed,
    // and its bodies stand still while the figure retires or stages.
    stagedAgainst.push({definition: Boolean(definition), refreshing, queued: canvas.queue.length});
    const body = h.registry.representations().find(repr => repr.state.visible);
    const pose = body && [...body.state.transform];
    return install(definition, options).then(result => {
      if (!definition && pose) assert.deepEqual([...body.state.transform], pose, 'the old chapter stopped posing its plates');
      return result;
    });
  }};
  const begin = source.indexOf('  async function installMolecularChapter('), end = source.indexOf('  async function setLessonFigure(', begin);
  const installChapter = vm.runInNewContext(source.slice(begin, end) + ';installMolecularChapter', {
    molecularAnimation:registry, lessonFigure:checked, applyInspectionTransform(){}, snapshot:()=>({ready:true}),
    wearerPlacement:{holdsPlacement:()=>true}, now:()=>performance.now(), recordCost(){},
    // mutate(): commit, then wait for a drawn frame with nothing left queued.
    inspectionMutation:async operation => { await operation(); while (canvas.queue.length) await new Promise(resolve => setTimeout(resolve, 1)); return {ready:true}; },
  });
  try {
    await installChapter(value, 'two-steps', {installFigure:true, figure:chapter, toolbarReady:Promise.resolve()});
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 2));
    // A late appearance refresh of the playing chapter is still building when
    // the restart arrives, as a lesson restart does over a live walk.
    void registry.refresh();
    stagedAgainst.length = 0;
    await installChapter(value, 'two-steps', {installFigure:true, figure:chapter, toolbarReady:Promise.resolve()});
    assert.deepEqual(stagedAgainst, [{definition:false, refreshing:0, queued:0}, {definition:true, refreshing:0, queued:0}]);
    assert.equal(figure.annotations().filter(repr => repr.state.visible).length, 2);
    const moving = h.registry.representations().find(repr => repr.state.visible), before = [...moving.state.transform];
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.notDeepEqual([...moving.state.transform], before, 'the restarted chapter is playing');
  } finally { clearInterval(frames); await h.registry.forget(); await figure.forget(); h.plugin.canvas3d = undefined; }
});

function failedChange({ figureFailures, frameFailsWhileFaulted = true }) {
  const saved = {layers:[], labels:[], distances:[]};
  let shown, faulted = true, settles = 0, payload = {lessonFigure:saved};
  const costs = [], c = vm.createContext({
    state:{status:'ready', error:null}, busy:false, companionRecord:undefined, inspectionMutationSettlement:undefined, stylesState:undefined, visibilityState:undefined, retiredComparisons:new Set(),
    inspectionState:{checkpoint:() => ({current:{}}), restoreCheckpoint() {}, payload:() => structuredClone(payload), setPayload:value => { payload = value; }},
    mutate:async (_kind, operation) => { await operation(); c.state.status = 'error'; c.state.error = surroundings; throw Error(surroundings); },
    normalizeStyles:value => value, normalizeVisibility:value => value, recordCost:(kind, detail) => costs.push({kind, ...detail}),
    lessonFigure:{definition:() => shown, install:async figure => {
      if (figure && figureFailures-- > 0) throw Error(surroundings);
      shown = figure;
    }},
    molecularAnimation:{settled:async () => { settles++; }, faulted:() => faulted, checkpoint:() => ({}), resume() {},
      restore:async () => { faulted = false; }, install:async () => { faulted = false; }},
    representation:{ref:'base', cell:{status:'ok'}}, plugin:{state:{data:{cells:new Map()}}},
    canvas:{webgl:{isContextLost:false}, xr:{isPresenting:{value:true}}, commit() {}},
    restoreInspectionPayload() {}, applyInspectionAppearance:async () => {}, applyInspectionTransform() {},
    // A faulted animation fails every frame wait with its fault.
    waitForFrame:async () => { if (faulted && frameFailsWhileFaulted) throw Error('Broken animation endpoint'); },
    assertContext() {},
  });
  c.plugin.state.data.cells.set('base', c.representation.cell);
  // Whatever helpers the page's recovery calls run here too.
  vm.runInContext(['inspectionMutation', 'redrawRestoredScene', 'unrestoredComponents']
    .filter(name => source.includes(`function ${name}(`)).map(name => pageFunction(source, name)).join('\n'), c);
  return {c, costs, saved, shown:() => shown, payload:() => payload, settles:() => settles};
}

test('a figure restore that fails once is retried after animation work stops, and the viewer draws ready', async () => {
  const h = failedChange({figureFailures:1});
  await assert.rejects(h.c.inspectionMutation(async () => {}), {message:surroundings});
  assert.equal(h.c.state.status, 'ready'); assert.equal(h.c.state.error, null); assert.equal(h.c.busy, false);
  assert.deepEqual(h.shown(), h.saved, 'the saved figure is back');
  assert.ok(h.settles() >= 1, 'the retry waited for animation work to land');
  assert.deepEqual(h.costs.filter(cost => cost.kind === 'scene-recovery').map(cost => cost.attempt), ['settled']);
});

test('a figure that cannot be restored stays in error rather than drawing a scene without it', async () => {
  const h = failedChange({figureFailures:Infinity});
  await assert.rejects(h.c.inspectionMutation(async () => {}), {message:surroundings});
  assert.equal(h.c.state.status, 'error'); assert.match(h.c.state.error, /surroundings changed/);
  assert.deepEqual(h.payload().lessonFigure, h.saved, 'the saved payload still claims the figure, for the page to reload');
  assert.deepEqual(h.costs.filter(cost => cost.kind === 'scene-recovery'), []);
});

test('a frame drawn without the restored figure is not a recovery, even when the frame itself draws', async () => {
  const h = failedChange({figureFailures:Infinity, frameFailsWhileFaulted:false});
  await assert.rejects(h.c.inspectionMutation(async () => {}), {message:surroundings});
  assert.equal(h.c.state.status, 'error');
  assert.match(h.c.state.error, /restoring the previous scene failed/);
  assert.equal(h.shown(), undefined, 'no figure is drawn');
  assert.deepEqual(h.costs.filter(cost => cost.kind === 'scene-recovery'), []);
});

test('a first redraw missing its figure is retried, and the retry that brings it back reports ready', async () => {
  const h = failedChange({figureFailures:1, frameFailsWhileFaulted:false});
  await assert.rejects(h.c.inspectionMutation(async () => {}), {message:surroundings});
  assert.equal(h.c.state.status, 'ready'); assert.equal(h.c.state.error, null);
  assert.deepEqual(h.shown(), h.saved, 'the saved figure is back');
  assert.ok(h.settles() >= 1, 'the retry waited for animation work to land');
  assert.deepEqual(h.costs.filter(cost => cost.kind === 'scene-recovery').map(cost => cost.attempt), ['settled']);
});
