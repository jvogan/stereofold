import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importStructureViewerScene, preflightInspectionScene } from '../src/inspection-scene-import.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const text = 'data_scene\n#\nloop_\n_atom_site.group_PDB\nATOM\n#\n';
const sha256 = createHash('sha256').update(text).digest('hex');
const target = () => ({ sourceSha256: sha256, modelNumber: 1, assemblyId: 'asymmetric_unit', molecularCenterAngstrom: [10, 0, 0] as [number, number, number], molecularRadiusAngstrom: 10,
  cameraBaseline: { mode: 'perspective' as const, fov: 1, position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], radius: 7, radiusMax: 9, fog: 12, clipFar: false, minNear: 3, minFar: 4 },
  atomIdToSelectionKey: { 'atom-1': 'residue-key-1' } });
const scene = () => ({ version: 2, revision: 0, objects: [{ id: 'primary', primary: true, visible: true, derived: false, frameCount: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1], construction: { kind: 'model', modelIndex: 0 }, constructionOptions: { models: [{ index: 0, modelNumber: 1 }], assemblies: [] } }],
  selection: { atomIds: ['atom-1'], atomIdsTruncated: false, expression: { kind: 'atom_ids', atomIds: ['atom-1'] }, summary: 'one' },
  focus: { atomIds: [], expression: null, summary: null },
  camera: { orientation: 'current', mode: 'perspective', fovDegrees: 45, position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0] },
  layers: [{ id: 'main', visible: true, target: { kind: 'all' }, labels: false, opacity: .4, representation: 'cartoon', color: { kind: 'uniform', value: '#44aaff' } }],
  background: '#192734', lighting: 'studio', annotations: [], measurements: [], volumes: [], analyses: [], assemblySymmetry: [], sceneGuides: [], qualityAssessment: [], storyboard: [], savedScenes: [], dirtyDerivedObjectIds: [], trajectory: null, namedSelections: {}, viewSettings: undefined, representationOptions: undefined,
});
const input = () => ({ sceneJson: scene(), coordinate: { format: 'selection-mmcif' as const, text, sha256, sourceObjectId: 'primary', expectedSceneRevision: 0,
  coordinateProvenance: { identityPreserving: true as const, generatedAtomIdentifierCount: 0 as const, generatedModelCount: 0 as const, namespacedAtomIdentifierCount: 0 as const, remappedModelCount: 0 as const } }, target: target() });
const defaultLigandLayers = (objectId = 'primary') => [
  { id: 'primary-display', name: 'Primary structure', visible: true, target: { kind: 'component', component: 'polymer', objectId }, labels: false,
    opacity: 1, representation: 'cartoon', color: { kind: 'chain' } },
  { id: 'primary-ligand-display', name: 'Ligands', visible: true, target: { kind: 'component', component: 'ligand', objectId }, labels: false,
    opacity: 1, representation: 'sticks', color: { kind: 'element' } },
];

