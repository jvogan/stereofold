import { updateTetherCaption, tetherCaption } from './tether-caption.mjs';
import { readCachedDemoCoordinates } from './demo-cache.mjs';
import { getMaxSize } from "molstar/lib/mol-geo/geometry/size-data.js";
import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { createLessonFigure, resolveFigureLoci } from './lesson-figure.mjs';
import { createTetherRepresentations, tetherMatrix } from './animation-tethers.mjs';
import { createDesktopAnnotationSizing } from './desktop-annotations.mjs';
import { componentLabelPaint } from './component-labels.mjs';

// Real Mol* CPU text/line geometry; only font rasterization and GPU are stubbed.
// Font metrics are proportional to font size, unlike the tiny fixed-width atlas
// stub used by geometry-only tests, so overlap checks exercise realistic widths.
async function fixture(run, text = readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8')) {
  const previous = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({setAttribute(){}}),
    head: {appendChild(){}, removeChild(){}} };
  setCanvasModule({createCanvas: () => ({getContext: () => ({
    measureText(char) { return {width: parseFloat(this.font.match(/([\d.]+)px/)[1]) * (char === ' ' ? .3 : .55)}; },
    clearRect(){}, fillText(){}, getImageData: (_x,_y,w,h) => ({data:new Uint8ClampedArray(w*h*4).fill(255)}),
  })})});
  const plugin = new PluginContext(DefaultPluginSpec());
  try {
    await plugin.init();
    const raw = await plugin.builders.data.rawData({data:text});
    const trajectory = await plugin.build().to(raw).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
    const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory,{modelIndex:0}).commit();
    const structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel,{type:{name:'model',params:{}}}).commit();
    const camera = new Camera(undefined, {x:0,y:0,width:1000,height:700});
    const canvas = {camera, webgl:{pixelRatio:1}, xr:{isPresenting:{value:false}}, update(){},add(){},remove(){},mark(){},syncVisibility(){},getRenderObjects:()=>[]};
    plugin.canvas3d = canvas;
    const figure = createLessonFigure({plugin,getStructure:()=>structure,getTransform:()=>Mat4.identity()});
    const fit = (radius, mode='perspective', center=structure.obj.data.boundary.sphere.center) => {
      camera.setState({mode,...camera.getFocus(center,radius),radiusMax:1000}); camera.update();
    };
    await run({figure,canvas,fit,structure,plugin});
    await figure.forget();
  } finally { plugin.canvas3d=undefined; plugin.dispose(); globalThis.document=previous; }
}

// Independent readback of the actual billboard projection (text.vert).
function textRect(canvas, object) {
  const v=object.values, camera=canvas.camera, ratio=canvas.webgl.pixelRatio;
  const center=Vec3.transformMat4(Vec3(),v.aPosition.ref.value.subarray(0,3),v.aTransform.ref.value);
  Vec3.scale(center,center,camera.scale);
  const eye=Vec3.transformMat4(Vec3(),center,camera.view);
  const z=(v.uOffsetZ.ref.value+v.aDepth.ref.value[0]*.95)*camera.scale;
  if(camera.state.mode==='orthographic')eye[2]+=z;
  else Vec3.scaleAndAdd(eye,eye,Vec3.normalize(Vec3(),eye),-z);
  const factor=camera.projection[5]*camera.viewport.height/(2*ratio*(camera.state.mode==='orthographic'?1:-eye[2]));
  const ndc=Vec3.transformMat4(Vec3(),eye,camera.projection), map=v.aMapping.ref.value;
  const size=getMaxSize(v)*v.uSizeFactor.ref.value*camera.scale;
  const xs=[],ys=[];
  for(let i=0;i<map.length;i+=2){
    xs.push((ndc[0]+1)*camera.viewport.width/(2*ratio)+(map[i]*size+v.uOffsetX.ref.value*camera.scale)*factor);
    ys.push((ndc[1]+1)*camera.viewport.height/(2*ratio)+(map[i+1]*size+v.uOffsetY.ref.value*camera.scale)*factor);
  }
  return {height:.8*size*factor,left:Math.min(...xs),right:Math.max(...xs),bottom:Math.min(...ys),top:Math.max(...ys)};
}
function readable(canvas, representations) {
  const rects=representations.flatMap(r=>r.renderObjects).filter(o=>o.type==='text').map(o=>textRect(canvas,o));
  assert.ok(rects.length);
  for(const r of rects)assert.ok(r.height>=13.99&&r.height<=18.01,`character height ${r.height}`);
  for(let i=0;i<rects.length;i++)for(let j=0;j<i;j++){
    const a=rects[i],b=rects[j];
    assert.ok(a.right<=b.left||a.left>=b.right||a.top<=b.bottom||a.bottom>=b.top,'projected label backgrounds overlap');
  }
}
const label=(text,offsetY=8)=>({text,target:{chain:'A',componentId:'HEM'},color:'#123456',sizeFactor:1.2,offsetX:0,offsetY});

