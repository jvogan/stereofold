import { afterEach, expect, it, vi } from 'vitest';
import { EXPERIENCE_PAGE_MIN_MS, experiencePageDwellMs, mountExperiencePlayer, type ExperiencePlayer } from '../src/experience-player.js';
import { MOLECULAR_EXPERIENCES, stageForStep } from '../src/molecular-experience.js';

const catalog = MOLECULAR_EXPERIENCES.map(item => ({ id: item.id, title: item.title, steps: item.steps.length,
  sources: item.stages.map(stage => ({ pdbId: stage.source.pdbId, assemblyId: stage.assembly.assemblyId, stepIndex: item.steps.findIndex(step => step.stageId === stage.id) })) }));
const hemoglobin = 'hemoglobin-quaternary-structure';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });
function harness(overrides: Partial<Parameters<typeof mountExperiencePlayer>[0]> = {}) {
  const original = globalThis.document;
  const events = new Map<string, () => void>();
  function element(): any {
    const children = new Map();
    return { dataset: {}, textContent: '', value: '', hidden: false, after() {}, remove() {}, setAttribute() {},
      addEventListener() {}, replaceChildren() {}, querySelectorAll: () => [],
      querySelector(selector: string) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); } };
  }
  globalThis.document = { createElement: element,
    addEventListener: (name: string, listener: () => void) => events.set(name, listener),
    removeEventListener: (name: string) => events.delete(name), hidden: false } as any;
  let player: ExperiencePlayer;
  const feedback = vi.fn();
  const rendered = (id: string, stepIndex: number) => {
    const definition = MOLECULAR_EXPERIENCES.find(item => item.id === id)!;
    player.update({ definition, revision: stepIndex + 1, stepIndex, stageId: stageForStep(definition, stepIndex).id, sourceKey: 'rendered' });
  };
  const navigate = vi.fn(async (id: string, step: number, _loadedOnly?: boolean) => { rendered(id, step); });
  const finish = vi.fn(async () => ({ status: 'rendered' as const }));
  const narrate = vi.fn(async () => {});
  player = mountExperiencePlayer({ after: element(), navigate, finish, explore() {}, onFeedback: feedback, narrate, ...overrides });
  player.setCatalog(catalog); player.setSubject({ pdbId: '4hhb', assembly: 'asymmetric_unit', modelNumber: 1, sourceSha256: 'loaded' });
  cleanups.push(() => { player.dispose(); globalThis.document = original; });
  return { player, navigate, finish, feedback, rendered, narrate,
    visibility(hidden: boolean) { Object.assign(document, { hidden }); events.get('visibilitychange')?.(); } };
}
it('keeps narration off through chapter navigation and Play, then restores the fresh-start default', async () => {
  const { player, narrate } = harness();
  await player.start(false, undefined, { narration: false });
  await player.next(); await player.back(); await player.rejoin();
  await player.togglePlay(); player.pause();
  await player.openMenu(); await player.togglePlay(); player.pause();
  expect(player.getState()).toMatchObject({ active: true, narration: false });
  expect(narrate).not.toHaveBeenCalled();
  await player.start(false);
  expect(player.getState().narration).toBe(true);
  expect(narrate).toHaveBeenCalledTimes(1);
});
it.each([false,true])('renders and narrates an opening stage once when switching experiences (prior=%s)', async prior => {
  const {player,navigate,narrate,rendered}=harness();
  if(prior) rendered(hemoglobin,0);
  await player.goToStage('tubulin-dimer','tubulin-eb3-lattice');
  expect(navigate).toHaveBeenCalledExactlyOnceWith('tubulin-eb3-lattice',0,false);
  expect(narrate).toHaveBeenCalledTimes(1);
  expect(player.getState()).toMatchObject({active:true,step:0,selectedId:'tubulin-eb3-lattice',navigating:false});
  // An explicit later request for the current stage still replays that visit.
  await player.goToStage('tubulin-dimer','tubulin-eb3-lattice');
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(narrate).toHaveBeenCalledTimes(2);
});
it('still visits a requested later stage after opening its experience', async () => {
  const {player,navigate,narrate}=harness();
  const definition=MOLECULAR_EXPERIENCES.find(item=>item.id==='tubulin-eb3-lattice')!;
  const step=definition.steps.findIndex(item=>item.stageId==='protofilament-slice');
  expect(step).toBeGreaterThan(0);
  await player.goToStage('protofilament-slice',definition.id);
  expect(navigate.mock.calls).toEqual([[definition.id,0,false],[definition.id,step,false]]);
  expect(narrate).toHaveBeenCalledTimes(2);
  expect(player.getState().step).toBe(step);
});
it('Tour starts hemoglobin on loaded 4HHB even though tubulin is first in the catalog', async () => {
  const { player, navigate } = harness();
  expect(player.getState()).toMatchObject({ active: false, menuOpen: false, title: '', progress: '' });
  await player.togglePlay();
  expect(navigate).toHaveBeenCalledExactlyOnceWith(hemoglobin, 0, true);
  expect(player.getState()).toMatchObject({ active: true, autoplay: true, selectedId: hemoglobin, step: 0 });
});
it('no matching journey changes no scene and reports the same refusal to plate and speech/status', async () => {
  const { player, navigate, feedback } = harness();
  player.setSubject({ pdbId: '2XYZ' });
  await expect(player.togglePlay()).rejects.toThrow('No journey for 2XYZ yet');
  expect(navigate).not.toHaveBeenCalled();
  expect(player.getState()).toMatchObject({ active: false, autoplay: false, feedback: 'No journey for 2XYZ yet', feedbackError: true });
  expect(feedback).toHaveBeenCalledExactlyOnceWith('No journey for 2XYZ yet');
});
it('Tours explicitly chooses a different source; a loaded later stage starts at its matching step', async () => {
  const { player, navigate } = harness();
  await player.openMenu(); await player.select('gfp-chromophore'); await player.togglePlay();
  expect(navigate).toHaveBeenLastCalledWith('gfp-chromophore', 0, false);
  await player.finish(); player.setSubject({ pdbId: '3JAK', assembly: '1' }); await player.togglePlay();
  expect(navigate).toHaveBeenLastCalledWith('tubulin-eb3-lattice', 15, true);
});
it('a failed step keeps the rendered counter and stops autoplay with its specific error on the plate', async () => {
  vi.useFakeTimers();
  const { player, navigate, feedback } = harness(); await player.togglePlay();
  navigate.mockRejectedValueOnce(Error('Journey could not render: atom budget exceeded. Previous view restored.'));
  await expect(player.next()).rejects.toThrow('atom budget exceeded');
  expect(player.getState()).toMatchObject({ step: 0, active: true, autoplay: false, navigating: false, feedbackError: true });
  expect(feedback).toHaveBeenCalledWith(player.getState().feedback);
  await vi.advanceTimersByTimeAsync(30_000); expect(navigate).toHaveBeenCalledTimes(2);
});
it('a successful navigation callback without a rendered update never starts or advances the counter', async () => {
  const { player, navigate } = harness(); navigate.mockImplementation(async () => {});
  await expect(player.togglePlay()).rejects.toThrow('has not been confirmed');
  expect(player.getState()).toMatchObject({ step: -1, active: false, autoplay: false, feedbackError: true });
});
it('Done ends experience playback and returns the plate to its subject', async () => {
  const { player } = harness(); await player.togglePlay(); await player.finish();
  expect(player.getState()).toMatchObject({ active: false, menuOpen: false, autoplay: false, step: -1 });
});