const rejectedFixtures: [string, (value: any) => void, RegExp][] = [
  ['two layers', (value: any) => { value.sceneJson.layers.push({ ...value.sceneJson.layers[0], id: 'ligand', representation: 'ball_and_stick' }); }, /ordered layers require exactly one layer; multi-layer scenes are unsupported\./],
  ['labels', (value: any) => { value.sceneJson.layers[0].labels = true; }, /layer labels are unsupported/],
  ['label mode', (value: any) => { value.sceneJson.layers[0].labelMode = 'residue'; }, /layer labels are unsupported/],
  ['representation options', (value: any) => { value.sceneJson.layers[0].representationOptions = { sizeFactor: 2 }; }, /layer representationOptions are unsupported/],
  ['selection color overrides', (value: any) => { value.sceneJson.layers[0].colorOverrides = [{ target: { kind: 'residue', residue: 'ALA' }, color: '#ff0000' }]; }, /colorOverrides are unsupported/],
  ['shared representation options', (value: any) => { value.sceneJson.representationOptions = { quality: 'high' }; }, /viewSettings and shared representationOptions are unsupported/],
  ['hidden layer', (value: any) => { value.sceneJson.layers[0].visible = false; }, /layers\[0\] must be visible/],
  ['no layers', (value: any) => { value.sceneJson.layers = []; }, /exactly one layer/],
  ['unsupported style', (value: any) => { value.sceneJson.layers[0].representation = 'ribbon'; }, /representation.*no Stereofold equivalent/],
  ['bad placement', (value: any) => { value.sceneJson.objects[0].matrix[12] = 10000010; }, /translation is outside/],
  ['annotations', (value: any) => { value.sceneJson.annotations = [{ label: 'site' }]; }, /annotations is not supported/],
  ['measurements', (value: any) => { value.sceneJson.measurements = [{ kind: 'distance' }]; }, /measurements is not supported/],
  ['maps', (value: any) => { value.sceneJson.volumes = [{ id: 'map' }]; }, /volumes is not supported/i],
  ['multiple objects', (value: any) => { value.sceneJson.objects.push(structuredClone(value.sceneJson.objects[0])); }, /exactly one structure/i],
  ['scoped layer', (value: any) => { value.sceneJson.layers[0].target = { kind: 'chain', chain: 'A' }; }, /complete single object/i],
  ['unmapped selection', (value: any) => { value.sceneJson.selection.atomIds = ['atom-2']; }, /every selected source atom ID/i],
  ['remapped coordinate IDs', (value: any) => { value.coordinate.coordinateProvenance.remappedModelCount = 1; }, /identityPreserving/i],
  ['invalid camera clipping', (value: any) => { value.sceneJson.camera.nearClip = -1; }, /camera.nearClip must be nonnegative/i],
  ['sliced clipping radius', (value: any) => { value.sceneJson.camera.clippingRadius = 2; }, /camera.clippingRadius may cut/i],
  ['sliced near and far planes', (value: any) => { value.sceneJson.camera.nearClip = 40; value.sceneJson.camera.farClip = 50; }, /camera.nearClip may cut/i],
  ['sliced far plane', (value: any) => { value.sceneJson.camera.farClip = 20; }, /camera.farClip may cut/i],
  ['camera zoom', (value: any) => { value.sceneJson.camera.zoom = 2; }, /camera focus and zoom/i],
  ['different layer object', (value: any) => { value.sceneJson.layers[0].target = { kind: 'all', objectId: 'other' }; }, /complete single object/i],
  ['hidden residue target', (value: any) => { value.sceneJson.layers[0].target = { kind: 'allOf', expressions: [{ kind: 'all', objectId: 'primary' }, { kind: 'not', expression: { kind: 'residue', residue: 'HEM' } }] }; }, /complete single object/i],
  ['hidden foreign component', (value: any) => { value.sceneJson.layers[0].target = { kind: 'allOf', expressions: [{ kind: 'all', objectId: 'primary' }, { kind: 'not', expression: { kind: 'component', component: 'water', objectId: 'other' } }] }; }, /complete single object/i],
  ['focused atoms', (value: any) => { value.sceneJson.focus = { atomIds: ['atom-1'], expression: { kind: 'atom_ids', atomIds: ['atom-1'] }, summary: 'one' }; }, /focus is unsupported/i],
  ['unverified construction model', (value: any) => { value.sceneJson.objects[0].constructionOptions.models[0].modelNumber = 2; }, /modelIndex does not match/i],
  ['incomplete truncated selection query', (value: any) => { value.sceneJson.selection = { atomIds: [], atomIdsTruncated: true, atomCount: 2 }; value.target.queriedSelectionAtomIds = ['atom-1']; }, /truncated selection\.atomIds/i],
  ['mutated coordinates', (value: any) => { value.coordinate.text += '# changed\n'; }, /sha256/i],
];

