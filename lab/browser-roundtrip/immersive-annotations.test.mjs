import { tetherCaption } from './tether-caption.mjs';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Camera } from 'molstar/lib/mol-canvas3d/camera.js';
import { text_vert } from 'molstar/lib/mol-gl/shader/text.vert.js';
import { motionFixture, sixBodyAnimation } from './motion-benchmark-fixture.mjs';
import { FIGURE_REFERENCE_SCALE, sizeImmersiveAnnotation, cylinderRadiusScale, annotationFieldBounds } from './immersive-annotations.mjs';
import { holdHeadRotationZero } from './head-rotation-lock.mjs';
import { tetherMatrix } from './animation-tethers.mjs';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { resolveFigureLoci, lociPositions } from './lesson-figure.mjs';
import { readCachedDemoCoordinates } from './demo-cache.mjs';
import { TETHER_RADIUS_ANGSTROM, TETHER_MIN_DIAMETER_METERS } from './animation-tethers.mjs';
import { createDashedLineRepresentation } from './lesson-figure.mjs';

// Real Mol* text/cylinder buffers; read back the shader's em and depth equations.
// Rasterization and GPU execution are not part of this CPU regression.
test('hemoglobin-calibrated glyph angles survive ATP/kinesin scale, rotation and placement; plates clear their target',async()=>{
  const h=await motionFixture();
  try {
    const label=h.figure.annotations()[0], v=label.renderObjects[0].values;
    const version=label.geometryVersion, mapping=v.aMapping.ref.value;
    assert.ok(v.aDepth.ref.value.every(depth=>depth===0),'scaleByRadius:false removes the built-in surface stand-off');
    assert.ok(mapping.some((y,i)=>i%2===1&&y!==mapping[1]),'the actual text/background geometry has nonzero height');
    const radius=StructureElement.Loci.getBoundingSphere(resolveFigureLoci({chain:'H0'},h.structure.obj.data)).radius;
    const camera=new Camera();const release=holdHeadRotationZero(camera);
    assert.ok(text_vert.includes('clip.xy += vec2(uProjection[0][0], uProjection[1][1]) * cornerOffset'));
    let reference;
    for(const scale of [FIGURE_REFERENCE_SCALE,.00777,.00504]) for(const yaw of [0,Math.PI/2,Math.PI]) for(const placement of [.5,1,2.4]){
      Mat4.fromRotation(camera.headRotation,yaw,[0,1,0]);assert.ok(Mat4.isZero(camera.headRotation));
      h.canvas.camera.scale=scale;
      const matrix=Mat4.fromRotation(Mat4(),yaw,[0,1,0]);Mat4.scale(matrix,matrix,[placement,placement,placement]);
      label.setState({transform:matrix});sizeImmersiveAnnotation(label,h.canvas);
      const em=.8*getMaxSize(v)*v.uSizeFactor.ref.value*scale;
      reference??=em;assert.ok(Math.abs(em-reference)<1e-8);
      assert.ok(Math.abs(v.uSizeFactor.ref.value-6*.6*FIGURE_REFERENCE_SCALE/scale)<1e-6);
      assert.ok(Math.abs(v.uOffsetZ.ref.value-(Math.min(radius,3)*placement+3*FIGURE_REFERENCE_SCALE/scale))<1e-6,
        'a plate clears its anchor residue, not the whole selection it names');
      const degrees=2*Math.atan(em/(2*2.35))*180/Math.PI;
      assert.ok(degrees>1.6&&degrees<1.8,`default-placement em: ${degrees} degrees`);
      assert.equal(sizeImmersiveAnnotation(label,h.canvas),false);
      assert.equal(v.aMapping.ref.value,mapping);assert.equal(label.geometryVersion,version);
    }
    release();
    const before=v.uSizeFactor.ref.version;h.canvas.xr.isPresenting.value=false;h.canvas.camera.scale=1;
    assert.equal(sizeImmersiveAnnotation(label,h.canvas),false);assert.equal(v.uSizeFactor.ref.version,before);
  }finally{await h.dispose();}
});

