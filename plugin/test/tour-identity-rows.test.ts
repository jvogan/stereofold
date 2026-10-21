import { expect, it } from 'vitest';
import { applyTourVisibility, mountTourPlayer, resolveTourSelection, type Tour } from '../src/tour-player.js';
import { applyTourCommand } from '../src/inspection-tour-client.js';
// @ts-ignore Browser modules exercised directly without a renderer.
import { residueIdentityRows } from '../../lab/inspection/residue-identity-rows.mjs';
// @ts-ignore Shared real-player fixture.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Shared visibility semantics.
import { componentClassesPresent, emptyVisibility, hiddenRowKeys } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const catalog = ['polymer', 'water', 'non-polymer', 'non-polymer'].map((entityType, i) => ({
  key: `key${i}`, entityType, coordinateState: 'resolved', identity: {
    authorChain: 'A', labelChain: 'A', authorResidue: i + 1, modelNumber: 1, copyId: '1',
    componentId: ['ALA', 'HOH', 'MG', 'ATP'][i], operatorIds: ['1'],
  }, get atomSites(): never { throw Error('Chapter metadata must not visit atom coordinates'); },
}));

it('retains exact selection, polymer/water/ion/ligand semantics and detached nested identity without reading atoms', () => {
  const light = residueIdentityRows(catalog);
  expect(componentClassesPresent(light, 1)).toEqual(componentClassesPresent(catalog, 1));
  for (const selection of [{ chain: 'A', residues: { from: 2, to: 3 } }, { componentIds: ['ATP'] }, 'clear'] as const)
    expect(resolveTourSelection(light, selection as any)).toEqual(resolveTourSelection(catalog, selection as any));
  light[0].identity.operatorIds.push('mutated'); light[0].identity.authorChain = 'B';
  expect(catalog[0]!.identity.operatorIds).toEqual(['1']); expect(catalog[0]!.identity.authorChain).toBe('A');
});

it('real chapter preparation uses only lightweight rows for both visibility and selection', async () => {
  const h = tourEndHarness({ xr: true });
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), modelNumber: 1 });
  h.workspace.rows = () => { throw Error('Full catalog cloned during chapter'); };
  h.workspace.identityRows = () => residueIdentityRows(catalog);
  let visibility = emptyVisibility(), selected: string[] = [];
  h.workspace.viewer.inspection.visibility = () => visibility;
  h.workspace.viewer.inspection.setVisibility = async (next: any) => { visibility = next; };
  h.workspace.viewer.select = async (keys: string[]) => { selected = keys; };
  const tour: Tour = { id: 'identity-cost', title: 'Identity cost', summary: '', steps: [{
    id: 'polymer', title: 'Polymer', body: 'Polymer', selection: { componentIds: ['ALA'] },
    visibility: { op: 'hide', classes: ['water', 'ion', 'ligand'] },
  }] } as Tour;
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await h.install(tour);
    await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false, narration: false });
    expect(selected).toEqual(['key0']);
    expect(hiddenRowKeys(h.workspace.identityRows(), visibility)).toEqual(['key1', 'key2', 'key3']);
    await expect(applyTourVisibility(h.workspace, { op: 'hide', classes: ['polymer'] })).rejects.toThrow(/every part/);
    // No stale cache: a new source is read on the next chapter operation.
    h.workspace.identityRows = () => [];
    await expect(applyTourVisibility(h.workspace, { op: 'only', chains: [{ labelChain: 'A', copyId: '1' }] })).rejects.toThrow();
  } finally { player.pause(); h.cleanup(); }
});

it('reuses detached metadata only while exact source, model, assembly and reader match', async () => {
  const h = tourEndHarness({ xr: true });
  const snapshot = h.workspace.snapshot;
  let sourceSha256 = 'source-a', modelNumber = 1, assemblyId = '1', reads = 0;
  h.workspace.snapshot = () => ({ ...snapshot(), sourceSha256, modelNumber, assemblyId });
  h.workspace.identityRows = () => { reads++; return residueIdentityRows(catalog).map((row: any) => ({
    ...row, identity: { ...row.identity, modelNumber },
  })); };
  h.workspace.rows = () => { throw Error('Full atoms copied'); };
  h.workspace.viewer.inspection.visibility = emptyVisibility;
  h.workspace.viewer.inspection.setVisibility = async () => {};
  const read = () => applyTourVisibility(h.workspace, { op: 'hide', classes: ['water'] });
  try {
    await read(); await read(); expect(reads).toBe(1);
    modelNumber = 2; await read(); expect(reads).toBe(2);
    assemblyId = '2'; await read(); expect(reads).toBe(3);
    sourceSha256 = 'source-b'; await read(); expect(reads).toBe(4);
    h.workspace.identityRows = () => { reads++; return []; };
    await expect(read()).rejects.toThrow(); expect(reads).toBe(5);
  } finally { h.cleanup(); }
});

it('selection clear never reads residue metadata or atom coordinates', async () => {
  const h = tourEndHarness({ xr: true });
  h.workspace.rows = h.workspace.identityRows = () => { throw Error('Clear does not need catalog'); };
  let selected: string[] | undefined;
  h.workspace.viewer.select = async (keys: string[]) => { selected = keys; };
  const tour = { id: 'clear', title: 'Clear', summary: '', steps: [{ id: 'clear', title: 'Clear', selection: 'clear' }] } as Tour;
  const player = mountTourPlayer({ ...h, tours: [tour] });
  try {
    await h.install(tour);
    await applyTourCommand(player, { action: 'start', tourId: tour.id, autoplay: false, narration: false });
    expect(selected).toEqual([]);
  } finally { player.pause(); h.cleanup(); }
});
