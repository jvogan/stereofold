import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { lessonRestingState, mountTourPlayer } from '../src/tour-player.js';
import { applyTourCommand, createPanelTourController, tourHeartbeat } from '../src/inspection-tour-client.js';
import { inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';
import { waitForPanelRender, panelEntering, sameEntryScene, withWearerEdits } from '../src/inspection-render-settle.js';
// @ts-ignore Real player DOM boundary, no browser or device needed.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore The viewer's own chapter-turn pin.
import { createLessonMotionHold } from '../../lab/browser-roundtrip/lesson-motion.mjs';

// One "next" from the wearer's assistant has to move the lesson one chapter.
// On the headset it often lands while the chapter is still turning, or a
// moment after entering VR while the opening chapter turns. The panel pauses
// the lesson before it asks the host to admit the command, and that pause
// settles the turn and rewrites the saved lesson cursor. The panel then read
// its own pause as a local edit and refused the command as `local_changed`,
// so the wearer waited and the assistant had to send "next" again.
const inspectorSource = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const inspectorAst = ts.createSourceFile('inspector.ts', inspectorSource, ts.ScriptTarget.Latest, true);
const receiveSource = inspectorAst.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'receive')!.getText(inspectorAst);
const monomer = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/microtubule-growth/monomer.json', import.meta.url), 'utf8')));
const noop = () => {};

afterEach(() => { vi.useRealTimers(); });

/** A presenting headset page: the real player and panel receiver, with the viewer's camera pin. */
async function headset(entering: boolean) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const h = tourEndHarness({ xr: true });
  const source = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1' };
  const hold = createLessonMotionHold();
  let camera = { mode: 'perspective', fov: 45, position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
  let lessonPlayback: any, startup: { phase: string } = { phase: entering ? 'preparing-menu' : 'presenting' };
  const inspection = h.workspace.viewer.inspection;
  // A chapter tick turns the live camera and pins the saved one, as the viewer does.
  inspection.applyLessonMotion = async (move: { degrees: number }) => {
    hold.hold(structuredClone(camera), source);
    const turn = move.degrees * Math.PI / 180, [x, y, z] = camera.position;
    camera = { ...camera, position: [x * Math.cos(turn) + z * Math.sin(turn), y, -x * Math.sin(turn) + z * Math.cos(turn)] };
    return { lessonMotionApplied: true };
  };
  inspection.bakeLessonMotion = () => hold.bake();
  inspection.setLessonPlayback = (value: any) => { lessonPlayback = structuredClone(value); };
  const capture = () => {
    const { painted, appearance, placement } = h.capture();
    return structuredClone({ ...source, selectionKeys: [], camera: hold.presented(camera, source),
      inspection: { appearance, placement, emphasis: painted, ...(lessonPlayback ? { lessonPlayback } : {}) } });
  };
  h.workspace.capture = capture;
  h.workspace.viewer.xr = { startup: () => startup };
  const player = mountTourPlayer({ ...h, tours: [monomer] });
  const panelTour = createPanelTourController(player, { ...player, getState: () => ({ ...player.getState(), active: false, tours: [] }) });
  panelTour.setDefault(true);
  await player.select(monomer.id);
  await player.start(false, 0, { narration: false });
  const phases: string[] = [], receipts: any[] = [];
  const binding = { sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 };
  const page: any = vm.createContext({ workspace: h.workspace, tourPlayer: player, panelTour, installedLesson: monomer, TOURS: [],
    isCompanion: true, closed: false, generation: 1, panelId: 'panel', dirty: false, blocked: false, loading: false, remote: false,
    binding, savedScene: capture(), localInteractionSerial: 0, lastLocalEditAt: -Infinity, pendingReceipt: undefined,
    narrationGeneration: 0, tourCommandContext: undefined, tourCommandReceipt: undefined,
    performance, Date, setTimeout, clearTimeout, requestAnimationFrame: (callback: () => void) => callback(),
    waitForPanelRender, panelEntering, sameEntryScene, withWearerEdits, applyTourCommand, tourHeartbeat, inspectionFailureReceipt,
    lessonRestingState, molecularLessonToTour, recordHeadsetEvent: noop, recordLoopStage: noop, showOutcome: noop,
    speakRemoteConfirmation: noop, busyBeat: async () => {}, scheduleSave: noop, save: async () => {},
    outcome: { textContent: '' }, notice: { hidden: true }, thrownErrorMessage: (error: Error) => error.message,
    recoverConfirmation: async () => {},
    // The host admits the claim and keeps it; a refusal would show as a failed receipt.
    call: async (_name: string, input: any) => { phases.push(input.phase);
      return { structuredContent: input.phase === 'admit' ? { admitted: true } : { deferred: false } }; },
    confirmReceipt: async (value: any) => { receipts.push(value); return { status: value.failure ? 'rejected' : 'rendered' }; },
  });
  const lessonSaveSource = inspectorAst.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'scheduleLessonSave')!.getText(inspectorAst);
  page.reloading = false;
  page.scheduleSave = () => { if (!page.remote) page.dirty = true; };
  vm.runInContext(ts.transpileModule(receiveSource + '\n' + lessonSaveSource,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, page);
  player.subscribe(() => page.scheduleLessonSave());
  const next = () => page.receive({ panelId: 'panel', commandId: 'next', claimToken: 'claim', change: { kind: 'tour', patch: { action: 'next' } } },
    { serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 1, baseInspectionRevision: 1 }, 1);
  return { h, player, page, phases, receipts, capture, next, enter: () => { startup = { phase: 'presenting' }; },
    turned: () => camera.position, done: () => { player.pause(); h.cleanup(); } };
}

