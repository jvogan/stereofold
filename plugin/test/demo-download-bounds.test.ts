/**
 * Demo downloads are read as a stream and given up the moment they pass their
 * limit, so a server that never stops sending cannot fill this Mac's memory,
 * and nothing reaches the demo cache unless its size and its digest both pass.
 *
 * The network is a stub: its body keeps producing the same chunk until the
 * reader cancels it, with a ceiling so a reader that never cancels still ends.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGrowthCoordinates } from '../src/growth-coordinates.js';
import { resolveCoordinates, type DemoEntry } from '../scripts/quest-demo.js';

const MiB = 1024 * 1024;
const PLAIN = 'data_PLAIN\n#\nloop_\n_atom_site.group_PDB\nATOM\n#\n';
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function endlessBody(chunkBytes: number, ceilingChunks: number) {
  const chunk = new Uint8Array(chunkBytes).fill(0x41);
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= ceilingChunks) { controller.close(); return; }
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, state };
}

/** A small body delivered in several chunks, as a real transfer arrives. */
function chunkedBody(text: string, pieces = 3): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const step = Math.ceil(bytes.length / pieces);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + step));
      offset += step;
    },
  });
}

let cache = '';
const cachePath = (file: string) => resolve(cache, file);

beforeEach(async () => { cache = await mkdtemp(resolve(tmpdir(), 'stereofold-download-bounds-')); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cache, { force: true, recursive: true });
});

const growthRequest = (sha256: string) => ({
  demo: 'microtubule-growth', stageId: 'wall', file: 'assembly.cif', sha256,
  download: 'https://files.example.test/assembly.cif',
});

const coordinateEntry = (sha256: string): DemoEntry => ({
  name: 'download-bounds', title: 'Download bounds', lesson: 'download-bounds.json', sources: [],
  coordinates: { file: 'assembly.cif', sha256, bytes: 1, atomSites: 1, download: 'https://files.example.test/assembly.cif' },
});

const mapEntry = (): DemoEntry => ({
  name: 'download-bounds-map', title: 'Download bounds map', lesson: 'download-bounds-map.json', sources: [],
  coordinates: {
    file: 'map-4x.map', sha256: 'b'.repeat(64), bytes: 1, atomSites: 0,
    download: 'https://files.example.test/map.map.gz',
    volume: {
      emdbId: 'EMD-0000', downloadSha256: 'c'.repeat(64), downsample: 4, grid: [1, 1, 1], voxelAngstroms: 1,
      contour: 1, depositedContour: 1, contourSigma: 1, triangles: 1,
      structure: { file: 'model.cif', sha256: 'd'.repeat(64), bytes: 1, atomSites: 1, catalogRows: 1, download: 'https://files.example.test/model.cif' },
    },
  },
});

describe('the live grow download', () => {
  it('cancels an endless body as soon as it passes 64 MiB and caches nothing', async () => {
    const { body, state } = endlessBody(MiB, 96);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(ensureGrowthCoordinates(growthRequest('a'.repeat(64)), { cachePath, announce: () => undefined }))
      .rejects.toThrow('could not be fetched');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBe(65);
    expect(await readdir(cache)).toEqual([]);
  });

  it('refuses a declared length past the limit without reading the body', async () => {
    const { body, state } = endlessBody(MiB, 96);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-length': String(64 * MiB + 1) } })));
    await expect(ensureGrowthCoordinates(growthRequest('a'.repeat(64)), { cachePath, announce: () => undefined }))
      .rejects.toThrow('could not be fetched');
    expect(state.pulled).toBe(0);
    expect(await readdir(cache)).toEqual([]);
  });

  it('still downloads, verifies and caches a file within the limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunkedBody(PLAIN))));
    const result = await ensureGrowthCoordinates(growthRequest(digest(PLAIN)), { cachePath, announce: () => undefined });
    expect(result.text).toBe(PLAIN);
    expect(await readFile(result.path, 'utf8')).toBe(PLAIN);
  });

  it('caches nothing when the body is within the limit but fails its digest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunkedBody(PLAIN))));
    await expect(ensureGrowthCoordinates(growthRequest('a'.repeat(64)), { cachePath, announce: () => undefined }))
      .rejects.toThrow('no longer serves');
    expect(await readdir(cache)).toEqual([]);
  });
});

