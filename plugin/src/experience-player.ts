import { tourStepDwellMs, wearerPages, type TourPlayerState, type TourStep } from './tour-player.js';
import type { MolecularExperience } from './molecular-experience.js';

export type ExperienceSummary = { id: string; title: string; summary?: string; steps?: number;
  deviceBudget?: {notice:string};
  sources?: { pdbId: string; assemblyId: string; modelNumber?: number; stepIndex: number }[] };
export type ExperienceView = { definition: MolecularExperience; revision: number; stepIndex: number; stageId: string; sourceKey: string };

/** The least one readout plate is held: three short lines at reading speed, the tour player's own page floor. */
export const EXPERIENCE_PAGE_MIN_MS = 3_000;
/**
 * How long autoplay holds one readout plate of a chapter.
 *
 * The chapter's spoken line sets the whole (`tourStepDwellMs`: words at three a
 * second plus 2.5 s), split across the plates the headset readout needs for it;
 * no plate goes under the floor. Until recently every plate held a flat 8 s,
 * so a ten-word chapter the plate splits in two cost 16 s and the twenty-chapter
 * hemoglobin lesson ran seven minutes on a desk. `data-tour-delay-ms` on
 * `body` overrides the hold, as it does for the tour player.
 */
export function experiencePageDwellMs(step: { title?: string; body?: string } | undefined, pageCount: number): number {
  const override = Number((globalThis as { document?: { body?: { dataset?: { tourDelayMs?: string } } } }).document?.body?.dataset?.tourDelayMs);
  if (Number.isFinite(override) && override >= 10) return override;
  const chapter = tourStepDwellMs(step as TourStep | undefined);
  return Math.max(EXPERIENCE_PAGE_MIN_MS, Math.ceil(chapter / Math.max(1, pageCount)));
}

