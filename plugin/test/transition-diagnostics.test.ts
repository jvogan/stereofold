import { expect, it } from 'vitest';
import { diagnosticEntrySchema, salvageDiagnosticEntries } from '../src/headset-diagnostics.js';
import { transitionRecords } from '../scripts/headset-drive.js';
// @ts-ignore Shared browser producer, no WebGL required.
import { beginSceneTransition, watchFrameCost } from '../../lab/browser-roundtrip/xr-render-budget.mjs';
// @ts-ignore Shared bounded browser ring.
import { createDiagnosticsBuffer } from '../../lab/browser-roundtrip/headset-diagnostics.mjs';

it('retains all transition phases through the page ring, heartbeat schema and driver diagnostics reader', () => {
  let clock = 0, frame: () => void;
  const ring = createDiagnosticsBuffer({ now: () => 1_000_000 + clock });
  const session = { frameRate: 72, requestAnimationFrame(fn: () => void) { frame = fn; } };
  const sampler = watchFrameCost({ session, now: () => clock, record: ring.record, intervalMs: 1, scope: {} });
  const transition = beginSceneTransition({ session, operation: 'source', now: () => clock, record: ring.record });
  session.requestAnimationFrame(() => { clock += 2; }); frame!();
  clock += 48; session.requestAnimationFrame(() => { clock += 3; }); frame!();
  transition.firstFrame(); transition.oldRemoved(); transition.finish(); sampler.stop();
  const raw = ring.all();
  expect(raw.map((entry: unknown) => diagnosticEntrySchema.parse(entry))).toEqual(raw);
  const read = transitionRecords(salvageDiagnosticEntries(raw));
  expect(read.map(entry => entry.detail.phase)).toEqual(['start', 'first-frame', 'old-removed', 'complete']);
  expect(read.at(-1)?.detail).toMatchObject({ worstFrameMs: 50, maxCallbackMs: 3, maxFrameGapMs: 50, frames: 2, reportedFrameRate: 72 });
  expect(read[0]?.detail.firstFrameAtMs).toBeNull();
  expect(read.at(-1)?.detail.firstFrameAtMs).toBeLessThanOrEqual(read.at(-1)!.detail.oldRemovedAtMs!);
});

it('separates failed and unmeasured transitions and rejects incomplete driver records', () => {
  const ring = createDiagnosticsBuffer();
  const transition = beginSceneTransition({ operation: 'appearance', record: ring.record });
  transition.finish('failed'); transition.finish();
  const records = transitionRecords(ring.all());
  expect(records).toHaveLength(2);
  expect(records.at(-1)?.detail).toMatchObject({ phase: 'failed', frames: 0, worstFrameMs: null, firstFrameAtMs: null, oldRemovedAtMs: null });
  expect(transitionRecords([{ kind: 'transition', detail: { phase: 'complete', id: 1, operation: 'source' } }])).toEqual([]);
});
