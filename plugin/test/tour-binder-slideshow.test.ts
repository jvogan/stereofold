import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { mountTourPlayer } from '../src/tour-player.js';
// @ts-ignore Production molecular controller state machine.
import { createXrManipulation, rotationDegrees } from '../../lab/browser-roundtrip/xr-manipulate.mjs';
// @ts-ignore Production player with only DOM and molecular drawing adapted.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const copyId = '["copy","asymmetric_unit",null,[]]';
const lesson = molecularLessonToTour({
  version: 1, id: 'private-binder-slideshow', title: 'Binder comparison', mode: 'guided',
  provenance: { sourceRefs: [{ kind: 'modelled', ref: 'Private aligned complexes' }] },
  presentation: { captionCard: 'hidden', end: 'hold' },
  chapters: Array.from({ length: 17 }, (_, index) => {
    const target = `T${index}`, binder = `B${index}`;
    return {
      id: `complex-${index + 1}`, title: `Complex ${index + 1}`, caption: `Private complex ${index + 1}.`,
      durationSeconds: 5, changes: [{ kind: 'hold', durationSeconds: 5 }],
      immersive: {
        appearance: { background: '#ffffff', representation: 'cartoon', color: 'uniform', uniformColor: '#b0b0b0', opacity: 0, labels: false, fog: 0 },
        motion: 'hold', visibility: { op: 'only', chains: [target, binder], classes: ['polymer'] },
        figure: {
          layers: [
            { id: 'target', target: { chain: target }, representation: 'gaussian-surface', color: '#b0b0b0' },
            { id: 'binder', target: { chain: binder }, representation: 'cartoon', color: '#2366ce' },
            { id: 'binder-envelope', target: { chain: binder }, representation: 'gaussian-surface', color: '#2366ce', opacity: .12 },
          ],
          labels: [{ id: 'name', target: { chain: binder }, text: `Complex ${index + 1}`, color: '#303840', sizeFactor: 1.4 }],
        },
      },
    };
  }),
});

function stage(xr: boolean) {
  vi.useFakeTimers();
  const h = tourEndHarness({ xr });
  const rows = Array.from({ length: 17 }, (_, i) => [`T${i}`, `B${i}`]).flat().map(labelChain => ({
    key: labelChain, entityType: 'polymer', identity: { labelChain, authorChain: labelChain, copyId, modelNumber: 1 },
  }));
  let figure: any, held = false, dragging = false, camera = { position: [0, 0, 40] }, visibility: any = { hiddenChains: [], hiddenClasses: [], showOnlySelection: false };
  const figures: any[] = [], masks: any[] = [], paints: any[] = [];
  const inspection = h.workspace.viewer.inspection;
  const capture = h.workspace.capture, snapshot = h.workspace.snapshot, restore = inspection.restore, configure = inspection.configure;
  h.workspace.rows = () => rows;
  h.workspace.capture = () => ({ ...capture(), camera: structuredClone(camera), figure: structuredClone(figure), visibility: structuredClone(visibility) });
  h.workspace.snapshot = () => ({ ...snapshot(), modelNumber: 1, selectionKeys: [], interactionActive: dragging });
  Object.assign(inspection, {
    configure: async (patch: any) => { paints.push(patch); await configure(patch); },
    setLessonFigure: async (value: any) => { figure = structuredClone(value); figures.push(figure); },
    visibility: () => visibility,
    setVisibility: async (value: any) => { visibility = structuredClone(value); masks.push(visibility); },
    setMolecularAnimation: async () => {},
    supportsConcurrentPlayback: true,
    holdsWearerPlacement: () => held,
    beginChapterFraming: () => { held = false; },
    restore: async (saved: any, options: any) => {
      const placement = capture().placement;
      await restore(options?.preservePlacement ? { ...saved, placement } : saved, options);
      if (!options?.preserveCamera) camera = structuredClone(saved.camera);
      figure = structuredClone(saved.figure); visibility = structuredClone(saved.visibility);
    },
  });
  const player = mountTourPlayer({ ...h, tours: [lesson] });
  return { h, player, inspection, figures, masks, paints,
    async move(index = 0) {
      held = true; camera = { position: [12 + index, 4, 38] };
      await inspection.place({ scale: 1.8 + index / 10, translation: [3 + index, 2, 1], rotation: [10 + index, 20, 30] });
    },
    drag(value: boolean) { dragging = value; },
    held: () => held,
    hold() { held = true; },
    release() { held = false; },
    close() { player.pause(); h.cleanup(); vi.useRealTimers(); } };
}

