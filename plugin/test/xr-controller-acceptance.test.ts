import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { beginControllerFrameWait, waitControllerFrames, createControllerMenuObservation, controllerGripFrame, assertControllerGripResponse, controllerTriggerAdmission, prepareControllerTrigger } from '../scripts/xr-controller-acceptance.js';

import { instrumentMolecularGeometry } from '../scripts/molecular-geometry-probe.js';

type Observation = {
  admission?: 'ray-grab' | 'depth-yaw-modifier';
  heldFrameGaps: { gapMs: number; at: number }[];
};

function preparation(observations: Observation[]) {
  const calls: string[] = [], records: Record<string, unknown>[] = [];
  let index = 0;
  return {
    calls, records,
    run: () => prepareControllerTrigger({
      release: async () => { calls.push('release'); },
      settleNeutral: async () => { calls.push('neutral'); },
      prepare: async () => { calls.push('press'); },
      observe: async () => { calls.push('observe'); return observations[index++]; },
      record: record => records.push(record),
    }),
  };
}

describe('controller acceptance trigger preparation', () => {
  it.each(['ray-grab', 'depth-yaw-modifier'] as const)('requires production %s admission before returning', async admission => {
    const test = preparation([{ admission, heldFrameGaps: [] }]);
    await test.run();
    expect(test.calls).toEqual(['release', 'neutral', 'press', 'observe']);
    expect(test.records).toEqual([{ attempt: 1, admission, ready: true }]);
  });

  it('releases and settles a cancelled held press before regrabbing, recording the observed gap', async () => {
    const gap = { gapMs: 555.7, at: 1790981591789 };
    const test = preparation([{ heldFrameGaps: [gap] }, { admission: 'ray-grab', heldFrameGaps: [] }]);
    await test.run();
    expect(test.calls).toEqual(['release', 'neutral', 'press', 'observe', 'release', 'neutral', 'press', 'observe']);
    expect(test.records).toEqual([
      { attempt: 1, ready: false, reason: 'held-input-frame-gap', gaps: [gap] },
      { attempt: 2, admission: 'ray-grab', ready: true },
    ]);
  });

  it.each([{ heldFrameGaps: [] }, { heldFrameGaps: [{ gapMs: 500, at: 1 }] }])('fails without retry when admission is missing without a guard-sized gap: %j', async ({ heldFrameGaps }) => {
    const test = preparation([{ heldFrameGaps }]);
    await expect(test.run()).rejects.toThrow('no interrupted-frame retry applies');
    expect(test.calls).toEqual(['release', 'neutral', 'press', 'observe', 'release', 'neutral']);
    expect(test.records).toEqual([{ attempt: 1, ready: false, reason: 'missing-production-admission', gaps: [] }]);
  });

  it('bounds repeated observed interruptions to three presses and finishes released', async () => {
    const gap = { gapMs: 570, at: 1 };
    const test = preparation(Array.from({ length: 3 }, () => ({ heldFrameGaps: [gap] })));
    await expect(test.run()).rejects.toThrow('all three attempts');
    expect(test.calls.filter(call => call === 'press')).toHaveLength(3);
    expect(test.calls.slice(-2)).toEqual(['release', 'neutral']);
    expect(test.records.map(record => record.attempt)).toEqual([1, 2, 3]);
    expect(test.records.every(record => record.reason === 'held-input-frame-gap')).toBe(true);
  });

  it('does not repeat an admitted press merely because an earlier held frame had a gap', async () => {
    const test = preparation([{ admission: 'ray-grab', heldFrameGaps: [{ gapMs: 570, at: 1 }] }]);
    await test.run();
    expect(test.calls.filter(call => call === 'press')).toHaveLength(1);
    expect(test.records).toEqual([{ attempt: 1, admission: 'ray-grab', ready: true }]);
  });

  it('cleans up a preparation error without treating it as an interrupted-frame retry', async () => {
    const calls: string[] = [];
    await expect(prepareControllerTrigger({
      release: async () => { calls.push('release'); },
      settleNeutral: async () => { calls.push('neutral'); },
      prepare: async () => { calls.push('press'); throw Error('session ended'); },
      observe: async () => { throw Error('must not observe'); },
      record: () => { throw Error('must not record'); },
    })).rejects.toThrow('session ended');
    expect(calls).toEqual(['release', 'neutral', 'press', 'release', 'neutral']);
  });
});

