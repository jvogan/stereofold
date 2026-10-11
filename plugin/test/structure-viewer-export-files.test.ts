import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { readNativeStructureViewerExports } from '../src/structure-viewer-export-files.js';

const source = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-exports-')); roots.push(root);
  const scenePath = join(root, 'scene.json'), coordinatePath = join(root, 'coordinates.cif');
  const parsed = await CIF.parse(source).run(); if (parsed.isError) throw Error(parsed.message);
  const atomCount = parsed.result.blocks[0].categories.atom_site.rowCount;
  const scene: any = { version: 2, revision: 7,
    objects: [{ id: 'primary', primary: true, visible: true, derived: false, frameCount: 1,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], construction: { kind: 'model', modelIndex: 0 },
      constructionOptions: { models: [{ index: 0, modelNumber: 1 }], assemblies: [] } }],
    selection: { atomIds: [], expression: null, summary: null }, focus: { atomIds: [], expression: null, summary: null },
    camera: { mode: 'perspective', fovDegrees: 45, position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0] },
    layers: [{ id: 'main', visible: true, target: { kind: 'all' }, labels: false, opacity: 1, representation: 'cartoon', color: { kind: 'chain' } }],
    background: '#192734', lighting: 'studio', trajectory: null,
  };
  const sidecar = (text: string, format: string, mediaType: string) => ({ schemaVersion: 1, createdAt: '2026-09-19T00:00:00Z',
    artifact: { outputPath: 'exports/native', sha256: hash(text), byteLength: Buffer.byteLength(text), mediaType },
    provenance: { format, sceneRevision: 7, selectionAtomCount: format === 'scene-json' ? 0 : atomCount,
      ...(format === 'scene-json' ? {} : { coordinateProvenance: { format: 'mmcif', atomCount, modelCount: 1,
        identityPreserving: true, generatedAtomIdentifierCount: 0, generatedModelCount: 0,
        namespacedAtomIdentifierCount: 0, remappedModelCount: 0, preservedAtomIdentifierCount: atomCount,
        atomIdentifierPolicy: 'preserve-source-atom-site-ids-with-collision-safe-fallbacks',
        residueIdentifierPolicy: 'source-label-and-author-identifiers', bondConnectivityPolicy: 'coordinates-only-no-explicit-bond-records' } }),
    },
  });
  const saveScene = async () => {
    const text = JSON.stringify(scene); await writeFile(scenePath, text);
    await writeFile(`${scenePath}.provenance.json`, JSON.stringify(sidecar(text, 'scene-json', 'application/json')));
  };
  const receipt = sidecar(source, 'selection-mmcif', 'chemical/x-mmcif');
  const saveReceipt = () => writeFile(`${coordinatePath}.provenance.json`, JSON.stringify(receipt));
  await saveScene(); await writeFile(coordinatePath, source); await saveReceipt();
  return { scene, receipt, saveScene, saveReceipt, input: { scenePath, coordinatePath,
    nativeExports: { expectedRevision: 7, exportSelection: { kind: 'all' as const, objectId: 'primary' } } } };
}