for (const gesture of ['ray', 'grip', 'two grips']) it(`real molecule ${gesture} keeps autoplay through three chapter redraws without running menu relocation`, async () => {
  const s = stage(true);
  const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  let inputHeld = false;
  const relocation = vi.fn(() => []), measurements = vi.fn(() => undefined);
  const context = vm.createContext({
    canvas: { xr: { isPresenting: { value: true } } }, latestRoomPlacementPose: {},
    interactionActive: () => inputHeld, chapterFieldBounds: measurements,
    inspectionState: {}, takeWearerPlacement: () => s.hold(),
    onInteraction: () => s.player.notifyMutation(undefined, { interaction: true }), console,
    grabFeedback: { admitted() {} }, cancelXrPlacementFollowup() {}, beginGesturePivot() {},
    talkCaption: { set() {} }, pausePresentationForInput: async () => {},
  });
  const clearanceStart = source.indexOf('  async function clearChapterMenu(');
  vm.runInContext(source.slice(clearanceStart, source.indexOf('\n  }', clearanceStart) + 4), context);
  const signalStart = source.indexOf('  const signalManualInteraction = kind => {');
  vm.runInContext(source.slice(signalStart, source.indexOf('\n  };', signalStart) + 5), context);
  const hook = source.match(/onGrabStart: (\(\) => \{[^\n]+\}), \/\/ The menu remains/);
  expect(hook).not.toBeNull();
  const onGrabStart = vm.runInContext(`(${hook![1]})`, context);
  s.h.workspace.viewer.xr = { refreshToolbar: () => context.clearChapterMenu({
    points: [], isCurrent: () => true, relocationCandidates: relocation, lesson: true,
  }) };
  const sources = new Map();
  const pointer = (hand: string, x: number, index = 0, held = true) => {
    if (!sources.has(hand)) sources.set(hand, { handedness: hand, targetRayMode: 'tracked-pointer' });
    const angle = index * .003;
    return { handedness: hand, source: sources.get(hand), buttons: held ? gesture === 'ray' ? 1 : 2 : 0,
      ray: { origin: [x, 1.4, index * .001], direction: [Math.sin(angle), 0, -Math.cos(angle)] } };
  };
  const deltas: any[] = [];
  const manipulation = createXrManipulation({ now: Date.now, onGrabStart, triggerTargetDistance: () => 3,
    pulse() {}, record() {}, onDelta: (delta: any) => {
      deltas.push(delta);
      const placement = s.h.workspace.capture().placement;
      void s.inspection.place({
        ...(delta.translation ? { translation: (placement.translation ?? [0, 0, 0]).map((value: number, axis: number) => value + delta.translation[axis]) } : {}),
        ...(delta.scale ? { scale: placement.scale * delta.scale } : {}),
        ...(delta.rotation ? { rotation: [0, (placement.rotation?.[1] ?? 0) + rotationDegrees(delta.rotation), 0] } : {}),
      });
    } });
  try {
    await s.player.installLesson(lesson, { chapterId: lesson.steps[0].id, autoplay: true, narration: false });
    measurements.mockClear();
    inputHeld = true; s.drag(true);
    for (let index = 0; index <= 150; index++) {
      const pointers = [pointer('right', .2 + index * .001, index)];
      if (gesture === 'two grips') pointers.push(pointer('left', -.2 - index * .001, index));
      manipulation.update(pointers);
      if (index > 0) await vi.advanceTimersByTimeAsync(100);
      expect(s.player.getState()).toMatchObject({ autoplay: true, stopped: false });
    }
    expect(manipulation.phase()).toBe(gesture === 'two grips' ? 'scale' : 'grab');
    expect(s.player.getState()).toMatchObject({ step: 3, autoplay: true });
    expect(deltas.length).toBeGreaterThan(10);
    if (gesture === 'two grips') expect(deltas.some(delta => delta.scale !== undefined)).toBe(true);
    else if (gesture === 'grip') expect(deltas.some(delta => delta.rotation !== undefined)).toBe(true);
    else expect(deltas.some(delta => delta.translation !== undefined)).toBe(true);
    expect(relocation).not.toHaveBeenCalled();
    expect(measurements).not.toHaveBeenCalled();
    const heldPose = s.h.workspace.capture().placement;
    inputHeld = false; s.drag(false);
    manipulation.update([pointer('right', .35, 150, false), pointer('left', -.35, 150, false)]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.player.getState()).toMatchObject({ step: 4, autoplay: true });
    expect(s.h.workspace.capture().placement).toEqual(heldPose);
  } finally { s.close(); }
});

