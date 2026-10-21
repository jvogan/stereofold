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
