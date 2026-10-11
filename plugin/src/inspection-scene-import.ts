// @ts-ignore Shared numerical placement guardrails used by the renderer.
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../../lab/browser-roundtrip/placement-limits.mjs';
import { createHash } from 'node:crypto';
import { sceneSchema, type InspectionScene } from './inspection-contract.js';
// @ts-ignore Shared component classification also drives the headset's visibility.
import { componentClassOf } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

/**
 * The narrow, portable intersection between Structure Viewer's SceneState v2
 * export and a saved Stereofold inspection. This is deliberately a snapshot
 * adapter: neither plugin publishes a state subscription or a common session.
 *
 * A controller can pair two exports by reading scene revision R, exporting
 * both artifacts with expectedRevision R, and requiring sceneJson.revision R.
 * Scene JSON itself nevertheless carries no coordinate bytes, coordinate
 * digest, or dependency manifest. This helper validates caller-supplied
 * artifact bytes and declarations; it does not read export receipts, discover,
 * or watch a Structure Viewer session.
 */
export type StructureViewerCoordinateAsset = {
  format: 'selection-mmcif';
  text: string;
  sha256: string;
  sourceObjectId: string;
  /** Caller-declared expectedRevision used for both exports. */
  expectedSceneRevision: number;
  /** Caller-parsed coordinate-export provenance that establishes retained IDs. */
  coordinateProvenance: {
    identityPreserving: true;
    generatedAtomIdentifierCount: 0;
    generatedModelCount: 0;
    namespacedAtomIdentifierCount: 0;
    remappedModelCount: 0;
  };
  /** Verified native selection export has baked its one assembly copy into atom positions. */
  assemblyBakedIntoCoordinates?: true;
};

/** Values derived after Stereofold has parsed the exact coordinate asset. */
export type StereofoldImportTarget = {
  sourceSha256: string;
  modelNumber: number;
  assemblyId: string;
  molecularCenterAngstrom: readonly [number, number, number];
  molecularRadiusAngstrom: number;
  /** A complete local camera snapshot captured after loading the exact asset. */
  cameraBaseline: InspectionScene['camera'];
  /**
   * The existing target catalog must resolve every upstream selected atom ID
   * before an import can preserve selection. There is no public cross-plugin
   * atom-ID mapping, so this adapter never fabricates one.
   */
  atomIdToSelectionKey: Readonly<Record<string, string>>;
  /** Exact current-selection atom IDs from revision-bound structure.query pages. */
  queriedSelectionAtomIds?: readonly string[];
  /** Server-owned rows from the loaded coordinate catalog. */
  catalogRows?: readonly { key: string; entityType: string; identity: { componentId: string; modelNumber: number } }[];
};

export type ImportedInspectionScene = {
  coordinate: { format: 'mmcif'; text: string; sha256: string };
  scene: InspectionScene;
};

const HEX = /^#[0-9a-f]{6}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EPSILON = 1e-6;

