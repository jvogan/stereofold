import { tetherCaption } from './tether-caption.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { isStereofoldAuxiliaryCell } from './representation-refs.mjs';
import { resolveFigureLoci } from './lesson-figure.mjs';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { animationBodiesVisible, animationEnvelope, createMolecularAnimation, poseMatrix, transformSphere } from './molecular-animation.mjs';
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
import { selectAnimationTrack } from './animation-selection.mjs';
const animation = {version:1, durationSeconds:2, playback:{autoplay:true,loop:true}, tracks:[{id:'cd',chains:['C','D'],keyframes:[
  {t:0,rotation:[0,0,0,1],translation:[0,0,0]},
  {t:2,rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],translation:[10,2,0]},
],visibility:[{t:.2,visible:false},{t:.4,visible:true}]}]};
test('internal serialization follows published controls while public captures stay detached', async t => {
  const h = await fixture(t);
  const encode = () => h.registry.serializeCapture(value => ({ inspection: { animation: value } }));
  assert.equal(encode(), '{"inspection":{}}');
  await h.registry.install(animation);
  const initial = encode();
  assert.equal(initial, JSON.stringify({ inspection: { animation: h.registry.capture() } }));
  const captured = h.registry.capture(); captured.definition.tracks[0].keyframes[0].translation[0] = 999;
  assert.equal(encode(), initial);
  h.registry.tick(0); h.registry.tick(500);
  assert.equal(encode(), initial, 'unpublished clock ticks do not dirty the shared scene');
  h.registry.control({ state: 'pause', seekSeconds: .5 });
  assert.notEqual(encode(), initial);
  assert.equal(encode(), JSON.stringify({ inspection: { animation: h.registry.capture() } }));
  h.registry.publish(undefined);
  assert.equal(encode(), '{"inspection":{}}');
});
import { molecularAnimationHarness as fixture } from './fixtures/molecular-animation-harness.mjs';
test('opening templates remain visible across every asynchronous body build until the posed handoff', async t => {
  const h = await fixture(t);
  const build = h.plugin.builders.structure.tryCreateComponentFromSelection.bind(h.plugin.builders.structure);
  let samples = 0;
  h.plugin.builders.structure.tryCreateComponentFromSelection = async (...args) => {
    // Sample the same asynchronous construction boundaries an XR frame can see.
    assert.equal(h.repr.state.visible, true, 'opening molecular template must still draw');
    assert.notEqual(h.plugin.state.data.cells.get(h.cell.ref).state.isHidden, true);
    h.registry.apply();
    assert.equal(h.repr.state.visible, true, 'input-frame apply must not retire a pending template');
    samples++;
    return build(...args);
  };
  await h.registry.install(animation, 'opening');
  assert.ok(samples >= 2);
  assert.equal(h.repr.state.visible, false);
  assert.ok(h.registry.representations().some(repr => repr.state.visible && repr.renderObjects.length));
  h.registry.tick(0); h.registry.tick(14);
  assert.ok(h.registry.snapshot().timeSeconds > 0);
});

test('a failed first body build keeps the opening template visible', async t => {
  const h = await fixture(t);
  h.plugin.builders.structure.tryCreateComponentFromSelection = async () => {
    assert.equal(h.repr.state.visible, true);
    throw Error('body build failed');
  };
  await assert.rejects(h.registry.install(animation), /body build failed/);
  assert.equal(h.repr.state.visible, true);
  assert.equal(h.registry.snapshot(), null);
});

test('1,000 real Mol* body ticks preserve mesh buffers, geometry versions, state cells and source bounds', async t => {
  const h=await fixture(t); const sphere=structuredClone(h.structure.obj.data.boundary.sphere);
  await h.registry.install(animation);
  assert.equal(h.repr.state.visible,false,'the full-source duplicate is hidden');
  const bodies=h.registry.representations(); assert.equal(bodies.length,2);
  const cells=h.plugin.state.data.cells.size;
  for (const repr of bodies) {
    const cell=[...h.plugin.state.data.cells.values()].find(c=>c.obj?.data?.repr===repr);
    assert.ok(isStereofoldAuxiliaryCell(cell),'body geometry cannot replace the primary structure in the hierarchy');
  }
  const before=bodies.map(repr=>({version:repr.geometryVersion,objects:repr.renderObjects.map(o=>({id:o.id,vertices:o.values.aPosition?.ref.value,version:o.values.aPosition?.ref.version}))}));
  h.registry.tick(0);
  for(let i=1;i<=1000;i++) h.registry.tick(i*13.89);
  assert.equal(h.plugin.state.data.cells.size,cells);
  for(const [i,repr] of bodies.entries()) {
    assert.equal(repr.geometryVersion,before[i].version);
    repr.renderObjects.forEach((o,j)=>{assert.equal(o.id,before[i].objects[j].id);assert.equal(o.values.aPosition?.ref.value,before[i].objects[j].vertices);assert.equal(o.values.aPosition?.ref.version,before[i].objects[j].version);});
  }
  const expected=Mat4.mul(Mat4(),h.presentation,poseMatrix(evaluateTrack(animation.tracks[0],h.registry.snapshot().timeSeconds)));
  bodies[0].state.transform.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-6));
  for (const object of bodies[0].renderObjects) for (let i=0;i<16;i++)
    assert.ok(Math.abs(object.values.aTransform.ref.value[i]-expected[i])<1e-4, 'actual render instance transform matches absolute evaluator');
  assert.deepEqual(h.structure.obj.data.boundary.sphere,sphere);
  assert.ok(h.stats().visibilitySyncs>2);
  assert.equal(h.costs.at(-1).geometryRebuilds,0);
  t.diagnostic(JSON.stringify(h.costs.at(-1)));
  await h.registry.refresh(); assert.equal(h.plugin.state.data.cells.size,cells);
  await h.registry.install(undefined); assert.equal(h.repr.state.visible,true);
  assert.equal(h.plugin.state.data.cells.size,cells-4);
});
test('unknown author chains are refused before replacing the installed animation',async t=>{
  const h=await fixture(t);await h.registry.install(animation);const id=h.registry.snapshot().id;
  await assert.rejects(h.registry.install({...animation,tracks:[{...animation.tracks[0],chains:['missing']}]}),/absent/);
  assert.equal(h.registry.snapshot().id,id);
});

test('appearance, emphasis, masks and ligand overlays propagate to every partition; attached annotations follow and reset',async t=>{
  const h=await fixture(t), loci=resolveFigureLoci({chain:'C'},h.structure.obj.data);
  const annotation={state:{visible:true},renderObjects:[],setState(patch){Object.assign(this.state,patch); if(patch.transform)this.state.transform=[...patch.transform];}};
  h.annotations.push({repr:annotation,loci});
  const component=await h.plugin.builders.structure.tryCreateComponentFromExpression(h.structure,
    (await import('./lesson-figure.mjs')).figureTargetExpression({chain:'D',componentId:'HEM'}),'test-ligand');
  const ligand=await h.plugin.builders.structure.representation.addRepresentation(component,{type:'ball-and-stick',color:'element-symbol'});
  h.representations.push(ligand.obj.data.repr);
  h.repr.setState({overpaint:{kind:'element-loci',layers:[{loci,color:0x00ff00,clear:false}]},
    transparency:{kind:'element-loci',layers:[{loci,value:.7}]}});
  await h.registry.install(animation);h.registry.tick(0);h.registry.tick(500);
  const expected=Mat4.mul(Mat4(),h.presentation,poseMatrix(evaluateTrack(animation.tracks[0],.5)));
  assert.deepEqual(annotation.state.transform,[...expected]);
  assert.deepEqual([...ligand.obj.data.repr.state.transform],[...expected]);
  const partitions=h.registry.representations();
  assert.equal(partitions[0].state.overpaint.layers[0].color,0x00ff00);
  assert.equal(partitions[0].state.transparency.layers[0].value,.7);
  assert.equal(partitions[1].state.overpaint.layers.length,0);
  // A live explicit emphasis replaces the chapter's layers while the clock runs.
  h.repr.setState({overpaint:{kind:'element-loci',layers:[{loci,color:0xff8800,clear:false}]},
    transparency:{kind:'element-loci',layers:[{loci,value:.18}]}});
  await h.registry.refresh();
  for (let i=1;i<=10;i++) h.registry.tick(500+i*14);
  assert.equal(h.registry.snapshot().state,'playing');
  assert.ok(h.registry.snapshot().timeSeconds>.5);
  assert.equal(h.registry.representations()[0].state.overpaint.layers[0].color,0xff8800);
  assert.equal(h.registry.representations()[0].state.transparency.layers[0].value,.18);
  const count=h.plugin.state.data.cells.size;
  await h.plugin.build().to(h.cell).update(params=>({...params,type:{...params.type,params:{...params.type.params,alpha:.4}},colorTheme:{name:'uniform',params:{value:0xff0000}}})).commit();
  await h.registry.refresh();
  assert.equal(h.plugin.state.data.cells.size,count);
  assert.ok(h.registry.representations().every(repr=>repr.props.alpha===.4));
  h.registry.tick(750);assert.ok(h.registry.owns(ligand.obj.data.repr));
  await h.registry.install(undefined);
  assert.deepEqual(annotation.state.transform,[...h.presentation]);
  assert.deepEqual([...ligand.obj.data.repr.state.transform],[...h.presentation]);
});
test('source disposal cancels queued installs and releases all body components',async t=>{
  const h=await fixture(t), cells=h.plugin.state.data.cells.size;
  const pending=h.registry.install(animation), forgotten=h.registry.forget();
  await Promise.all([pending,forgotten]);assert.equal(h.registry.snapshot(),null);assert.equal(h.plugin.state.data.cells.size,cells);
  await h.registry.install(animation);await h.registry.forget();
  assert.equal(h.registry.snapshot(),null);assert.equal(h.plugin.state.data.cells.size,cells);
});