test('native component plates use the desktop depth-aware label pass without changing source or XR state',async()=>fixture(async({canvas,fit,structure,plugin})=>{
  const loci=resolveFigureLoci({chain:'A',componentId:'HEM'},structure.obj.data), refs=[];
  for(const [i,name] of ['Dyskerin 1','NOP10 1'].entries()){
    const ref=`component-test-${i}`;refs.push(ref);
    const builder=plugin.build().toRoot().apply(StateTransforms.Model.MultiStructureSelectionFromBundle,{
      selections:[{key:'a',ref:structure.ref,bundle:StructureElement.Bundle.fromLoci(loci)}],isTransitive:true,label:name,
    },{ref,dependsOn:[structure.ref]});
    builder.apply(StateTransforms.Representation.StructureSelectionsLabel3D,{
      customText:name,textSize:1,scaleByRadius:false,sizeFactor:1.5,offsetX:0,offsetY:0,
      ...componentLabelPaint({offsetZ:4,color:0x123456}).backing,
    },{ref:`${ref}-backing`});
    await builder.commit();
  }
  const representations=()=>refs.map(ref=>plugin.state.data.cells.get(`${ref}-backing`).obj.data.repr);
  const reprs=representations(), source=reprs.map(repr=>repr.getAllLoci()), versions=reprs.map(repr=>repr.geometryVersion);
  const objects=()=>representations().flatMap(repr=>repr.renderObjects);
  const size=createDesktopAnnotationSizing();fit(150);
  assert.ok(objects().every(object=>!object.state.stereofoldLessonLabel),'native component plates initially take the ordinary depth path');
  createDesktopAnnotationSizing({enabled:false})(canvas,[],reprs,[]);
  canvas.xr.isPresenting.value=true;size(canvas,[],reprs,[]);
  assert.ok(objects().every(object=>!object.state.stereofoldLessonLabel),'companion/XR plates retain their existing draw policy');
  canvas.xr.isPresenting.value=false;
  size(canvas,[],reprs,[]);
  assert.ok(objects().every(object=>object.state.stereofoldLessonLabel),'flat component plates must not lose their ink behind molecular geometry');
  readable(canvas,reprs);
  assert.deepEqual(reprs.map(repr=>repr.geometryVersion),versions);
  assert.deepEqual(reprs.map(repr=>repr.getAllLoci()),source);
  assert.equal(size(canvas,[],reprs,[]),false,'depth-pass enrollment settles without a redraw loop');
  await plugin.build().to(`${refs[1]}-backing`).update(params=>({...params,customText:'NOP10 edited'})).commit();
  fit(75);size(canvas,[],representations(),[]);
  assert.ok(objects().every(object=>object.state.stereofoldLessonLabel),'edited component geometry keeps the desktop visibility policy');
  readable(canvas,representations());
  for(const ref of refs)await plugin.build().delete(ref).commit();
}));

test('desktop figure, distance and name-plate billboards stay readable at fit, zoom, resize and HiDPI',async()=>fixture(async({figure,canvas,fit})=>{
  await figure.install({layers:[],labels:[label('Heme'),label('Iron',-8),{...label('Component name'),sizeFactor:1.5,offsetY:0}],
    distances:[{id:'local-distance',a:{chain:'A',residues:{from:1,to:1},atomName:'CA'},b:{chain:'A',residues:{from:2,to:2},atomName:'CA'},color:'#123456',sizeFactor:1,offsetX:0,offsetY:0}]});
  const size=createDesktopAnnotationSizing(), reprs=figure.annotations();
  const geometry=reprs.map(r=>r.geometryVersion);
  for(const mode of ['perspective','orthographic'])for(const radius of [75,150,15,300])for(const ratio of [1,2]){
    canvas.webgl.pixelRatio=ratio;canvas.camera.viewport.width=1000*ratio;canvas.camera.viewport.height=(radius===15?450:700)*ratio;fit(radius,mode);
    size(canvas,reprs);readable(canvas,reprs);
    assert.equal(size(canvas,reprs),false,'settled uniforms must not request endless redraws');
  }
  assert.deepEqual(reprs.map(r=>r.geometryVersion),geometry);
}));

