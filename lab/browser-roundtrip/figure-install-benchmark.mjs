// node --import tsx lab/browser-roundtrip/figure-install-benchmark.mjs
//   --baseline HEAD --source /path/composite.cif --lesson /path/flipbook.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { lessonFigureSchema } from '../../plugin/src/lesson-figure.ts';
import { motionFixture } from './motion-benchmark-fixture.mjs';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const source=readFileSync(arg('--source'),'utf8');
const lesson=JSON.parse(readFileSync(arg('--lesson'),'utf8'));
const baseline=new URL(`.figure-baseline-${process.pid}.mjs`,import.meta.url);
async function measure(name,createFigure){
  const h=await motionFixture({source,animation:null,createFigure});
  try {
    const samples=[],cold=[];
    for(let pass=0;pass<3;pass++) for(const chapter of lesson.chapters){
      const figure=lessonFigureSchema.parse(chapter.immersive.figure);
      const beforeLayers=new Set(h.figure.molecular()),beforeLabels=new Set(h.figure.annotations());
      const start=performance.now();await h.figure.install(figure);const ms=performance.now()-start;
      (pass ? samples : cold).push({chapter:chapter.id,ms,
        builtLayers:h.figure.molecular().filter(r=>!beforeLayers.has(r)).length,
        builtAnnotations:h.figure.annotations().filter(r=>!beforeLabels.has(r)).length,
        ...h.figure.snapshot().preparation});
    }
    const sum=key=>samples.reduce((s,r)=>s+(r[key]??0),0)/2;
    console.log(JSON.stringify({name,chapters:lesson.chapters.length,totalMs:sum('ms'),layersBuilt:sum('builtLayers'),annotationsBuilt:sum('builtAnnotations'),
      firstVisitTransitionsMs:cold.slice(1).reduce((s,r)=>s+r.ms,0),
      firstVisitTransitionsResolveMs:cold.slice(1).reduce((s,r)=>s+(r.resolveMs??0),0),resolveMs:sum('resolveMs'),layersMs:sum('layersMs'),annotationsMs:sum('annotationsMs'),commitMs:sum('commitMs'),
      samples:samples.slice(0,lesson.chapters.length)}));
  }finally{await h.dispose();}
}
try{
  let old=execFileSync('git',['show',`${arg('--baseline')}:lab/browser-roundtrip/lesson-figure.mjs`],{encoding:'utf8'});
  old=old.replace('const install = async figure => {', 'const install = async figure => { const profileStart=performance.now(); let profileResolved, profileLayers, profileAnnotations;')
    .replace('    const staged = { signature', '    profileResolved=performance.now();\n    const staged = { signature')
    .replace('      const addSelections =', '      profileLayers=performance.now();\n      const addSelections =')
    .replace('      applyTransform(staged);', '      profileAnnotations=performance.now();\n      applyTransform(staged);')
    .replace('      current = staged;', '      staged.preparation={resolveMs:profileResolved-profileStart,layersMs:profileLayers-profileResolved,annotationsMs:profileAnnotations-profileLayers,commitMs:performance.now()-profileAnnotations}; current = staged;')
    .replace('snapshot: () => current ? { layers:', 'snapshot: () => current ? { preparation:current.preparation, layers:');
  writeFileSync(baseline,old);
  await measure('before',(await import(baseline.href)).createLessonFigure);
  await measure('after');
}finally{unlinkSync(baseline);}
