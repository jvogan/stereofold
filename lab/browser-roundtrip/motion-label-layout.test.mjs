import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coordinates, walkPlateAllowance } from './fixtures/kinesin-layout.mjs';
import { demoSeats, sampleTimes, prepareLabelScene, labelFrame } from './fixtures/motion-label-layout.mjs';
import { platesOverlap, countPlateOverlaps, PLATE_FIELD } from './label-layout.mjs';
import { motionFixture } from './motion-benchmark-fixture.mjs';
import { sizeImmersiveAnnotation, FIGURE_REFERENCE_SCALE } from './immersive-annotations.mjs';
import { resolveFigureLoci, lociPositions } from './lesson-figure.mjs';
const cache=process.env.STEREOFOLD_DEMO_CACHE;
// XR draws a plate on or right beside its own part, so it may cover that part
// and its neighbours in a packed assembly. It must not hide another plate's
// anchor, or the wearer loses the part that plate names. The one exception is
// an anchor on a part the plate may briefly cover: a walking head's plate
// crossing the stalk, or a bound head's plate over the head waiting behind it.
for(const [name,seat] of Object.entries(demoSeats)) test(`${name}: every motion-chapter plate clears other plates and their anchors`,{skip:!cache},()=>{
  const lesson=JSON.parse(readFileSync(new URL(`../../plugin/demos/${name}/motion.json`,import.meta.url)));
  const atoms=coordinates(`${cache}/${seat.file}`,lesson.provenance.sourceSha256);
  for(const chapter of lesson.chapters) {
    const scene=prepareLabelScene(chapter,atoms), allow=name==='kinesin-walk'?walkPlateAllowance(chapter):()=>false;
    for(const yaw of name==='kinesin-walk'?[-.35,0,.35]:[0]) for(const pitch of name==='kinesin-walk'?[-.2,0,.2]:[0]) for(const placement of [1,seat.placement]) for(const eye of [-.032,.032]) for(const t of sampleTimes(chapter)) {
      const f=labelFrame(scene,{...seat,yaw,pitch},t,placement,eye),where=`${name}/${chapter.id} at ${t}, yaw ${yaw}, pitch ${pitch}, scale ${placement}, eye ${eye}`;
      for(const label of f.labels) for(const other of f.labels) if(other!==label)
        assert.ok(!platesOverlap(label,{rect:other.anchorRect}) || allow(label.id,other.chain,t),`${where}: ${label.id} covers the anchor of ${other.id}`);
      // Only a walking kinesin head plate may cross a linker or the coil, or
      // cover the free head that waits behind it just after ATP binds.
      if(name==='kinesin-walk') for(const label of f.labels) for(const body of f.bodies)
        assert.ok(!platesOverlap(label,body) || allow(label.id,body.id,t),`${where}: ${label.id} covers ${body.id}`);
      assert.equal(countPlateOverlaps(f.labels),0,`${where}: plates overlap`);
      if(chapter.animation && placement===seat.placement) for(const {id,rect} of f.labels) {
        assert.ok(Math.abs(rect.x)+rect.halfWidth<=PLATE_FIELD.halfWidth,`${where}: ${id} outside horizontal field`);
        assert.ok(Math.abs(rect.y)+rect.halfHeight<=PLATE_FIELD.halfHeight,`${where}: ${id} outside vertical field`);
      }
    }
  }
});

test('the walk regression catches the former Head 1 plate crossing the neck coil between keyframes',{skip:!cache},()=>{
  const lesson=JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/motion.json',import.meta.url)));
  const seat={...demoSeats['kinesin-walk'],yaw:-.35,pitch:-.2},chapter=lesson.chapters[0];
  const atoms=coordinates(`${cache}/${seat.file}`,lesson.provenance.sourceSha256);
  const old=structuredClone(chapter),label=old.immersive.figure.labels.find(l=>l.id==='k1d-name');
  label.offsetX=26;label.offsetY=2;
  let formerCrossings=0;
  for(const eye of [-.032,.032]) {
    const before=labelFrame(prepareLabelScene(old,atoms),seat,.949,seat.placement,eye);
    if(platesOverlap(before.labels.find(l=>l.id===label.id),before.bodies.find(b=>b.id==='NC2'))) formerCrossings++;
    const after=labelFrame(prepareLabelScene(chapter,atoms),seat,.949,seat.placement,eye);
    for(const body of after.bodies) assert.ok(!platesOverlap(after.labels.find(l=>l.id===label.id),body));
  }
  assert.ok(formerCrossings>0,'the projection fixture must reproduce the former coil crossing');
});

// These reference seats do not contain the live caption panel's rectangle.
// Keep this plate on the opposite side from the recorded left caption glass;
// this is not a proof of arbitrary toolbar clearance. Epsilon sits on its part
// at the molecule's centre, so its plate cannot keep to the right band.
test('ATP subunit a occupies the right band, away from the recorded left caption',{skip:!cache},()=>{
  const lesson=JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase-rotor/motion.json',import.meta.url)));
  const seat=demoSeats['atp-synthase-rotor'],atoms=coordinates(`${cache}/${seat.file}`,lesson.provenance.sourceSha256);
  for(const [chapterId,labelId] of [['machine','subunit-a']]) {
    const scene=prepareLabelScene(lesson.chapters.find(c=>c.id===chapterId),atoms);
    for(const placement of [1,seat.placement]) for(const eye of [-.032,.032]) {
      const {rect}=labelFrame(scene,seat,0,placement,eye).labels.find(l=>l.id===labelId);
      assert.ok(rect.x-rect.halfWidth>0,`${labelId} stays to the right of the molecule centre`);
    }
  }
});

