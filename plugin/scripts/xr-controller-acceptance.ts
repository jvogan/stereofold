import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { createRequire } from 'node:module';
const { Mat4, Vec3 } = createRequire(import.meta.url)('molstar/lib/commonjs/mol-math/linear-algebra.js') as typeof import('molstar/lib/mol-math/linear-algebra');
import { xrToolbarControllerPose } from './xr-toolbar-controller-pose.js';
import { runViewpointAcceptance } from './xr-viewpoint-acceptance.js';
import { runGenericMenuDragAcceptance, runGripMenuDragAcceptance } from './xr-menu-drag-acceptance.js';

/** Browser task admission returns no promise across CDP. Native-frame work
 * remains pinned, bounded and observable even during controller-driven resets.
 */
export function beginControllerFrameWait(duration: number): number {
    const test = (globalThis as any).__companionXrTest, active = test.active;
    const control = (globalThis as any).__controllerAcceptance;
    const wait: any = { id: (control.frameWaitSerial ?? 0) + 1, duration, started: performance.now(), frames: 0, settled: false };
    if (control.frameWait && !control.frameWait.settled) throw Error('Controller frame wait is already running');
    control.frameWaitSerial = wait.id;
    // Retain the native-frame task in the browser; return only its scalar ID
    // to CDP. Even a pinned promise can be lost by CDP during a rendered reset.
    control.frameWait = wait;
    wait.promise = (async () => {
      do { await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Native XR frame did not arrive')), 20_000);
          try { active.session.requestAnimationFrame((_at: number, frame: any) => {
            clearTimeout(timer); wait.frames++;
            try {
              const pose = frame.getViewerPose(active.space);
              if (pose) {
                const { position: p, quaternion: q } = test.device;
                control.viewerFrame = { viewerFromRoom: Array.from(pose.transform.inverse.matrix),
                  viewerPose: { position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } } };
              }
              control.nativeGrips = {};
              for (const source of active.session.inputSources) {
                const grip = source.gripSpace && frame.getPose(source.gripSpace, active.space);
                if (grip) {
                  const p = grip.transform.position;
                  control.nativeGrips[source.handedness] = [p.x, p.y, p.z];
                }
              }
              resolve();
            } catch (error) { reject(error); }
          }); } catch (error) { clearTimeout(timer); reject(error); }
        }); } while (performance.now() - wait.started < duration);
    })();
    wait.promise.then(() => { wait.settled = true; }, (error: any) => {
      wait.error = error instanceof Error ? error.message : String(error); wait.settled = true;
    });
    return wait.id;
}

export async function waitControllerFrames(page: Page, duration: number): Promise<void> {
  const id = await page.evaluate(beginControllerFrameWait, duration);
  await page.waitForFunction(id => {
    const wait = (globalThis as any).__controllerAcceptance?.frameWait;
    return wait?.id !== id || wait.settled;
  }, id, { timeout: duration + 25_000, polling: 25 });
  const result = await page.evaluate(id => {
    const wait = (globalThis as any).__controllerAcceptance?.frameWait;
    if (wait?.id !== id) throw Error('Controller frame wait was replaced before observation');
    return { error: wait.error, settled: wait.settled, frames: wait.frames };
  }, id);
  if (result.error) throw Error(result.error);
  assert.ok(result.settled && result.frames > 0, 'Controller frame wait did not observe a native XR frame');
}

/** Serialization and repeated Euler normalization can differ at float precision. */
export function sameControllerPlacement(actual: any, expected: any): boolean {
  const sameNumber = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number'
    && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8;
  return sameNumber(actual?.scale, expected?.scale) && ['translation', 'rotation'].every(key =>
    Array.isArray(actual?.[key]) && Array.isArray(expected?.[key]) && actual[key].length === 3 && expected[key].length === 3
    && actual[key].every((value: number, axis: number) => sameNumber(value, expected[key][axis])));
}

/** Independent readout: raw scientific source bounds, committed GPU transform,
 * and a native XR viewer pose. No production grip/placement helper is used. */
export function controllerGripFrame(sample: any) {
  const vector = (values: number[]) => Vec3.create(values[0], values[1], values[2]);
  for (const key of ['matrix', 'renderFromRoom', 'viewerFromRoom'])
    assert.ok(sample[key]?.length === 16 && sample[key].every(Number.isFinite), `Invalid measured ${key}`);
  assert.ok(sample.sourceCenter?.length === 3 && sample.sourceCenter.every(Number.isFinite)
    && sample.cameraScale > 0 && Number.isFinite(sample.cameraScale), 'Invalid measured molecular source geometry');
  const centerRender = Vec3.transformMat4(Vec3(), vector(sample.sourceCenter), Mat4.fromArray(Mat4(), sample.matrix, 0));
  Vec3.scale(centerRender, centerRender, sample.cameraScale);
  const roomFromRender = Mat4.invert(Mat4(), Mat4.fromArray(Mat4(), sample.renderFromRoom, 0));
  const roomFromViewer = Mat4.invert(Mat4(), Mat4.fromArray(Mat4(), sample.viewerFromRoom, 0));
  const centerRoom = Vec3.transformMat4(Vec3(), centerRender, roomFromRender);
  const headRoom = Mat4.getTranslation(Vec3(), roomFromViewer);
  const radial = Vec3.sub(Vec3(), centerRoom, headRoom);
  assert.ok(Vec3.magnitude(radial) > .01, 'Measured molecule is too close to define a depth axis');
  const depthAxis = Vec3.normalize(Vec3(), radial);
  const reference = Math.abs(depthAxis[1]) < .9 ? Vec3.create(0, 1, 0) : Vec3.create(1, 0, 0);
  const lateralA = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), depthAxis, reference));
  const lateralB = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), depthAxis, lateralA));
  return { centerRoom: Array.from(centerRoom), headRoom: Array.from(headRoom), depthAxis: Array.from(depthAxis),
    lateralA: Array.from(lateralA), lateralB: Array.from(lateralB) };
}

/** Check axial and perpendicular components separately in measured room metres. */
export function assertControllerGripResponse(input: number[], output: number[], axis: number[], label: string) {
  assert.ok([input, output, axis].every(v => v.length === 3 && v.every(Number.isFinite)), `${label}: non-finite measured movement`);
  assert.ok(Math.abs(Math.hypot(...axis) - 1) < 1e-6, `${label}: non-unit measured axis`);
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const inputDepth = dot(input, axis), outputDepth = dot(output, axis);
  const inputLateral = input.map((value, i) => value - inputDepth * axis[i]);
  const outputLateral = output.map((value, i) => value - outputDepth * axis[i]);
  // 0.1 mm is above Float32 GPU-transform quantization, far below the 60 mm
  // difference between 1x and 2.5x for each deliberate 40 mm axial move.
  const toleranceMetres = .0001;
  assert.ok(Math.abs(outputDepth - inputDepth * 2.5) < toleranceMetres,
    `${label}: axial travel expected ${inputDepth * 2.5} m, got ${outputDepth} m`);
  assert.ok(Math.hypot(...outputLateral.map((value, i) => value - inputLateral[i])) < toleranceMetres,
    `${label}: lateral travel expected ${JSON.stringify(inputLateral)} m, got ${JSON.stringify(outputLateral)} m`);
  return { input, output, axis, inputDepth, outputDepth, inputLateral, outputLateral, toleranceMetres };
}

