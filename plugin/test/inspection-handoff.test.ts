import { describe, expect, it } from 'vitest';
import { SOURCE_ONLY_HANDOFF_DISCLOSURE, nativeStructureViewerPrompt, officialMolstarUrl, parseNativeStructureViewerHandoff } from '../src/inspection-handoff.js';

describe('source-identity handoff', () => {
  const sha256 = 'a'.repeat(64);

  it('opens the official Mol* website only for a server-declared public PDB source', () => {
    const source = parseNativeStructureViewerHandoff({ kind: 'public-pdb', pdbId: '1crn', sourceSha256: sha256 });
    expect(source).toEqual({ kind: 'public-pdb', pdbId: '1CRN', sourceSha256: sha256 });
    expect(officialMolstarUrl(source)).toBe('https://molstar.org/viewer/?pdb=1CRN');
    expect(nativeStructureViewerPrompt(source!)).toBe(`Open public PDB 1CRN in Molecular Structure Viewer. ${SOURCE_ONLY_HANDOFF_DISCLOSURE}`);
  });

  it('rejects inferred or malformed public identities and never creates a website URL for local files', () => {
    expect(parseNativeStructureViewerHandoff({ kind: 'public-pdb', pdbId: ' 1CRN', sourceSha256: sha256 })).toBeUndefined();
    expect(parseNativeStructureViewerHandoff({ kind: 'public-pdb', pdbId: '1CRN', sourceSha256: 'bad' })).toBeUndefined();
    const local = parseNativeStructureViewerHandoff({ kind: 'local-file', filePath: '/private/data/structure.cif', sourceSha256: sha256 });
    expect(officialMolstarUrl(local)).toBeUndefined();
    expect(nativeStructureViewerPrompt(local!)).toBe(`Open the local structure in Molecular Structure Viewer only after verifying SHA-256 ${sha256} for path "/private/data/structure.cif". ${SOURCE_ONLY_HANDOFF_DISCLOSURE}`);
  });

  it('does not accept pasted bytes, relative paths, fixtures, or arbitrary source metadata as handoff identity', () => {
    for (const value of [undefined, { pdbId: '1CRN', sourceSha256: sha256 }, { kind: 'local-file', filePath: 'relative.cif', sourceSha256: sha256 },
      { kind: 'fixture', pdbId: '1CRN', sourceSha256: sha256 }, { kind: 'public-pdb', pdbId: '1CRN', sourceSha256: sha256, structureText: 'data_private' }])
      expect(parseNativeStructureViewerHandoff(value)).toBeUndefined();
  });
});
