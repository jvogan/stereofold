import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { capFigureAnnotations } from './figure-label-placement.mjs';
import { capPlateInEyes, plateCharacterDegrees, plateObstaclesInEyes, releasePlateInEyes } from './plate-eye-cap.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { registerImmersiveAnnotation, sizeImmersiveAnnotation, annotationOffsetCap } from './immersive-annotations.mjs';
import { viewerCallback } from './fixtures/viewer-callback.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { renderedLabelQuads, projectPlateQuad, measureComponentLabels } from './component-label-measurement.mjs';
import { coordinates } from './fixtures/kinesin-layout.mjs';

const cell = value => ({ref:{value,version:0}});
function plate(at, {size=4,x=0,y=0,z=0,halfWidth=3}={}) {
  const m=[1,0,0,0,0,1,0,0,0,0,1,0,...at,1];
  return {type:'text',state:{visible:true},values:Object.fromEntries(Object.entries({
    aPosition:new Float32Array(12),aTransform:new Float32Array(m),aMapping:new Float32Array([-halfWidth,-.5,halfWidth,-.5,halfWidth,.5,-halfWidth,.5]),
    aTexCoord:new Float32Array(8).fill(10),aDepth:new Float32Array(4),elements:new Uint32Array([0,1,2,0,2,3]),
    drawCount:6,instanceCount:1,dSizeType:'uniform',uSize:1,alpha:1,uSizeFactor:size,uOffsetX:x,uOffsetY:y,uOffsetZ:z,
  }).map(([k,v])=>[k,cell(v)]))};
}
const views=syntheticViews(), cameraScale=.01;
const rect=(object,view)=>{
  const q=projectPlateQuad(renderedLabelQuads(object,view,cameraScale)[0].corners,view),r=q.rect,p=view.projectionMatrix;
  assert.ok(q.inside>.99999,'the entire backing is inside the lens');
  return {left:(r.x-r.hw)*p[0]-p[8],right:(r.x+r.hw)*p[0]-p[8],bottom:(r.y-r.hh)*p[5]-p[9],top:(r.y+r.hh)*p[5]-p[9]};
};
const overlap=(a,b)=>a.left<b.right&&b.left<a.right&&a.bottom<b.top&&b.bottom<a.top;

test('figure plates enter the same per-eye cap as component and residue names',()=>{
  const object=plate([0,0,-50]);
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const c=vm.createContext({canvas:{camera:{scale:cameraScale}},componentLabels:{active:()=>false},plugin:{state:{data:{cells:new Map()}}},
    lessonFigure:{annotations:()=>[{state:{visible:true},renderObjects:[object]}]},inspectionLabel:null,
    plateEyeMemory:new WeakMap(),capFigureAnnotations,capPlateInEyes,plateObstaclesInEyes,immersiveSession:null,annotationOffsetCap:()=>2});
  vm.runInContext(pageFunction(source,'capDrawnPlates'),c);c.capDrawnPlates(views);
  assert.ok(plateCharacterDegrees(object,views[0],cameraScale)<=2.00001);
});

test('figure sites separate in BOTH eyes within their own offset cap, with unchanged buffers',()=>{
  const memory=new WeakMap(), placed=[];
  const objects=[plate([-4,0,-180]),plate([4,0,-180]),plate([8,8,-185])];
  const buffers=objects.map(o=>Object.fromEntries(['aPosition','aMapping','aTransform'].map(k=>[k,o.values[k].ref.value])));
  for(let frame=0;frame<3;frame++){
    placed.length=0;
    for(const object of objects)capPlateInEyes({objects:[object],views,cameraScale,memory,placed,maxOffsetEm:2});
    assert.ok(objects.every(o=>o.state.visible),'all three site names remain readable');
    for(const view of views)for(let i=0;i<objects.length;i++)for(let j=i+1;j<objects.length;j++)assert.equal(overlap(rect(objects[i],view),rect(objects[j],view)),false);
    for(let i=0;i<objects.length;i++){
      const v=objects[i].values,em=.8*v.uSizeFactor.ref.value;
      assert.ok(Math.abs(v.uOffsetX.ref.value)<=2*em+1e-6&&Math.abs(v.uOffsetY.ref.value)<=2*em+1e-6);
      for(const [k,b] of Object.entries(buffers[i]))assert.equal(v[k].ref.value,b);
    }
  }
});

