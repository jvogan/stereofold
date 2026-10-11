import { performance } from 'node:perf_hooks';
import { labelRuntime, labelCell, labelSource, updateLabel, viewerLabelWorkload } from '../test/helpers/molstar-label-runtime.js';

// Warm CPU-only layer work from viewer's staged params. This does not time the
// tool queue, layout solve, canvas rasterization, WebGL uploads or a headset.
const optimized = process.argv.includes('--optimized');
const { labelUniformUpdatePatch } = await import('../src/molstar-font-atlas-patch.js');
const api = await labelRuntime(optimized ? [labelUniformUpdatePatch] : []);
const rows = [];
for (const scenario of ['appearance-opacity', 'emphasize', 'tour-chapter', 'selection-identity']) {
  const cells = await Promise.all(Array.from({ length: 30 }, (_, i) => labelCell(api, undefined,
    i % 3 === 2 ? { tether: true, tetherLength: 1 } : {})));
  const times: number[] = [];
  let builds = 0;
  for (let round = 0; round < 25; round++) {
    const before = api.shapeBuilds;
    const began = performance.now();
    for (const [i, cell] of cells.entries()) {
      const alternate = round % 2;
      const patch = scenario === 'appearance-opacity' ? { alpha: alternate ? .4 : .8 }
        : scenario === 'selection-identity' ? { alpha: .6 }
        : { alpha: alternate ? .5 : .9, sizeFactor: alternate ? 1 : 2,
          offsetX: alternate ? 1 : 3, offsetY: alternate ? 2 : 4,
          ...(i % 3 === 2 ? { tetherLength: alternate ? 2 : 3 } : {}) };
      if (scenario === 'selection-identity') cell.a = labelSource(api, round + 10);
      await updateLabel(api, cell, patch);
    }
    if (round >= 5) { times.push(performance.now() - began); builds += api.shapeBuilds - before; }
  }
  times.sort((a,b) => a-b);
  rows.push({ scenario, layers: 30, rounds: times.length, shapeBuilds: builds,
    uniformUpdates: times.length * 30 - builds,
    medianMs: +times[Math.floor(times.length / 2)]!.toFixed(3),
    medianPerLayerMs: +(times[Math.floor(times.length / 2)]! / 30).toFixed(4) });
  cells.forEach(cell => cell.b.data.repr.destroy());
}
for (const scenario of ['viewer-appearance', 'viewer-selection', 'viewer-emphasize', 'viewer-tour']) {
  const workload = await viewerLabelWorkload();
  const cells = new Map(await Promise.all(workload.initial.map(async ([ref, props]) => [ref, await labelCell(api, undefined, props)] as const)));
  const times: number[] = [];
  let builds = 0, updates = 0;
  for (let round = 0; round < 25; round++) {
    const staged = await workload.updates(scenario, round);
    const before = api.shapeBuilds, began = performance.now();
    for (const [ref, props] of staged) await updateLabel(api, cells.get(ref), props);
    if (round >= 5) { times.push(performance.now() - began); builds += api.shapeBuilds - before; updates += staged.length; }
  }
  times.sort((a, b) => a - b);
  rows.push({ scenario, layers: cells.size, rounds: times.length, shapeBuilds: builds,
    uniformUpdates: updates - builds, medianMs: +times[Math.floor(times.length / 2)]!.toFixed(3),
    medianPerLayerMs: +(times[Math.floor(times.length / 2)]! / cells.size).toFixed(4) });
  cells.forEach(cell => cell.b.data.repr.destroy());
}
console.log(JSON.stringify({ mode: optimized ? 'optimized' : 'baseline', scope: 'node CPU; real Mol* text/transformer; synthetic 30-layer staged changes; canvas shim; no GPU', rows }, null, 2));