describe('controller trigger admission evidence', () => {
  const modifier = { seq: 753, kind: 'xr-stick', detail: { hand: 'left', event: 'modifier', mode: 'depth-yaw' } };
  const ray = { seq: 754, kind: 'xr-grab', detail: { hand: 'left', event: 'start', kind: 'ray' } };
  const end = { seq: 755, kind: 'xr-grab', detail: { event: 'end' } };

  it('admits tracked empty-space yaw but requires a real hit for pointed pull', () => {
    expect(controllerTriggerAdmission([modifier], 'left', 'depth-yaw')).toBe('depth-yaw-modifier');
    expect(controllerTriggerAdmission([modifier], 'left', 'pointed-ray')).toBeUndefined();
  });

  it.each(['pointed-ray', 'depth-yaw'] as const)('admits an active ray grab for %s', expected => {
    expect(controllerTriggerAdmission([ray], 'left', expected)).toBe('ray-grab');
  });

  it('rejects other-hand, wrong-mode and grip admissions', () => {
    expect(controllerTriggerAdmission([modifier, ray], 'right', 'depth-yaw')).toBeUndefined();
    expect(controllerTriggerAdmission([{ ...modifier, detail: { ...modifier.detail, mode: 'scale' } }], 'left', 'depth-yaw')).toBeUndefined();
    expect(controllerTriggerAdmission([{ ...ray, detail: { ...ray.detail, kind: 'grip' } }], 'left', 'pointed-ray')).toBeUndefined();
  });

  it('rejects ended admissions and accepts a later fresh production admission', () => {
    expect(controllerTriggerAdmission([ray, end], 'left', 'pointed-ray')).toBeUndefined();
    expect(controllerTriggerAdmission([modifier, end], 'left', 'depth-yaw')).toBeUndefined();
    expect(controllerTriggerAdmission([ray, end, { ...modifier, seq: 756 }], 'left', 'depth-yaw')).toBe('depth-yaw-modifier');
  });
});


