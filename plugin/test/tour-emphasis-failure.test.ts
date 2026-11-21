import { describe, expect, it, vi } from 'vitest';
import { executeInspectionVoiceAction } from '../src/inspection-voice-actions.js';
import { EMPHASIS_FAILURE_LINE, EMPHASIS_RETRY_FAILURE_LINE, EMPHASIS_RETRY_SUCCESS_LINE,
  mountTourPlayer, type Tour, type TourPlayer, type TourStep, type Workspace } from '../src/tour-player.js';

// A chapter whose highlight fails tells the wearer and offers
// a retry, instead of narrating a highlight that never appeared.
const words = (line: string) => line.trim().split(/\s+/u).filter(Boolean).length;
/** Let the aside's microtask chain run; the line waits for the chapter's turn. */
const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

const guideStep: TourStep = { id: 'guide', title: 'Guide',
  narration: 'Guide RNA leads the way home.',
  emphasis: { parts: [{ id: 'guide', label: 'Guide RNA', color: '#ff8a1f', chain: 'B' }], focus: 'guide' } };
const recapStep: TourStep = { id: 'recap', title: 'Recap',
  narration: 'The complex rests in plain view.',
  emphasis: { parts: [] } };
const tours: readonly Tour[] = [{ id: 'lesson', title: 'Lesson', summary: 'Two chapters.', steps: [guideStep, recapStep] }];

const setupMockDom = () => {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const elements: Record<string, unknown> = {};
  const makeElement = (tag = 'div') => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      dataset: {} as Record<string, string>,
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      disabled: false,
      children: [] as unknown[],
      attributes: {} as Record<string, string>,
      setAttribute: (k: string, v: string) => { (el.attributes as Record<string, string>)[k] = v; },
      append: (...nodes: unknown[]) => { (el.children as unknown[]).push(...nodes); },
      replaceChildren: (...nodes: unknown[]) => { el.children = [...nodes]; },
      after: vi.fn(),
      addEventListener: (evt: string, cb: (...args: unknown[]) => void) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(cb);
      },
      querySelector: (sel: string) => elements[sel] ?? makeElement(),
      querySelectorAll: (sel: string) => [elements[sel]].filter(Boolean),
    };
    return el;
  };
  for (const s of ['[data-tour-menu]', '[data-tour-summary]', '[data-tour-progress]',
    '[data-tour-title]', '[data-tour-body]', '[data-tour-sources]',
    '[data-tour-status]', '[data-tour-start]', '[data-tour-rejoin]',
    '[data-tour-back]', '[data-tour-next]', '[data-tour-play]',
    '[data-tour-pace]', '[data-tour-restart]', '[data-tour-restore]',
    '[data-tour-menu-button]']) {
    elements[s] = makeElement();
  }
  const root = makeElement('section');
  root.querySelector = ((sel: string) => elements[sel] ?? makeElement()) as any;
  const originalDoc = (globalThis as any).document;
  const originalWin = (globalThis as any).window;
  (globalThis as any).document = {
    body: { dataset: {} },
    createElement: (tag: string) => (tag === 'section' ? root : makeElement(tag)),
    hidden: false,
    addEventListener: (evt: string, cb: (...args: unknown[]) => void) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
    },
    removeEventListener: vi.fn(),
  };
  (globalThis as any).window = {
    addEventListener: (evt: string, cb: (...args: unknown[]) => void) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
    },
    removeEventListener: vi.fn(),
  };
  return {
    mountAnchor: makeElement('div') as unknown as Element,
    restore: () => {
      (globalThis as any).document = originalDoc;
      (globalThis as any).window = originalWin;
    },
  };
};