test('explicit desktop label sizes retain pixels and wider offsets through zoom without changing XR',async()=>fixture(async({figure,canvas,fit})=>{
  const size=createDesktopAnnotationSizing();
  // A single label avoids collision corrections, exposing the authored offset cap.
  for(const desktopSizePx of [undefined,14,26,32,48]){
    const authored={...label('Binder 01',-25),offsetX:25,maxOffsetEm:5,...(desktopSizePx===undefined?{}:{desktopSizePx})};
    await figure.install({layers:[],distances:[],labels:[authored]});
    const reprs=figure.annotations(), object=reprs[0].renderObjects[0], v=object.values, version=reprs[0].geometryVersion;
    const expected=desktopSizePx??18, cap=desktopSizePx===undefined?2:5;
    for(const mode of ['perspective','orthographic'])for(const radius of [75,150,300])for(const ratio of [1,2]){
      canvas.webgl.pixelRatio=ratio;canvas.camera.viewport.width=1600*ratio;canvas.camera.viewport.height=1200*ratio;fit(radius,mode);
      size(canvas,reprs);
      const rect=textRect(canvas,object);
      assert.ok(Math.abs(rect.height-expected)<.01,`expected ${expected}px, got ${rect.height}`);
      const factor=rect.height/(.8*getMaxSize(v)*v.uSizeFactor.ref.value);
      assert.ok(Math.abs(v.uOffsetX.ref.value*factor-cap*expected)<.01,'explicit desktop size opts into the authored offset cap');
      assert.ok(Math.abs(v.uOffsetY.ref.value*factor+cap*expected)<.01);
      assert.equal(size(canvas,reprs),false);
    }
    assert.equal(reprs[0].geometryVersion,version,'sizing does not rebuild geometry');
    canvas.xr.isPresenting.value=true;
    const uniforms=[v.uSizeFactor.ref.version,v.uOffsetX.ref.version,v.uOffsetY.ref.version];
    fit(30);assert.equal(size(canvas,reprs),false);
    assert.deepEqual([v.uSizeFactor.ref.version,v.uOffsetX.ref.version,v.uOffsetY.ref.version],uniforms);
    canvas.xr.isPresenting.value=false;
  }
  // Changing only desktop metadata must invalidate the figure label cache.
  await figure.install({layers:[],distances:[],labels:[{...label('Binder 01',-25),offsetX:25,maxOffsetEm:5,desktopSizePx:32}]});
  fit(150);size(canvas,figure.annotations());
  assert.ok(Math.abs(textRect(canvas,figure.annotations()[0].renderObjects[0]).height-32)<.01);
}));

test('enlarged desktop labels reflow inside panel and chrome bounds at both pixel ratios',async()=>fixture(async({figure,canvas,fit})=>{
  await figure.install({layers:[],distances:[],labels:[
    {...label('Binder 01',25),desktopSizePx:32,offsetX:25,maxOffsetEm:5},
    {...label('Target 1',-25),desktopSizePx:26,offsetX:-25,maxOffsetEm:5},
  ]});
  const reprs=figure.annotations(), geometry=reprs.map(r=>r.geometryVersion);
  const size=createDesktopAnnotationSizing({topInset:48,bottomInset:48});
  for(const [width,height] of [[848,378],[565,530],[326,578]])for(const ratio of [1,2])for(const radius of [75,150])for(const sign of [-1,1]){
    canvas.webgl.pixelRatio=ratio;canvas.camera.viewport.width=width*ratio;canvas.camera.viewport.height=height*ratio;fit(radius);
    const c=canvas.camera.state, shift=[sign*radius*.72,sign*radius*.6,0];
    canvas.camera.setState({target:c.target.map((v,i)=>v-shift[i]),position:c.position.map((v,i)=>v-shift[i])});canvas.camera.update();
    size(canvas,reprs);
    const rects=reprs.map(r=>textRect(canvas,r.renderObjects[0]));
    for(const [i,r] of rects.entries()){
      assert.ok(Math.abs(r.height-[32,26][i])<.01);
      assert.ok(r.left>=3.99&&r.right<=width-3.99&&r.bottom>=51.99&&r.top<=height-51.99,`label crosses panel/chrome bounds: ${JSON.stringify(r)}`);
    }
    const [a,b]=rects;
    assert.ok(a.right<=b.left||a.left>=b.right||a.top<=b.bottom||a.bottom>=b.top,'enlarged backgrounds overlap');
    assert.equal(size(canvas,reprs),false);
  }
  assert.deepEqual(reprs.map(r=>r.geometryVersion),geometry);
}));