describe('independent native grip movement evidence', () => {
  const measured = () => controllerGripFrame({ sourceCenter: [2, 0, 0], cameraScale: .5,
    matrix: [0,2,0,0,-2,0,0,0,0,0,2,0,10,20,30,1],
    renderFromRoom: [1,0,0,0,0,1,0,0,0,0,1,0,3,4,5,1],
    viewerFromRoom: [1,0,0,0,0,1,0,0,0,0,1,0,-1,-2,-3,1] });

  it('derives head-target direction from native pose and committed geometry in different coordinate frames', () => {
    const frame = measured();
    expect(frame.centerRoom).toEqual([2,8,10]); expect(frame.headRoom).toEqual([1,2,3]);
    frame.depthAxis.forEach((value, i) => expect(value).toBeCloseTo([1,6,7][i] / Math.sqrt(86), 12));
    expect(frame.depthAxis.reduce((sum, value, i) => sum + value * frame.lateralA[i], 0)).toBeCloseTo(0, 12);
    expect(frame.depthAxis.reduce((sum, value, i) => sum + value * frame.lateralB[i], 0)).toBeCloseTo(0, 12);
  });

  it('requires 2.5x radial response and 1x response along both independently measured lateral axes', () => {
    const frame = measured();
    for (const sign of [-1, 1]) {
      const input = frame.depthAxis.map(value => sign * .04 * value);
      expect(assertControllerGripResponse(input, input.map(value => value * 2.5), frame.depthAxis, 'axial').outputDepth).toBeCloseTo(sign * .1, 12);
      expect(() => assertControllerGripResponse(input, input, frame.depthAxis, 'wrong gain')).toThrow('axial travel');
      for (const axis of [frame.lateralA, frame.lateralB]) {
        const lateral = axis.map(value => sign * .04 * value);
        assertControllerGripResponse(lateral, lateral, frame.depthAxis, 'lateral');
        expect(() => assertControllerGripResponse(lateral, lateral.map(value => value * 2.5), frame.depthAxis, 'wrong lateral gain')).toThrow('lateral travel');
      }
    }
  });

  it('accepts required cross-world-axis movement but rejects applying gain along a controller-forward axis', () => {
    const axis = [Math.SQRT1_2, 0, -Math.SQRT1_2], input = [.04,0,0];
    assertControllerGripResponse(input, [.07,0,-.03], axis, 'oblique');
    expect(() => assertControllerGripResponse(input, [.04,0,0], axis, 'wrong forward axis')).toThrow('axial travel');
    expect(() => assertControllerGripResponse(input, [.07,.001,-.03], axis, 'unrelated drift')).toThrow('lateral travel');
  });

  it('exposes existing scientific source bounds only in served test instrumentation', () => {
    const html = 'getEntryGeometry:()=>({objects:[primary?.obj?.data?.repr,ligand?.representation?.obj?.data?.repr].flatMap(x=>x?.renderObjects??[]),cameraScale:camera.scale})';
    const instrumented = instrumentMolecularGeometry(html);
    expect(instrumented).toContain('sourceBoundary:primary?.obj?.data?.sourceData?.boundary?.sphere');
    expect(html).not.toContain('sourceBoundary');
    expect(() => instrumentMolecularGeometry('getEntryGeometry:()=>({objects:[]})')).toThrow('primary molecular representation');
  });
});


describe('current native menu row publications', () => {
  const rows = (draw: number, from: number, actions: string[], total = actions.length) => ({
    kind: 'toolbar', detail: { phase: 'rows', draw, from, total, hidden: false,
      actions: actions.map(kind => JSON.stringify({ kind })), labels: actions,
      x: actions.map((_, i) => from + i), y: actions.map(() => 0), z: actions.map(() => -1) },
  });
  it('retains the actual complete publication after the diagnostics ring evicts its rows', () => {
    const observer = createControllerMenuObservation();
    observer.record(rows(82, 0, ['collapse'], 2)); observer.record(rows(82, 1, ['recenter-menu'], 2));
    for (let i = 0; i < 512; i++) observer.record({ kind: 'xr-frame', detail: { i } });
    expect(observer.current()).toEqual({ draw: 82, rows: [
      { label: 'collapse', action: '{"kind":"collapse"}', x: 0, y: 0, z: -1 },
      { label: 'recenter-menu', action: '{"kind":"recenter-menu"}', x: 1, y: 0, z: -1 },
    ] });
  });
  it('never substitutes an older complete seat for a newer incomplete draw', () => {
    const observer = createControllerMenuObservation(); observer.record(rows(82,0,['recenter-menu']));
    observer.record(rows(83,1,['recenter-menu'],2)); expect(observer.current()).toBeNull();
    observer.record(rows(82,0,['recenter-menu'])); expect(observer.current()).toBeNull();
    observer.record(rows(83,0,['collapse'],2)); expect(observer.current()?.draw).toBe(83);
  });
  it.each(['redraw-dispose', 'hidden', 'seat-commit', 'selectstart'])('invalidates previous rows on %s teardown/hidden state', phase => {
    const observer = createControllerMenuObservation(); observer.record(rows(82,0,['recenter-menu']));
    observer.record({ kind: 'toolbar', detail: { phase, hidden: true, closed: phase === 'selectstart' } });
    expect(observer.current()).toBeNull();
    observer.record(rows(82,0,['recenter-menu'])); expect(observer.current()).toBeNull();
    observer.record(rows(83,0,['collapse'])); expect(observer.current()?.draw).toBe(83);
  });
  it('recognizes a complete compact draw without inventing an expanded recenter row', () => {
    const observer = createControllerMenuObservation(); observer.record(rows(82,0,['recenter-menu']));
    observer.record(rows(83,0,['recenter-structure','collapse']));
    expect(observer.current()?.rows.map(row => JSON.parse(row.action).kind)).toEqual(['recenter-structure','collapse']);
    expect(observer.current()?.rows.some(row => JSON.parse(row.action).kind === 'recenter-menu')).toBe(false);
  });
});