const setup = (emphasize: (value: unknown) => Promise<unknown>, tourList: readonly Tour[] = tours) => {
  const dom = setupMockDom();
  // Two channels, because the page has two. `narrate` is the lesson's own
  // voice, gated by `speakNarration`; `aside` is the page's ordinary
  // acknowledgement slot, which that gate does not govern. `spoken` keeps the
  // order the player asked in, across both.
  const narrated: string[] = [];
  const asides: string[] = [];
  const spoken: string[] = [];
  const calls: string[] = [];
  const note = (kind: string) => async (...args: unknown[]) => { calls.push(kind); return undefined; };
  const workspace = {
    snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: false, selectionKeys: [] as string[] }),
    rows: () => [],
    capture: () => ({}),
    runTour: async (action: () => Promise<void>) => action(),
    setStatus: () => undefined,
    viewer: {
      select: note('select'),
      focus: note('focus'),
      inspection: {
        configure: note('configure'), place: note('place'), fit: note('fit'),
        resetOrientation: note('reset'), orbit: note('orbit'), dolly: note('dolly'),
        setMotion: note('motion'), restore: note('restore'), emphasize,
      },
    },
  } as unknown as Workspace;
  const player = mountTourPlayer({ workspace, tours: tourList, after: dom.mountAnchor,
    narrate: (line: string) => { narrated.push(line); spoken.push(line); },
    aside: (line: string) => { asides.push(line); spoken.push(line); } });
  return { dom, narrated, asides, spoken, calls, workspace, player };
};

const failingEmphasis = () => {
  let attempts = 0;
  const emphasize = async () => { attempts++; throw Error("Could not find node 'yEw1bmA1hVpstsCEqyENWg'."); };
  return { emphasize, attempts: () => attempts };
};