/** Retain only the current production row publication across ring eviction.
 * A newer/incomplete draw or teardown can never fall back to an older seat. */
export function createControllerMenuObservation() {
  let draw = -1, minimumDraw = 0;
  const chunks = new Map<number, any>();
  return {
    record(entry: any) {
      if (entry?.kind !== 'toolbar') return;
      const detail = entry.detail;
      if (detail.phase === 'redraw-dispose' || detail.closed === true
        || ((detail.phase === 'hidden' || detail.phase === 'seat-commit') && detail.hidden === true)) {
        chunks.clear(); minimumDraw = draw + 1; return;
      }
      if (detail.phase !== 'rows' || !Number.isInteger(detail.draw) || detail.draw < draw || detail.draw < minimumDraw) return;
      if (detail.draw !== draw) { draw = detail.draw; chunks.clear(); }
      chunks.set(detail.from, detail);
    },
    current() {
      const parts = [...chunks.values()].sort((a, b) => a.from - b.from);
      const total = parts[0]?.total;
      if (!Number.isInteger(total) || total <= 0) return null;
      const rows: any[] = [];
      for (const part of parts) {
        if (part.hidden || part.total !== total || part.from !== rows.length
          || !['x','y','z','labels','actions'].every(key => Array.isArray(part[key]) && part[key].length === part.x.length)) return null;
        for (let i = 0; i < part.x.length; i++) rows.push({ label: part.labels[i], action: part.actions[i],
          x: part.x[i], y: part.y[i], z: part.z[i] });
      }
      return rows.length === total ? { draw, rows } : null;
    },
  };
}

/** A pointed-grab case must hit the molecule. Empty-space stick yaw also has
 * a production modifier admission, regardless of controller pose quality. */
export function controllerTriggerAdmission(entries: any[], hand: string, expected: 'pointed-ray' | 'depth-yaw'):
  'ray-grab' | 'depth-yaw-modifier' | undefined {
  let start: any;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if ((entry.kind === 'xr-grab' && entry.detail.hand === hand && entry.detail.event === 'start' && entry.detail.kind === 'ray')
      || (expected === 'depth-yaw' && entry.kind === 'xr-stick' && entry.detail.hand === hand
        && entry.detail.event === 'modifier' && entry.detail.mode === 'depth-yaw')) {
      start = entry;
      break;
    }
  }
  if (!start || entries.some(entry => entry.seq > start.seq && entry.kind === 'xr-grab' && entry.detail.event === 'end')) return;
  return start.kind === 'xr-grab' ? 'ray-grab' : 'depth-yaw-modifier';
}

/** Simulator preparation only: a cancelled held press needs a fresh release.
 * Never retry movement, direction or saved-scene assertions. */
export async function prepareControllerTrigger({ prepare, observe, release, settleNeutral, record }: {
  prepare: () => Promise<void>;
  observe: () => Promise<{ admission?: 'ray-grab' | 'depth-yaw-modifier'; heldFrameGaps: { gapMs: number; at: number }[] }>;
  release: () => Promise<void>;
  settleNeutral: () => Promise<void>;
  record: (value: Record<string, unknown>) => void;
}) {
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await release(); await settleNeutral();
      await prepare();
      const observation = await observe();
      if (observation.admission) {
        record({ attempt, admission: observation.admission, ready: true });
        return;
      }
      const gaps = observation.heldFrameGaps.filter(gap => gap.gapMs > 500);
      record({ attempt, ready: false, reason: gaps.length ? 'held-input-frame-gap' : 'missing-production-admission', gaps });
      if (!gaps.length) throw Error('Trigger preparation did not reach production grab/modifier admission; no interrupted-frame retry applies.');
    }
    throw Error('Trigger preparation was interrupted by held-input frame gaps on all three attempts.');
  } catch (error) {
    await release(); await settleNeutral();
    throw error;
  }
}

/** Real companion, IWER sources and saved scene. Pose-quality faults are injected
 * only into this isolated simulator. No production input or placement API is called. */
