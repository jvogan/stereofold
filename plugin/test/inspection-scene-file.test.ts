import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_INSPECTION_SCENE_BYTES } from '../src/inspection-limits.js';
import { importStructureViewerSceneFiles, readStructureViewerSceneFiles, sceneImportMatchesSavedScene } from '../src/inspection-scene-file.js';

const coordinateText = 'data_scene\n#\nloop_\n_atom_site.id\nATOM\n#\n';
const sceneJson = {
  version: 2, revision: 0,
  objects: [{ id: 'primary', primary: true, visible: true, derived: false, frameCount: 1,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    construction: { kind: 'model', modelIndex: 0 }, constructionOptions: { models: [{ index: 0, modelNumber: 1 }], assemblies: [] } }],
  selection: { atomIds: ['atom-1'], atomIdsTruncated: false, expression: { kind: 'atom_ids', atomIds: ['atom-1'] }, summary: 'one' },
  focus: { atomIds: [], expression: null, summary: null },
  camera: { orientation: 'current', mode: 'perspective', fovDegrees: 45, position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0] },
  layers: [{ id: 'main', visible: true, target: { kind: 'all' }, labels: false, opacity: 1, representation: 'cartoon', color: { kind: 'uniform', value: '#44aaff' } }],
  background: '#192734', lighting: 'studio', annotations: [], measurements: [], volumes: [], analyses: [], assemblySymmetry: [], sceneGuides: [], qualityAssessment: [], storyboard: [], savedScenes: [], dirtyDerivedObjectIds: [], trajectory: null, namedSelections: {},
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const declaration = (sceneBytes: Buffer, coordinateBytes = Buffer.from(coordinateText)) => JSON.stringify({
  version: 1, kind: 'structure-viewer-local-snapshot', sceneSha256: sha256(sceneBytes.toString()), expectedRevision: 0, sourceObjectId: 'primary',
  coordinate: { format: 'selection-mmcif', sha256: sha256(coordinateBytes.toString()), coordinateProvenance: { identityPreserving: true, generatedAtomIdentifierCount: 0, generatedModelCount: 0, namespacedAtomIdentifierCount: 0, remappedModelCount: 0 } },
});

const importTarget = {
  sourceSha256: sha256(coordinateText), modelNumber: 1, assemblyId: 'asymmetric_unit',
  molecularCenterAngstrom: [0, 0, 0] as [number, number, number], molecularRadiusAngstrom: 10,
  cameraBaseline: { mode: 'perspective' as const, fov: 1, position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], radius: 7, radiusMax: 9, fog: 12, clipFar: false, minNear: 3, minFar: 4 },
  atomIdToSelectionKey: { 'atom-1': 'residue-key-1' },
};

