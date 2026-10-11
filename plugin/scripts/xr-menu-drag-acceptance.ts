import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { xrToolbarControllerPose } from './xr-toolbar-controller-pose.js';

/** Real squeeze edges and measured XR poses; no menu action/placement setter. */
export async function runGripMenuDragAcceptance(page: Page, frameWait: (ms: number) => Promise<unknown>,
  readScene: () => Promise<any>, hand: string, evidence: any) {
  await page.evaluate(() => {
    const hook = (globalThis as any).__stereofoldDiagnostics, control = (globalThis as any).__controllerAcceptance;
    const original = hook.record;
    control.menuPublishedRows = [];
    control.menuObservedEvidence = [];
    // The bounded telemetry ring preferentially evicts sampled rows after
    // delivery. Observe actual publications so a correct no-op needs neither
    // a forced redraw nor a cached seat from before an unseen production draw.
    function observe(kind: string, detail: any) {
      const entry = original.call(hook, kind, detail);
      if (entry && ['toolbar', 'toolbar-action', 'xr-grab', 'xr-tracking', 'xr-pointer'].includes(entry.kind)) {
        control.menuObservedEvidence.push(entry);
        if (control.menuObservedEvidence.length > 256) control.menuObservedEvidence.shift();
        if (entry.kind === 'toolbar' && entry.detail.phase === 'rows') {
          if (control.menuPublishedRows[0]?.detail.draw !== entry.detail.draw) control.menuPublishedRows = [];
          control.menuPublishedRows.push(entry);
        }
      }
      return entry;
    }
    hook.record = observe;
    control.restoreMenuObservation = () => { if (hook.record === observe) hook.record = original; };
  });
  const ring = () => page.evaluate(() => {
    const entries = [...(globalThis as any).__stereofoldDiagnostics.entries(), ...(globalThis as any).__controllerAcceptance.menuObservedEvidence];
    return [...new Map(entries.map((entry: any) => [entry.seq, entry])).values()].sort((a: any, b: any) => a.seq - b.seq);
  });
  const rows = (): Promise<any> => page.evaluate(() => {
    const published = [...(globalThis as any).__stereofoldDiagnostics.entries(), ...(globalThis as any).__controllerAcceptance.menuPublishedRows]
      .filter((entry: any) => entry.kind === 'toolbar' && entry.detail.phase === 'rows');
    const all = [...new Map(published.map((entry: any) => [entry.seq, entry])).values()].sort((a: any, b: any) => a.seq - b.seq);
    const last = all.at(-1)?.detail;
    if (!last) return null;
    const chunks = all.filter((entry: any) => entry.detail.draw === last.draw).sort((a: any, b: any) => a.detail.from - b.detail.from);
    const seats = chunks.flatMap((entry: any) => entry.detail.x.map((x: number, i: number) => ({
      x, y: entry.detail.y[i], z: entry.detail.z[i], label: entry.detail.labels[i], action: entry.detail.actions[i] })));
    if (seats.length !== last.total) return null;
    return { draw: last.draw, anchor: last.anchor, fontMeters: last.fontMeters, hidden: last.hidden,
      seats, target: seats.find((seat: any) => JSON.parse(seat.action)?.kind === 'collapse') };
  });
  const nextRows = async (draw: number) => {
    const deadline = Date.now() + 30_000;
    do { const value = await rows(); if (value?.draw > draw) return value; await page.waitForTimeout(100); } while (Date.now() < deadline);
    throw Error(`${hand} grip menu did not publish a complete new draw`);
  };
  const squeeze = (value: number) => page.evaluate(({ hand, value }) => {
    (globalThis as any).__controllerAcceptance.input = { hand, button: 'squeeze', value };
    (globalThis as any).__companionXrTest.device.controllers[hand].updateButtonValue('squeeze', value);
  }, { hand, value });
  const nativeEvents = () => page.evaluate(() => (globalThis as any).__companionXrTest.active.inputEvents);
  const nativeGrip = () => page.evaluate(hand => (globalThis as any).__controllerAcceptance.nativeGrips[hand], hand);
  const move = (aim: ReturnType<typeof xrToolbarControllerPose> & { translationAxis: number[] }, distance: number) => page.evaluate(({ hand, aim, distance }) => {
    const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
    controller.position.set(aim.position.x + aim.translationAxis[0] * distance, aim.position.y + aim.translationAxis[1] * distance,
      aim.position.z + aim.translationAxis[2] * distance);
    controller.quaternion.set(aim.quaternion.x, aim.quaternion.y, aim.quaternion.z, aim.quaternion.w);
  }, { hand, aim, distance });
  const aimAt = async (current: any) => {
    await frameWait(50);
    const measured = await page.evaluate(() => (globalThis as any).__controllerAcceptance.viewerFrame);
    const { x, y, z } = current.target;
    const aim = xrToolbarControllerPose({ x, y, z }, measured.viewerFromRoom, measured.viewerPose, .7);
    // Aim at the published button, but translate along the head-to-menu
    // radial. The row's screen-facing ray can differ substantially from the
    // direction the wearer pushes the outboard panel farther away.
    const [ax, ay, az] = current.anchor;
    const mapped = xrToolbarControllerPose({ x: ax, y: ay, z: az }, measured.viewerFromRoom, measured.viewerPose, .7);
    const head = measured.viewerPose.position;
    const radial = [mapped.deviceTarget.x - head.x, mapped.deviceTarget.y - head.y, mapped.deviceTarget.z - head.z];
    const length = Math.hypot(...radial);
    assert.ok(length > 0, `${hand} menu has no measured radial travel axis`);
    const positioned = { ...aim, translationAxis: radial.map(value => value / length) };
    await move(positioned, 0); await frameWait(100);
    return positioned;
  };
  const unchanged = async (baseline: any, since: number, label: string) => {
    // Menu movement cannot alter even the exact serialized placement floats.
    assert.deepEqual((await readScene()).placement, baseline.placement, `${hand} ${label} changed saved molecule placement`);
    const events = (await ring()).filter((entry: any) => entry.seq > since);
    assert.ok(!events.some((entry: any) => entry.kind === 'xr-grab' && entry.detail.event === 'start'), `${hand} ${label} grabbed the molecule`);
    assert.ok(!events.some((entry: any) => entry.kind === 'toolbar-action'), `${hand} ${label} fired a button action`);
    assert.ok(!events.some((entry: any) => entry.kind === 'toolbar' && entry.detail.phase === 'hidden' && entry.detail.hidden), `${hand} ${label} hid the menu`);
  };
  const original = await page.evaluate(hand => {
    const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
    return { position: { x: controller.position.x, y: controller.position.y, z: controller.position.z },
      quaternion: { x: controller.quaternion.x, y: controller.quaternion.y, z: controller.quaternion.z, w: controller.quaternion.w } };
  }, hand);
  Object.assign(evidence, { hand, scope: 'Chrome/IWER native squeeze events and production rendered geometry; physical Quest not tested',
    geometryObservation: 'Actual diagnostics.record publications retained read-only through bounded telemetry eviction; newest complete draw only',
    movement: [], uncertainGrip: [] });
  try {
    // Always summon through a physical face-button edge. Old bounded-ring row
    // diagnostics can be evicted after earlier long controller journeys.
    await page.evaluate(hand => {
      const test = (globalThis as any).__companionXrTest;
      const controller = test.device.controllers[hand], face = hand === 'left' ? 'y-button' : 'b-button';
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { controller.updateButtonValue(face, 0); reject(Error('No grip-menu summon frame')); }, 20_000);
        controller.updateButtonValue(face, 1);
        test.active.session.requestAnimationFrame(() => { controller.updateButtonValue(face, 0); clearTimeout(timer); resolve(); });
      });
    }, hand);
    await frameWait(250);
    let current = await rows();
    assert.ok(current?.target && current.anchor?.length === 3 && Number.isFinite(current.fontMeters), `${hand} no measured grip-menu geometry`);
    assert.equal(current.hidden, false, `${hand} grip test starts with hidden menu`);
    const baseline = await readScene();
    evidence.baseline = baseline; evidence.initial = current;
    evidence.pointer = (await ring()).filter((entry: any) => entry.kind === 'xr-pointer').at(-1)?.detail
      ?? { scope: 'Installation diagnostic aged out; no cursor pixel assertion' };
    // Twelve centimetres measured grip travel should move the actual menu
    // anchor thirty centimetres. A pull then push also restores the seat.
    for (const distance of [-.12, .12]) {
      const before: any = current, aim = await aimAt(before), since = (await ring()).at(-1)?.seq ?? -1;
      const frameBefore = await page.evaluate(() => (globalThis as any).__companionXrTest.active.rafCount);
      const drawBefore = await page.evaluate(() => (globalThis as any).__companionXrTest.drawSerial());
      await squeeze(1); await frameWait(90);
      const gripBefore = await nativeGrip();
      assert.ok((await nativeEvents()).some((event: any) => event.frame >= frameBefore && event.handedness === hand && event.type === 'squeezestart'), `${hand} no native squeezestart`);
      await move(aim, distance); await frameWait(120);
      const gripAfter = await nativeGrip();
      assert.ok(gripBefore?.length === 3 && gripAfter?.length === 3, `${hand} missing measured native grip`);
      const gripDelta = gripAfter.map((value: number, axis: number) => value - gripBefore[axis]);
      const gripTravel = Math.hypot(...gripDelta);
      assert.ok(Math.abs(gripTravel - .12) < 1e-5, `${hand} measured grip travel was ${gripTravel} m`);
      await unchanged(baseline, since, 'held grip-menu drag');
      await squeeze(0); await frameWait(250);
      current = await nextRows(before.draw);
      assert.ok((await nativeEvents()).some((event: any) => event.frame >= frameBefore && event.handedness === hand && event.type === 'squeezeend'), `${hand} no native squeezeend`);
      const menuDelta = current.anchor.map((value: number, axis: number) => value - before.anchor[axis]);
      const menuTravel = Math.hypot(...menuDelta);
      assert.ok(Math.abs(menuTravel - .3) < .003, `${hand} 12 cm grip produced ${menuTravel} m menu travel`);
      assert.ok(menuDelta.every((value: number, axis: number) => Math.abs(value - gripDelta[axis] * 2.5) < .003), `${hand} menu moved away from measured grip direction`);
      assert.equal(current.fontMeters, before.fontMeters, `${hand} grip drag resized physical text`);
      assert.equal(current.hidden, false, `${hand} grip drag committed hidden menu`);
      assert.deepEqual(current.seats.map((seat: any) => seat.action), before.seats.map((seat: any) => seat.action), `${hand} grip drag changed menu actions`);
      const measured = await page.evaluate(() => (globalThis as any).__controllerAcceptance.viewerFrame);
      const depth = (anchor: number[]) => -anchor.reduce((sum: number, v: number, i: number) => sum + measured.viewerFromRoom[i * 4 + 2] * v, measured.viewerFromRoom[14]);
      const beforeDepth = depth(before.anchor), afterDepth = depth(current.anchor);
      const beforeAngle = 2 * Math.atan(before.fontMeters / (2 * beforeDepth)), afterAngle = 2 * Math.atan(current.fontMeters / (2 * afterDepth));
      assert.ok(beforeDepth > 0 && afterDepth > 0 && (distance < 0 ? afterAngle > beforeAngle : afterAngle < beforeAngle), `${hand} pull/push did not grow/shrink angular text size`);
      const drawAfter = await page.evaluate(() => (globalThis as any).__companionXrTest.drawSerial());
      assert.ok(drawAfter > drawBefore, `${hand} grip menu never reached production GL draws`);
      await unchanged(baseline, since, 'released grip-menu drag');
      evidence.movement.push({ distance, before, after: current, gripBefore, gripAfter, gripTravel, menuDelta, menuTravel,
        fontMeters: current.fontMeters, beforeDepth, afterDepth, angularFontRadians: { before: beforeAngle, after: afterAngle },
        drawCalls: drawAfter - drawBefore, nativeStartAndRelease: true, angularScope: 'Geometry-derived angular size; no isolated glyph-pixel measurement' });
    }
    for (const mode of ['emulated', 'null']) {
      const before = current, aim = await aimAt(before), since = (await ring()).at(-1)?.seq ?? -1;
      await page.evaluate(({ hand, mode }) => { (globalThis as any).__controllerAcceptance.gripModes[hand] = mode; }, { hand, mode });
      await frameWait(60); await squeeze(1); await frameWait(90);
      await move(aim, -.12); await frameWait(120); await squeeze(0); await frameWait(250);
      // Uncertain grip positions are deliberately a no-op. A production
      // redraw is unnecessary when the committed geometry has not changed.
      current = await rows();
      assert.ok(current, `${hand} ${mode} grip lost committed menu geometry`);
      assert.deepEqual(current.anchor, before.anchor, `${hand} ${mode} grip teleported the menu`);
      assert.equal(current.fontMeters, before.fontMeters); assert.equal(current.hidden, false);
      await unchanged(baseline, since, `${mode} grip-menu drag`);
      const tracking = (await ring()).filter((entry: any) => entry.kind === 'xr-tracking' && entry.detail.hand === hand).at(-1)?.detail;
      assert.equal(tracking?.gripTracking, mode === 'null' ? 'unavailable' : 'emulated-position', `${hand} grip-only fault never reached production reader`);
      assert.equal(tracking?.tracking, 'tracked-position', `${hand} grip-only fault also removed the aiming ray`);
      evidence.uncertainGrip.push({ mode, before, after: current, tracking, menuUnchanged: true, moleculeUnchanged: true });
      await page.evaluate(hand => { delete (globalThis as any).__controllerAcceptance.gripModes[hand]; }, hand); await frameWait(100);
    }
    // Native input-source removal cancels the held grip. It must discard the
    // temporary offset, rather than commit it when the controller reconnects.
    const beforeCancel = current, aim = await aimAt(current), sinceCancel = (await ring()).at(-1)?.seq ?? -1;
    const sourceFrame = await page.evaluate(() => (globalThis as any).__companionXrTest.active.rafCount);
    await squeeze(1); await frameWait(90); await move(aim, -.04); await frameWait(100);
    await page.evaluate(hand => { (globalThis as any).__companionXrTest.device.controllers[hand].connected = false; }, hand);
    await frameWait(100); await squeeze(0);
    await page.evaluate(hand => { (globalThis as any).__companionXrTest.device.controllers[hand].connected = true; }, hand);
    await frameWait(150);
    const cancelled = await rows();
    assert.deepEqual(cancelled?.anchor, beforeCancel.anchor, `${hand} cancelled menu grip committed an offset`);
    assert.equal(cancelled?.hidden, false, `${hand} cancellation hid the menu`);
    const sourceChanges = await page.evaluate(() => (globalThis as any).__controllerAcceptance.sourceChanges);
    assert.ok(sourceChanges.some((change: any) => change.frame >= sourceFrame && change.removed.includes(hand)), `${hand} no native source removal cancelled the grip`);
    assert.ok(sourceChanges.some((change: any) => change.frame >= sourceFrame && change.added.includes(hand)), `${hand} no native source return reached the session`);
    await unchanged(baseline, sinceCancel, 'native source-removal cancellation');
    // A fresh native grip can reclaim and move the menu after cancellation.
    const reaim = await aimAt(cancelled);
    await squeeze(1); await frameWait(90); await move(reaim, .02); await frameWait(90); await squeeze(0); await frameWait(250);
    current = await nextRows(cancelled.draw);
    const recoveryTravel = Math.hypot(...current.anchor.map((value: number, axis: number) => value - cancelled.anchor[axis]));
    assert.ok(Math.abs(recoveryTravel - .05) < .003, `${hand} cancelled menu grip left hand ownership stuck (${recoveryTravel} m)`);
    await unchanged(baseline, sinceCancel, 'post-cancel grip recovery');
    evidence.cancellation = { route: 'IWER controller disconnected/reconnected; native inputsourceschange', before: beforeCancel,
      cancelled, recovered: current, recoveryTravel, sourceChanges: sourceChanges.filter((change: any) => change.frame >= sourceFrame), moleculeUnchanged: true };
  } finally {
    await squeeze(0);
    await page.evaluate(({ hand, original }) => {
      const control = (globalThis as any).__controllerAcceptance;
      control.restoreMenuObservation();
      delete control.gripModes[hand];
      const controller = (globalThis as any).__companionXrTest.device.controllers[hand], p = original.position, q = original.quaternion;
      controller.connected = true; controller.position.set(p.x, p.y, p.z); controller.quaternion.set(q.x, q.y, q.z, q.w);
    }, { hand, original });
    await frameWait(100);
  }
}