for (const chapter of [0, 4]) it(`Reset then Play retains its rendered room pose through the next three slides from chapter ${chapter + 1}`, async () => {
  const s = stage(true);
  const resetPose = { translation: [.5538995105144608, .03625360853914114, -2.916473216682924],
    rotation: [0, 0, 0], scale: .9793028266267692 };
  try {
    await s.inspection.place({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
    await s.player.installLesson(lesson, { chapterId: lesson.steps[chapter].id, autoplay: false, narration: false });
    const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    const begin = viewer.indexOf('  async function seatStructureForEntry(');
    const code = viewer.slice(begin, viewer.indexOf('\n  }', begin) + 4);
    const context = vm.createContext({
      xrManipulation: null, xrThumbstick: null, xrPushStick: null, xrDeferredGrab: false, xrDeferredBake: false,
      grabRotation: null, grabScale: 1, grabOffset: null, assertReady() {},
      canvas: { xr: { isPresenting: { value: true } } }, performance: { now: () => 0 }, latestHeadSample: 0,
      latestRoomPlacementPose: {}, inspectionSnapshot: () => ({ placement: s.h.workspace.capture().placement }),
      loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }), roomAnchor: null,
      roomAnchorPlacement: () => ({ ...structuredClone(resetPose), mode: 'auto', metersAcross: 1.75 }),
      setInspectionMotion: async () => {},
      inspectionState: { checkpoint: () => s.h.workspace.capture().placement, restoreCheckpoint() {},
        place: (patch: any) => s.inspection.place(patch) },
      mutate: async (_kind: any, apply: any) => apply(), syncInspectionPayload() {}, applyInspectionTransform() {},
      spatialTour: s.player, notePlacement() {}, recordManipulation() {}, releaseWearerPlacement: s.release,
    });
    vm.runInContext(code, context);
    await context.seatStructureForEntry({ resetMenu: true });
    expect(s.player.getState()).toMatchObject({ step: chapter, stopped: true, autoplay: false });
    expect(s.h.workspace.capture().placement).toEqual(resetPose);
    await s.player.togglePlay();
    expect(s.h.workspace.capture().placement).toEqual(resetPose);
    expect(s.player.getState()).toMatchObject({ step: chapter, stopped: false, autoplay: true });
    for (let index = chapter + 1; index <= chapter + 3; index++) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.player.getState()).toMatchObject({ step: index, autoplay: true });
      expect(s.h.workspace.capture().placement).toEqual(resetPose);
    }
  } finally { s.close(); }
});