describe('a chapter whose highlight fails', () => {
  it('keeps a narration-off visit silent through navigation and Play, then restores the fresh-start default', async () => {
    const f = failingEmphasis();
    const { dom, narrated, asides, player, workspace } = setup(f.emphasize);
    workspace.viewer.inspection.clearLessonEmphasis = async () => undefined;
    try {
      await player.select('lesson');
      await player.start(false, undefined, { narration: false });
      await player.next(); await player.back();
      await player.togglePlay(); player.pause();
      await player.rejoin();
      await player.restoreStart(); await player.togglePlay(); player.pause();
      await settle();
      expect(player.getState()).toMatchObject({ active: true, narration: false });
      expect(narrated).toEqual([]); expect(asides).toEqual([]);
      expect(f.attempts()).toBeGreaterThan(1);
      await player.start(false); await settle();
      expect(player.getState().narration).toBe(true);
      expect(narrated).toEqual([guideStep.narration]);
      expect(asides).toEqual([EMPHASIS_FAILURE_LINE]);
    } finally { player.pause(); dom.restore(); }
  });

  it('speaks one short line and keeps the chapter moving', async () => {
    const f = failingEmphasis();
    const { dom, narrated, asides, spoken, player } = setup(f.emphasize);
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      // The chapter is on screen even though its key never painted.
      expect(player.getState().step).toBe(0);
      // The chapter keeps the lesson's own voice; the failure line is an aside.
      expect(narrated).toEqual([guideStep.narration]);
      expect(asides).toEqual([EMPHASIS_FAILURE_LINE]);
      expect(spoken).toEqual([guideStep.narration, EMPHASIS_FAILURE_LINE]);
      expect(words(EMPHASIS_FAILURE_LINE)).toBeLessThan(12);
    } finally { dom.restore(); }
  });

  it('speaks the failure line once per chapter across both paint sites', async () => {
    const f = failingEmphasis();
    const { dom, asides, player } = setup(f.emphasize);
    try {
      await player.select('lesson');
      await player.start(false);
      await player.next();
      await settle();
      // One line for each failed chapter, via the linear walk.
      expect(asides.filter(line => line === EMPHASIS_FAILURE_LINE)).toHaveLength(2);
      // Back restores the cached scene and repaints the same key through the
      // second paint site — the wearer is not told twice for one chapter.
      await player.back();
      await settle();
      expect(player.getState().step).toBe(0);
      expect(asides.filter(line => line === EMPHASIS_FAILURE_LINE)).toHaveLength(2);
    } finally { dom.restore(); }
  });

  it('retries the current chapter emphasis, and reports a second failure once', async () => {
    const f = failingEmphasis();
    const { dom, asides, workspace, player } = setup(f.emphasize);
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      expect(f.attempts()).toBe(1);
      // The retry re-applies the same chapter's emphasis exactly once.
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      expect(f.attempts()).toBe(2);
      expect(words(EMPHASIS_RETRY_FAILURE_LINE)).toBeLessThan(12);
      // Reported, not re-narrated: the failure line still appears once.
      await settle();
      expect(asides.filter(line => line === EMPHASIS_FAILURE_LINE)).toHaveLength(1);
      expect(player.getState().step).toBe(0);
      // The voice action answers with the same line and keeps the save going.
      const save = vi.fn(async () => {});
      const hooks = { tour: () => player, experience: () => undefined,
        workspace: () => workspace, save, navigate: vi.fn(async () => {}) };
      await expect(executeInspectionVoiceAction('retry', hooks)).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      expect(f.attempts()).toBe(3);
      expect(save).toHaveBeenCalledOnce();
    } finally { dom.restore(); }
  });

  /** One chapter that frames chain A and hides chain B: a close-up when presenting. */
  const closeUpLesson = (xrPresenting = true, after: TourStep[] = []) => {
    const site = { id: 'site', title: 'Site', narration: 'The site.', figure: { layers: [], labels: [], focus: [{ chain: 'A' }] },
      visibility: { op: 'only', chains: ['A'] } } as unknown as TourStep;
    let failEmphasis = false;
    const lesson = setup(async () => {
      lesson.calls.push(failEmphasis ? 'emphasis-failed' : 'emphasis');
      if (failEmphasis) throw Error("Could not find node 'yEw1bmA1hVpstsCEqyENWg'.");
    }, [{ id: 'lesson', title: 'Lesson', summary: 'One close-up.', steps: [site, ...after] }]);
    const ws = lesson.workspace as any;
    ws.snapshot = () => ({ ready: true, sourceSha256: 'a', xrPresenting, selectionKeys: [] as string[] });
    ws.rows = () => ['A', 'B'].map(chain => ({ key: chain, entityType: 'polymer',
      identity: { labelChain: chain, authorChain: chain, copyId: '1', modelNumber: 1 } }));
    Object.assign(ws.viewer.inspection, {
      visibility: () => ({ hiddenChains: [], hiddenClasses: [], showOnlySelection: false }),
      setVisibility: async () => { lesson.calls.push('visibility'); },
      setLessonFigure: async (value: unknown) => { if (value) lesson.calls.push('figure'); },
    });
    return { ...lesson, inspection: ws.viewer.inspection as Record<string, unknown>,
      failEmphasis: (value: boolean) => { failEmphasis = value; } };
  };
  const plainStep = { id: 'plain', title: 'Plain', narration: 'Plain.', emphasis: { parts: [] } } as TourStep;
  const busy = () => Object.assign(Error('The viewer is busy.'), { code: 'viewer_busy' });

  it('stops a headset close-up retry that Pause interrupts during its early visibility', async () => {
    let pauseOnVisibility = false;
    const { dom, player, calls, inspection } = closeUpLesson();
    inspection.setVisibility = async () => { calls.push('visibility'); if (pauseOnVisibility) { pauseOnVisibility = false; player.pause(); calls.push('pause'); } };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      expect(calls).toContain('figure');
      calls.length = 0;
      pauseOnVisibility = true;
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      expect(calls).toEqual(['visibility', 'pause']);
    } finally { dom.restore(); }
  });

  it('stops a headset close-up retry that Pause interrupts while its figure waits out a busy viewer', async () => {
    let busyOnce = false;
    const { dom, player, calls, inspection } = closeUpLesson();
    inspection.setLessonFigure = async (value: unknown) => {
      if (busyOnce) {
        busyOnce = false; calls.push('busy');
        setTimeout(() => { player.pause(); calls.push('pause'); }, 10);
        throw busy();
      }
      if (value) calls.push('figure');
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      expect(calls).toContain('figure');
      calls.length = 0;
      busyOnce = true;
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      // No second figure attempt, no emphasis and no closing visibility after Pause.
      expect(calls).toEqual(['visibility', 'busy', 'pause']);
    } finally { dom.restore(); }
  });

  it('lets a newer headset close-up retry stand in for an older one', async () => {
    let holdNext = false, release: (() => void) | undefined;
    const { dom, player, calls, inspection } = closeUpLesson();
    inspection.setVisibility = async () => {
      calls.push('visibility');
      if (holdNext) { holdNext = false; await new Promise<void>(resolve => { release = resolve; }); }
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      holdNext = true;
      const older = player.retryEmphasis();
      await settle();
      expect(calls).toEqual(['visibility']);
      const newer = player.retryEmphasis();
      release!();
      // One install and one highlight; the older retry answers with the newer's line.
      await expect(Promise.all([older, newer])).resolves.toEqual([EMPHASIS_RETRY_SUCCESS_LINE, EMPHASIS_RETRY_SUCCESS_LINE]);
      expect(calls.filter(call => call === 'figure')).toHaveLength(1);
      expect(calls.filter(call => call === 'emphasis')).toHaveLength(1);
      expect(player.getState().step).toBe(0);
    } finally { dom.restore(); }
  });

  it('answers a close-up retry whose closing visibility Pause interrupts with the failure line', async () => {
    let busyOnce = false;
    const { dom, player, calls, inspection } = closeUpLesson();
    inspection.setVisibility = async () => {
      if (busyOnce && calls.includes('emphasis')) {
        busyOnce = false; calls.push('busy');
        setTimeout(() => { player.pause(); calls.push('pause'); }, 10);
        throw busy();
      }
      calls.push('visibility');
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      busyOnce = true;
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      expect(calls).toEqual(['visibility', 'figure', 'emphasis', 'busy', 'pause']);
    } finally { dom.restore(); }
  });

  it('lets a newer close-up retry that fails answer for an older one still finishing', async () => {
    let holdClosing = false, release: (() => void) | undefined;
    const { dom, player, calls, inspection, failEmphasis } = closeUpLesson();
    inspection.setVisibility = async () => {
      calls.push('visibility');
      if (holdClosing && calls.includes('emphasis')) { holdClosing = false; await new Promise<void>(resolve => { release = resolve; }); }
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      holdClosing = true;
      const older = player.retryEmphasis();
      for (let turn = 0; turn < 5 && !release; turn++) await settle();
      expect(calls).toEqual(['visibility', 'figure', 'emphasis', 'visibility']);
      failEmphasis(true);
      const newer = player.retryEmphasis();
      await expect(newer).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      release!();
      await expect(older).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
    } finally { dom.restore(); }
  });

  it('does not lend a newer retry\'s answer to an older one once the wearer has stepped on', async () => {
    let busyOnce = false, followUp: Promise<string> | undefined;
    const { dom, player, calls, inspection, failEmphasis } = closeUpLesson(true, [plainStep]);
    inspection.setLessonFigure = async (value: unknown) => {
      if (busyOnce) {
        busyOnce = false; calls.push('busy');
        followUp = (async () => {
          const answer = await player.retryEmphasis();
          failEmphasis(true);
          await player.next();
          return answer;
        })();
        throw busy();
      }
      if (value) calls.push('figure');
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      busyOnce = true;
      const older = player.retryEmphasis();
      await expect(older).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      await expect(followUp).resolves.toBe(EMPHASIS_RETRY_SUCCESS_LINE);
      expect(player.getState().step).toBe(1);
      // The older retry installed nothing after its busy refusal.
      expect(calls.filter(call => call === 'figure')).toHaveLength(1);
    } finally { dom.restore(); }
  });

  it('stops a close-up retry\'s early visibility from writing again after the wearer steps on', async () => {
    let busyOnce = false, stepped: Promise<unknown> | undefined;
    const { dom, player, calls, inspection } = closeUpLesson(true, [plainStep]);
    inspection.setVisibility = async () => {
      if (busyOnce) {
        busyOnce = false; calls.push('busy');
        stepped = player.next().then(() => calls.push('stepped'));
        throw busy();
      }
      calls.push('visibility');
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      busyOnce = true;
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      await stepped;
      expect(player.getState().step).toBe(1);
      expect(calls.slice(calls.indexOf('stepped'))).not.toContain('visibility');
      expect(calls.filter(call => call === 'figure')).toHaveLength(0);
    } finally { dom.restore(); }
  });

  it('writes nothing for a close-up retry whose source changes before its early visibility', async () => {
    const { dom, player, calls, workspace } = closeUpLesson();
    const ws = workspace as any;
    let sourceSha256 = 'a';
    ws.snapshot = () => ({ ready: true, sourceSha256, xrPresenting: true, selectionKeys: [] as string[] });
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      const answer = player.retryEmphasis();
      sourceSha256 = 'b';
      await expect(answer).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      expect(calls).toEqual([]);
    } finally { dom.restore(); }
  });

  it('does not keep a newer retry\'s answer for an older one when the wearer steps on while it waits', async () => {
    let holdVisibility = false, holdEmphasis = false, wearerHolds = false;
    let releaseVisibility: (() => void) | undefined, releaseEmphasis: (() => void) | undefined;
    const { dom, player, calls, inspection } = closeUpLesson(true, [plainStep]);
    inspection.holdsWearerPlacement = () => wearerHolds;
    inspection.setVisibility = async () => {
      calls.push('visibility');
      if (holdVisibility) { holdVisibility = false; await new Promise<void>(resolve => { releaseVisibility = resolve; }); }
    };
    inspection.emphasize = async () => {
      calls.push('emphasis');
      if (holdEmphasis) { holdEmphasis = false; await new Promise<void>(resolve => { releaseEmphasis = resolve; }); }
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      holdVisibility = true;
      const older = player.retryEmphasis();
      for (let turn = 0; turn < 5 && !releaseVisibility; turn++) await settle();
      // The wearer holds the molecule, so the newer retry frames nothing and is not a close-up.
      wearerHolds = true; holdEmphasis = true;
      const newer = player.retryEmphasis();
      for (let turn = 0; turn < 5 && !releaseEmphasis; turn++) await settle();
      releaseVisibility!();
      await settle();
      wearerHolds = false;
      await player.next();
      expect(player.getState().step).toBe(1);
      releaseEmphasis!();
      await expect(newer).resolves.toBe(EMPHASIS_RETRY_SUCCESS_LINE);
      await expect(older).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
    } finally { dom.restore(); }
  });

  it('answers an older retry with the failure line when the newer one it waits on rejects after a step', async () => {
    let holdVisibility = false, holdClosing = false, wearerHolds = false;
    let releaseVisibility: (() => void) | undefined, rejectClosing: ((error: Error) => void) | undefined;
    const { dom, player, calls, inspection } = closeUpLesson(true, [plainStep]);
    inspection.holdsWearerPlacement = () => wearerHolds;
    inspection.setVisibility = async () => {
      calls.push('visibility');
      if (holdVisibility) { holdVisibility = false; await new Promise<void>(resolve => { releaseVisibility = resolve; }); }
      else if (holdClosing && calls.includes('emphasis')) { holdClosing = false; await new Promise<void>((_resolve, reject) => { rejectClosing = reject; }); }
    };
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      holdVisibility = true;
      const older = player.retryEmphasis();
      for (let turn = 0; turn < 5 && !releaseVisibility; turn++) await settle();
      wearerHolds = true; holdClosing = true;
      const newer = player.retryEmphasis();
      for (let turn = 0; turn < 5 && !rejectClosing; turn++) await settle();
      releaseVisibility!();
      await settle();
      wearerHolds = false;
      await player.next();
      expect(player.getState().step).toBe(1);
      rejectClosing!(Error('Closing visibility failed.'));
      await expect(newer).rejects.toThrow('Closing visibility failed.');
      await expect(older).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
    } finally { dom.restore(); }
  });

  /** Three retries of one close-up: the oldest waits on a second that frames nothing while a third settles first. */
  const threeRetries = async (secondCloses: 'resolve' | 'reject', thirdFails: boolean) => {
    let holdVisibility = false, holdClosing = false, wearerHolds = false;
    let releaseVisibility: (() => void) | undefined, settleClosing: ((error?: Error) => void) | undefined;
    const lesson = closeUpLesson();
    const { player, calls, inspection } = lesson;
    inspection.holdsWearerPlacement = () => wearerHolds;
    inspection.setVisibility = async () => {
      calls.push('visibility');
      if (holdVisibility) { holdVisibility = false; await new Promise<void>(resolve => { releaseVisibility = resolve; }); }
      else if (holdClosing && calls.includes('emphasis')) {
        holdClosing = false;
        await new Promise<void>((resolve, reject) => { settleClosing = error => error ? reject(error) : resolve(); });
      }
    };
    await player.select('lesson');
    await player.start(false);
    await settle();
    calls.length = 0;
    holdVisibility = true;
    const oldest = player.retryEmphasis();
    for (let turn = 0; turn < 5 && !releaseVisibility; turn++) await settle();
    // The wearer holds the molecule, so the second retry frames nothing and is not a close-up.
    wearerHolds = true; holdClosing = true;
    const second = player.retryEmphasis();
    for (let turn = 0; turn < 5 && !settleClosing; turn++) await settle();
    releaseVisibility!();
    await settle();
    wearerHolds = false;
    lesson.failEmphasis(thirdFails);
    const third = await player.retryEmphasis();
    settleClosing!(secondCloses === 'reject' ? Error('Closing visibility failed.') : undefined);
    return { lesson, oldest, second, third };
  };

  it('answers an older retry with the newest retry\'s line when a later one settles first', async () => {
    const { lesson, oldest, second, third } = await threeRetries('resolve', true);
    try {
      expect(third).toBe(EMPHASIS_RETRY_FAILURE_LINE);
      await expect(second).resolves.toBe(EMPHASIS_RETRY_SUCCESS_LINE);
      await expect(oldest).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
    } finally { lesson.dom.restore(); }
  });

  it('does not pass a stale rejection to an older retry once a later one has succeeded', async () => {
    const { lesson, oldest, second, third } = await threeRetries('reject', false);
    try {
      expect(third).toBe(EMPHASIS_RETRY_SUCCESS_LINE);
      await expect(second).rejects.toThrow('Closing visibility failed.');
      await expect(oldest).resolves.toBe(EMPHASIS_RETRY_SUCCESS_LINE);
    } finally { lesson.dom.restore(); }
  });

  it('answers a close-up retry with the failure line when the structure changes before its chapter validates', async () => {
    const { dom, player, calls, workspace } = closeUpLesson();
    const ws = workspace as any;
    let sourceSha256 = 'a', chains = ['A', 'B'];
    ws.snapshot = () => ({ ready: true, sourceSha256, xrPresenting: true, selectionKeys: [] as string[] });
    ws.rows = () => chains.map(chain => ({ key: chain, entityType: 'polymer',
      identity: { labelChain: chain, authorChain: chain, copyId: '1', modelNumber: 1 } }));
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      const answer = player.retryEmphasis();
      sourceSha256 = 'c'; chains = ['C', 'D'];
      await expect(answer).resolves.toBe(EMPHASIS_RETRY_FAILURE_LINE);
      expect(calls).toEqual([]);
    } finally { dom.restore(); }
  });

  it('keeps two overlapping retries of a chapter that is not a close-up as they were', async () => {
    const { dom, player, calls } = closeUpLesson(false);
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      calls.length = 0;
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_SUCCESS_LINE);
      expect(calls).toEqual(['figure', 'emphasis', 'visibility']);
      calls.length = 0;
      await expect(Promise.all([player.retryEmphasis(), player.retryEmphasis()]))
        .resolves.toEqual([EMPHASIS_RETRY_SUCCESS_LINE, EMPHASIS_RETRY_SUCCESS_LINE]);
      expect([...calls].sort()).toEqual(['emphasis', 'emphasis', 'figure', 'figure', 'visibility', 'visibility']);
    } finally { dom.restore(); }
  });

  it('answers a successful retry with the success line', async () => {
    let fail = true;
    let attempts = 0;
    const { dom, asides, player } = setup(async () => {
      attempts++;
      if (fail) throw Error("Could not find node 'yEw1bmA1hVpstsCEqyENWg'.");
    });
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      expect(asides).toContain(EMPHASIS_FAILURE_LINE);
      fail = false;
      await expect(player.retryEmphasis()).resolves.toBe(EMPHASIS_RETRY_SUCCESS_LINE);
      expect(attempts).toBe(2);
      expect(words(EMPHASIS_RETRY_SUCCESS_LINE)).toBeLessThan(12);
    } finally { dom.restore(); }
  });

  it('speaks nothing extra for a chapter whose highlight paints', async () => {
    const { dom, narrated, asides, player } = setup(async () => undefined);
    try {
      await player.select('lesson');
      await player.start(false);
      await player.next();
      await settle();
      expect(narrated).toEqual([guideStep.narration, recapStep.narration]);
      expect(asides).toEqual([]);
    } finally { dom.restore(); }
  });

  it('names the chapter the restored scene repainted, not the one the walk left behind', async () => {
    // The cached-restore site repaints a chapter's key outside the linear
    // walk, so it has to say whose key it is repainting. Left naming whatever
    // chapter the walk last touched, chapter 1's failure here would be charged
    // to chapter 2 — already reported — and the wearer coming back to a
    // chapter whose key has since died would never be told.
    let failing = false;
    const { dom, asides, player } = setup(async () => {
      if (failing) throw Error("Could not find node 'yEw1bmA1hVpstsCEqyENWg'.");
    });
    try {
      await player.select('lesson');
      await player.start(false);
      await settle();
      expect(asides).toEqual([]);
      // Chapter 2's key dies on the way out: the linear walk reports it.
      failing = true;
      await player.next();
      await settle();
      expect(asides).toEqual([EMPHASIS_FAILURE_LINE]);
      // Back repaints chapter 1 from its cached scene, and that key is gone
      // too. A second chapter, so a second line.
      await player.back();
      await settle();
      expect(player.getState().step).toBe(0);
      expect(asides).toEqual([EMPHASIS_FAILURE_LINE, EMPHASIS_FAILURE_LINE]);
    } finally { dom.restore(); }
  });

  it('rejects a retry with no active chapter', async () => {
    const { dom, player } = setup(async () => undefined);
    try {
      await expect(player.retryEmphasis()).rejects.toThrow('no active lesson chapter');
    } finally { dom.restore(); }
  });
});