test('desktop labels stay inside actual panel bounds near edges after resize, zoom and source edits',async()=>fixture(async({figure,canvas,fit})=>{
  const size=createDesktopAnnotationSizing();
  // Several distinct labels on one atom force collision handling at the edge,
  // rather than merely clamping a single plate over its neighbours.
  for(const names of [['H1 · ADP·Pi','H2 · apo','Both bound'],['TP site · ATP analogue','E site · empty','Rotor marker']]){
    await figure.install({layers:[],distances:[],labels:names.map((name,i)=>({...label(name),offsetX:24,offsetY:i===0?24:-24}))});
    const reprs=figure.annotations(), geometry=reprs.map(r=>r.geometryVersion);
    for(const [width,height] of [[848,378],[565,530]])for(const ratio of [1,2])for(const radius of [75,150]){
      canvas.webgl.pixelRatio=ratio;canvas.camera.viewport.width=width*ratio;canvas.camera.viewport.height=height*ratio;
      fit(radius);
      // Move the camera target until the atom is near the top/right corner.
      const c=canvas.camera.state;
      const shift=[radius*.72,radius*.33,0];
      canvas.camera.setState({target:c.target.map((v,i)=>v-shift[i]),position:c.position.map((v,i)=>v-shift[i])});canvas.camera.update();
      size(canvas,reprs);readable(canvas,reprs);
      for(const repr of reprs)for(const object of repr.renderObjects.filter(o=>o.type==='text')){
        const r=textRect(canvas,object);
        assert.ok(r.left>=3.99&&r.bottom>=3.99&&r.right<=width-3.99&&r.top<=height-3.99,
          `label crosses ${width}×${height} panel: ${JSON.stringify(r)}`);
      }
      assert.equal(size(canvas,reprs),false,'viewport correction must converge without a draw loop');
    }
    assert.deepEqual(reprs.map(r=>r.geometryVersion),geometry,'reflow does not rebuild source text geometry');
  }
}));

test('a returning label reflows after an earlier visible label moved while it was hidden',async()=>fixture(async({figure,canvas,fit})=>{
  await figure.install({layers:[],distances:[],labels:[label('Heme',0),label('Iron',0)]});
  const reprs=figure.annotations(), size=createDesktopAnnotationSizing();
  fit(150);size(canvas,reprs);readable(canvas,reprs);
  const before=reprs.map(repr=>textRect(canvas,repr.renderObjects[0]));
  reprs[1].setState({visible:false});
  // Move the first label into the absent label's old lane. Its new geometry
  // settles while the trailing cache slot is unvisited.
  const props=reprs[0].props;
  await reprs[0].createOrUpdate({...props,offsetY:(before[1].bottom-before[0].bottom)/16}).run();
  size(canvas,reprs);
  assert.equal(size(canvas,reprs),false);
  reprs[1].setState({visible:true});
  size(canvas,reprs);readable(canvas,reprs);
  assert.equal(size(canvas,reprs),false,'consecutive visible reads still reuse the settled layout');
}));