function nativeFrameWaitHarness({ missing = false, replace = false } = {}) {
  let clock = 0, timerId = 0;
  const frames: any[] = [], timers = new Map<number, () => void>(), returns: unknown[] = [];
  const control: any = {};
  const source = { handedness: 'left', gripSpace: {} };
  const c = vm.createContext({ performance: { now: () => clock },
    setTimeout(callback: () => void, duration: number) { expect(duration).toBe(20_000); timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    __controllerAcceptance: control,
    __companionXrTest: { device: { position: { x: 0, y: 1.6, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      active: { space: {}, session: { inputSources: [source], requestAnimationFrame(callback: any) { frames.push(callback); } } } },
  });
  const evaluate = async (fn: (...args: any[]) => any, arg: any) => {
    c.arg = arg;
    const result = vm.runInContext(`(${fn.toString()})(arg)`, c);
    returns.push(result);
    expect(typeof result?.then).not.toBe('function');
    return result;
  };
  const page = { evaluate, waitForFunction: async (fn: (...args: any[]) => any, arg: any, options: any) => {
    expect(options.timeout).toBe(25_070);
    if (replace) { control.frameWait = { id: 99, settled: true }; return; }
    for (let iteration = 0; iteration < 20; iteration++) {
      if (missing) { for (const callback of timers.values()) callback(); timers.clear(); }
      else {
        clock += 16;
        frames.shift()?.(clock, { getViewerPose: () => ({ transform: { inverse: { matrix: Array(16).fill(1) } } }),
          getPose: () => ({ transform: { position: { x: .2, y: 1.2, z: -.3 } } }) });
      }
      await Promise.resolve(); await Promise.resolve();
      c.arg = arg;
      if (vm.runInContext(`(${fn.toString()})(arg)`, c)) return;
    }
    throw Error('Harness wait did not settle');
  } };
  return { page: page as any, c, control, frames, returns, timers };
}

describe('controller native frame wait lifetime', () => {
  it('starts synchronously, retains native observations and returns no browser promise through CDP', async () => {
    const h = nativeFrameWaitHarness();
    await waitControllerFrames(h.page, 70);
    expect(h.returns[0]).toBe(1);
    expect(h.control.frameWait).toMatchObject({ settled: true, frames: 5, duration: 70 });
    expect(h.control.nativeGrips.left).toEqual([.2, 1.2, -.3]);
    expect(h.control.viewerFrame.viewerPose.position.y).toBe(1.6);
    expect(h.timers.size).toBe(0);
  });

  it('keeps the native missing-frame refusal rather than silently accepting a stalled session', async () => {
    const h = nativeFrameWaitHarness({ missing: true });
    await expect(waitControllerFrames(h.page, 70)).rejects.toThrow('Native XR frame did not arrive');
    expect(h.control.frameWait).toMatchObject({ settled: true, frames: 0 });
  });

  it('rejects replaced task ownership instead of accepting another wait result', async () => {
    const h = nativeFrameWaitHarness({ replace: true });
    await expect(waitControllerFrames(h.page, 70)).rejects.toThrow('replaced before observation');
  });

  it('rejects overlapping starts while preserving the original pending native task', () => {
    const h = nativeFrameWaitHarness();
    const begin = vm.runInContext(`(${beginControllerFrameWait.toString()})`, h.c);
    expect(begin(0)).toBe(1);
    const original = h.control.frameWait;
    expect(() => begin(0)).toThrow('already running');
    expect(h.control.frameWait).toBe(original);
  });
});