describe('the demo launcher download', () => {
  it('cancels an endless coordinate body as soon as it passes 64 MiB and caches nothing', async () => {
    const { body, state } = endlessBody(MiB, 96);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(resolveCoordinates(coordinateEntry('a'.repeat(64)), cache, () => undefined)).rejects.toThrow();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBe(65);
    expect(await readdir(cache)).toEqual([]);
  });

  it('cancels an endless map body as soon as it passes 256 MiB and caches nothing', async () => {
    const { body, state } = endlessBody(4 * MiB, 66);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(resolveCoordinates(mapEntry(), cache, () => undefined)).rejects.toThrow();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBe(65);
    expect(await readdir(cache)).toEqual([]);
  });

  it('still downloads, verifies and caches coordinates within the limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunkedBody(PLAIN))));
    const path = await resolveCoordinates(coordinateEntry(digest(PLAIN)), cache, () => undefined);
    expect(await readFile(path, 'utf8')).toBe(PLAIN);
  });

  it('caches nothing when coordinates within the limit fail their digest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunkedBody(PLAIN))));
    await expect(resolveCoordinates(coordinateEntry('a'.repeat(64)), cache, () => undefined)).rejects.toThrow('no longer produces');
    expect(await readdir(cache)).toEqual([]);
  });
});

/**
 * A stand-in for fetch that behaves as fetch does with redirects: it follows
 * them itself unless the caller asks for `redirect: 'manual'`, and records
 * every address actually requested.
 */
function redirectingFetch(hops: Record<string, string>, final: () => Response) {
  const requested: string[] = [];
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let url = String(input);
    for (;;) {
      requested.push(url);
      const next = hops[url];
      if (next === undefined) return final();
      if (init?.redirect === 'manual') return new Response(null, { status: 302, headers: { location: next } });
      url = new URL(next, url).href;
    }
  });
  return { fake, requested };
}

describe('demo download redirects', () => {
  const start = 'https://files.example.test/assembly.cif';
  const loopback = 'http://127.0.0.1:8123/probe';

  it('a live grow never requests a redirect that leaves https', async () => {
    const { fake, requested } = redirectingFetch({ [start]: loopback }, () => new Response(PLAIN));
    vi.stubGlobal('fetch', fake);
    await expect(ensureGrowthCoordinates(growthRequest(digest(PLAIN)), { cachePath, announce: () => undefined }))
      .rejects.toThrow('could not be fetched');
    expect(requested).toEqual([start]);
    expect(await readdir(cache)).toEqual([]);
  });

  it('the launcher never requests a redirect that leaves https', async () => {
    const { fake, requested } = redirectingFetch({ [start]: loopback }, () => new Response(PLAIN));
    vi.stubGlobal('fetch', fake);
    await expect(resolveCoordinates(coordinateEntry(digest(PLAIN)), cache, () => undefined)).rejects.toThrow('Insecure URLs');
    expect(requested).toEqual([start]);
    expect(await readdir(cache)).toEqual([]);
  });

  it('the launcher refuses a download address that is not https before requesting it', async () => {
    const { fake, requested } = redirectingFetch({}, () => new Response(PLAIN));
    vi.stubGlobal('fetch', fake);
    const entry = coordinateEntry(digest(PLAIN));
    entry.coordinates.download = loopback;
    await expect(resolveCoordinates(entry, cache, () => undefined)).rejects.toThrow('Insecure URLs');
    expect(requested).toEqual([]);
  });

  it('both still follow https redirects to the verified file', async () => {
    const mirror = 'https://mirror.example.test/assembly.cif';
    const grow = redirectingFetch({ [start]: mirror }, () => new Response(PLAIN));
    vi.stubGlobal('fetch', grow.fake);
    const result = await ensureGrowthCoordinates(growthRequest(digest(PLAIN)), { cachePath, announce: () => undefined });
    expect(result.text).toBe(PLAIN);
    expect(grow.requested).toEqual([start, mirror]);
    await rm(result.path);

    const launch = redirectingFetch({ [start]: mirror }, () => new Response(PLAIN));
    vi.stubGlobal('fetch', launch.fake);
    const path = await resolveCoordinates(coordinateEntry(digest(PLAIN)), cache, () => undefined);
    expect(await readFile(path, 'utf8')).toBe(PLAIN);
    expect(launch.requested).toEqual([start, mirror]);
  });

  it('a live grow refuses a sixth redirect', async () => {
    const hops = Object.fromEntries(Array.from({ length: 6 }, (_, i) =>
      [i === 0 ? start : `https://files.example.test/hop-${i}`, `https://files.example.test/hop-${i + 1}`]));
    const { fake, requested } = redirectingFetch(hops, () => new Response(PLAIN));
    vi.stubGlobal('fetch', fake);
    await expect(ensureGrowthCoordinates(growthRequest(digest(PLAIN)), { cachePath, announce: () => undefined }))
      .rejects.toThrow('five-redirect');
    expect(requested).toHaveLength(6);
  });
});
