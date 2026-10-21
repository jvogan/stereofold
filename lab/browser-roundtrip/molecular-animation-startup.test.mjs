import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { createLessonFigure } from './lesson-figure.mjs';
import { molecularAnimationHarness } from './fixtures/molecular-animation-harness.mjs';

const cache = process.env.STEREOFOLD_DEMO_CACHE;
const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/motion.json',import.meta.url)));
// Prepared composites are content-addressed; the bare name is a legacy copy.
const file = cache && [`${cache}/kinesin-walk-motion.${lesson.provenance.sourceSha256}.cif`, `${cache}/kinesin-walk-motion.cif`].find(existsSync);
test('kinesin startup separates figure layers, plates, animation and first moving bodies', {skip:!file || !existsSync(file)}, async t => {
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText:()=>({width:4}),clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const chapter = lesson.chapters[0];
  let h, figure, annotations=()=>[];
  h=await molecularAnimationHarness(t,{structureText:readFileSync(file,'utf8'),
    getRepresentations:()=>[h.repr,...figure.molecular()],getAnnotations:()=>annotations()});
  h.plugin.canvas3d={xr:{isPresenting:{value:true}},update(){},add(){},remove(){},mark(){},syncVisibility(){},getRenderObjects:()=>[]};
  figure=createLessonFigure({plugin:h.plugin,getStructure:()=>h.structure,getTransform:()=>h.presentation});
  const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
  const annotationsStart=source.indexOf('    getAnnotations: () => {');
  annotations=vm.runInNewContext('({'+source.slice(annotationsStart,source.indexOf('    // Immersion uses',annotationsStart))+'}).getAnnotations',
    {plugin:h.plugin,componentLabelRepresentations:()=>[],lessonFigure:figure,StructureElement});
  const start=source.indexOf('  async function installMolecularChapter('), end=source.indexOf('  async function setLessonFigure(',start);
  const began=performance.now(), phases=[]; let bodyDrawAt, firstMotionAt, platesAt;
  const install=vm.runInNewContext(source.slice(start,end)+';installMolecularChapter',{
    molecularAnimation:h.registry,lessonFigure:figure,applyInspectionTransform(){},snapshot:()=>({ready:true}),
    now:()=>performance.now(), recordCost:(kind,detail)=>phases.push({kind,...detail}),
    wearerPlacement:{holdsPlacement:()=>true},
    inspectionMutation:async operation=>{
      await operation();
      // CPU phase harness: real geometry and pose evaluator; the draw costs
      // and XR compositor are not simulated by this callback.
      if(bodyDrawAt===undefined) {
        bodyDrawAt=performance.now()-began;
        h.registry.tick(0);
        const bodies=h.registry.representations().filter(r=>r.state.visible);
        const opening=bodies.map(r=>[...r.state.transform]);
        for(let ms=14;ms<=1000;ms+=14) {
          h.registry.tick(ms);
          if(bodies.some((r,i)=>r.state.transform.some((v,j)=>Math.abs(v-opening[i][j])>1e-6))) {
            firstMotionAt=bodyDrawAt+ms;break;
          }
        }
      }
      if(figure.annotations().length) platesAt=performance.now()-began;
      return {ready:true};
    },
  });
  try {
    await h.registry.prepare(chapter.animation);
    await install(chapter.animation,chapter.id,{installFigure:true,figure:chapter.immersive.figure,toolbarReady:Promise.resolve()});
    assert.ok(firstMotionAt>0);
    const preparation=figure.snapshot().preparation;
    t.diagnostic(JSON.stringify({clock:'CPU geometry plus sampled motion onset; excludes GPU and host dispatch',
      bodyDrawMs:bodyDrawAt,firstMotionMs:firstMotionAt,platesMs:platesAt,figure:preparation,animation:h.costs.filter(c=>c.kind==='animation-phase'),phases}));
  } finally {await h.registry.forget();await figure.forget();h.plugin.canvas3d=undefined;}
});
