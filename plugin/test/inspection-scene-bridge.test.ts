import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function scene(modelNumber: number, assemblyId: string) {
  return { version: 2, revision: 0, objects: [{ id: 'primary', primary: true, visible: true, derived: false, frameCount: 1,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], construction: { kind: 'model', modelIndex: 0 },
    constructionOptions: { models: [{ index: 0, modelNumber }], assemblies: [] } }],
  selection: { atomIds: [], atomIdsTruncated: false, expression: { kind: 'atom_ids', atomIds: [] }, summary: 'none' },
  focus: { atomIds: [], expression: null, summary: null }, camera: { orientation: 'current', mode: 'perspective', fovDegrees: 45, position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0] },
  layers: [{ id: 'main', visible: true, target: { kind: 'all' }, labels: false, opacity: 1, representation: 'cartoon', color: { kind: 'uniform', value: '#44aaff' } }],
  background: '#192734', lighting: 'studio', annotations: [], measurements: [], volumes: [], analyses: [], assemblySymmetry: [], sceneGuides: [], qualityAssessment: [], storyboard: [], savedScenes: [], dirtyDerivedObjectIds: [], trajectory: null, namedSelections: {},
  };
}

describe('Structure Viewer local scene bridge', () => {
  it('keeps file provenance declared-local and resolves through the loaded target boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-scene-bridge-'));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(); const client = new Client({ name: 'scene bridge test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      const sourceSha256 = digest(cif), rawScene = JSON.stringify(scene(1, 'asymmetric_unit'));
      const scenePath = join(root, 'scene.json'), coordinatePath = join(root, 'selection.mmcif'), provenancePath = join(root, 'provenance.json');
      await writeFile(scenePath, rawScene); await writeFile(coordinatePath, cif); await writeFile(provenancePath, JSON.stringify({ version: 1, kind: 'structure-viewer-local-snapshot', sceneSha256: digest(rawScene), expectedRevision: 0, sourceObjectId: 'primary', coordinate: { format: 'selection-mmcif', sha256: sourceSha256, coordinateProvenance: { identityPreserving: true, generatedAtomIdentifierCount: 0, generatedModelCount: 0, namespacedAtomIdentifierCount: 0, remappedModelCount: 0 } } }));
      const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
      const opened = await call('inspect_scene', { scenePath, coordinatePath, provenancePath });
      expect(opened.isError).not.toBe(true);
      const sessionId = opened.structuredContent.sessionId;
      const hydration = await call('get_inspection', { sessionId });
      const metadata = hydration._meta[KEY];
      expect(metadata.sceneImport).toMatchObject({ provenanceStatus: 'declared-local', declaration: { expectedRevision: 0 } });
      const target = { sourceSha256, modelNumber: 1, assemblyId: 'asymmetric_unit', molecularCenterAngstrom: [0, 0, 0], molecularRadiusAngstrom: 10,
        cameraBaseline: { mode: 'perspective', fov: 1, position: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], radius: 1, radiusMax: 1, fog: 0, clipFar: false, minNear: .1, minFar: .1 }, atomIdToSelectionKey: {} };
      const resolved = await call('resolve_scene_import', { sessionId, serverEpoch: metadata.serverEpoch, sourceToken: metadata.sourceToken, baseStateRevision: metadata.stateRevision, baseInspectionRevision: metadata.inspectionRevision, target });
      expect(resolved.isError).not.toBe(true);
      expect(resolved.structuredContent).toMatchObject({ imported: true, provenanceStatus: 'declared-local', scene: { sourceSha256, modelNumber: 1, assemblyId: 'asymmetric_unit' } });
      expect((await call('resolve_scene_import', { sessionId, serverEpoch: metadata.serverEpoch, sourceToken: metadata.sourceToken, baseStateRevision: metadata.stateRevision, baseInspectionRevision: metadata.inspectionRevision, target })).structuredContent.scene).toEqual(resolved.structuredContent.scene);
      const captured = structuredClone(resolved.structuredContent.scene);
      captured.inspection.emphasis = { parts: [], focus: [], contextOpacity: .18 };
      const saved = await call('sync_inspection', { sessionId, serverEpoch: metadata.serverEpoch, sourceToken: metadata.sourceToken,
        baseStateRevision: metadata.stateRevision, baseInspectionRevision: metadata.inspectionRevision, scene: captured });
      expect(saved.isError).not.toBe(true);
      expect((await call('get_inspection', { sessionId }))._meta[KEY].sceneImport).toBeUndefined();
      const edited = structuredClone(captured); edited.inspection.appearance.opacity = .6;
      const changed = await call('sync_inspection', { sessionId, serverEpoch: metadata.serverEpoch, sourceToken: metadata.sourceToken,
        baseStateRevision: saved.structuredContent.stateRevision, baseInspectionRevision: saved.structuredContent.inspectionRevision, scene: edited });
      expect(changed.isError).not.toBe(true);
      const rehydrated = (await call('get_inspection', { sessionId }))._meta[KEY];
      expect(rehydrated.scene.inspection.appearance.opacity).toBe(.6);
      expect(rehydrated.sceneImport).toBeUndefined();

    } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('opens a bounded local lesson and exposes its custom tour privately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-lesson-'));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(); const client = new Client({ name: 'lesson bridge test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      const lessonPath = join(root, 'lesson.json'), filePath = join(root, 'source.mmcif');
      await writeFile(filePath, cif); await writeFile(lessonPath, JSON.stringify({ version: 1, id: 'local-demo', title: 'Local demo', mode: 'explore', provenance: { sourceRefs: [{ kind: 'local', ref: filePath }] }, chapters: [{ id: 'intro', title: 'Intro', caption: 'A local chapter.', durationSeconds: .5, changes: [{ kind: 'rotate', durationSeconds: .5, degrees: 10 }], immersive: { appearance: { representation: 'cartoon', color: 'chain-id' }, view: 'fit' } }] }));
      const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
      const mismatchPath = join(root, 'mismatch.json');
      const mismatch = JSON.parse(await readFile(lessonPath, 'utf8')); mismatch.provenance.sourceSha256 = '0'.repeat(64); await writeFile(mismatchPath, JSON.stringify(mismatch));
      expect((await call('inspect_lesson', { filePath, lessonPath: mismatchPath })).isError).toBe(true);
      const opened = await call('inspect_lesson', { filePath, lessonPath });
      expect(opened.isError).not.toBe(true);
      const metadata = (await call('get_inspection', { sessionId: opened.structuredContent.sessionId }))._meta[KEY];
      expect(metadata.customTour).toMatchObject({ id: 'lesson-local-demo', title: 'Local demo', steps: [{ id: 'intro' }] });
      const state = await call('get_inspection_state', { sessionId: opened.structuredContent.sessionId });
      expect(state.structuredContent.tours.some((tour: any) => tour.id === 'lesson-local-demo')).toBe(true);
    } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });
});