test('one body owning the whole file can be hidden, sought backwards and removed without changing the source',async t=>{
  const h=await fixture(t);
  await h.registry.install({...animation,tracks:[{...animation.tracks[0],chains:['A','B','C','D']}]});
  assert.equal(h.registry.representations().length,1);
  h.registry.control({state:'pause',seekSeconds:.3});
  assert.equal(h.registry.representations()[0].state.visible,false);
  assert.ok(h.registry.drawn(new Set(h.registry.representations()[0].renderObjects)));
  h.registry.control({seekSeconds:0});assert.equal(h.registry.representations()[0].state.visible,true);
  assert.deepEqual([...h.registry.representations()[0].state.transform],[...h.presentation]);
  await h.registry.forget();assert.equal(h.repr.state.visible,true);
});

test('focus follows cached selection bounds while Fit retains one conservative envelope across playback', async t => {
  const h = await fixture(t);
  await h.registry.install(animation);
  const envelope = h.registry.envelope();
  const loci = resolveFigureLoci({chain:'C'}, h.structure.obj.data);
  const deposited = StructureElement.Loci.getBoundingSphere(loci);
  const measure = StructureElement.Loci.getBoundingSphere;
  let measurements = 0;
  StructureElement.Loci.getBoundingSphere = (...args) => { measurements++; return measure(...args); };
  try {
    for (const time of [0,.5,1,1.5,2,.5]) {
      h.registry.control({state:'pause',seekSeconds:time});
      const sphere = h.registry.selectionSphere(loci);
      const expected = transformSphere(deposited, poseMatrix(evaluateTrack(animation.tracks[0],time)));
      assert.ok(Vec3.distance(sphere.center,expected.center) < 1e-8);
      assert.ok(Math.abs(sphere.radius - expected.radius) < 1e-8);
      assert.equal(h.registry.envelope(),envelope,'Fit does not depend on the current time');
    }
    assert.equal(measurements,1,'the same selection is measured once, outside the frame loop');
  } finally { StructureElement.Loci.getBoundingSphere = measure; }
  // Every body, including static chains and intermediate rotation arcs, fits.
  for (let time=0; time<=2; time+=.025) {
    h.registry.control({state:'pause',seekSeconds:time});
    for (const chain of ['A','B','C','D']) {
      const sphere = h.registry.selectionSphere(resolveFigureLoci({chain},h.structure.obj.data));
      assert.ok(Vec3.distance(sphere.center,envelope.center)+sphere.radius <= envelope.radius+1e-6);
    }
  }
  const mixed = h.registry.selectionSphere(StructureElement.Loci.union(loci,resolveFigureLoci({chain:'A'},h.structure.obj.data)));
  assert.ok(mixed.radius > 0);
  await h.registry.install(undefined); assert.equal(h.registry.envelope(),undefined);
  assert.deepEqual(h.registry.selectionSphere(loci),deposited);
});

test('drawn bounds pose each body now, drop a body its track hides, and measure atoms once', async t => {
  const h = await fixture(t);
  const all = StructureElement.Loci.all(h.structure.obj.data);
  assert.equal(h.registry.drawnSphere(all), undefined, 'no animation, no posed bounds');
  await h.registry.install(animation);
  const geometry = () => h.registry.representations().map(repr => [repr.geometryVersion,
    ...repr.renderObjects.map(object => [object.id, object.values.aPosition?.ref.version])]);
  const body = StructureElement.Loci.union(resolveFigureLoci({chain:'C'}, h.structure.obj.data), resolveFigureLoci({chain:'D'}, h.structure.obj.data));
  const moving = StructureElement.Loci.getBoundingSphere(body);
  const still = StructureElement.Loci.getBoundingSphere(StructureElement.Loci.subtract(all, body));
  // The same box-of-spheres union the registry takes of its parts.
  const enclose = (a, b) => {
    const center = [0, 1, 2].map(i => (Math.min(a.center[i] - a.radius, b.center[i] - b.radius) + Math.max(a.center[i] + a.radius, b.center[i] + b.radius)) / 2);
    return { center, radius: Math.max(Vec3.distance(center, a.center) + a.radius, Vec3.distance(center, b.center) + b.radius) };
  };
  const measure = StructureElement.Loci.getBoundingSphere;
  let measurements = 0;
  StructureElement.Loci.getBoundingSphere = (...args) => { measurements++; return measure(...args); };
  try {
    for (const time of [0, .1, .3, 1, 1.5, 2]) {
      h.registry.control({state:'pause', seekSeconds:time});
      // Chains C and D are the moving body, hidden from 0.2 s to 0.4 s; the
      // rest of hemoglobin stays where it was deposited.
      const expected = time > .2 && time < .4 ? still
        : enclose(still, transformSphere(moving, poseMatrix(evaluateTrack(animation.tracks[0], time))));
      const sphere = h.registry.drawnSphere(all);
      assert.ok(Vec3.distance(sphere.center, expected.center) < 1e-6, `drawn centre at ${time} s`);
      assert.ok(Math.abs(sphere.radius - expected.radius) < 1e-6, `drawn radius at ${time} s`);
    }
    measurements = 0;
    const built = JSON.stringify(geometry()), updates = h.stats().updates;
    for (let tick = 0; tick < 50; tick++) h.registry.drawnSphere(all);
    assert.equal(measurements, 0, 'a known loci only re-poses its cached body bounds');
    assert.equal(JSON.stringify(geometry()), built, 'reading the drawn bounds rebuilds nothing');
    assert.equal(h.stats().updates, updates, 'reading the drawn bounds draws nothing');
  } finally { StructureElement.Loci.getBoundingSphere = measure; }
});