test('a detached coloured legend moves inboard as one plate rather than disappearing at the right lens',()=>{
  const memory=new WeakMap(), placed=[];
  const ink=plate([130,0,-200],{x:35,size:5}),key=plate([130,0,-200],{x:35,size:5,halfWidth:3.1});
  const next=plate([130,2,-200],{x:35,size:5});
  capPlateInEyes({objects:[ink,key],views,cameraScale,memory,placed,legend:true});
  capPlateInEyes({objects:[next],views,cameraScale,memory,placed,legend:true});
  for(const object of [ink,key,next]){
    assert.equal(object.state.visible,true);
    for(const view of views){const r=rect(object,view);assert.ok(r.left>=-.981&&r.right<=.981&&r.bottom>=-.981&&r.top<=.981);}
  }
  for(const view of views)assert.equal(overlap(rect(key,view),rect(next,view)),false);
  assert.equal(ink.values.uOffsetX.ref.value,key.values.uOffsetX.ref.value);
  assert.equal(ink.values.uOffsetY.ref.value,key.values.uOffsetY.ref.value);
  assert.ok(ink.values.uOffsetX.ref.value<35);
});

test('a plate pushed inside 0.05 m or past the eye is hidden, and returns at a safe distance',()=>{
  for(const depth of [2,4,10]){
    const object=plate([0,0,-depth],{z:7}),memory=new WeakMap();
    const r=capPlateInEyes({objects:[object],views,cameraScale,memory});
    assert.equal(object.state.visible,false,`depth ${depth}, push 7`);
    assert.equal(r.clipped,true);
    object.values.aTransform.ref.value[14]=-100;
    capPlateInEyes({objects:[object],views,cameraScale,memory});assert.equal(object.state.visible,true);
  }
});

test('the ATP putative phosphate plate names the displayed phosphate rather than the chain terminus',()=>{
  const c=JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase-rotor/motion.json',import.meta.url),'utf8')).chapters[3];
  const label=c.immersive.figure.labels.find(l=>l.id==='beta-e'),site=c.immersive.figure.layers.find(l=>l.id==='po4_e');
  assert.deepEqual(label.target,site.target);
  assert.ok(label.offsetY>0,'the plate clears the site above it');
});

test('the ATP βDP plate names its empty nucleotide site, not a residue beside the stalk',{skip:!process.env.STEREOFOLD_DEMO_CACHE},()=>{
  const lesson=JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase-rotor/motion.json',import.meta.url),'utf8'));
  const label=lesson.chapters[3].immersive.figure.labels.find(l=>l.id==='beta-dp');
  const atoms=coordinates(`${process.env.STEREOFOLD_DEMO_CACHE}/atp-synthase-rotor-motion.cif`,lesson.provenance.sourceSha256);
  const at=(chain,residue,atom)=>atoms.find(a=>a.chain===chain&&a.residue===residue&&(!atom||a.atom===atom)).position;
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
  // βE's phosphate sits on the same Walker A lysine the βDP plate now names.
  const phosphate=at('E',600,'P');
  const lining=atoms.filter(a=>a.chain==='E'&&a.residue<600).sort((a,b)=>dist(a.position,phosphate)-dist(b.position,phosphate))
    .slice(0,12).map(a=>a.residue);
  assert.ok(lining.includes(label.target.residues.from),`residue ${label.target.residues.from} lines the βE site`);
  assert.equal(label.target.chain,'D');
  // The site is in the head, well above the DELSEED loop that grips γ.
  const gamma=atoms.filter(a=>a.chain==='G').map(a=>a.position);
  const anchor=at('D',label.target.residues.from,label.target.atomName);
  assert.ok(Math.min(...gamma.map(p=>dist(p,anchor)))>15,'the plate does not stand on the stalk');
});

