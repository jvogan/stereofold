import { describe, expect, it } from 'vitest';
import { sceneImportPreflightView } from '../src/scene-import-preflight-view.js';

describe('scene preflight app-tool presentation', () => {
  it('shows provisional supported and unsupported decisions without implying a loaded scene', () => {
    const supported = sceneImportPreflightView({ kind: 'scene-preflight', preflight: { supported: true, message: 'Admission is provisional until the structure loads.' }, disclosure: 'Local metadata only.' });
    expect(supported?.title).toBe('Scene compatibility checked');
    expect(supported?.supported).toBe(true);
    expect(supported?.details).toContain('Admission is provisional');
    expect(supported?.text).toContain('can open as a matching scene');
    expect(supported?.next).toContain('matching scene or the structure only');
    const ligand = sceneImportPreflightView({ kind: 'scene-preflight', preflight: { supported: true,
      message: 'Open matching scene.', renderingDifference: 'Ligands are shown as ball-and-stick; Structure Viewer drew bond-only sticks.' } });
    expect(ligand?.text).toContain('Ligands are shown as ball-and-stick; Structure Viewer drew bond-only sticks.');
    const refused = sceneImportPreflightView({ kind: 'scene-preflight', preflight: { supported: false, message: 'Additional layers cannot transfer.' } });
    expect(refused?.title).toBe('Matching scene unavailable');
    expect(refused?.supported).toBe(false);
    expect(refused?.details).toContain('Additional layers cannot transfer.');
    expect(refused?.text).toContain('nothing was opened');
    expect(refused?.next).toContain('structure-only view');
    // The visible sentences carry no scene field paths or tool names; the
    // checker's own reasons stay in the collapsed details.
    for (const view of [supported, refused])
      expect(`${view?.title} ${view?.text} ${view?.next}`).not.toMatch(/stereo_structure|\w\[\d+\]|\w_\w/u);
  });
  it('ignores normal inspection receipts and malformed reports', () => {
    for (const value of [null, {}, { kind: 'inspect' }, { kind: 'scene-preflight', preflight: { supported: 'true', message: 'fake' } }])
      expect(sceneImportPreflightView(value)).toBeUndefined();
  });
});