test('appearance replacement keeps old posed partitions until all hidden replacements are ready', async t => {
  const h = await fixture(t); await h.registry.install(animation);
  h.registry.tick(0); h.registry.tick(500);
  const old = h.registry.representations(), oldRoots = [...h.plugin.state.data.cells.values()]
    .filter(c=>old.includes(c.obj?.data?.repr)).map(c=>c.transform.parent);
  const params = createStructureRepresentationParams(h.plugin,h.structure.obj.data,
    {type:'ball-and-stick',color:'uniform',colorParams:{value:0xff0000},typeParams:{quality:'low'}});
  const incoming = await h.plugin.build().to(h.structure)
    .apply(StateTransforms.Representation.StructureRepresentation3D,params,{state:{isHidden:true}}).commit();
  const loci = resolveFigureLoci({chain:'C'},h.structure.obj.data);
  incoming.obj.data.repr.setState({overpaint:{kind:'element-loci',layers:[{loci,color:0x00ff00,clear:false}]},
    transparency:{kind:'element-loci',layers:[{loci,value:1}]}});
  h.representations.splice(0,1,incoming.obj.data.repr);
  const build = h.plugin.builders.structure.tryCreateComponentFromSelection;
  let reached, release, calls=0;
  const waiting = new Promise(resolve=>{reached=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  h.plugin.builders.structure.tryCreateComponentFromSelection = async (...args) => {
    if (++calls===2) { reached(); await gate; }
    return build.apply(h.plugin.builders.structure,args);
  };
  const pending = h.registry.refresh();
  try {
    await waiting;
    assert.deepEqual(h.registry.representations(),old);
    assert.ok(oldRoots.every(ref=>h.plugin.state.data.cells.has(ref)));
    assert.ok(old.every(repr=>repr.state.visible));
    assert.equal(h.repr.state.visible,false);
    assert.equal(incoming.obj.data.repr.state.visible,false);
    const staging = [...h.plugin.state.data.cells.values()].filter(c => c.obj?.data?.repr
      && c.transform.tags?.includes('stereofold-molecular-animation') && !old.includes(c.obj.data.repr));
    assert.equal(staging.length,1);
    assert.equal(staging[0].obj.data.repr.state.visible,false);
    h.registry.tick(750);
    assert.equal(staging[0].obj.data.repr.state.visible,false,'ticks cannot reveal a partial replacement');
  } finally { release(); h.plugin.builders.structure.tryCreateComponentFromSelection=build; }
  await pending;
  const bodies=h.registry.representations();
  assert.ok(bodies.every(repr=>!old.includes(repr)));
  assert.ok(oldRoots.every(ref=>!h.plugin.state.data.cells.has(ref)));
  assert.equal(h.repr.state.visible,false,'outgoing unsplit template never reappears');
  assert.equal(incoming.obj.data.repr.state.visible,false);
  const expected=Mat4.mul(Mat4(),h.presentation,poseMatrix(evaluateTrack(animation.tracks[0],.75)));
  assert.deepEqual([...bodies[0].state.transform],[...expected]);
  assert.equal(bodies[0].state.overpaint.layers[0].color,0x00ff00);
  assert.equal(bodies[0].state.transparency.layers[0].value,1);
  await h.registry.install(undefined);
  assert.equal(incoming.obj.data.repr.state.visible,true,'clearing motion restores the replacement template');
});

test('chapter emphasis, visibility and replacement labels propagate after animation installation without body rebuilds', async t => {
  const h=await fixture(t); await h.registry.install(animation);
  h.registry.tick(0); h.registry.tick(500);
  const bodies=h.registry.representations(), versions=bodies.map(repr=>repr.geometryVersion);
  const loci=resolveFigureLoci({chain:'C'},h.structure.obj.data), bundle=StructureElement.Bundle.fromLoci(loci);
  const paint=await h.plugin.build().to(h.cell).apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle,
    {layers:[{bundle,color:0xff6600,clear:false}]}).commit();
  const mask=await h.plugin.build().to(h.cell).apply(StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle,
    {layers:[{bundle,value:1}]}).commit();
  const label=()=>({state:{visible:true},renderObjects:[],setState(patch){Object.assign(this.state,patch);if(patch.transform)this.state.transform=[...patch.transform];}});
  const first=label(); h.annotations.push({repr:first,loci});
  await h.registry.refresh();
  assert.equal(bodies[0].state.overpaint.layers[0].color,0xff6600);
  assert.equal(bodies[0].state.transparency.layers[0].value,1);
  const replacement=label(); h.annotations.splice(0,1,{repr:replacement,loci});
  await h.plugin.build().to(paint).update({layers:[{bundle,color:0x3366ff,clear:false}]}).commit();
  await h.plugin.build().to(mask).update({layers:[]}).commit();
  await h.registry.refresh();
  assert.deepEqual(h.registry.representations(),bodies);
  assert.deepEqual(bodies.map(repr=>repr.geometryVersion),versions);
  assert.equal(bodies[0].state.overpaint.layers[0].color,0x3366ff);
  assert.equal(bodies[0].state.transparency.layers.length,0);
  assert.equal(bodies[1].state.overpaint.layers.length,0);
  assert.deepEqual(replacement.state.transform,[...bodies[0].state.transform]);
  assert.equal(h.registry.owns(first),false);
  assert.equal(h.registry.owns(replacement),true);
});

test('XR samples once after placement and before both eyes, with the independent scheduler desktop-only', async t => {
  let immersive=false, sequence=0;
  const desktop=new Map(), callbacks=[], order=[];
  const h=await fixture(t,{isImmersive:()=>immersive,
    schedule:callback=>{desktop.set(++sequence,callback);return sequence;},cancel:id=>desktop.delete(id)});
  await h.registry.install(animation); assert.equal(desktop.size,1);
  immersive=true; h.registry.reanchor(); assert.equal(desktop.size,0);
  const viewer=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const sessionSource=readFileSync(new URL('./immersive-session.mjs',import.meta.url),'utf8');
  const context=vm.createContext({
    latestXrSpace:undefined, xrInputHeadInRoom:undefined, canvas:{webgl:{xr:{}},camera:{view:Mat4.identity()}},
    Mat4, XRRigidTransform:class {}, capDrawnPlates(){}, recordCost(_kind,error){throw Error(JSON.stringify(error));},
    naturalInput:{frame(){order.push('input');}}, xrControllerInput:{read:()=>[]},
    processXrPointers(){order.push('placement'); Mat4.setTranslation(h.presentation,[sequence,4,5]);},
    flushXrDeferredGrab(){order.push('flush');},
    molecularAnimation:{tick(time){order.push('pose');h.registry.tick(time);}, tetherRepresentations:()=>[]},
    lessonFigure:{annotations:()=>[]}, sizeImmersiveAnnotation(){}, plateEyeInSource:()=>undefined,
    recordXrFrameError(_phase,error){throw error;},
  });
  const from=viewer.indexOf('      onInputFrame:');
  const onInputFrame=vm.runInContext('({'+viewer.slice(from,viewer.indexOf('      onHeadFrame:',from))+'}).onInputFrame',context);
  const start=sessionSource.indexOf('function installHeadFrameObserver(');
  vm.runInContext(sessionSource.slice(start,sessionSource.indexOf('\n}\n',start)+3),context);
  const session={requestAnimationFrame(callback){callbacks.push(callback);return callbacks.length;}};
  context.installHeadFrameObserver({session,space:{getOffsetReferenceSpace:()=>({})},mode:'immersive-vr',onInputFrame});
  for (const time of [100,600,1100]) {
    sequence++;
    session.requestAnimationFrame(()=>{});
    session.requestAnimationFrame(()=>{
      const expected=Mat4.mul(Mat4(),h.presentation,poseMatrix(evaluateTrack(animation.tracks[0],(time-100)/1000)));
      for (const eye of ['left','right']) {
        order.push(eye);
        assert.deepEqual([...h.registry.representations()[0].state.transform],[...expected]);
      }
    });
    session.requestAnimationFrame(()=>{});
    const frame={getViewerPose:()=>undefined};
    callbacks.splice(0).forEach(callback=>callback(time,frame));
  }
  assert.deepEqual(order,Array(3).fill(['input','placement','flush','pose','left','right']).flat());
  assert.equal(desktop.size,0,'no duplicate animation scheduler runs in XR');
  immersive=false; h.registry.reanchor(); assert.equal(desktop.size,1);
  const callback=[...desktop.values()][0]; desktop.clear();callback(2000);
  assert.equal(desktop.size,1,'desktop schedules its next frame');
  const resumedTime=h.registry.snapshot().timeSeconds;
  const nextCallback=[...desktop.values()][0]; desktop.clear();nextCallback(2200);
  assert.ok(Math.abs(h.registry.snapshot().timeSeconds-resumedTime-.2)<1e-8,
    'the molecular clock advances on desktop frames after leaving XR');
  // Starting playback while already immersed never registers another RAF.
  immersive=true;h.registry.reanchor();await h.registry.install(animation);
  assert.equal(desktop.size,0);
});

test('a delivered desktop frame clears its diagnostic handle without retiring a newer schedule', async t => {
  let immersive=false, sequence=0;
  const desktop=new Map();
  const h=await fixture(t,{isImmersive:()=>immersive,
    schedule:callback=>{desktop.set(++sequence,callback);return sequence;},cancel:id=>desktop.delete(id)});
  await h.registry.install(animation);
  const cancelled=[...desktop.values()][0];
  h.registry.reanchor();
  assert.equal(desktop.size,1);
  cancelled(100);
  assert.equal(h.registry.activity().scheduled,true,'an old callback cannot clear the current handle');
  assert.equal(desktop.size,1);
  // The runtime may enter XR before the presenting subscriber cancels the
  // pending window frame. That delivered frame is consumed even without a tick.
  immersive=true;
  const delivered=[...desktop.values()][0]; desktop.clear();delivered(200);
  assert.equal(h.registry.activity().scheduled,false,'a consumed frame is no longer pending');
  assert.equal(h.registry.activity().frameSamples,0,'the desktop callback does not tick inside XR');
  assert.equal(h.registry.snapshot().timeSeconds,0);
  assert.equal(desktop.size,0);
});

test('new authored figure labels attach to their moving body after a chapter change', async t => {
  const { createLessonFigure } = await import('./lesson-figure.mjs');
  const { setCanvasModule } = await import('molstar/lib/mol-geo/geometry/text/font-atlas.js');
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  let annotations=()=>[];
  const h=await fixture(t,{getAnnotations:()=>annotations()});
  h.plugin.canvas3d={xr:{isPresenting:{value:false}},update(){},add(){},remove(){},mark(){},syncVisibility(){},getRenderObjects:()=>[]};
  const figure=createLessonFigure({plugin:h.plugin,getStructure:()=>h.structure,getTransform:()=>h.presentation});
  const viewer=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const start=viewer.indexOf('    getAnnotations: () => {');
  const end=viewer.indexOf('    // Immersion uses',start);
  annotations=vm.runInNewContext('({'+viewer.slice(start,end)+'}).getAnnotations',
    {plugin:h.plugin,componentLabelRepresentations:()=>[],lessonFigure:figure,StructureElement});
  const chapter=text=>({layers:[{id:'head',target:{chain:'C'},representation:'cartoon',color:'#ffffff',opacity:1}],
    labels:[{id:'name',text,target:{chain:'C'},color:'#ffffff',offsetX:0,offsetY:0,sizeFactor:1}],distances:[]});
  try {
    await figure.install(chapter('First chapter'));
    h.representations.push(...figure.molecular());
    await h.registry.install(animation); h.registry.tick(0); h.registry.tick(500);
    const first=figure.annotations()[0];assert.ok(h.registry.owns(first));
    await figure.install(chapter('Second chapter'));
    h.representations.splice(1,Infinity,...figure.molecular());
    await h.registry.refresh();
    const next=figure.annotations()[0];
    assert.notEqual(next,first);assert.equal(h.registry.owns(first),false);assert.ok(h.registry.owns(next));
    assert.ok(next.renderObjects.some(object=>object.values.drawCount.ref.value>0));
    assert.deepEqual([...next.state.transform],[...h.registry.representations()[0].state.transform]);
    h.registry.tick(750);
    assert.deepEqual([...next.state.transform],[...h.registry.representations()[0].state.transform]);
  } finally {
    await h.registry.forget();await figure.forget();h.plugin.canvas3d=undefined;
  }
});

test('real Mol* tethers follow independent atoms and midpoint through ticks without changing geometry', async t => {
  const { setCanvasModule } = await import('molstar/lib/mol-geo/geometry/text/font-atlas.js');
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const h = await fixture(t), initialCells = h.plugin.state.data.cells.size;
  const tether = {id:'dimer',from:{chain:'C',residue:1,atom:'CA'},to:{chain:'A',residue:1,atom:'CA'},label:'Dimer',color:'#ffcc00'};
  const definition = {...animation,tracks:[animation.tracks[0],{id:'a',chains:['A'],keyframes:[
    {t:0,rotation:[0,0,0,1],translation:[0,0,0]},
    {t:2,rotation:[Math.SQRT1_2,0,0,Math.SQRT1_2],translation:[-20,0,5]},
  ],visibility:[{t:.6,visible:false},{t:.8,visible:true}]}],tethers:[tether,{id:'static',from:tether.from,to:{...tether.to,chain:'B'}}]};
  await h.registry.install(definition);
  const [line,label,staticLine] = [...h.manual];
  assert.equal(h.manual.size,3); assert.ok([...h.manual].every(repr => h.registry.owns(repr)));
  assert.equal(h.registry.extraCount(),6);
  assert.ok(h.registry.drawn(new Set(h.registry.representations().flatMap(repr => repr.renderObjects))));
  const cells = h.plugin.state.data.cells.size;
  const geometry = [...h.manual].map(repr => ({repr,version:repr.geometryVersion,objects:repr.renderObjects.map(object => ({
    object, buffers:Object.entries(object.values).filter(([key,cell]) => /^a(Start|End|Position|Mapping|Group|Scale|Cap|Center|TexCoord|Depth)$|^elements$/.test(key) && cell?.ref)
      .map(([key,cell]) => ({key,value:cell.ref.value,version:cell.ref.version,copy:Array.from(cell.ref.value)})),
  }))}));
  const deposited = atom => StructureElement.Loci.getBoundingSphere(resolveFigureLoci({chain:atom.chain,residues:{from:atom.residue,to:atom.residue},atomName:atom.atom},h.structure.obj.data)).center;
  const a = deposited(tether.from), b = deposited(tether.to), c = deposited({...tether.to,chain:'B'});
  h.registry.tick(0);
  for (let i=0;i<=1000;i++) {
    Mat4.fromRotation(h.presentation, i * .002, [0, 1, 0]);
    Mat4.scale(h.presentation, h.presentation, [1 + i / 1000, 1 + i / 1000, 1 + i / 1000]);
    Mat4.setTranslation(h.presentation, [i / 100, 4, -5]);
    h.registry.tick(i*13.89);
    const time = h.registry.snapshot().timeSeconds;
    const from = Vec3.transformMat4(Vec3(),a,poseMatrix(evaluateTrack(definition.tracks[0],time)));
    const to = Vec3.transformMat4(Vec3(),b,poseMatrix(evaluateTrack(definition.tracks[1],time)));
    for (const [repr,local,expected] of [[line,[0,0,0],from],[line,[0,0,1],to],
      [label,[0,0,0],Vec3.lerp(Vec3(),from,to,.5)],[staticLine,[0,0,0],from],[staticLine,[0,0,1],c]]) {
      if (!repr.state.visible) continue; // Hidden tether transforms are deferred until reveal.
      const placed = Vec3.transformMat4(Vec3(),expected,h.presentation);
      if (repr === label) {
        const caption=tetherCaption(label);
        assert.ok(Vec3.distance(Vec3.lerp(Vec3(),caption.from,caption.to,.5),placed)<1e-8);
      }
      assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),local,repr.state.transform),placed)<1e-8);
      assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),local,repr.renderObjects[0].values.aTransform.ref.value),placed)<1e-4);
    }
    const visible = definition.tracks.every(track => evaluateTrack(track,time).visible);
    assert.equal(line.state.visible,visible); assert.equal(label.state.visible,visible);
    assert.equal(staticLine.state.visible,evaluateTrack(definition.tracks[0],time).visible);
  }
  for (const {repr,version,objects} of geometry) {
    assert.equal(repr.geometryVersion,version);
    objects.forEach(({object,buffers},i) => {
      assert.equal(repr.renderObjects[i],object);
      for (const {key,value,version,copy} of buffers) {
        assert.equal(object.values[key].ref.value,value); assert.equal(object.values[key].ref.version,version);
        assert.deepEqual(Array.from(value),copy);
      }
    });
  }
  assert.equal(h.plugin.state.data.cells.size,cells); assert.equal(h.costs.at(-1).geometryRebuilds,0);
  h.registry.control({state:'pause',seekSeconds:.7}); assert.equal(line.state.visible,false);
  h.registry.control({seekSeconds:0}); assert.equal(line.state.visible,true);
  Mat4.setTranslation(h.presentation,[9,-7,4]); h.registry.apply();
  assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),[0,0,0],line.state.transform),Vec3.transformMat4(Vec3(),a,h.presentation))<1e-8);
  const loci = resolveFigureLoci({chain:'A'},h.structure.obj.data);
  h.repr.setState({transparency:{kind:'element-loci',layers:[{loci,value:1}]}});
  await h.registry.refresh(); assert.equal(line.state.visible,false); assert.equal(label.state.visible,false);
  assert.equal(staticLine.state.visible,true); assert.deepEqual([...h.manual],[line,label,staticLine]);
  h.repr.setState({transparency:{kind:'element-loci',layers:[]}}); await h.registry.refresh(); assert.equal(line.state.visible,true);
  await h.registry.install(undefined);
  assert.equal(h.manual.size,0); assert.equal(h.plugin.state.data.cells.size,initialCells);
  assert.equal(h.registry.owns(line),false); assert.ok(geometry.every(g => g.objects.every(({object}) => object.state.disposed)));
  await h.registry.install(definition); await h.registry.forget(); assert.equal(h.manual.size,0);
});

