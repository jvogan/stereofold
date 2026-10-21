import { isDeepStrictEqual } from 'node:util';
// @ts-ignore Shared renderer default for an un-emphasized scene.
import { DEFAULT_CONTEXT_OPACITY } from '../../lab/browser-roundtrip/lesson-emphasis.mjs';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { assertInspectionBudget, MAX_INSPECTION_HYDRATION_BYTES, MAX_INSPECTION_SCENE_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import {
  importStructureViewerScene,
  preflightInspectionScene,
  type InspectionScenePreflight,
  type ImportedInspectionScene,
  type StereofoldImportTarget,
  type StructureViewerCoordinateAsset,
} from './inspection-scene-import.js';

/** The sidecar is a local declaration, not a signed Structure Viewer receipt. */
export const STRUCTURE_VIEWER_SCENE_FILE_KIND = 'structure-viewer-local-snapshot' as const;
export const MAX_STRUCTURE_VIEWER_PROVENANCE_BYTES = 64 * 1024;
import { MAX_MOLECULAR_LESSON_BYTES } from './molecular-lesson.js';
export { MAX_MOLECULAR_LESSON_BYTES };

const SHA256 = /^[a-f0-9]{64}$/;
const sceneFileDeclarationSchema = z.object({
  version: z.literal(1),
  kind: z.literal(STRUCTURE_VIEWER_SCENE_FILE_KIND),
  sceneSha256: z.string().regex(SHA256),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceObjectId: z.string().min(1).max(256),
  coordinate: z.object({
    format: z.literal('selection-mmcif'),
    sha256: z.string().regex(SHA256),
    coordinateProvenance: z.object({
      identityPreserving: z.literal(true),
      generatedAtomIdentifierCount: z.literal(0),
      generatedModelCount: z.literal(0),
      namespacedAtomIdentifierCount: z.literal(0),
      remappedModelCount: z.literal(0),
    }).strict(),
  }).strict(),
}).strict();

export type StructureViewerSceneFileDeclaration = z.output<typeof sceneFileDeclarationSchema>;

export type StructureViewerSceneFileBundle = {
  sceneJson: unknown;
  coordinate: StructureViewerCoordinateAsset;
  declaration: StructureViewerSceneFileDeclaration;
  /** Always `declared-local`; no receipt or live session was authenticated here. */
  provenanceStatus: 'declared-local';
};

const vectorSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const cameraBaselineSchema = z.object({
  mode: z.enum(['perspective', 'orthographic']), fov: z.number().finite(), position: vectorSchema,
  target: vectorSchema, up: vectorSchema, radius: z.number().finite(), radiusMax: z.number().finite(),
  fog: z.number().finite(), clipFar: z.boolean(), minNear: z.number().finite(), minFar: z.number().finite(),
}).strict();
/** Input boundary for the app-only resolver; all values are revalidated by the pure adapter. */
export const structureViewerImportTargetSchema = z.object({
  sourceSha256: z.string().regex(SHA256), modelNumber: z.number().int().positive(), assemblyId: z.string().min(1).max(128),
  molecularCenterAngstrom: vectorSchema, molecularRadiusAngstrom: z.number().finite().positive(),
  cameraBaseline: cameraBaselineSchema,
  atomIdToSelectionKey: z.record(z.string().min(1).max(256), z.string().min(1).max(4096)).refine(value => Object.keys(value).length <= 200_000, 'atomIdToSelectionKey is too large.'),
  queriedSelectionAtomIds: z.array(z.string().min(1).max(256)).max(20_000).optional(),
}).strict();

function reject(message: string): never { throw Error(`Structure Viewer local scene import rejected: ${message}`); }

function pathFor(path: unknown, extension: readonly string[]): string {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || !extension.includes(extname(path).toLowerCase()))
    reject(`path must be an absolute regular file with extension ${extension.join(' or ')}.`);
  return path;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

async function readStableBytes(filePath: string, limit: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) reject(`${filePath} exceeds its bounded artifact size.`);
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) reject(`${filePath} exceeds its bounded artifact size.`);
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size || length !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      reject(`${filePath} changed while it was being read.`);
    return Buffer.from(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Structure Viewer local scene import rejected:')) throw error;
    return reject(`cannot read ${filePath} as a stable regular file.`);
  } finally {
    await handle?.close();
  }
}