for (const xr of [false, true]) it(`shows every binder for its five-second silent dwell and holds the final slide (XR=${xr})`, async () => {
  const s = stage(xr);
  try {
    await s.player.installLesson(lesson, { chapterId: 'complex-1', autoplay: true, narration: false });
    s.h.restores.length = 0;
    for (let index = 0; index < 17; index++) {
      expect(s.player.getState()).toMatchObject({ active: true, step: index, autoplay: true, narration: false });
      const current: any = s.h.workspace.capture();
      expect(current.figure).toEqual(lesson.steps[index].figure);
      const visible = rowsVisible(s.h.workspace.rows(), current.visibility);
      expect(visible).toEqual([`T${index}`, `B${index}`]);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(s.player.getState().step).toBe(index);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(s.player.getState()).toMatchObject({ active: true, step: 16, autoplay: false });
    expect(s.figures).toEqual(lesson.steps.map(step => step.figure));
    expect(s.paints).toEqual(lesson.steps.map(step => step.appearance));
    expect(s.h.restores, 'linear playback never restores/rebuilds the composite').toEqual([]);
    expect(s.h.spoken).toEqual([]);
  } finally { s.close(); }
});

const rowsVisible = (rows: any[], mask: any) => rows.filter(row => !mask.hiddenChains.some((chain: any) =>
  chain.labelChain === row.identity.labelChain && chain.copyId === row.identity.copyId)).map(row => row.identity.labelChain);

it('pause and manual Back/Next retain the installed slideshow and restart a complete dwell', async () => {
  const s = stage(true);
  try {
    await s.player.installLesson(lesson, { autoplay: true, narration: false });
    await vi.advanceTimersByTimeAsync(5_000);
    s.player.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.player.getState()).toMatchObject({ step: 1, autoplay: false });
    await s.player.back();
    expect(s.player.getState()).toMatchObject({ step: 0, autoplay: false });
    await s.player.next();
    expect(s.player.getState()).toMatchObject({ step: 1, autoplay: false });
    await s.player.togglePlay();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.player.getState().step).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.player.getState().step).toBe(2);
  } finally { s.close(); }
});

for (const xr of [false, true]) it(`aligned binder slides retain the wearer's placement and camera through Next and Back (XR=${xr})`, async () => {
  const s = stage(xr);
  try {
    await s.player.installLesson(lesson, { autoplay: false, narration: false });
    await s.move();
    const moved: any = s.h.workspace.capture();
    await s.player.next();
    await s.player.back();
    const current: any = s.h.workspace.capture();
    expect(current.camera).toEqual(moved.camera);
    expect(current.placement).toEqual(moved.placement);
    expect(current.figure).toEqual(lesson.steps[0].figure);
    expect(s.held()).toBe(true);
  } finally { s.close(); }
});

it('direct installation of a later slide hides the base composite without depending on the first chapter', async () => {
  const s = stage(true);
  try {
    await s.player.installLesson(lesson, { chapterId: 'complex-12', autoplay: false, narration: false });
    expect(s.player.getState()).toMatchObject({ step: 11, autoplay: false });
    const current: any = s.h.workspace.capture();
    expect(current.appearance).toMatchObject({ background: '#ffffff', opacity: 0 });
    expect(current.figure).toEqual(lesson.steps[11].figure);
    expect(rowsVisible(s.h.workspace.rows(), current.visibility)).toEqual(['T11', 'B11']);
    expect(s.figures).toEqual([lesson.steps[11].figure]);
  } finally { s.close(); }
});

for (const xr of [false, true]) it(`keeps swapping all 17 figures while a drag remains active and inherits each latest pose (XR=${xr})`, async () => {
  const s = stage(xr);
  try {
    await s.player.installLesson(lesson, { autoplay: true, narration: false });
    s.drag(true);
    for (let index = 1; index < 17; index++) {
      await s.move(index);
      s.player.notifyMutation(s.h.workspace.snapshot(), { interaction: true });
      const chosen: any = s.h.workspace.capture();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.player.getState()).toMatchObject({ step: index, autoplay: true, stopped: false });
      const shown: any = s.h.workspace.capture();
      expect(shown.camera).toEqual(chosen.camera);
      expect(shown.placement).toEqual(chosen.placement);
      expect(shown.figure).toEqual(lesson.steps[index].figure);
      expect(s.h.workspace.snapshot().interactionActive).toBe(true);
      expect(s.held()).toBe(true);
    }
    expect(s.h.restores, 'a live drag never restores a captured pose').toEqual([]);
    await s.player.back();
    expect(s.player.getState()).toMatchObject({ step: 15, autoplay: true });
    expect(s.h.workspace.snapshot().interactionActive).toBe(true);
  } finally { s.close(); }
});
