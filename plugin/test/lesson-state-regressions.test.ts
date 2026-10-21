import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { withTextState, TEXT_STATE_MAX_CHARS } from '../src/tool-text-state.js';
import { parseMolecularLesson } from '../src/molecular-lesson.js';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
import { measureAtoms } from '../src/inspection-measure.js';
import { validateLessonSource } from '../src/lesson-source-validation.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import { waitForPanelRender } from '../src/inspection-render-settle.js';
// @ts-ignore Shared DOM fixture; no browser or device.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Production scene defaults.
import { DEFAULT_INSPECTION } from '../../lab/browser-roundtrip/inspection-state.mjs';

const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const density = () => parseMolecularLesson(JSON.parse(readFileSync(new URL('../demos/microtubule-arrival/density.json', import.meta.url), 'utf8')));
/** Every fenced JSON block a text-only host receives, in order. */
const textBlocks = (structuredContent: any) => {
  const answer = withTextState({ structuredContent });
  const text = answer.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(block => ({ raw: block[0], value: JSON.parse(block[1]) }));
};

it('round-trips the complete density manifest through text, including metadata and public references', () => {
  const lesson = density();
  const blocks = textBlocks({ lessonManifest: lesson });
  const manifest = blocks.find(block => block.value.lessonManifest)?.value.lessonManifest;
  expect(parseMolecularLesson(manifest)).toEqual(lesson);
  expect(manifest).toEqual(lesson);
  const state = blocks.find(block => block.value.textStateVersion === 1)!;
  expect(state.value.truncated).toBe(false);
  expect(state.raw.length).toBeLessThanOrEqual(TEXT_STATE_MAX_CHARS);
});

it('omits a manifest over its byte contract atomically without pointing a text-only host at structured content', () => {
  const lesson: any = density();
  lesson.title = 'x'.repeat(262_145);
  const original = structuredClone(lesson);
  const blocks = textBlocks({ sessionId: 'session', lessonManifest: lesson });
  expect(blocks).toHaveLength(1);
  const [state] = blocks;
  expect(state.raw.length).toBeLessThanOrEqual(TEXT_STATE_MAX_CHARS);
  expect(state.value.truncated).toBe(true);
  expect(state.value.lessonManifest).toBeUndefined();
  expect(state.value.lessonManifestNotice).toContain('omitted');
  expect(state.raw).not.toMatch(/structuredContent/);
  expect(lesson).toEqual(original);
});

it.each(['playing', 'paused'])('hydration preserves the saved molecular clock: %s', async state => {
  const h = tourEndHarness({ xr: false });
  const tour: Tour = { id: 'lesson-live', title: 'Live', summary: '', steps: [{ id: 'one', title: 'One', durationMs: 60000 }] };
  const start = { sourceSha256: 'same', modelNumber: 1, assemblyId: '', inspection: {} };
  const saved = { ...start, inspection: { lessonPlayback: { tourId: tour.id, chapterId: 'one', stopped: false, startingScene: start } } };
  const playback = { state, timeSeconds: 3, speed: 2, loop: false };
  h.workspace.viewer.inspection.controlMolecularAnimation = (patch: any) => {
    if (patch.state) playback.state = patch.state === 'play' ? 'playing' : 'paused';
    if (patch.seekSeconds !== undefined) playback.timeSeconds = patch.seekSeconds;
    if (patch.restart) playback.timeSeconds = 0;
  };
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const context: any = { tourPlayer: player, data: { customTour: tour, scene: saved }, TOURS: [], closed: false,
    densityReferencePreview: false, panelCustomTour: tour, options: {},
    generation: 1, ownGeneration: 1, restoredLessonPlayback: false, installedLesson: undefined, grownLesson: undefined, isCompanion: false };
  try {
    // Execute the hydration bookkeeping actually shipped by the inspector, after scene restore.
    const from = inspector.indexOf('      const hasSavedPlayback');
    const to = inspector.indexOf('\n    }', from);
    expect(from).toBeGreaterThan(0);
    await vm.runInNewContext(transpile(`(async()=>{${inspector.slice(from, to)}})()`), context);
    expect(context.restoredLessonPlayback).toBe(true);
    expect(player.getState()).toMatchObject({ selectedId: tour.id, step: 0 });
    expect(playback).toEqual({ state, timeSeconds: 3, speed: 2, loop: false });
  } finally { player.pause(); h.cleanup(); }
});

