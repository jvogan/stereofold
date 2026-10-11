import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');

/**
 * Extraction runs on the thread that answers panel and headset requests. Run
 * without a break, a large structure left that thread deaf for the whole
 * extraction: 66 s for a 24 MB ribosome, against a 10 s desktop heartbeat grace.
 */
it('hands the thread back during an extraction, so heartbeats and other requests are answered', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 2);
  try { for (let run = 0; run < 4; run++) await extractInspectionCatalogBytes(hhb); }
  finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(0);
});

it('returns the same catalog however the thread is shared', async () => {
  const [first, second] = await Promise.all([extractInspectionCatalogBytes(hhb), extractInspectionCatalogBytes(hhb)]) as any[];
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(first.rows.length).toBeGreaterThan(500);
});
