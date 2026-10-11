import { isAbsolute } from 'node:path';
export { SOURCE_ONLY_HANDOFF_DISCLOSURE } from './inspection-handoff.js';

export type NativeStructureViewerHandoff =
  | { kind: 'public-pdb'; pdbId: string; sourceSha256: string }
  | { kind: 'local-file'; filePath: string; sourceSha256: string };

type HandoffInput = {
  sourceSha256: unknown;
  pdbId?: unknown;
  localFile?: { filePath: unknown; sourceSha256: unknown };
};

const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const pdbId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-z]{4}$/i.test(value);

/**
 * Creates a private, source-only native-viewer intent. It deliberately has no
 * scene, camera, selection, tour, or coordinate payload.
 */
export function nativeStructureViewerHandoff(input: HandoffInput): NativeStructureViewerHandoff | undefined {
  if (!digest(input.sourceSha256)) return undefined;
  if (pdbId(input.pdbId)) return { kind: 'public-pdb', pdbId: input.pdbId.toUpperCase(), sourceSha256: input.sourceSha256 };
  const local = input.localFile;
  if (local && typeof local.filePath === 'string' && local.filePath.length <= 4096 && !local.filePath.includes('\0')
    && isAbsolute(local.filePath) && digest(local.sourceSha256) && local.sourceSha256 === input.sourceSha256) {
    return { kind: 'local-file', filePath: local.filePath, sourceSha256: local.sourceSha256 };
  }
  return undefined;
}
