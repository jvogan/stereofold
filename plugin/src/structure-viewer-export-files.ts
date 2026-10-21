import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CIF } from './compatible-cif.js';
import { MAX_INSPECTION_SCENE_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import { readBoundedSceneArtifact, STRUCTURE_VIEWER_SCENE_FILE_KIND, type StructureViewerSceneFileBundle } from './inspection-scene-file.js';

const path = z.string().min(1).max(4096);
export const nativeSceneExportSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exportSelection: z.object({ kind: z.literal('all'), objectId: z.string().min(1).max(256) }).strict(),
  sceneProvenancePath: path.optional(),
  coordinateProvenancePath: path.optional(),
}).strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sidecarSchema = z.object({
  schemaVersion: z.literal(1),
  artifact: z.object({ byteLength: count, mediaType: z.string(), outputPath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  provenance: z.object({ format: z.string(), sceneRevision: count, selectionAtomCount: count,
    workspacePublication: z.object({ source: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).optional(),
    coordinateProvenance: z.object({ format: z.literal('mmcif'), atomCount: count, modelCount: count,
      identityPreserving: z.boolean(), generatedAtomIdentifierCount: count, generatedModelCount: count,
      namespacedAtomIdentifierCount: count, remappedModelCount: count, preservedAtomIdentifierCount: count,
      atomIdentifierPolicy: z.string(), residueIdentifierPolicy: z.string(), bondConnectivityPolicy: z.string(),
    }).optional(),
  }),
});
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function reject(message: string): never { throw Error(`Structure Viewer export pair rejected: ${message}`); }
export const NATIVE_EXPORT_DISCLOSURE = 'Native export sidecars were checked locally, not authenticated. Export scope is caller-declared: upstream receipts do not bind a session, object or selection expression. Optional workspace-publication source digests are compared when both sidecars provide them; these are local metadata, not authenticated source proof. Coordinates omit explicit bonds and bond order. This is a one-shot snapshot, not live synchronization.';

/** Read the actual Structure Viewer 0.1.80 export contract; never manufacture a receipt. */
export async function readNativeStructureViewerExports(input: {
  scenePath: string; coordinatePath: string; nativeExports: z.output<typeof nativeSceneExportSchema>;
}) {
  const request = nativeSceneExportSchema.parse(input.nativeExports);
  const [sceneBytes, coordinateBytes, sceneSidecarBytes, coordinateSidecarBytes] = await Promise.all([
    readBoundedSceneArtifact(input.scenePath, ['.json'], MAX_INSPECTION_SCENE_BYTES),
    readBoundedSceneArtifact(input.coordinatePath, ['.cif', '.mmcif'], MAX_STRUCTURE_SOURCE_BYTES),
    readBoundedSceneArtifact(request.sceneProvenancePath ?? `${input.scenePath}.provenance.json`, ['.json'], 2 * 1024 * 1024),
    readBoundedSceneArtifact(request.coordinateProvenancePath ?? `${input.coordinatePath}.provenance.json`, ['.json'], 2 * 1024 * 1024),
  ]);
  const sceneJson = JSON.parse(decoder.decode(sceneBytes));
  const sceneReceipt = sidecarSchema.parse(JSON.parse(decoder.decode(sceneSidecarBytes)));
  const coordinateReceipt = sidecarSchema.parse(JSON.parse(decoder.decode(coordinateSidecarBytes)));
  for (const [receipt, bytes, format, mediaType] of [
    [sceneReceipt, sceneBytes, 'scene-json', 'application/json'],
    [coordinateReceipt, coordinateBytes, 'selection-mmcif', 'chemical/x-mmcif'],
  ] as const) {
    if (receipt.artifact.sha256 !== digest(bytes) || receipt.artifact.byteLength !== bytes.byteLength)
      reject(`${format} digest or byte length does not match the exact artifact.`);
    if (receipt.provenance.format !== format || receipt.artifact.mediaType !== mediaType)
      reject(`${format} format or media type does not match the native export contract.`);
    if (receipt.provenance.sceneRevision !== request.expectedRevision)
      reject(`${format} revision does not match expectedRevision.`);
  }
  const sceneSourceDigest = sceneReceipt.provenance.workspacePublication?.source?.sha256;
  const coordinateSourceDigest = coordinateReceipt.provenance.workspacePublication?.source?.sha256;
  if (sceneSourceDigest && coordinateSourceDigest && sceneSourceDigest !== coordinateSourceDigest)
    reject('workspace-publication source digests do not match between the scene and coordinate exports.');
  if (!sceneJson || Array.isArray(sceneJson) || sceneJson.version !== 2 || sceneJson.revision !== request.expectedRevision)
    reject('scene must be SceneState v2 at expectedRevision.');
  if (!Array.isArray(sceneJson.objects) || !sceneJson.objects.some((object: any) => object?.id === request.exportSelection.objectId))
    reject('exportSelection.objectId is not present in the scene.');
  const coordinateText = decoder.decode(coordinateBytes), coordinateSha256 = digest(coordinateBytes);
  const parsed = await CIF.parse(coordinateText).run();
  if (parsed.isError) reject('coordinate artifact is not valid mmCIF.');
  const atoms = parsed.result.blocks.length === 1 ? parsed.result.blocks[0].categories.atom_site : undefined;
  const provenance = coordinateReceipt.provenance.coordinateProvenance;
  if (!atoms || atoms.rowCount < 1 || !provenance) reject('coordinate export requires one atom_site block and native coordinateProvenance.');
  if (atoms.rowCount !== provenance.atomCount || atoms.rowCount !== coordinateReceipt.provenance.selectionAtomCount)
    reject('native coordinate atom counts do not match serialized atom_site rows.');
  const ids = new Set<string>(), models = new Set<string>();
  for (const key of ['group_PDB', 'id', 'type_symbol', 'pdbx_PDB_model_num', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'pdbx_formal_charge'])
    if (!atoms.getField(key)) reject(`coordinate atom_site is missing ${key}.`);
  for (let i = 0; i < atoms.rowCount; i++) {
    const id = atoms.getField('id')!.str(i), model = atoms.getField('pdbx_PDB_model_num')!.str(i);
    const group = atoms.getField('group_PDB')!.str(i), symbol = atoms.getField('type_symbol')!.str(i);
    if (group !== 'ATOM' && group !== 'HETATM') reject('coordinate group_PDB must be ATOM or HETATM.');
    if (!symbol.trim()) reject('coordinate type_symbol must be nonempty.');
    const charge = atoms.getField('pdbx_formal_charge')!, chargeText = charge.str(i);
    // Mol* reports . and ? through valueKind and returns an empty str for both.
    if (charge.valueKind(i) === 0 && (!/^[+-]?\d+$/.test(chargeText) || !Number.isSafeInteger(Number(chargeText))))
      reject('coordinate formal charges must be safe integers or unknown (. or ?).');
    if (!id || id === '.' || id === '?' || ids.has(id)) reject('coordinate atom IDs must be nonempty and unique.');
    if (!/^-?\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
      reject('nonnumeric or unsafe atom IDs are unsupported by the current inspection catalog; neither matching-scene nor structure-only can open this export. Atom IDs are never renumbered.');
    if (String(Number(id)) !== id || Number(id) < -2147483648 || Number(id) > 2147483647)
      reject('atom IDs must retain canonical signed 32-bit integer spelling for exact Mol* identity; neither matching-scene nor structure-only can open this export. Atom IDs are never renumbered.');
    if (!/^\d+$/.test(model) || !Number.isSafeInteger(Number(model)) || Number(model) < 1 || Number(model) > 2147483647) reject('coordinate model numbers must be positive signed 32-bit integers for exact Mol* identity.');
    for (const key of ['Cartn_x', 'Cartn_y', 'Cartn_z']) {
      const value = atoms.getField(key)!.str(i);
      if (!value.trim() || !Number.isFinite(Number(value))) reject('coordinate positions must be finite.');
    }
    ids.add(id); models.add(model);
  }
  if (models.size !== provenance.modelCount) reject('native modelCount does not match serialized models.');
  const compatibilityIssues: string[] = [];
  const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (sceneJson.objects.some((object: any) => Array.isArray(object?.matrix)
    && (object.matrix.length !== 16 || object.matrix.some((value: unknown, index: number) => value !== identityMatrix[index]))))
    compatibilityIssues.push('Native coordinate exports already bake object transforms into their coordinates. Matching-scene currently requires identity object matrices to avoid applying placement twice; structure-only retains the baked coordinates.');
  if (sceneJson.selection?.atomIdsTruncated === true)
    compatibilityIssues.push('Truncated selection atom IDs cannot transfer through this native handoff; no complete revision-bound query-ID input is available.');
  if ((Array.isArray(sceneJson.selection?.atomIds) && sceneJson.selection.atomIds.length > 0) || sceneJson.selection?.atomCount > 0)
    compatibilityIssues.push('Native selection IDs identify object/instance/element, not exported atom_site IDs; no proven selection mapping is supplied. Matching-scene currently requires an empty native selection.');
  if (!provenance.identityPreserving || provenance.generatedAtomIdentifierCount !== 0 || provenance.generatedModelCount !== 0
    || provenance.namespacedAtomIdentifierCount !== 0 || provenance.remappedModelCount !== 0
    || provenance.preservedAtomIdentifierCount !== atoms.rowCount)
    compatibilityIssues.push('Coordinate export does not preserve source atom/model identity without generated, namespaced or remapped identifiers.');
  if (provenance.atomIdentifierPolicy !== 'preserve-source-atom-site-ids-with-collision-safe-fallbacks'
    || provenance.residueIdentifierPolicy !== 'source-label-and-author-identifiers'
    || provenance.bondConnectivityPolicy !== 'coordinates-only-no-explicit-bond-records')
    compatibilityIssues.push('Coordinate export identifier/connectivity policy is outside the supported native contract.');
  const declaration: StructureViewerSceneFileBundle['declaration'] = {
    version: 1, kind: STRUCTURE_VIEWER_SCENE_FILE_KIND, sceneSha256: digest(sceneBytes), expectedRevision: request.expectedRevision,
    sourceObjectId: request.exportSelection.objectId,
    coordinate: { format: 'selection-mmcif', sha256: coordinateSha256, coordinateProvenance: {
      identityPreserving: true, generatedAtomIdentifierCount: 0, generatedModelCount: 0, namespacedAtomIdentifierCount: 0, remappedModelCount: 0,
    } },
  };
  // This in-memory adapter declaration is created only after validating native
  // metadata; it is never presented as an authenticated upstream receipt.
  const bundle: StructureViewerSceneFileBundle | undefined = compatibilityIssues.length ? undefined : {
    sceneJson, declaration, provenanceStatus: 'declared-local', coordinate: {
      format: 'selection-mmcif', text: coordinateText, sha256: coordinateSha256,
      sourceObjectId: declaration.sourceObjectId, expectedSceneRevision: declaration.expectedRevision,
      coordinateProvenance: declaration.coordinate.coordinateProvenance,
      assemblyBakedIntoCoordinates: true,
    },
  };
  return { sceneJson, coordinateText, coordinateSha256, compatibilityIssues, bundle, disclosure: NATIVE_EXPORT_DISCLOSURE };
}