test('solid tethers exceed two native eye pixels without changing measurement strokes or geometry',async()=>{
  const h=await motionFixture();
  try{
    const [line,label]=h.registry.tetherRepresentations();
    const version=line.geometryVersion, values=line.renderObjects[0].values;
    assert.equal(getMaxSize(values), TETHER_RADIUS_ANGSTROM);
    // All impostor vertices belong to the same complete unit segment.
    for (let i=0;i<values.aStart.ref.value.length;i+=3) {
      assert.deepEqual([...values.aStart.ref.value.slice(i,i+3)],[0,0,0]);
      assert.deepEqual([...values.aEnd.ref.value.slice(i,i+3)],[0,0,1]);
    }
    assert.ok(label.renderObjects.every(o=>o.state.stereofoldLessonLabel),'moving tether plates use the lesson visibility pass');
    assert.ok(line.renderObjects.every(o=>!o.state.stereofoldLessonLabel),'tether strokes retain molecular depth');
    for(const scale of [.02421,.00777,.00502])for(const placement of [.5,1,1.7,1.9,2.4])for(const length of [1,30,120]){
      h.canvas.camera.scale=scale;
      const matrix=Mat4.mul(Mat4(),Mat4.fromScaling(Mat4(),[placement,placement,placement]),tetherMatrix([0,0,0],[0,length,0]));
      line.setState({transform:matrix});sizeImmersiveAnnotation(line,h.canvas);sizeImmersiveAnnotation(label,h.canvas);
      const v=line.renderObjects[0].values;
      const diameter=2*getMaxSize(v)*v.uSizeFactor.ref.value*scale*cylinderRadiusScale(matrix);
      assert.ok(diameter>=TETHER_MIN_DIAMETER_METERS-1e-6,`actual shader diameter ${diameter}`);
      // 1832 native pixels/eye, 85% viewport, conservative 110-degree field,
      // and the report's 3.481 m eye distance rounded up to 3.5 m.
      const focalPixels=1832*.85/(2*Math.tan(55*Math.PI/180));
      assert.ok(diameter*focalPixels/3.5>=2,`projected device width ${diameter*focalPixels/3.5}`);
      assert.ok(Math.abs(label.renderObjects[0].values.uSizeFactor.ref.value*scale-6*FIGURE_REFERENCE_SCALE)<1e-6);
    }
    assert.equal(line.geometryVersion,version);
    const measurement=await createDashedLineRepresentation('distance',[0,0,0],[0,0,10],'#ffffff');
    try { assert.ok(Math.abs(getMaxSize(measurement.renderObjects[0].values)-.07)<1e-6); }
    finally { measurement.destroy(); }
  }finally{await h.dispose();}
});

for(const [demo,scale] of [['hemoglobin-switch',.02421],['atp-synthase-rotor',.00777],['kinesin-walk',.00504]]){
  test(`${demo} actual composite figures retain hemoglobin's physical glyph size`,{skip:!process.env.STEREOFOLD_DEMO_CACHE},async()=>{
    const {readFileSync}=await import('node:fs');
    const root=process.env.STEREOFOLD_DEMO_ROOT??new URL('../../plugin/demos/',import.meta.url).pathname;
    const chapter=JSON.parse(readFileSync(`${root}/${demo}/motion.json`,'utf8')).chapters[0];
    const figure={distances:[],...chapter.immersive.figure};
    const h=await motionFixture({source:readCachedDemoCoordinates(demo,'motion'),animation:null});
    try{
      h.canvas.camera.scale=scale;await h.figure.install(figure);
      const reprs=h.figure.annotations();assert.ok(reprs.length>=figure.labels.length);
      for(let i=0;i<figure.labels.length;i++){
        // A plate hidden by the visibility rule is sized on the frame it shows.
        if(!reprs[i].state.visible){reprs[i].setState({visible:true});sizeImmersiveAnnotation(reprs[i],h.canvas);}
        const authored=figure.labels[i],v=reprs[i].renderObjects[0].values;
        const height=.8*getMaxSize(v)*v.uSizeFactor.ref.value*scale;
        assert.ok(Math.abs(height-.8*6*authored.sizeFactor*FIGURE_REFERENCE_SCALE)<1e-6);
        const em=.8*getMaxSize(v)*v.uSizeFactor.ref.value;
        // A label may raise its own headset cap (`maxOffsetEm`, 2-5 character boxes).
        const cap=(authored.maxOffsetEm??2)*em;
        assert.ok(Math.abs(v.uOffsetX.ref.value)<=cap+1e-9&&Math.abs(v.uOffsetY.ref.value)<=cap+1e-9,'offset within the label\'s cap');
        assert.ok(v.uOffsetZ.ref.value<=3+3*FIGURE_REFERENCE_SCALE/scale+1e-9,'stand-off capped at 3 Å');
      }
    }finally{await h.dispose();}
  });
}

