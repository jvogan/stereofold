// node lab/browser-roundtrip/motion-benchmark.mjs [--baseline <git-ref>]
// CPU geometry/pose benchmark, not GPU or headset fps. Baseline is extracted
// from git into a temporary sibling module, so both versions use identical data.
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { motionFixture } from './motion-benchmark-fixture.mjs';
const ref=process.argv[process.argv.indexOf('--baseline')+1];
const baseline=process.argv.includes('--baseline')?new URL(`.motion-baseline-${process.pid}.mjs`,import.meta.url):undefined;
async function measure(name, createAnimation) {
  const h=await motionFixture({createAnimation});
  try {
    h.registry.tick(0);
    for(let i=1;i<=300;i++)h.registry.tick(i*1000/72);
    const values=[],start={...h.counts};
    for(let i=301;i<=2300;i++){const t=performance.now();h.registry.tick(i*1000/72);values.push(performance.now()-t);}
    values.sort((a,b)=>a-b);
    console.log(JSON.stringify({name,atoms:h.structure.obj.data.elementCount,ticks:values.length,
      meanMs:values.reduce((a,b)=>a+b,0)/values.length,p50Ms:values[1000],p95Ms:values[1900],
      uploadsPerTick:(h.counts.uploads-start.uploads)/values.length,objectsPerTick:(h.counts.objects-start.objects)/values.length}));
  }finally{await h.dispose();}
}
try {
  if(baseline){writeFileSync(baseline,execFileSync('git',['show',`${ref}:lab/browser-roundtrip/molecular-animation.mjs`]));await measure('before', (await import(baseline.href)).createMolecularAnimation);}
  await measure('after');
}finally{if(baseline)unlinkSync(baseline);}