test('inboard legends clear the molecule and existing UI glass in both eyes',()=>{
  const memory=new WeakMap();
  const subject=plateObstaclesInEyes([[[.15,-.35,-2],[.8,.35,-2]]],views);
  const placed=plateObstaclesInEyes([[[-.7,-.9,-2],[-.2,-.4,-2]]],views);
  const objects=[plate([130,0,-200],{x:35,size:5}),plate([130,2,-200],{x:35,size:5})];
  for(const o of objects)capPlateInEyes({objects:[o],views,cameraScale,memory,legend:true,obstacles:subject,placed});
  for(const o of objects){
    assert.equal(o.state.visible,true);
    for(let eye=0;eye<views.length;eye++)for(const blocker of [...subject,placed.slice(0,1)[0]])for(const b of blocker[eye])assert.equal(overlap(rect(o,views[eye]),b),false);
  }
});

test('a plate with a raised authored cap can move inboard without reducing its font',()=>{
  const memory=new WeakMap(),object=plate([84,0,-100],{size:3});
  capPlateInEyes({objects:[object],views,cameraScale,memory,maxOffsetEm:5,placed:[]});
  assert.equal(object.state.visible,true);
  for(const view of views)rect(object,view);
  assert.ok(Math.abs(object.values.uOffsetX.ref.value)<=5*.8*object.values.uSizeFactor.ref.value);
});

test('ten moving colour legends and figure plates use uniform writes with frame p95 below 2 ms',t=>{
  const memory=new WeakMap(),objects=Array.from({length:10},(_,i)=>[plate([100,i*5-25,-220],{size:5,x:35}),plate([100,i*5-25,-220],{size:5,x:35,halfWidth:3.1})]);
  const sites=Array.from({length:3},(_,i)=>plate([i*15-20,15,-200]));
  const reprs=sites.map(o=>{
    Object.assign(o.values,{matrix:cell(o.values.aTransform.ref.value),boundingSphere:cell({center:[0,0,0],radius:1}),
      invariantBoundingSphere:cell({center:[0,0,0],radius:1})});
    return registerImmersiveAnnotation({renderObjects:[o],state:{visible:true},props:{offsetY:8},updated:{subscribe(){}}},{size:.3});
  });
  const canvas={camera:{scale:cameraScale},xr:{isPresenting:{value:true}}};
  const points=Array.from({length:256},(_,i)=>[-.5+.25*Math.cos(i),.25*Math.sin(i),-2]);
  const buffers=[...objects.flat(),...sites].map(o=>[o,o.values.aPosition.ref.value,o.values.aTransform.ref.value,o.values.aMapping.ref.value]);
  const samples=[];
  for(let frame=0;frame<700;frame++){
    const placed=[],start=performance.now();
    for(const repr of reprs){
      const v=repr.renderObjects[0].values;v.aTransform.ref.value[14]=-200+5*Math.sin(frame/20);v.matrix.ref.version++;
      sizeImmersiveAnnotation(repr,canvas);
    }
    const obstacles=plateObstaclesInEyes([points],views,{silhouette:true});
    for(const lines of objects)capPlateInEyes({objects:lines,views,cameraScale,memory,placed,legend:true,obstacles});
    for(const o of sites)capPlateInEyes({objects:[o],views,cameraScale,memory,placed,maxOffsetEm:2});
    if(frame>200)samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);const p95=samples[Math.floor(samples.length*.95)];t.diagnostic(`plate frame p95 ${p95.toFixed(3)} ms; geometry rebuilds 0`);
  assert.ok(p95<2,`plate frame p95 ${p95} ms`);
  for(const [o,p,mappingTransform,mapping] of buffers){assert.equal(o.values.aPosition.ref.value,p);assert.equal(o.values.aTransform.ref.value,mappingTransform);assert.equal(o.values.aMapping.ref.value,mapping);}
});

