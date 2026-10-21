import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

test('chapter field diagnostics capture scale once and retain the exact per-kind summary', () => {
  for (const [scale, cameraScale] of [[1, 1], [.782137849783092, .0240464], [2.714, .00151539]]) {
    let snapshots = 0;
    const h = vm.createContext({
      inspectionSnapshot: () => { snapshots++; return { placement: { scale } }; },
      canvas: { camera: { scale: cameraScale } },
    });
    vm.runInContext(pageFunction(source, 'chapterFieldSummary'), h);
    const bounds = { radius: 87.123456789, spheres: [
      { radius: 56.9, kind: 'motion' },
      ...Array.from({ length: 3731 }, (_, i) => ({ radius: .5 + i % 27 / 13, kind: 'drawn' })),
      ...Array.from({ length: 51 }, (_, i) => ({ radius: 2 + i / 17, kind: 'plate' })),
      { radius: 0 },
    ] };
    // Original arithmetic and ordering, evaluated against the same fixed
    // synchronous view. Keep the rounding and default kind exactly alike.
    const metres = value => Math.round(value * scale * cameraScale * 1000) / 1000;
    const expected = { radius: metres(bounds.radius) };
    for (const sphere of bounds.spheres) {
      const entry = expected[sphere.kind ?? 'other'] ??= { count: 0, largest: 0 };
      entry.count++; entry.largest = Math.max(entry.largest, metres(sphere.radius));
    }
    const actual = h.chapterFieldSummary(bounds);
    assert.equal(snapshots, 1, 'one synchronous summary takes one placement snapshot, independent of bound count');
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  }
});
