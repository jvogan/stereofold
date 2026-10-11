import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { xrStartupSchema } from '../src/inspection-contract.js';

/**
 * The immersive page polls with its XR startup snapshot on every heartbeat and
 * the server parses it with a strict object. A change once added two
 * keys to the page with green suites on both sides, and the merged tip refused
 * every headset poll with 409 "Unrecognized keys" until the schema caught up.
 * This file reads the page's own snapshot literal so the seam fails here first.
 */
const page = readFileSync(new URL('../../lab/browser-roundtrip/immersive-session.mjs', import.meta.url), 'utf8');

function startupSnapshotKeys(source: string): string[] {
  const start = source.indexOf('startup: () => {');
  expect(start, 'immersive-session.mjs still builds the startup snapshot in a `startup` hook').toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf('return {', start));
  let depth = 0; let end = open;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  const flat = source.slice(open + 1, end).replace(/\{[^{}]*\}/g, '{}');
  const keys = new Set<string>();
  for (const part of flat.split(',')) {
    const match = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}

describe('the XR startup snapshot the page polls with', () => {
  it('names only keys the strict server schema accepts', () => {
    const keys = startupSnapshotKeys(page);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(xrStartupSchema.shape, `page snapshot key ${key}`).toHaveProperty(key);
  });

  it('parses with the frame-rate keys in both shapes the page sends', () => {
    const base = { phase: 'active', pending: false, reloadRequired: false, mode: 'immersive-ar', gestureActive: true,
      frameCount: 19510, viewCount: 2, blendMode: 'alpha-blend', errorName: null, presenting: true,
      sessionVisibility: 'visible', pendingEntry: null } as const;
    const granted = xrStartupSchema.parse({ ...base, supportedFrameRates: [60, 72, 80, 90, 120], reportedFrameRate: 72 });
    expect(granted.supportedFrameRates).toEqual([60, 72, 80, 90, 120]);
    expect(granted.reportedFrameRate).toBe(72);
    const withoutApi = xrStartupSchema.parse({ ...base, supportedFrameRates: [], reportedFrameRate: null });
    expect(withoutApi.supportedFrameRates).toEqual([]);
    expect(withoutApi.reportedFrameRate).toBeNull();
    expect(() => xrStartupSchema.parse({ ...base, somethingNew: 1 })).toThrow(/Unrecognized/);
  });
});