test('desktop labels clear reserved toolbar and caption rows at both pixel ratios',async()=>fixture(async({figure,canvas,fit})=>{
  await figure.install({layers:[],distances:[],labels:[label('Head 1',0),label('Head 2',0),label('State caption',0)]});
  const reprs=figure.annotations(), size=createDesktopAnnotationSizing({topInset:48,bottomInset:48});
  for(const [width,height] of [[848,378],[586,578],[326,578]])for(const ratio of [1,2])for(const sign of [-1,1]){
    canvas.webgl.pixelRatio=ratio;canvas.camera.viewport.width=width*ratio;canvas.camera.viewport.height=height*ratio;
    fit(150);
    const c=canvas.camera.state, shift=[0,sign*200,0];
    canvas.camera.setState({target:c.target.map((v,i)=>v-shift[i]),position:c.position.map((v,i)=>v-shift[i])});canvas.camera.update();
    size(canvas,reprs);readable(canvas,reprs);
    for(const repr of reprs){
      const r=textRect(canvas,repr.renderObjects[0]);
      assert.ok(r.bottom>=51.99 && r.top<=height-51.99,`label enters a reserved chrome row: ${JSON.stringify(r)}`);
    }
    assert.equal(size(canvas,reprs),false,'fixed chrome insets retain stable cached layouts');
  }
}));

test('desktop tether stroke is at least two pixels and text follows the same policy; headset uniforms stay unchanged',async()=>fixture(async({canvas,fit})=>{
  const tether={id:'tether',label:'Neck linker',color:'#123456',from:{position:[0,0,0]},to:{position:[30,0,0]}};
  const {line,label}=await createTetherRepresentations(tether);
  try{
    const objects=[line,label].flatMap(r=>r.renderObjects), versions=objects.map(o=>o.values.uSizeFactor.ref.version);
    const size=createDesktopAnnotationSizing();
    line.setState({transform:tetherMatrix([0,0,0],[30,0,-80])});
    fit(150);
    assert.equal(createDesktopAnnotationSizing({enabled:false})(canvas,[line,label]),false);
    canvas.xr.isPresenting.value=true;
    assert.equal(size(canvas,[line,label]),false);
    assert.deepEqual(objects.map(o=>o.values.uSizeFactor.ref.version),versions);
    canvas.xr.isPresenting.value=false;
    for(const radius of [75,150,300,15]){
      fit(radius);size(canvas,[line,label]);readable(canvas,[label]);
      const v=line.renderObjects[0].values, eye=Vec3.transformMat4(Vec3(),[30,0,-80],canvas.camera.view);
      const pixelsPerUnit=canvas.camera.projection[5]*canvas.camera.viewport.height/(2*-eye[2]);
      assert.ok(2*getMaxSize(v)*v.uSizeFactor.ref.value*pixelsPerUnit>=1.99);
    }
  }finally{line.destroy();label.destroy();}
}));

// Optional cached composites exercise the exact authored close-up chapters,
// without a download or a browser. The regular regressions above are portable.
for(const [stage,chapter] of [['flipbook','heme'],['motion','overlay']]){
  test(`authored hemoglobin ${chapter} has readable, nonoverlapping projected labels`,{skip:!process.env.STEREOFOLD_DEMO_CACHE},async()=>{
    const lesson=JSON.parse(readFileSync(new URL(`../../plugin/demos/hemoglobin-switch/${stage}.json`,import.meta.url),'utf8'));
    const authored=lesson.chapters.find(c=>c.id===chapter).immersive.figure;
    // A chapter whose plates were moved to the colour key has nothing to project.
    if(!authored?.labels?.length)return;
    await fixture(async({figure,canvas,fit,structure})=>{
      await figure.install({distances:[],...authored,layers:[]});
      const size=createDesktopAnnotationSizing();
      const loci=authored.labels.map(label=>resolveFigureLoci(label.target,structure.obj.data)).reduce((a,b)=>StructureElement.Loci.union(a,b));
      const sphere=StructureElement.Loci.getBoundingSphere(loci);
      for(const radius of [sphere.radius,sphere.radius*1.5]){fit(radius,'perspective',sphere.center);size(canvas,figure.annotations());readable(canvas,figure.annotations());}
    },readCachedDemoCoordinates('hemoglobin-switch',stage));
  });
}