test('XR caption offsets keep their authored direction within the desktop clamp and default plate clearance across motion and scale', async()=>{
  const animation=structuredClone(sixBodyAnimation);
  animation.tethers[1].offsetX=-12;animation.tethers[1].offsetY=20;
  const h=await motionFixture({animation});
  try {
    const [,automatic,,authored]=h.registry.tetherRepresentations();
    const caption=tetherCaption(automatic), geometry=automatic.geometryVersion;
    for(const scale of [.02421,.00777,.00504]) for(const time of [0,.4,1.5]) {
      h.canvas.camera.scale=scale;h.registry.control({state:'pause',seekSeconds:time});
      sizeImmersiveAnnotation(automatic,h.canvas);sizeImmersiveAnnotation(authored,h.canvas);
      const a=authored.renderObjects[0].values,v=automatic.renderObjects[0].values;
      // Authored captions keep their direction within two character boxes.
      const em=.8*getMaxSize(a)*a.uSizeFactor.ref.value;
      assert.ok(Math.abs(a.uOffsetX.ref.value+2*em)<1e-6);
      assert.ok(Math.abs(a.uOffsetY.ref.value-2*em)<1e-6);
      const unit=getMaxSize(v)*v.uSizeFactor.ref.value;
      assert.ok(Math.hypot(v.uOffsetX.ref.value,v.uOffsetY.ref.value)>=caption.halfHeight*unit);
      assert.equal(sizeImmersiveAnnotation(automatic,h.canvas),false);
      assert.equal(automatic.geometryVersion,geometry);
    }
  }finally{await h.dispose();}
});

// A chain-wide plate on its bounding-sphere centre can float in the space
// between helices. In XR it sits on the atom that faces the wearer instead.
test('a wide XR plate anchors on the surface that faces the wearer, re-picked past 20 degrees, without a rebuild',async()=>{
  const h=await motionFixture();
  try {
    const label=h.figure.annotations()[0], v=label.renderObjects.find(o=>o.type==='text').values;
    const loci=resolveFigureLoci({chain:'H0'},h.structure.obj.data), sphere=StructureElement.Loci.getBoundingSphere(loci);
    const atoms=lociPositions(loci), version=label.geometryVersion, positions=v.aPosition.ref.value;
    const extreme=axis=>{let best=-Infinity;for(let i=0;i<atoms.length;i+=3)best=Math.max(best,(atoms[i]-sphere.center[0])*axis[0]+(atoms[i+1]-sphere.center[1])*axis[1]+(atoms[i+2]-sphere.center[2])*axis[2]);return best;};
    const eye=(axis,distance=400)=>Vec3.transformMat4(Vec3(),Vec3.scaleAndAdd(Vec3(),sphere.center,Vec3.create(...axis),distance),v.matrix.ref.value);
    const anchor=()=>Vec3.create(positions[0],positions[1],positions[2]);
    const along=axis=>Vec3.dot(Vec3.sub(Vec3(),anchor(),sphere.center),Vec3.create(...axis));
    assert.ok(sphere.radius>6);
    // A plate hidden by the visibility rule is sized on the frame it shows.
    if(!label.state.visible) label.setState({visible:true});
    assert.ok(Vec3.distance(anchor(),sphere.center)<1e-3,'a plate starts at its selection centre');
    sizeImmersiveAnnotation(label,h.canvas);
    assert.ok(Vec3.distance(anchor(),sphere.center)<1e-3,'no eye, no anchor change');
    sizeImmersiveAnnotation(label,h.canvas,eye([1,0,0]));
    assert.ok(along([1,0,0])>.8*extreme([1,0,0]),`facing +x: ${along([1,0,0])} of ${extreme([1,0,0])} Å`);
    for(let i=0;i<positions.length;i+=3)assert.deepEqual([positions[i],positions[i+1],positions[i+2]],[...anchor()]);
    const first=anchor(), turn=10*Math.PI/180;
    assert.equal(sizeImmersiveAnnotation(label,h.canvas,eye([Math.cos(turn),Math.sin(turn),0])),false,'a small turn keeps the anchor');
    assert.deepEqual([...anchor()],[...first]);
    sizeImmersiveAnnotation(label,h.canvas,eye([-1,0,0]));
    assert.ok(along([-1,0,0])>.8*extreme([-1,0,0]),'walking round re-anchors on the near side');
    assert.equal(label.geometryVersion,version,'a buffer rewrite, not a geometry rebuild');
    const bounds=v.boundingSphere.ref.value;
    assert.ok(Vec3.distance(bounds.center,Vec3.transformMat4(Vec3(),anchor(),v.matrix.ref.value))<=bounds.radius,'bounds cover the moved anchor');
  }finally{await h.dispose();}
});


