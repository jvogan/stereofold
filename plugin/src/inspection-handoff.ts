/** Source-identity-only handoff helpers. Coordinate bytes never leave Stereofold here. */
export type NativeStructureViewerHandoff =
  | { kind: 'public-pdb'; pdbId: string; sourceSha256: string }
  | { kind: 'local-file'; filePath: string; sourceSha256: string };

export const SOURCE_ONLY_HANDOFF_DISCLOSURE = [
  'Open structure only in Molecular Structure Viewer.',
  'Carries public pdbId or verified local filePath, plus sourceSha256.',
  'Does not carry selection, camera or appearance.',
  'Does not carry layers, annotations, maps or measurements.',
  'Not a matching scene or a live link.',
].join('\n');

const PDB_ID = /^[0-9A-Za-z]{4}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseNativeStructureViewerHandoff(value: unknown): NativeStructureViewerHandoff | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sourceSha256 !== 'string' || !SHA256.test(candidate.sourceSha256)) return undefined;
  const only = (...keys: string[]) => Object.keys(candidate).every(key => keys.includes(key));
  if (candidate.kind === 'public-pdb' && only('kind', 'pdbId', 'sourceSha256') && typeof candidate.pdbId === 'string' && PDB_ID.test(candidate.pdbId))
    return { kind: 'public-pdb', pdbId: candidate.pdbId.toUpperCase(), sourceSha256: candidate.sourceSha256 };
  if (candidate.kind === 'local-file' && only('kind', 'filePath', 'sourceSha256') && typeof candidate.filePath === 'string' && candidate.filePath.startsWith('/') && candidate.filePath.length <= 4096)
    return { kind: 'local-file', filePath: candidate.filePath, sourceSha256: candidate.sourceSha256 };
  return undefined;
}

/** The public website receives only a public accession, never a local identity or coordinates. */
export function officialMolstarUrl(source: NativeStructureViewerHandoff | undefined): string | undefined {
  return source?.kind === 'public-pdb' ? `https://molstar.org/viewer/?pdb=${source.pdbId}` : undefined;
}

/** A host-delivered user intent; it is not a cross-plugin call or render receipt. */
export function nativeStructureViewerPrompt(source: NativeStructureViewerHandoff): string {
  const request = source.kind === 'public-pdb'
    ? `Open public PDB ${source.pdbId} in Molecular Structure Viewer.`
    : `Open the local structure in Molecular Structure Viewer only after verifying SHA-256 ${source.sourceSha256} for path ${JSON.stringify(source.filePath)}.`;
  return `${request} ${SOURCE_ONLY_HANDOFF_DISCLOSURE}`;
}