/** Native IWER trigger events against currently published production button seats. */
export async function runGenericMenuDragAcceptance(page: Page, frameWait: (ms: number) => Promise<unknown>,
  readScene: () => Promise<any>, samePlacement: (a: any, b: any) => boolean,
  hand: string, mode: string, evidence: any) {
  const ring = () => page.evaluate(() => (globalThis as any).__stereofoldDiagnostics.entries());
  const row = () => page.evaluate(() => {
    const rows = (globalThis as any).__stereofoldDiagnostics.entries()
      .filter((entry: any) => entry.kind === 'toolbar' && entry.detail.phase === 'rows');
    const latest = rows.at(-1)?.detail;
    if (!latest) return null;
    const chunks = rows.filter((entry: any) => entry.detail.draw === latest.draw);
    if (chunks.reduce((count: number, entry: any) => count + entry.detail.x.length, 0) !== latest.total) return null;
    for (const chunk of chunks) {
      const i = chunk.detail.actions.findIndex((value: string) => JSON.parse(value)?.kind === 'collapse');
      if (i >= 0) return { draw: latest.draw, label: chunk.detail.labels[i], action: chunk.detail.actions[i],
        x: chunk.detail.x[i], y: chunk.detail.y[i], z: chunk.detail.z[i] };
    }
    return null;
  });
  const nextRow = async (afterDraw: number) => {
    const deadline = Date.now() + 30_000;
    do {
      const current = await row();
      if (current && current.draw > afterDraw) return current;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw Error(`${hand}/${mode} generic menu button did not publish a complete new draw`);
  };
  const trigger = (value: number) => page.evaluate(({ hand, value }) => {
    (globalThis as any).__controllerAcceptance.input = { hand, button: 'trigger', value };
    (globalThis as any).__companionXrTest.device.controllers[hand].updateButtonValue('trigger', value);
  }, { hand, value });
  const placeController = (aim: ReturnType<typeof xrToolbarControllerPose>, dx = 0, yaw = 0) => page.evaluate(({ hand, aim, dx, yaw }) => {
    const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
    const q = aim.quaternion, c = Math.cos(yaw / 2), s = Math.sin(yaw / 2);
    controller.position.set(aim.position.x + dx, aim.position.y, aim.position.z);
    controller.quaternion.set(c * q.x + s * q.z, c * q.y + s * q.w, c * q.z - s * q.x, c * q.w - s * q.y);
  }, { hand, aim, dx, yaw });
  const aimAt = async (current: { x: number; y: number; z: number }) => {
    await frameWait(50);
    const measured = await page.evaluate(() => (globalThis as any).__controllerAcceptance.viewerFrame);
    // Diagnostics also carry string labels/actions. The pose helper validates
    // every target value, so pass only its room-space coordinates.
    const aim = xrToolbarControllerPose({ x: current.x, y: current.y, z: current.z },
      measured.viewerFromRoom, measured.viewerPose, .7);
    await placeController(aim); await frameWait(100);
    return aim;
  };
  const original = await page.evaluate(hand => {
    const controller = (globalThis as any).__companionXrTest.device.controllers[hand];
    return { position: { x: controller.position.x, y: controller.position.y, z: controller.position.z },
      quaternion: { x: controller.quaternion.x, y: controller.quaternion.y, z: controller.quaternion.z, w: controller.quaternion.w } };
  }, hand);
  try {
    let initial = await row();
    if (!initial) {
      // A long manipulation can evict prior row diagnostics. The actual face
      // button requests a fresh menu draw; never aim from an old cached seat.
      await page.evaluate(hand => {
        const test = (globalThis as any).__companionXrTest;
        const controller = test.device.controllers[hand], name = hand === 'left' ? 'y-button' : 'b-button';
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { controller.updateButtonValue(name, 0); reject(Error('No generic-menu summon frame')); }, 20_000);
          controller.updateButtonValue(name, 1);
          test.active.session.requestAnimationFrame(() => { controller.updateButtonValue(name, 0); clearTimeout(timer); resolve(); });
        });
      }, hand);
      initial = await nextRow(-1);
    }
    assert.ok(initial);
    const baseline = await readScene();
    Object.assign(evidence, { hand, mode, baseline, initial, route: 'IWER native trigger on a generic collapse/Menu button' });
    const aim = await aimAt(initial);
    const since = (await ring()).at(-1)?.seq ?? -1;
    await trigger(1); await frameWait(260);
    assert.ok((await ring()).some((entry: any) => entry.seq > since && entry.kind === 'toolbar'
      && entry.detail.phase === 'selectstart' && entry.detail.hit === initial.label), `${hand}/${mode} generic button aim missed`);
    if (mode === 'tracked') await placeController(aim, -.06);
    else await placeController(aim, 0, .12);
    await frameWait(120);
    assert.ok(!(await ring()).some((entry: any) => entry.seq > since && entry.kind === 'toolbar-action'),
      `${hand}/${mode} generic button action fired while dragging`);
    await trigger(0); await frameWait(250);
    const moved = await nextRow(initial.draw);
    const travel = Math.hypot(moved.x - initial.x, moved.y - initial.y, moved.z - initial.z);
    assert.ok(travel > .02 && travel < .25, `${hand}/${mode} generic button drag moved its rendered seat ${travel} m`);
    assert.equal(moved.action, initial.action, `${hand}/${mode} dragging changed the button action`);
    const dragEvents = (await ring()).filter((entry: any) => entry.seq > since);
    assert.ok(!dragEvents.some((entry: any) => entry.kind === 'toolbar-action'), `${hand}/${mode} drag released as a button click`);
    assert.ok(!dragEvents.some((entry: any) => entry.kind === 'xr-grab' && entry.detail.event === 'start'), `${hand}/${mode} generic button drag grabbed the molecule`);
    assert.ok(samePlacement((await readScene()).placement, baseline.placement), `${hand}/${mode} generic menu drag changed the molecule`);
    evidence.drag = { moved, travel, actionSuppressed: true, moleculeUnchanged: true };

    // Two genuine quick clicks change the menu form and then restore it. Each
    // click re-aims from the latest rendered row, since the first changes layout.
    evidence.clicks = [];
    let current = moved;
    for (let click = 0; click < 2; click++) {
      await aimAt(current);
      const before = (await ring()).at(-1)?.seq ?? -1;
      const tap = await page.evaluate(({ hand, since }) => {
        const test = (globalThis as any).__companionXrTest, control = (globalThis as any).__controllerAcceptance;
        const controller = test.device.controllers[hand], started = performance.now();
        control.input = { hand, button: 'trigger', value: 1 };
        control.genericMenuTap = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => { controller.updateButtonValue('trigger', 0); reject(Error('No generic-menu click frame')); }, 20_000);
          controller.updateButtonValue('trigger', 1);
          test.active.session.requestAnimationFrame(() => {
            const beforeRelease = (globalThis as any).__stereofoldDiagnostics.entries()
              .filter((entry: any) => entry.seq > since && entry.kind === 'toolbar-action');
            const heldMs = performance.now() - started;
            controller.updateButtonValue('trigger', 0); control.input = { hand, button: 'trigger', value: 0 };
            clearTimeout(timer); resolve({ heldMs, beforeRelease });
          });
        });
        return control.genericMenuTap;
      }, { hand, since: before });
      assert.ok(tap.heldMs < 220, `${hand}/${mode} simulator could not supply a quick click: ${tap.heldMs} ms`);
      assert.deepEqual(tap.beforeRelease, [], `${hand}/${mode} button fired before trigger release`);
      const next = await nextRow(current.draw);
      const actions = (await ring()).filter((entry: any) => entry.seq > before && entry.kind === 'toolbar-action');
      assert.equal(actions.length, 1, `${hand}/${mode} quick click did not produce exactly one button action`);
      assert.equal(actions[0].detail.kind, 'collapse');
      assert.equal(JSON.parse(next.action).value, !JSON.parse(current.action).value, `${hand}/${mode} quick click did not change rendered menu form`);
      assert.ok(samePlacement((await readScene()).placement, baseline.placement), `${hand}/${mode} generic menu click changed the molecule`);
      evidence.clicks.push({ before: current, after: next, heldMs: tap.heldMs, action: actions[0] });
      current = next;
    }
    assert.equal(current.action, initial.action, `${hand}/${mode} menu form did not return after two clicks`);
  } finally {
    await trigger(0);
    await page.evaluate(({ hand, original }) => {
      const controller = (globalThis as any).__companionXrTest.device.controllers[hand], p = original.position, q = original.quaternion;
      controller.position.set(p.x, p.y, p.z); controller.quaternion.set(q.x, q.y, q.z, q.w);
    }, { hand, original });
    await frameWait(100);
  }
}