/**
 * The failure line against the gate that used to
 * swallow it, and the chapter line with it.
 *
 * The unit tests above inject a narrator that simply records, so nothing in
 * them ever reached the page's own speech route. That route is the whole
 * defect. `speakNarration` in inspector.ts stamps every call with a generation
 * counter and hands a `stale()` down to the speaker, which asks it once the
 * Mac has rendered the audio and drops the line if it answers yes. A line is
 * stale when a newer narration has been asked for, or when the player is still
 * holding a *different* line as the one it is narrating.
 *
 * Two lines through that gate inside one chapter therefore cancel each other:
 * the failure line bumps the counter, so the chapter line is dropped, and the
 * failure line is dropped in turn because `narratingLine()` still answers with
 * the chapter's. Silence, and two `speech-dropped` records. The route below is
 * that gate, copied from inspector.ts:1238-1242, so this file fails if the
 * failure line ever goes back through it.
 */
const speechRoute = (narratingLine: () => string | undefined) => {
  const played: string[] = [];
  const dropped: string[] = [];
  let generation = 0;
  // The speaker: one queue, one line at a time. Nothing is dropped here — a
  // queued line waits for the one in front of it. Dropping is the gate's job.
  let turn: Promise<void> = Promise.resolve();
  const after = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
  const play = (line: string) => {
    turn = turn.then(async () => { played.push(line); await after(2); });
    return turn;
  };
  return {
    played, dropped,
    /** inspector.ts `speakNarration`: a stamp, a round trip, then `stale()`. */
    async narration(line: string) {
      const stamp = ++generation;
      const stale = () => {
        if (stamp !== generation) return true;
        const held = narratingLine();
        return held !== undefined && held !== line;
      };
      await after(5); // The Mac renders the audio.
      if (stale()) { dropped.push(line); return; }
      await play(line);
    },
    /** The ordinary acknowledgement slot: rendered, queued, never asked. */
    async aside(line: string) {
      await after(5);
      await play(line);
    },
  };
};