test('tether source validation refuses missing atoms and body ownership before changing the live chapter', async t => {
  const h = await fixture(t); await h.registry.install(animation);
  const id = h.registry.snapshot().id, cells = h.plugin.state.data.cells.size;
  const tether = {id:'dimer',from:{chain:'C',residue:1,atom:'CA'},to:{chain:'A',residue:1,atom:'CA'}};
  for (const to of [{...tether.to,chain:'missing'},{...tether.to,residue:9999},{...tether.to,atom:'MISSING'},
    {...tether.to,chain:'D'}]) {
    await assert.rejects(h.registry.install({...animation,tethers:[{...tether,to}]}),/exactly one atom|different bodies/);
    assert.equal(h.registry.snapshot().id,id); assert.equal(h.plugin.state.data.cells.size,cells);
  }
  await assert.rejects(h.registry.install({...animation,tethers:[tether,tether]}),/unique/);
  await assert.rejects(h.registry.install({...animation,tethers:Array(17).fill(tether)}),/16/);
});

test('shared revision playback reconciles a follower and captures stay stable between ticks', async t => {
  const cleanups = [[],[]];
  t.after(async()=>{for (const group of cleanups.toReversed()) for (const cleanup of group) await cleanup();});
  const leader = await fixture({after:fn=>cleanups[0].push(fn)}), follower = await fixture({after:fn=>cleanups[1].push(fn)});
  await leader.registry.install(animation, 'walk');
  // A joining panel installs the same definition and chapter from the scene.
  const transported = leader.registry.capture();
  transported.definition = Object.fromEntries(Object.entries(transported.definition).reverse());
  await follower.registry.restore(transported);
  for (const patch of [{state:'pause',seekSeconds:1.3,speed:.5,loop:false},
    {state:'play',restart:true,speed:2,loop:true}]) {
    leader.registry.control(patch);
    const shared = leader.registry.capture();
    await follower.registry.restore(shared);
    assert.deepEqual(follower.registry.snapshot(), leader.registry.snapshot());
    const now = performance.now(); follower.registry.tick(now); follower.registry.tick(now + 100);
    assert.deepEqual(follower.registry.capture(), shared, 'ticks do not dirty the shared revision');
  }
  const wrong = follower.registry.capture(); wrong.playback.id = 'other';
  await assert.rejects(follower.registry.restore(wrong), /identity/);
});

test('visibility suspension preserves explicit animation intent independently of tour autoplay', async t => {
  const h = await fixture(t); await h.registry.install(animation, 'walk');
  h.registry.control({state:'pause',seekSeconds:1});
  h.registry.suspend(true); h.registry.tick(10000); h.registry.suspend(false); h.registry.tick(20000);
  assert.equal(h.registry.snapshot().state, 'paused'); assert.equal(h.registry.snapshot().timeSeconds, 1);
  h.registry.control({state:'play'}); h.registry.suspend(true);
  h.registry.tick(30000); const held = h.registry.snapshot().timeSeconds;
  h.registry.suspend(false); h.registry.tick(40000); h.registry.tick(40100);
  assert.ok(Math.abs(h.registry.snapshot().timeSeconds - held - .1) < 1e-8);
  h.registry.suspend(true); h.registry.control({state:'pause'}); h.registry.suspend(false);
  assert.equal(h.registry.snapshot().state, 'paused');
});

test('cancelled controls restore clock identity and playback before releasing the cancellation fence', async t => {
  const {interruptibleCommand} = await import('../inspection/interruptible-command.mjs');
  const h = await fixture(t); await h.registry.install(animation, 'walk');
  h.registry.control({state:'pause',seekSeconds:.5,speed:.5,loop:false});
  const before = h.registry.snapshot(), saved = h.registry.capture(); let released = false;
  const viewer = {snapshot:()=>({}), inspection:{capture:()=>({}), restore:async()=>{},
    checkpointMolecularAnimation:()=>h.registry.checkpoint(),
    restoreMolecularAnimation:async checkpoint=>{await h.registry.restore(checkpoint,true); assert.deepEqual(h.registry.snapshot(),before);},
  }};
  await assert.rejects(interruptibleCommand(viewer,async()=>{},async()=>{
    h.registry.control({seekSeconds:1.5,speed:3,loop:true,state:'play'});
    throw Object.assign(Error('cancelled'),{code:'superseded'});
  },()=>{assert.deepEqual(h.registry.snapshot(),before);released=true;}), /cancelled/);
  assert.ok(released); assert.deepEqual(h.registry.capture(),saved);
  viewer.inspection.restoreMolecularAnimation=async()=>{throw Error('draw failed');}; released=false;
  await assert.rejects(interruptibleCommand(viewer,async()=>{},async()=>{throw Object.assign(Error('cancelled'),{code:'superseded'});},()=>{released=true;}),{code:'rollback_failed'});
  assert.equal(released,false);
});

test('tethers use effective endpoint opacity and skip hidden and unchanged transform work', async t => {
  const h = await fixture(t);
  await h.registry.install({...animation, tethers:[{id:'link',label:'Link',from:{chain:'C',residue:1,atom:'CA'},to:{chain:'A',residue:1,atom:'CA'}}]});
  h.registry.control({state:'pause',seekSeconds:0});
  const [line,label] = [...h.manual], before = h.stats().updates;
  for(let i=0;i<100;i++) h.registry.apply();
  assert.equal(h.stats().updates,before);
  await h.plugin.build().to(h.cell).update(params=>({...params,type:{...params.type,params:{...params.type.params,alpha:0}}})).commit();
  await h.registry.refresh();
  assert.ok(h.registry.representations().filter(repr=>!h.manual.has(repr)).every(repr=>repr.props.alpha===0 && repr.state.alphaFactor===1));
  assert.equal(line.state.visible,false); assert.equal(label.state.visible,false);
  const matrix = [...line.state.transform], labelMatrix = [...label.state.transform];
  h.registry.control({seekSeconds:1});
  assert.deepEqual([...line.state.transform],matrix); assert.deepEqual([...label.state.transform],labelMatrix);
  await h.plugin.build().to(h.cell).update(params=>({...params,type:{...params.type,params:{...params.type.params,alpha:.5}}})).commit();
  await h.registry.refresh(); assert.equal(line.state.visible,true); assert.equal(label.state.visible,true);
  assert.notDeepEqual([...line.state.transform],matrix);
});