/** Shared bounded, stable local artifact boundary for native export pairs. */
export async function readBoundedSceneArtifact(filePath: string, extensions: readonly string[], limit: number): Promise<Buffer> {
  return readStableBytes(pathFor(filePath, extensions), limit);
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function decodeJson(bytes: Buffer, label: string): unknown {
  let text: string;
  try { text = decoder.decode(bytes); } catch { reject(`${label} must be valid UTF-8 JSON.`); }
  try { return JSON.parse(text); } catch { reject(`${label} must contain valid JSON.`); }
}

/** Read one bounded local lesson JSON file without following its final path component. */
export async function readBoundedJsonFile(filePath: string, limit = MAX_MOLECULAR_LESSON_BYTES): Promise<unknown> {
  const path = pathFor(filePath, ['.json']);
  return decodeJson(await readStableBytes(path, limit), 'lesson artifact');
}

function assertCoordinateText(text: string): void {
  if (!/^data_\S*/im.test(text.trimStart()) || !/_atom_site\./i.test(text)) reject('coordinate artifact is not supported mmCIF text.');
}

/**
 * Read a raw SceneState JSON export, a selection-mmcif export, and an explicit
 * local declaration pairing them. The declaration is checked for consistency,
 * but it is intentionally reported as unauthenticated local metadata.
 */
export async function readStructureViewerSceneFiles(input: {
  scenePath: string;
  coordinatePath: string;
  provenancePath: string;
}): Promise<StructureViewerSceneFileBundle> {
  const scenePath = pathFor(input.scenePath, ['.json']);
  const coordinatePath = pathFor(input.coordinatePath, ['.cif', '.mmcif']);
  const provenancePath = pathFor(input.provenancePath, ['.json']);
  const [sceneBytes, coordinateBytes, provenanceBytes] = await Promise.all([
    readStableBytes(scenePath, MAX_INSPECTION_SCENE_BYTES),
    readStableBytes(coordinatePath, MAX_STRUCTURE_SOURCE_BYTES),
    readStableBytes(provenancePath, MAX_STRUCTURE_VIEWER_PROVENANCE_BYTES),
  ]);
  const sceneJson = decodeJson(sceneBytes, 'scene artifact');
  const declaration = sceneFileDeclarationSchema.parse(decodeJson(provenanceBytes, 'provenance sidecar'));
  const sceneSha256 = digest(sceneBytes);
  const coordinateSha256 = digest(coordinateBytes);
  if (declaration.sceneSha256 !== sceneSha256) reject('sceneSha256 does not match the exact scene artifact bytes.');
  if (declaration.coordinate.sha256 !== coordinateSha256) reject('coordinate sha256 does not match the exact coordinate artifact bytes.');
  let coordinateText: string;
  try { coordinateText = decoder.decode(coordinateBytes); } catch { reject('coordinate artifact must be valid UTF-8 mmCIF text.'); }
  assertCoordinateText(coordinateText);
  const coordinate: StructureViewerCoordinateAsset = {
    format: declaration.coordinate.format,
    text: coordinateText,
    sha256: coordinateSha256,
    sourceObjectId: declaration.sourceObjectId,
    expectedSceneRevision: declaration.expectedRevision,
    coordinateProvenance: declaration.coordinate.coordinateProvenance,
  };
  // The SCENE half of the pair is what stays inline in a
  // hydration, so only it is held to the inline budget. The coordinates ride
  // the chunk route to a desktop panel and the LAN `/source` route to the
  // headset, and are already bounded by the 16 MiB read policy above.
  try { assertInspectionBudget({ sceneJson }, MAX_INSPECTION_HYDRATION_BYTES, 'Structure Viewer local scene import'); }
  catch (error) { reject(error instanceof Error ? error.message : 'scene artifact exceeds the inline hydration budget.'); }
  const scene = sceneJson as Record<string, unknown>;
  if (scene.revision !== declaration.expectedRevision) reject('scene revision does not match expectedRevision in the sidecar.');
  return { sceneJson, coordinate, declaration, provenanceStatus: 'declared-local' };
}

/** Read and then pass the bounded pair through the existing lossless scene adapter. */
export async function importStructureViewerSceneFiles(input: {
  scenePath: string;
  coordinatePath: string;
  provenancePath: string;
  target: StereofoldImportTarget;
}): Promise<ImportedInspectionScene & { provenanceStatus: 'declared-local'; preflight: InspectionScenePreflight; message: string }> {
  const bundle = await readStructureViewerSceneFiles(input);
  const preflight = preflightInspectionScene(bundle.sceneJson, { coordinate: bundle.coordinate, target: input.target });
  let imported: ImportedInspectionScene;
  try { imported = importStructureViewerScene({ sceneJson: bundle.sceneJson, coordinate: bundle.coordinate, target: input.target }); }
  catch (error) {
    // Preserve the original error and message; callers can display preflight separately.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { preflight });
  }
  return { ...imported, provenanceStatus: bundle.provenanceStatus, preflight, message: preflight.message };
}

/** The renderer may explicitly capture the default empty emphasis after import. */
export function sceneImportMatchesSavedScene(saved: ImportedInspectionScene['scene'], imported: ImportedInspectionScene['scene']): boolean {
  const normalized = (scene: ImportedInspectionScene['scene']) => {
    // JSON normalizes harmless -0 and optional undefined fields exactly as MCP
    // transport does; deep equality ignores object-key insertion order.
    const copy = JSON.parse(JSON.stringify(scene));
    const emphasis = copy.inspection.emphasis;
    if (emphasis && emphasis.parts?.length === 0 && emphasis.focus?.length === 0
      && emphasis.contextOpacity === DEFAULT_CONTEXT_OPACITY && emphasis.origin === undefined)
      delete copy.inspection.emphasis;
    return copy;
  };
  return isDeepStrictEqual(normalized(saved), normalized(imported));
}