test('Mol* groupInstance text sizes are capped from their packed texture, rather than assumed to be one',()=>{
  const o=plate([0,0,-50],{size:1});
  o.values.dSizeType.ref.value='groupInstance';o.values.uSize.ref.value=0;
  o.values.tSize=cell({array:new Uint8Array([0,1,145]),width:1,height:1});
  assert.ok(plateCharacterDegrees(o,views[0],cameraScale)>3);
  capPlateInEyes({objects:[o],views,cameraScale,memory:new WeakMap()});
  assert.ok(plateCharacterDegrees(o,views[0],cameraScale)<=2.00001);
});

test('recorded close telomerase glass clears in both eyes after the shader backing-depth bias',()=>{
  const cases=JSON.parse(readFileSync(new URL('./fixtures/plate-close-views.json',import.meta.url),'utf8'));
  for(const c of cases){
    const memory=new WeakMap(),placed=[];
    for(const objects of c.groups)capPlateInEyes({objects,views:c.views,cameraScale:c.scale,memory,placed,legend:true});
    const groups=c.groups.map((objects,id)=>({id,objects}));
    for(const measured of measureComponentLabels({plates:groups,views:c.views,cameraScale:c.scale})){
      assert.equal(measured.visible,2);assert.equal(measured.overlaps,0,`${c.name}/${measured.eye}`);assert.equal(measured.offGlass,0);
    }
  }
});

test('opted-in close oblique glass keeps the glyph footprint rather than exposing ink below its backing',()=>{
  const o=plate([10,-10,-80],{size:3,x:5,y:-20,z:40});o.values.uPlateBillboard=cell(0);
  const ink={...o,values:{...o.values,aTexCoord:cell(new Float32Array(8))}};
  const box=(object,view)=>projectPlateQuad(renderedLabelQuads(object,view,cameraScale)[0].corners,view).rect;
  for(const view of views){
    const original=box(o,view),glyph=box(ink,view);
    assert.ok(Math.abs(original.y-glyph.y)>1e-4,'the uncorrected backing shifts away from its glyphs');
  }
  o.values.uPlateBillboard.ref.value=1;
  for(const view of views){
    const background=box(o,view),glyph=box(ink,view);
    for(const key of ['x','y','hw','hh'])assert.ok(Math.abs(background[key]-glyph[key])<1e-8,key);
  }
});

test('retained figure plates release their XR uniforms for desktop without rewriting geometry or a newer author edit',()=>{
  const o=plate([0,0,-50],{size:4,y:10}),memory=new WeakMap();o.values.uPlateBillboard=cell(0);
  const positions=o.values.aPosition.ref.value;
  capPlateInEyes({objects:[o],views,cameraScale,memory,maxOffsetEm:2,placed:[]});
  assert.equal(o.values.uPlateBillboard.ref.value,1);assert.ok(o.values.uSizeFactor.ref.value<4);
  o.values.uOffsetX.ref.value=7; // An authored update after the cap owns this field.
  releasePlateInEyes(o,memory);
  assert.equal(o.values.uPlateBillboard.ref.value,0);assert.equal(o.values.uSizeFactor.ref.value,4);
  assert.equal(o.values.uOffsetY.ref.value,10);assert.equal(o.values.uOffsetX.ref.value,7);
  assert.equal(o.values.aPosition.ref.value,positions);
});


