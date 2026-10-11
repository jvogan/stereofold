import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { comparisonDescriptor } from '../src/inspection-server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection } from '../src/inspection-contract.js';
import { assertInspectionBudget, MAX_INSPECTION_CHUNK_BYTES, MAX_INSPECTION_HYDRATION_BYTES,
  MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { assembleInspectionPart, hydrateComparisonSource, hydrateInspectionBytes } from '../src/inspection-chunk-client.js';
import { decodeInspectionCatalog, verifyInspectionCatalogSource } from '../src/inspection-catalog-codec.js';

// Counts how often a catalog is extracted, without changing what extraction does.
vi.mock('../src/inspection-catalog.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/inspection-catalog.js')>();
  return { ...original, extractInspectionCatalogBytes: vi.fn(original.extractInspectionCatalogBytes) };
});
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const crn = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const sha256 = (text: string | Buffer) => createHash('sha256').update(text as any).digest('hex');

/**
 * 1CRN's atoms behind mmCIF comment lines: a real, readable structure whose
 * source is large, so the test exercises the transport and not the cost of
 * parsing a ribosome. The comment lines carry no atoms.
 */
function padded(bytes: number): string {
  const comment = '# padding that carries no atoms, only bytes\n';
  return `${crn.trimEnd()}\n${comment.repeat(Math.ceil(bytes / comment.length))}`;
}
const BIG = padded(9 * 1024 * 1024);
const OVER_POLICY = padded(MAX_STRUCTURE_SOURCE_BYTES + 1024);

