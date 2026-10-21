import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readCachedDemoCoordinates } from './demo-cache.mjs';

test('optional demo-cache inputs select the index digest and verify legacy fallback', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'stereofold-lab-cache-'));
  try {
    const text = 'data_EXPECTED\n', sha256 = createHash('sha256').update(text).digest('hex');
    await writeFile(resolve(dir, 'index.json'), JSON.stringify({ demos: [{ name: 'motion', stages: [{
      id: 'motion', coordinates: { file: 'motion.cif', sha256 },
    }] }] }));
    const read = () => readCachedDemoCoordinates('motion', 'motion', { cache: dir, root: dir });
    await writeFile(resolve(dir, 'motion.cif'), 'wrong revision');
    assert.throws(read, /No cached coordinates matching/);
    await writeFile(resolve(dir, 'motion.cif'), text);
    assert.equal(read(), text);
    await writeFile(resolve(dir, `motion.${sha256}.cif`), text);
    await writeFile(resolve(dir, 'motion.cif'), 'another host changed legacy bytes');
    assert.equal(read(), text);
    await writeFile(resolve(dir, `motion.${sha256}.cif`), 'corrupted');
    assert.throws(read, /No cached coordinates matching/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