test('ATP chapter 6 measurement spans its endpoints with a 2-3 pixel XR stroke and no motion rebuild',
  { skip: !process.env.STEREOFOLD_DEMO_CACHE && 'requires the verified public demo coordinate cache' }, async () => {
  const { readFileSync } = await import('node:fs');
  const chapter = JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase-rotor/motion.json', import.meta.url))).chapters[5];
  const h = await motionFixture({ source: readCachedDemoCoordinates('atp-synthase-rotor', 'motion'), animation: null });
  try {
    h.canvas.camera.scale = .00777;
    await h.figure.install({ layers: [], labels: [], distances: chapter.immersive.figure.distances });
    const line = h.figure.annotations().find(repr => repr.renderObjects.some(o => o.type === 'cylinders'));
    assert.ok(line);
    line.setState({ visible: true });
    const v = line.renderObjects[0].values, geometry = line.geometryVersion, starts = v.aStart.ref.value, ends = v.aEnd.ref.value;
    const { a, b } = chapter.immersive.figure.distances[0];
    const targets = [a, b];
    const endpoints = targets.map(target => StructureElement.Loci.getBoundingSphere(resolveFigureLoci(target, h.structure.obj.data)).center);
    const length = Vec3.distance(...endpoints);
    assert.ok(length > 110 && length < 113, 'the actual 11 nm ATP measurement');
    for (const point of endpoints) {
      let nearest = Infinity;
      for (const buffer of [starts, ends]) for (let i = 0; i < buffer.length; i += 3)
        nearest = Math.min(nearest, Math.hypot(buffer[i] - point[0], buffer[i+1] - point[1], buffer[i+2] - point[2]));
      assert.ok(nearest <= length / 40 + 1e-4, 'dashes reach both molecular endpoints');
    }
    const focalPixels = 1832 * .85 / (2 * Math.tan(55 * Math.PI / 180));
    sizeImmersiveAnnotation(line, h.canvas);
    const diameter = () => 2 * getMaxSize(v) * v.uSizeFactor.ref.value * h.canvas.camera.scale * cylinderRadiusScale(v.matrix.ref.value);
    const pixels = diameter() * focalPixels / 4.6;
    assert.ok(pixels >= 2 && pixels <= 3, `default seat width ${pixels} px`);
    const dash = Math.hypot(...[0,1,2].map(i => ends[i] - starts[i]));
    assert.ok(dash * h.canvas.camera.scale >= diameter(), 'dashes must be longer than their width');
    for (const scale of [.005, .00777, .02421]) for (const placement of [.5, 1, 3]) {
      h.canvas.camera.scale = scale;
      line.setState({ transform: Mat4.fromScaling(Mat4(), [placement, placement, placement]) });
      sizeImmersiveAnnotation(line, h.canvas);
      assert.ok(diameter() >= .02 - 1e-6);
      assert.ok(diameter() >= length / 150 * scale * placement - 1e-6, 'long lines also retain proportional width');
      assert.equal(sizeImmersiveAnnotation(line, h.canvas), false);
    }
    assert.equal(line.geometryVersion, geometry);
    assert.equal(v.aStart.ref.value, starts); assert.equal(v.aEnd.ref.value, ends);
    h.canvas.xr.isPresenting.value = false;
    await h.figure.install({ layers: [], labels: [], distances: chapter.immersive.figure.distances });
    const desktop = h.figure.annotations().find(repr => repr.renderObjects.some(o => o.type === 'cylinders'));
    assert.ok(Math.abs(getMaxSize(desktop.renderObjects[0].values) - .07) < 1e-6);
    assert.equal(desktop.renderObjects[0].values.uSizeFactor.ref.value, 1);
  } finally { await h.dispose(); }
});


