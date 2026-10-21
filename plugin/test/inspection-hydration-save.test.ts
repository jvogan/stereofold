import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { createSaveRetryAdmission } from '../src/inspection-save-retry.js';
import { waitForPanelRender } from '../src/inspection-render-settle.js';

const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['scheduleSave', 'save'].includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
const from = source.indexOf('  // Following a saved view is a read.');
const to = source.indexOf('  // A definitive attach refusal', from);
const script = ts.transpileModule(`${functions}\nasync function checkpoint() { ${source.slice(from, to)} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
afterEach(() => vi.useRealTimers());

// Execute the real hydration checkpoint and queued saver. The renderer boundary
// models a chapter-control notification starting a clearance draw after install.
function page(options:{densityReferencePreview?:boolean;referenceOnly?:boolean}={}) {
  vi.useFakeTimers();
  const events: string[] = [];
  const skipped:string[]=[];
  let ready = false;
  const scene = { sourceSha256: 'new-source', inspection: { placement: { scale: 2 } } };
  const h: any = vm.createContext({
    Promise, JSON, Date, Math, setTimeout, clearTimeout, waitForPanelRender,
    saveRetryAdmission: createSaveRetryAdmission(),
    binding: { sessionId: 'session', sourceToken: 'new-source', serverEpoch: 'epoch', stateRevision: 2, inspectionRevision: 0 },
    loading: false, remote: false, closed: false, reloading: false, failedSourceLoad: undefined,
    dirty: false, blocked: false, edits: 0, generation: 3, ownGeneration: 3,
    timer: undefined, saving: Promise.resolve(), savedScene: undefined, saveAttempts: 0,
    passiveSavedRestore: false, journeySave: undefined, replacesPanelId: 'retained-headset', options: {},
    densityReferencePreview:options.densityReferencePreview===true,densityReferenceOnly:false,
    isCompanion: true, experiencePreparing: false, tourPlayer: undefined, panelId: 'retained-headset',
    workspace: { snapshot: () => ({ ready }), capture: () => structuredClone(scene), syncSceneHistory() {}, setStatus() {} },
    trace: { phase: async (_name: string, work: Promise<unknown>) => work, skip:(name:string)=>skipped.push(name) },
    recordHeadsetEvent() {}, thrownErrorMessage: (e: Error) => e.message, problemMessage: (_kind: string, e: Error) => e.message,
    showProblem: () => { h.blocked = true; }, recoverSave: () => { h.blocked = true; },
    call: async (name: string, args: any) => {
      expect(name).toBe('sync_inspection'); expect(ready).toBe(true);
      expect(args.sourceToken).toBe('new-source'); expect(args.scene).toEqual(scene);
      if(options.referenceOnly) {
        events.push('reference-acknowledged');
        return {structuredContent:{saved:false,referenceOnly:true,inspectionRevision:4,reason:'Reference coordinates cannot replace the shared map.'}};
      }
      events.push('saved'); return { structuredContent: { saved: true, inspectionRevision: 1 } };
    },
    attach: async () => { events.push(h.densityReferenceOnly?'attached-reference':h.savedScene ? 'attached-saved' : 'attached-without-scene'); },
  });
  vm.runInContext(script, h);
  return { h, events, skipped, draw: () => { ready = true; }, redraw: () => { ready = false; } };
}

it('waits for chapter clearance and saves the replacement before reattaching the headset', async () => {
  const p = page();
  const pending = p.h.checkpoint();
  await vi.advanceTimersByTimeAsync(100);
  expect(p.events).toEqual([]);
  p.draw(); await vi.advanceTimersByTimeAsync(100); await pending;
  expect(p.events).toEqual(['saved', 'attached-saved']);
  expect(p.h.dirty).toBe(false); expect(p.h.blocked).toBe(false);
});

it('saves an already settled replacement before attaching', async () => {
  const p = page(); p.draw();
  await p.h.checkpoint();
  expect(p.events).toEqual(['saved', 'attached-saved']);
});

it('rechecks the draw after an earlier queued save yields', async () => {
  const p = page(); p.draw();
  let release!: () => void;
  p.h.saving = new Promise<void>(resolve => { release = resolve; });
  const pending = p.h.checkpoint();
  p.redraw(); release();
  await vi.advanceTimersByTimeAsync(100);
  expect(p.events).toEqual([]);
  p.draw(); await vi.advanceTimersByTimeAsync(100); await pending;
  expect(p.events).toEqual(['saved', 'attached-saved']);
});

it('does not attach or claim a save when clearance never settles', async () => {
  const p = page();
  const pending = p.h.checkpoint();
  await vi.advanceTimersByTimeAsync(15_100); await pending;
  expect(p.events).toEqual([]);
  expect(p.h.blocked).toBe(true);
});

it.each(['generation', 'closed'] as const)('does not save or attach an obsolete hydration after %s changes while clearance draws', async field => {
  const p = page();
  const pending = p.h.checkpoint();
  await vi.advanceTimersByTimeAsync(100);
  if (field === 'generation') p.h.generation++;
  else p.h.closed = true;
  p.draw(); await vi.advanceTimersByTimeAsync(100); await pending;
  expect(p.events).toEqual([]);
  expect(p.h.blocked).toBe(false);
});

it('attaches a delayed reference preview without claiming it saved over the map',async()=>{
  const p=page({densityReferencePreview:true,referenceOnly:true});
  const pending=p.h.checkpoint();
  await vi.advanceTimersByTimeAsync(100);expect(p.events).toEqual([]);
  p.draw();await vi.advanceTimersByTimeAsync(100);await pending;
  expect(p.events).toEqual(['reference-acknowledged','attached-reference']);
  expect(p.skipped).toContain('saved');
  expect(p.h.binding.inspectionRevision).toBe(4);
  expect(p.h.dirty).toBe(false);expect(p.h.blocked).toBe(false);
});

it('keeps an explicit reference edit unsaved instead of treating it as passive hydration',async()=>{
  const p=page({densityReferencePreview:true,referenceOnly:true});p.draw();
  p.h.scheduleSave();await p.h.save();
  expect(p.events).toEqual(['reference-acknowledged']);
  expect(p.h.dirty).toBe(true);expect(p.h.blocked).toBe(true);
  expect(p.h.savedScene).toBeUndefined();
});