test('live grip translation, rotation and scale compose with advancing bodies during a chapter mutation', async t => {
  const { tourFocusHarness } = await import('./fixtures/tour-focus-harness.mjs');
  const { pageFunction } = await import('./fixtures/label-action-harness.mjs');
  const { clampPlacementScale, PLACEMENT_MAX_TRANSLATION } = await import('./placement-limits.mjs');
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const c = tourFocusHarness().h;
  Object.assign(c, { GRABBABLE_STATUS: new Set(['ready', 'mutating']), appearanceWork: {}, chapterInteractionDepth: 1,
    clampPlacementScale, PLACEMENT_MAX_TRANSLATION, xrTransformBatchDepth: 0, motionAngle: 0 });
  for (const name of ['canManipulateNow', 'applyGrabDelta', 'grabTransform', 'presentationTransform'])
    vm.runInContext(pageFunction(viewer, name), c);
  // Use the viewer's actual clock admission, including a draw/save in progress.
  const canTick = vm.runInContext(viewer.match(/canTick: (.*),\n/)[1], c);
  const h = await fixture(t, { canTick, cachePresentation: true, getTransform: () => c.presentationTransform() });
  c.applyInspectionTransform = () => h.registry.apply({ presentation: c.presentationTransform() });
  await h.registry.install(animation);
  const loci = resolveFigureLoci({ chain: 'C' }, h.structure.obj.data);
  const label = { state: {}, renderObjects: [], setState(patch) { Object.assign(this.state, patch); } };
  h.annotations.push({ repr: label, loci }); await h.registry.refresh();
  const versions = h.registry.representations().map(r => r.geometryVersion);
  c.state.status = 'mutating'; c.wearerPlacement.takeover('grab');
  h.registry.tick(0);
  for (let i = 1; i <= 60; i++) {
    c.applyGrabDelta({ translation: [.001, .002, -.003], scale: 1.002,
      rotation: Mat4.fromRotation(Mat4(), .01, [0, 1, 0]) });
    h.registry.tick(i * 16);
  }
  assert.ok(h.registry.snapshot().timeSeconds > .9, 'grip and save do not reanchor molecular time');
  assert.equal(h.registry.snapshot().state, 'playing');
  assert.deepEqual(h.registry.representations().map(r => r.geometryVersion), versions);
  const expected = Mat4.mul(Mat4(), c.presentationTransform(), poseMatrix(evaluateTrack(animation.tracks[0], h.registry.snapshot().timeSeconds)));
  h.registry.representations()[0].state.transform.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6));
  assert.deepEqual(label.state.transform, [...h.registry.representations()[0].state.transform]);
  assert.equal(h.costs.at(-1).geometryRebuilds, 0);
});

const domainAnimation = () => ({version:1,durationSeconds:2,playback:{autoplay:true},tracks:[{
  id:'hinge',chains:['A'],selector:{residues:[{from:1,to:60}]},pivot:[10,-5,3],
  keyframes:[{t:0,rotation:[0,0,0,1],translation:[0,0,0]},
    {t:2,rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],translation:[4,2,0]}],
}]});

test('residues 1–60 alone move about a pivot; residue labels and same-chain tethers follow, with zero playback rebuilds and full leave restoration',async t=>{
  const h=await fixture(t), value=domainAnimation(), source=h.structure.obj.data;
  const cells=h.plugin.state.data.cells.size;
  const selected=resolveFigureLoci({chain:'A',residues:{from:1,to:60}},source);
  const makeLabel=()=>({state:{visible:true},renderObjects:[],setState(p){Object.assign(this.state,p);if(p.transform)this.state.transform=[...p.transform];}});
  const movingLabel=makeLabel(), staticLabel=makeLabel();
  h.annotations.push({repr:movingLabel,loci:resolveFigureLoci({chain:'A',residues:{from:30,to:30}},source)},
    {repr:staticLabel,loci:resolveFigureLoci({chain:'A',residues:{from:61,to:61}},source)});
  value.tethers=[{id:'hinge-link',from:{chain:'A',residue:30,atom:'CA'},to:{chain:'A',residue:61,atom:'CA'}}];
  await h.registry.install(value,'domain');
  const [moving,rest]=h.registry.representations().filter(r=>!h.manual.has(r));
  const dataOf=r=>[...h.plugin.state.data.cells.values()].find(c=>c.obj?.data?.repr===r).obj.data.sourceData;
  const moved=StructureElement.Loci.remap(StructureElement.Loci.all(dataOf(moving)),source);
  const remainder=StructureElement.Loci.remap(StructureElement.Loci.all(dataOf(rest)),source);
  assert.ok(StructureElement.Loci.areEqual(moved,selected));
  assert.equal(StructureElement.Loci.size(StructureElement.Loci.intersect(moved,remainder)),0);
  assert.equal(StructureElement.Loci.size(moved)+StructureElement.Loci.size(remainder),source.elementCount);
  assert.deepEqual(h.registry.snapshot().representationCounts,{molecular:2,moving:1,added:1,annotations:2,tethers:1});
  const versions=h.registry.representations().map(r=>r.geometryVersion);
  const buffers=h.registry.representations().flatMap(r=>r.renderObjects.map(o=>o.values.aPosition?.ref.value));
  const installedCells=h.plugin.state.data.cells.size;
  h.registry.tick(0);for(let i=1;i<=1000;i++)h.registry.tick(i*1.5);
  assert.equal(h.costs.at(-1).geometryRebuilds,0);
  assert.deepEqual(h.registry.representations().map(r=>r.geometryVersion),versions);
  h.registry.representations().flatMap(r=>r.renderObjects.map(o=>o.values.aPosition?.ref.value)).forEach((b,i)=>assert.equal(b,buffers[i]));
  assert.equal(h.plugin.state.data.cells.size,installedCells);
  h.registry.control({state:'pause',seekSeconds:2});
  const matrix=poseMatrix(evaluateTrack(value.tracks[0],2));
  assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),[11,-5,3],matrix),[14,-2,3])<1e-8);
  assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),[10,-5,3],matrix),[14,-3,3])<1e-8);
  const placed=Mat4.mul(Mat4(),h.presentation,matrix);
  assert.deepEqual([...moving.state.transform],[...placed]);
  assert.deepEqual(movingLabel.state.transform,[...placed]);
  assert.deepEqual(staticLabel.state.transform,[...h.presentation]);
  assert.deepEqual([...rest.state.transform],[...h.presentation]);
  const line=[...h.manual][0];
  const from=StructureElement.Loci.getBoundingSphere(resolveFigureLoci({chain:'A',residues:{from:30,to:30},atomName:'CA'},source)).center;
  const to=StructureElement.Loci.getBoundingSphere(resolveFigureLoci({chain:'A',residues:{from:61,to:61},atomName:'CA'},source)).center;
  assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),[0,0,0],line.state.transform),Vec3.transformMat4(Vec3(),from,placed))<1e-8);
  assert.ok(Vec3.distance(Vec3.transformMat4(Vec3(),[0,0,1],line.state.transform),Vec3.transformMat4(Vec3(),to,h.presentation))<1e-8);
  const envelope=h.registry.envelope();
  for(let time=0;time<=2;time+=.05){h.registry.control({seekSeconds:time});const sphere=h.registry.selectionSphere(selected);
    assert.ok(Vec3.distance(sphere.center,envelope.center)+sphere.radius<=envelope.radius+1e-6);}
  await h.registry.install(undefined);
  assert.equal(h.registry.snapshot(),null);assert.equal(h.registry.representations().length,0);
  assert.equal(h.repr.state.visible,true);assert.equal(h.plugin.state.data.cells.size,cells);
  assert.deepEqual(movingLabel.state.transform,[...h.presentation]);assert.equal(h.manual.size,0);
});

test('disjoint domains of one chain resolve; overlap, empty selections and component/range atom collisions preserve the active chapter',async t=>{
  const h=await fixture(t), value=domainAnimation();
  value.tracks.push({...value.tracks[0],id:'second',selector:{residues:[{from:61,to:100}]}});
  await h.registry.install(value);const before=h.registry.snapshot(),cells=h.plugin.state.data.cells.size;
  assert.equal(before.representationCounts.added,2);
  for(const selector of [{residues:[{from:60,to:100}]},{residues:[{from:9999,to:10000}]}]){
    const invalid=structuredClone(value);invalid.tracks[1].selector=selector;
    await assert.rejects(h.registry.install(invalid),/Overlapping atom ownership|selects no atoms/);
    assert.deepEqual(h.registry.snapshot(),before);assert.equal(h.plugin.state.data.cells.size,cells);
  }
  const invalid=domainAnimation();invalid.tracks[0].selector={residues:[{from:1,to:9999}]};
  invalid.tracks.push({...invalid.tracks[0],id:'heme',selector:{componentIds:['HEM']}});
  await assert.rejects(h.registry.install(invalid),/Overlapping atom ownership/);
  assert.deepEqual(h.registry.snapshot(),before);
  const union=domainAnimation();union.tracks[0].selector={residues:[{from:1,to:20},{from:40,to:60}],componentIds:['HEM']};
  await h.registry.install(union);
  assert.equal(h.registry.snapshot().representationCounts.moving,1);
  assert.equal(h.registry.snapshot().representationCounts.added,1);
});

test('domain split refuses more than one additional representation per selection before altering the chapter',async t=>{
  const h=await fixture(t);await h.registry.install(animation);const before=h.registry.snapshot();
  const extra=await h.plugin.builders.structure.representation.addRepresentation(h.structure,{type:'spacefill',color:'element-symbol'});
  h.representations.push(extra.obj.data.repr);
  await assert.rejects(h.registry.install(domainAnimation()),/would add 2 representations/);
  assert.deepEqual(h.registry.snapshot(),before);
  assert.equal(extra.obj.data.repr.state.visible,true);
});

test('residue-label geometry spanning a domain and static residue is partitioned once and follows each owner',async t=>{
  const h=await fixture(t);
  const component=await h.plugin.builders.structure.tryCreateComponentFromExpression(h.structure,
    (await import('./lesson-figure.mjs')).figureTargetExpression({chain:'A',residues:{from:60,to:61}}),'residue-labels');
  const label=await h.plugin.builders.structure.representation.addRepresentation(component,{type:'label',typeParams:{level:'residue'},color:'uniform'});
  const original=label.obj.data.repr;h.representations.push(original);
  const cells=h.plugin.state.data.cells.size;
  await h.registry.install(domainAnimation());
  assert.equal(h.registry.snapshot().representationCounts.added,1);
  assert.equal(h.registry.snapshot().representationCounts.annotations,2);
  const labels=h.registry.representations().filter(r=>[...h.plugin.state.data.cells.values()].some(c=>c.obj?.data?.repr===r&&c.params?.values?.type?.name==='label'));
  assert.equal(labels.length,2);const versions=labels.map(r=>r.geometryVersion);
  h.registry.control({state:'pause',seekSeconds:2});
  const expected=Mat4.mul(Mat4(),h.presentation,poseMatrix(evaluateTrack(domainAnimation().tracks[0],2)));
  assert.deepEqual([...labels[0].state.transform],[...expected]);
  assert.deepEqual([...labels[1].state.transform],[...h.presentation]);
  assert.deepEqual(labels.map(r=>r.geometryVersion),versions);
  await h.registry.install(undefined);assert.equal(original.state.visible,true);
  assert.equal(h.plugin.state.data.cells.size,cells);
});