async function setup(primary = crn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, {
    fetchPdbText: async id => id === '2BIG' ? BIG : id === '9BIG' ? OVER_POLICY : id === '4HHB' ? hhb : crn,
  });
  const client = new Client({ name: 'comparison chunk route', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const chunkCalls: Array<Record<string, any>> = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_inspection_bytes') chunkCalls.push(args);
    return await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  };
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    if (result.isError) throw Error(result.content[0].text);
    return result;
  };
  const sessionId = (await ok('inspect', { structureText: primary })).structuredContent.sessionId as string;
  const hydrated = (await ok('get_inspection', { sessionId }))._meta[KEY];
  const catalog = hydrated.catalog;
  const scene = {
    sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId,
    selectionKeys: [catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const opened = { sessionId, serverEpoch: hydrated.serverEpoch, sourceToken: hydrated.sourceToken,
    baseStateRevision: hydrated.stateRevision, baseInspectionRevision: hydrated.inspectionRevision };
  const saved = (await ok('sync_inspection', { ...opened, scene })).structuredContent;
  const live = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await ok('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  const advance = (value: any) => {
    if (typeof value?.stateRevision === 'number') live.baseStateRevision = value.stateRevision;
    if (typeof value?.inspectionRevision === 'number') live.baseInspectionRevision = value.inspectionRevision;
    return value;
  };
  const beat = async () => (await ok('poll_inspection', { ...live, panelId, availability: 'ready' }))._meta?.[KEY];
  const render = async (delivery: any, rendered: any) => {
    advance((await ok('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: rendered })).structuredContent);
    await beat();
  };
  const state = async () => advance((await ok('get_inspection_state', { sessionId })).structuredContent);
  const compare = (pdbId: string, commandId = 'compare') =>
    call('replace_inspection_source', { ...live, panelId, mode: 'compare', pdbId, commandId });
  /** The call a panel or headset page makes: the same route, bytes and all. */
  const pageCall = (name: string, args: any) => ok(name, args);
  return { call, ok, pageCall, sessionId, scene, panelId, beat, render, state, compare, chunkCalls, hydrated,
    get binding() { return { ...live }; },
    close: async () => { await client.close(); await server.close(); } };
}

describe('comparison structures travel the chunk route', () => {
  it('delivers a comparison whose inline form passes the old 8 MiB total, one slice at a time', async () => {
    const t = await setup();
    try {
      // The shape every hydration and heartbeat used to carry. It is over the
      // budget by itself, before the scene or the catalog.
      expect(() => assertInspectionBudget({ comparisonSources: [{ cif: BIG }] }, MAX_INSPECTION_HYDRATION_BYTES, 'Comparison hydration'))
        .toThrow(/exceeds the 8\.4 MB/);

      const queued = await t.compare('2BIG');
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      expect(queued.structuredContent.command.status).toBe('queued');

      const heartbeat = await t.beat();
      const delivery = heartbeat.delivery;
      expect(delivery.change.kind).toBe('companion-structure');
      expect(heartbeat.comparisonSources).toHaveLength(1);
      const [source] = heartbeat.comparisonSources;
      const bytes = Buffer.byteLength(BIG, 'utf8');
      expect(source.cif).toBeUndefined();
      expect(source.catalogWire.data).toBeUndefined();
      expect(source.sourceBytes).toEqual({ sha256: sha256(BIG), bytes });
      expect(source.sha256).toBe(sha256(BIG));
      expect(source.assemblyId).toBe('asymmetric_unit');
      // The heartbeat is the descriptor, not the structure.
      expect(Buffer.byteLength(JSON.stringify(heartbeat), 'utf8')).toBeLessThan(64 * 1024);
      expect(bytes).toBeGreaterThan(MAX_INSPECTION_HYDRATION_BYTES);

      t.chunkCalls.length = 0;
      await hydrateComparisonSource(source, t.pageCall, t.sessionId);
      expect(source.cif).toBe(BIG);
      expect(source.sourceBytes).toBeUndefined();
      expect(source.catalogBytes).toBeUndefined();
      const sourceCalls = t.chunkCalls.filter(args => args.part === 'source');
      expect(sourceCalls).toHaveLength(Math.ceil(bytes / MAX_INSPECTION_CHUNK_BYTES));
      expect(sourceCalls.every(args => args.comparison?.sourceSha256 === sha256(BIG)
        && args.comparison?.assemblyId === 'asymmetric_unit')).toBe(true);
      expect(Math.max(...t.chunkCalls.map(args => args.byteCount))).toBeLessThanOrEqual(MAX_INSPECTION_CHUNK_BYTES);

      const catalog = await decodeInspectionCatalog(source.catalogWire);
      await expect(verifyInspectionCatalogSource(source.cif, catalog)).resolves.toBeUndefined();
      expect(catalog.source.sha256).toBe(sha256(BIG));

      // The rendered pair saves and hydrates again through the same descriptors.
      const pair = expectedInspection(t.scene as any, delivery.change);
      await t.render(delivery, pair);
      expect((await t.state()).view.companionStructure).toMatchObject({ sourceSha256: sha256(BIG) });
      const hydration = (await t.ok('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      expect(hydration.comparisonSources).toHaveLength(1);
      expect(hydration.comparisonSources[0].sourceBytes).toEqual({ sha256: sha256(BIG), bytes });
      expect(Buffer.byteLength(JSON.stringify(hydration), 'utf8')).toBeLessThan(MAX_INSPECTION_HYDRATION_BYTES);
    } finally { await t.close(); }
  }, 120_000);

  it('serves the primary and the comparison as separate parts of one session', async () => {
    const t = await setup();
    try {
      await t.compare('4HHB');
      const { delivery, comparisonSources: [source] } = await t.beat();
      const primary = (await t.ok('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      expect(source.sourceBytes.sha256).toBe(sha256(hhb));
      expect(primary.sourceBytes.sha256).toBe(sha256(crn));
      const key = { sourceSha256: sha256(hhb), assemblyId: source.assemblyId };
      const asComparison = await assembleInspectionPart(t.pageCall, t.sessionId, 'source', source.sourceBytes, key);
      const asPrimary = await assembleInspectionPart(t.pageCall, t.sessionId, 'source', primary.sourceBytes);
      expect(Buffer.from(asComparison).toString('utf8')).toBe(hhb);
      expect(Buffer.from(asPrimary).toString('utf8')).toBe(crn);
      // A descriptor read against the wrong owner fails the chunk's own digest.
      await expect(assembleInspectionPart(t.pageCall, t.sessionId, 'source', source.sourceBytes))
        .rejects.toThrow(/changed during delivery/);
      expect(delivery.change.kind).toBe('companion-structure');
    } finally { await t.close(); }
  });

  it('refuses a comparison key the session does not hold, and one from another session', async () => {
    const t = await setup();
    try {
      const unknown = { sourceSha256: 'e'.repeat(64), assemblyId: 'asymmetric_unit' };
      const read = (sessionId: string, comparison: unknown) =>
        t.call('get_inspection_bytes', { sessionId, part: 'source', offset: 0, byteCount: 16, comparison });
      const missing = await read(t.sessionId, unknown);
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/not held by this session/);
      // Malformed keys fail the schema rather than reaching a lookup.
      expect((await read(t.sessionId, { sourceSha256: 'xyz', assemblyId: 'asymmetric_unit' })).isError).toBe(true);
      expect((await read(t.sessionId, { sourceSha256: 'e'.repeat(64), assemblyId: 'asymmetric_unit', extra: 1 })).isError).toBe(true);

      await t.compare('4HHB');
      const { comparisonSources: [source] } = await t.beat();
      const key = { sourceSha256: sha256(hhb), assemblyId: source.assemblyId };
      expect((await read(t.sessionId, key)).isError).not.toBe(true);
      // A second session on the same server holds no comparison, so the first
      // session's structure is not readable through it.
      const other = (await t.ok('inspect', { structureText: hhb })).structuredContent.sessionId as string;
      expect(other).not.toBe(t.sessionId);
      const foreign = await read(other, key);
      expect(foreign.isError).toBe(true);
      expect(foreign.content[0].text).toMatch(/not held by this session/);
    } finally { await t.close(); }
  });

  it('stops serving a comparison once the primary source is replaced', async () => {
    const t = await setup();
    try {
      await t.compare('4HHB');
      const { delivery, comparisonSources: [source] } = await t.beat();
      await t.render(delivery, expectedInspection(t.scene as any, delivery.change));
      const key = { sourceSha256: sha256(hhb), assemblyId: source.assemblyId };
      const before = await t.call('get_inspection_bytes', { sessionId: t.sessionId, part: 'source', offset: 0, byteCount: 8, comparison: key });
      expect(before.isError).not.toBe(true);
      const replaced = await t.call('replace_inspection_source', { ...t.binding, panelId: t.panelId, pdbId: '1CRN' });
      expect(replaced.isError, JSON.stringify(replaced.content)).not.toBe(true);
      const after = await t.call('get_inspection_bytes', { sessionId: t.sessionId, part: 'source', offset: 0, byteCount: 8, comparison: key });
      expect(after.isError).toBe(true);
    } finally { await t.close(); }
  });
});

describe('preparing a comparison', () => {
  it('extracts the comparison catalog once, not once to verify it and again to use it', async () => {
    const t = await setup();
    try {
      const extract = vi.mocked(extractInspectionCatalogBytes);
      const before = extract.mock.calls.length;
      const queued = await t.compare('4HHB');
      expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
      expect(extract.mock.calls.length - before).toBe(1);
      expect(extract.mock.calls.at(-1)![0]).toBe(hhb);
    } finally { await t.close(); }
  });
});

describe('a comparison that is refused or fails leaves the primary structure intact', () => {
  /** Everything the primary is: its view, revision, source, coordinates and held comparisons. */
  async function primaryFacts(t: Awaited<ReturnType<typeof setup>>) {
    const state = await t.state();
    const hydration = (await t.ok('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
    const data = { ...hydration };
    await hydrateInspectionBytes(data, t.pageCall);
    return { sourceToken: state.sourceToken, inspectionRevision: state.inspectionRevision, view: state.view,
      comparisonSources: hydration.comparisonSources, structureText: data.structureText, scene: hydration.scene };
  }

  it('a source past the byte policy is refused before anything is queued or held', async () => {
    const t = await setup();
    try {
      const before = await primaryFacts(t);
      const refused = await t.compare('9BIG', 'too-large');
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/larger than the 64 MiB source policy/);
      expect(await primaryFacts(t)).toEqual(before);
      expect(before.comparisonSources).toEqual([]);
      expect((await t.beat()).delivery).toBeFalsy();
      // The refusal does not wedge the panel: the next, valid comparison is accepted.
      expect((await t.compare('4HHB', 'next')).isError).not.toBe(true);
    } finally { await t.close(); }
  }, 120_000);

  it('a chunk corrupted in transit fails that comparison, and the primary and a retry are unaffected', async () => {
    const t = await setup();
    try {
      await t.compare('4HHB');
      const heartbeat = await t.beat();
      const before = await primaryFacts(t);
      const flipped = async (name: string, args: any) => {
        const answer = await t.pageCall(name, args);
        const chunk = answer._meta[KEY];
        const bytes = Buffer.from(chunk.data, 'base64'); bytes[0] ^= 0xff; chunk.data = bytes.toString('base64');
        return answer;
      };
      const source = structuredClone(heartbeat.comparisonSources[0]);
      await expect(hydrateComparisonSource(source, flipped, t.sessionId)).rejects.toThrow(/changed during delivery/);
      // A failed assembly publishes nothing: the entry is still descriptors.
      expect(source.cif).toBeUndefined();
      expect(source.sourceBytes).toBeTruthy();
      expect(await primaryFacts(t)).toEqual(before);

      const retry = structuredClone(heartbeat.comparisonSources[0]);
      await hydrateComparisonSource(retry, t.pageCall, t.sessionId);
      expect(retry.cif).toBe(hhb);
    } finally { await t.close(); }
  });

  it('describes no asset whose coordinates or compressed catalog the transport would refuse', () => {
    const asset = { source: { kind: 'pdb', id: '9BIG' }, sources: [], id: '9BIG', cif: OVER_POLICY, sha256: sha256(OVER_POLICY),
      catalog: { assemblyId: 'asymmetric_unit' } } as any;
    expect(() => comparisonDescriptor(asset)).toThrow(/over the 64 MiB this plugin accepts/);
  });

  it('refuses descriptors that disagree with each other before requesting a byte', async () => {
    const t = await setup();
    try {
      await t.compare('4HHB');
      const { comparisonSources: [source] } = await t.beat();
      const never = async () => { throw Error('no chunk should be requested'); };
      const tampered = (change: (entry: any) => void) => { const entry = structuredClone(source); change(entry); return entry; };
      for (const entry of [
        tampered(value => { value.catalogWire.sourceSha256 = 'f'.repeat(64); }),
        tampered(value => { value.sha256 = 'f'.repeat(64); }),
        tampered(value => { value.sourceBytes.bytes = MAX_STRUCTURE_SOURCE_BYTES + 1; }),
        tampered(value => { delete value.catalogBytes; }),
        tampered(value => { value.cif = hhb; }),
        tampered(value => { value.assemblyId = ''; }),
      ]) await expect(hydrateComparisonSource(entry, never, t.sessionId)).rejects.toThrow();
    } finally { await t.close(); }
  });
});