it.each(['rendered', 'rejected', 'paused'])('lost install acknowledgement resumes only confirmed, still-playing autoplay: %s', async outcome => {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr: false }), player = mountTourPlayer({ ...h, tours: [] });
  const tour: Tour = { id: 'lesson-short', title: 'Short', summary: '', presentation: { captionCard: 'shown', end: 'hold' }, steps: [
    { id: 'first', title: 'First', durationMs: 100 }, { id: 'second', title: 'Second', durationMs: 100 },
  ] };
  try {
    await expect(player.installLesson(tour, { autoplay: true, narration: false }, async () => {
      throw Error('Acknowledgement lost after host commit');
    })).rejects.toThrow('Acknowledgement lost');
    await vi.advanceTimersByTimeAsync(180);
    expect(player.getState()).toMatchObject({ step: 0, autoplay: true });
    if (outcome === 'paused') player.pause();
    const scene = h.workspace.capture();
    const receipt = { commandId: 'install', baseStateRevision: 1, scene };
    const status = outcome === 'rejected' ? 'rejected' : 'rendered';
    const context: any = { isCompanion: true, pendingReceipt: receipt, pendingReceiptFields: ['lesson'],
      binding: { sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 }, tourCommandContext: undefined,
      call: async () => ({ structuredContent: { accepted: status === 'rendered', sourceToken: 'source', stateRevision: 1,
        inspectionRevision: 2, command: { commandId: 'install', status, renderedRevision: 2 } } }),
      recordLoopStage() {}, showOutcome() {}, workspace: h.workspace, tourPlayer: player, savedScene: undefined,
      dirty: true, blocked: false, notice: { hidden: false } };
    const ast = ts.createSourceFile('inspector.ts', inspector, ts.ScriptTarget.Latest, true);
    const confirm = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'confirmReceipt')!;
    vm.runInNewContext(transpile(confirm.getText(ast)), context);
    if (status === 'rejected') await expect(context.confirmReceipt(receipt)).rejects.toThrow();
    else await context.confirmReceipt(receipt);
    await vi.advanceTimersByTimeAsync(180);
    expect(player.getState().step).toBe(outcome === 'rendered' ? 1 : 0);
  } finally { player.pause(); h.cleanup(); vi.useRealTimers(); }
});

it('a one-second receipt wait leaves a two-second panel transition pending and then renders', async () => {
  let now = 0;
  const binding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 };
  const expected = { serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 1, baseInspectionRevision: 1 };
  const commands = new InspectionCommands(() => now), panelId = commands.attach(expected, binding);
  const scene: any = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '', selectionKeys: [], camera: {}, inspection: structuredClone(DEFAULT_INSPECTION) };
  commands.enqueue({ ...expected, panelId, commandId: 'short-wait', waitForRenderMs: 1000,
    change: { kind: 'appearance', patch: { opacity: .5 } } }, binding, scene);
  const polled = commands.poll({ ...expected, panelId, availability: 'ready' }, binding);
  if (!('delivery' in polled) || !polled.delivery) throw Error('No delivery');
  const delivery = polled.delivery;
  await waitForPanelRender({ ready: () => now >= 2000, current: () => true, waitMs: delivery.settleBudgetMs,
    now: () => now, sleep: async ms => { now += ms;
      if (now === 1000) expect(commands.summary(binding, 'short-wait').command?.status).toBe('rendering');
    } });
  expect(now).toBe(2000);
  scene.inspection.appearance.opacity = .5;
  expect(commands.complete({ ...expected, panelId, commandId: 'short-wait', claimToken: delivery.claimToken, scene }, binding))
    .toMatchObject({ accepted: true, command: { status: 'rendered' } });
});

it('measures validated 4HHB label-chain E parts and reports their membership in candidates', async () => {
  const catalog: any = await extractInspectionCatalogBytes(readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8'));
  const part = { id: 'heme', label: 'Heme', chain: 'E', color: '#ffffff' };
  const lesson = parseMolecularLesson({ version: 1, id: 'label-chain', title: 'Label chains', mode: 'explore',
    provenance: { sourceRefs: [{ kind: 'local', ref: '4HHB.cif' }] }, chapters: [{ id: 'one', title: 'One', caption: 'Ligand',
      durationSeconds: 1, changes: [{ kind: 'hold', durationSeconds: 1 }], immersive: { motion: 'hold', parts: [part] } }] });
  const scene = { modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId, inspection: {} };
  validateLessonSource(lesson, catalog, scene.modelNumber);
  const measured: any = measureAtoms(catalog, scene, [{ part: part.id }, { part: part.id }], null, [part]);
  expect(measured.ok).toBe(true);
  expect(measured.atoms[0]).toMatchObject({ labelChain: 'E', authorChain: 'A', part: 'heme' });
  const candidates: any = measureAtoms(catalog, scene, [{ labelChain: 'E' }, { part: part.id }], null, [part]);
  expect(candidates.errors[0].candidates[0].parts).toContainEqual({ id: 'heme', label: 'Heme' });
  const outside: any = measureAtoms(catalog, scene, [{ part: part.id }, { part: part.id }], null,
    [{ ...part, residues: { from: 99999, to: 99999 } }]);
  expect(outside.ok).toBe(false);
});
