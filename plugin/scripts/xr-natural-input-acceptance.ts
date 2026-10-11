import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { sameControllerPlacement } from './xr-controller-acceptance.js';

type V3 = [number, number, number];

/** Harness-only injection; exported for CPU checks of transforms and event restrictions. */
export function installSyntheticNaturalInput() {
    const test = (globalThis as any).__companionXrTest, runtime = (globalThis as any).IWER;
    const session = test.active.session, originalPose = runtime.XRFrame.prototype.getPose;
    const sourceDescriptor = Object.getOwnPropertyDescriptor(session, 'inputSources');
    const control: any = { sources: [], records: new Map(), spaces: new Map(), eventLog: [], restrictedViewerPoseCalls: 0, serial: 0 };
    const multiply = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, i) =>
      [0, 1, 2, 3].reduce((v, k) => v + a[(i % 4) + k * 4] * b[k + Math.floor(i / 4) * 4], 0));
    const matrix = (position: number[], direction: number[]) => {
      const n = Math.hypot(...direction), z = direction.map(v => -v / n);
      const up = Math.abs(z[1]) > .99 ? [1, 0, 0] : [0, 1, 0];
      let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
      const length = Math.hypot(...x); x = x.map(v => v / length);
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      return [...x, 0, ...y, 0, ...z, 0, ...position, 1];
    };
    runtime.XRFrame.prototype.getPose = function (space: any, base: any) {
      const synthetic = control.spaces.get(space);
      if (!synthetic) return originalPose.call(this, space, base);
      if (synthetic.missing) return null;
      const basePose = originalPose.call(this, test.active.space, base);
      if (!basePose) return null;
      const m = multiply(Array.from(basePose.transform.matrix), matrix(synthetic.position, synthetic.direction));
      return { emulatedPosition: false, transform: { matrix: new Float32Array(m), position: { x: m[12], y: m[13], z: m[14], w: 1 } } };
    };
    Object.defineProperty(session, 'inputSources', { configurable: true, get: () => [...control.sources] });
    control.emit = (type: string, frame: any, source?: any, added: any[] = [], removed: any[] = []) => {
      // WebXR input-event frames permit getPose, but not getViewerPose.
      const eventFrame = { getPose: frame.getPose.bind(frame), getViewerPose() {
        control.restrictedViewerPoseCalls++;
        throw new DOMException('getViewerPose requires an animation frame', 'InvalidStateError');
      }, session, predictedDisplayTime: frame.predictedDisplayTime };
      const event = new Event(type, { cancelable: true });
      Object.defineProperties(event, { frame: { value: eventFrame }, inputSource: { value: source }, session: { value: session }, added: { value: added }, removed: { value: removed } });
      control.eventLog.push({ type, id: source?.fixtureId ?? null, added: added.map(s => s.fixtureId), removed: removed.map(s => s.fixtureId) });
      session.dispatchEvent(event);
    };
    control.create = (eye: number[], direction: number[], grip: number[]) => {
      const id = ++control.serial;
      const source = { fixtureId: id, handedness: 'none', targetRayMode: 'transient-pointer', profiles: ['generic-touchpad'], targetRaySpace: {}, gripSpace: {} };
      control.spaces.set(source.targetRaySpace, { position: [...eye], direction: [...direction] });
      control.spaces.set(source.gripSpace, { position: [...grip], direction: [0, 0, -1] });
      control.records.set(id, source); return id;
    };
    control.restore = () => {
      runtime.XRFrame.prototype.getPose = originalPose;
      if (sourceDescriptor) Object.defineProperty(session, 'inputSources', sourceDescriptor); else delete session.inputSources;
    };
    (globalThis as any).__naturalAcceptance = control;
}

/** Synthetic WebXR input protocol over IWER's real session/frame/render loop.
 * This is neither Safari nor a visionOS simulator. No production action, pick,
 * ownership, camera or placement setter is called by this fixture. */
