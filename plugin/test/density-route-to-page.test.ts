/**
 * The wire and the page's own check, proven together.
 *
 * Every other test in this repo proves one side of the density tier. The host
 * tests prove that `/density` serves the right bytes under the right headers;
 * `lab/browser-roundtrip/volume-source.test.mjs`
 * proves that `checkedVolumeFixture` refuses a fixture whose digest is wrong.
 * Neither says the two agree, and they are separately written — a host that
 * served a base64 string and a page that demanded raw bytes would pass both.
 *
 * So this stands up the real loopback server, fetches over a real socket with
 * a real bearer, and hands what comes back to the real page-side checker, as
 * the headset's `inspection-companion-client.ts` does. The lab module is
 * imported dynamically through a URL so the plugin's TypeScript project does
 * not have to resolve a `.mjs` outside its own tree.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { MAX_INSPECTION_DENSITY_BYTES } from '../src/inspection-limits.js';
import { syntheticMap } from './synthetic-map.js';

const volumeSourceUrl = new URL('../../lab/browser-roundtrip/volume-source.mjs', import.meta.url).href;
const volumeSource: {
  checkedVolumeFixture: (fixture: unknown, options: unknown, failure: (code: string, message: string) => Error,
    subtle?: SubtleCrypto) => Promise<{ source: Record<string, unknown>; settings: Record<string, unknown> }>;
  isVolumeFixture: (fixture: unknown) => boolean;
  volumeIsosurfaceParams: (options: { contour: number; opacity?: number }) => Record<string, unknown>;
  VOLUME_REPRESENTATION: string;
} = await import(volumeSourceUrl);

const key = 'stereo_structure/inspection';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** The viewer's own error maker, in the shape `checkedVolumeFixture` expects. */
const failure = (code: string, message: string) => Object.assign(Error(message), { code });

const map = syntheticMap();
const contour = 3.3;
const text = 'data_3jak\n_atom_site.id 1\n';

/** A host holding the map, and the bearer-scoped link a headset would be given. */
async function host(density?: { bytes: Buffer; sha256: string; contour: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-density-page-'));
  const htmlPath = join(directory, 'inspector.html');
  await writeFile(htmlPath, '<!doctype html><html><head></head><body><script src="inspection.js"></script></body></html>');
  const companion = new InspectionCompanionHttp({
    htmlPath,
    source: async () => ({ text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') }),
    ...(density ? { density: async () => density } : {}),
    dispatch: vi.fn(async (_sessionId, _sourceToken, name, args) => ({
      content: [{ type: 'text', text: `${name} complete` }], structuredContent: { name, args },
      _meta: { [key]: { structureText: text, catalog: { source: { sha256: createHash('sha256').update(text, 'utf8').digest('hex') } } } },
    })),
  });
  const link = await companion.open('session-a', 'source-a');
  const origin = new URL(link.url).origin;
  const bearer = new URL(link.url).hash.slice(1);
  return {
    origin, bearer,
    /** What the page would receive as its hydration, minus the coordinates. */
    hydrate: async () => (await (await fetch(`${origin}/tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_inspection', args: { panelId: 'panel-1' } }),
    })).json())._meta[key],
    cleanup: async () => { await companion.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

describe('the density map, from the host route into the page\'s own check', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('serves bytes the page accepts, meshed at the contour the response named', async () => {
    const served = await host({ bytes: map, sha256: digest(map), contour });
    cleanups.push(served.cleanup);

    // 1. The page reads the descriptor out of its hydration, exactly as
    //    `inspection-companion-client.ts` does before it fetches anything.
    const meta = await served.hydrate();
    expect(meta.density).toEqual({ url: '/density', sha256: digest(map), bytes: map.byteLength, contour });
    expect(meta.density.bytes).toBeLessThanOrEqual(MAX_INSPECTION_DENSITY_BYTES);

    // 2. It fetches that url with the same bearer, and checks the served digest
    //    and contour against the descriptor before it trusts either.
    const response = await fetch(`${served.origin}${meta.density.url}`, { headers: { Authorization: `Bearer ${served.bearer}` } });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get('x-stereofold-density-sha256')).toBe(meta.density.sha256);
    expect(Number(response.headers.get('x-stereofold-density-contour'))).toBe(meta.density.contour);
    expect(digest(bytes)).toBe(meta.density.sha256);

    // 3. And the page's own checker takes them. THIS is the joint the two sides
    //    were written separately across: the fixture is built out of what the
    //    wire produced, not out of a literal in a test.
    const fixture = { id: 'microtubule-growth-filament', map: bytes, sha256: meta.density.sha256, contour: meta.density.contour };
    expect(volumeSource.isVolumeFixture(fixture)).toBe(true);
    const { source, settings } = await volumeSource.checkedVolumeFixture(fixture, {}, failure, globalThis.crypto.subtle);
    expect(source.map).toBeInstanceOf(Uint8Array);
    expect((source.map as Uint8Array).byteLength).toBe(map.byteLength);
    expect(Buffer.from(source.map as Uint8Array).equals(map)).toBe(true);
    expect(settings.representation).toBe(volumeSource.VOLUME_REPRESENTATION);

    // 4. The contour that reaches the isosurface is the one the RESPONSE
    //    carried, absolute, and not a relative sigma of this map's own RMS.
    expect(volumeSource.volumeIsosurfaceParams({ contour: source.contour as number }))
      .toMatchObject({ isoValue: { kind: 'absolute', absoluteValue: contour } });
  });

  it('leaves the page with nothing to fetch when the session is atomic', async () => {
    const served = await host();
    cleanups.push(served.cleanup);
    const meta = await served.hydrate();

    expect('density' in meta).toBe(false);
    // The absence is the whole instruction. A page that asked anyway is told
    // the route does not exist, rather than handed an empty body to mesh.
    expect((await fetch(`${served.origin}/density`, { headers: { Authorization: `Bearer ${served.bearer}` } })).status).toBe(404);
  });

  it('refuses on the page when a byte changes anywhere between the two ends', async () => {
    // The digest is checked three times — by the host before it sends, by the
    // client against the header, and here by the page against the descriptor.
    // Only the last one is still standing if the bytes are altered in flight,
    // so it is the one that has to hold.
    const served = await host({ bytes: map, sha256: digest(map), contour });
    cleanups.push(served.cleanup);
    const meta = await served.hydrate();
    const bytes = new Uint8Array(await (await fetch(`${served.origin}/density`,
      { headers: { Authorization: `Bearer ${served.bearer}` } })).arrayBuffer());

    const tampered = Uint8Array.from(bytes);
    tampered[2_000] ^= 0xff; // one voxel, in the payload rather than the header.
    await expect(volumeSource.checkedVolumeFixture(
      { id: 'microtubule-growth-filament', map: tampered, sha256: meta.density.sha256, contour },
      {}, failure, globalThis.crypto.subtle)).rejects.toThrow(/do not match the digest/i);
    // And a contour the response never named is refused before any mesh is
    // built, rather than silently meshed at a level nobody authored.
    await expect(volumeSource.checkedVolumeFixture(
      { id: 'microtubule-growth-filament', map: bytes, sha256: meta.density.sha256, contour: undefined },
      {}, failure, globalThis.crypto.subtle)).rejects.toThrow(/absolute contour/i);
  });
});