for(const demo of ['kinesin-walk','atp-synthase-rotor','hemoglobin-switch'])for(const stage of ['motion','flipbook','cycle','figure']){
  const lessonPath=process.env.STEREOFOLD_DEMO_ROOT ? `${process.env.STEREOFOLD_DEMO_ROOT}/${demo}/${stage}.json`
    : new URL(`../../plugin/demos/${demo}/${stage}.json`,import.meta.url);
  test(`${demo} ${stage} overview labels fit the desktop size band`,{skip:!process.env.STEREOFOLD_DEMO_CACHE || !existsSync(lessonPath)},async()=>{
    const lesson=JSON.parse(readFileSync(lessonPath,'utf8'));
    const authored=lesson.chapters[0].immersive.figure;
    await fixture(async({figure,canvas,fit,structure})=>{
      await figure.install({distances:[],...authored,layers:[]});
      fit(structure.obj.data.boundary.sphere.radius);
      createDesktopAnnotationSizing()(canvas,figure.annotations());
      readable(canvas,figure.annotations());
    },readCachedDemoCoordinates(demo,stage));
  });
}

test('the desktop viewer sizes lesson, component-name and tether paths; the companion page never changes them',async()=>fixture(async({figure,canvas,fit,plugin})=>{
  await figure.install({layers:[],distances:[],labels:[label('Lesson label'),label('Component name'),label('Tether label')]});
  const reprs=figure.annotations();fit(150);
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  const sizeDesktopAnnotations =');
  const code=source.slice(start,source.indexOf('  canvas.notifyDidDraw =',start))+'\nglobalThis.refresh=refreshDesktopAnnotations;';
  let beforeRender,draws=0;
  canvas.beforeRender={subscribe:callback=>{beforeRender=callback;return {unsubscribe(){}};}};
  canvas.requestDraw=()=>draws++;
  const input={canvas,plugin,componentLabels:{refs:out=>out},createDesktopAnnotationSizing,lessonFigure:{annotations:()=>[reprs[0]]},
    componentLabelRepresentations:()=>[reprs[1]],molecularAnimation:{tetherRepresentations:()=>[reprs[2]]}};
  const versions=reprs.map(r=>r.renderObjects[0].values.uSizeFactor.ref.version);
  const companion=vm.createContext({...input,enableXr:true});vm.runInContext(code,companion);companion.refresh();
  assert.deepEqual(reprs.map(r=>r.renderObjects[0].values.uSizeFactor.ref.version),versions);assert.equal(draws,0);
  const desktop=vm.createContext({...input,enableXr:false});vm.runInContext(code,desktop);beforeRender();
  readable(canvas,reprs);assert.equal(draws,1);desktop.refresh();assert.equal(draws,1);
  // Move a tether onto a head between frames. Only the pre-render callback
  // runs: the first drawn pose must already have separated plates.
  const versionsBefore=reprs.map(r=>r.geometryVersion);
  for (const shift of [80, 0, -30, 0]) {
    reprs[2].setState({transform:Mat4.fromTranslation(Mat4(),[shift,0,0])});
    beforeRender(); readable(canvas,reprs);
  }
  assert.deepEqual(reprs.map(r=>r.geometryVersion),versionsBefore);
}));


test('desktop chain and residue plates clear the target radius at scaled placements without larger text',async()=>fixture(async({figure,canvas,fit,structure})=>{
  const labels=[{...label('Whole chain'),target:{chain:'A'}},{...label('Residue'),target:{chain:'A',residues:{from:1,to:1}}}];
  await figure.install({layers:[],distances:[],labels});
  const reprs=figure.annotations(), size=createDesktopAnnotationSizing();
  for(const scale of [.5,1,2])for(const mode of ['perspective','orthographic']){
    fit(200,mode);
    for(let i=0;i<reprs.length;i++){
      const repr=reprs[i], radius=StructureElement.Loci.getBoundingSphere(resolveFigureLoci(labels[i].target,structure.obj.data)).radius;
      repr.setState({transform:Mat4.fromUniformScaling(Mat4(),scale)});
      size(canvas,reprs);
      const v=repr.renderObjects[0].values;
      assert.ok(Math.abs(v.uOffsetZ.ref.value-(radius*scale+3))<1e-6);
      assert.equal(repr.props.offsetZ,3,'saved/authored offset stays unchanged');
      assert.ok(v.boundingSphere.ref.value.radius>v.uOffsetZ.ref.value);
    }
    readable(canvas,reprs);
  }
}));

