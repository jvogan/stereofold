/** Optional lab inputs follow the selected build's index, never another revision. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

export function readCachedDemoCoordinates(demo, stage, {
  cache = process.env.STEREOFOLD_DEMO_CACHE,
  root = process.env.STEREOFOLD_DEMO_ROOT ?? new URL('../../plugin/demos/', import.meta.url).pathname,
} = {}) {
  if (!cache) throw Error('STEREOFOLD_DEMO_CACHE is required');
  const index = JSON.parse(readFileSync(resolve(root, 'index.json'), 'utf8'));
  const entry = index.demos.find(entry => entry.name === demo);
  const coordinates = entry?.stages?.find(entry => entry.id === stage)?.coordinates;
  if (!coordinates) throw Error(`Unknown indexed demo stage: ${demo}/${stage}`);
  const { file, sha256 } = coordinates, ext = extname(file);
  const addressed = `${file.slice(0, file.length - ext.length)}.${sha256}${ext}`;
  for (const name of [addressed, file]) {
    let bytes;
    try { bytes = readFileSync(resolve(cache, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (createHash('sha256').update(bytes).digest('hex') === sha256) return bytes.toString('utf8');
  }
  throw Error(`No cached coordinates matching ${demo}/${stage} SHA-256 ${sha256}`);
}
