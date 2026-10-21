import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalSceneService } from '../src/scene-service.js';
import { createStereoStructureServer } from '../src/server.js';
import { parseMolecularLesson } from '../src/molecular-lesson.js';
import { createPreparedCompositeStore } from '../src/prepared-composite.js';
import { compositeSha256 } from '../src/demo-rigid-composite.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { inverse, syntheticCrambin } from './fixtures/superposition.js';
import { PRIVATE_INSPECTION_META_KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';

const texts: Record<string, string> = Object.fromEntries(await Promise.all(['1CRN', '4HHB'].map(async id =>
  [id, await readFile(new URL(`../../fixtures/${id}.cif`, import.meta.url), 'utf8')])));
texts['9CRN'] = await syntheticCrambin();
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network is forbidden in composite tests'); })));
afterEach(() => vi.unstubAllGlobals());
const recipe = () => ({ version: 1 as const, id: 'two-sources', title: 'Crambin and hemoglobin',
  sources: [{ id: '1CRN' }, { id: '4HHB' }],
  bodies: [
    { source: '1CRN', authChains: ['A'], atoms: 'all' as const, chain: 'C', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
    { source: '4HHB', authChains: ['A', 'B'], atoms: 'backbone' as const, residues: { from: 1, to: 20 }, ligands: ['HEM'],
      chain: 'H', matrix: [[1, 0, 0, 50], [0, 1, 0, 0], [0, 0, 1, 0]] },
  ],
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'stereofold-prepare-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function setup(factory = createStereoStructureServer, extra: any = {}) {
  const dir = await directory(), cachePath = (file: string) => join(dir, file);
  const fetchPdbText = vi.fn(async (id: string) => { if (!texts[id]) throw Error(`Unexpected source ${id}`); return texts[id]; });
  const server = factory(undefined, { fetchPdbText, compositeCachePath: cachePath, sceneServiceFile: join(dir, 'scene.json'), ...extra });
  const client = new Client({ name: 'composite-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  return { call, client, cachePath, fetchPdbText };
}
const textOf = (reply: any) => reply.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
// Deliberately consumes only the text content of prepare_composite.
const identityFromText = (reply: any) => JSON.parse(textOf(reply).split('\n').find((line: string) => line.startsWith('{'))!);
async function catalog(t: Awaited<ReturnType<typeof setup>>, sessionId: string) {
  const data = (await t.call('get_inspection', { sessionId }))._meta[PRIVATE_INSPECTION_META_KEY];
  return { data, catalog: data.catalog ?? await decodeInspectionCatalog(data.catalogWire) };
}
async function saveAndAttach(t: Awaited<ReturnType<typeof setup>>, sessionId: string, surface: 'desktop' | 'companion' = 'desktop') {
  const { data, catalog: c } = await catalog(t, sessionId);
  const binding = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  const scene = { sourceSha256: c.source.sha256, modelNumber: c.modelNumbers[0], assemblyId: c.assemblyId, selectionKeys: [],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
      opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  const saved = await t.call('sync_inspection', { ...binding, scene });
  expect(saved.isError, textOf(saved)).not.toBe(true);
  const attached = await t.call('attach_inspection', { ...binding,
    baseStateRevision: saved.structuredContent.stateRevision, baseInspectionRevision: saved.structuredContent.inspectionRevision, surface });
  expect(attached.isError, textOf(attached)).not.toBe(true);
}
function lesson(digest: string) {
  return { version: 1, id: 'composite-tour', title: 'Composite tour', mode: 'guided',
    provenance: { sourceSha256: digest, sourceRefs: [{ kind: 'public', ref: 'https://www.rcsb.org/structure/1CRN' }] },
    chapters: [{ id: 'overview', title: 'Overview', caption: 'Two deposited structures in rigid poses.', durationSeconds: 2,
      changes: [{ kind: 'hold', durationSeconds: 2 }], immersive: { appearance: { representation: 'cartoon', color: 'chain-id' } } }] };
}

const superposeRecipe = () => ({ version: 1, id: 'homologues', title: 'Sequence-aligned bodies',
  sources: [{ id: '1CRN' }, { id: '9CRN' }], bodies: [
    { id: 'reference', source: '1CRN', authChains: ['A'], atoms: 'all', chain: 'F', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
    { source: '9CRN', authChains: ['A'], atoms: 'all', chain: 'M', place: { superpose: { onto: 'reference' } } },
    { source: '9CRN', authChains: ['A'], atoms: 'all', chain: 'L', place: { superpose: { onto: 1 }, then: { translate: [0, 0, 7] } } },
  ],
});
async function checkSuperpositionFlow(t: Awaited<ReturnType<typeof setup>>) {
  const reply = await t.call('prepare_composite', { recipe: superposeRecipe() });
  expect(reply.isError, textOf(reply)).not.toBe(true);
  const value = identityFromText(reply);
  const state = JSON.parse(textOf(reply).match(/```json\n(.*?)\n```/s)![1]);
  expect(state.truncated).toBe(false);
  expect(state.source).toEqual(value.source);
  expect(state.bodies).toEqual(value.bodies);
  expect(state.bodies[1].superposition).toMatchObject({ pairedAtomCount: 46, coverage: { mobile: 1, fixed: 1 } });
  expect(state.bodies[1].superposition.rmsd).toBeLessThan(1e-5);
  expect(state.bodies[1].superposition.sequenceIdentity).toBeCloseTo(37 / 46, 8);
  state.bodies[1].matrix.forEach((row: number[], i: number) => row.forEach((v, j) => expect(v).toBeCloseTo(inverse[i][j], 3)));
  expect(state.bodies[2].matrix[2][3]).toBeCloseTo(-23, 3);
  const opened = await t.call('inspect', { source: value.source });
  expect(opened.isError, textOf(opened)).not.toBe(true);
  expect((await catalog(t, opened.structuredContent.sessionId)).catalog.source.sha256).toBe(value.sha256);
  // Reported matrices can be copied directly into a subsequent recipe.
  const reused: any = superposeRecipe();
  reused.bodies.forEach((body: any, i: number) => { body.matrix = value.bodies[i].matrix; delete body.place; });
  expect(identityFromText(await t.call('prepare_composite', { recipe: reused })).sha256).toBe(value.sha256);
}

describe('prepare_composite public MCP workflow', () => {
  it('returns reusable fits in text-only state and opens a three-body tree', async () => {
    await checkSuperpositionFlow(await setup());
  });
  it('builds two sources, reports exact identities without coordinates, and opens from text-only results', async () => {
    const t = await setup();
    const prepared = await t.call('prepare_composite', { recipe: recipe() });
    expect(prepared.isError, textOf(prepared)).not.toBe(true);
    const identity = identityFromText(prepared);
    expect(identity).toMatchObject(prepared.structuredContent);
    expect(identity.bodies.map((b: any) => b.chain)).toEqual(['C', 'H']);
    expect(identity.bodies[0].atomSites).toBe(327);
    expect(identity.bodies[1].labelChains).toEqual(['H', 'H_1', 'H_2', 'H_3']);
    expect(identity.bodies[1].labelChainMapping).toHaveLength(4);
    expect(identity.atomSites).toBe(identity.bodies.reduce((sum: number, b: any) => sum + b.atomSites, 0));
    expect(identity.sources).toEqual(['1CRN', '4HHB'].map(id => ({ id, sha256: compositeSha256(texts[id]) })));
    expect(JSON.stringify(prepared)).not.toMatch(/Cartn_x|structureText|data_two|ATOM\s/);
    const bytes = await readFile(t.cachePath(`composites/${identity.sha256}.cif`), 'utf8');
    expect(Buffer.byteLength(bytes)).toBe(identity.bytes);
    expect(compositeSha256(bytes)).toBe(identity.sha256);
    const opened = await t.call('inspect', { source: identity.source });
    expect(opened.isError, textOf(opened)).not.toBe(true);
    const sessionId = textOf(opened).match(/sessionId ([a-f0-9-]+)/)![1];
    const { catalog: c } = await catalog(t, sessionId);
    expect(c.source.sha256).toBe(identity.sha256);
    expect(c.rows.reduce((sum: number, r: any) => sum + r.atomSites.length, 0)).toBe(identity.atomSites);
    expect(opened.structuredContent).toMatchObject({ sourceKind: 'composite', hasScene: false });
    expect(t.fetchPdbText).toHaveBeenCalledTimes(2);
    const reused = identityFromText(await t.call('prepare_composite', { recipe: recipe() }));
    expect(reused.sha256).toBe(identity.sha256);
    expect(t.fetchPdbText).toHaveBeenCalledTimes(2);
  });

  it('replaces a saved source using normal admission and keeps render status pending', async () => {
    const t = await setup();
    const identity = identityFromText(await t.call('prepare_composite', { recipe: recipe() }));
    const opened = await t.call('inspect', { pdbId: '1CRN' }), sessionId = opened.structuredContent.sessionId;
    const refused = await t.call('replace_inspection_source', { sessionId, source: identity.source });
    expect(refused.isError).toBe(true);
    await saveAndAttach(t, sessionId);
    const replaced = await t.call('replace_inspection_source', { sessionId, source: identity.source });
    expect(replaced.isError, textOf(replaced)).not.toBe(true);
    expect(replaced.structuredContent).toMatchObject({ sessionId, sourceKind: 'composite' });
    expect(replaced.structuredContent.sourceToken).not.toBe(opened.structuredContent.sourceToken);
    expect(replaced.structuredContent.sourceRenderStatus?.rendered).not.toBe(true);
    expect((await catalog(t, sessionId)).catalog.source.sha256).toBe(identity.sha256);
  });

  it('opens an inline lesson with the handle and verifies exact provenance before opening', async () => {
    const t = await setup();
    const identity = identityFromText(await t.call('prepare_composite', { recipe: recipe() }));
    const opened = await t.call('inspect_lesson', { source: identity.source, lesson: lesson(identity.sha256) });
    expect(opened.isError, textOf(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({ customTourId: 'lesson-composite-tour', sourceKind: 'composite', atomSites: identity.atomSites, hasScene: false });
    const bad = await t.call('inspect_lesson', { source: identity.source, lesson: lesson('0'.repeat(64)) });
    expect(bad.isError).toBe(true); expect(textOf(bad)).toMatch(/sourceSha256: does not match/);
    const oversized: any = lesson(identity.sha256);
    oversized.chapters[0].animation = { version: 1, durationSeconds: 600,
      tracks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, chains: [`X${i}`],
        keyframes: Array.from({ length: 512 }, (_, t) => ({ t, rotation: [0, 0, 0, 1], translation: [1, 2, 3] })) })) };
    const tooBig = await t.call('inspect_lesson', { source: identity.source, lesson: oversized });
    expect(tooBig.isError).toBe(true); expect(textOf(tooBig)).toMatch(/262144/);
  });

  it.each([
    ['missing placement', (r: any) => delete r.bodies[0].matrix, /exactly one/],
    ['both placements', (r: any) => r.bodies[1].place = { superpose: { onto: 0 } }, /exactly one/],
    ['cycle', (r: any) => { delete r.bodies[1].matrix; r.bodies[1].place = { superpose: { onto: 1 } }; }, /cycle/],
    ['unknown body', (r: any) => { delete r.bodies[1].matrix; r.bodies[1].place = { superpose: { onto: 'absent' } }; }, /Unknown superposition body/],
    ['matrix rows', (r: any) => r.bodies[0].matrix.pop(), /matrix/],
    ['matrix columns', (r: any) => r.bodies[0].matrix[0].pop(), /matrix/],
    ['empty sources', (r: any) => r.sources = [], /sources/],
    ['empty bodies', (r: any) => r.bodies = [], /bodies/],
    ['empty chains', (r: any) => r.bodies[0].authChains = [], /authChains/],
    ['matrix', (r: any) => r.bodies[0].matrix[0][0] = 2, /matrix/],
    ['source reference', (r: any) => r.bodies[1].source = '2DN2', /source/],
    ['duplicate output chain', (r: any) => r.bodies[1].chain = 'C', /chain/],
    ['duplicate source id', (r: any) => r.sources.push({ id: '1crn' }), /sources/],
    ['residue range', (r: any) => r.bodies[0].residues = { from: 5, to: 1 }, /residues/],
    ['ligands', (r: any) => r.bodies[0].ligands = ['HEM', 'HEM'], /ligands/],
    ['source URL', (r: any) => r.sources[0].url = 'https://elsewhere.invalid', /url/],
  ])('returns field-level %s errors before any fetch', async (_, edit, field) => {
    const t = await setup(), r = recipe(); edit(r);
    const result = await t.call('prepare_composite', { recipe: r });
    expect(result.isError).toBe(true); expect(textOf(result)).toMatch(field);
    expect(t.fetchPdbText).not.toHaveBeenCalled();
  });

  it('refuses empty selections, digest mismatches, invalid handles and caller atom budgets', async () => {
    const t = await setup(), r = recipe(); r.bodies[0].authChains = ['missing'];
    const selection = await t.call('prepare_composite', { recipe: r });
    expect(selection.isError).toBe(true); expect(textOf(selection)).toMatch(/recipe.bodies\[0\].*matches no atoms/);
    const pinned = recipe(); Object.assign(pinned.sources[0], { sha256: '0'.repeat(64) });
    const mismatch = await t.call('prepare_composite', { recipe: pinned });
    expect(mismatch.isError).toBe(true); expect(textOf(mismatch)).toMatch(/recipe.sources\[0\].*sha256 mismatch/);
    const budget = await t.call('prepare_composite', { recipe: recipe(), maximumAtomSites: 327 });
    expect(budget.isError).toBe(true); expect(textOf(budget)).toMatch(/bodies\[1\].*maximumAtomSites/);
    await expect(readdir(t.cachePath('composites'))).rejects.toThrow();
    const unknown = await t.call('inspect', { source: { kind: 'composite', handle: randomUUID() } });
    expect(unknown.isError).toBe(true); expect(textOf(unknown)).toMatch(/Unknown or expired/);
    const traversal = await t.call('inspect', { source: { kind: 'composite', handle: '../bad' } });
    expect(traversal.isError).toBe(true);
  });
});

describe('verified composite cache and limits', () => {
  it('reuses immutable bytes and prior handles while a different recipe shares the cache', async () => {
    const dir = await directory(), cachePath = (file: string) => join(dir, file);
    const options = { cachePath, fetchPdbText: async (id: string) => texts[id] };
    const store = createPreparedCompositeStore(options), input = { recipe: recipe() } as any;
    const first = await store.prepare(input);
    const path = cachePath(`composites/${first.sha256}.cif`), before = await stat(path);
    const repeat = await createPreparedCompositeStore(options).prepare(input);
    expect(repeat.source.handle).not.toBe(first.source.handle);
    expect(repeat.sha256).toBe(first.sha256);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    input.recipe.bodies[0].chain = 'DIFFERENT';
    const second = await createPreparedCompositeStore(options).prepare(input);
    expect(second.sha256).not.toBe(first.sha256);
    const cold = createPreparedCompositeStore(options);
    for (const prepared of [first, repeat, second]) {
      expect(compositeSha256(await cold.resolve(prepared.source.handle))).toBe(prepared.sha256);
    }
  });

  it('reuses pinned demo cache sources, survives store restart and rejects altered artifact bytes', async () => {
    const dir = await directory(), cachePath = (file: string) => join(dir, file);
    const fetchPdbText = vi.fn(async (id: string) => texts[id]);
    const store = createPreparedCompositeStore({ cachePath, fetchPdbText });
    const input = { recipe: recipe() } as any;
    const first = await store.prepare(input);
    const cold = createPreparedCompositeStore({ cachePath, fetchPdbText });
    expect(compositeSha256(await cold.resolve(first.source.handle))).toBe(first.sha256);
    input.recipe.sources = input.recipe.sources.map((s: any) => ({ ...s, sha256: compositeSha256(texts[s.id]) }));
    expect((await cold.prepare(input)).sha256).toBe(first.sha256);
    expect(fetchPdbText).toHaveBeenCalledTimes(2);
    await writeFile(cachePath(`composite-sources/${compositeSha256(texts['1CRN'])}-1CRN.cif`), 'corrupt');
    await cold.prepare(input); expect(fetchPdbText).toHaveBeenCalledTimes(3);
    await writeFile(cachePath(`composites/${first.sha256}.cif`), texts['1CRN']);
    await expect(cold.resolve(first.source.handle)).rejects.toThrow(/digest verification/);
    const rebuilt = await cold.prepare(input);
    expect(compositeSha256(await cold.resolve(rebuilt.source.handle))).toBe(first.sha256);
  });

  it('refuses oversized source downloads before body transfer and artifact publication', async () => {
    const dir = await directory();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('not read', { headers: { 'content-length': String(MAX_STRUCTURE_SOURCE_BYTES + 1) } }));
    const store = createPreparedCompositeStore({ cachePath: file => join(dir, file), fetch });
    await expect(store.prepare({ recipe: recipe() } as any)).rejects.toThrow(/recipe.sources\[0\].*64 MiB/);
    expect(fetch).toHaveBeenCalledOnce(); expect(await readdir(dir)).toEqual([]);
  });
});

// Import only the distributable in an isolated tree: no src/, scripts/ or
// workspace packages are available beside it. MCP clients still use the SDK.
it('runs prepare → inspect → replace → inline lesson from the shipped bare-Node bundle', async () => {
  const dir = await directory();
  await cp(new URL('../dist/', import.meta.url), join(dir, 'dist'), { recursive: true });
  await cp(new URL('../demos/', import.meta.url), join(dir, 'demos'), { recursive: true });
  expect((await readdir(dir)).sort()).toEqual(['demos', 'dist']);
  const runtime = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'dist/server.mjs')).href);
  const t = await setup(runtime.createStereoStructureServer);
  await checkSuperpositionFlow(t);
  const reply = await t.call('prepare_composite', { recipe: recipe() });
  expect(reply.isError, textOf(reply)).not.toBe(true);
  const identity = identityFromText(reply);
  const opened = await t.call('inspect', { source: identity.source });
  expect(opened.isError, textOf(opened)).not.toBe(true);
  const sessionId = textOf(opened).match(/sessionId ([a-f0-9-]+)/)![1];
  const existing = await t.call('inspect', { pdbId: '1CRN' });
  await saveAndAttach(t, existing.structuredContent.sessionId);
  const replaced = await t.call('replace_inspection_source', { sessionId: existing.structuredContent.sessionId, source: identity.source });
  expect(replaced.isError, textOf(replaced)).not.toBe(true);
  const taught = await t.call('inspect_lesson', { source: identity.source, lesson: lesson(identity.sha256) });
  expect(taught.isError, textOf(taught)).not.toBe(true);
  expect(taught.structuredContent.customTourId).toBe('lesson-composite-tour');
  expect((await t.call('get_inspection_state', { sessionId })).structuredContent.hasScene).toBe(false);
  expect((await catalog(t, sessionId)).catalog.source.sha256).toBe(identity.sha256);
});

it('attached connector prepares and consumes handles on the owner with isolated caches',async()=>{
  const dir=await directory(),file=join(dir,'owner.json');
  const ownerService=new LocalSceneService({file});
  const owner=await setup(createStereoStructureServer,{sceneService:ownerService});
  const opened=await owner.call('inspect',{pdbId:'1CRN'}),sessionId=opened.structuredContent.sessionId;
  await saveAndAttach(owner,sessionId,'companion');
  // Real attachment and forwarding; only the forbidden socket transport is replaced.
  await writeFile(file,JSON.stringify({version:1,origin:'http://127.0.0.1:12345',token:'a'.repeat(64),
    sceneId:randomUUID(),pid:process.pid,uid:process.getuid?.(),startedAt:new Date().toISOString()}),{mode:0o600});
  const transport=vi.fn(async(url:any,init:any)=>{
    if(String(url).endsWith('/alive')) return new Response(null,{status:204});
    const request=JSON.parse(init.body);
    const value=request.name==='scene.describe'?{sessionId}:await ownerService.dispatch(request.name,request.arguments);
    return Response.json({result:value});
  });
  const connectorService=new LocalSceneService({file,fetch:transport as any});
  const blocked=vi.fn(async()=>{throw Error('Connector cannot fetch RCSB');});
  const connector=await setup(createStereoStructureServer,{sceneService:connectorService,fetchPdbText:blocked});
  const joined=await connector.call('continue_session',{assistant:'Claude'});
  expect(joined.structuredContent.role).toBe('attached');
  const state=await connector.call('get_inspection_state',{sessionId});
  for (const reply of [joined,state]) {
    expect(reply.content[0].text).toMatch(/^For a bundled demo in a joined session use one call: replace_inspection_source/);
    expect(reply.content[0].text).toMatch(/When a headset session is joined, make any new scene or lesson there: prepare_composite.* -> replace_inspection_source with the joined sessionId -> install_lesson/);
    expect(reply.structuredContent.authoringRoute).toContain('do not ask a handoff question');
    expect(reply.structuredContent.voiceDelivery).toMatchObject({mode:'none',acknowledgement:'unavailable'});
  }
  expect(textOf(joined)).toContain('Claude owns the assistant floor');
  expect(textOf(joined)).toContain('No consumer is reading wearer speech yet, so spoken requests are not delivered.');
  expect(textOf(joined)).not.toContain('is listening');
  const prepared=await connector.call('prepare_composite',{recipe:recipe()});
  expect(prepared.isError,textOf(prepared)).not.toBe(true);
  const identity=identityFromText(prepared);
  const replaced=await connector.call('replace_inspection_source',{sessionId,source:identity.source});
  expect(replaced.isError,textOf(replaced)).not.toBe(true);
  expect((await catalog(owner,sessionId)).catalog.source.sha256).toBe(identity.sha256);
  const fresh=await connector.call('inspect',{source:identity.source});
  expect(fresh.isError,textOf(fresh)).not.toBe(true);
  expect((await catalog(owner,fresh.structuredContent.sessionId)).catalog.source.sha256).toBe(identity.sha256);
  expect((await connector.call('get_inspection_state',{sessionId:fresh.structuredContent.sessionId})).isError).not.toBe(true);
  expect((await ownerService.dispatch('scene.describe',{}) as any).sessionId).toBe(fresh.structuredContent.sessionId);
  expect(blocked).not.toHaveBeenCalled();
  expect(owner.fetchPdbText).toHaveBeenCalled();
  await expect(readdir(connector.cachePath('composites'))).rejects.toThrow();
});

it('accepts a long hold through the published schema but refuses it with one bounded server diagnostic', async () => {
  const t = await setup();
  const { tools } = await t.client.listTools();
  const invalid = lesson('a'.repeat(64));
  invalid.chapters[0].durationSeconds = 24;
  invalid.chapters[0].changes[0].durationSeconds = 24;
  for (const name of ['install_lesson', 'inspect_lesson']) {
    const schema = tools.find(tool => tool.name === `stereo_structure.${name}`)!.inputSchema as any;
    const hold = schema.properties.lesson.properties.chapters.items.properties.changes.items.oneOf.find((branch: any) => branch.properties.kind.const === 'hold');
    expect(hold.properties.durationSeconds.maximum).toBeUndefined();
    const reply = await t.call(name, name === 'install_lesson'
      ? {sessionId:randomUUID(), lesson:invalid} : {source:{kind:'pdb',id:'1CRN'}, lesson:invalid});
    expect(reply.isError).toBe(true);
    const text = textOf(reply);
    expect(text.length).toBeLessThan(512);
    expect(text.match(/"message"/g)).toHaveLength(1);
    expect(text).toMatch(/durationSeconds/);
    expect(text).toContain('20 seconds per hold');
    expect(text).toContain('split the hold');
    expect(text).not.toContain('invalid_union');
    expect(reply.structuredContent?.commandId).toBeUndefined();
  }
  expect(() => parseMolecularLesson(invalid)).toThrow(/chapters.0.changes.0.durationSeconds.*split the hold/);
  invalid.chapters[0].changes = [{kind:'hold',durationSeconds:20}, {kind:'hold',durationSeconds:4}];
  expect(parseMolecularLesson(invalid).chapters[0].changes).toEqual(invalid.chapters[0].changes);
});