// Exercise every shipped measurement style through actual Mol* geometry.
// Substitute local atom targets only, so the check needs no network/cache.
test('all authored lesson measurements use dark readout ink and retain their line colours in flat and XR figures',async()=>fixture(async({figure,canvas,fit})=>{
  const root=new URL('../../plugin/demos/',import.meta.url);
  const lessons=readdirSync(root,{recursive:true}).filter(p=>p.endsWith('.json'));
  const checked=new Set();
  for(const file of lessons){
    const lesson=JSON.parse(readFileSync(new URL(file,root),'utf8'));
    for(const chapter of lesson.chapters??[])for(const distance of chapter.immersive?.figure?.distances??[]){
      checked.add(file);
      const authored={sizeFactor:1,offsetX:0,offsetY:0,...distance,expectedAngstrom:undefined,
        a:{chain:'A',residues:{from:1,to:1},atomName:'CA'},b:{chain:'A',residues:{from:2,to:2},atomName:'CA'}};
      for(const xr of [false,true]){
        canvas.xr.isPresenting.value=xr;
        await figure.install({layers:[],labels:[],distances:[authored]});
        const reprs=figure.annotations();
        const text=reprs.flatMap(r=>r.renderObjects).filter(o=>o.type==='text');
        assert.equal(text.length,distance.showText===false?0:1);
        for(const object of text) {
          assert.equal(object.state.stereofoldLessonLabel,true,'distance plates opt into the label-only visibility pass');
          const v=object.values;
          if(v.dColorType.ref.value==='uniform') assert.deepEqual(Array.from(v.uColor.ref.value),[48/255,56/255,64/255].map(Math.fround));
          else assert.deepEqual(Array.from(v.tColor.ref.value.array.slice(0,3)),[48,56,64]);
        }
        const line=reprs.find(r=>r.renderObjects.some(o=>o.type==='cylinders'));
        assert.ok(line.renderObjects.every(o=>!o.state.stereofoldLessonLabel),'distance strokes retain molecular depth');
        assert.deepEqual(Array.from(line.renderObjects[0].values.tColor.ref.value.array.slice(0,3)),[1,3,5].map(i=>parseInt(distance.color.slice(i,i+2),16)));
        if(!xr && text.length){fit(100);createDesktopAnnotationSizing()(canvas,reprs);readable(canvas,reprs);}
      }
    }
  }
  // The connected kinesin motion no longer authors a distance marker.
  assert.deepEqual([...checked].sort(),[
    'atp-synthase-rotor/flipbook.json','atp-synthase-rotor/motion.json',
    'daraxonrasib.json','hemoglobin-switch/flipbook.json','kinesin-walk/flipbook.json',
  ]);
}));

test('desktop automatic tether caption clears its join and a midpoint plate while authored offsets follow label sizing',async()=>fixture(async({canvas,fit})=>{
  const tether={id:'link',label:'Unmodelled linker',from:{position:[-20,10,0]},to:{position:[20,10,0]},centre:[0,0,0]};
  const auto=await createTetherRepresentations(tether);
  const fixed=await createTetherRepresentations({...tether,id:'distance',label:'81.50 Å',offsetX:0,offsetY:0});
  try {
    const size=createDesktopAnnotationSizing();
    for(const radius of [75,150,300,15]) {
      fit(radius,'orthographic',[0,0,0]);
      for(const pair of [auto,fixed]) {
        pair.label.setState({transform:Mat4.fromTranslation(Mat4(),[0,10,0])});
        updateTetherCaption(pair.label,tether.from.position,tether.to.position,Mat4.identity());
      }
      size(canvas,[fixed.label],[],[auto.line,auto.label]);
      readable(canvas,[fixed.label,auto.label]);
      const v=auto.label.renderObjects[0].values,c=tetherCaption(auto.label);
      assert.ok(v.uOffsetY.ref.value>=c.halfHeight*getMaxSize(v)*v.uSizeFactor.ref.value);
      assert.equal(v.uOffsetX.ref.value,0);
      assert.equal(fixed.label.renderObjects[0].values.uOffsetY.ref.value,0,'explicit zero remains centred');
    }
  }finally{auto.line.destroy();auto.label.destroy();fixed.line.destroy();fixed.label.destroy();}
}));