it('matches the loaded assembly before choosing a stage of the same entry', async () => {
  const { player, navigate } = harness();
  player.setSubject({ pdbId: '5SYF', assembly: '1', modelNumber: 1 });
  await player.start();
  expect(navigate).toHaveBeenCalledExactlyOnceWith('tubulin-eb3-lattice', 5, true);
});
it('names the required and loaded assemblies without replacing the source', async () => {
  const { player, navigate, feedback } = harness();
  player.setCatalog([{ id: hemoglobin, title: 'Hemoglobin', sources: [{ pdbId: '4HHB', assemblyId: '1', stepIndex: 0 }] }]);
  await expect(player.start()).rejects.toThrow('Journey needs assembly 1; you have the asymmetric unit');
  expect(navigate).not.toHaveBeenCalled();
  expect(feedback).toHaveBeenCalledWith(expect.stringContaining('Use Tours to explicitly load its assembly'));
});
it('matches pinned models and refuses an unknown or different loaded model', async () => {
  const { player, navigate } = harness();
  player.setCatalog([{ id: hemoglobin, title: 'Hemoglobin', sources: [
    { pdbId: '4HHB', assemblyId: 'asymmetric_unit', modelNumber: 2, stepIndex: 1 },
    { pdbId: '4HHB', assemblyId: 'asymmetric_unit', modelNumber: 1, stepIndex: 0 },
  ] }]);
  await player.start(); expect(navigate).toHaveBeenLastCalledWith(hemoglobin, 0, true);
  for (const modelNumber of [3, undefined]) {
    player.setSubject({ pdbId: '4HHB', assembly: 'asymmetric_unit', modelNumber });
    await expect(player.start()).rejects.toThrow('Journey needs model 2');
  }
  expect(navigate).toHaveBeenCalledTimes(1);
});
it('early Done waits for a rendered restore receipt, and a failed restore keeps the journey', async () => {
  const { player, finish } = harness(); await player.togglePlay();
  let resolve!: (receipt: { status: 'rendered' }) => void;
  finish.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const done = player.finish();
  expect(player.getState()).toMatchObject({ active: true, autoplay: false, navigating: true });
  expect(player.getState().feedback).not.toBe('Back to your view');
  resolve({ status: 'rendered' }); await done;
  expect(player.getState()).toMatchObject({ active: false, feedback: 'Back to your view' });
  await player.start(); finish.mockRejectedValueOnce(Error('Restore could not render'));
  await expect(player.finish()).rejects.toThrow('Restore could not render');
  expect(player.getState()).toMatchObject({ active: true, feedbackError: true, navigating: false });
});


