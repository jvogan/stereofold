import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fitAppearanceInWorker } from './appearance-fit.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';
const cell = value => ({ ref: { value } });
function input() {
  const matrix = identity(); matrix[14] = -1;
  return { seat: { translation: [0, 0, -1], rotation: [0, 0, 0], scale: 1 }, fit: true,
    cameraScale: 1, center: [0, 0, 0], radius: 1, headInRoom: identity(), renderFromRoom: identity(),
    points: [-.8, -.3].flatMap(x => [-.8, .8].map(y => [x, y, -1])),
    geometry: { fromPlacement: matrix, toPlacement: matrix, views: syntheticViews(),
      objects: [{ type: 'mesh', state: { visible: true }, values: { drawCount: cell(36), instanceCount: cell(1),
        aTransform: cell(matrix), aPosition: cell(new Float32Array([-.7, -.2, 0, .7, .2, 0])) } }] } };
}
function makeWorker() {
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(new URL('./appearance-fit-worker.mjs', import.meta.url).href)}).then(({solveAppearanceFit}) =>
      parentPort.on('message', data => { try { parentPort.postMessage({fitted: solveAppearanceFit(data)}); }
      catch (error) { parentPort.postMessage({error: error.message}); } }));`, { eval: true });
  const adapter = { terminate: () => worker.terminate(), postMessage: (data, transfers) => worker.postMessage(data, transfers) };
  worker.on('message', data => adapter.onmessage({ data })); worker.on('error', error => adapter.onerror(error));
  return adapter;
}
test('chapter glass moves before the structure retreats to the four metre fallback', async () => {
  const options = input();
  options.preferMenuRelocation = true;
  options.menuCandidates = [{ id: 'overhead', points: [-.6, .6].flatMap(x => [.5, .8].map(y => [x, y, -1])) }];
  const fitted = await fitAppearanceInWorker(options, { makeWorker });
  assert.deepEqual(fitted.translation, options.seat.translation);
  assert.equal(fitted.scale, options.seat.scale);
  assert.equal(fitted.menuRelocation, 'overhead');
});
test('an orbit recovers its off-centre origin sideways while retaining chapter depth and scale', async () => {
  const options = input();
  options.preferMenuRelocation = true;
  options.points = [-.8, .8].flatMap(x => [-.8, .8].map(y => [x, y, -1]));
  options.seat.translation = [-1.7, 0, -2.4];
  options.geometry.fromPlacement[12] = -1.7;
  options.geometry.fromPlacement[14] = -2.4;
  options.menuCandidates = [{ id: 'overhead', points: [-.6, .6].flatMap(x => [.5, .8].map(y => [x, y, -1])) }];
  options.menuCandidates[0].points.plates = [options.menuCandidates[0].points.slice()];
  const fitted = await fitAppearanceInWorker(options, { makeWorker });
  assert.equal(fitted.translation[2], -2.4);
  assert.equal(fitted.scale, 1);
  assert.ok(fitted.translation[0] > options.seat.translation[0]);
  assert.equal(fitted.menuRelocation, 'overhead');
});
test('worker runs the real stereo fitter and leaves renderer buffers attached', async () => {
  const options = input(), waiters = new Set();
  const fitted = await fitAppearanceInWorker(options, { makeWorker, waiters });
  assert.ok(fitted.scale <= 1);
  assert.notDeepEqual(fitted.translation, options.seat.translation);
  assert.equal(options.geometry.objects[0].values.aPosition.ref.value.length, 6);
  assert.equal(waiters.size, 0);
});

test('worker preserves live mesh counts so unused translated buffer capacity cannot shrink the fit', async () => {
  const options = input(), object = options.geometry.objects[0];
  const shift = [300, 250, 350], positions = object.values.aPosition.ref.value;
  const translated = Array.from(positions, (v, i) => v + shift[i % 3]);
  const matrix = identity(); matrix.splice(12, 3, -300, -250, -351);
  object.values.aTransform = cell(matrix);
  object.values.aPosition = cell(new Float32Array([...translated, 0, 0, 0, 900, -800, 700]));
  object.values.uVertexCount = cell(2);
  const { solveAppearanceFit } = await import('./appearance-fit-worker.mjs');
  const direct = solveAppearanceFit(options);
  const actual = await fitAppearanceInWorker(options, { makeWorker });
  assert.deepEqual(actual, direct, 'the actual worker receives the same live geometry as the direct fitter');
  assert.equal(object.values.aPosition.ref.value.length, 12, 'renderer retains its complete attached buffer');
  assert.equal(object.values.uVertexCount.ref.value, 2);
  object.values.uVertexCount.ref.value = 3;
  const rebuilt = await fitAppearanceInWorker(options, { makeWorker });
  assert.deepEqual(rebuilt, solveAppearanceFit(options), 'a changed live count reaches the worker');
  assert.ok(rebuilt.scale < actual.scale, 'the newly live origin vertex participates in the fit');
  // Without a live count the fitter must conservatively include all capacity.
  // The restored 1e-6 numerical floor permits that large source-unit fit.
  delete object.values.uVertexCount;
  const conservative = await fitAppearanceInWorker(options, { makeWorker });
  assert.deepEqual(conservative, solveAppearanceFit(options));
  assert.ok(conservative.scale < rebuilt.scale, 'missing live counts include the spare extreme vertex');
  assert.ok(actual.scale > conservative.scale * 100, 'live counts protect the drawn mesh from spare-capacity shrinkage');

});

test('worker fits the actual monoscopic XR view and still rejects a missing stereo eye', async () => {
  const options = input();
  options.geometry.views = [{ ...options.geometry.views[0], eye: 'none' }];
  const fitted = await fitAppearanceInWorker(options, { makeWorker });
  assert.ok(Number.isFinite(fitted.scale));
  assert.ok(fitted.translation.every(Number.isFinite));
  options.geometry.views[0].eye = 'left';
  await assert.rejects(fitAppearanceInWorker(options, { makeWorker }), /measurable in both eyes/);
});
for (const cause of ['deadline', 'session exit']) test(`appearance worker terminates on ${cause} without revealing`, async () => {
  let terminated = 0, clock = 0;
  const waiters = new Set();
  const promise = fitAppearanceInWorker(input(), { waiters, now: () => clock,
    makeWorker: () => ({ postMessage() {}, terminate() { terminated++; } }) });
  clock = 30001;
  for (const check of waiters) check(cause === 'session exit' ? Error('session ended') : undefined);
  await assert.rejects(promise, cause === 'deadline' ? /30 seconds/ : /session ended/);
  assert.equal(terminated, 1); assert.equal(waiters.size, 0);
});

test('the embedded production worker bundles independently and executes the real fit', async () => {
  const { createRequire } = await import('node:module');
  const { build } = createRequire(new URL('../../plugin/package.json', import.meta.url))('esbuild');
  const { fileURLToPath } = await import('node:url');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./appearance-fit-worker.mjs', import.meta.url))],
    bundle: true, format: 'iife', platform: 'browser', target: ['es2022'], minify: true, write: false });
  const code = bundle.outputFiles[0].text;
  const fitted = await fitAppearanceInWorker(input(), { makeWorker: () => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');
      globalThis.self={postMessage: data=>parentPort.postMessage(data)};
      ${code}
      parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
    const adapter = { terminate: () => worker.terminate(), postMessage: (data, transfers) => worker.postMessage(data, transfers) };
    worker.on('message', data => adapter.onmessage({data})); worker.on('error', error => adapter.onerror(error));
    return adapter;
  } });
  assert.ok(fitted.scale <= 1);
  const main = await build({ entryPoints: [fileURLToPath(new URL('./appearance-fit.mjs', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'AppearanceFit', platform: 'browser', target: ['es2022'], minify: true, write: false, logLevel: 'silent',
    define: { __APPEARANCE_FIT_WORKER_SOURCE__: JSON.stringify(code) } });
  assert.ok(main.outputFiles[0].text.includes('createObjectURL'));
  let created, revoked;
  const context = vm.createContext({ setTimeout, clearTimeout, performance, Blob,
    URL: { createObjectURL: () => 'blob:embedded-worker', revokeObjectURL: url => { revoked = url; } },
    Worker: class {
      constructor(url) { created = url; }
      postMessage() { queueMicrotask(() => this.onmessage({ data: { fitted } })); }
      terminate() {}
    },
  });
  vm.runInContext(main.outputFiles[0].text, context);
  await context.AppearanceFit.fitAppearanceInWorker(input());
  assert.equal(created, 'blob:embedded-worker', 'inline inspector needs no separate worker asset');
  assert.equal(revoked, created);
});

test('a newer worker fit cancels its predecessor and ignores a late answer', async () => {
  const waiters = new Set(); let old, terminated = 0;
  const first = fitAppearanceInWorker(input(), { waiters, makeWorker: () => (old = {
    postMessage() {}, terminate() { terminated++; },
  }) });
  const rejected = assert.rejects(first, /newer change/);
  const second = fitAppearanceInWorker(input(), { waiters, makeWorker });
  old.onmessage({ data: { fitted: { scale: 999 } } });
  const fitted = await second; await rejected;
  assert.ok(fitted.scale <= 1);
  assert.equal(terminated, 1); assert.equal(waiters.size, 0);
});

test('abort cancels a scheduled main-thread fallback before any geometry read', async () => {
  const controller = new AbortController(), options = input();
  let reads = 0;
  Object.defineProperty(options.geometry, 'objects', { get() { reads++; throw Error('must not solve'); } });
  const pending = fitAppearanceInWorker(options, { signal: controller.signal,
    makeWorker: () => { throw Error('CSP'); } });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, 0);
});

for (const mode of ['constructor', 'error']) test(`desktop worker ${mode} failure retains the exact synchronous fallback`, async () => {
  const { solveAppearanceFit } = await import('./appearance-fit-worker.mjs');
  const options = input(), diagnostics = [];
  const fitted = await fitAppearanceInWorker(options, { isPresenting: () => false,
    record: detail => diagnostics.push(detail), makeWorker: () => {
      if (mode === 'constructor') throw Error('Worker unavailable');
      const worker = new Worker(`throw Error('Worker crashed');`, { eval: true });
      const adapter = { postMessage() {}, terminate: () => worker.terminate() };
      worker.on('error', error => adapter.onerror(error));
      return adapter;
    } });
  assert.deepEqual(fitted, solveAppearanceFit(options));
  assert.ok(diagnostics.some(d => d.path === 'main-thread-fallback' && d.outcome === 'fitted'));
});

test('entering XR before the deferred fallback refuses without a geometry read', async () => {
  let presenting = false, reads = 0;
  const options = input();
  Object.defineProperty(options.geometry, 'objects', { get() { reads++; throw Error('must not solve'); } });
  const pending = fitAppearanceInWorker(options, { isPresenting: () => presenting,
    makeWorker: () => { throw Error('Worker unavailable'); } });
  presenting = true;
  await assert.rejects(pending, /headset browser could not run the fitting helper/);
  assert.equal(reads, 0);
});

test('fresh transfer buffers and minimal sphere snapshots preserve exact solver answers', async () => {
  const { appearanceFitMessage } = await import('./appearance-fit.mjs');
  const { solveAppearanceFit } = await import('./appearance-fit-worker.mjs');
  for (const type of ['mesh', 'spheres']) {
    const options = input(), object = options.geometry.objects[0];
    object.type = type;
    object.values.invariantBoundingSphere = cell({ center: [0, 0, 0], radius: .2, extrema: [() => {}] });
    const transfers = [], message = appearanceFitMessage(options, transfers);
    assert.equal(transfers.length, type === 'mesh' ? 1 : 0);
    if (type === 'mesh') assert.notEqual(message.geometry.objects[0].values.aPosition.ref.value.buffer, object.values.aPosition.ref.value.buffer);
    else assert.equal(message.geometry.objects[0].values.aPosition, undefined, 'nonmesh fitting reads instance spheres, not positions');
    const delivered = structuredClone(message, { transfer: transfers });
    if (type === 'mesh') assert.equal(transfers[0].byteLength, 0);
    assert.equal(object.values.aPosition.ref.value.byteLength, 24);
    assert.deepEqual(solveAppearanceFit(delivered), solveAppearanceFit(options));
  }
});

test('worker snapshots omit spare mesh capacity without changing exact fit decisions', async () => {
  const { appearanceFitMessage } = await import('./appearance-fit.mjs');
  const { solveAppearanceFit } = await import('./appearance-fit-worker.mjs');
  const options = input(), object = options.geometry.objects[0];
  const positions = new Float32Array(300_000);
  positions.set(object.values.aPosition.ref.value);
  positions.set([900, -800, 700], 6);
  object.values.aPosition = cell(positions);
  const outcome = options => {
    try { return { fitted: solveAppearanceFit(options) }; }
    catch (error) { return { error: error.message }; }
  };
  for (const count of [2, 3, 0, undefined, -1, 1.5, 100_001]) {
    object.values.uVertexCount = cell(count);
    const transfers = [], message = appearanceFitMessage(options, transfers);
    const valid = Number.isInteger(count) && count >= 0 && count <= positions.length / 3;
    assert.equal(transfers.reduce((bytes, buffer) => bytes + buffer.byteLength, 0), valid ? count * 12 : positions.byteLength);
    const delivered = structuredClone(message, { transfer: transfers });
    assert.deepEqual(outcome(delivered), outcome(options));
    assert.equal(positions.byteLength, 1_200_000, 'the renderer buffer remains attached and unchanged');
  }
});