/** Chapter previews precede geometry; counters and narration require a rendered scene. */
export function mountExperiencePlayer(options: {
  after: Element;
  /** Finish a previously claimed chooser command before reading its selection. */
  settle?: () => Promise<void>;
  navigate: (id: string, step: number, loadedSourceOnly?: boolean) => Promise<void>;
  finish: () => Promise<{ status: 'rendered'; message?: string }>;
  onFeedback?: (message: string) => void;
  narrate?: (message: string) => Promise<void> | void;
  explore: () => void;
  place?: (target: 'overhead' | 'front') => Promise<void>;
}) {
  const root = document.createElement('section');
  root.className = 'experience-player'; root.dataset.experiencePlayer = '';
  root.setAttribute('aria-label', 'Molecular experiences');
  root.innerHTML = `<div class="experience-kicker">DISCOVER IN DEPTH <button data-experience-library>Tours</button></div>
    <div class="experience-library"><label>Choose your journey<select aria-label="Molecular experiences" data-experience-menu></select></label><p data-experience-summary></p><button class="experience-primary" data-experience-start>Start exploring</button></div>
    <div class="experience-readout" hidden><span data-experience-progress></span><h3 data-experience-title></h3><p data-experience-body></p><a data-experience-source target="_blank" rel="noopener noreferrer">About this structure ↗</a>
      <div class="experience-transport"><button data-experience-back aria-label="Previous scene">← Back</button><button data-experience-play>Play</button><button data-experience-next aria-label="Next scene">Next →</button></div>
      <div class="experience-secondary"><button data-experience-explore>Explore freely</button></div>
      <div class="experience-room"><button data-experience-front>Within reach</button><button data-experience-overhead>Above us</button></div>
    </div><p class="experience-status" data-experience-status role="status"></p>`;
  options.after.after(root);
  for (const control of root.querySelectorAll<HTMLElement>('button, select')) control.dataset.workspace = '';
  const $ = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-experience-${name}]`)!;
  const menu = $<HTMLSelectElement>('menu');
  let catalog: ExperienceSummary[] = [], current: ExperienceView | undefined, chosen = '', menuOpen = false;
  let subject: { pdbId?: string; sourceSha256?: string; assembly?: string; modelNumber?: number } = {}, feedbackError = false;
  let pending = false, rendering = false, playing = false, page = 0, feedback = '', disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chapterStartedAt: number | undefined, narration: string | undefined;
  let narrationEnabled = true, playbackIntent = 0, interactionIntent = 0;
  const ensureLive = () => { if (disposed) throw Error('The experience player was disposed.'); };
  let chapterPreview: TourPlayerState['chapterPreview'];
  const listeners = new Set<() => void>();
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const getState = (): TourPlayerState & {budgetNotice?:string} => {
    const step = current?.definition.steps[current.stepIndex], pages = wearerPages(step);
    const index = Math.min(page, pages.length - 1), busy = pending || rendering;
    return { tours: catalog.map(item => ({ id: item.id, title: item.title, steps: item.steps ?? 20 })),
      selectedId: current?.definition.id ?? (menuOpen ? chosen : undefined),
      selectedTitle: menuOpen ? catalog.find(item => item.id === chosen)?.title : current?.definition.title,
      budgetNotice: menuOpen ? catalog.find(item => item.id === chosen)?.deviceBudget?.notice : undefined,
      title: step?.title ?? '', feedback, feedbackError, chapterStartedAt, chapterPreview,
      body: step?.body ?? '', bodyPage: pages[index], bodyPageIndex: index, bodyPageCount: pages.length,
      progress: current ? `Scene ${current.stepIndex + 1} / ${current.definition.steps.length}` : '',
      step: current?.stepIndex ?? -1, total: current?.definition.steps.length ?? 0,
      active: !!current, stopped: false, autoplay: playing, narration: narrationEnabled, menuOpen, navigating: busy,
      canBack: !!current && current.stepIndex > 0 && !busy,
      canNext: !!current && current.stepIndex < current.definition.steps.length - 1 && !busy,
      canPlay: !busy && (!!chosen || !!current),
    };
  };
  const sync = () => {
    if (disposed) return;
    const state = getState(), summary = catalog.find(item => item.id === chosen);
    root.querySelector<HTMLElement>('.experience-library')!.hidden = !menuOpen;
    root.querySelector<HTMLElement>('.experience-readout')!.hidden = !current || menuOpen;
    $('summary').textContent = [summary?.summary ?? 'Molecules, assemblies and the experiments that revealed them.', summary?.deviceBudget?.notice].filter(Boolean).join(' ');
    $('progress').textContent = state.progress; $('title').textContent = state.title; $('body').textContent = state.body;
    const stage = current?.definition.stages.find(item => item.id === current!.stageId);
    const source = $<HTMLAnchorElement>('source'); source.hidden = !stage;
    if (stage) { source.href = stage.source.citationUrl; source.textContent = `${stage.source.pdbId} · Experimental source ↗`; }
    $<HTMLButtonElement>('start').disabled = !chosen || state.navigating;
    $<HTMLButtonElement>('back').disabled = !state.canBack;
    $<HTMLButtonElement>('next').disabled = !state.canNext;
    $<HTMLButtonElement>('play').disabled = !state.canPlay;
    $('play').textContent = playing ? 'Pause' : 'Play';
    $('status').textContent = feedback;
    for (const listener of listeners) listener();
  };
  const pause = (reason = 'Paused. Take your time.', error = false) => { playbackIntent++; playing = false; narration = undefined; clear(); feedback = reason; feedbackError = error; sync(); };
  const schedule = () => {
    clear(); if (!playing || !current || pending || rendering || disposed || document.hidden) return;
    const holdMs = experiencePageDwellMs(current.definition.steps[current.stepIndex], getState().bodyPageCount);
    timer = setTimeout(() => {
      if (disposed || !playing || !current) return;
      if (document.hidden) { pause('Paused while this view is hidden.'); return; }
      const state = getState();
      if (state.bodyPageIndex + 1 < state.bodyPageCount) { page++; chapterStartedAt = globalThis.performance?.now?.() ?? Date.now(); sync(); schedule(); }
      else if (state.canNext) void visit(current!.definition.id, current!.stepIndex + 1).catch(report);
      else pause('Journey complete. Explore the structure or choose another tour.');
    }, holdMs);
  };
  const report = (error: unknown) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : 'The scene could not be opened.';
    const repeat = feedbackError && feedback === message;
    pause(message, true);
    if (!repeat) options.onFeedback?.(message);
  };
  const visit = async (id: string, step: number, loadedSourceOnly = false) => {
    ensureLive();
    if (pending || rendering) throw Error('Wait for the current scene to finish loading.');
    const intent = playbackIntent;
    clear(); pending = true; feedbackError = false; feedback = 'Preparing your next view…'; sync();
    try {
      await options.navigate(id, step, loadedSourceOnly);
      ensureLive();
      if (!current || current.definition.id !== id || current.stepIndex !== step) throw Error('The requested scene has not been confirmed.');
      page = 0; menuOpen = false;
      // A pause during rendering keeps its feedback and withdraws the spoken
      // line, while the confirmed scene still updates the chapter counter.
      if (intent !== playbackIntent || document.hidden) return;
      feedback = 'Scene ready. Look around.';
      chapterStartedAt = globalThis.performance?.now?.() ?? Date.now();
      narration = current.definition.steps[current.stepIndex]!.body;
      if (narrationEnabled) void Promise.resolve(options.narrate?.(narration)).catch(error => {
        if (!disposed && intent === playbackIntent) options.onFeedback?.(error instanceof Error ? error.message : 'Chapter audio is unavailable.');
      });
    } catch (error) { report(error); throw error; }
    finally { chapterPreview = undefined; pending = false; sync(); schedule(); }
  };
  const openMenu = async () => { pause(); feedback = ''; feedbackError = false; menuOpen = true; chosen ||= current?.definition.id ?? catalog[0]?.id ?? ''; sync(); };
  // The chooser says so when it shuts. On the Quest 2
  // pressing Menu closed it and the plate went straight back to the resting
  // caption with no sentence about it. The stamp is the window `spatial-toolbar.mjs` draws the sentence for,
  // and it is `performance.now()` because that is the clock the plate reads.
  // Closing over a running journey leaves its chapter caption alone: the plate
  // has its own rule for that, and handing the chapter back is the answer.
  const closeMenu = () => {
    menuOpen = false;
    if (!current) {
      feedbackError = false; feedback = 'Tour chooser closed';
      chapterStartedAt = globalThis.performance?.now?.() ?? Date.now();
    }
    sync();
  };
  const start = async (autoStart = false, startAt?: number | 'last', startOptions?: { narration?: boolean }) => {
    ensureLive();
    if (pending || rendering) throw Error('Wait for the current scene to finish loading.');
    // A claimed chooser command may pause while settle completes. Finish it
    // before issuing Start; a genuine input during that wait still cancels us.
    const interaction = interactionIntent;
    if (options.settle) await options.settle();
    ensureLive();
    if (interaction !== interactionIntent) throw Error('The experience start was interrupted.');
    if (pending || rendering) throw Error('Wait for the current scene to finish loading.');
    playbackIntent++; narrationEnabled = startOptions?.narration !== false; playing = autoStart;
    if (menuOpen) {
      if (!chosen) throw Error('No experiences are available.');
      const index = startAt === 'last' ? (catalog.find(item => item.id === chosen)?.steps ?? 1) - 1 : startAt ?? 0;
      await visit(chosen, index); return;
    }
    const candidates = catalog.flatMap(item => (item.sources ?? []).map(source => ({ id: item.id, ...source })))
      .filter(source => source.pdbId.toUpperCase() === subject.pdbId?.toUpperCase());
    const assemblies = candidates.filter(source => source.assemblyId === subject.assembly);
    const match = assemblies.find(source => source.modelNumber === undefined || source.modelNumber === subject.modelNumber);
    if (!match) {
      const assemblyName = (id?: string) => id === 'asymmetric_unit' ? 'the asymmetric unit' : id ? `assembly ${id}` : 'an unknown assembly';
      const error = Error(assemblies.length
        ? `Journey needs model ${assemblies[0].modelNumber}; you have ${subject.modelNumber === undefined ? 'an unknown model' : `model ${subject.modelNumber}`}. Use Tours to explicitly load its model.`
        : candidates.length ? `Journey needs ${assemblyName(candidates[0].assemblyId)}; you have ${assemblyName(subject.assembly)}. Use Tours to explicitly load its assembly.`
        : `No journey for ${subject.pdbId || 'this structure'} yet`);
      report(error); throw error;
    }
    await visit(match.id, match.stepIndex, true);
  };
  const next = async () => { const state = getState(); if (!state.canNext || !current) throw Error('There is no next scene.'); await visit(current.definition.id, current.stepIndex + 1); };
  const back = async () => { const state = getState(); if (!state.canBack || !current) throw Error('There is no previous scene.'); await visit(current.definition.id, current.stepIndex - 1); };
  const togglePlay = async () => {
    ensureLive();
    if (playing) { pause(); return; }
    if (pending || rendering) throw Error('Wait for the current scene to finish loading.');
    if (!current || menuOpen) { await start(true, undefined, { narration: narrationEnabled }); return; }
    playbackIntent++; playing = true; feedbackError = false; feedback = 'Playing. Pause whenever you want to explore.'; sync(); schedule();
  };
  menu.addEventListener('change', () => { chosen = menu.value; sync(); });
  for (const [name, action] of Object.entries({ start, next, back, play: togglePlay, library: openMenu,
    explore: async () => { pause('Paused for exploration. Next continues your journey.'); options.explore(); },
    overhead: async () => { pause(); if (!options.place) throw Error('Room placement is unavailable.'); await options.place('overhead'); feedback = 'Placed above you for this VR session.'; sync(); },
    front: async () => { pause(); if (!options.place) throw Error('Room placement is unavailable.'); await options.place('front'); feedback = 'Placed in front of you.'; sync(); },
  })) $(name).addEventListener('click', () => { void action().catch(report); });
  const visibility = () => { if (document.hidden && playing) pause('Paused while this view is hidden.'); };
  document.addEventListener('visibilitychange', visibility);
  sync();
  return Object.freeze({ getState, start, next, back, pause, togglePlay, openMenu, closeMenu,
    async finish(_reason?: 'completed' | 'done') {
      ensureLive();
      if (pending || rendering) throw Error('Wait for the current scene to finish loading.');
      if (!current) return;
      playing = false; clear(); pending = true; feedbackError = false; feedback = 'Restoring your view…'; sync();
      try {
        const receipt = await options.finish();
        ensureLive();
        if (receipt?.status !== 'rendered') throw Error('Your restored view has not been confirmed.');
        current = undefined; menuOpen = false; narration = undefined; page = 0; feedback = receipt.message ?? 'Back to your view';
        chapterStartedAt = receipt.message ? globalThis.performance?.now?.() ?? Date.now() : undefined;
        options.onFeedback?.(feedback);
      } catch (error) { report(error); throw error; }
      finally { pending = false; sync(); }
    },
    preview(value: ExperienceView | undefined) {
      const step = value?.definition.steps[value.stepIndex];
      chapterPreview = value && step ? { title: step.title, progress: `Scene ${value.stepIndex + 1} / ${value.definition.steps.length}`,
        bodyPage: wearerPages(step)[0] } : undefined;
      sync();
    },
    setSubject(value: typeof subject) {
      if (!pending && (subject.sourceSha256 !== value.sourceSha256 || subject.assembly !== value.assembly || subject.modelNumber !== value.modelNumber)) {
        current = undefined; playing = false; clear(); narration = undefined; chapterStartedAt = undefined; page = 0; feedback = ''; feedbackError = false;
      }
      subject = value; sync();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async select(id: string) { if (!catalog.some(item => item.id === id)) throw Error('Unknown experience.'); chosen = id; menu.value = id; menuOpen = true; sync(); },
    async cycleTour(delta = 1) { const index = catalog.findIndex(item => item.id === chosen); chosen = catalog[(index + delta + catalog.length) % catalog.length]?.id ?? ''; menu.value = chosen; sync(); },
    async nextReadoutPage() { const state = getState(); page = (page + 1) % state.bodyPageCount; chapterStartedAt = globalThis.performance?.now?.() ?? Date.now(); sync(); },
    async rejoin(autoStart = false) {
      ensureLive();
      if (pending || rendering) throw Error('Wait for the current scene to finish loading.');
      if (current) { playbackIntent++; playing = autoStart; await visit(current.definition.id, current.stepIndex); }
    },
    async restoreStart() { if (current) await visit(current.definition.id, 0); },
    notifyInteraction() {
      interactionIntent++;
      pause('Paused for exploration. Next continues your journey.');
    },
    // Hydration emits mutations too. Its own writes must not interrupt the
    // chapter; genuine input uses notifyInteraction even while loading.
    notifyMutation() { if (current && !pending && !rendering) pause('Paused for exploration. Next continues your journey.'); },
    setRendering(value: boolean) { rendering = value; sync(); schedule(); },
    narratingLine: () => narration,
    setCatalog(items: ExperienceSummary[]) { catalog = items; menu.replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; return option; })); chosen ||= items[0]?.id ?? ''; menu.value = chosen; sync(); },
    update(value: ExperienceView | undefined, message?: string) {
      if (disposed) return;
      if (!pending && current && value && (value.definition.id !== current.definition.id || value.revision !== current.revision)) pause('Following the shared experience.');
      const changed = current?.definition.id !== value?.definition.id || current?.revision !== value?.revision;
      current = value; chapterPreview = undefined;
      if (changed) page = 0;
      if (value && (pending || !menuOpen)) { chosen = value.definition.id; menuOpen = false; }
      if (!value) { playing = false; clear(); narration = undefined; chapterStartedAt = undefined; }
      if (message) { menuOpen = false; feedback = message; feedbackError = false; chapterStartedAt = globalThis.performance?.now?.() ?? Date.now(); }
      sync();
    },
    async goToStage(stageId: string, experienceId = current?.definition.id ?? 'tubulin-eb3-lattice') {
      const opening = !current || current.definition.id !== experienceId;
      if (opening) await visit(experienceId, 0);
      const index = current!.definition.steps.findIndex(step => step.stageId === stageId);
      if (index < 0) throw Error('That assembly stage is unavailable.');
      // Opening already rendered and narrated scene zero. A request for that
      // stage must not hydrate and speak the same scene a second time.
      if (opening && index === 0) return;
      await visit(experienceId, index);
    },
    dispose() { playbackIntent++; disposed = true; playing = false; narration = undefined; clear(); document.removeEventListener('visibilitychange', visibility); listeners.clear(); root.remove(); },
  });
}
export type ExperiencePlayer = ReturnType<typeof mountExperiencePlayer>;