describe('native Structure Viewer export handoff', () => {
  it('consumes unedited native sidecars without an authored pairing file', async () => {
    const { input } = await fixture(); const output = await readNativeStructureViewerExports(input);
    expect(output.compatibilityIssues).toEqual([]);
    expect(output.bundle?.coordinate.sha256).toBe(hash(source));
    expect(output.bundle?.declaration).toMatchObject({ expectedRevision: 7, sourceObjectId: 'primary' });
    expect(output.disclosure).toContain('not authenticated');
    expect(output.disclosure).toContain('caller-declared');
  });
  it.each(['digest', 'byteLength', 'revision', 'count', 'modelCount', 'format', 'object'])('fails closed for mismatched %s', async kind => {
    const f = await fixture(); const receipt: any = f.receipt;
    if (kind === 'digest') receipt.artifact.sha256 = '0'.repeat(64);
    if (kind === 'byteLength') receipt.artifact.byteLength++;
    if (kind === 'revision') receipt.provenance.sceneRevision++;
    if (kind === 'count') receipt.provenance.coordinateProvenance.atomCount++;
    if (kind === 'modelCount') receipt.provenance.coordinateProvenance.modelCount++;
    if (kind === 'format') receipt.provenance.format = 'selection-pdb';
    if (kind === 'object') f.input.nativeExports.exportSelection.objectId = 'other';
    await f.saveReceipt(); await expect(readNativeStructureViewerExports(f.input)).rejects.toThrow();
  });
  it.each([
    ['duplicate', 'ATOM C 1 1 0 0 0 ?\nATOM C 1 1 1 1 1 ?\n', /atom IDs/],
    ['nonfinite', 'ATOM C 1 1 NaN 0 0 ?\n', /positions/],
    ['missing-model', 'ATOM C 1 ? 0 0 0 ?\n', /model numbers/],
    ['wrapped-model', 'ATOM C 1 2147483648 0 0 0 ?\n', /model numbers.*32-bit/],
    ['invalid-group', 'OTHER C 1 1 0 0 0 ?\n', /group_PDB/],
    ['missing-element', 'ATOM ? 1 1 0 0 0 ?\n', /type_symbol/],
    ['namespaced-atom', 'ATOM C object:1 1 0 0 0 ?\n', /neither matching-scene nor structure-only/],
    ['unsafe-atom', 'ATOM C 9007199254740992 1 0 0 0 ?\n', /unsafe atom IDs/],
    ['wrapped-atom', 'ATOM C 2147483648 1 0 0 0 ?\n', /signed 32-bit/],
    ['noncanonical-atom', 'ATOM C 0001 1 0 0 0 ?\n', /integer spelling/],
    ['invalid-charge', 'ATOM C 1 1 0 0 0 NaN\n', /formal charges/],
    ['fractional-charge', 'ATOM C 1 1 0 0 0 0.1\n', /formal charges/],
    ['unsafe-charge', 'ATOM C 1 1 0 0 0 9007199254740992\n', /formal charges/],
  ])('rejects invalid serialized atom data: %s', async (_kind, rows, error) => {
    const f = await fixture();
    const text = 'data_native\nloop_\n_atom_site.group_PDB\n_atom_site.type_symbol\n_atom_site.id\n_atom_site.pdbx_PDB_model_num\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n_atom_site.pdbx_formal_charge\n' + rows;
    const count = String(rows).trim().split('\n').length;
    f.receipt.artifact.sha256 = hash(text); f.receipt.artifact.byteLength = Buffer.byteLength(text);
    f.receipt.provenance.selectionAtomCount = count;
    f.receipt.provenance.coordinateProvenance!.atomCount = count;
    f.receipt.provenance.coordinateProvenance!.preservedAtomIdentifierCount = count;
    await writeFile(f.input.coordinatePath, text); await f.saveReceipt();
    await expect(readNativeStructureViewerExports(f.input)).rejects.toThrow(error as RegExp);
  });
  it.each(['group_PDB', 'type_symbol'])('rejects a missing required %s field', async field => {
    const f = await fixture();
    const text = source.replace(`_atom_site.${field}`, `_atom_site.unused_${field}`);
    f.receipt.artifact.sha256 = hash(text); f.receipt.artifact.byteLength = Buffer.byteLength(text);
    await writeFile(f.input.coordinatePath, text); await f.saveReceipt();
    await expect(readNativeStructureViewerExports(f.input)).rejects.toThrow(`missing ${field}`);
  });
  it.each(['matching', 'different', 'absent', 'scene-only', 'coordinate-only'])('compares optional workspace source digests: %s', async kind => {
    const f = await fixture();
    const sceneSidecarPath = `${f.input.scenePath}.provenance.json`;
    const sceneReceipt = JSON.parse(await readFile(sceneSidecarPath, 'utf8'));
    if (kind !== 'absent' && kind !== 'coordinate-only')
      sceneReceipt.provenance.workspacePublication = { source: { sha256: '1'.repeat(64), workspacePath: 'source.cif' } };
    if (kind !== 'absent' && kind !== 'scene-only')
      (f.receipt.provenance as any).workspacePublication = { source: { sha256: (kind === 'different' ? '2' : '1').repeat(64), workspacePath: 'source.cif' } };
    await writeFile(sceneSidecarPath, JSON.stringify(sceneReceipt)); await f.saveReceipt();
    if (kind === 'different') await expect(readNativeStructureViewerExports(f.input)).rejects.toThrow(/source digests do not match/);
    else expect((await readNativeStructureViewerExports(f.input)).bundle?.provenanceStatus).toBe('declared-local');
  });
  it.each([['primary|1_555|0'], ['1']])('refuses nonempty native selections without pretending raw IDs are the upstream contract: %j', async atomIds => {
    const f = await fixture(); f.scene.selection = { atomIds: [atomIds], atomCount: 1, expression: null, summary: null }; await f.saveScene();
    const output = await readNativeStructureViewerExports(f.input);
    expect(output.bundle).toBeUndefined(); expect(output.compatibilityIssues.join(' ')).toContain('requires an empty native selection');
  });
  it('refuses nonidentity native matrices because exported coordinates already contain the transform', async () => {
    const f = await fixture(); f.scene.objects[0].matrix[12] = 2; await f.saveScene();
    const output = await readNativeStructureViewerExports(f.input);
    expect(output.bundle).toBeUndefined(); expect(output.compatibilityIssues.join(' ')).toContain('avoid applying placement twice');
    expect(output.coordinateText).toBe(source);
  });
  it('returns identity incompatibility separately so an explicit structure-only choice remains possible', async () => {
    const f = await fixture(); const policy = f.receipt.provenance.coordinateProvenance!;
    policy.identityPreserving = false; policy.remappedModelCount = 1; await f.saveReceipt();
    const output = await readNativeStructureViewerExports(f.input);
    expect(output.bundle).toBeUndefined(); expect(output.compatibilityIssues[0]).toContain('identity');
  });
  it('checks without opening, refuses unsupported scenes, then honors explicit structure-only or matching-scene choices', async () => {
    const f = await fixture(); const server = createStereoStructureServer();
    const client = new Client({ name: 'native export test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    const call = async (mode?: string) => await client.callTool({ name: 'stereo_structure.inspect_scene', arguments: { ...f.input, ...(mode ? { mode } : {}) } }) as any;
    try {
      const missing: any = await client.callTool({ name: 'stereo_structure.inspect_scene', arguments: { scenePath: f.input.scenePath, coordinatePath: f.input.coordinatePath } });
      expect(missing.isError).toBe(true);
      const ambiguous: any = await client.callTool({ name: 'stereo_structure.inspect_scene', arguments: { ...f.input, provenancePath: f.input.scenePath } });
      expect(ambiguous.isError).toBe(true);
      const checked = await call();
      expect(checked.isError).not.toBe(true);
      expect(checked.structuredContent).toMatchObject({ kind: 'scene-preflight', imported: false, preflight: { supported: true } });
      expect(checked.structuredContent.sessionId).toBeUndefined(); expect(checked._meta).toBeUndefined();
      f.scene.selection = { atomIds: [], atomIdsTruncated: true, atomCount: 1, expression: null, summary: null }; await f.saveScene();
      for (const mode of ['check', 'matching-scene']) {
        const truncated = await call(mode);
        expect(truncated.structuredContent).toMatchObject({ imported: false, preflight: { supported: false } });
        expect(truncated.structuredContent.preflight.unsupportedFeatures.join(' ')).toContain('Truncated selection');
        expect(truncated.structuredContent.choices[0].available).toBe(false);
        expect(truncated.structuredContent.sessionId).toBeUndefined();
      }
      f.scene.selection = { atomIds: [], expression: null, summary: null };
      f.scene.layers.push({ ...f.scene.layers[0], id: 'extra' }); await f.saveScene();
      const rejected = await call('matching-scene');
      expect(rejected.structuredContent).toMatchObject({ imported: false, preflight: { supported: false } });
      expect(rejected.structuredContent.sessionId).toBeUndefined();
      const opened = await call('structure-only');
      expect(opened.isError).not.toBe(true); expect(opened.structuredContent.handoffMode).toBe('structure-only');
      const hydration: any = await client.callTool({ name: 'stereo_structure.get_inspection', arguments: { sessionId: opened.structuredContent.sessionId } });
      expect(hydration._meta[KEY].sceneImport).toBeUndefined();
      f.scene.layers.pop(); await f.saveScene();
      const matching = await call('matching-scene'); expect(matching.isError).not.toBe(true);
      const matchingHydration: any = await client.callTool({ name: 'stereo_structure.get_inspection', arguments: { sessionId: matching.structuredContent.sessionId } });
      expect(matchingHydration._meta[KEY].sceneImport.declaration.expectedRevision).toBe(7);
      expect(JSON.stringify(checked)).not.toContain(source); expect(JSON.stringify(checked)).not.toContain(f.input.scenePath);
    } finally { await client.close(); await server.close(); }
  });
});