function fail(message: string): never { throw Error(`Structure Viewer scene import rejected: ${message}`); }
function object(value: unknown, name: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  return value as Record<string, any>;
}
function array(value: unknown, name: string): any[] {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  return value;
}
function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be finite.`);
  return value;
}
function vector(value: unknown, name: string): [number, number, number] {
  const values = array(value, name);
  if (values.length !== 3) fail(`${name} must contain three numbers.`);
  return [finite(values[0], `${name}[0]`), finite(values[1], `${name}[1]`), finite(values[2], `${name}[2]`)];
}
function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function isEmptyRecord(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}
function assertEmpty(scene: Record<string, any>, key: string): void {
  const value = scene[key];
  if (Array.isArray(value) ? value.length !== 0 : value !== undefined && value !== null && !isEmptyRecord(value)) {
    fail(`${key} is not supported by the single-structure Stereofold importer.`);
  }
}
function assertNoFocus(scene: Record<string, any>): void {
  const focus = object(scene.focus, 'focus');
  const atomIds = array(focus.atomIds, 'focus.atomIds');
  if (atomIds.length !== 0 || focus.atomIdsTruncated === true || focus.expression !== null || focus.summary !== null || (focus.atomCount !== undefined && focus.atomCount !== 0))
    fail('focus is unsupported by the Stereofold inspection scene.');
}

function retainedSelectionAtomIds(selection: Record<string, any>): string[] {
  const atomIds = array(selection.atomIds, 'selection.atomIds');
  if (!atomIds.every(value => typeof value === 'string' && value.length > 0)) fail('selection.atomIds must contain exact nonempty atom IDs.');
  if (new Set(atomIds).size !== atomIds.length) fail('selection.atomIds contains duplicate atom IDs.');
  return atomIds;
}

function sourceSelection(scene: Record<string, any>, queriedAtomIds?: readonly string[]): string[] {
  const selection = object(scene.selection, 'selection');
  const atomIds = retainedSelectionAtomIds(selection);
  if (selection.atomIdsTruncated === true) {
    if (!Array.isArray(queriedAtomIds) || !queriedAtomIds.every(value => typeof value === 'string' && value.length > 0)
      || new Set(queriedAtomIds).size !== queriedAtomIds.length || selection.atomCount !== queriedAtomIds.length)
      fail('truncated selection.atomIds requires complete unique revision-bound atom query results matching selection.atomCount.');
    return [...queriedAtomIds];
  }
  if (queriedAtomIds !== undefined && !sameArray(atomIds, queriedAtomIds)) fail('queried selection atom IDs do not exactly match SceneState selection.atomIds.');
  return atomIds;
}

function targetIsAll(target: unknown, sourceObjectId: unknown): boolean {
  const value = object(target, 'layers[0].target');
  const keys = Object.keys(value);
  return value.kind === 'all' && (keys.length === 1
    || keys.length === 2 && keys.includes('objectId') && value.objectId === sourceObjectId);
}
const HIDDEN_COMPONENTS = ['water', 'ligand', 'ion'] as const;
// Structure Viewer 0.1.90's XPt classifier uses these IDs for non-polymer atoms.
const STRUCTURE_VIEWER_ION_IDS = new Set(['BR', 'CA', 'CD', 'CL', 'CO', 'CU', 'FE', 'K', 'MG', 'MN', 'NA', 'NI', 'ZN']);
const STRUCTURE_VIEWER_WATER_IDS = new Set(['DOD', 'H2O', 'HOH', 'SOL', 'WAT']);
export const LIGAND_STYLE_DIFFERENCE = 'Ligands are shown as ball-and-stick; Structure Viewer drew bond-only sticks.';
function structureViewerComponentClass(row: NonNullable<StereofoldImportTarget['catalogRows']>[number]): string | undefined {
  const type = row.entityType?.trim().toLowerCase();
  const id = row.identity.componentId?.trim().toUpperCase() ?? '';
  if (type === 'polymer') return 'polymer';
  if (type === 'water' || STRUCTURE_VIEWER_WATER_IDS.has(id)) return 'water';
  if (type === 'non-polymer' || type === 'branched') return STRUCTURE_VIEWER_ION_IDS.has(id) ? 'ion' : 'ligand';
  return undefined;
}
function componentTarget(target: unknown, component: string, objectId: unknown): boolean {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const value = target as Record<string, unknown>;
  return Object.keys(value).length === 3 && value.kind === 'component' && value.component === component && value.objectId === objectId;
}
function layerHiddenClasses(target: unknown, objectId: unknown): string[] | undefined {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  if (targetIsAll(target, objectId)) return [];
  return excludedClasses(target, value => targetIsAll(value, objectId), objectId);
}
function excludedClasses(target: unknown, base: (value: unknown) => boolean, objectId: unknown): string[] | undefined {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const value = target as Record<string, any>;
  if (Object.keys(value).length !== 2 || value.kind !== 'allOf' || !Array.isArray(value.expressions)
    || value.expressions.length !== 2 || !base(value.expressions[0])) return undefined;
  const exclusion = value.expressions[1];
  if (!exclusion || Object.keys(exclusion).length !== 2 || exclusion.kind !== 'not') return undefined;
  const excluded = exclusion.expression?.kind === 'anyOf' && Object.keys(exclusion.expression).length === 2
    && Array.isArray(exclusion.expression.expressions) ? exclusion.expression.expressions : [exclusion.expression];
  if (!excluded.length || excluded.length > HIDDEN_COMPONENTS.length) return undefined;
  const classes: string[] = [];
  for (const expression of excluded) {
    const name = HIDDEN_COMPONENTS.find(component => componentTarget(expression, component, objectId));
    if (!name || classes.includes(name)) return undefined;
    classes.push(name);
  }
  return HIDDEN_COMPONENTS.filter(name => classes.includes(name));
}
function componentHiddenClasses(target: unknown, component: string, objectId: unknown): string[] | undefined {
  if (componentTarget(target, component, objectId)) return [];
  return excludedClasses(target, value => componentTarget(value, component, objectId), objectId);
}
function defaultPolymerLayer(layer: any, objectId: unknown): boolean {
  return layer?.id === 'primary-display' && layer.name === 'Primary structure' && layer.representation === 'cartoon'
    && componentHiddenClasses(layer.target, 'polymer', objectId) !== undefined;
}
function defaultLigandLayer(layer: any, objectId: unknown): boolean {
  return layer?.id === 'primary-ligand-display' && layer.name === 'Ligands' && layer.representation === 'sticks'
    && componentHiddenClasses(layer.target, 'ligand', objectId) !== undefined && layer.color?.kind === 'element' && layer.opacity === 1;
}
function defaultColor(color: any): boolean {
  return color && typeof color === 'object' && !Array.isArray(color)
    && (color.kind === 'uniform'
      ? Object.keys(color).length === 2 && typeof color.value === 'string' && HEX.test(color.value)
      : Object.keys(color).length === 1 && colorMap[color.kind] !== undefined);
}
function defaultLayerFields(layer: any, keys: readonly string[]): boolean {
  return Object.keys(layer).every(key => keys.includes(key)) && layer.visible === true && layer.labels === false
    && defaultColor(layer.color) && layer.labelMode === undefined && isEmptyRecord(layer.representationOptions) && isEmptyRecord(layer.colorOverrides);
}
function isDefaultLigandScene(layers: any[], objectId: unknown): boolean {
  const common = ['id', 'name', 'visible', 'target', 'labels', 'opacity', 'representation', 'color'];
  return (layers.length === 2 || layers.length === 1) && defaultPolymerLayer(layers[0], objectId)
    && defaultLayerFields(layers[0], common) && layers[0].opacity === 1
    && (layers.length === 1 || defaultLigandLayer(layers[1], objectId) && defaultLayerFields(layers[1], common)
      && sameArray(componentHiddenClasses(layers[0].target, 'polymer', objectId)!, componentHiddenClasses(layers[1].target, 'ligand', objectId)!));
}
type AdmissionCheck = { run: () => unknown; feature?: string };
const representationMap: Record<string, InspectionScene['inspection']['appearance']['representation']> = {
  cartoon: 'cartoon', ball_and_stick: 'ball-and-stick', surface: 'molecular-surface', spheres: 'spacefill',
};
const colorMap: Record<string, InspectionScene['inspection']['appearance']['color']> = {
  chain: 'chain-id', element: 'element-symbol', residue: 'residue-name', sequence_id: 'sequence-id', uniform: 'uniform',
};

/** Ordered checks: importing throws the original first error; preflight collects them. */
function appearanceChecks(scene: Record<string, any>): AdmissionCheck[] {
  const layers = array(scene.layers, 'layers');
  const objectId = scene.objects?.[0]?.id;
  const defaultLigands = isDefaultLigandScene(layers, objectId);
  const checks: AdmissionCheck[] = [{ run: () => {
    if (layers.length !== 1 && !defaultLigands) fail('ordered layers require exactly one layer; multi-layer scenes are unsupported.');
  } }];
  layers.forEach((raw, index) => {
    const layer = () => object(raw, `layers[${index}]`);
    const name = typeof raw?.id === 'string' ? JSON.stringify(raw.id) : `#${index + 1}`;
    const feature = `Layer ${name} (${String(raw?.representation)})`;
    if (index > 0 && !defaultLigands) checks.push({ feature, run: () => fail('extra layers are unsupported.') });
    const add = (run: () => unknown) => checks.push({ feature, run });
    add(() => { if (layer().visible !== true) fail(`layers[${index}] must be visible.`); });
    add(() => { if (!defaultLigands && layerHiddenClasses(layer().target, objectId) === undefined) fail(`layers[${index}].target must be the complete single object.`); });
    add(() => { if (layer().labels === true || layer().labelMode !== undefined) fail('layer labels are unsupported; no annotation is silently dropped.'); });
    add(() => {
      const overrides = layer().colorOverrides;
      if (Array.isArray(overrides) ? overrides.length !== 0 : overrides !== undefined && overrides !== null && !isEmptyRecord(overrides))
        fail(`layers[${index}].colorOverrides are unsupported; selection colors cannot be carried into Stereofold.`);
    });
    add(() => { if (!isEmptyRecord(layer().representationOptions)) fail('layer representationOptions are unsupported.'); });
    add(() => { if (representationMap[layer().representation] === undefined && !(defaultLigands && index === 1)) fail(`representation ${JSON.stringify(layer().representation)} has no Stereofold equivalent.`); });
    add(() => {
      const color = object(layer().color, `layers[${index}].color`);
      if (colorMap[color.kind] === undefined) fail(`color ${JSON.stringify(color.kind)} has no Stereofold equivalent.`);
      if (color.kind === 'uniform' && (typeof color.value !== 'string' || !HEX.test(color.value))) fail('uniform color must be a six-digit hexadecimal color.');
    });
    add(() => {
      const opacity = finite(layer().opacity, `layers[${index}].opacity`);
      if (opacity < 0 || opacity > 1) fail(`layers[${index}].opacity must be between zero and one.`);
    });
  });
  checks.push({ run: () => { if (typeof scene.background !== 'string' || !HEX.test(scene.background)) fail('background must be a six-digit hexadecimal color.'); } });
  return checks;
}

