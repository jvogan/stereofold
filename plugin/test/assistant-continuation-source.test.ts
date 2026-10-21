import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';

const tour = { selectedId: 'local-crambin', step: 1, total: 2, active: true,
  autoplay: false, narration: false, navigating: false };
const ok = (answer: any) => { expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true); return answer; };
const textState = (answer: any) => JSON.parse(answer.content.find((item: any) => item.type === 'text' && item.text.startsWith('```json\n{"textStateVersion":1')).text.slice(8, -4));

async function setup(opening: 'inspect_lesson' | 'inspect_file' | 'inspect' = 'inspect_lesson') {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-continuation-source-'));
  const hosts: Array<{ client: Client; server: ReturnType<typeof createStereoStructureServer> }> = [];
  const connect = async (name: string) => {
    const server = createStereoStructureServer(undefined, { sceneServiceFile: join(root, 'scene.json'), loopbackListenDenied: async () => false });
    const client = new Client({ name, version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
    hosts.push({ client, server });
    await server.connect(b); await client.connect(a);
    return (name: string, args: Record<string, unknown> = {}) => client.callTool({ name: 'stereo_structure.' + name, arguments: args }) as Promise<any>;
  };
  const close = async () => { for (const { client, server } of hosts.reverse()) { await client.close(); await server.close(); }
    await rm(root, { recursive: true, force: true }); };
  try {
  const owner = await connect('Claude');
  const crnPath = join(root, 'custom-crambin.cif'), hhbPath = join(root, 'custom-hemoglobin.cif');
  await writeFile(crnPath, await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url)));
  await writeFile(hhbPath, await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url)));
  const lesson = { version: 1, id: 'local-crambin', title: 'Custom crambin', mode: 'explore',
    provenance: { sourceRefs: [{ kind: 'local', ref: crnPath }] }, chapters: [0, 1].map(i => ({ id: `chapter-${i}`, title: `Chapter ${i}`,
      caption: `Custom chapter ${i}.`, durationSeconds: 10, changes: [{ kind: 'rotate', durationSeconds: 10, degrees: 10 }],
      immersive: { emphasis: { parts: [{ id: 'chain-a', label: 'Chain A', color: '#ffaa33', chain: 'A' }], contextOpacity: .18 } } })) };
  const opened = ok(await owner(opening, opening === 'inspect_lesson' ? { filePath: crnPath, lesson }
    : opening === 'inspect_file' ? { filePath: crnPath } : { source: { kind: 'file', path: crnPath } }));
  const sessionId = opened.structuredContent.sessionId;
  const read = async () => {
    const data = ok(await owner('get_inspection', { sessionId }))._meta[KEY];
    return { data, catalog: data.catalog ?? await decodeInspectionCatalog(data.catalogWire) };
  };
  const initial = await read();
  const binding: any = { sessionId, serverEpoch: initial.data.serverEpoch, sourceToken: initial.data.sourceToken,
    baseStateRevision: initial.data.stateRevision, baseInspectionRevision: initial.data.inspectionRevision };
  const save = async (catalog: any) => {
    const scene = { sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId,
      selectionKeys: [catalog.rows[0].key], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0],
        up: [0, 1, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
    const saved = ok(await owner('sync_inspection', { ...binding, scene })).structuredContent;
    Object.assign(binding, { baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision });
  };
  await save(initial.catalog);
  const desktop = ok(await owner('attach_inspection', { ...binding, surface: 'desktop' })).structuredContent.panelId;
  ok(await owner('poll_inspection', { ...binding, panelId: desktop, availability: 'ready', tourState: tour }));
  ok(await owner('continue_session', { assistant: 'Claude' }));
  const attached = await connect('Codex');
  const rejoin = async () => ok(await attached('continue_session', { assistant: 'Codex' })).structuredContent;
  return { owner, attached, binding, desktop, read, save, join: rejoin, hhbPath, crnPath, root, opened, close };
  } catch (error) { await close(); throw error; }
}