test('motion framing excludes static context, includes authored focus, and leaves Fit bounds unchanged', async t => {
  const h = await fixture(t), source = h.structure.obj.data;
  const focused = resolveFigureLoci({chain:'A'}, source);
  const hidden = resolveFigureLoci({chain:'C'}, source);
  assert.equal(animationBodiesVisible(source, animation), true);
  assert.equal(animationBodiesVisible(source, animation, hidden), false);
  // An initially hidden state copy does not disqualify a preceding chapter.
  assert.equal(animationBodiesVisible(source, {...animation, tracks: [animation.tracks[0],
    {id:'state-copy', chains:['A'], keyframes:animation.tracks[0].keyframes, visibility:[{t:0,visible:false}]}]}, focused), true);
  await h.registry.install(animation);
  const whole = structuredClone(h.registry.envelope());
  const moving = h.registry.framingEnvelope();
  const expected = animationEnvelope(source, animation, {movingOnly:true});
  assert.deepEqual(moving.center, expected.center);
  assert.equal(moving.radius, expected.radius * 1.1);
  const union = h.registry.framingEnvelope(focused);
  const staticFocus = StructureElement.Loci.getBoundingSphere(focused);
  assert.ok(Vec3.distance(union.center, staticFocus.center) + staticFocus.radius <= union.radius);
  assert.deepEqual(h.registry.envelope(), whole, 'Fit keeps the full static-plus-travel envelope');
});

test('lookahead leaves the current scene untouched and reuses only matching preparation', async t => {
  const h = await fixture(t), before = h.plugin.state.data.cells.size;
  const first = await h.registry.prepare(animation);
  assert.equal(h.registry.snapshot(), null);
  assert.equal(h.repr.state.visible, true);
  assert.equal(h.plugin.state.data.cells.size, before);
  assert.equal(await h.registry.prepare(structuredClone(animation)), first);
  await h.registry.install(animation, 'prepared');
  assert.equal(h.registry.snapshot().chapterId, 'prepared');
  assert.equal(h.costs.filter(c => c.phase === 'prepare').length, 1);
  assert.notEqual(await h.registry.prepare({...animation, durationSeconds: 3}), first);
  await h.registry.forget();
  assert.notEqual(await h.registry.prepare(animation), first);
  assert.equal(h.registry.snapshot(), null);
});

test('prepared ownership survives clearing and replay, and a replacement source gets a fresh preparation', async t => {
  let current;
  const h = await fixture(t, { getStructure: () => current }); current = h.structure;
  const prepared = await h.registry.prepare(animation);
  await h.registry.install(animation); await h.registry.install(undefined);
  assert.ok(prepared.owners.size > 0, 'live removal must not clear cached ownership');
  await h.registry.install(animation);
  assert.ok(h.registry.framingEnvelope());
  current = await h.plugin.build().to(h.structure.cell.transform.parent)
    .apply(StateTransforms.Model.StructureFromModel, {type:{name:'model',params:{}}}).commit();
  assert.notEqual(await h.registry.prepare(animation), prepared);
  assert.equal(h.registry.snapshot(), null, 'an outgoing source never supplies playback to its replacement');
});

for (const autoplay of [false, true]) test(`same-animation install reuses body geometry and resets authored playback; autoplay: ${autoplay}`, async t => {
  const h = await fixture(t), value = {...animation, playback:{autoplay, loop:true, speed:2}};
  await h.registry.install(value, 'same');
  const opening = h.registry.capture(), bodies = h.registry.representations();
  assert.equal(h.costs.findLast(cost => cost.phase === 'install').reusedGeometry, false);
  const geometry = bodies.map(repr => ({version:repr.geometryVersion, objects:[...repr.renderObjects], transform:[...repr.state.transform]}));
  const cells = h.plugin.state.data.cells.size, sourceBounds = structuredClone(h.structure.obj.data.boundary.sphere);
  h.registry.control({state:'pause',seekSeconds:1.5,speed:.5,loop:false});
  const revision = h.registry.revision();
  let builds = 0;
  const build = h.plugin.builders.structure.tryCreateComponentFromSelection.bind(h.plugin.builders.structure);
  h.plugin.builders.structure.tryCreateComponentFromSelection = (...args) => { builds++; return build(...args); };
  // Transport key order must not invalidate identical content.
  const reordered = {tracks:value.tracks,playback:value.playback,durationSeconds:value.durationSeconds,version:value.version};
  await h.registry.install(reordered, 'same');
  assert.equal(builds, 0, 'an unchanged live chapter does not rebuild molecular partitions');
  assert.equal(h.costs.findLast(cost => cost.phase === 'install').reusedGeometry, true);
  assert.equal(h.plugin.state.data.cells.size, cells);
  assert.ok(h.registry.representations().every((repr,i) => repr === bodies[i]));
  for (const [i, repr] of bodies.entries()) {
    assert.equal(repr.geometryVersion, geometry[i].version);
    assert.deepEqual(repr.renderObjects, geometry[i].objects);
    assert.deepEqual([...repr.state.transform], geometry[i].transform, 'the displayed pose returns to t=0');
  }
  assert.deepEqual(h.registry.capture(), opening, 'published state resets time, speed, loop and autoplay');
  assert.equal(h.registry.revision(), revision + 1);
  h.registry.tick(10000); h.registry.tick(10250);
  assert.equal(h.registry.snapshot().timeSeconds, autoplay ? .5 : 0, 'a new clock anchors at its first frame');
  assert.deepEqual(h.structure.obj.data.boundary.sphere, sourceBounds);
});

test('same-animation install retains full reconstruction for manual tether geometry', async t => {
  const { setCanvasModule } = await import('molstar/lib/mol-geo/geometry/text/font-atlas.js');
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const h = await fixture(t), value = {...animation,
    tethers:[{id:'link',from:{chain:'C',residue:1,atom:'CA'},to:{chain:'A',residue:1,atom:'CA'},label:'Link'}]};
  await h.registry.install(value, 'same');
  const bodies = h.registry.representations(), tethers = [...h.manual];
  await h.registry.install(value, 'same');
  assert.ok(h.registry.representations().every(repr => !bodies.includes(repr)));
  assert.equal(h.manual.size, 2);
  assert.ok([...h.manual].every(repr => !tethers.includes(repr)));
  assert.equal(h.costs.findLast(cost => cost.phase === 'install').reusedGeometry, false);
});

test('same-animation install refreshes live paint, masks, annotation gates, placement and changed template geometry', async t => {
  const h = await fixture(t), loci = resolveFigureLoci({chain:'C'}, h.structure.obj.data);
  const annotation = {state:{visible:true},renderObjects:[],setState(patch){Object.assign(this.state,patch);if(patch.transform)this.state.transform=[...patch.transform];}};
  h.annotations.push({repr:annotation,loci});
  await h.registry.install(animation, 'same');
  const bodies = h.registry.representations();
  h.registry.control({state:'pause',seekSeconds:1});
  h.repr.setState({overpaint:{kind:'element-loci',layers:[{loci,color:0xff8800,clear:false}]},
    transparency:{kind:'element-loci',layers:[{loci,value:.45}]},alphaFactor:.6,pickable:false});
  h.annotations[0] = {repr:annotation,loci,gate:{shown:false,rest:true}};
  Mat4.setTranslation(h.presentation,[10,20,30]);
  await h.registry.install(animation, 'same');
  assert.ok(h.registry.representations().every((repr,i) => repr === bodies[i]), 'paint changes retain the existing partitions');
  assert.equal(bodies[0].state.overpaint.layers[0].color, 0xff8800);
  assert.equal(bodies[0].state.transparency.layers[0].value, .45);
  assert.equal(bodies[1].state.overpaint.layers.length, 0);
  for (const repr of bodies) {
    assert.equal(repr.state.alphaFactor, .6); assert.equal(repr.state.pickable, false);
    assert.deepEqual([...repr.state.transform], [...h.presentation]);
  }
  assert.equal(annotation.state.visible, false);
  h.annotations[0].gate.shown = true;
  await h.plugin.build().to(h.cell).update(params => ({...params,type:{...params.type,params:{...params.type.params,alpha:.4}}})).commit();
  await h.registry.install(animation, 'same');
  assert.ok(h.registry.representations().every(repr => !bodies.includes(repr) && repr.props.alpha === .4));
  assert.equal(h.costs.findLast(cost => cost.phase === 'install').reusedGeometry, false, 'edited template rebuilds are not reported as retained geometry');
  assert.equal(annotation.state.visible, true);
  assert.deepEqual(annotation.state.transform, [...h.presentation]);
});

test('same-animation install rebuilds when the chapter, definition, live layers, body cells or halted ownership changes', async t => {
  const h = await fixture(t);
  let value = animation, chapter = 'same';
  await h.registry.install(value, chapter);
  const cases = [
    () => { chapter = 'other'; },
    () => { value = {...animation,playback:{autoplay:false}}; },
    async () => {
      const extra = await h.plugin.builders.structure.representation.addRepresentation(h.structure,{type:'cartoon',color:'uniform',typeParams:{quality:'low'}});
      h.representations.push(extra.obj.data.repr);
    },
    () => { h.representations.pop(); },
    () => { h.annotations.push({repr:{state:{visible:true},renderObjects:[],setState(patch){Object.assign(this.state,patch);}},chains:['C']}); },
    () => { h.annotations.pop(); },
    async () => {
      const body = h.registry.representations()[0];
      const cell = [...h.plugin.state.data.cells.values()].find(cell => cell.obj?.data?.repr === body);
      await h.plugin.build().delete(cell.transform.parent).commit();
    },
    () => { h.registry.halt(); },
  ];
  for (const change of cases) {
    const before = h.registry.representations();
    await change(); await h.registry.install(value, chapter);
    assert.ok(h.registry.representations().every(repr => !before.includes(repr)));
    assert.equal(h.registry.snapshot().chapterId, chapter);
  }
});

