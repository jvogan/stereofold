import { createInspectionWorkspace } from './workspace.mjs';
import crambin from '../../fixtures/1CRN.cif';
import edge from '../../fixtures/identity-edge.cif';
const catalogs = __ROUNDTRIP_CATALOGS__;
const fixtures = Object.fromEntries(Object.entries({ public_1crn: crambin, identity_edge: edge })
  .map(([id, cif]) => [id, { id, cif, catalog: catalogs[id], sha256: catalogs[id].source.sha256,
    title:id === 'public_1crn' ? 'Crambin ' : 'Identity fixture ', code:id === 'public_1crn' ? '1CRN' : 'SYNTHETIC',
    caption:id === 'public_1crn' ? 'PUBLIC STRUCTURE / 1CRN' : 'SYNTHETIC IDENTITY FIXTURE' }]));
async function boot() {
  const workspace = await createInspectionWorkspace({ enableTestHooks:true });
  const loadFixture = id => { if (!fixtures[id]) throw Error('This preview contains only the pinned public fixtures.'); return workspace.loadSource(fixtures[id], { modelNumber:1, assemblyId:'1' }); };
  Object.defineProperty(window, '__stereofoldInspection', { value:Object.freeze({ ...workspace, loadFixture }), configurable:false });
  await loadFixture('public_1crn');
}
boot().catch(error => { document.body.dataset.ready = 'error'; const status = document.querySelector('#status'); status.textContent = error.message; status.dataset.error = 'true'; });