it('does not present a stale old-source chapter as the current tour to a joining assistant', async () => {
  const t = await setup();
  try {
    expect((await t.join()).scene.tour).toEqual(tour);
    const oldSource = t.binding.sourceToken;
    ok(await t.attached('replace_inspection_source', { ...t.binding, panelId: t.desktop, commandId: 'join-source-swap',
      source: { kind: 'file', path: t.hhbPath }, waitForRenderMs: 0 }));
    const next = await t.read();
    Object.assign(t.binding, { sourceToken: next.data.sourceToken, baseStateRevision: next.data.stateRevision,
      baseInspectionRevision: next.data.inspectionRevision });
    expect(t.binding.sourceToken).not.toBe(oldSource);
    await t.save(next.catalog);
    const state = ok(await t.owner('get_inspection_state', { sessionId: t.binding.sessionId })).structuredContent;
    expect(state.panels).toContainEqual(expect.objectContaining({ panelId: t.desktop, current: false, tour }));
    const joined = await t.join();
    expect(joined).toMatchObject({ role: 'attached', sessionId: t.binding.sessionId,
      scene: { sourceToken: t.binding.sourceToken, hasScene: true, selectedResidueCount: 1, lesson: null } });
    expect(joined.scene.tour, 'The new-source continuation must not claim an old-source chapter').toBeNull();
    const current = ok(await t.owner('attach_inspection', { ...t.binding, surface: 'desktop', replacesPanelId: t.desktop })).structuredContent.panelId;
    const nextTour = { ...tour, selectedId: 'residue-tour', step: -1, total: 0, active: false };
    ok(await t.owner('poll_inspection', { ...t.binding, panelId: current, availability: 'ready', tourState: nextTour }));
    expect((await t.join()).scene.tour).toEqual(nextTour);
  } finally { await t.close(); }
});

it('withholds a same-source stale tour until its panel reports the current saved revision', async () => {
  const t = await setup();
  try {
    const before = await t.read();
    const scene = structuredClone(before.data.scene);
    scene.inspection.appearance.opacity = .7;
    const saved = ok(await t.owner('sync_inspection', { ...t.binding, scene })).structuredContent;
    t.binding.baseInspectionRevision = saved.inspectionRevision;
    const joined = await t.join();
    expect(joined.scene.sourceToken).toBe(before.data.sourceToken);
    expect(joined.scene.appearance.opacity).toBe(.7);
    expect(joined.scene.tour).toBeNull();
    ok(await t.owner('poll_inspection', { ...t.binding, panelId: t.desktop, availability: 'ready', tourState: tour }));
    expect((await t.join()).scene.tour).toEqual(tour);
  } finally { await t.close(); }
});

it.each(['inspect_file', 'inspect'] as const)('%s preserves safe local provenance through two-host reads, replacement and continuation', async opening => {
  const t = await setup(opening);
  try {
    const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    const first = { kind: 'file', fileName: 'custom-crambin.cif', sha256: sha(await readFile(t.crnPath, 'utf8')) };
    expect(t.opened.structuredContent.sourceProvenance).toEqual(first);
    expect(textState(t.opened).sourceProvenance).toEqual(first);
    expect((await t.join()).scene.sourceProvenance).toEqual(first);
    const read = ok(await t.attached('get_inspection_state', { sessionId: t.binding.sessionId }));
    expect(read.structuredContent.sourceProvenance).toEqual(first);
    expect(textState(read).sourceProvenance).toEqual(first);
    expect(JSON.stringify(read.structuredContent)).not.toContain(t.root);
    expect(JSON.stringify(read.content)).not.toContain(t.root);
    expect(read.structuredContent.pdbId).toBeUndefined();

    // The filename is a label, never an identity: the same name may now hold
    // different user-supplied coordinates, and the bytes must win.
    const hhb = await readFile(t.hhbPath, 'utf8');
    await writeFile(t.crnPath, hhb);
    const replaced = ok(await t.attached('replace_inspection_source', { ...t.binding, panelId: t.desktop,
      commandId: 'same-name-new-bytes', source: { kind: 'file', path: t.crnPath }, waitForRenderMs: 0 }));
    const second = { ...first, sha256: sha(hhb) };
    expect(second.sha256).not.toBe(first.sha256);
    expect(replaced.structuredContent.sourceProvenance).toEqual(second);
    const next = await t.read();
    Object.assign(t.binding, { sourceToken: next.data.sourceToken, baseStateRevision: next.data.stateRevision, baseInspectionRevision: next.data.inspectionRevision });
    await t.save(next.catalog);
    const joined = ok(await t.attached('continue_session', { assistant: 'Codex' }));
    expect(joined.structuredContent.scene.sourceProvenance).toEqual(second);
    expect(textState(joined).scene.sourceProvenance).toEqual(second);
    expect(JSON.stringify(joined.content)).not.toContain(t.root);
    const current = ok(await t.owner('attach_inspection', { ...t.binding, surface: 'desktop', replacesPanelId: t.desktop })).structuredContent.panelId;
    ok(await t.owner('replace_inspection_source', { ...t.binding, panelId: current, commandId: 'same-bytes-pasted',
      source: { kind: 'pasted', text: hhb, format: 'mmcif' }, waitForRenderMs: 0 }));
    const pasted = await t.join();
    expect(pasted.scene.sourceProvenance).toEqual({ kind: 'pasted', sha256: sha(hhb) });
  } finally { await t.close(); }
});