test('same-animation install rebuilds against a replacement source with the same molecular content', async t => {
  let current;
  const h = await fixture(t, {getStructure:()=>current}); current = h.structure;
  await h.registry.install(animation, 'same');
  const bodies = h.registry.representations(), before = h.registry.capture();
  current = await h.plugin.build().to(h.structure.cell.transform.parent)
    .apply(StateTransforms.Model.StructureFromModel,{type:{name:'model',params:{}}}).commit();
  const params = createStructureRepresentationParams(h.plugin,current.obj.data,{type:'cartoon',color:'chain-id',typeParams:{quality:'low'}});
  const next = await h.plugin.build().to(current).apply(StateTransforms.Representation.StructureRepresentation3D,params).commit();
  h.representations.splice(0,1,next.obj.data.repr);
  await h.registry.install(animation, 'same');
  assert.equal(h.registry.representations().length, bodies.length);
  assert.ok(h.registry.representations().every(repr => !bodies.includes(repr)));
  assert.deepEqual(h.registry.capture(), before, 'source replacement preserves the authored definition and opening playback');
  assert.equal(h.costs.filter(cost => cost.phase === 'prepare').length, 2, 'ownership is resolved for the new structure');
});

test('same-animation install rechecks the current split budget before resetting the live clock', async t => {
  const h = await fixture(t), value = domainAnimation();
  await h.registry.install(value, 'same');
  h.registry.control({state:'pause',seekSeconds:1});
  const before = h.registry.capture(), bodies = h.registry.representations();
  const extra = await h.plugin.builders.structure.representation.addRepresentation(h.structure,{type:'cartoon',color:'uniform',typeParams:{quality:'low'}});
  h.representations.push(extra.obj.data.repr);
  await assert.rejects(h.registry.install(value, 'same'), /would add 2 representations/);
  assert.deepEqual(h.registry.capture(), before);
  assert.ok(h.registry.representations().every((repr,i) => repr === bodies[i]));
});

for (const outcome of ['caption failure','chapter change','source change']) test(`same-animation install keeps caption staging and cleans up ${outcome}`, async t => {
  let current;
  const h = await fixture(t, {getStructure:()=>current}), cells = h.plugin.state.data.cells.size; current = h.structure;
  await h.registry.install(animation, 'same');
  const bodies = h.registry.representations();
  h.registry.control({state:'pause',seekSeconds:1});
  let reach, release, refuse;
  const reached = new Promise(resolve => { reach = resolve; });
  const gate = new Promise((resolve,reject) => { release = resolve; refuse = reject; });
  const installing = h.registry.install(animation, 'same', {beforeReveal:{then(resolve,reject){reach();return gate.then(resolve,reject);}}});
  await reached;
  assert.ok(![...h.plugin.state.data.cells.values()].some(cell => bodies.includes(cell.obj?.data?.repr)), 'caption admission uses the existing full staged path');
  h.registry.tick(100); h.registry.tick(200);
  assert.equal(h.registry.snapshot().timeSeconds, 0, 'incomplete restart never samples the clock');
  assert.equal(h.registry.drawn(new Set(h.registry.representations().flatMap(repr => repr.renderObjects))), false);
  const failure = assert.rejects(installing, outcome === 'caption failure' ? /caption failed/ : /source or chapter changed/);
  if (outcome === 'chapter change') {
    const next = h.registry.install(animation, 'replacement');
    release(); await failure; await next;
    assert.equal(h.registry.snapshot().chapterId, 'replacement');
    assert.equal(h.registry.drawn(new Set(h.registry.representations().flatMap(repr => repr.renderObjects))), true);
  } else if (outcome === 'source change') {
    current = await h.plugin.build().to(h.structure.cell.transform.parent)
      .apply(StateTransforms.Model.StructureFromModel,{type:{name:'model',params:{}}}).commit();
    release(); await failure;
    assert.equal(h.registry.snapshot(), null); assert.equal(h.plugin.state.data.cells.size, cells + 1);
    assert.equal(h.repr.state.visible, true);
  } else {
    refuse(Error('caption failed')); await failure;
    assert.equal(h.registry.snapshot(), null); assert.equal(h.plugin.state.data.cells.size, cells);
    assert.equal(h.repr.state.visible, true);
  }
});

test('XR input ticks during teardown and tether construction never sample incomplete geometry', async t => {
  const errors = [];
  const h = await fixture(t, {isImmersive:()=>true, onError:error=>errors.push(error)});
  let time = 0, frames = 0;
  const inputFrame = () => { frames++; h.registry.tick(time += 14); };
  const subscriptions = ['created', 'removed'].map(kind => h.plugin.state.data.events.cell[kind].subscribe(inputFrame));
  t.after(() => subscriptions.forEach(subscription => subscription.unsubscribe()));
  const value = {...animation, tethers:[{id:'link',from:{chain:'C',residue:1,atom:'CA'},to:{chain:'A',residue:1,atom:'CA'},label:'Head 1'}]};
  await h.registry.install(value, 'two-steps');
  h.registry.control({state:'play'});
  value.tethers[0].label = 'Leading head'; value.playback = {...value.playback, speed:2};
  await h.registry.install(value, 'two-steps');
  for (let i=0;i<100;i++) inputFrame();
  assert.ok(frames > 100, 'input ran during asynchronous state-tree construction too');
  assert.deepEqual(errors, []);
  assert.equal(h.registry.snapshot().state, 'playing'); assert.equal(h.registry.snapshot().speed, 2);
  assert.equal(h.registry.drawn(new Set(h.registry.representations().flatMap(repr=>repr.renderObjects))), true);
  const cached = await h.registry.prepare(value);
  assert.equal(cached.tethers[0].from.representations, undefined, 'prepared endpoints never retain retired live representations');
});

test('one corrupt endpoint hides its tether; an unexpected frame fault stops ticks and fails draw evidence once', async t => {
  const errors=[]; const h=await fixture(t,{onError:error=>errors.push(error)});
  const endpointSource=readFileSync(new URL('./molecular-animation.mjs',import.meta.url),'utf8');
  const start=endpointSource.indexOf('  const endpointVisible =');
  const end=endpointSource.indexOf('\n  const place',start);
  const visible=vm.runInNewContext(endpointSource.slice(start,end)+';endpointVisible',{poses:new Map()});
  assert.equal(visible({}),false); assert.equal(visible(null),false);
  await h.registry.install(animation);
  h.registry.representations()[0].setState=()=>{throw Error('Broken body');};
  for(let i=0;i<100;i++) h.registry.tick(i*14);
  assert.equal(errors.length,1); assert.match(errors[0].message,/Broken body/);
  assert.throws(()=>h.registry.drawn(new Set()),/Broken body/);
  await h.registry.restore(h.registry.capture());
  h.registry.tick(2000); assert.equal(errors.length,1);
  assert.equal(h.registry.drawn(new Set(h.registry.representations().flatMap(repr=>repr.renderObjects))),true);
});