function importedAppearance(scene: Record<string, any>) {
  for (const check of appearanceChecks(scene)) check.run();
  const layer = scene.layers[0], color = layer.color;
  return {
    representation: representationMap[layer.representation], color: colorMap[color.kind], uniformColor: color.kind === 'uniform' ? color.value.toUpperCase() : '#58DCC9',
    background: scene.background.toUpperCase(), opacity: layer.opacity, labels: false, highlightColor: '#F2C47C', clipping: 0, fog: 0,
  } as const;
}

function importedLayerDetails(scene: Record<string, any>, target: StereofoldImportTarget) {
  const layers = scene.layers as any[];
  const defaultLigands = isDefaultLigandScene(layers, scene.objects[0].id);
  const hidden = defaultLigands ? [...new Set([...(componentHiddenClasses(layers[0].target, 'polymer', scene.objects[0].id) ?? []), ...(layers.length === 1 ? ['ligand'] : [])])]
    : layerHiddenClasses(layers[0].target, scene.objects[0].id) ?? [];
  if (!target.catalogRows) {
    if (!defaultLigands && hidden.length === 0) return {};
    fail('loaded catalog rows are required to resolve component layers.');
  }
  const rows = target.catalogRows.filter(row => row.identity.modelNumber === target.modelNumber);
  for (const row of rows) {
    if (row.entityType === 'polymer') continue;
    const sourceClass = structureViewerComponentClass(row), targetClass = componentClassOf(row);
    if (!sourceClass || sourceClass !== targetClass)
      fail(`component ${JSON.stringify(row.identity.componentId)} is ${sourceClass ?? 'unclassified'} in Structure Viewer but ${targetClass ?? 'unclassified'} in Stereofold; matching component layers are unsupported.`);
  }
  if (!defaultLigands && hidden.length === 0) return {};
  const present = new Set(rows.map(structureViewerComponentClass).filter(Boolean));
  const hiddenClasses = HIDDEN_COMPONENTS.filter(name => hidden.includes(name) && present.has(name));
  const visibility = hiddenClasses.length
    ? { visibility: { hiddenChains: [], hiddenClasses, showOnlySelection: false } } : {};
  if (!defaultLigands || layers.length === 1 || hidden.includes('ligand')) return visibility;
  const selectionKeys = [...new Set(rows.filter(row => structureViewerComponentClass(row) === 'ligand').map(row => row.key))].sort();
  if (!selectionKeys.length || selectionKeys.length > 20_000 || selectionKeys.some(key => typeof key !== 'string' || !key.length))
    fail('the ligand layer requires 1–20,000 resolved ligand residue keys from the loaded catalog.');
  return { ...visibility, styles: [{ selectionKeys, representation: 'ball-and-stick' as const, color: 'element-symbol' as const, opacity: 1 }] };
}