test('motion sizing and binocular cap run before either eye draws on every native frame', t => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const objects = [plate([-4, 0, -50]), plate([4, 0, -50])];
  const reprs = objects.map(object => {
    Object.assign(object.values, { matrix: cell(object.values.aTransform.ref.value),
      boundingSphere: cell({ center: [0, 0, 0], radius: 1 }),
      invariantBoundingSphere: cell({ center: [0, 0, 0], radius: 1 }), uPlateBillboard: cell(0) });
    return registerImmersiveAnnotation({ renderObjects: [object], state: { visible: true },
      props: { offsetX: 0, offsetY: 8 }, updated: { subscribe() {} } }, { size: 1 });
  });
  const buffers = objects.map(o => [o.values.aPosition.ref.value, o.values.aMapping.ref.value, o.values.aTransform.ref.value]);
  const order = [], uncapped = [];
  let frameViews = views;
  const c = vm.createContext({ Mat4, XRRigidTransform: class {}, recordXrFrameError(_phase, error) { throw error; },
    canvas: { camera: { scale: cameraScale, view: Mat4.identity() }, xr: { isPresenting: { value: true } } },
    latestXrSpace: undefined, xrInputHeadInRoom: undefined, naturalInput: undefined, xrControllerInput: undefined,
    plateEyeInSource() {}, flushXrDeferredGrab() {}, recordCost(_kind, error) { throw Error(JSON.stringify(error)); },
    molecularAnimation: { tick(time) { order.push('motion'); for (const o of objects) {
      o.values.aTransform.ref.value[14] = -50 - time / 100; o.values.matrix.ref.version++;
    } }, tetherRepresentations: () => [] },
    sizeImmersiveAnnotation(...args) { order.push('size'); const result = sizeImmersiveAnnotation(...args);
      uncapped.push(plateCharacterDegrees(args[0].renderObjects[0], views[0], cameraScale)); return result; },
    lessonFigure: { annotations: () => reprs }, componentLabels: { active: () => false },
    plugin: { state: { data: { cells: new Map() } } }, inspectionLabel: null,
    immersiveSession: null, plateEyeMemory: new WeakMap(), capFigureAnnotations, capPlateInEyes, plateObstaclesInEyes, annotationOffsetCap,
  });
  vm.runInContext(pageFunction(source, 'capDrawnPlates'), c);
  const cap = c.capDrawnPlates; c.capDrawnPlates = current => { order.push('cap'); assert.equal(current, frameViews, 'cap uses this frame’s eye views'); cap(current); };
  const input = vm.runInContext(viewerCallback(source, 'onInputFrame'), c);
  const observerSource = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
  const start = observerSource.indexOf('function installHeadFrameObserver(');
  vm.runInContext(observerSource.slice(start, observerSource.indexOf('\n}\n', start) + 3), c);
  const queued = [], session = { requestAnimationFrame(fn) { queued.push(fn); } };
  const offset = {}, space = { getOffsetReferenceSpace: () => offset };
  const frame = { getViewerPose: ref => ref === offset ? { views: frameViews } : { transform: { matrix: Mat4.identity() } } };
  let draws = 0;
  c.installHeadFrameObserver({ session, space, onInputFrame: input, drawCount: () => draws });
  for (let i = 0; i < 3; i++) {
    frameViews = syntheticViews();
    for (const view of frameViews) { view.transform.matrix[12] += i * .005; view.transform.inverse.matrix[12] -= i * .005; }
    order.length = 0;
    session.requestAnimationFrame(() => {}); // diagnostics subscriber precedes Mol*
    session.requestAnimationFrame(() => {
      for (const view of frameViews) {
        order.push('draw'); draws++;
        for (const o of objects) { assert.equal(o.state.visible, true);
          assert.ok(plateCharacterDegrees(o, view, cameraScale) <= 2.00001, 'size is capped at draw time'); }
        assert.equal(overlap(rect(objects[0], view), rect(objects[1], view)), false);
      }
    });
    for (const callback of queued.splice(0)) callback(i * 14, frame);
    assert.deepEqual(order, ['motion', 'size', 'size', 'cap', 'draw', 'draw']);
  }
  assert.ok(uncapped.every(degrees => degrees > 10), 'real sizing restores the oversized authored plate each tick');
  t.diagnostic(`moving plate before cap ${uncapped[0].toFixed(2)} degrees; at draw ${plateCharacterDegrees(objects[0], views[0], cameraScale).toFixed(2)} degrees`);
  for (let i = 0; i < objects.length; i++) for (const [j, key] of ['aPosition', 'aMapping', 'aTransform'].entries())
    assert.equal(objects[i].values[key].ref.value, buffers[i][j]);
});