test('per-label maxOffsetEm raises only its XR cap and updates on a cap-only edit', async()=>{
  const h=await motionFixture({animation:null});
  const label={id:'raised',text:'Head',target:{chain:'H0',residues:{from:10,to:10},atomName:'CA'},
    color:'#246080',sizeFactor:1.1,offsetX:100,offsetY:-100,maxOffsetEm:4};
  const normal={...label,id:'default'};delete normal.maxOffsetEm;
  const figure={layers:[],distances:[],labels:[label,normal]};
  try {
    for(const cap of [4,3,2]) {
      label.maxOffsetEm=cap;await h.figure.install(figure);
      for(const scale of [.02421,.00777,.00504]) for(const placement of [.5,1,2.4]) {
        h.canvas.camera.scale=scale;
        for(const [i,repr] of h.figure.annotations().entries()) {
          repr.setState({visible:true,transform:Mat4.fromScaling(Mat4(),[placement,placement,placement])});
          sizeImmersiveAnnotation(repr,h.canvas);
          const object=repr.renderObjects.find(o=>o.type==='text'),v=object.values;
          const em=.8*getMaxSize(v)*v.uSizeFactor.ref.value,expected=(i===0?cap:2)*em;
          assert.ok(Math.abs(v.uOffsetX.ref.value-expected)<1e-6,'positive cap in character boxes');
          assert.ok(Math.abs(v.uOffsetY.ref.value+expected)<1e-6,'negative cap in character boxes');
          const bounds=annotationFieldBounds(repr,object,scale,placement);
          assert.ok(Math.abs(bounds.offset[0]-expected)<1e-6,'fitting uses the drawn cap');
          assert.ok(Math.abs(bounds.offset[1]+expected)<1e-6);
          assert.equal(sizeImmersiveAnnotation(repr,h.canvas),false);
        }
      }
    }
    label.maxOffsetEm=4;label.offsetX=8;label.offsetY=-8;
    await h.figure.install(figure);
    const repr=h.figure.annotations()[0];repr.setState({visible:true});sizeImmersiveAnnotation(repr,h.canvas);
    assert.ok(Math.abs(repr.renderObjects[0].values.uOffsetX.ref.value-8*FIGURE_REFERENCE_SCALE/h.canvas.camera.scale)<1e-6,
      'an offset below the cap keeps its authored length');
    label.offsetX=normal.offsetX;label.offsetY=normal.offsetY;
    h.canvas.xr.isPresenting.value=false;await h.figure.install(figure);
    const [raised,defaultPlate]=h.figure.annotations().map(r=>r.renderObjects[0].values);
    assert.equal(raised.uOffsetX.ref.value,defaultPlate.uOffsetX.ref.value,'the headset cap leaves desktop offsets unchanged');
    assert.equal(raised.uOffsetY.ref.value,defaultPlate.uOffsetY.ref.value);
  } finally {await h.dispose();}
});