it('an open chooser retains its choice across hydration while the heartbeat names only the rendered journey', async () => {
  const { player } = harness();
  await player.start(); await player.openMenu(); await player.select('gfp-chromophore');
  const definition = MOLECULAR_EXPERIENCES.find(item => item.id === hemoglobin)!;
  player.update({ definition, revision: 1, stepIndex: 0, stageId: stageForStep(definition, 0).id, sourceKey: 'rendered' });
  expect(player.getState()).toMatchObject({ active: true, step: 0, selectedId: hemoglobin, menuOpen: true,
    selectedTitle: catalog.find(item => item.id === 'gfp-chromophore')!.title });
  await player.start();
  expect(player.getState()).toMatchObject({ active: true, step: 0, selectedId: 'gfp-chromophore', menuOpen: false });
});

// Pressing Menu with the
// chooser open closed it and the plate went straight back to the resting
// caption with no sentence about it, read at 20 fps across the whole transition
// and again 13 s later. The plate draws the sentence for a reading window off
// the stamp written here; `caption-card.test.mjs` holds the drawing half.
it('closing the chooser says so, with the stamp the caption window is measured from', async () => {
  const { player, feedback } = harness();
  await player.openMenu();
  expect(player.getState()).toMatchObject({ menuOpen: true, feedback: '' });
  const before = performance.now();
  player.closeMenu!();
  const state = player.getState();
  expect(state).toMatchObject({ menuOpen: false, active: false, feedback: 'Tour chooser closed', feedbackError: false });
  expect(state.chapterStartedAt).toBeGreaterThanOrEqual(before);
  // The sentence is the plate's, not the status line's: nothing is spoken and
  // nothing is reported as an error to the panel.
  expect(feedback).not.toHaveBeenCalledWith('Tour chooser closed');
});

it('closing the chooser over a running journey hands back its chapter untouched', async () => {
  const { player } = harness();
  await player.togglePlay();
  const running = player.getState();
  expect(running).toMatchObject({ active: true });
  await player.openMenu();
  player.closeMenu!();
  const state = player.getState();
  expect(state).toMatchObject({ menuOpen: false, active: true, title: running.title });
  // The chapter's own reading window is not restarted by a chooser press.
  expect(state.feedback).not.toBe('Tour chooser closed');
  expect(state.chapterStartedAt).toBe(running.chapterStartedAt);
});