test('a legend stays in a ring opening but clears locally occupied molecular samples in either eye', () => {
  const ring = Array.from({ length: 256 }, (_, i) => {
    const angle = i * 2 * Math.PI / 256; return [2 * Math.cos(angle), 2 * Math.sin(angle), -2];
  });
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const o = plate([0, 0, -200], { size: 3 });
  const c = vm.createContext({ canvas: { camera: { scale: cameraScale } },
    componentLabels: { active: () => true, refs: () => ['legend'] },
    plugin: { state: { data: { cells: new Map([['legend-key', { obj: { data: { repr: { renderObjects: [o] } } } }]]) } } },
    lessonFigure: { annotations: () => [] }, inspectionLabel: null, immersiveSession: null,
    representation: { obj: { data: { repr: { renderObjects: [{}] } } } }, renderedSubjectPoints: () => ring,
    plateEyeMemory: new WeakMap(), capFigureAnnotations, capPlateInEyes, plateObstaclesInEyes,
  });
  vm.runInContext(pageFunction(source, 'capDrawnPlates'), c); c.capDrawnPlates(views);
  assert.equal(o.state.visible, true, 'empty ring centre stays readable');
  assert.equal(o.values.uOffsetX.ref.value, 0); assert.equal(o.values.uOffsetY.ref.value, 0);
  // Fill the opening locally: the same legend now has to move or hide.
  ring.push([0, 0, -2]); c.capDrawnPlates(views);
  assert.ok(!o.state.visible || o.values.uOffsetX.ref.value !== 0 || o.values.uOffsetY.ref.value !== 0);
  if (o.state.visible) for (const [eye, bounds] of plateObstaclesInEyes([ring], views, { silhouette: true })[0].entries())
    for (const b of bounds) for (const occupied of b.cells) assert.equal(overlap(rect(o, views[eye]), occupied), false);

});

test('XR exit releases retained residue plates hidden by glass and respects representation visibility', async () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  for (const visible of [true, false]) {
    const o = plate([0, 0, -100]); o.values.uPlateBillboard = cell(0);
    const memory = new WeakMap(), placed = plateObstaclesInEyes([[[-.4, -.4, -1], [.4, .4, -1]]], views);
    capPlateInEyes({ objects: [o], views, cameraScale, memory, placed });
    assert.equal(o.state.visible, false); assert.equal(o.values.uPlateBillboard.ref.value, 1);
    const c = vm.createContext({ lessonFigure: { annotations: () => [] },
      inspectionLabel: { plate: true, representation: { obj: { data: { repr: { state: { visible }, renderObjects: [o] } } } } },
      plateEyeMemory: memory, releasePlateInEyes, fitDesktopPreview() {}, canRebuildForXr: () => false });
    vm.runInContext(pageFunction(source, 'releaseFigurePlates'), c);
    const exit = source.match(/onLeavingPresentation: (async \(\) => \{[^\n]+\}),/)[1];
    await vm.runInContext(`(${exit})`, c)();
    assert.equal(o.state.visible, visible); assert.equal(o.values.uPlateBillboard.ref.value, 0);
    assert.equal(o.values.uSizeFactor.ref.value, 4); assert.equal(memory.has(o), false);
  }
});

test('unrelated residue plates separate in both eyes without rebuilding geometry', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const objects = [plate([-2, 0, -180]), plate([2, 0, -180])];
  const selectors = objects.map(object => ({ obj: { data: { repr: { state: { visible: true }, renderObjects: [object] } } } }));
  const buffers = objects.map(object => object.values.aPosition.ref.value);
  const c = vm.createContext({ canvas: { camera: { scale: cameraScale } },
    componentLabels: { active: () => false }, plugin: { state: { data: { cells: new Map() } } },
    lessonFigure: { annotations: () => [] }, immersiveSession: null,
    inspectionLabel: { plate: true, representation: selectors[0], extraRepresentations: selectors.slice(1) },
    plateEyeMemory: new WeakMap(), capFigureAnnotations, capPlateInEyes, plateObstaclesInEyes });
  vm.runInContext(pageFunction(source, 'capDrawnPlates'), c);
  for (let frame = 0; frame < 3; frame++) {
    c.capDrawnPlates(views);
    assert.ok(objects.every(object => object.state.visible));
    for (const view of views) assert.equal(overlap(rect(objects[0], view), rect(objects[1], view)), false);
    objects.forEach((object, index) => assert.equal(object.values.aPosition.ref.value, buffers[index]));
  }
});