describe('Structure Viewer SceneState v2 import', () => {
  it('imports the bundled default protein and ligand layers against the 4HHB catalog', async () => {
    const value: any = input();
    const coordinates = await readFile(fileURLToPath(new URL('../../fixtures/4HHB.cif', import.meta.url)), 'utf8');
    const catalog: any = await extractInspectionCatalogBytes(coordinates);
    value.coordinate.text = coordinates;
    value.coordinate.sha256 = createHash('sha256').update(coordinates).digest('hex');
    value.target.sourceSha256 = value.coordinate.sha256;
    value.target.catalogRows = catalog.rows;
    value.sceneJson.selection.atomIds = [];
    value.sceneJson.layers = defaultLigandLayers();
    const report = preflightInspectionScene(value.sceneJson, value);
    expect(report).toMatchObject({ supported: true, unsupportedFeatures: [], renderingDifference: 'Ligands are shown as ball-and-stick; Structure Viewer drew bond-only sticks.' });
    const imported = importStructureViewerScene(value).scene;
    expect(imported.inspection.appearance).toMatchObject({ representation: 'cartoon', color: 'chain-id' });
    expect(imported.inspection.styles).toEqual([{ selectionKeys: catalog.rows.filter((row: any) => ['HEM', 'PO4'].includes(row.identity.componentId)).map((row: any) => row.key).sort(),
      representation: 'ball-and-stick', color: 'element-symbol', opacity: 1 }]);
    expect(imported.inspection.visibility).toBeUndefined();
  });
  it('maps hidden component targets with the headset class split for ions', () => {
    const value: any = input();
    value.target.catalogRows = [
      { key: 'polymer', entityType: 'polymer', identity: { componentId: 'ALA', modelNumber: 1 } },
      { key: 'heme', entityType: 'non-polymer', identity: { componentId: 'HEM', modelNumber: 1 } },
      { key: 'magnesium', entityType: 'non-polymer', identity: { componentId: 'MG', modelNumber: 1 } },
      { key: 'water', entityType: 'water', identity: { componentId: 'HOH', modelNumber: 1 } },
    ];
    value.sceneJson.layers[0].target = { kind: 'allOf', expressions: [
      { kind: 'all', objectId: 'primary' }, { kind: 'not', expression: { kind: 'anyOf', expressions: [
        { kind: 'component', component: 'water', objectId: 'primary' },
        { kind: 'component', component: 'ion', objectId: 'primary' },
      ] } },
    ] };
    expect(importStructureViewerScene(value).scene.inspection.visibility).toEqual({ hiddenChains: [], hiddenClasses: ['water', 'ion'], showOnlySelection: false });
    value.sceneJson.layers = defaultLigandLayers();
    expect(importStructureViewerScene(value).scene.inspection.styles?.[0].selectionKeys).toEqual(['heme']);
    value.sceneJson.layers.forEach((layer: any) => { layer.target = { kind: 'allOf', expressions: [layer.target,
      { kind: 'not', expression: { kind: 'component', component: 'water', objectId: 'primary' } }] }; });
    expect(importStructureViewerScene(value).scene.inspection.visibility?.hiddenClasses).toEqual(['water']);
    value.sceneJson.layers.pop();
    expect(importStructureViewerScene(value).scene.inspection.visibility?.hiddenClasses).toEqual(['water', 'ligand']);
  });
  it('refuses a loaded NH4 class disagreement for ligand layers and ion hides', () => {
    const value: any = input();
    value.target.catalogRows = [
      { key: 'protein', entityType: 'polymer', identity: { componentId: 'ALA', modelNumber: 1 } },
      { key: 'ammonium', entityType: 'non-polymer', identity: { componentId: 'NH4', modelNumber: 1 } },
    ];
    value.sceneJson.layers = defaultLigandLayers();
    const disagreement = /component "NH4" is ligand in Structure Viewer but ion in Stereofold/i;
    expect(() => importStructureViewerScene(value)).toThrow(disagreement);
    expect(preflightInspectionScene(value.sceneJson, value)).toMatchObject({
      supported: false, outcome: 'structure-only alternative', unsupportedFeatures: [expect.stringMatching(disagreement)],
    });
    value.sceneJson.layers = [input().sceneJson.layers[0]];
    expect(() => importStructureViewerScene(value)).toThrow(disagreement);
    value.sceneJson.layers[0].target = { kind: 'allOf', expressions: [
      { kind: 'all', objectId: 'primary' },
      { kind: 'not', expression: { kind: 'component', component: 'ion', objectId: 'primary' } },
    ] };
    expect(() => importStructureViewerScene(value)).toThrow(disagreement);
  });
  it('refuses modified default ligand layers and mismatched class exclusions', () => {
    const value: any = input();
    value.sceneJson.layers = defaultLigandLayers();
    value.sceneJson.layers[1].color = { kind: 'element', value: '#ff0000' };
    expect(() => importStructureViewerScene(value)).toThrow(/multi-layer scenes are unsupported/);
    value.sceneJson.layers[1].color = { kind: 'element' };
    value.sceneJson.layers[0].target = { kind: 'allOf', expressions: [value.sceneJson.layers[0].target,
      { kind: 'not', expression: { kind: 'component', component: 'water', objectId: 'primary' } }] };
    expect(() => importStructureViewerScene(value)).toThrow(/multi-layer scenes are unsupported/);
  });
  it('accepts a native single-copy assembly export with its normal object target and clipping metadata', () => {
    const value: any = input();
    value.sceneJson.objects[0].construction = { kind: 'assembly', assemblyId: '1', modelIndex: 0 };
    value.sceneJson.objects[0].constructionOptions = {
      models: [{ index: 0, modelNumber: 1 }], assemblies: [{ id: '1' }],
      operatorCount: 1, operatorsTruncated: false, operators: [{ assemblyId: '1', modelNumber: 1 }],
    };
    value.sceneJson.layers[0].target = { kind: 'all', objectId: 'primary' };
    value.sceneJson.camera.clippingRadius = 21;
    value.sceneJson.camera.nearClip = 1;
    value.coordinate.assemblyBakedIntoCoordinates = true;
    expect(preflightInspectionScene(value.sceneJson, value)).toMatchObject({ supported: true, unsupportedFeatures: [] });
    expect(preflightInspectionScene(value.sceneJson, value).disclosure.doesNotCarry).toContain('camera clippingRadius/nearClip/farClip');
    expect(importStructureViewerScene(value).scene.assemblyId).toBe('asymmetric_unit');
    value.sceneJson.objects[0].constructionOptions.operatorCount = 2;
    expect(() => importStructureViewerScene(value)).toThrow(/source assembly does not match/);
  });
  it('marks clipping as provisional until the parsed structure can prove it is uncut', () => {
    const value: any = input();
    value.sceneJson.camera.clippingRadius = 2;
    const provisional = preflightInspectionScene(value.sceneJson);
    expect(provisional.supported).toBe(true);
    expect(provisional.pendingChecks.join(' ')).toMatch(/clippingRadius.*do not cut/);
    const resolved = preflightInspectionScene(value.sceneJson, value);
    expect(resolved.supported).toBe(false);
    expect(resolved.unsupportedFeatures.join(' ')).toMatch(/camera.clippingRadius may cut/);
  });
  it('imports only the supported single-structure snapshot and retains exact coordinate bytes', () => {
    const value = input();
    expect(preflightInspectionScene(value.sceneJson)).toMatchObject({ supported: true, scope: 'scene', unsupportedFeatures: [], outcome: 'open matching scene' });
    expect(preflightInspectionScene(value.sceneJson, value)).toMatchObject({ supported: true, scope: 'complete-input', pendingChecks: [] });
    const imported = importStructureViewerScene(value);
    expect(imported.coordinate).toEqual({ format: 'mmcif', text, sha256 });
    expect(imported.scene).toMatchObject({ sourceSha256: sha256, modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: ['residue-key-1'],
      camera: { fov: Math.PI / 4, position: [0, 0, 30], radius: 7, radiusMax: 9, fog: 12, clipFar: false, minNear: 3, minFar: 4 },
      inspection: { appearance: { representation: 'cartoon', color: 'uniform', uniformColor: '#44AAFF', background: '#192734', opacity: .4 }, placement: { translation: [.2, 0, 0], rotation: [0, 0, 0], scale: 1 } } });
  });
  it('converts a Mol* column-major rigid matrix around Stereofold’s molecular center', () => {
    const value: any = input();
    value.sceneJson.objects[0].matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(importStructureViewerScene(value).scene.inspection.placement).toEqual({ translation: [-1, 1, 0], rotation: [0, 0, 90], scale: 1 });
  });
  it('uses complete revision-bound query IDs when the retained SceneState atom IDs are truncated', () => {
    const value: any = input();
    value.sceneJson.selection = { atomIds: [], atomIdsTruncated: true, atomCount: 1, expression: { kind: 'current', target: 'selection' }, summary: 'truncated' };
    const before = structuredClone(value.sceneJson);
    const pending = preflightInspectionScene(value.sceneJson);
    expect(pending).toMatchObject({ supported: true, scope: 'scene', unsupportedFeatures: [], outcome: 'open matching scene' });
    expect(pending.pendingChecks).toContain('selection.atomIds is truncated; verify complete unique revision-bound query IDs matching selection.atomCount.');
    expect(value.sceneJson).toEqual(before);
    expect(preflightInspectionScene(value.sceneJson, value).supported).toBe(false);
    expect(() => importStructureViewerScene(value)).toThrow('truncated selection.atomIds requires complete unique revision-bound atom query results matching selection.atomCount.');
    value.target.queriedSelectionAtomIds = ['atom-1'];
    expect(preflightInspectionScene(value.sceneJson, value)).toMatchObject({ supported: true, scope: 'complete-input', unsupportedFeatures: [], pendingChecks: [] });
    expect(importStructureViewerScene(value).scene.selectionKeys).toEqual(['residue-key-1']);
  });
  it.each([['atom-1', 'atom-1'], [''], [42]])('still rejects malformed retained IDs while query results are pending: %j', (...atomIds) => {
    const value: any = input();
    value.sceneJson.selection = { atomIds, atomIdsTruncated: true, atomCount: 2 };
    expect(preflightInspectionScene(value.sceneJson)).toMatchObject({ supported: false });
    expect(() => importStructureViewerScene(value)).toThrow(/selection.atomIds/);
  });
  it.each([
    ['surface', 'molecular-surface'], ['ball_and_stick', 'ball-and-stick'], ['spheres', 'spacefill'], ['cartoon', 'cartoon'],
  ])('discloses requested %s separately from headset appearance', (requested, imported) => {
    const value = input();
    value.sceneJson.layers[0].representation = requested;
    for (const report of [preflightInspectionScene(value.sceneJson), preflightInspectionScene(value.sceneJson, value)]) {
      expect(report.disclosure.appearance).toContain(`Requested representation: ${requested}.\nThe headset may draw cartoon for dense scenes.`);
      expect(report.message).toContain(report.disclosure.appearance);
    }
    expect(importStructureViewerScene(value).scene.inspection.appearance.representation).toBe(imported);
  });
  it.each(rejectedFixtures)('rejects %s instead of silently dropping it', (_name, change, error) => {
    const value: any = input(); change(value); expect(() => importStructureViewerScene(value)).toThrow(error);
  });
  it('names the extra ligand layer, labels, options and scoped targets together without mutating the scene', () => {
    const value: any = input();
    value.sceneJson.layers.push({ ...value.sceneJson.layers[0], id: 'ligand', representation: 'ball_and_stick',
      labels: true, representationOptions: { sizeFactor: 2 }, target: { kind: 'residue', residue: 'LIG' } });
    const before = structuredClone(value);
    const report = preflightInspectionScene(value.sceneJson);
    expect(report.supported).toBe(false);
    expect(report.unsupportedFeatures.join(' ')).toContain('Layer "ligand" (ball_and_stick)');
    for (const feature of ['extra layers', 'labels', 'representationOptions', 'complete single object'])
      expect(report.unsupportedFeatures.join(' ')).toContain(feature);
    expect(report.message).toContain('Structure-only alternative');
    expect(report.message.split('\n').slice(1, 1 + report.unsupportedFeatures.length)).toEqual(report.unsupportedFeatures);
    expect(report.message).not.toContain('representation options (representationOptions)');
    expect(() => importStructureViewerScene(value)).toThrow('Structure Viewer scene import rejected: ordered layers require exactly one layer; multi-layer scenes are unsupported.');
    expect(value).toEqual(before);
  });

  it('uses source-only handoff terms and retains unsupported field names', () => {
    const value: any = input();
    value.sceneJson.volumes = [{ id: 'map' }];
    value.sceneJson.namedSelections = { site: {} };
    value.sceneJson.viewSettings = { shadows: true };
    const report = preflightInspectionScene(value.sceneJson);
    expect(report.unsupportedFeatures).toEqual([
      'Maps (volumes): volumes is not supported by the single-structure Stereofold importer.',
      'namedSelections are unsupported.',
      'viewSettings and shared representationOptions are unsupported.',
    ]);
    expect(report.message).toContain('does not carry selection, camera, appearance, layers, annotations, maps or measurements; it is not a matching scene or a live link.');
    expect(report.message).not.toContain('existing source-only');
  });

  it('discloses residue granularity when multiple source atoms collapse to the same residue', () => {
    const value: any = input();
    value.sceneJson.selection.atomIds.push('atom-2');
    value.target.atomIdToSelectionKey['atom-2'] = 'residue-key-1';
    const report = preflightInspectionScene(value.sceneJson, value);
    expect(report.disclosure.selectionGranularity).toBe('residues');
    expect(report.disclosure.selection).toContain('collapse to one selected residue');
    expect(importStructureViewerScene(value).scene.selectionKeys).toEqual(['residue-key-1']);
    expect(report.disclosure.camera).toContain('retain the local camera baseline');
    expect(report.disclosure.appearance).toContain('labels are off');
    value.sceneJson.selection.atomIds = [];
    expect(preflightInspectionScene(value.sceneJson, value).disclosure.selectionGranularity).toBe('none');
    expect(importStructureViewerScene(value).scene.selectionKeys).toEqual([]);
  });

  it('agrees with the importer over the same supported and rejected fixtures', () => {
    const fixtures: [string, (value: any) => void][] = [
      ['supported', () => {}], ['empty selection', value => { value.sceneJson.selection.atomIds = []; }],
      ['complete query', value => { value.sceneJson.selection = { atomIds: [], atomIdsTruncated: true, atomCount: 1 }; value.target.queriedSelectionAtomIds = ['atom-1']; }],
      ...rejectedFixtures.map(([name, change]): [string, (value: any) => void] => [name, change]),
    ];
    for (const [name, change] of fixtures) {
      const value: any = input(); change(value);
      let imported = false;
      try { importStructureViewerScene(value); imported = true; } catch { /* Expected for rejected fixtures. */ }
      const preflight = preflightInspectionScene(value.sceneJson, value);
      expect(preflight.supported, name).toBe(imported);
      expect(preflight.unsupportedFeatures.length === 0, name).toBe(imported);
    }
  });

});

it.each([.01, 8, 100])('imports an explored uniform scale %s beyond the old comfort range', scale => {
  const value = input();
  value.sceneJson.objects[0].matrix = [scale,0,0,0,0,scale,0,0,0,0,scale,0,200,0,0,1];
  const placement = importStructureViewerScene(value).scene.inspection.placement;
  expect(placement.scale).toBe(scale);
  expect(placement.translation[0]).toBeCloseTo(20 + scale - 1);
});