test('animated chapter draws moving bodies before plates, reveals only posed copies, and waits for the final draw', async t => {
  const { createLessonFigure } = await import('./lesson-figure.mjs');
  const { setCanvasModule } = await import('molstar/lib/mol-geo/geometry/text/font-atlas.js');
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  let figure, h, annotations=()=>[];
  h=await fixture(t,{getRepresentations:()=>[h.repr,...figure.molecular()],getAnnotations:()=>annotations()});
  h.plugin.canvas3d={xr:{isPresenting:{value:false}},update(){},add(){},remove(){},mark(){},syncVisibility(){},getRenderObjects:()=>[]};
  figure=createLessonFigure({plugin:h.plugin,getStructure:()=>h.structure,getTransform:()=>h.presentation});
  const value={...animation,tracks:[
    {...animation.tracks[0],id:'head',chains:['C'],visibility:undefined},
    {...animation.tracks[0],id:'copy',chains:['D'],visibility:[{t:0,visible:false}]},
  ]};
  const chapter={layers:[],distances:[],labels:['C','D'].map(chain=>({id:chain,text:'Head',target:{chain},color:'#ffffff',offsetX:0,offsetY:0,sizeFactor:1}))};
  const build=h.plugin.builders.structure.tryCreateComponentFromSelection.bind(h.plugin.builders.structure);
  let stagedSamples=0, releaseDraw, drawing, releaseBodies, drawingBodies;
  const bodyDraw=new Promise(resolve=>{releaseBodies=resolve;});
  const atBodyDraw=new Promise(resolve=>{drawingBodies=resolve;});
  const drawn=new Promise(resolve=>{releaseDraw=resolve;});
  const atDraw=new Promise(resolve=>{drawing=resolve;});
  h.plugin.builders.structure.tryCreateComponentFromSelection=async(...args)=>{
    // These async boundaries are where the previous implementation displayed
    // both plates while the molecular bodies were still being built.
    assert.equal(figure.annotations().length,0,'plates are absent while bodies build');
    assert.equal(h.repr.state.visible,true);
    stagedSamples++;
    return build(...args);
  };
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const annotationsStart=source.indexOf('    getAnnotations: () => {');
  annotations=vm.runInNewContext('({'+source.slice(annotationsStart,source.indexOf('    // Immersion uses',annotationsStart))+'}).getAnnotations',
    {plugin:h.plugin,componentLabelRepresentations:()=>[],lessonFigure:figure,StructureElement});
  const start=source.indexOf('  async function installMolecularChapter(');
  const end=source.indexOf('  async function setLessonFigure(',start);
  assert.ok(start>0&&end>start);
  const install=vm.runInNewContext(source.slice(start,end)+';installMolecularChapter',{
    molecularAnimation:h.registry,lessonFigure:figure,applyInspectionTransform(){},snapshot:()=>({ready:true}),
    wearerPlacement:{holdsPlacement:()=>true},now:()=>performance.now(),recordCost(){},
    inspectionMutation:async operation=>{
      await operation();
      if (!figure.annotations().length) {
        assert.ok(h.registry.representations().some(repr=>repr.state.visible&&repr.renderObjects.length));
        drawingBodies(); await bodyDraw; return {ready:true};
      }
      assert.equal(figure.annotations().filter(repr=>repr.state.visible).length,1);
      for (const repr of figure.annotations()) {
        const cell=[...h.plugin.state.data.cells.values()].find(cell=>cell.obj?.data?.repr===repr);
        assert.equal(cell.state.isHidden,false,'track visibility owns labels after the handoff');
      }
      assert.ok(h.registry.representations().some(repr=>repr.state.visible&&repr.renderObjects.length));
      drawing(); await drawn; return {ready:true};
    },
  });
  let complete=false;
  try {
    await figure.install(chapter);
    await figure.install(chapter,{deferReveal:true});
    assert.ok(figure.annotations().every(repr=>!repr.state.visible));
    await figure.install(chapter); // A failed/cancelled stage restores static plates.
    assert.equal(figure.annotations().filter(repr=>repr.state.visible).length,2);
    const pending=install(value,'opening',{installFigure:true,figure:chapter,toolbarReady:Promise.resolve()}).then(()=>{complete=true;});
    await atBodyDraw;
    assert.equal(complete,false);assert.equal(figure.annotations().length,0);
    h.registry.tick(0);h.registry.tick(500);
    const moving=h.registry.representations().find(repr=>repr.state.visible);
    const pose=[...moving.state.transform];
    h.registry.tick(700);
    assert.notDeepEqual([...moving.state.transform],pose,'bodies move before the plates are built');
    // Sample all asynchronous cell changes while the late figure builds.
    const samples=[];
    const subscription=h.plugin.state.data.events.cell.stateUpdated.subscribe(()=>queueMicrotask(()=>{
      const plates=[...h.plugin.state.data.cells.values()].filter(cell=>cell.obj?.data?.repr && cell.params?.values?.customText==='Head');
      samples.push(plates.filter(cell=>cell.obj.data.repr.state.visible).length);
    }));
    releaseBodies();await atDraw;subscription.unsubscribe();
    assert.ok(samples.length>0);assert.ok(samples.every(n=>n<=1),'no static duplicate plates during handoff');
    assert.ok(stagedSamples>=2); assert.equal(complete,false,'completion requires the real draw boundary');
    releaseDraw(); await pending;
    assert.equal(figure.annotations().filter(repr=>repr.state.visible).length,1);
    const visible=figure.annotations().find(repr=>repr.state.visible);
    h.registry.tick(0); h.registry.tick(500);
    assert.deepEqual([...visible.state.transform],[...h.registry.representations().find(repr=>h.registry.owns(repr)&&repr.state.visible).state.transform]);
    // An edited/reloaded walk can restart while its old posed figure is live.
    await install(value,'restarted',{installFigure:true,figure:chapter,toolbarReady:Promise.resolve()});
    assert.equal(figure.annotations().filter(repr=>repr.state.visible).length,1);
    assert.equal(h.registry.snapshot().chapterId,'restarted');
  } finally { releaseBodies(); releaseDraw(); await h.registry.forget(); await figure.forget(); h.plugin.canvas3d=undefined; }
});

for (const fail of [false,true]) test(`body geometry builds before the caption barrier; failed barrier: ${fail}`, async t => {
  const h=await fixture(t), before=h.plugin.state.data.cells.size;
  let reach, release, refuse;
  const staged=new Promise(resolve=>{reach=resolve;});
  const gate=new Promise((resolve,reject)=>{release=resolve;refuse=reject;});
  const installing=h.registry.install(animation,'caption',{beforeReveal:{then(resolve,reject){reach();return gate.then(resolve,reject);}}});
  await staged;
  assert.ok(h.plugin.state.data.cells.size>before,'body geometry was built while the caption was pending');
  assert.equal(h.repr.state.visible,true,'the previous molecule remains visible');
  const bodies=[...h.plugin.state.data.cells.values()].filter(cell=>cell.obj?.data?.repr && cell.obj.data.repr!==h.repr);
  assert.ok(bodies.length>0);assert.ok(bodies.every(cell=>cell.state.isHidden));
  if(fail) {
    refuse(Error('caption failed'));await assert.rejects(installing,/caption failed/);
    assert.equal(h.registry.snapshot(),null);assert.equal(h.plugin.state.data.cells.size,before);
    assert.equal(h.repr.state.visible,true);
  } else {
    release();await installing;
    assert.equal(h.repr.state.visible,false);
    assert.equal(h.registry.drawn(new Set(h.registry.representations().flatMap(repr=>repr.renderObjects))),true);
  }
});


test('the field envelope is the moving bodies as the chapter opens, whatever the clock reads', async t => {
  const h = await fixture(t), data = h.structure.obj.data;
  await h.registry.install(animation);
  const rest = StructureElement.Loci.getBoundingSphere(selectAnimationTrack(data,animation.tracks[0]));
  // Chain C at t=0. Neither later poses nor the hidden interval change it.
  const opening = transformSphere(rest,poseMatrix(evaluateTrack(animation.tracks[0],0)));
  let first;
  for (const seconds of [0,.3,1.9]) {
    h.registry.control({state:'pause',seekSeconds:seconds});
    const field = h.registry.fieldEnvelope();
    first ??= field;
    assert.ok(Vec3.distance(opening.center,field.center)+opening.radius<=field.radius+1e-6);
    assert.ok(Vec3.distance(first.center,field.center)<1e-9 && Math.abs(first.radius-field.radius)<1e-9, `${seconds}s`);
    assert.ok(field.radius<h.registry.framingEnvelope().radius);
  }
  // The moving body's drawn representation is measured by this sphere instead.
  assert.ok(h.registry.movingRepresentations().length > 0);
  await h.registry.install(undefined);
  assert.equal(h.registry.fieldEnvelope(),undefined);
  assert.deepEqual(h.registry.movingRepresentations(),[]);
});

test('annotation envelopes recover the source anchor at every drawn pose, whatever the clock reads, and expire with the animation', async t => {
  const h = await fixture(t), loci = resolveFigureLoci({chain:'C'},h.structure.obj.data);
  const annotation = {state:{visible:true},renderObjects:[],setState(patch){Object.assign(this.state,patch);}};
  h.annotations.push({repr:annotation,loci});
  await h.registry.install(animation);
  const sourcePoint = [12,4,1], inverse = Mat4.invert(Mat4(),h.presentation);
  let first;
  for (const seconds of [0,.3,.7,1.9]) {
    h.registry.control({state:'pause',seekSeconds:seconds});
    // Hidden annotations keep their last drawn matrix until their next reveal.
    const drawn = Vec3.transformMat4(Vec3(),sourcePoint,annotation.state.transform);
    const posed = Vec3.transformMat4(Vec3(),drawn,inverse);
    const envelope = h.registry.annotationEnvelope(annotation,posed);
    // Hidden from 0.2 to 0.4 s, it shows again later: every menu draw in the
    // chapter measures the same travel, so a draw at 0.3 s does too.
    first ??= envelope;
    assert.ok(Vec3.distance(first.center,envelope.center)<1e-8);
    assert.ok(Math.abs(first.radius-envelope.radius)<1e-8);
    for (let time=0;time<=2;time+=.05) {
      const point = Vec3.transformMat4(Vec3(),sourcePoint,poseMatrix(evaluateTrack(animation.tracks[0],time)));
      assert.ok(Vec3.distance(point,envelope.center)<=envelope.radius+1e-8);
    }
  }
  await h.registry.install(undefined);
  assert.equal(h.registry.annotationEnvelope(annotation,sourcePoint),undefined);
});

test('a plate on a body that never shows in the chapter has no travel to clear', async t => {
  const h = await fixture(t), loci = resolveFigureLoci({chain:'C'},h.structure.obj.data);
  const never = {...animation, tracks:[{...animation.tracks[0], visibility:[{t:0,visible:false}]}]};
  const annotation = {state:{visible:false,transform:Mat4.copy(Mat4(),h.presentation)},renderObjects:[],setState(patch){Object.assign(this.state,patch);}};
  h.annotations.push({repr:annotation,loci});
  await h.registry.install(never);
  for (const seconds of [0,1,1.9]) {
    h.registry.control({state:'pause',seekSeconds:seconds});
    assert.equal(h.registry.annotationEnvelope(annotation,[12,4,1]),null);
  }
});

test('a plate on a body hidden at t=0 keeps its source anchor when the placement moves', async t => {
  const h = await fixture(t), loci = resolveFigureLoci({chain:'C'},h.structure.obj.data);
  const hidden = {...animation, tracks:[{...animation.tracks[0], visibility:[{t:0,visible:false},{t:1,visible:true}]}]};
  // A figure plate keeps the static scene's matrix until its body first shows.
  const annotation = {state:{visible:true,transform:Mat4.copy(Mat4(),h.presentation)},renderObjects:[],setState(patch){Object.assign(this.state,patch);}};
  h.annotations.push({repr:annotation,loci});
  await h.registry.install(hidden);
  h.registry.control({state:'pause',seekSeconds:.5});
  const sourcePoint = [12,4,1], drawn = Vec3.transformMat4(Vec3(),sourcePoint,annotation.state.transform);
  // The placement then moves while the plate stays hidden.
  Mat4.mul(h.presentation, Mat4.fromTranslation(Mat4(),[3,-2,5]), h.presentation);
  const posed = Vec3.transformMat4(Vec3(),drawn,Mat4.invert(Mat4(),h.presentation));
  const envelope = h.registry.annotationEnvelope(annotation,posed);
  for (let time=0;time<=2;time+=.05) {
    const point = Vec3.transformMat4(Vec3(),sourcePoint,poseMatrix(evaluateTrack(hidden.tracks[0],time)));
    assert.ok(Vec3.distance(point,envelope.center)<=envelope.radius+1e-8);
  }
  assert.ok(envelope.radius < 10, `radius ${envelope.radius}`);
});
