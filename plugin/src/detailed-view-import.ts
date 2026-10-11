import { sceneSchema, type InspectionScene } from './inspection-contract.js';
// @ts-ignore Shared JavaScript science module, also used by the panel.
import { cameraSnapshot } from '../../lab/browser-roundtrip/camera-snapshot.mjs';
// @ts-ignore Shared pure figure appearance policy used by the inspector.
import { withFigureRepresentation } from '../../lab/browser-roundtrip/lesson-figure-appearance.mjs';

/**
 * Reads a Mol* plugin state snapshot saved by the full viewer's Download State
 * and projects it onto the narrow inspection scene the cinematic panel can
 * actually render.
 *
 * This is a projection, not a load. A `.molj` is an arbitrary Mol* state tree:
 * many components, several representations, volumes, trajectories, extensions.
 * The panel's scene is four representations, five color themes, one opacity, a
 * placement and a selection. Anything outside that intersection is reported as
 * dropped rather than silently approximated, and anything describing a
 * different structure is refused outright.
 */

export const REPRESENTATIONS = new Set(['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill']);
export const COLORS = new Set(['chain-id', 'element-symbol', 'residue-name', 'sequence-id', 'uniform']);
/** The largest state file worth parsing. A full viewer session is JSON, not coordinates. */
export const MAX_DETAILED_VIEW_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export type DetailedViewImport = {
  scene: InspectionScene;
  /** Human-readable notes about what the full viewer had that the panel cannot show. */
  dropped: string[];
  /** Which fields the projection actually changed, for the tool result text. */
  applied: string[];
};

function fail(message: string): never { throw Error(`Detailed view import rejected: ${message}`); }

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/** Mol* stores colors as a packed 0xRRGGBB number. */
function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffff) return undefined;
  return `#${value.toString(16).padStart(6, '0')}`;
}

export function parseDetailedViewSnapshotText(text: string): Record<string, any> {
  if (typeof text !== 'string') fail('the state file could not be read as text.');
  if (Buffer.byteLength(text, 'utf8') > MAX_DETAILED_VIEW_SNAPSHOT_BYTES) {
    fail(`the state file is larger than the ${MAX_DETAILED_VIEW_SNAPSHOT_BYTES / (1024 * 1024)} MB limit.`);
  }
  if (text.slice(0, 2) === 'PK') {
    fail('this is a .molx archive. In the full viewer choose Download State with the .molj format, which is plain JSON.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail('the state file is not valid JSON.'); }
  const snapshot = record(parsed);
  if (!snapshot) fail('the state file is not a Mol* state snapshot.');
  const entries = snapshot.entries;
  if (!Array.isArray(entries) || entries.length === 0) fail('the state snapshot contains no entries.');
  return snapshot;
}

/** The entry a returning user means is the one the viewer was showing, else the first. */
function chosenEntry(snapshot: Record<string, any>): Record<string, any> {
  const entries = snapshot.entries as any[];
  const current = typeof snapshot.current === 'string'
    ? entries.find(entry => record(entry)?.snapshot?.id === snapshot.current)
    : undefined;
  const entry = record(current) ?? record(entries[0]);
  const inner = entry && record(entry.snapshot);
  if (!inner) fail('the state snapshot entry has no plugin state.');
  return inner;
}

function transforms(entry: Record<string, any>): Record<string, any>[] {
  const list = record(entry.data)?.tree?.transforms;
  return Array.isArray(list) ? list.map(record).filter(Boolean) as Record<string, any>[] : [];
}

/**
 * The first structure representation wins. A full-viewer user who built several
 * is told which one was taken, because guessing between them silently would
 * make the returning scene look like a bug rather than a projection.
 */
function representationTransforms(entry: Record<string, any>) {
  return transforms(entry).filter(node => typeof node.transformer === 'string'
    && node.transformer.endsWith('structure-representation-3d')
    && !node.transformer.includes('from-'));
}

export function detailedViewImportFromSnapshot(snapshotJson: Record<string, any>, base: InspectionScene): DetailedViewImport {
  const current = sceneSchema.parse(base);
  const entry = chosenEntry(snapshotJson);
  const next: InspectionScene = structuredClone(current);
  const dropped: string[] = [];
  const applied: string[] = [];

  const entries = snapshotJson.entries as any[];
  if (entries.length > 1) dropped.push(`${entries.length - 1} further saved states in the file`);

  const camera = record(entry.camera)?.current;
  if (camera) {
    try {
      const validated = cameraSnapshot(camera);
      next.camera = sceneSchema.shape.camera.parse(validated);
      applied.push('camera');
    } catch (error) {
      dropped.push(`the camera (${error instanceof Error ? error.message : 'unreadable'})`);
    }
  } else dropped.push('the camera, which the state file did not record');

  const representations = representationTransforms(entry);
  if (representations.length > 1) dropped.push(`${representations.length - 1} further representations`);
  const params = record(representations[0]?.params);
  if (params) {
    const typeName = record(params.type)?.name;
    if (typeof typeName === 'string' && REPRESENTATIONS.has(typeName)) {
      if (typeName !== next.inspection.appearance.representation) {
        applied.push('representation');
        if (next.inspection.lessonFigure) next.inspection.lessonFigure = withFigureRepresentation(next.inspection.lessonFigure, typeName);
      }
      next.inspection.appearance.representation = typeName as InspectionScene['inspection']['appearance']['representation'];
    } else if (typeof typeName === 'string') dropped.push(`the ${typeName} representation, which the panel does not render`);

    const colorName = record(params.colorTheme)?.name;
    if (typeof colorName === 'string' && COLORS.has(colorName)) {
      if (colorName !== next.inspection.appearance.color) applied.push('color theme');
      next.inspection.appearance.color = colorName as InspectionScene['inspection']['appearance']['color'];
      const uniform = hexColor(record(record(params.colorTheme)?.params)?.value);
      if (colorName === 'uniform' && uniform) next.inspection.appearance.uniformColor = uniform;
    } else if (typeof colorName === 'string') dropped.push(`the ${colorName} color theme, which the panel does not offer`);

    const alpha = record(params.type)?.params?.alpha;
    if (typeof alpha === 'number' && Number.isFinite(alpha) && alpha > 0 && alpha <= 1) {
      if (alpha !== next.inspection.appearance.opacity) applied.push('opacity');
      next.inspection.appearance.opacity = alpha;
    }
  } else dropped.push('every representation, because the state file has no structure representation');

  const background = hexColor(record(record(record(entry.canvas3d)?.props)?.renderer)?.backgroundColor);
  if (background) {
    if (background !== next.inspection.appearance.background) applied.push('background');
    next.inspection.appearance.background = background;
  }

  // Selection travels as Mol* element bundles keyed to loci in the live
  // structure. There is no serialized form the server can map back to the
  // panel's canonical residue identities without loading the structure, so the
  // panel keeps the selection it already has and the user is told.
  if (record(entry.structureSelection)?.entries) dropped.push('the selection, which has no portable form outside a loaded structure');

  return {scene: sceneSchema.parse(next), dropped, applied};
}

export function detailedViewImport(text: string, base: InspectionScene): DetailedViewImport {
  return detailedViewImportFromSnapshot(parseDetailedViewSnapshotText(text), base);
}
