import { describe, expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
import { applyTourCommand } from '../src/inspection-tour-client.js';
// @ts-ignore Real player DOM boundary and resting-key owner; no browser or device.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

// A restart is a fresh start. Telomerase restarted from its close-up wide
// chapter came back as chapter one wearing the last chapter's colours, at the
// last chapter's close seat, because the restart took the scene it found as
// its starting view.

const purple = { parts: [{ id: 'dyskerin', label: 'Dyskerin', color: '#7c3aed', chain: 'C' }] };
const pink = { parts: [{ id: 'dyskerin', label: 'Dyskerin', color: '#db2777', chain: 'C' }], focus: ['dyskerin'] };
const lesson: Tour = { id: 'restart', title: 'Restart', summary: '', steps: [
  { id: 'reveal', title: 'Reveal', durationMs: 60_000, appearance: { fog: 30 }, emphasis: purple },
  { id: 'site', title: 'Site', durationMs: 60_000, appearance: { fog: 10, background: '#202020' }, placement: { scale: 2.4 }, emphasis: pink },
  { id: 'wide', title: 'Wide', durationMs: 60_000, placement: { scale: 1.9 }, emphasis: { ...purple, contextOpacity: 0.3 } },
] };

/** The XR viewer keeps the live placement when asked to, as the page's restore does. */
function stage(xr = true, tour: Tour = lesson) {
  const h = tourEndHarness({ xr });
  const restore = h.workspace.viewer.inspection.restore;
  h.workspace.viewer.inspection.restore = async (saved: any, options: any = {}) => {
    const kept = options.preservePlacement ? h.capture().placement : undefined;
    await restore(saved, options);
    if (kept) await h.workspace.viewer.inspection.place(kept);
  };
  h.workspace.viewer.inspection.place({ translation: [0.4, 0, -0.3], scale: 1.1 });
  // The menu seat a fresh start frames against is the one the lesson found.
  const seats = h.workspace.viewer.inspection.restoreTourSeat = vi.fn(async () => {});
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { h, player, seats };
}

async function freshChapterOne() {
  const { h, player } = stage();
  try {
    await h.install(lesson);
    await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
    expect(player.getState().step).toBe(0);
    return h.capture();
  } finally { player.pause(); h.cleanup(); }
}

describe('restarting a lesson', () => {
  for (const xr of [false, true]) for (const keys of [['B7', 'B8'], ['C3'], []])
    it(`keeps a later wearer selection ${JSON.stringify(keys)} on MCP start (${xr ? 'XR' : 'desktop'})`, async () => {
      const { h, player } = stage(xr);
      let selectionKeys = ['C3'], lessonSelection: string | undefined = 'C3';
      const capture = h.workspace.capture, snapshot = h.workspace.snapshot;
      h.workspace.capture = () => ({ ...capture(), selectionKeys: [...selectionKeys], inspection: { lessonSelection } });
      h.workspace.snapshot = () => ({ ...snapshot(), selectionKeys: [...selectionKeys] });
      h.workspace.viewer.select = async (keys: string[], _kind?: string, options?: { lesson?: boolean }) => {
        selectionKeys = [...keys]; lessonSelection = options?.lesson ? [...keys].sort().join('\n') : undefined;
      };
      const restore = h.workspace.viewer.inspection.restore;
      h.workspace.viewer.inspection.restore = async (saved: any, options: any) => {
        await restore(saved, options);
        selectionKeys = [...saved.selectionKeys]; lessonSelection = saved.inspection.lessonSelection;
      };
      try {
        await h.install(lesson);
        await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
        await applyTourCommand(player, { action: 'next' });
        await h.workspace.viewer.select(keys);
        await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
        expect(player.getState().step).toBe(0);
        expect(h.workspace.capture().selectionKeys).toEqual(keys);
        expect(h.workspace.capture().inspection.lessonSelection).toBeUndefined();
      } finally { player.pause(); h.cleanup(); }
    });

  it('shows chapter one exactly as a fresh start does after the last chapter', async () => {
    const fresh = await freshChapterOne();
    const { h, player, seats } = stage();
    try {
      await h.install(lesson);
      await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
      await applyTourCommand(player, { action: 'next' });
      await applyTourCommand(player, { action: 'next' });
      expect(player.getState().step).toBe(2);
      expect(h.capture()).not.toEqual(fresh);
      expect(seats).not.toHaveBeenCalled();
      await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
      expect(player.getState()).toMatchObject({ step: 0, active: true, navigating: false });
      expect(h.capture()).toEqual(fresh);
      expect(seats).toHaveBeenCalledTimes(1);
      expect(seats).toHaveBeenLastCalledWith({ restart: true });
      // A second restart starts from the same view, not the one before it.
      await applyTourCommand(player, { action: 'next' });
      await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
      expect(h.capture()).toEqual(fresh);
    } finally { player.pause(); h.cleanup(); }
  });

  // A headset spin chapter turns the camera that maps the structure into the
  // room. Telomerase left its "Slow orbit" before the turn came round, and a
  // restart then kept that turn: chapter one came back seen end-on, at another
  // size, with its readout and legend moved. A held placement is the wearer's,
  // and keeps the live camera as it always did.
  for (const held of [false, true]) it(held ? 'keeps the live camera through a restart while the placement is held'
    : 'brings back the starting camera after a spin chapter left mid-turn', async () => {
    const spin: Tour = { ...lesson, id: 'spin', steps: [{ ...lesson.steps[0], placement: { scale: 1 } },
      { id: 'orbit', title: 'Slow orbit', durationMs: 60_000,
        cameraSpin: { axis: [0, -1, 0], degrees: 360, seconds: 1, delaySeconds: 0, easing: 'linear' } },
      lesson.steps[2]] };
    const { h, player } = stage(true, spin);
    let yaw = 0;
    const capture = h.workspace.capture;
    h.workspace.capture = () => ({ ...capture(), camera: { yaw } });
    const restore = h.workspace.viewer.inspection.restore;
    h.workspace.viewer.inspection.restore = async (saved: any, options: any = {}) => {
      await restore(saved, options);
      if (!options.preserveCamera) yaw = saved.camera.yaw;
    };
    // Chapter one's seat is solved through the camera, so a turned camera
    // frames it at another scale.
    const place = h.workspace.viewer.inspection.place;
    h.workspace.viewer.inspection.place = async (patch: any) =>
      place(patch.scale ? { ...patch, scale: patch.scale * (1.27 + Math.abs(Math.sin(yaw * Math.PI / 180))) } : patch);
    (h.workspace.viewer.inspection as any).applyLessonMotion = async (move: { degrees: number }) => { yaw += move.degrees; };
    (h.workspace.viewer.inspection as any).holdsWearerPlacement = () => held;
    try {
      await h.install(spin);
      await applyTourCommand(player, { action: 'start', tourId: spin.id, autoplay: false, narration: false });
      const first = h.workspace.capture();
      await applyTourCommand(player, { action: 'next' });
      await new Promise(resolve => setTimeout(resolve, 400));
      await applyTourCommand(player, { action: 'next' });
      expect(player.getState().step).toBe(2);
      expect(Math.abs(yaw % 360)).toBeGreaterThan(30);
      const turned = yaw;
      await applyTourCommand(player, { action: 'start', tourId: spin.id, autoplay: false, narration: false });
      expect(player.getState()).toMatchObject({ step: 0, active: true, navigating: false });
      if (held) expect(h.workspace.capture().camera).toEqual({ yaw: turned });
      else expect(h.workspace.capture()).toEqual(first);
    } finally { player.pause(); h.cleanup(); }
  });

  it('plays a lesson again from its starting view, not from its closing chapter', async () => {
    const fresh = await freshChapterOne();
    const { h, player } = stage();
    try {
      await h.install(lesson);
      await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
      await applyTourCommand(player, { action: 'next' });
      await applyTourCommand(player, { action: 'next' });
      await player.start(false);
      expect(player.getState().step).toBe(0);
      expect(h.capture()).toEqual(fresh);
    } finally { player.pause(); h.cleanup(); }
  });

  it('brings chapter one back whole when Back reaches it from a close seat', async () => {
    const fresh = await freshChapterOne();
    const { h, player, seats } = stage();
    try {
      await h.install(lesson);
      await applyTourCommand(player, { action: 'start', tourId: lesson.id, autoplay: false, narration: false });
      await applyTourCommand(player, { action: 'next' });
      await applyTourCommand(player, { action: 'back' });
      expect(player.getState().step).toBe(0);
      expect(h.capture()).toEqual(fresh);
      expect(seats).toHaveBeenCalledTimes(1);
    } finally { player.pause(); h.cleanup(); }
  });
});