let roots: string[] = [];
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-scene-file-')); roots.push(root);
  const scene = Buffer.from(JSON.stringify(sceneJson)); const coordinate = Buffer.from(coordinateText);
  const scenePath = join(root, 'scene.json'), coordinatePath = join(root, 'selection.mmcif'), provenancePath = join(root, 'provenance.json');
  await writeFile(scenePath, scene); await writeFile(coordinatePath, coordinate); await writeFile(provenancePath, declaration(scene, coordinate));
  return { scenePath, coordinatePath, provenancePath };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('bounded Structure Viewer local scene artifact reader', () => {
  it('reads an exact scene/mmCIF pair with declared, unauthenticated provenance', async () => {
    const input = await files();
    const result = await readStructureViewerSceneFiles(input);
    expect(result.provenanceStatus).toBe('declared-local');
    expect(result.declaration.expectedRevision).toBe(0);
    expect(result.coordinate.text).toBe(coordinateText);
    expect(result.sceneJson).toEqual(sceneJson);
  });

  it('passes a bounded pair into the existing lossless importer', async () => {
    const input = await files();
    const result = await importStructureViewerSceneFiles({ ...input, target: importTarget });
    expect(result.provenanceStatus).toBe('declared-local');
    expect(result.scene.selectionKeys).toEqual(['residue-key-1']);
    expect(result.preflight).toMatchObject({ supported: true, scope: 'complete-input', disclosure: { selectionGranularity: 'residues' } });
    expect(result.message).toContain('Open matching scene');
  });

  it('preserves the original error verbatim and attaches the structure-only alternative separately', async () => {
    const input = await files();
    const scene: any = structuredClone(sceneJson);
    scene.layers.push({ ...scene.layers[0], id: 'ligand', representation: 'ball_and_stick' });
    const bytes = Buffer.from(JSON.stringify(scene));
    await writeFile(input.scenePath, bytes);
    await writeFile(input.provenancePath, declaration(bytes));
    await expect(importStructureViewerSceneFiles({ ...input, target: importTarget })).rejects.toMatchObject({
      message: 'Structure Viewer scene import rejected: ordered layers require exactly one layer; multi-layer scenes are unsupported.',
      preflight: { supported: false, message: expect.stringContaining('Structure-only alternative'),
        unsupportedFeatures: expect.arrayContaining([expect.stringContaining('Layer "ligand" (ball_and_stick)')]) },
    });
  });

  it.each([
    ['scene digest mismatch', async (input: any) => { const sidecar = JSON.parse(await readFile(input.provenancePath, 'utf8')); sidecar.sceneSha256 = '0'.repeat(64); await writeFile(input.provenancePath, JSON.stringify(sidecar)); }, /sceneSha256/i],
    ['coordinate digest mismatch', async (input: any) => { const sidecar = JSON.parse(await readFile(input.provenancePath, 'utf8')); sidecar.coordinate.sha256 = '0'.repeat(64); await writeFile(input.provenancePath, JSON.stringify(sidecar)); }, /coordinate sha256/i],
    ['revision mismatch', async (input: any) => { const sidecar = JSON.parse(await readFile(input.provenancePath, 'utf8')); sidecar.expectedRevision = 2; await writeFile(input.provenancePath, JSON.stringify(sidecar)); }, /scene revision/i],
    ['unsupported declaration field', async (input: any) => { const sidecar = JSON.parse(await readFile(input.provenancePath, 'utf8')); sidecar.receipt = 'fake'; await writeFile(input.provenancePath, JSON.stringify(sidecar)); }, /unrecognized key/i],
  ])('rejects %s', async (_name, change, error) => {
    const input = await files(); await change(input); await expect(readStructureViewerSceneFiles(input)).rejects.toThrow(error);
  });

  it('rejects final-component symlinks and oversized scenes', async () => {
    const input = await files(); const link = `${input.scenePath}.link`; await symlink(input.scenePath, link);
    await expect(readStructureViewerSceneFiles({ ...input, scenePath: link })).rejects.toThrow(/absolute regular file|stable regular file/i);
    await writeFile(input.scenePath, Buffer.alloc(MAX_INSPECTION_SCENE_BYTES + 1, 0x20));
    await expect(readStructureViewerSceneFiles(input)).rejects.toThrow(/bounded artifact size/i);
  });
  it('recognizes the renderer empty-emphasis default without ignoring actual scene changes', async () => {
    const input = await files(), imported = (await importStructureViewerSceneFiles({ ...input, target: importTarget })).scene;
    const captured = structuredClone(imported);
    captured.inspection.emphasis = { parts: [], focus: [], contextOpacity: .18 };
    expect(sceneImportMatchesSavedScene(captured, imported)).toBe(true);
    const moved = structuredClone(captured); moved.camera.position[0] += 1;
    expect(sceneImportMatchesSavedScene(moved, imported)).toBe(false);
    const changed = structuredClone(captured); changed.inspection.appearance.opacity = .5;
    expect(sceneImportMatchesSavedScene(changed, imported)).toBe(false);
    const emphasized = structuredClone(captured); emphasized.inspection.emphasis!.parts = [{ id:'ligand', label:'Ligand', color:'#ffffff' }];
    expect(sceneImportMatchesSavedScene(emphasized, imported)).toBe(false);
  });

});