describe('the failure line against the page’s own speech gate', () => {
  const run = async (viaNarration: boolean) => {
    const dom = setupMockDom();
    let player: TourPlayer | undefined;
    const route = speechRoute(() => player?.narratingLine());
    const workspace = {
      snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: false, selectionKeys: [] as string[] }),
      rows: () => [], capture: () => ({}),
      runTour: async (action: () => Promise<void>) => action(),
      setStatus: () => undefined,
      viewer: {
        select: async () => undefined, focus: async () => undefined,
        inspection: {
          configure: async () => undefined, place: async () => undefined, fit: async () => undefined,
          resetOrientation: async () => undefined, orbit: async () => undefined, dolly: async () => undefined,
          setMotion: async () => undefined, restore: async () => undefined,
          emphasize: async () => { throw Error("Could not find node 'yEw1bmA1hVpstsCEqyENWg'."); },
        },
      },
    } as unknown as Workspace;
    player = mountTourPlayer({ workspace, tours, after: dom.mountAnchor,
      narrate: (line: string) => { void route.narration(line); },
      // `true` is the wiring this replaced: the failure line went out
      // through the same gated narration path the chapter line uses.
      aside: (line: string) => (viaNarration ? route.narration(line) : route.aside(line)) });
    try {
      await player.select('lesson');
      await player.start(false);
      await new Promise(resolve => { setTimeout(resolve, 80); });
      return route;
    } finally { dom.restore(); }
  };

  it('lets the wearer hear both the chapter and the failure, in that order', async () => {
    const route = await run(false);
    expect(route.played).toEqual([guideStep.narration, EMPHASIS_FAILURE_LINE]);
    expect(route.dropped).toEqual([]);
  });

  it('drops both of them if the failure line goes back through the narration gate', async () => {
    // The defect, kept so that reverting the fix fails this file rather than
    // passing it quietly: the wearer heard nothing, not even the chapter.
    const route = await run(true);
    expect(route.played).toEqual([]);
    expect(route.dropped).toHaveLength(2);
    expect(route.dropped).toContain(guideStep.narration);
    expect(route.dropped).toContain(EMPHASIS_FAILURE_LINE);
  });
});
