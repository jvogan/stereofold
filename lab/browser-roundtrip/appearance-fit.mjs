import { solveAppearanceFit } from './appearance-fit-worker.mjs';
import { renderedMeshVertexCount } from './component-label-measurement.mjs';

// Snapshot only the values the geometry reader uses. Native XRView/transform
// objects and Mol* ValueCell metadata are not structured-cloneable. Typed arrays
// are copied into fresh buffers for transfer, never detached from the renderer.
export function appearanceFitMessage(options, transfers = []) {
  const snapshot = (object, key, value) => {
    // Sphere extrema/metadata are not read by the solver.
    if (key === 'invariantBoundingSphere' || key === 'boundingSphere')
      return value && { center: Array.from(value.center), radius: value.radius };
    // The fitter reads only live mesh vertices. Mol* can retain much larger
    // backing buffers after a rebuild; copying their spare capacity gives the
    // worker bytes it deliberately never examines. Re-read the live count on
    // every request, including same-buffer growth, and keep the conservative
    // full-capacity count when that metadata is absent or invalid.
    const meshPositions = key === 'aPosition';
    if (ArrayBuffer.isView(value) || (meshPositions && Array.isArray(value))) {
      const copy = meshPositions ? value.slice(0, renderedMeshVertexCount(object, value) * 3) : value.slice();
      if (ArrayBuffer.isView(copy)) transfers.push(copy.buffer);
      return copy;
    }
    return value;
  };
  const keys = ['alpha', 'drawCount', 'instanceCount', 'uVertexCount', 'aPosition', 'aTransform',
    'invariantBoundingSphere', 'boundingSphere', 'matrix'];
  return { ...options, geometry: { ...options.geometry,
    objects: options.geometry.objects.map(object => ({ type: object.type,
      state: { visible: object.state?.visible, disposed: object.state?.disposed, alphaFactor: object.state?.alphaFactor },
      // Impostor spheres/cylinders and texture meshes use their instance
      // bounding spheres in resetEntryGeometry, never their position buffers.
      values: Object.fromEntries(keys.filter(key => object.values?.[key]
        && (key !== 'aPosition' || object.type === 'mesh')).map(key =>
        [key, { ref: { value: snapshot(object, key, object.values[key].ref.value) } }])) })),
    views: options.geometry.views.map(view => ({ eye: view.eye,
      projectionMatrix: Array.from(view.projectionMatrix),
      transform: { inverse: { matrix: Array.from(view.transform.inverse.matrix) } } })),
  } };
}

function appearanceWorker() {
  // Production inspectors are a single inline bundle; the build embeds this
  // small independent worker so it needs no new authenticated asset route.
  if (typeof __APPEARANCE_FIT_WORKER_SOURCE__ !== 'undefined') {
    const url = URL.createObjectURL(new Blob([__APPEARANCE_FIT_WORKER_SOURCE__], { type: 'text/javascript' }));
    try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
  }
  return new Worker(new URL('./appearance-fit-worker.mjs', import.meta.url), { type: 'module' });
}

export function fitAppearanceInWorker(options, { makeWorker = appearanceWorker,
  waiters, timeoutMs = 30000, now = () => performance.now(), signal, kind = 'appearance',
  isPresenting = () => false,
  record = detail => globalThis.__stereofoldDiagnostics?.record?.('appearance-fit', detail) } = {}) {
  // Appearance changes and retained-pose checks have independent owners.
  for (const check of [...(waiters ?? [])]) if (check.fitKind === kind)
    check(Object.assign(Error('The fit was cancelled by a newer change. Kept the previous appearance.'), { code: 'FIT_CANCELLED' }));
  return new Promise((resolve, reject) => {
    let worker, timer, fallbackTimer, settled, finished = false, path = 'worker';
    const started = now(), deadline = started + timeoutMs;
    const report = detail => { try { record({ path, kind, elapsedMs: now() - started, ...detail }); } catch {} };
    const finish = (error, fitted) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(fallbackTimer);
      waiters?.delete(check); signal?.removeEventListener('abort', abort); worker?.terminate();
      report({ outcome: error ? 'refused' : 'fitted', ...(error ? { reason: error.message } : {}) });
      if (error) reject(error); else resolve(fitted);
      settled();
    };
    const check = error => {
      if (error) finish(error);
      else if (now() >= deadline) finish(Error('The fit did not answer within 30 seconds. Kept the previous appearance. Try again.'));
    };
    check.fitKind = kind;
    check.settled = new Promise(resolve => { settled = resolve; });
    const abort = () => check(Error('The fit was cancelled. Kept the previous appearance.'));
    const refuseInXR = () => {
      if (!isPresenting()) return false;
      path = 'worker-unavailable-xr';
      finish(Error('The headset browser could not run the fitting helper. Kept the previous appearance.'));
      return true;
    };
    const fallback = error => {
      if (finished || path === 'main-thread-fallback') return;
      worker?.terminate(); worker = undefined;
      if (refuseInXR()) return;
      path = 'main-thread-fallback'; report({ outcome: 'started', reason: error?.message ?? 'Worker unavailable' });
      // Let the existing progress caption paint before the compatibility solve.
      // This is the same solver/input as the worker, never a weaker clearance test.
      fallbackTimer = setTimeout(() => {
        check(); if (finished || refuseInXR()) return;
        try { const fitted = solveAppearanceFit(options); check(); if (!finished) finish(null, fitted); }
        catch (error) { finish(error); }
      }, 0);
    };
    waiters?.add(check);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => check(), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    try {
      worker = makeWorker();
      worker.onmessage = ({ data }) => { check(); if (!finished) finish(data.error ? Error(data.error) : null, data.fitted); };
      worker.onerror = error => fallback(error);
      report({ outcome: 'started' });
      const dispatchStart = now(), transfers = [];
      const message = appearanceFitMessage(options, transfers);
      const built = now();
      worker.postMessage(message, transfers);
      report({ outcome: 'dispatched', buildMs: built - dispatchStart, postMs: now() - built,
        dispatchMs: now() - dispatchStart });
    } catch (error) { fallback(error); }
  });
}