it('one next during the opening chapter turn advances one chapter and renders', async () => {
  const s = await headset(false);
  try {
    expect(s.player.getState()).toMatchObject({ step: 0, active: true, motionRunning: true });
    const saved = s.capture();
    await vi.advanceTimersByTimeAsync(2_000);
    // The turn is under way on screen, and the capture still reports the saved scene.
    expect(s.turned()).not.toEqual([0, 0, 10]);
    expect(s.capture()).toEqual(saved);
    expect(s.player.getState().motionRunning).toBe(true);
    const sentAt = Date.now();
    await s.next();
    expect(Date.now() - sentAt).toBeLessThan(15_000);
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].failure).toBeUndefined();
    expect(s.receipts[0].scene.inspection.lessonPlayback.chapterId).toBe(monomer.steps[1].id);
    expect(s.phases).toEqual(['admit']);
    expect(s.player.getState()).toMatchObject({ step: 1, active: true, navigating: false });
  } finally { s.done(); }
});

it('a real edit while host admission is in flight still refuses next without advancing', async () => {
  const s = await headset(false);
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    s.page.call = async () => {
      s.h.workspace.capture = () => ({ ...s.capture(), selectionKeys: ['wearer-selection'] });
      return { structuredContent: { admitted: true } };
    };
    await s.next();
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].failure).toBe('local_changed');
    expect(s.player.getState().step).toBe(0);
  } finally { s.done(); }
});

it('one next right after entering VR, while the opening chapter turns and entry seats it, advances one chapter', async () => {
  const s = await headset(true);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.player.getState()).toMatchObject({ step: 0, motionRunning: true });
    const received = s.next();
    // Entry finishes after the command arrived: it seats the structure, then presents.
    await vi.advanceTimersByTimeAsync(200);
    await s.h.workspace.viewer.inspection.place({ scale: 1.4 });
    s.enter();
    await vi.advanceTimersByTimeAsync(200);
    await received;
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].failure).toBeUndefined();
    expect(s.receipts[0].scene.inspection.lessonPlayback.chapterId).toBe(monomer.steps[1].id);
    expect(s.phases).toEqual(['admit']);
    expect(s.player.getState()).toMatchObject({ step: 1, active: true, navigating: false });
  } finally { s.done(); }
});

// A chapter the host has already confirmed `rendered` is the saved scene. On a
// Quest 2 a viewer call later in the same command could find the viewer still
// finishing that chapter and throw "A molecular change is still rendering.";
// the page then put the previous chapter back and redrew the saved one over it.
const stillRendering = () => Object.assign(new Error('A molecular change is still rendering.'), { code: 'viewer_busy' });

it('keeps a chapter the host confirmed rendered when the viewer is still finishing it', async () => {
  const s = await headset(false);
  try {
    const events: any[] = [], reloads: string[] = [];
    Object.assign(s.page, { recordHeadsetEvent: (kind: string, detail: any) => events.push({ kind, ...detail }),
      reloadSavedScene: (reason: string) => { reloads.push(reason); return true; },
      speakRemoteConfirmation: () => { throw stillRendering(); } });
    await s.next();
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].failure).toBeUndefined();
    expect(reloads).toEqual([]);
    expect(s.player.getState()).toMatchObject({ step: 1, active: true });
    expect(s.capture().inspection.lessonPlayback.chapterId).toBe(monomer.steps[1].id);
    expect(events.filter(e => e.kind === 'command-rollback')).toEqual([]);
    expect(events.some(e => e.kind === 'command-phase' && e.phase === 'viewer-busy-after-rendered')).toBe(true);
  } finally { s.done(); }
});

