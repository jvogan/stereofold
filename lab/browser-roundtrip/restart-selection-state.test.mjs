import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { selectionPaintPlan, selectionSignature } from './selection-paint.mjs';
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const guide = ['B1', 'B2'], pam = ['D5', 'D6', 'D7'];
function page() {
  let payload, checkpoint;
  const marks = [];
  const c = vm.createContext({
    state: { selectionKeys: [] }, lessonSelection: undefined, settledSelectionLayers: undefined,
    selection: {}, structure: {}, stylesState: [], visibilityState: {}, styleLayers: [], emphasisOrigin: 'lesson',
    currentEmphasisPlan: () => ({ colours: [{keys: guide, color:'#ff8800'}, {keys:pam, color:'#ffff00'}] }),
    selectionPaintPlan, selectionSignature, selectedKeys: keys => [...keys],
    hiddenSceneKeys: () => [], hiddenSceneKeySet: () => new Set(), retainCurrent: () => ({}),
    markRecord: (_record, keys) => marks.push([...keys]), assertReady() {},
    inspectionLayersIntact: () => false, selectionLayersUnchanged: () => false, async paintSelectionOverlay() {}, async rebuildInspectionLabels() {}, async rebuildComponentLabels() {},
    inspectionSnapshot: () => ({ appearance: {}, placement: {} }), savedEmphasis: () => undefined, savedStyles: () => ({}), savedVisibility: () => ({}),
    canvas: {camera:{getSnapshot:()=>({}), setState() {}}}, cameraSnapshot: v => v, detached: structuredClone,
    desktopPreviewCamera: undefined, lessonFigure:{definition:()=>undefined, async install() {}}, molecularAnimation:{capture:()=>undefined, checkpoint:()=>undefined, supersededBy:()=>false, async settled() {}, async restore() {}, resume() {}},
    lessonPlayback: undefined, lessonMotionHold:{presented:v=>v, release() {}}, liveScene:()=>({sourceSha256:'source',modelNumber:1,assemblyId:'1',camera:{}}),
    inspectionState: {setPayload: v => {payload=structuredClone(v);}, payload:()=>structuredClone(payload), recordPayload() {}, replace() {}},
    validInspectionCapture: v => ({keys:v.selectionKeys,camera:v.camera,inspection:v.inspection}),
    normalizeStyles: v => v ?? [], normalizeVisibility: v => v ?? {}, wearerPlacement:{holdsPlacement:()=>false},
    invalidateGesturePivot() {}, async restoreCompanion() {}, async applyInspectionAppearance() {}, applyInspectionTransform() {}, fitDesktopPreview() {},
    inspectionMutation: async (op, options) => { checkpoint=structuredClone(payload); try {await op();} catch(e) { await options?.rollback?.(); payload=checkpoint; c.restoreInspectionPayload(); throw e;} },
  });
  for (const name of ['select','markSelection','currentSelectionPlan','inspectionPayload','syncInspectionPayload','restoreInspectionPayload','completeInspectionCapture','restoreInspection']) vm.runInContext(pageFunction(source,name),c);
  return {c, marks};
}
for (const route of ['Back', 'fresh panel']) test(`${route} restores lesson ownership before marking the saved guide RNA`, async () => {
  const first = page(); await first.c.select(guide, 'selection', {lesson:true});
  const saved = plain(first.c.completeInspectionCapture());
  const next = route === 'Back' ? first : page();
  if (route === 'Back') await next.c.select(pam, 'selection', {lesson:true});
  await next.c.restoreInspection(saved, {preserveCamera:true});
  assert.deepEqual([...next.c.state.selectionKeys],guide);
  assert.deepEqual([...next.c.currentSelectionPlan().keys],[], 'orange guide key survives');
  assert.deepEqual(next.marks.at(-1),[], 'flat marker preserves the key too');
});
test('history payload restores lesson ownership and ordinary wearer ownership', async () => {
  const {c} = page(); await c.select(guide,'selection',{lesson:true});
  const saved=plain(c.inspectionPayload());
  await c.select(guide);
  c.inspectionState.setPayload(saved); c.restoreInspectionPayload();
  assert.deepEqual([...c.currentSelectionPlan().keys],[]);
  c.inspectionState.setPayload({...saved,lessonSelection:undefined}); c.restoreInspectionPayload();
  assert.deepEqual([...c.currentSelectionPlan().keys],guide);
});
test('failed saved chapter restore rolls selection ownership back', async () => {
  const {c} = page(); await c.select(guide,'selection',{lesson:true});
  const saved=plain(c.completeInspectionCapture());
  await c.select(guide); // same keys, different owner
  c.applyInspectionAppearance=async()=>{throw Error('draw failed');};
  await assert.rejects(c.restoreInspection(saved,{preserveCamera:true}),/draw failed/);
  assert.deepEqual([...c.currentSelectionPlan().keys],guide);
});
test('built-in selections with no applied key, and uncovered rows, remain visibly marked', async () => {
  const {c,marks}=page(); c.currentEmphasisPlan=()=>({colours:[]});
  await c.select(guide,'selection',{lesson:true});
  assert.deepEqual([...c.currentSelectionPlan().keys],guide);
  assert.deepEqual(marks.at(-1),guide);
  c.currentEmphasisPlan=()=>({colours:[{keys:['B1'],color:'#ff8800'}]});
  assert.deepEqual([...c.currentSelectionPlan().keys],['B2']);
});