export async function runNaturalInputAcceptance(page: Page, readSaved: () => Promise<any>, evidence: any = {}) {
  Object.assign(evidence, { scope: 'Synthetic handless/gamepadless transient-pointer events on IWER production renderer; not Apple simulator or physical Vision Pro evidence',
    inputShape: { handedness: 'none', targetRayMode: 'transient-pointer', distinctGripSpace: true, eyeOriginAim: true, hand: false, gamepad: false }, cases: [] });
  await page.evaluate(() => {
    const test = (globalThis as any).__companionXrTest;
    for (const controller of Object.values(test.device.controllers) as any[]) controller.connected = false;
  });
  await page.waitForTimeout(150);
  await page.evaluate(installSyntheticNaturalInput);
  // Every source mutation/event is applied inside a real session callback.
  const step = (operation: string, args: any = {}, frames = 3) => page.evaluate(({ operation, args, frames }) => {
    const test = (globalThis as any).__companionXrTest, c = (globalThis as any).__naturalAcceptance;
    c.pending = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`No XR frame for natural input ${operation}`)), 20_000);
      let remaining = frames;
      const tick = (_time: number, frame: any) => {
        try {
          if (remaining === frames) {
            const source = c.records.get(args.id);
            if (operation === 'start' || operation === 'tap') {
              if (operation === 'tap') c.tap = { started: performance.now(), since: args.since };
              c.sources.push(source); c.emit('inputsourceschange', frame, undefined, [source]); c.emit('selectstart', frame, source);
            } else if (operation === 'move') {
              for (const move of args.moves) {
                const s = c.records.get(move.id), grip = c.spaces.get(s.gripSpace);
                if (move.grip) grip.position = move.grip;
                if (move.rayOrigin) c.spaces.get(s.targetRaySpace).position = move.rayOrigin;
                if (move.missing !== undefined) grip.missing = move.missing;
              }
            } else if (['end', 'cancel', 'vanish'].includes(operation)) {
              if (operation === 'end') { c.emit('select', frame, source); c.emit('selectend', frame, source); }
              if (operation === 'cancel') c.emit('selectcancel', frame, source);
              c.sources = c.sources.filter((s: any) => s !== source);
              c.emit('inputsourceschange', frame, undefined, [], [source]);
            }
          }
          if (operation === 'tap' && remaining === frames - 1) {
            const source = c.records.get(args.id);
            c.tap.beforeRelease = (globalThis as any).__stereofoldDiagnostics.entries().filter((e: any) => e.seq > args.since && e.kind === 'toolbar-action');
            c.tap.heldMs = performance.now() - c.tap.started;
            c.emit('select', frame, source); c.emit('selectend', frame, source);
            c.sources = c.sources.filter((s: any) => s !== source);
            c.emit('inputsourceschange', frame, undefined, [], [source]);
          }
          const pose = frame.getViewerPose(test.active.space);
          if (pose) c.eye = [pose.transform.position.x, pose.transform.position.y, pose.transform.position.z];
          if (--remaining > 0) test.active.session.requestAnimationFrame(tick);
          else { clearTimeout(timer); resolve({ eye: c.eye, live: c.sources.map((s: any) => s.fixtureId), tap: operation === 'tap' ? c.tap : undefined }); }
        } catch (error) { clearTimeout(timer); reject(error); }
      };
      test.active.session.requestAnimationFrame(tick);
    });
    return c.pending;
  }, { operation, args, frames });
  const ring = () => page.evaluate(() => (globalThis as any).__stereofoldDiagnostics.entries());
  const mark = async () => (await ring()).at(-1)?.seq ?? -1;
  const events = async (since: number) => (await ring()).filter((entry: any) => entry.seq > since);
  const state = () => readSaved().then(saved => ({ revision: saved.inspectionRevision, placement: saved.scene.inspection.placement }));
  const savedChange = async (before: any, predicate = (s: any) => !sameControllerPlacement(s.placement, before.placement)) => {
    const deadline = Date.now() + 30_000;
    do { const current = await state(); if (current.revision > before.revision && predicate(current)) return current; await page.waitForTimeout(100); } while (Date.now() < deadline);
    throw Error(`Natural input release was not saved: ${JSON.stringify({ before, after: await state() })}`);
  };
  const create = (eye: V3, direction: V3, grip: V3) => page.evaluate(({ eye, direction, grip }) =>
    (globalThis as any).__naturalAcceptance.create(eye, direction, grip), { eye, direction, grip });
  const menuRow = (kind = 'collapse') => page.evaluate(kind => {
    const rows = (globalThis as any).__stereofoldDiagnostics.entries().filter((e: any) => e.kind === 'toolbar' && e.detail.phase === 'rows');
    const latest = rows.at(-1)?.detail;
    if (!latest) return null;
    const chunks = rows.filter((e: any) => e.detail.draw === latest.draw);
    if (chunks.reduce((n: number, e: any) => n + e.detail.x.length, 0) !== latest.total) return null;
    for (const { detail: d } of chunks) {
      const i = d.actions.findIndex((a: string) => JSON.parse(a)?.kind === kind);
      if (i >= 0) return { draw: latest.draw, label: d.labels[i], action: d.actions[i], targetable: d.targetable[i], point: [d.x[i], d.y[i], d.z[i]] };
    }
    return null;
  }, kind);
  const nextRow = async (draw: number) => {
    const deadline = Date.now() + 30_000;
    do { const row = await menuRow(); if (row && row.draw > draw) return row; await page.waitForTimeout(100); } while (Date.now() < deadline);
    throw Error('Natural menu input did not publish fresh rendered rows');
  };
  try {
    const sample = await step('wait'); const eye = sample.eye as V3;
    assert.ok(eye?.every(Number.isFinite), 'Measured XR eye origin is required');
    const grip: V3 = [eye[0] + .18, eye[1] - .3, eye[2] - .4];
    let row = await menuRow(); assert.ok(row, 'Current rendered menu row is required');
    const baseline = await state(); evidence.baseline = baseline;
    for (let tap = 0; tap < 2; tap++) {
      const aim = row.point.map((v: number, i: number) => v - eye[i]) as V3;
      const id = await create(eye, aim, grip), since = await mark();
      const result = await step('tap', { id, since }, 3);
      // The current gesture tracker uses release + motion, not a hold deadline.
      // Record real frame duration without imposing an invented 220 ms limit.
      assert.deepEqual(result.tap.beforeRelease, [], 'Menu pinch must wait for release');
      const after = await nextRow(row.draw), observed = await events(since);
      const actions = observed.filter((e: any) => e.kind === 'toolbar-action');
      assert.equal(actions.length, 1, 'A fresh unhanded pinch must fire exactly one menu action');
      assert.equal(actions[0].detail.kind, 'collapse');
      assert.equal(JSON.parse(after.action).value, !JSON.parse(row.action).value);
      assert.ok(sameControllerPlacement((await state()).placement, baseline.placement), 'Menu pinch changed molecule');
      evidence.cases.push({ kind: 'menu-tap', id, before: row, after, actions, heldMs: result.tap.heldMs }); row = after;
    }
    const menuAim = row.point.map((v: number, i: number) => v - eye[i]) as V3;
    const menuId = await create(eye, menuAim, grip), menuSince = await mark();
    await step('start', { id: menuId });
    await step('move', { moves: [{ id: menuId, grip: [grip[0] - .05, grip[1], grip[2]], rayOrigin: [eye[0] - .05, eye[1], eye[2]] }] });
    await step('move', { moves: [{ id: menuId, grip: [grip[0] - .12, grip[1], grip[2]], rayOrigin: [eye[0] - .12, eye[1], eye[2]] }] });
    await step('end', { id: menuId });
    const moved = await nextRow(row.draw), travel = Math.hypot(...moved.point.map((v: number, i: number) => v - row!.point[i]));
    assert.ok(travel > .025 && travel < .3, `Physical menu pinch travel was ${travel} m`);
    assert.equal(moved.action, row.action, 'Menu drag activated its button');
    assert.ok(!(await events(menuSince)).some((e: any) => e.kind === 'toolbar-action' || (e.kind === 'xr-grab' && e.detail.event === 'start')));
    assert.ok(sameControllerPlacement((await state()).placement, baseline.placement), 'Menu drag changed molecule');
    evidence.cases.push({ kind: 'menu-drag-ray-follows-hand', id: menuId, travel, before: row, after: moved });

    // Eye aim stays fixed away from the menu throughout physical hand travel.
    const aim: V3 = [0, .65, -1];
    const id = await create(eye, aim, grip), before = await state(), since = await mark();
    await step('start', { id });
    await step('move', { moves: [{ id, grip: [grip[0], grip[1], grip[2] - .05] }] });
    await step('move', { moves: [{ id, grip: [grip[0] + .08, grip[1] + .04, grip[2] - .18] }] });
    await step('end', { id });
    const single = await savedChange(before);
    assert.ok(Math.hypot(...single.placement.translation.map((v: number, i: number) => v - before.placement.translation[i])) > .02, 'Physical pinch must translate molecule');
    assert.ok(!(await events(since)).some((e: any) => e.kind === 'natural-input' && e.detail.event === 'pick'), 'Dragged pinch also picked');
    evidence.cases.push({ kind: 'single-pinch-xyz-saved', id, before, after: single });

    for (const enlarge of [true, false]) {
      const before = await state(), half = enlarge ? .2 : .4;
      const a: V3 = [eye[0] - half, grip[1], grip[2]], b: V3 = [eye[0] + half, grip[1], grip[2]];
      const first = await create(eye, aim, a), second = await create(eye, aim, b), since = await mark();
      // Both report none; insert in opposite order on the second operation.
      for (const id of enlarge ? [first, second] : [second, first]) await step('start', { id });
      await step('move', { moves: [{ id: first, grip: [a[0], a[1], a[2] - .05] }, { id: second, grip: [b[0], b[1], b[2] - .05] }] });
      const change = enlarge ? .14 : -.14;
      await step('move', { moves: [{ id: first, grip: [a[0] - change, a[1], a[2] - .05] }, { id: second, grip: [b[0] + change, b[1], b[2] - .05] }] });
      for (const id of [second, first]) await step('end', { id });
      const after = await savedChange(before, s => enlarge ? s.placement.scale > before.placement.scale * 1.1 : s.placement.scale < before.placement.scale * .9);
      const promoted = (await events(since)).filter((e: any) => e.kind === 'natural-input' && e.detail.event === 'grab');
      assert.deepEqual([...new Set(promoted.map((e: any) => e.detail.hand))].sort(), ['left', 'right'], 'Source identities must claim distinct slots');
      evidence.cases.push({ kind: enlarge ? 'two-pinch-enlarge' : 'two-pinch-shrink', sources: [first, second], before, after });
    }
    const stable = await state(), cancellationSince = await mark();
    for (const operation of ['cancel', 'vanish']) {
      const id = await create(eye, aim, grip); await step('start', { id }, 1); await step(operation, { id }, 1);
    }
    await step('wait');
    assert.ok(sameControllerPlacement((await state()).placement, stable.placement), 'Cancelled pending pinches changed molecule');
    assert.ok(!(await events(cancellationSince)).some((e: any) => e.kind === 'natural-input' && e.detail.event === 'pick'), 'Cancelled pending pinch picked');
    const last = await create(eye, aim, grip); await step('start', { id: last });
    await step('move', { moves: [{ id: last, grip: [grip[0] + .05, grip[1], grip[2]] }] });
    await step('move', { moves: [{ id: last, grip: [grip[0] + .14, grip[1], grip[2]] }] });
    await step('vanish', { id: last });
    const afterCancel = await savedChange(stable);
    evidence.cases.push({ kind: 'cancel-and-remove-then-new-source-drag', before: stable, after: afterCancel });

    // The input cases can age the old row records out of the bounded ring.
    // Summon fresh controls with the wearer's empty-space pinch gesture.
    const summonSince = await mark(), summon = await create(eye, [0, 1, -.5], grip);
    await step('tap', { id: summon, since: summonSince }, 3);
    await page.waitForFunction(since => (globalThis as any).__stereofoldDiagnostics.entries().some((e: any) =>
      e.seq > since && e.kind === 'toolbar' && e.detail.phase === 'rows'), summonSince, { timeout: 30_000 });

    // Real menu clicks must reach the shared host history, not just change a
    // local display. Reuse the current synthetic pinch path and read only the
    // server's saved scene and rendered row diagnostics for assertions.
    const waitRow = async (kind: string, predicate = (r: any) => r.targetable) => {
      const deadline = Date.now() + 30_000;
      do { const found = await menuRow(kind); if (found && predicate(found)) return found; await page.waitForTimeout(100); } while (Date.now() < deadline);
      throw Error(`Scene menu row not ready: ${kind}`);
    };
    const clickRow = async (kind: string) => {
      const target = await waitRow(kind), since = await mark();
      const direction = target.point.map((v: number, i: number) => v - eye[i]) as V3;
      const id = await create(eye, direction, grip);
      const tapped = await step('tap', { id, since }, 3);
      assert.deepEqual(tapped.tap.beforeRelease, [], 'Scene action must wait for pinch release');
      return { target, since, id };
    };
    const waitScene = async (revision: number, representation: string) => {
      const deadline = Date.now() + 40_000;
      do {
        const saved = await readSaved();
        if (saved.inspectionRevision > revision && saved.scene.inspection.appearance.representation === representation) return saved;
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
      throw Error(`Scene did not save ${representation} after revision ${revision}`);
    };
    const styleSequence = ['spacefill', 'molecular-surface', 'ball-and-stick', 'cartoon'];
    let savedScene = await readSaved();
    assert.equal(savedScene.scene.inspection.appearance.representation, 'cartoon');
    const heldPlacement = savedScene.scene.inspection.placement;
    for (const representation of styleSequence) {
      const clicked = await clickRow('appearance-cycle');
      savedScene = await waitScene(savedScene.inspectionRevision, representation);
      assert.ok(sameControllerPlacement(savedScene.scene.inspection.placement, heldPlacement), 'Changing style moved the molecule');
      const rendered = await waitRow('appearance-cycle', r => r.label === ({ spacefill: 'Spacefill', 'molecular-surface': 'Surface', 'ball-and-stick': 'Atoms', cartoon: 'Ribbons' } as any)[representation]);
      evidence.cases.push({ kind: 'scene-style-cycle-saved', representation, revision: savedScene.inspectionRevision, rendered, input: clicked.id });
    }
    const compact = await waitRow('collapse');
    if (JSON.parse(compact.action).value === false) await clickRow('collapse');
    for (const [kind, representation] of [['undo', 'ball-and-stick'], ['redo', 'cartoon']] as const) {
      await clickRow(kind);
      savedScene = await waitScene(savedScene.inspectionRevision, representation);
      assert.ok(sameControllerPlacement(savedScene.scene.inspection.placement, heldPlacement), `${kind} changed unrelated placement`);
      evidence.cases.push({ kind: `shared-menu-${kind}-saved`, representation, revision: savedScene.inspectionRevision });
    }
    await clickRow('undo');
    savedScene = await waitScene(savedScene.inspectionRevision, 'ball-and-stick');
    await waitRow('redo');
    await clickRow('appearance-cycle');
    savedScene = await waitScene(savedScene.inspectionRevision, 'cartoon');
    const disabledRedo = await waitRow('redo', r => !r.targetable);
    assert.equal(savedScene.history.redoCount, 0);
    evidence.cases.push({ kind: 'fresh-menu-edit-clears-shared-redo', revision: savedScene.inspectionRevision, disabledRedo });
    evidence.protocol = await page.evaluate(() => {
      const c = (globalThis as any).__naturalAcceptance;
      return { events: c.eventLog, liveSources: c.sources.length, restrictedViewerPoseCalls: c.restrictedViewerPoseCalls };
    });
    assert.equal(evidence.protocol.liveSources, 0);
    assert.equal(evidence.protocol.restrictedViewerPoseCalls, 0, 'Production queried getViewerPose on an input-event frame');
    evidence.callbackFailures = (await ring()).filter((entry: any) => entry.kind === 'xr-frame-error'
      || (['natural-input', 'xr-grab'].includes(entry.kind) && (entry.detail.event === 'failed' || entry.detail.error)));
    assert.deepEqual(evidence.callbackFailures, [], 'Production XR callbacks reported an input or frame failure');
  } finally {
    await page.evaluate(() => (globalThis as any).__naturalAcceptance.restore());
  }
}