function matrixTransform(matrixValue: unknown) {
  const matrix = array(matrixValue, 'objects[0].matrix');
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) fail('objects[0].matrix must be a finite 4×4 matrix.');
  if (Math.abs(matrix[3]) > EPSILON || Math.abs(matrix[7]) > EPSILON || Math.abs(matrix[11]) > EPSILON || Math.abs(matrix[15] - 1) > EPSILON)
    fail('objects[0].matrix must be affine.');
  const columns = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]];
  const scales = columns.map(column => Math.hypot(...column));
  if (scales.some(scale => scale < EPSILON) || scales.some(scale => Math.abs(scale - scales[0]) > EPSILON))
    fail('objects[0].matrix must have one positive uniform scale.');
  const scale = scales[0];
  if (scale < PLACEMENT_MIN_SCALE || scale > PLACEMENT_MAX_SCALE) fail('objects[0].matrix scale is outside Stereofold’s numerical placement range.');
  const rotation = columns.map(column => column.map(value => value / scale));
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = dot(rotation[0], [rotation[1][1] * rotation[2][2] - rotation[1][2] * rotation[2][1], rotation[1][2] * rotation[2][0] - rotation[1][0] * rotation[2][2], rotation[1][0] * rotation[2][1] - rotation[1][1] * rotation[2][0]]);
  if (Math.abs(dot(rotation[0], rotation[1])) > EPSILON || Math.abs(dot(rotation[0], rotation[2])) > EPSILON || Math.abs(dot(rotation[1], rotation[2])) > EPSILON || Math.abs(determinant - 1) > EPSILON)
    fail('objects[0].matrix must be a rigid, right-handed rotation with uniform scale; shear and reflections are unsupported.');
  return { matrix, scale, rotation };
}

function placementFromMatrix(matrixValue: unknown, center: readonly [number, number, number], radius: number) {
  const { matrix, scale, rotation } = matrixTransform(matrixValue);
  // Matrices use Mol*’s column-major convention. Stereofold composes Z·Y·X.
  const r00 = rotation[0][0], r10 = rotation[0][1], r20 = rotation[0][2], r01 = rotation[1][0], r11 = rotation[1][1], r21 = rotation[1][2], r22 = rotation[2][2];
  const y = Math.asin(Math.max(-1, Math.min(1, -r20)));
  const cosineY = Math.cos(y);
  const x = Math.abs(cosineY) > EPSILON ? Math.atan2(r21, r22) : 0;
  const z = Math.abs(cosineY) > EPSILON ? Math.atan2(r10, r00) : Math.atan2(-r01, r11);
  const transformedCenter = [
    matrix[0] * center[0] + matrix[4] * center[1] + matrix[8] * center[2],
    matrix[1] * center[0] + matrix[5] * center[1] + matrix[9] * center[2],
    matrix[2] * center[0] + matrix[6] * center[1] + matrix[10] * center[2],
  ];
  const translation = [matrix[12] + transformedCenter[0] - center[0], matrix[13] + transformedCenter[1] - center[1], matrix[14] + transformedCenter[2] - center[2]].map(value => value / radius) as [number, number, number];
  if (translation.some(value => Math.abs(value) > PLACEMENT_MAX_TRANSLATION)) fail('objects[0].matrix translation is outside Stereofold’s numerical placement range.');
  const degrees = [x, y, z].map(value => {
    const degrees = value * 180 / Math.PI;
    return Math.abs(degrees) < EPSILON ? 0 : degrees;
  }) as [number, number, number];
  return { translation, rotation: degrees, scale };
}