it('still puts the chapter back when the viewer is busy before the host confirmed it', async () => {
  const s = await headset(false);
  try {
    const events: any[] = [], reloads: string[] = [];
    Object.assign(s.page, { recordHeadsetEvent: (kind: string, detail: any) => events.push({ kind, ...detail }),
      reloadSavedScene: (reason: string) => { reloads.push(reason); return true; },
      confirmReceipt: async (value: any) => { s.receipts.push(value); if (!value.failure) throw stillRendering(); return { status: 'rejected' }; } });
    await s.next();
    const putBack = events.some(e => e.kind === 'command-rollback') || reloads.includes('lesson-rollback');
    expect(putBack, JSON.stringify({ events: events.map(e => e.kind), reloads })).toBe(true);
    expect(events.some(e => e.phase === 'viewer-busy-after-rendered')).toBe(false);
  } finally { s.done(); }
});

// The device case: the real receipt step is accepted `rendered`, then its own
// capture of the drawn scene meets the viewer still finishing the chapter.
it('keeps the chapter when the confirmed receipt’s own capture meets a busy viewer', async () => {
  const s = await headset(false);
  try {
    const confirmSource = inspectorAst.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'confirmReceipt')!.getText(inspectorAst);
    vm.runInContext(ts.transpileModule(confirmSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s.page);
    const reloads: string[] = [], receipts: any[] = [];
    let busyOnce = false;
    const capture = s.h.workspace.capture;
    s.h.workspace.capture = () => { if (busyOnce) { busyOnce = false; throw stillRendering(); } return capture(); };
    Object.assign(s.page, { pendingReceiptFields: undefined, desktopReceiptInFlight: false, PRIVATE_KEY: 'private',
      expected: () => ({}), reloadSavedScene: (reason: string) => { reloads.push(reason); return true; },
      call: async (_name: string, input: any) => {
        if (input.phase === 'admit') return { structuredContent: { admitted: true } };
        receipts.push(input); busyOnce = true;
        return { structuredContent: { accepted: true, inspectionRevision: 2, sourceToken: 'source', stateRevision: 1,
          command: { commandId: 'next', status: 'rendered', renderedRevision: 2 } } };
      } });
    await s.next();
    expect(receipts).toHaveLength(1);
    expect(reloads).toEqual([]);
    expect(s.page.binding.inspectionRevision).toBe(2);
    expect(s.player.getState()).toMatchObject({ step: 1, active: true });
    expect(s.capture().inspection.lessonPlayback.chapterId).toBe(monomer.steps[1].id);
  } finally { s.done(); }
});

// A step sent while the viewer is still finishing the previous change is
// deferred by the player before it draws anything. The page used to compare
// the checkpoint against a viewer that refused its capture while busy, restore,
// meet the restore's own busy work, call that a mismatch, and redraw the whole
// saved view.
function deferredStep(s: Awaited<ReturnType<typeof headset>>, changeBeforeVisit = false,
  { deferBusyMs = 1_000, restoreBusyMs = 500 }: { deferBusyMs?: number; restoreBusyMs?: number } = {}) {
  const events: any[] = [], reloads: string[] = [], restores: any[] = [];
  const snapshot = s.h.workspace.snapshot, capture = s.h.workspace.capture;
  let settling = false, restoredTo: any, changed = false;
  const busyFor = (ms: number) => { settling = true; setTimeout(() => { settling = false; }, ms); };
  s.h.workspace.snapshot = () => settling ? { ...snapshot(), ready: false, status: 'mutating' } : snapshot();
  s.h.workspace.capture = () => {
    if (settling) throw stillRendering();
    if (restoredTo) return structuredClone(restoredTo);
    const scene = capture();
    return changed ? { ...scene, selectionKeys: ['repainted-before-the-visit'] } : scene;
  };
  // The viewer's own restore leaves it busy for a moment, as a chapter's menu clearance does.
  s.h.workspace.restoreShared = async (target: any, admit: () => void, ..._rest: unknown[]) => {
    admit(); restores.push(structuredClone(target)); restoredTo = structuredClone(target); busyFor(restoreBusyMs); return target;
  };
  let deferOnce = true;
  Object.assign(s.page, { recordHeadsetEvent: (kind: string, detail: any) => events.push({ kind, ...detail }),
    reloadSavedScene: (reason: string) => { reloads.push(reason); return true; },
    applyTourCommand: async (...args: any[]) => {
      if (deferOnce) { deferOnce = false; if (changeBeforeVisit) changed = true; busyFor(deferBusyMs); }
      return (applyTourCommand as any)(...args);
    } });
  return { events, reloads, restores };
}

