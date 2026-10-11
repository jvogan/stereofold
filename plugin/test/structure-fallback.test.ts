import { describe, expect, it } from 'vitest';
import { decideStructureFallback } from '../src/structure-fallback.js';

const CRAMBIN = 'ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N';

describe('decideStructureFallback', () => {
  it('leaves a panel that already has a structure alone', () => {
    expect(decideStructureFallback({
      hasStructure: true,
      cached: { kind: 'structure', empty: false, structureText: CRAMBIN, format: 'pdb' },
    })).toEqual({ action: 'keep' });
    // Even with no cache at all: what is on the stage outranks what the
    // server remembers.
    expect(decideStructureFallback({ hasStructure: true, cached: undefined })).toEqual({ action: 'keep' });
  });

  it('loads a cache hit and labels it with the PDB id when there is one', () => {
    expect(decideStructureFallback({
      hasStructure: false,
      cached: { kind: 'structure', empty: false, structureText: CRAMBIN, format: 'mmcif', pdbId: '1CRN' },
    })).toEqual({ action: 'load', structureText: CRAMBIN, format: 'mmcif', label: '1CRN' });
  });

  it('labels a cached paste, which has no id, as a pasted structure', () => {
    expect(decideStructureFallback({
      hasStructure: false,
      cached: { kind: 'structure', empty: false, structureText: CRAMBIN, format: 'pdb' },
    })).toEqual({ action: 'load', structureText: CRAMBIN, format: 'pdb', label: 'pasted structure' });
  });

  it('sends the depth fixture down its own pinned-camera path', () => {
    // The fixture must not go through loadStructure directly: its camera pose
    // is pinned at (0, 0, 65) and the evaluation protocol quotes marker depths
    // from that pose.
    expect(decideStructureFallback({
      hasStructure: false,
      cached: { kind: 'structure', empty: false, structureText: CRAMBIN, format: 'pdb', fixture: 'three-depth-markers' },
    })).toEqual({ action: 'fixture' });
  });

  it('shows the empty state for an empty, missing, or unusable cache', () => {
    expect(decideStructureFallback({ hasStructure: false, cached: { kind: 'structure', empty: true } }))
      .toEqual({ action: 'empty' });
    // The tool call failed, or the host returned no structured content.
    expect(decideStructureFallback({ hasStructure: false, cached: undefined })).toEqual({ action: 'empty' });
    // Coordinates without a format, or a format without coordinates, cannot be
    // parsed; the honest empty state beats a load that fails behind a toast.
    expect(decideStructureFallback({ hasStructure: false, cached: { empty: false, structureText: CRAMBIN } }))
      .toEqual({ action: 'empty' });
    expect(decideStructureFallback({ hasStructure: false, cached: { empty: false, format: 'pdb' } }))
      .toEqual({ action: 'empty' });
    expect(decideStructureFallback({ hasStructure: false, cached: { empty: false, structureText: '', format: 'pdb' } }))
      .toEqual({ action: 'empty' });
  });
  it('ignores the look on the cache, which decides how to draw and never whether', () => {
    // The colour and style travel on the same payload so the panel can adopt
    // them, but they must not turn an empty cache into a load or a load into
    // an empty state.
    expect(decideStructureFallback({
      hasStructure: false,
      cached: { empty: true, color: 'sequence-id', style: 'atomic-detail' },
    })).toEqual({ action: 'empty' });
    expect(decideStructureFallback({
      hasStructure: false,
      cached: { structureText: 'ATOM', format: 'pdb', pdbId: '1CRN', color: 'element-symbol', style: 'molecular-surface' },
    })).toEqual({ action: 'load', structureText: 'ATOM', format: 'pdb', label: '1CRN' });
    expect(decideStructureFallback({
      hasStructure: false,
      cached: { fixture: 'three-depth-markers', color: 'element-symbol' },
    })).toEqual({ action: 'fixture' });
  });
});