function cameraSnapshot(scene: Record<string, any>) {
  const camera = object(scene.camera, 'camera');
  if (camera.orientation !== undefined && camera.orientation !== 'current') fail('camera.orientation must be current; named reorientation is not an exact camera snapshot.');
  if (camera.mode !== 'perspective' && camera.mode !== 'orthographic') fail('camera.mode is unsupported.');
  const fovDegrees = finite(camera.fovDegrees, 'camera.fovDegrees');
  if (fovDegrees <= 0 || fovDegrees >= 180) fail('camera.fovDegrees is outside Stereofold’s camera range.');
  const position = vector(camera.position, 'camera.position'), target = vector(camera.target, 'camera.target'), up = vector(camera.up, 'camera.up');
  const direction = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  if (Math.hypot(...direction) <= EPSILON || Math.hypot(...up) <= EPSILON) fail('camera must have a nonzero viewing direction and up vector.');
  // SceneState normally includes clippingRadius and nearClip. A source clip
  // plane can be omitted only after the loaded coordinate bounds prove it
  // cannot cut the molecule; assertUnclippedCamera performs that check.
  if (camera.clippingRadius !== undefined && finite(camera.clippingRadius, 'camera.clippingRadius') <= 0)
    fail('camera.clippingRadius must be positive.');
  if (camera.nearClip !== undefined && finite(camera.nearClip, 'camera.nearClip') < 0)
    fail('camera.nearClip must be nonnegative.');
  if (camera.farClip !== undefined && finite(camera.farClip, 'camera.farClip') < 0)
    fail('camera.farClip must be nonnegative.');
  if (camera.nearClip !== undefined && camera.farClip !== undefined && camera.farClip <= camera.nearClip)
    fail('camera.farClip must be greater than camera.nearClip.');
  if (camera.focus !== undefined || camera.zoom !== undefined)
    fail('camera focus and zoom have no equivalent Stereofold snapshot field.');
  return { mode: camera.mode, fov: fovDegrees * Math.PI / 180, position, target, up };
}

function assertUnclippedCamera(scene: Record<string, any>, target: StereofoldImportTarget): void {
  const camera = object(scene.camera, 'camera');
  const pose = cameraSnapshot(scene);
  const center = vector(target.molecularCenterAngstrom, 'target.molecularCenterAngstrom');
  const radius = finite(target.molecularRadiusAngstrom, 'target.molecularRadiusAngstrom');
  if (radius <= 0) fail('target.molecularRadiusAngstrom must be positive.');
  const tolerance = Math.max(1e-3, radius * 1e-3);
  const offset = center.map((value, index) => value - pose.target[index]);
  if (camera.clippingRadius !== undefined && camera.clippingRadius + tolerance < Math.hypot(...offset) + radius)
    fail('camera.clippingRadius may cut the parsed structure; a matching scene cannot drop that clipping.');
  const forward = pose.target.map((value, index) => value - pose.position[index]);
  const length = Math.hypot(...forward);
  const depth = center.reduce((sum, value, index) => sum + (value - pose.position[index]) * forward[index] / length, 0);
  if (camera.nearClip !== undefined && camera.nearClip > depth - radius + tolerance)
    fail('camera.nearClip may cut the parsed structure; a matching scene cannot drop that clipping.');
  if (camera.farClip !== undefined && camera.farClip < depth + radius - tolerance)
    fail('camera.farClip may cut the parsed structure; a matching scene cannot drop that clipping.');
}

function importedCamera(scene: Record<string, any>, baseline: InspectionScene['camera']) {
  return sceneSchema.shape.camera.parse({ ...baseline, ...cameraSnapshot(scene) });
}

