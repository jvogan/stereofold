import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const fixture = vi.hoisted(() => ({ index: {} as any, path: '' }));
vi.mock('../src/molecular-growth.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/molecular-growth.js')>(),
  readGrowthIndex: async () => fixture.index,
}));
vi.mock('../src/growth-coordinates.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/growth-coordinates.js')>(),
  ensureGrowthCoordinates: async () => ({ path: fixture.path, fetched: false, fetchedAt: null }),
}));

it('grows a lesson with the existing renderer owner and acknowledges its first saved frame', async () => {
  // Only the demo index/download are fixtures; source commit, hydration,
  // panel ownership, saving and the rendered receipt use the real host.
  const dir = await mkdtemp(join(tmpdir(), 'growth-source-handoff-'));
  const source = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
  const target = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
  fixture.path = join(dir, 'target.cif');
  await writeFile(fixture.path, target);
  const catalog: any = await extractInspectionCatalogBytes(target);
  const lesson = (id: string) => ({ version: 1, id: `handoff-${id}`, title: id, mode: 'explore',
    provenance: { sourceRefs: [{ kind: 'public', ref: 'https://www.rcsb.org/structure/4HHB' }] },
    chapters: [{ id: 'first', title: id, caption: 'The next structure.', durationSeconds: 10,
      changes: [{ kind: 'hold', durationSeconds: 10 }], immersive: { motion: 'hold', figure: { layers: [{ id: 'body', target: { chain: 'A' }, representation: 'cartoon', color: '#ff8800' }] } } }] });
  const lessonPath = join(dir, 'dimer.json');
  await writeFile(lessonPath, JSON.stringify(lesson('dimer')));
  fixture.index = { demos: [{ name: 'handoff', stages: ['monomer', 'dimer'].map(id => ({ id, title: id,
    tiers: ['quest2', 'quest3'], lesson: lessonPath, coordinates: { file: 'target.cif', download: 'https://files.rcsb.org/download/4HHB.cif',
      sha256: createHash('sha256').update(target).digest('hex'),
      atomSites: catalog.rows.reduce((sum: number, row: any) => sum + row.atomSites.length, 0) } })) }] };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { sceneServiceFile: join(dir, 'scene-service.json') });
  const client = new Client({ name: 'growth handoff test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: any): Promise<any> => {
    const result = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  try {
    const opened = await call('inspect_lesson', { source: { kind: 'pasted', text: source }, lesson: lesson('monomer') });
    const sessionId = opened.structuredContent.sessionId;
    const bind = (data: any) => ({ sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision });
    const capture = async (data: any) => {
      const cat = data.catalog ?? await decodeInspectionCatalog(data.catalogWire);
      return { sourceSha256: cat.source.sha256, modelNumber: cat.modelNumbers[0], assemblyId: cat.assemblyId,
        selectionKeys: [], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80],
          target: [0, 0, 0], up: [0, 1, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9',
          background: '#071015', opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
    };
    const before = (await call('get_inspection', { sessionId }))._meta[KEY];
    const saved = (await call('sync_inspection', { ...bind(before), scene: await capture(before) })).structuredContent;
    const panelId = (await call('attach_inspection', { ...bind(saved), surface: 'companion' })).structuredContent.panelId;
    await call('poll_inspection', { ...bind(saved), panelId, availability: 'ready' });
    await call('grow_structure', { ...bind(saved), panelId, stage: 'dimer', device: 'quest2' });
    const next = (await call('get_inspection', { sessionId }))._meta[KEY];
    expect(next.sourceReplacement).toEqual({ panelId, previousSourceToken: before.sourceToken });
    expect(next.customTour.id).toBe('lesson-handoff-dimer');
    const drawn = (await call('sync_inspection', { ...bind(next), scene: await capture(next) })).structuredContent;
    const attached = (await call('attach_inspection', { ...bind(drawn), surface: 'companion', replacesPanelId: panelId })).structuredContent;
    expect(attached.panelId).toBe(panelId);
    const state = (await call('get_inspection_state', { sessionId })).structuredContent;
    expect(state.sourceRenderReceipt).toMatchObject({ status: 'rendered', panelId, sourceToken: next.sourceToken });
  } finally { await client.close(); await server.close(); }
}, 30_000);
