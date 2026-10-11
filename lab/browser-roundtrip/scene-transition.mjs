import { Task } from 'molstar/lib/mol-task/task.js';

/** Mol* 5.11 public Canvas3D boundary. A batch is one indivisible render object,
 * not a promise of a millisecond bound on a buffer upload or shader compile. */
export async function prepareRepresentationUploads({ canvas, representation, yieldFrame, check = () => {} }) {
  const repr = representation.obj.data.repr;
  if (repr.state.visible) throw new Error('A replacement must stay hidden while its geometry uploads.');
  const batches = [];
  // State creation automatically adds even a hidden representation. Cancel that
  // pending add before yielding, then submit its objects one at a time.
  canvas.remove(repr);
  try {
    for (const object of repr.renderObjects) {
      check();
      // Canvas3D only reads these Representation members. Keep each facade
      // static; the real representation owns geometry, state and destruction.
      const batch = Object.create(repr);
      Object.defineProperty(batch, 'renderObjects', { value: [object] });
      batches.push(batch);
      canvas.add(batch);
      canvas.commit(false);
      await yieldFrame();
      check();
    }
    // Remove then add in the same task. Mol* CommitQueue cancels the pending
    // removals; Scene.add reuses the existing renderables and their buffers.
    for (const batch of batches) canvas.remove(batch);
    canvas.add(repr);
    canvas.commit(false);
    return batches.length;
  } catch (error) {
    for (const batch of batches) canvas.remove(batch);
    canvas.remove(repr);
    canvas.commit(false);
    throw error;
  }
}

/**
 * Mol* 5.11 measures shouldUpdate from BEFORE its scheduler yield. A slow XR
 * frame can consume the entire next work slice, causing every tiny surface
 * chunk to yield again. Restart the shared tree's 8 ms work budget on resume.
 * Only this observable context is decorated. Unsupported runtime shapes keep
 * Mol*'s original behavior, and all own descriptors are restored on completion.
 */
export function installTransitionWorkBudget(context, budget, wrapChild) {
  const names = ['shouldUpdate', 'update', 'runChild'];
  const originals = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(context, name)]));
  let prototype = context, descriptor;
  while (prototype && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(prototype, 'shouldUpdate'); prototype = Object.getPrototypeOf(prototype); }
  if (typeof descriptor?.get !== 'function' || typeof context.update !== 'function'
    || typeof context.runChild !== 'function' || !Object.isExtensible(context)
    || names.some(name => originals[name]?.configurable === false)) return undefined;
  const originalShouldUpdate = descriptor.get, update = context.update.bind(context), runChild = context.runChild.bind(context);
  const restore = () => {
    for (const name of names) {
      if (originals[name]) Object.defineProperty(context, name, originals[name]);
      else delete context[name];
    }
  };
  try {
    Object.defineProperties(context, {
      shouldUpdate: { configurable: true, get() {
        originalShouldUpdate.call(context); // Retain Mol*'s abort check on every poll.
        return budget.now() - budget.resumedAt >= 8;
      } },
      update: { configurable: true, writable: true, value(...args) {
        const pending = update(...args);
        // dontNotify may return undefined and does not yield or reset work time.
        return pending?.then ? pending.then(value => { budget.resumedAt = budget.now(); return value; }) : pending;
      } },
      runChild: { configurable: true, writable: true, value(child, progress) { return runChild(wrapChild(child), progress); } },
    });
  } catch { restore(); return undefined; }
  return restore;
}

/** Observable, cooperative tasks; indivisible kernels still need device timing. */
export async function runTransitionTask(task, check = () => {}, { now = () => performance.now() } = {}) {
  check();
  const budget = { now, resumedAt: now() };
  const wrap = original => Task.create(original.name, async context => {
    const restore = installTransitionWorkBudget(context, budget, wrap);
    try { return await original.runInContext(context); }
    finally { restore?.(); }
  });
  let cancelled;
  try {
    const result = await wrap(task).run(progress => {
      try { check(); } catch (error) { cancelled = error; progress.requestAbort(error.message); }
    }, 8);
    check();
    return result;
  } catch (error) { throw cancelled ?? error; }
}

/** Primary modifiers belong to their representation while old and new coexist.
 * Auxiliary components retain their existing per-component suffixes. */
export function representationLayerRef(representation, base, suffix = '') {
  if (typeof base !== 'string') return base;
  return !suffix && representation?.ref?.startsWith('stereofold-transition-')
    ? `${base}-${representation.ref}` : `${base}${suffix}`;
}