test('ATP static site tags keep the inhibition meaning and beta-TP on its head in both eyes',{skip:!cache},()=>{
  const lesson=JSON.parse(readFileSync(new URL('../../plugin/demos/atp-synthase-rotor/motion.json',import.meta.url)));
  const seat=demoSeats['atp-synthase-rotor'],atoms=coordinates(`${cache}/${seat.file}`,lesson.provenance.sourceSha256);
  assert.equal(lesson.chapters.find(c=>c.id==='epsilon').immersive.figure.labels.find(l=>l.id==='beta-dp').text,'βDP: held open');
  for(const chapterId of ['sites','epsilon','distance']) {
    const chapter=lesson.chapters.find(c=>c.id===chapterId),scene=prepareLabelScene(chapter,atoms);
    assert.equal(chapter.immersive.figure.labels.find(l=>l.id==='beta-tp').target.chain,'F');
    for(const eye of [-.032,.032]) {
      const frame=labelFrame(scene,seat,0,seat.placement,eye);
      for(const {id,rect} of frame.labels) {
        assert.ok(Math.abs(rect.x)+rect.halfWidth<=PLATE_FIELD.halfWidth,`${chapterId}/${id}: horizontal field`);
        assert.ok(Math.abs(rect.y)+rect.halfHeight<=PLATE_FIELD.halfHeight,`${chapterId}/${id}: vertical field`);
      }
      const plate=frame.labels.find(l=>l.id==='beta-tp').rect,head=frame.bodies.find(b=>b.id==='F').rect;
      assert.ok(plate.x>head.x,'beta-TP sits on the right half of chain F');
      assert.ok(plate.x-plate.halfWidth<head.x+head.halfWidth,'beta-TP stays on or right beside its head');
      assert.ok(Math.abs(plate.y-head.y)<head.halfHeight,'beta-TP is level with its head');
    }
  }
});

test('label and distance anchors select the requested copy', () => {
  const atoms = ['one', 'two'].flatMap((copyId, copy) => [1, 2].map(residue => ({
    chain: 'A', copyId, residue, atom: 'CA', component: 'ALA', position: [copy * 100 + residue, 0, 0],
  })));
  const target = { chain: 'A', copyId: 'two', atomName: 'CA', residues: { from: 1, to: 1 } };
  const chapter = { immersive: { figure: { labels: [{ id: 'copy', text: 'Copy two', target }] } } };
  assert.ok(Math.abs(prepareLabelScene(chapter, atoms).labels[0].center[0] - 101) < 1e-10);
  chapter.immersive.figure.distances = [{ id: 'distance', a: target, b: { ...target, residues: { from: 2, to: 2 } } }];
  const distance = prepareLabelScene(chapter, atoms).labels[1];
  assert.deepEqual(Array.from(distance.center), [101.5, 0, 0]);
  assert.equal(distance.text, '1.00 Å');
  assert.throws(() => prepareLabelScene({ immersive: { figure: { labels: [{ target: { ...target, copyId: 'missing' } }] } } }, atoms), /Missing label target/);
});


test('per-label maxOffsetEm fixture offsets match the actual XR plate uniforms',async()=>{
  const h=await motionFixture({animation:null});
  const label={id:'raised',text:'Head',target:{chain:'H0',residues:{from:10,to:10},atomName:'CA'},
    color:'#246080',sizeFactor:1.1,offsetX:100,offsetY:-100,maxOffsetEm:4};
  const normal={...label,id:'default'};delete normal.maxOffsetEm;
  const figure={layers:[],distances:[],labels:[label,normal]};
  try {
    await h.figure.install(figure);
    const position=Array.from(lociPositions(resolveFigureLoci(label.target,h.structure.obj.data)));
    assert.equal(position.length,3);
    const atoms=[{chain:'H0',residue:10,atom:'CA',position}];
    const chapter={immersive:{figure}},scene=prepareLabelScene(chapter,atoms);
    const zero=prepareLabelScene({immersive:{figure:{...figure,labels:figure.labels.map(l=>({...l,offsetX:0,offsetY:0}))}}},atoms);
    for(const scale of [.02421,.00504]) for(const placement of [1,1.738056]) for(const eye of [-.032,.032]) {
      const seat={scale,placement,distance:6.5,center:position},gain=FIGURE_REFERENCE_SCALE/(scale*placement);
      const frame=labelFrame(scene,seat,0,placement,eye),origin=labelFrame(zero,seat,0,placement,eye);
      // The fixture works in source units; the shader works in placed units.
      h.canvas.camera.scale=scale;
      for(const [i,repr] of h.figure.annotations().entries()) {
        repr.setState({visible:true});sizeImmersiveAnnotation(repr,h.canvas);
        const plate=frame.labels[i],base=origin.labels[i],v=repr.renderObjects[0].values;
        const x=(plate.rect.x-base.rect.x)/plate.offsetUnit*gain;
        const y=(plate.rect.y-base.rect.y)/plate.offsetUnit*gain;
        const expected=(i===0?4:2)*.8*6*label.sizeFactor*gain;
        assert.ok(Math.abs(x-expected)<1e-6,'fixture honours per-label cap');
        assert.ok(Math.abs(y+expected)<1e-6);
        assert.ok(Math.abs(x-v.uOffsetX.ref.value/placement)<1e-6,'fixture matches drawn X');
        assert.ok(Math.abs(y-v.uOffsetY.ref.value/placement)<1e-6,'fixture matches drawn Y');
      }
    }
  } finally {await h.dispose();}
});
