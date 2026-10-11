import { expect, it } from 'vitest';
import { diagnosticEntrySchema, salvageDiagnosticEntries } from '../src/headset-diagnostics.js';
// @ts-ignore Shared page sanitizer.
import { sanitizeDetail } from '../../lab/browser-roundtrip/headset-diagnostics.mjs';

it('keeps reply-seat evidence through the page sanitizer, strict Mac schema and salvage', () => {
  const entry = { seq: 1, at: 1000, kind: 'talk-caption-seat',
    detail: { outcome: 'shown', replyOffset: [0, -.16, 0] } };
  expect(sanitizeDetail(entry.detail)).toEqual(entry.detail);
  expect(diagnosticEntrySchema.parse(entry)).toEqual(entry);
  expect(salvageDiagnosticEntries([entry])).toEqual([entry]);
  for (const replyOffset of [[0, 1], [0, Infinity, 0], [0, 1, 0, 2]]) {
    expect(diagnosticEntrySchema.safeParse({ ...entry, detail: { replyOffset } }).success).toBe(false);
  }
});