export async function runControllerAcceptance(page: Page, readSaved: () => Promise<any>, evidence: any = {}) {
  Object.assign(evidence, { scope: 'IWER production viewer integration with injected pose quality; physical headset not tested', cases: [] });
  await page.evaluate(({ menuFactory }) => {
    const test = (globalThis as any).__companionXrTest;
    const runtime = (globalThis as any).IWER;
    const original = runtime.XRFrame.prototype.getPose;
    const control: any = { modes: { left: 'tracked', right: 'tracked' }, gripModes: {}, currentFrame: undefined, lastFrameAt: undefined, frameGaps: [], maximumFrameGapMs: 0, samples: new Map(), restored: false };
    // The serialized factory is shared with the unit tests. It observes only
    // genuine diagnostics publications and never asks the menu to redraw.
    control.menuObservation = (0, eval)(`(${menuFactory})`)();
    const diagnostics = (globalThis as any).__stereofoldDiagnostics, originalRecord = diagnostics.record;
    for (const entry of diagnostics.entries()) control.menuObservation.record(entry);
    const observeRows = function(kind: string, detail: any) {
      const entry = originalRecord.call(diagnostics, kind, detail);
      control.menuObservation.record(entry);
      return entry;
    };
    diagnostics.record = observeRows;
    const axesRestores: (() => void)[] = [];
    control.sourceChanges = [];
    const sourcesChanged = (event: any) => control.sourceChanges.push({
      frame: test.active.rafCount,
      removed: [...(event.removed ?? [])].map((source: any) => source.handedness),
      added: [...(event.added ?? [])].map((source: any) => source.handedness),
    });
    test.active.session.addEventListener('inputsourceschange', sourcesChanged);
    runtime.XRFrame.prototype.getPose = function (space: any, base: any) {
      if (control.currentFrame !== this.predictedDisplayTime) {
        const at = performance.now();
        if (control.lastFrameAt !== undefined) {
          const gapMs = at - control.lastFrameAt;
          control.maximumFrameGapMs = Math.max(control.maximumFrameGapMs, gapMs);
          if (gapMs > 500) control.frameGaps.push({ at: Date.now(), gapMs, input: control.input, modes: { ...control.modes } });
        }
        control.lastFrameAt = at;
      }
      control.currentFrame = this.predictedDisplayTime;
      const source = [...test.active.session.inputSources].find((s: any) => s.targetRaySpace === space || s.gripSpace === space);
      const mode = source && space === source.gripSpace ? control.gripModes[source.handedness] ?? control.modes[source.handedness]
        : source && control.modes[source.handedness];
      if (source && mode === 'null') return null;
      const pose = original.call(this, space, base);
      if (pose && source) Object.defineProperty(pose, 'emulatedPosition', { value: mode === 'emulated' });
      return pose;
    };
    control.observeAxes = (source: any) => {
      const gamepad = source.gamepad;
      if (gamepad.__counted) return;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(gamepad), 'axes');
      if (!descriptor?.get) throw Error('IWER axes getter unavailable');
      Object.defineProperty(gamepad, '__counted', { value: true, configurable: true });
      Object.defineProperty(gamepad, 'axes', { configurable: true, get() {
        const axes = descriptor.get!.call(this);
        // The adapter snapshots with Array.from; stock Mol* only indexes axes.
        return new Proxy(axes, { get(target, key) {
          if (key === Symbol.iterator) return function* () {
            const id = `${source.handedness}:${control.currentFrame}`;
            control.samples.set(id, (control.samples.get(id) ?? 0) + 1);
            yield* target;
          };
          return Reflect.get(target, key, target);
        } });
      } });
      axesRestores.push(() => { delete gamepad.axes; delete gamepad.__counted; });
    };
    control.restore = () => { runtime.XRFrame.prototype.getPose = original; test.active.session.removeEventListener('inputsourceschange', sourcesChanged); for (const restore of axesRestores) restore(); if (diagnostics.record === observeRows) diagnostics.record = originalRecord; control.restored = true; };
    (globalThis as any).__controllerAcceptance = control;
  }, { menuFactory: createControllerMenuObservation.toString() });
  const frameWait = (milliseconds: number) => waitControllerFrames(page, milliseconds);
  const state = () => readSaved().then(saved => ({ revision: saved.inspectionRevision, placement: saved.scene.inspection.placement }));
  const until = async (predicate: (value: any) => boolean, label: string) => {
    const end = Date.now() + 30_000;
    do { const value = await state(); if (predicate(value)) return value; await page.waitForTimeout(100); } while (Date.now() < end);
    throw Error(`Controller acceptance: ${label}; last ${JSON.stringify(await state())}`);
  };
  const button = (hand: string, name: string, value: number) => page.evaluate(({ hand, name, value }) => {
    (globalThis as any).__controllerAcceptance.input = { hand, button: name, value };
    (globalThis as any).__companionXrTest.device.controllers[hand].updateButtonValue(name, value);
  }, { hand, name, value });
  const stick = (hand: string, x: number, y: number) => page.evaluate(({ hand, x, y }) => {
    (globalThis as any).__controllerAcceptance.input = { hand, stick: [x, y] };
    (globalThis as any).__companionXrTest.device.controllers[hand].updateAxes('thumbstick', x, y);
  }, { hand, x, y });
  const ring = () => page.evaluate(() => (globalThis as any).__stereofoldDiagnostics.entries());
  const unchangedVector = (actual: number[], expected: number[], label: string) => {
    assert.ok(actual.length === expected.length && actual.every((value, axis) => Math.abs(value - expected[axis]) < 1e-8),
      `${label}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`);
  };
  const prepareTrigger = async (hand: string, record: any, label: string, expected: 'pointed-ray' | 'depth-yaw') => {
    const attempts: any[] = [];
    (record.triggerPreparation ??= []).push({ label, expected, attempts });
    let since = { seq: -1, at: 0 };
    await prepareControllerTrigger({
      release: async () => { await stick(hand, 0, 0); await button(hand, 'trigger', 0); },
      // Two fresh neutral frames expose the release to both the input adapter
      // and its modifier. No elapsed-time or production guard is changed.
      settleNeutral: async () => { await frameWait(0); await frameWait(0); },
      prepare: async () => {
        since = { seq: (await ring()).at(-1)?.seq ?? -1, at: Date.now() };
        await button(hand, 'trigger', 1); await frameWait(280);
      },
      observe: async () => {
        const observation = await page.evaluate(({ hand, since }) => {
          const entries = (globalThis as any).__stereofoldDiagnostics.entries().filter((entry: any) => entry.seq > since.seq);
          const gaps = (globalThis as any).__controllerAcceptance.frameGaps.filter((gap: any) => gap.at >= since.at
            && gap.input?.hand === hand && gap.input?.button === 'trigger' && gap.input?.value === 1);
          return { entries: entries.filter((entry: any) => entry.kind === 'xr-grab' || entry.kind === 'xr-stick'),
            heldFrameGaps: gaps.map(({ gapMs, at }: any) => ({ gapMs, at })) };
        }, { hand, since });
        return { admission: controllerTriggerAdmission(observation.entries, hand, expected), heldFrameGaps: observation.heldFrameGaps };
      },
      record: value => attempts.push(value),
    });
  };
  try {
    for (const hand of ['left', 'right']) for (const mode of ['tracked', 'emulated', 'null']) {
      await page.evaluate(({ hand, mode }) => {
        const test = (globalThis as any).__companionXrTest;
        const control = (globalThis as any).__controllerAcceptance;
        for (const side of ['left', 'right']) {
          const controller = test.device.controllers[side];
          controller.updateAxes('thumbstick', 0, 0);
          for (const name of ['trigger', 'squeeze', 'thumbstick', side === 'left' ? 'y-button' : 'b-button']) controller.updateButtonValue(name, 0);
          controller.connected = side === hand;
          controller.position.set(0, 1.6, 0); controller.quaternion.set(0, 0, 0, 1);
        }
        control.modes[hand] = mode;
      }, { hand, mode });
      await frameWait(300);
      const expectedTracking = mode === 'null' ? 'unavailable' : mode === 'emulated' ? 'emulated-position' : 'tracked-position';
      const reportedTracking = (await ring()).filter((entry: any) => entry.kind === 'xr-tracking' && entry.detail.hand === hand).at(-1)?.detail.tracking;
      assert.equal(reportedTracking, expectedTracking, `${hand}/${mode} pose quality did not reach the production adapter`);
      await page.evaluate(hand => {
        const source = [...(globalThis as any).__companionXrTest.active.session.inputSources].find((source: any) => source.handedness === hand);
        (globalThis as any).__controllerAcceptance.observeAxes(source);
      }, hand);
      // Reset is driven through the same pose-independent face-button reader.
      const beforeReset = await state();
      const beforeResetSeq = (await ring()).at(-1)?.seq ?? -1;
      await button(hand, 'thumbstick', 1); await frameWait(70); await button(hand, 'thumbstick', 0);
      // Entry size is chosen by the room/geometry solver and can exceed 2x.
      // Require this button's completed reset after a rendered mutation, then
      // match the saved placement against the live, read-only menu state.
      await page.waitForFunction(since => (globalThis as any).__stereofoldDiagnostics.entries().some((entry: any) =>
        entry.seq > since && entry.kind === 'xr-button' && entry.detail.action === 'recenter-structure'
        && Number.isFinite(entry.detail.scale)), beforeResetSeq, { timeout: 30_000 });
      const resetEvents = (await ring()).filter((entry: any) => entry.seq > beforeResetSeq);
      const resetCompleted = resetEvents.find((entry: any) => entry.kind === 'xr-button'
        && entry.detail.action === 'recenter-structure' && Number.isFinite(entry.detail.scale));
      assert.ok(resetEvents.some((entry: any) => entry.kind === 'xr-button' && entry.detail.hand === hand
        && entry.detail.button === 'stick' && entry.detail.action === 'recenter-structure'), `${hand}/${mode} reset did not start from the controller`);
      assert.ok(resetEvents.some((entry: any) => entry.seq < resetCompleted.seq && entry.kind === 'render-operation-cost'
        && entry.detail.operation === 'inspection' && entry.detail.outcome === 'rendered'), `${hand}/${mode} reset did not render`);
      const resetView = await page.evaluate(() => (globalThis as any).__stereofoldMenu.state());
      evidence.pendingReset = { hand, mode, before: beforeReset, completed: resetCompleted, live: resetView };
      assert.equal(resetView.motion?.paused, true, `${hand}/${mode} reset left automatic motion playing`);
      assert.equal(resetView.placement.scale, resetCompleted.detail.scale, `${hand}/${mode} reset result differs from the live entry placement`);
      const resetChanged = !sameControllerPlacement(beforeReset.placement, resetView.placement);
      evidence.pendingReset.changed = resetChanged;
      const reset = await until(value => {
        evidence.pendingReset.latestSaved = value;
        // An already-restored entry pose is a valid no-op. Its controller
        // action and render were checked above; only a changed pose owes a
        // new saved revision.
        return (resetChanged ? value.revision > beforeReset.revision : value.revision >= beforeReset.revision)
          && sameControllerPlacement(value.placement, resetView.placement);
      }, `${hand}/${mode} completed reset placement was not saved`);
      const record: any = { hand, mode, reportedTracking, reset, resetProof: { completed: resetCompleted, live: resetView, changed: resetChanged },
        inputs: 'IWER gamepad controls via native XR frames', poseInjection: true };
      evidence.cases.push(record);
      delete evidence.pendingReset;
      await frameWait(300);
      assert.deepEqual((await state()).placement, reset.placement, `${hand}/${mode} entry placement drifted before controller input`);
      if (hand === 'left' && mode === 'tracked') {
        record.viewpoint = {};
        await runViewpointAcceptance(page, readSaved, frameWait, record.viewpoint);
      }
      // Both tracked and emulated targets must traverse the pointed ray grab;
      // a null pose must still admit the trigger's depth modifier without aim.
      const seq = (await ring()).at(-1)?.seq ?? -1;
      const pointedAdmission = mode === 'null' ? 'depth-yaw' : 'pointed-ray';
      await prepareTrigger(hand, record, 'pull', pointedAdmission);
      await stick(hand, 0, 1); await frameWait(420); await stick(hand, 0, 0);
      await button(hand, 'trigger', 0);
      record.depth = await until(value => value.revision > reset.revision && Math.hypot(...value.placement.translation.map((v: number, i: number) => v - reset.placement.translation[i])) > .01,
        `${hand}/${mode} trigger-stick pull did not change saved translation`);
      assert.equal(record.depth.placement.scale, reset.placement.scale, `${hand}/${mode} depth stick resized`);
      const events = (await ring()).filter((entry: any) => entry.seq > seq);
      if (mode !== 'null') assert.ok(events.some((entry: any) => entry.kind === 'xr-grab' && entry.detail.event === 'start' && entry.detail.kind === 'ray'), `${hand}/${mode} never targeted the molecule`);
      record.targetedRayGrab = mode !== 'null';
      await frameWait(250);
      // Reverse depth with the same controller, release, and continue pushing.
      // Timing can differ between native frames, so compare signed movement,
      // not an assumed exact inverse of the previous wall-clock duration.
      record.push = [];
      const pullDirection = record.depth.placement.translation.map((v: number, i: number) => v - reset.placement.translation[i]);
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = await state();
        await prepareTrigger(hand, record, `push-${repeat + 1}`, pointedAdmission);
        await stick(hand, 0, -1); await frameWait(420); await stick(hand, 0, 0);
        await button(hand, 'trigger', 0);
        const after = await until(value => value.revision > before.revision
          && value.placement.translation.reduce((dot: number, v: number, i: number) => dot + (v - before.placement.translation[i]) * pullDirection[i], 0) < -.001,
        `${hand}/${mode} push ${repeat + 1} did not reverse the pull`);
        assert.equal(after.placement.scale, before.placement.scale, `${hand}/${mode} pushing resized`);
        unchangedVector(after.placement.rotation, before.placement.rotation, `${hand}/${mode} pushing rotated`);
        record.push.push({ before, after });
        await frameWait(250);
        assert.ok(sameControllerPlacement((await state()).placement, after.placement), `${hand}/${mode} push reverted on release`);
      }
      if (mode !== 'null') {
        record.genericMenuDrag = {};
        await runGenericMenuDragAcceptance(page, frameWait, state, sameControllerPlacement, hand, mode, record.genericMenuDrag);
      }
      if (mode === 'tracked') {
        record.gripMenuDrag = {};
        await runGripMenuDragAcceptance(page, frameWait, state, hand, record.gripMenuDrag);
        // Aim a real IWER controller just 10 cm from the menu's reseat row. Its distance
        // from the glass must not disable dragging. Inject a tracking jump
        // while held; only the two deliberate small moves may relocate it.
        const beforeMenuScene = await state();
        const menuRow = async () => page.evaluate(() => {
          const test = (globalThis as any).__companionXrTest;
          if (!(globalThis as any).__stereofoldMenu || !test.active?.session || test.active.ended) return null;
          const publication = (globalThis as any).__controllerAcceptance.menuObservation.current();
          const row = publication?.rows.find((value: any) => JSON.parse(value.action)?.kind === 'recenter-menu');
          return row ? { draw: publication.draw, ...row } : null;
        });
        let initialRow = await menuRow();
        if (!initialRow) {
          // No complete current expanded publication exists. A native face
          // tap can expand a compact menu; observed rows survive ring eviction.
          const since = (await ring()).at(-1)?.seq ?? -1;
          await page.evaluate(hand => {
            const control = (globalThis as any).__controllerAcceptance;
            const test = (globalThis as any).__companionXrTest;
            const controller = test.device.controllers[hand], face = hand === 'left' ? 'y-button' : 'b-button';
            // Tool round trips can stretch a short press into a long hold.
            // Release in the next native frame inside the same evaluation.
            control.menuSummon = new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { controller.updateButtonValue(face, 0); reject(Error('No menu summon XR frame')); }, 20_000);
              controller.updateButtonValue(face, 1);
              test.active.session.requestAnimationFrame(() => { controller.updateButtonValue(face, 0); clearTimeout(timer); resolve(); });
            });
            return control.menuSummon;
          }, hand);
          await page.waitForFunction(since => (globalThis as any).__stereofoldDiagnostics.entries().some((entry: any) =>
            entry.seq > since && entry.kind === 'toolbar' && entry.detail.phase === 'rows'), since, { timeout: 30_000 });
          await frameWait(50);
          initialRow = await menuRow();
        }
        assert.ok(initialRow, `${hand} no complete rendered recenter-menu row after summoning`);
        const measured = await page.evaluate(() => (globalThis as any).__controllerAcceptance.viewerFrame);
        // Labels/actions are diagnostics metadata, not transform components.
        const aim = xrToolbarControllerPose({ x: initialRow.x, y: initialRow.y, z: initialRow.z },
          measured.viewerFromRoom, measured.viewerPose, .1);
        const moveMenuHand = (dx: number) => page.evaluate(({ hand, aim, dx }) => {
          const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
          controller.position.set(aim.position.x + dx, aim.position.y, aim.position.z);
          controller.quaternion.set(aim.quaternion.x, aim.quaternion.y, aim.quaternion.z, aim.quaternion.w);
        }, { hand, aim, dx });
        await moveMenuHand(0); await frameWait(100);
        const menuSeq = (await ring()).at(-1)?.seq ?? -1;
        await button(hand, 'trigger', 1); await frameWait(260);
        assert.ok((await ring()).some((entry: any) => entry.seq > menuSeq && entry.kind === 'toolbar'
          && entry.detail.phase === 'selectstart' && entry.detail.hit === initialRow.label), `${hand} close menu aim missed ${initialRow.label}`);
        await moveMenuHand(-.03); await frameWait(80);
        await moveMenuHand(-.63); await frameWait(80);
        await moveMenuHand(-.65); await frameWait(80);
        await button(hand, 'trigger', 0); await frameWait(300);
        const finalRow = await menuRow();
        assert.ok(finalRow, `${hand} no complete rendered recenter-menu row after release`);
        assert.equal(finalRow.action, initialRow.action, `${hand} close menu drag changed the targeted action`);
        const horizontalTravel = initialRow.x - finalRow.x;
        // Release faces the panel toward its seat origin, so a row's exact
        // position changes slightly with that rotation. Exact anchor deltas
        // are covered by the production toolbar unit tests.
        assert.ok(finalRow.draw > initialRow.draw && horizontalTravel > .02 && horizontalTravel < .12,
          `${hand} close menu drag/jump produced ${horizontalTravel} m of row travel`);
        assert.ok(sameControllerPlacement((await state()).placement, beforeMenuScene.placement),
          `${hand} menu drag changed the molecule`);
        assert.ok(!(await ring()).some((entry: any) => entry.seq > menuSeq && entry.kind === 'xr-grab'
          && entry.detail.event === 'start'), `${hand} menu drag started a molecule grab`);
        record.menuDrag = { scope: 'Native controller at 10 cm; two small moves around an injected 0.6 m jump; rendered row movement',
          initialRow, finalRow, horizontalTravel };
        await page.evaluate(hand => {
          const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
          controller.position.set(0, 1.6, 0); controller.quaternion.set(0, 0, 0, 1);
        }, hand);
        await frameWait(250);
        // Compare a normal 2 cm grip move with a position/orientation jump
        // followed by the same move. Only the intended 2 cm may be saved.
        const pose = (x: number, yaw = 0) => page.evaluate(({ hand, x, yaw }) => {
          const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
          controller.position.set(x, 1.6, 0);
          controller.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        }, { hand, x, yaw });
        const baseline = await state();
        await button(hand, 'squeeze', 1); await frameWait(80);
        await pose(.02); await frameWait(80); await button(hand, 'squeeze', 0);
        const moved = await until(value => value.revision > baseline.revision
          && value.placement.translation[0] > baseline.placement.translation[0], `${hand} reference grip movement was not saved`);
        await frameWait(250);
        const beforeSeq = (await ring()).at(-1)?.seq ?? -1;
        await button(hand, 'squeeze', 1); await frameWait(80);
        await pose(.62, 1); await frameWait(80);
        await pose(.64, 1); await frameWait(80); await button(hand, 'squeeze', 0);
        const recovered = await until(value => value.revision > moved.revision, `${hand} recovered grip movement was not saved`);
        const intended = moved.placement.translation[0] - baseline.placement.translation[0];
        const actual = recovered.placement.translation[0] - moved.placement.translation[0];
        // The measured 2 cm move calibrates the saved molecular-radius units
        // without calling a production placement API or inspecting closures.
        const unitsPerMetre = intended / .02;
        assert.ok(Math.abs(actual - intended) < Math.abs(intended) * .01 + 1e-6,
          `${hand} tracking jump leaked into translation: reference ${intended}, recovered ${actual}`);
        unchangedVector(recovered.placement.rotation, moved.placement.rotation, `${hand} tracking jump rotated the saved molecule`);
        assert.equal(recovered.placement.scale, moved.placement.scale, `${hand} tracking jump resized the saved molecule`);
        assert.ok((await ring()).some((entry: any) => entry.seq > beforeSeq && entry.kind === 'xr-grab'
          && entry.detail.event === 'rebased' && entry.detail.reason === 'tracking-jump'), `${hand} no tracking discontinuity reached the gesture reader`);
        record.discontinuityRecovery = { baseline, moved, recovered, intended, actual, scope: 'single measured grip, injected 0.6 m position and 1 rad orientation discontinuity' };
        await pose(0); await frameWait(250);
        // Read the actual molecular transform and native reference-space poses.
        // This isolated controller fixture shows the full 1CRN source; its
        // primary representation's source sphere is the visible target centre.
        const gripGeometry = () => page.evaluate(hand => {
          const geometry = (globalThis as any).__stereofoldReadGeometry?.();
          const frame = (globalThis as any).__controllerAcceptance;
          const objects = geometry?.objects?.filter((object: any) => object.state.visible
            && object.values.drawCount.ref.value > 0 && object.type !== 'text');
          if (!objects?.length || !geometry.sourceBoundary?.center) throw Error('No live source-backed molecular grip geometry');
          const matrix = Array.from(objects[0].values.matrix.ref.value) as number[];
          if (!objects.every((object: any) => Array.from(object.values.matrix.ref.value).every((value, i) =>
            Math.abs(Number(value) - matrix[i]) < 1e-8))) throw Error('Molecular grip fixture has inconsistent committed transforms');
          return { matrix, sourceCenter: Array.from(geometry.sourceBoundary.center), cameraScale: geometry.cameraScale,
            renderFromRoom: Array.from(geometry.renderFromRoom), viewerFromRoom: frame.viewerFrame.viewerFromRoom,
            viewerFrame: frame.viewerFrame, nativeGrip: frame.nativeGrips[hand], objectCount: objects.length,
            drawSerial: (globalThis as any).__companionXrTest.drawSerial() };
        }, hand);
        record.gripAxes = [];
        for (const direction of ['world-x', 'world-y', 'world-z', 'axial', 'lateral-a', 'lateral-b']) for (const sign of [1, -1]) {
          await frameWait(0);
          const before = await state(), beforeSeq = (await ring()).at(-1)?.seq ?? -1;
          const geometryBefore = await gripGeometry(), measured = controllerGripFrame(geometryBefore);
          let deviceDirection: number[];
          if (direction.startsWith('world-')) {
            deviceDirection = [0, 0, 0]; deviceDirection[['world-x', 'world-y', 'world-z'].indexOf(direction)] = 1;
          } else {
            const roomDirection = direction === 'axial' ? measured.depthAxis : direction === 'lateral-a' ? measured.lateralA : measured.lateralB;
            const target = measured.headRoom.map((value, i) => value + roomDirection[i]);
            const mapped = xrToolbarControllerPose({ x: target[0], y: target[1], z: target[2] },
              geometryBefore.viewerFromRoom, geometryBefore.viewerFrame.viewerPose, 1);
            const head = geometryBefore.viewerFrame.viewerPose.position;
            deviceDirection = [mapped.deviceTarget.x - head.x, mapped.deviceTarget.y - head.y, mapped.deviceTarget.z - head.z];
          }
          await button(hand, 'squeeze', 1); await frameWait(80);
          await page.evaluate(({ hand, delta }) => {
            (globalThis as any).__companionXrTest.device.controllers[hand].position.set(delta[0], 1.6 + delta[1], delta[2]);
          }, { hand, delta: deviceDirection.map(value => value * sign * .04) });
          await frameWait(100);
          const nativeGripAfter = await page.evaluate(hand => (globalThis as any).__controllerAcceptance.nativeGrips[hand], hand);
          await button(hand, 'squeeze', 0);
          const after = await until(value => value.revision > before.revision, `${hand} grip ${direction}/${sign} was not saved`);
          await frameWait(80);
          const geometryAfter = await gripGeometry(), afterMeasured = controllerGripFrame(geometryAfter);
          const input = nativeGripAfter.map((value: number, i: number) => value - geometryBefore.nativeGrip[i]);
          const output = afterMeasured.centerRoom.map((value: number, i: number) => value - measured.centerRoom[i]);
          assert.ok(Math.abs(Math.hypot(...input) - .04) < 1e-5, `${hand} ${direction} native grip did not travel 40 mm`);
          const response = assertControllerGripResponse(input, output, measured.depthAxis, `${hand} ${direction}/${sign}`);
          if (direction === 'axial') assert.ok(Math.abs(response.inputDepth - sign * .04) < 1e-5, `${hand} axial fixture was not radial`);
          if (direction.startsWith('lateral')) assert.ok(Math.abs(response.inputDepth) < 1e-5, `${hand} lateral fixture was not perpendicular`);
          assert.equal(after.placement.scale, before.placement.scale, `${hand} grip travel resized`);
          unchangedVector(after.placement.rotation, before.placement.rotation, `${hand} grip travel rotated`);
          const gesture = (await ring()).filter((entry: any) => entry.seq > beforeSeq);
          assert.ok(gesture.some((entry: any) => entry.kind === 'xr-grab' && entry.detail.event === 'start'
            && entry.detail.hand === hand && entry.detail.kind === 'grip'), `${hand} grip ${direction}/${sign} did not enter molecule grab`);
          assert.ok(!gesture.some((entry: any) => entry.kind === 'toolbar' && entry.detail.phase === 'hidden' && entry.detail.hidden === true), `${hand} molecule grip hid the menu`);
          assert.ok(!gesture.some((entry: any) => entry.kind === 'toolbar-action'), `${hand} grip travel activated menu`);
          record.gripAxes.push({ direction, sign, before, after, geometryBefore, geometryAfter, measured, response, menuRemainedVisible: true });
          await page.evaluate(hand => (globalThis as any).__companionXrTest.device.controllers[hand].position.set(0, 1.6, 0), hand);
          await frameWait(250);
          assert.ok(sameControllerPlacement((await state()).placement, after.placement), `${hand} released controller reposition moved molecule`);
        }
        record.wrist = [];
        for (const yaw of [.1, -.1]) {
          const before = await state();
          await button(hand, 'squeeze', 1); await frameWait(80);
          const nativeGripBefore = await page.evaluate(hand => (globalThis as any).__controllerAcceptance.nativeGrips[hand], hand);
          const wristPose = await page.evaluate(({ hand, yaw }) => {
            const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
            const config = (globalThis as any).IWER.metaQuest2.controllerConfig;
            if (controller.profileId !== config.profileId) throw Error('Wrist fixture controller profile does not match its grip offset');
            const offset = config.layout[hand].gripOffsetMatrix.slice(12, 15);
            if (offset.length !== 3 || !offset.every(Number.isFinite)) throw Error('Wrist fixture has no finite grip offset');
            // IWER positions the target ray, whose origin differs from the
            // physical grip. Rotate about the grip by compensating that lever
            // arm before the next native frame, then verify the measured pose.
            const rotated = [Math.cos(yaw) * offset[0] + Math.sin(yaw) * offset[2], offset[1],
              -Math.sin(yaw) * offset[0] + Math.cos(yaw) * offset[2]];
            const point = [offset[0] - rotated[0], 1.6 + offset[1] - rotated[1], offset[2] - rotated[2]];
            controller.position.set(...point);
            controller.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
            return { profile: config.profileId, gripOffset: offset, targetRayPosition: point };
          }, { hand, yaw });
          await frameWait(100);
          const nativeGripAfter = await page.evaluate(hand => (globalThis as any).__controllerAcceptance.nativeGrips[hand], hand);
          assert.ok(nativeGripAfter.every((value: number, i: number) => Math.abs(value - nativeGripBefore[i]) < 1e-6),
            `${hand} pure wrist fixture moved the native grip origin`);
          await button(hand, 'squeeze', 0);
          const after = await until(value => value.revision > before.revision, `${hand} wrist rotation was not saved`);
          const degrees = ((after.placement.rotation[1] - before.placement.rotation[1] + 540) % 360) - 180;
          assert.ok(Math.abs(degrees - yaw * 180 / Math.PI) < .01, `${hand} wrist expected ${yaw * 180 / Math.PI} degrees, got ${degrees}`);
          assert.equal(after.placement.scale, before.placement.scale, `${hand} wrist resized`);
          unchangedVector(after.placement.translation, before.placement.translation, `${hand} wrist moved the molecular centre`);
          record.wrist.push({ yaw, before, after, degrees, wristPose, nativeGripBefore, nativeGripAfter });
          await pose(0); await frameWait(250);
          assert.ok(sameControllerPlacement((await state()).placement, after.placement), `${hand} released wrist rotated molecule`);
        }
        // Saved travel, calibrated by the real 2 cm grip, determines when the
        // pull passes the 1–4 m entry seat. Slow simulator frames must not be
        // mistaken for the wall-clock time actually integrated by the stick.
        record.closePull = [];
        for (const minimumMetres of [4, .4]) {
          const journeyStart = await state();
          const pull: any = { minimumMetres, before: journeyStart.placement, metres: 0, segments: [] };
          record.closePull.push(pull);
          let before = journeyStart;
          for (let attempt = 0; attempt < 6 && pull.metres <= minimumMetres; attempt++) {
            const duration = attempt === 0 && minimumMetres === 4 ? 3000 : 1000;
            // The first pull targets the molecule. Once it crosses the
            // controller plane, the fixed forward ray can miss it; continuing
            // uses the same trigger/stick depth modifier without resetting it.
            const admission = minimumMetres === 4 && attempt === 0 ? pointedAdmission : 'depth-yaw';
            await prepareTrigger(hand, record, `close-pull-${minimumMetres}-${attempt + 1}`, admission);
            await stick(hand, 0, 1); await frameWait(duration); await stick(hand, 0, 0);
            await button(hand, 'trigger', 0);
            const after = await until(value => value.revision > before.revision
              && value.placement.translation[2] > before.placement.translation[2] + .01,
            `${hand} close pull stopped or did not persist`);
            assert.equal(after.placement.scale, before.placement.scale, `${hand} close pull resized`);
            unchangedVector(after.placement.rotation, before.placement.rotation, `${hand} close pull rotated`);
            pull.segments.push({ duration, before: before.placement, after: after.placement });
            pull.after = after.placement;
            pull.metres = (after.placement.translation[2] - journeyStart.placement.translation[2]) / unitsPerMetre;
            before = after; await frameWait(250);
          }
          assert.ok(pull.metres > minimumMetres, `${hand} close pull did not reach ${minimumMetres} m: ${pull.metres} m`);
        }

      }
      // Grow past the former 4x limit, release/save, then grow again.
      for (const [index, duration] of [1200, 350].entries()) {
        const before = await state();
        await button(hand, 'squeeze', 1); await frameWait(80);
        await stick(hand, 0, -1); await frameWait(duration); await stick(hand, 0, 0);
        await button(hand, 'squeeze', 0);
        const minimumGrowth = index === 0 ? 1.3 : 1.05;
        const after = await until(value => value.revision > before.revision && value.placement.scale > before.placement.scale * minimumGrowth,
          `${hand}/${mode} grip-stick resize ${index + 1} did not persist`);
        (record.growth ??= []).push({ before: before.placement.scale, after: after.placement.scale });
        assert.ok(after.placement.scale > 4, `${hand}/${mode} stopped at the former 4x wall`);
        unchangedVector(after.placement.translation, before.placement.translation, `${hand}/${mode} growth moved the saved placement`);
        unchangedVector(after.placement.rotation, before.placement.rotation, `${hand}/${mode} growth rotated the saved placement`);
        await frameWait(250);
        assert.deepEqual((await state()).placement, after.placement, `${hand}/${mode} saved growth reverted during idle frames`);
      }
      record.shrink = [];
      for (const duration of [700, 350]) {
        const before = await state();
        await button(hand, 'squeeze', 1); await frameWait(80);
        await stick(hand, 0, 1); await frameWait(duration); await stick(hand, 0, 0);
        await button(hand, 'squeeze', 0);
        const after = await until(value => value.revision > before.revision && value.placement.scale < before.placement.scale * .95,
          `${hand}/${mode} shrinking did not persist after regrabbing`);
        unchangedVector(after.placement.translation, before.placement.translation, `${hand}/${mode} shrinking moved the saved placement`);
        unchangedVector(after.placement.rotation, before.placement.rotation, `${hand}/${mode} shrinking rotated the saved placement`);
        record.shrink.push({ before, after });
        await frameWait(250);
        assert.ok(sameControllerPlacement((await state()).placement, after.placement), `${hand}/${mode} shrink reverted on release`);
      }
      record.slide = [];
      for (const [axis, x, y, sign] of [[0, 1, 0, 1], [0, -1, 0, -1], [1, 0, -1, 1], [1, 0, 1, -1]]) {
        const before = await state();
        await stick(hand, x, y); await frameWait(400); await stick(hand, 0, 0);
        const after = await until(value => value.revision > before.revision
          && sign * (value.placement.translation[axis] - before.placement.translation[axis]) > .01,
        `${hand}/${mode} slide axis ${axis} sign ${sign} did not persist`);
        assert.equal(after.placement.scale, before.placement.scale, `${hand}/${mode} sliding resized`);
        unchangedVector(after.placement.rotation, before.placement.rotation, `${hand}/${mode} sliding rotated`);
        for (const other of [0, 1, 2].filter(other => other !== axis))
          assert.ok(Math.abs(after.placement.translation[other] - before.placement.translation[other]) < 1e-8,
            `${hand}/${mode} slide axis ${axis} changed axis ${other}`);
        record.slide.push({ axis, sign, before, after });
        await frameWait(250);
        assert.ok(sameControllerPlacement((await state()).placement, after.placement), `${hand}/${mode} slide reverted after release`);
      }
      record.yaw = [];
      for (const sign of [1, -1]) {
        const before = await state();
        await prepareTrigger(hand, record, `yaw-${sign}`, 'depth-yaw');
        await stick(hand, sign, 0); await frameWait(400); await stick(hand, 0, 0);
        await button(hand, 'trigger', 0);
        const yawDelta = (value: any) => ((value.placement.rotation[1] - before.placement.rotation[1] + 540) % 360) - 180;
        const after = await until(value => value.revision > before.revision && sign * yawDelta(value) < -1,
          `${hand}/${mode} yaw ${sign} did not rotate the intended way`);
        assert.equal(after.placement.scale, before.placement.scale, `${hand}/${mode} yaw resized`);
        unchangedVector(after.placement.translation, before.placement.translation, `${hand}/${mode} yaw moved the saved placement`);
        record.yaw.push({ sign, before, after, degrees: yawDelta(after) });
        await frameWait(250);
        assert.ok(sameControllerPlacement((await state()).placement, after.placement), `${hand}/${mode} yaw reverted after release`);
      }
      // Null-ray recovery: turn away, then tap B/Y and require the toolbar's
      // production reseat action and new rendered geometry, not only a callback.
      if (mode === 'null') {
        const beforeSeq = (await ring()).at(-1)?.seq ?? -1;
        await page.evaluate(() => { const head = (globalThis as any).__companionXrTest.device; head.quaternion.set(0, Math.sin(.25), 0, Math.cos(.25)); });
        record.menuTap = await page.evaluate(async hand => {
          const test = (globalThis as any).__companionXrTest;
          const controller = test.device.controllers[hand];
          const name = hand === 'left' ? 'y-button' : 'b-button';
          controller.updateButtonValue(name, 1);
          const start = performance.now();
          await new Promise<void>(resolve => test.active.session.requestAnimationFrame(() => resolve()));
          controller.updateButtonValue(name, 0);
          return { elapsedMs: performance.now() - start, path: 'one native XR frame in one evaluation' };
        }, hand);
        await page.waitForFunction(({ beforeSeq }) => {
          const entries = (globalThis as any).__stereofoldDiagnostics.entries().filter((entry: any) => entry.seq > beforeSeq);
          return entries.some((entry: any) => entry.kind === 'toolbar-action' && entry.detail.kind === 'collapse')
            && entries.some((entry: any) => entry.kind === 'toolbar' && entry.detail.phase === 'rows');
        }, { beforeSeq }, { timeout: 30_000 });
        assert.ok(record.menuTap.elapsedMs < 250, 'Simulator could not supply a short menu tap');
        record.recoveryFrame = await page.evaluate(async () => {
          const test = (globalThis as any).__companionXrTest, active = test.active;
          const before = test.drawSerial(), deadline = performance.now() + 20_000;
          let views: any[] = [];
          do {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(Error('Menu recovery XR frame did not arrive')), 20_000);
              active.session.requestAnimationFrame((_time: number, frame: any) => {
              clearTimeout(timer);
              const pose = frame.getViewerPose(active.space);
              views = [...(pose?.views ?? [])].map((view: any) => ({ eye: view.eye, projection: Array.from(view.projectionMatrix),
                inverse: Array.from(view.transform.inverse.matrix), viewport: (() => { const v = active.session.renderState.baseLayer.getViewport(view); return [v.x,v.y,v.width,v.height]; })() }));
              resolve();
            }); });
          } while (test.drawSerial() === before && performance.now() < deadline);
          const rows = (globalThis as any).__stereofoldDiagnostics.entries().filter((entry: any) => entry.kind === 'toolbar' && entry.detail.phase === 'rows');
          const latestDraw = rows.at(-1)?.detail.draw;
          const points = rows.filter((entry: any) => entry.detail.draw === latestDraw).flatMap((entry: any) => entry.detail.x.map((x: number, i: number) => [x,entry.detail.y[i],entry.detail.z[i],1]));
          const product = (matrix: number[], vector: number[]) => Array.from({ length: 4 }, (_, row) => vector.reduce((sum, value, col) => sum + matrix[col * 4 + row] * value, 0));
          return { drawCallsAfterRecovery: test.drawSerial() - before, rowCount: points.length, boundsScope: 'Recorded row centres only; excludes plate and glyph edges',
            eyes: views.map(view => { const projected = points.map((point: number[]) => { const clip = product(view.projection, product(view.inverse, point)); return [clip[0]/clip[3], clip[1]/clip[3]]; });
              return { eye: view.eye, viewport: view.viewport, rowCentreNdc: { minX: Math.min(...projected.map((p: number[]) => p[0])), maxX: Math.max(...projected.map((p: number[]) => p[0])), minY: Math.min(...projected.map((p: number[]) => p[1])), maxY: Math.max(...projected.map((p: number[]) => p[1])) } }; }) };
        });
        assert.ok(record.recoveryFrame.drawCallsAfterRecovery > 0 && record.recoveryFrame.rowCount > 0, 'Menu recovery did not reach a production render callback');
        assert.deepEqual(record.recoveryFrame.eyes.map((view: any) => view.eye).sort(), ['left', 'right']);
        record.menuRecoveredWithoutAim = true;
        await page.evaluate(() => (globalThis as any).__companionXrTest.device.quaternion.set(0,0,0,1));
      }
      record.tracking = (await ring()).filter((entry: any) => entry.kind === 'xr-tracking' && entry.detail.hand === hand).map((entry: any) => entry.detail.tracking);
      console.log(`Passed native XR controls: ${hand}/${mode}, scale ${record.growth[0].after.toFixed(2)} -> ${record.growth[1].after.toFixed(2)}`);
    }
    evidence.sampling = await page.evaluate(() => {
      const samples = (globalThis as any).__controllerAcceptance.samples;
      return { frames: samples.size, maximumSnapshotsPerHandFrame: Math.max(...samples.values()), doubled: [...samples].filter(([, count]: any) => count !== 1).slice(0, 8) };
    });
    assert.ok(evidence.sampling.frames > 100, 'Too few native frames entered the input adapter');
    assert.equal(evidence.sampling.maximumSnapshotsPerHandFrame, 1, 'A hand was sampled more than once per native XR frame');
    return evidence;
  } finally {
    evidence.frameTiming = await page.evaluate(() => {
      const control = (globalThis as any).__controllerAcceptance;
      return { maximumFrameGapMs: control.maximumFrameGapMs, over500ms: control.frameGaps };
    });
    evidence.sampling ??= await page.evaluate(() => {
      const samples = (globalThis as any).__controllerAcceptance.samples;
      return { frames: samples.size, maximumSnapshotsPerHandFrame: Math.max(...samples.values()), doubled: [...samples].filter(([, count]: any) => count !== 1).slice(0, 8) };
    });
    await page.evaluate(() => (globalThis as any).__controllerAcceptance.restore());
  }
}