function sceneSubsetChecks(scene: Record<string, any>): AdmissionCheck[] {
  return [
    { run: () => { if (scene.version !== 2) fail('scene JSON must be a SceneState v2 object.'); } },
    ...['annotations', 'measurements', 'volumes', 'analyses', 'assemblySymmetry', 'sceneGuides', 'qualityAssessment', 'storyboard', 'savedScenes', 'dirtyDerivedObjectIds'].map(key => ({
      feature: key === 'volumes' ? 'Maps (volumes)' : undefined, run: () => assertEmpty(scene, key),
    })),
    { run: () => assertNoFocus(scene) },
    { run: () => { if (scene.trajectory !== null) fail('trajectory state is unsupported.'); } },
    { run: () => { if (!isEmptyRecord(scene.namedSelections)) fail('namedSelections are unsupported.'); } },
    { run: () => { if (!isEmptyRecord(scene.viewSettings) || !isEmptyRecord(scene.representationOptions)) fail('viewSettings and shared representationOptions are unsupported.'); } },
    { run: () => { if (scene.lighting !== 'studio') fail('only the default studio lighting is accepted; Stereofold has no lighting transfer field.'); } },
    { run: () => { if (array(scene.objects, 'objects').length !== 1) fail('objects requires exactly one structure; multi-object scenes are unsupported.'); } },
  ];
}

function assertSourceObject(source: Record<string, any>): void {
  if (source.primary !== true || source.visible !== true || source.derived === true || source.frameCount !== 1) fail('the sole object must be a visible, non-derived, single-frame primary structure.');
}

function assertSceneSubset(scene: Record<string, any>, target: StereofoldImportTarget, coordinate: StructureViewerCoordinateAsset): void {
  for (const check of sceneSubsetChecks(scene)) check.run();
  const source = object(array(scene.objects, 'objects')[0], 'objects[0]');
  if (source.id !== coordinate.sourceObjectId) fail('coordinate sourceObjectId does not match the sole scene object.');
  assertSourceObject(source);
  assertConstruction(source, target, coordinate.assemblyBakedIntoCoordinates === true);
  assertUnclippedCamera(scene, target);
}

function assertConstruction(source: Record<string, any>, target?: StereofoldImportTarget, assemblyBaked = false): void {
  const construction = source.construction;
  if (construction === undefined) fail('objects[0].construction is required to verify the parsed model and assembly.');
  const value = object(construction, 'objects[0].construction');
  const options = object(source.constructionOptions, 'objects[0].constructionOptions');
  const models = array(options.models, 'objects[0].constructionOptions.models');
  const modelNumber = target?.modelNumber ?? models.find(candidate => candidate?.index === value.modelIndex)?.modelNumber;
  const assemblyId = target?.assemblyId ?? (value.kind === 'assembly' ? value.assemblyId : 'asymmetric_unit');
  if (!models.some(candidate => candidate?.index === value.modelIndex && candidate?.modelNumber === modelNumber))
    fail('source construction modelIndex does not match the parsed target modelNumber.');
  if (value.kind === 'assembly') {
    const declared = array(options.assemblies, 'objects[0].constructionOptions.assemblies').some(candidate => candidate?.id === value.assemblyId);
    const flattened = assemblyBaked && assemblyId === 'asymmetric_unit' && options.operatorsTruncated === false
      && options.operatorCount === 1 && Array.isArray(options.operators) && options.operators.length === 1
      && options.operators[0]?.assemblyId === value.assemblyId && options.operators[0]?.modelNumber === modelNumber;
    if (!declared || value.assemblyId !== assemblyId && !flattened)
      fail('source assembly does not match an available parsed target assembly.');
  } else if (value.kind === 'model') {
    if (assemblyId !== 'asymmetric_unit') fail('a source model construction requires the target asymmetric_unit assembly.');
  } else fail('source construction is unsupported.');
}

/**
 * Import one bounded single-object SceneState v2 snapshot. This does not verify
 * a receipt or expose an import feature; callers must authenticate the paired
 * export transaction before passing data here. Unsupported state is rejected
 * so callers cannot mistake a coordinate-only fallback for a complete scene.
 */
