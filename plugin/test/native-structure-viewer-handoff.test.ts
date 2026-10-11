import { describe, expect, it } from 'vitest';
import { nativeStructureViewerHandoff, SOURCE_ONLY_HANDOFF_DISCLOSURE } from '../src/native-structure-viewer-handoff.js';

const digest = 'a'.repeat(64);

describe('native Structure Viewer handoff intent', () => {
  it('discloses structure-only fidelity without exposing a machine path', () => {
    expect(SOURCE_ONLY_HANDOFF_DISCLOSURE).toContain('Open structure only');
    expect(SOURCE_ONLY_HANDOFF_DISCLOSURE).toContain('Carries public pdbId or verified local filePath, plus sourceSha256.');
    expect(SOURCE_ONLY_HANDOFF_DISCLOSURE).toContain('Does not carry selection, camera or appearance.');
    expect(SOURCE_ONLY_HANDOFF_DISCLOSURE).toContain('Does not carry layers, annotations, maps or measurements.');
    expect(SOURCE_ONLY_HANDOFF_DISCLOSURE).toContain('Not a matching scene or a live link.');
    expect(SOURCE_ONLY_HANDOFF_DISCLOSURE).not.toContain('/');
  });

  it('preserves only server-proven public PDB identity', () => {
    expect(nativeStructureViewerHandoff({ sourceSha256: digest, pdbId: '1crn' })).toEqual({
      kind: 'public-pdb', pdbId: '1CRN', sourceSha256: digest,
    });
    expect(nativeStructureViewerHandoff({ sourceSha256: digest })).toBeUndefined();
  });

  it('requires an exact absolute local path and matching cached source hash', () => {
    expect(nativeStructureViewerHandoff({ sourceSha256: digest, localFile: { filePath: '/tmp/exact.cif', sourceSha256: digest } })).toEqual({
      kind: 'local-file', filePath: '/tmp/exact.cif', sourceSha256: digest,
    });
    expect(nativeStructureViewerHandoff({ sourceSha256: digest, localFile: { filePath: 'relative.cif', sourceSha256: digest } })).toBeUndefined();
    expect(nativeStructureViewerHandoff({ sourceSha256: digest, localFile: { filePath: '/tmp/changed.cif', sourceSha256: 'b'.repeat(64) } })).toBeUndefined();
  });
});
