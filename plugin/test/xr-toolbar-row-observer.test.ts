import { describe, expect, it } from 'vitest';
import { observeToolbarRows } from '../scripts/xr-toolbar-row-observer.js';
// @ts-ignore Production browser diagnostics recorder.
import { createDiagnosticsBuffer, installHeadsetDiagnostics, resetHeadsetDiagnostics, recordHeadsetEvent } from '../../lab/browser-roundtrip/headset-diagnostics.mjs';

const rows = (draw: number, from: number, labels: string[]) => ({ phase: 'rows', draw, from,
  total: 2, labels, actions: labels.map(label => JSON.stringify({ kind: label })),
  targetable: labels.map(() => true), x: labels.map(() => -.7),
  y: labels.map((_, index) => -.06 - (from + index) * .066), z: labels.map(() => -1.15) });
function setup() {
  const buffer = createDiagnosticsBuffer({ limit: 8, rateLimitMs: {} });
  const hook = { record: buffer.record, entries: buffer.all };
  return { buffer, hook, scope: { __stereofoldDiagnostics: hook } };
}
describe('live toolbar row observation', () => {
  it('retains genuine row coordinates through production ring eviction without changing its behavior', () => {
    const { buffer, hook, scope } = setup();
    hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
    const published = observeToolbarRows(scope);
    for (let index = 0; index < 40; index++) hook.record('xr-stick', { event: 'end', index });
    expect(buffer.all()).toHaveLength(8);
    expect(buffer.all().some((entry: any) => entry.detail.phase === 'rows')).toBe(false);
    expect(observeToolbarRows(scope)).toEqual(published);
    expect(published[0].labels).toEqual(['Close', 'Surface']);
    expect(published[0].y).toEqual([-.06, -.126]);
    expect(hook.record('xr-stick', { event: 'end' }).seq).toBe(42);
  });

  it('replaces prior seats immediately on a new draw and retains all of its chunks', () => {
    const { hook, scope } = setup();
    observeToolbarRows(scope);
    hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
    hook.record('toolbar', rows(2, 0, ['Menu']));
    expect(observeToolbarRows(scope).flatMap(part => part.labels)).toEqual(['Menu']);
    hook.record('toolbar', rows(2, 1, ['Fit']));
    expect(observeToolbarRows(scope).flatMap(part => part.labels)).toEqual(['Menu', 'Fit']);
    expect(observeToolbarRows(scope).every(part => part.draw === 2)).toBe(true);
    hook.record('toolbar', rows(1, 0, ['New session']));
    expect(observeToolbarRows(scope).flatMap(part => part.labels)).toEqual(['New session']);
  });

  it('does not carry seats into a replaced diagnostics hook or invent absent rows', () => {
    const { hook, scope } = setup();
    observeToolbarRows(scope);
    hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
    scope.__stereofoldDiagnostics = setup().hook;
    expect(observeToolbarRows(scope)).toEqual([]);
  });

  it('clears same-hook seats on actual module-recorder session boundaries and buffer reset', () => {
    resetHeadsetDiagnostics({ rateLimitMs: {} });
    const scope: any = {};
    const hook = installHeadsetDiagnostics(scope);
    observeToolbarRows(scope);
    for (const kind of ['session-end', 'session-start']) {
      hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
      recordHeadsetEvent(kind, {}); // Production session path bypasses hook.record.
      expect(observeToolbarRows(scope)).toEqual([]);
    }
    hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
    resetHeadsetDiagnostics({ rateLimitMs: {} });
    recordHeadsetEvent('page-open', {});
    expect(observeToolbarRows(scope)).toEqual([]);
    expect(scope.__stereofoldDiagnostics).toBe(hook);
    hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
    resetHeadsetDiagnostics();
    expect(observeToolbarRows(scope)).toEqual([]);
  });

  it('invalidates disposal and malformed publications, and drops extra chunks on a same-counter redraw', () => {
    const { hook, scope } = setup();
    observeToolbarRows(scope);
    const publish = () => {
      hook.record('toolbar', rows(1, 0, ['Close']));
      hook.record('toolbar', rows(1, 1, ['Surface']));
    };
    publish();
    hook.record('toolbar', { ...rows(1, 0, ['Menu']), total: 1 });
    expect(observeToolbarRows(scope).flatMap(part => part.labels)).toEqual(['Menu']);
    for (const invalid of [{ draw: NaN }, { from: NaN }, { x: [] }, { total: 0 }]) {
      publish();
      hook.record('toolbar', { ...rows(1, 0, ['Bad']), ...invalid });
      expect(observeToolbarRows(scope)).toEqual([]);
    }
    publish();
    hook.record('toolbar', { phase: 'redraw-dispose' });
    expect(observeToolbarRows(scope)).toEqual([]);
  });

  it('preserves receiver, returned identity and thrown errors', () => {
    const receiver = {}, returned = {}, failure = Error('recorder failed');
    let actualReceiver: unknown;
    const hook = { entries: () => [], record(this: unknown, fail: boolean) {
      actualReceiver = this;
      if (fail) throw failure;
      return returned;
    } };
    observeToolbarRows({ __stereofoldDiagnostics: hook });
    expect(hook.record.call(receiver, false)).toBe(returned);
    expect(actualReceiver).toBe(receiver);
    expect(() => hook.record.call(receiver, true)).toThrow(failure);
  });

  it('keeps unchanged seats when the production buffer immediately drops direct frequent samples', () => {
    resetHeadsetDiagnostics({ limit: 8, rateLimitMs: {} });
    const scope: any = {}, hook = installHeadsetDiagnostics(scope);
    observeToolbarRows(scope);
    hook.record('toolbar', rows(1, 0, ['Close', 'Surface']));
    for (let i = 0; i < 8; i++) hook.record('xr-stick', { event: 'end' });
    const before = observeToolbarRows(scope);
    for (let i = 0; i < 40; i++) recordHeadsetEvent('frame-rate', { fps: 72 });
    expect(hook.entries().some((entry: any) => entry.kind === 'frame-rate')).toBe(false);
    expect(observeToolbarRows(scope)).toEqual(before);
    hook.record('xr-stick', { event: 'start' });
    expect(observeToolbarRows(scope)).toEqual(before);
    recordHeadsetEvent('session-end', {});
    expect(observeToolbarRows(scope)).toEqual([]);
  });
});