export function importStructureViewerScene(input: { sceneJson: unknown; coordinate: StructureViewerCoordinateAsset; target: StereofoldImportTarget }): ImportedInspectionScene {
  const { coordinate, target } = input;
  if (coordinate.format !== 'selection-mmcif') fail('only an explicit selection-mmcif coordinate export is supported.');
  if (typeof coordinate.text !== 'string' || !/^\s*data_\S+/i.test(coordinate.text) || !/_atom_site\./i.test(coordinate.text)) fail('coordinate asset must be complete mmCIF text.');
  const digest = createHash('sha256').update(coordinate.text, 'utf8').digest('hex');
  if (!SHA256.test(coordinate.sha256) || digest !== coordinate.sha256) fail('coordinate sha256 does not match the supplied exact bytes.');
  if (!SHA256.test(target.sourceSha256) || target.sourceSha256 !== digest) fail('target sourceSha256 does not identify the supplied exact coordinate bytes.');
  const radius = finite(target.molecularRadiusAngstrom, 'target.molecularRadiusAngstrom');
  if (radius <= 0) fail('target.molecularRadiusAngstrom must be positive.');
  const center = vector(target.molecularCenterAngstrom, 'target.molecularCenterAngstrom');
  if (!Number.isSafeInteger(target.modelNumber) || target.modelNumber < 1 || typeof target.assemblyId !== 'string' || target.assemblyId.length === 0) fail('target model and assembly identity are invalid.');
  const scene = object(input.sceneJson, 'sceneJson');
  if (!Number.isSafeInteger(coordinate.expectedSceneRevision) || coordinate.expectedSceneRevision < 0 || scene.revision !== coordinate.expectedSceneRevision)
    fail('scene JSON revision must equal the shared expectedRevision of both exports.');
  const provenance = object(coordinate.coordinateProvenance, 'coordinateProvenance');
  if (provenance.identityPreserving !== true || ['generatedAtomIdentifierCount', 'generatedModelCount', 'namespacedAtomIdentifierCount', 'remappedModelCount'].some(key => provenance[key] !== 0))
    fail('coordinate provenance must prove identityPreserving with no generated, namespaced, or remapped IDs.');
  assertSceneSubset(scene, target, coordinate);
  const upstreamAtomIds = sourceSelection(scene, target.queriedSelectionAtomIds);
  const selectionKeys = [...new Set(upstreamAtomIds.map(atomId => target.atomIdToSelectionKey[atomId]))];
  if (!selectionKeys.every(key => typeof key === 'string' && key.length > 0) || new Set(selectionKeys).size !== selectionKeys.length || selectionKeys.length > 20_000)
    fail('every selected source atom ID must resolve to a unique, nonempty target catalog key (at most 20,000).');
  const result = {
    sourceSha256: digest, modelNumber: target.modelNumber, assemblyId: target.assemblyId, selectionKeys,
    camera: importedCamera(scene, target.cameraBaseline), inspection: { appearance: importedAppearance(scene), placement: placementFromMatrix(object(array(scene.objects, 'objects')[0], 'objects[0]').matrix, center, radius),
      ...importedLayerDetails(scene, target) },
  };
  // Keep this adapter coupled to the real inspector boundary rather than a
  // second, broader scene shape.
  return { coordinate: { format: 'mmcif', text: coordinate.text, sha256: digest }, scene: sceneSchema.parse(result) };
}

export type InspectionScenePreflight = {
  supported: boolean;
  /** Scene-only admission is provisional until the parsed target is available. */
  scope: 'scene' | 'complete-input';
  unsupportedFeatures: string[];
  pendingChecks: string[];
  renderingDifference?: string;
  disclosure: {
    selectionGranularity: 'residues' | 'none';
    selection: string;
    camera: string;
    appearance: string;
    doesNotCarry: readonly string[];
  };
  outcome: 'open matching scene' | 'structure-only alternative';
  message: string;
};

/**
 * Pure admission report. Before loading, pass the scene alone; supported then
 * means the scene subset is supported, with explicit pending asset/target checks.
 * With the exact coordinate and parsed target, this runs the importer itself as
 * well, including hashes, provenance, mapping, placement and final schema checks.
 * No fallback import or state mutation is performed.
 */