it('refuses a step the player deferred without putting a chapter back, and a retry renders once the beat has saved', async () => {
  const s = await headset(false);
  try {
    const { events, reloads, restores } = deferredStep(s);
    const first = s.next(); await vi.advanceTimersByTimeAsync(3_000); await first;
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].failure).toBeDefined();
    expect(String(s.receipts[0].failureReason ?? s.receipts[0].detail ?? '')).toContain('waiting for the current scene change');
    expect(reloads).toEqual([]);
    expect(restores).toEqual([]);
    expect(events.filter(e => e.kind === 'command-rollback')).toEqual([]);
    // The wearer keeps the chapter on screen: the deferred visit does not run by itself.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.player.getState()).toMatchObject({ step: 0, navigating: false });
    // The command's own pause is all that differs from the saved scene, as for
    // any refused tour command; the next beat saves it, and a retry then renders.
    const shown = s.capture(), saved = s.page.savedScene;
    expect({ ...shown.inspection.lessonPlayback, motionPlaying: true }).toEqual(saved.inspection.lessonPlayback);
    expect({ ...shown, inspection: { ...shown.inspection, lessonPlayback: undefined } })
      .toEqual({ ...saved, inspection: { ...saved.inspection, lessonPlayback: undefined } });
    s.page.savedScene = shown; s.page.binding = { ...s.page.binding, inspectionRevision: 2 };
    const retry = s.page.receive({ panelId: 'panel', commandId: 'retry', claimToken: 'claim', change: { kind: 'tour', patch: { action: 'next' } } },
      { serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 1, baseInspectionRevision: 2 }, 1);
    await vi.advanceTimersByTimeAsync(3_000); await retry;
    expect(s.receipts).toHaveLength(2);
    expect(s.receipts[1].failure).toBeUndefined();
    expect(s.player.getState()).toMatchObject({ step: 1, active: true });
  } finally { s.done(); }
});

it('still puts the checkpoint back when the command changed the scene before its visit was deferred', async () => {
  const s = await headset(false);
  try {
    const { events, reloads, restores } = deferredStep(s, true);
    const first = s.next(); await vi.advanceTimersByTimeAsync(3_000); await first;
    expect(s.receipts[0].failure).toBeDefined();
    expect(restores).toHaveLength(1);
    expect(restores[0].selectionKeys).toEqual([]);
    expect(events.filter(e => e.kind === 'command-rollback').map(e => e.outcome)).toEqual(['restored']);
    expect(reloads).toEqual([]);
  } finally { s.done(); }
});

// The put-back waits for a settled viewer before its restore and again after
// it, up to fifteen seconds each. The caller used to see the command still
// rendering for all of that: about thirty seconds before the refusal reached
// the host, on a viewer slow to settle twice.
it('answers a refused step at once while its put-back waits out a busy viewer, and still puts the chapter back', async () => {
  const s = await headset(false);
  try {
    const { events, reloads, restores } = deferredStep(s, true, { deferBusyMs: 14_000, restoreBusyMs: 14_000 });
    const saves: number[] = [];
    s.page.save = async () => { saves.push(Date.now()); };
    const sentAt = Date.now();
    const first = s.next();
    await vi.advanceTimersByTimeAsync(2_000);
    // The refusal is on the host while the viewer is still busy with the step.
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].failure).toBeDefined();
    expect(String(s.receipts[0].failureReason ?? '')).toContain('waiting for the current scene change');
    // Nothing is saved or offered to the page until the checkpoint is back.
    expect(restores).toEqual([]);
    expect(s.page.remote).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(restores).toHaveLength(1);
    expect(s.page.remote).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); await first;
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(28_000);
    expect(s.receipts).toHaveLength(1);
    expect(restores[0].selectionKeys).toEqual([]);
    expect(events.filter(e => e.kind === 'command-rollback').map(e => e.outcome)).toEqual(['restored']);
    expect(reloads).toEqual([]);
    expect(saves).toEqual([]);
    expect(s.page.remote).toBe(false);
  } finally { s.done(); }
});

// A refusal whose answer was lost is retried after the put-back. When the
// retry finds that a newer request replaced this one, the page still owes the
// host its `settled` word, which is what releases the replaced command.
it('settles a refused step whose lost refusal turns out to have been replaced', async () => {
  const s = await headset(false);
  try {
    const { restores } = deferredStep(s, true);
    const sent: any[] = [];
    let lose = true;
    s.page.confirmReceipt = async (value: any) => {
      sent.push(value);
      if (value.failure && lose) { lose = false; throw Error('The answer was lost.'); }
      return value.phase === 'settled' ? undefined : { status: 'rejected' };
    };
    s.page.recoverConfirmation = async () => ({ status: 'superseded' });
    const first = s.next(); await vi.advanceTimersByTimeAsync(3_000); await first;
    expect(restores).toHaveLength(1);
    expect(sent.map(value => value.phase ?? (value.failure ? 'refusal' : 'receipt'))).toEqual(['refusal', 'settled']);
  } finally { s.done(); }
});