it('autoplay holds a chapter for its spoken length spread over its plates, not 8 s a plate', async () => {
  vi.useFakeTimers();
  const { player, navigate } = harness(); await player.togglePlay();
  expect(navigate).toHaveBeenCalledTimes(1);
  // "4HHB shows alpha and beta subunits assembled around heme." is nine words: a 5.5 s chapter the plate splits in two, so each plate sits at the 3 s floor.
  expect(player.getState()).toMatchObject({ step: 0, bodyPageCount: 2, bodyPageIndex: 0 });
  await vi.advanceTimersByTimeAsync(3_100);
  expect(player.getState()).toMatchObject({ step: 0, bodyPageIndex: 1 });
  expect(navigate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3_100);
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(player.getState()).toMatchObject({ step: 1, autoplay: true });
});
it('a plate hold follows the chapter words, floors at 3 s and yields to data-tour-delay-ms', () => {
  expect(experiencePageDwellMs({ body: '4HHB shows alpha and beta subunits assembled around heme.' }, 2)).toBe(EXPERIENCE_PAGE_MIN_MS);
  expect(experiencePageDwellMs({ body: 'Heme explains the molecular setting for oxygen binding, not an oxygen occupancy measurement here.' }, 3)).toBe(EXPERIENCE_PAGE_MIN_MS);
  expect(experiencePageDwellMs({ body: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty' }, 1)).toBe(9_167);
  expect(experiencePageDwellMs(undefined, 1)).toBe(EXPERIENCE_PAGE_MIN_MS);
  const original = globalThis.document;
  globalThis.document = { body: { dataset: { tourDelayMs: '40' } } } as any;
  try { expect(experiencePageDwellMs({ body: 'Surface view reveals the tetrameric envelope.' }, 2)).toBe(40); }
  finally { globalThis.document = original; }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['start', 'rejoin'] as const)('%s keeps a pause made while its scene is rendering', async action => {
  vi.useFakeTimers();
  const { player, navigate, rendered, narrate } = harness();
  if (action === 'rejoin') await player.start(false);
  narrate.mockClear(); navigate.mockClear();
  const entered = deferred(), release = deferred();
  navigate.mockImplementationOnce(async (id, step) => { entered.resolve(); await release.promise; rendered(id, step); });
  const pending = action === 'start' ? player.start(true) : player.rejoin(true);
  await entered.promise;
  player.pause('Paused by you.');
  release.resolve(); await pending;
  expect(player.getState()).toMatchObject({ active: true, autoplay: false, feedback: 'Paused by you.', navigating: false });
  expect(narrate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(navigate).toHaveBeenCalledTimes(1);
});

it('a second Play during a paused in-flight scene cannot arm autoplay', async () => {
  vi.useFakeTimers();
  const { player, navigate, rendered } = harness(); await player.start(false);
  const entered = deferred(), release = deferred();
  navigate.mockImplementationOnce(async (id, step) => { entered.resolve(); await release.promise; rendered(id, step); });
  const pending = player.next(); await entered.promise;
  await expect(player.togglePlay()).rejects.toThrow('finish loading');
  expect(player.getState().autoplay).toBe(false);
  release.resolve(); await pending;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(navigate).toHaveBeenCalledTimes(2);
});

it.each(['navigation', 'finish'] as const)('a late %s completion after disposal has no speech, feedback or UI notifications', async action => {
  const { player, navigate, rendered, narrate, finish, feedback } = harness();
  if (action === 'finish') await player.start(false);
  const entered = deferred(), release = deferred(), listener = vi.fn();
  player.subscribe(listener); narrate.mockClear(); feedback.mockClear();
  if (action === 'navigation') navigate.mockImplementationOnce(async (id, step) => { entered.resolve(); await release.promise; rendered(id, step); });
  else finish.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { status: 'rendered' }; });
  const pending = action === 'navigation' ? player.start(true) : player.finish();
  const rejected = expect(pending).rejects.toThrow('disposed');
  await entered.promise; player.dispose(); listener.mockClear();
  release.resolve(); await rejected;
  expect(narrate).not.toHaveBeenCalled(); expect(feedback).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  expect(player.getState().autoplay).toBe(false);
});

it('holds autoplay during a redraw and resumes its dwell without declaring the journey complete', async () => {
  vi.useFakeTimers();
  const { player, navigate } = harness(); await player.togglePlay();
  player.setRendering(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(player.getState()).toMatchObject({ active: true, autoplay: true, navigating: true, step: 0 });
  expect(player.getState().feedback).not.toContain('Journey complete');
  expect(navigate).toHaveBeenCalledTimes(1);
  player.setRendering(false);
  await vi.advanceTimersByTimeAsync(6_100);
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(player.getState()).toMatchObject({ step: 1, autoplay: true });
});

it('a late narration failure from a paused visit does not replace its feedback', async () => {
  const { player, narrate, feedback } = harness();
  let reject!: (error: Error) => void;
  narrate.mockImplementationOnce(() => new Promise((_done, failed) => { reject = failed; }));
  await player.start(true); player.pause('Paused by you.');
  reject(Error('Old chapter audio failed.')); await Promise.resolve();
  expect(feedback).not.toHaveBeenCalled();
  expect(player.getState()).toMatchObject({ autoplay: false, feedback: 'Paused by you.' });
  expect(player.narratingLine()).toBeUndefined();
});


it('hiding the page during Start preserves its pause through the render and later visibility', async () => {
  vi.useFakeTimers();
  const { player, navigate, rendered, narrate, visibility } = harness();
  const entered = deferred(), release = deferred();
  navigate.mockImplementationOnce(async (id, step) => { entered.resolve(); await release.promise; rendered(id, step); });
  const pending = player.togglePlay(); await entered.promise;
  visibility(true); release.resolve(); await pending; visibility(false);
  expect(player.getState()).toMatchObject({ active: true, autoplay: false, feedback: 'Paused while this view is hidden.' });
  expect(narrate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000); expect(navigate).toHaveBeenCalledTimes(1);
  await player.togglePlay(); await vi.advanceTimersByTimeAsync(6_100);
  expect(navigate).toHaveBeenCalledTimes(2); expect(player.getState().autoplay).toBe(true);
});


for (const action of ['start', 'next', 'rejoin'] as const) {
  it.each(['interaction', 'hydration'] as const)(`${action}: %s during pending navigation preserves its playback intent`, async provenance => {
    vi.useFakeTimers();
    const { player, navigate, rendered, narrate } = harness();
    if (action !== 'start') await player.start(true);
    narrate.mockClear(); navigate.mockClear();
    const entered = deferred(), release = deferred();
    navigate.mockImplementationOnce(async (id, step) => { entered.resolve(); await release.promise; rendered(id, step); });
    const pending = action === 'start' ? player.start(true) : action === 'next' ? player.next() : player.rejoin(true);
    await entered.promise;
    if (provenance === 'interaction') player.notifyInteraction();
    else { player.setRendering(true); player.notifyMutation(); player.setRendering(false); }
    release.resolve(); await pending;
    expect(player.getState()).toMatchObject({ active: true, autoplay: provenance === 'hydration', navigating: false });
    expect(narrate).toHaveBeenCalledTimes(provenance === 'hydration' ? 1 : 0);
    if (provenance === 'interaction') {
      expect(player.getState().feedback).toBe('Paused for exploration. Next continues your journey.');
      await vi.advanceTimersByTimeAsync(60_000); expect(navigate).toHaveBeenCalledTimes(1);
    } else {
      await vi.advanceTimersByTimeAsync(20_000); expect(navigate.mock.calls.length).toBeGreaterThan(1);
    }
  });
}


it('genuine interaction while Start settles an earlier command cancels the unopened journey', async () => {
  const release = deferred();
  const { player, navigate, narrate } = harness({ settle: () => release.promise });
  const pending = player.start(true), rejected = expect(pending).rejects.toThrow('interrupted');
  player.notifyInteraction(); release.resolve(); await rejected;
  expect(player.getState()).toMatchObject({ active: false, autoplay: false, navigating: false });
  expect(navigate).not.toHaveBeenCalled(); expect(narrate).not.toHaveBeenCalled();
});

it('overlapping Starts cannot change the admitted visit after settling the same command', async () => {
  const settled = deferred(), entered = deferred(), release = deferred();
  const { player, navigate, rendered, narrate } = harness({ settle: () => settled.promise });
  navigate.mockImplementationOnce(async (id, step) => { entered.resolve(); await release.promise; rendered(id, step); });
  const first = player.start(false, undefined, { narration: false });
  const second = player.start(true), refused = expect(second).rejects.toThrow('finish loading');
  settled.resolve(); await entered.promise; await refused;
  expect(player.getState()).toMatchObject({ autoplay: false, narration: false, navigating: true });
  release.resolve(); await first;
  expect(navigate).toHaveBeenCalledTimes(1); expect(narrate).not.toHaveBeenCalled();
  expect(player.getState()).toMatchObject({ active: true, autoplay: false, narration: false });
});

it('disposing Start while it settles a command prevents navigation and narration', async () => {
  const release = deferred();
  const { player, navigate, narrate, feedback } = harness({ settle: () => release.promise });
  const pending = player.start(true), rejected = expect(pending).rejects.toThrow('disposed');
  player.dispose(); release.resolve(); await rejected;
  expect(navigate).not.toHaveBeenCalled(); expect(narrate).not.toHaveBeenCalled(); expect(feedback).not.toHaveBeenCalled();
  expect(player.getState().autoplay).toBe(false);
});