export function preflightInspectionScene(sceneJson: unknown, context?: {
  coordinate: StructureViewerCoordinateAsset; target: StereofoldImportTarget;
}): InspectionScenePreflight {
  const unsupportedFeatures: string[] = [];
  const pendingChecks: string[] = [];
  const collect = ({ run, feature }: AdmissionCheck) => {
    try { run(); } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/^Structure Viewer scene import rejected: /, '');
      const message = feature ? `${feature}: ${reason}` : reason;
      if (!unsupportedFeatures.includes(message)) unsupportedFeatures.push(message);
    }
  };
  let hasSelection = false;
  let requestedRepresentation = 'unknown';
  let renderingDifference: string | undefined;
  collect({ run: () => {
    const scene = object(sceneJson, 'sceneJson');
    requestedRepresentation = String(scene.layers?.[0]?.representation ?? 'unknown');
    if (Array.isArray(scene.layers) && scene.layers.length === 2
      && isDefaultLigandScene(scene.layers, scene.objects?.[0]?.id)) renderingDifference = LIGAND_STYLE_DIFFERENCE;
    hasSelection = Array.isArray(scene.selection?.atomIds) && scene.selection.atomIds.length > 0
      || scene.selection?.atomIdsTruncated === true && scene.selection?.atomCount !== 0;
    for (const check of sceneSubsetChecks(scene)) collect(check);
    collect({ run: () => {
      const source = object(array(scene.objects, 'objects')[0], 'objects[0]');
      collect({ run: () => assertSourceObject(source) });
      collect({ run: () => assertConstruction(source, context?.target, context?.coordinate.assemblyBakedIntoCoordinates === true) });
      collect({ run: () => matrixTransform(source.matrix) });
    } });
    collect({ run: () => {
      if (!context && scene.selection?.atomIdsTruncated === true) {
        // Retained IDs must still be valid; completeness waits for the resolver.
        retainedSelectionAtomIds(object(scene.selection, 'selection'));
        pendingChecks.push('selection.atomIds is truncated; verify complete unique revision-bound query IDs matching selection.atomCount.');
      } else sourceSelection(scene, context?.target.queriedSelectionAtomIds);
    } });
    collect({ run: () => { cameraSnapshot(scene); if (context) assertUnclippedCamera(scene, context.target); } });
    collect({ run: () => { for (const check of appearanceChecks(scene)) collect(check); } });
  } });
  // The complete-input verdict cannot drift from the actual importer, including
  // validation dependent on loaded coordinates that a scene alone cannot prove.
  let supported = unsupportedFeatures.length === 0;
  if (context) {
    let imported = false;
    collect({ run: () => { importStructureViewerScene({ sceneJson, ...context }); imported = true; } });
    supported = imported;
  }
  if (!context) pendingChecks.push(
    'Verify coordinate bytes, digest, shared revision and identity-preserving provenance.',
    'Verify model, assembly, selection mapping, placement bounds and local camera baseline.',
    'Verify clippingRadius, nearClip and farClip do not cut the parsed structure.',
  );
  if (!context && Array.isArray((sceneJson as any)?.layers)
    && (renderingDifference || layerHiddenClasses((sceneJson as any).layers[0]?.target, (sceneJson as any).objects?.[0]?.id)?.length))
    pendingChecks.push('Resolve component classes and ligand residue keys from the loaded coordinate catalog.');
  const disclosure: InspectionScenePreflight['disclosure'] = {
    selectionGranularity: hasSelection ? 'residues' : 'none',
    selection: hasSelection
      ? [
        'Selection carries residues.',
        'Atoms in the same residue collapse to one selected residue.',
        'Atom or chain granularity does not transfer.',
        'selection.expression and namedSelections do not transfer.',
      ].join('\n')
      : 'Selection is empty.',
    camera: [
      'Camera carries mode, position, target, up and fovDegrees.',
      'radius and radiusMax retain the local camera baseline.',
      'fog and clipFar retain the local camera baseline.',
      'minNear and minFar retain the local camera baseline.',
      'Camera clippingRadius, nearClip and farClip are omitted only when the parsed structure proves they cannot cut the molecule.',
      'Camera focus and zoom do not transfer.',
    ].join('\n'),
    appearance: [
      `Requested representation: ${requestedRepresentation}.`,
      'The headset may draw cartoon for dense scenes.',
      'color, opacity and background transfer.',
      'placement carries translation, rigid rotation and uniform scale.',
      'labels are off.',
      'highlightColor is #F2C47C.',
      'clipping and fog are zero.',
      ...(renderingDifference ? [renderingDifference] : []),
    ].join('\n'),
    doesNotCarry: [
      'atom-level selection granularity', 'selection.expression', 'layer labels',
      'representationOptions', 'colorOverrides', 'layers beyond the default polymer and ligand pair', 'annotations', 'volumes (maps)',
      'measurements', 'camera clippingRadius/nearClip/farClip', 'live synchronization',
    ],
  };
  const outcome = supported ? 'open matching scene' : 'structure-only alternative';
  const message = (supported ? [
    'Open matching scene (supported subset).',
    ...(pendingChecks.length ? ['Admission is provisional.', ...pendingChecks] : []),
    disclosure.selection, disclosure.camera, disclosure.appearance,
  ] : [
    'Matching scene is unsupported:', ...unsupportedFeatures,
    'Structure-only alternative: open the coordinate file with stereo_structure.inspect_file.',
    'This does not carry selection, camera, appearance, layers, annotations, maps or measurements; it is not a matching scene or a live link.',
  ]).join('\n');
  return { supported, scope: context ? 'complete-input' : 'scene', unsupportedFeatures, pendingChecks, renderingDifference, disclosure, outcome, message };
}

export const STRUCTURE_VIEWER_SCENE_IMPORT_CAPABILITIES = Object.freeze({
  source: 'Structure Viewer SceneState v2 + selection-mmcif coordinate export',
  preserves: ['one primary single-frame structure', 'current camera pose and field of view', 'one full-object layer or the default polymer cartoon and ligand sticks pair', 'hidden water, ligand and ion classes', 'chain/element/residue/sequence/uniform colors', 'opacity', 'background', 'resolved residue selection keys (not atom or chain granularity)', 'rigid uniform object placement'],
  rejects: ['multiple or derived objects', 'maps', 'trajectories', 'layers beyond the default polymer and ligand pair', 'annotations', 'measurements', 'analyses', 'named selections', 'targets outside the sole object', 'unsupported styles', 'camera clipping that may cut the parsed structure', 'camera focus/zoom', 'unresolved selection IDs or truncated IDs without complete revision-bound query results', 'layer labels', 'colorOverrides', 'layer/shared representation options', 'non-default lighting', 'focus', 'view settings', 'assembly symmetry', 'scene guides', 'quality assessment', 'storyboards', 'saved scenes', 'dirty derived objects', 'invalid placement', 'unverified model/assembly or coordinate identity'],
} as const);
