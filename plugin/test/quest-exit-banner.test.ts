/**
 * Quest Browser's own "The immersive web experience is still running in the
 * background." banner is chrome composited above the page. The page cannot see
 * it, so the tab that handed off leaves a note and the page reads it. What
 * these tests hold is the note's weakness and the reading's bias: it carries a
 * moment and nothing else, it is never spent on read, and where it is unclear
 * the page lays out lower rather than leaving its way out under the banner.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  QUEST_EXIT_BANNER_KEY, QUEST_EXIT_BANNER_MAX_AGE_MS, QUEST_EXIT_BANNER_PX,
  noteQuestExitBanner, questExitBannerCss, questExitBannerInset, questExitBannerSource,
  readQuestExitBanner, readQuestExitBannerHere,
} from '../src/quest-exit-banner.js';

const store = () => {
  const held = new Map<string, string>();
  return { held, getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => { held.set(key, value); } };
};

describe('the note a handing-off tab leaves', () => {
  it('carries a moment and no capability at all', () => {
    const storage = store();
    expect(noteQuestExitBanner(storage, () => 1_000)).toBe(true);
    expect(JSON.parse(storage.held.get(QUEST_EXIT_BANNER_KEY)!)).toEqual({ at: 1_000 });
  });

  it('never blocks the handoff when storage is off', () => {
    expect(noteQuestExitBanner(undefined)).toBe(false);
    expect(noteQuestExitBanner(null)).toBe(false);
    expect(noteQuestExitBanner({ getItem: () => null, setItem: () => { throw Error('off'); } })).toBe(false);
  });
});

describe('reading the note', () => {
  const read = (raw: string | null, at: number) => readQuestExitBanner(
    { getItem: () => raw, setItem: () => {} }, QUEST_EXIT_BANNER_KEY, QUEST_EXIT_BANNER_MAX_AGE_MS, at);

  it('lays the page out below the banner for a note this tab just left', () => {
    expect(read(JSON.stringify({ at: 1_000 }), 1_500)).toEqual({ covered: true, ageMs: 500 });
    expect(questExitBannerInset(read(JSON.stringify({ at: 1_000 }), 1_500))).toBe(QUEST_EXIT_BANNER_PX);
  });

  it('is not spent on read, because a reload is still behind the same banner', () => {
    const storage = store();
    noteQuestExitBanner(storage, () => 1_000);
    expect(readQuestExitBannerHere(storage, () => 1_100).covered).toBe(true);
    expect(readQuestExitBannerHere(storage, () => 1_200).covered).toBe(true);
  });

  it('lays the page out at the top when there is nothing to read', () => {
    for (const raw of [null, '', 'not json', '{}', JSON.stringify({ at: 'soon' }), JSON.stringify({ at: null })]) {
      expect(`${raw}: ${read(raw, 1_000).covered}`).toBe(`${raw}: false`);
    }
    expect(questExitBannerInset(read(null, 1_000))).toBe(0);
    expect(questExitBannerInset(null)).toBe(0);
    // Storage that throws on read is a page at the top, not a thrown page.
    expect(readQuestExitBannerHere({ getItem: () => { throw Error('blocked'); }, setItem: () => {} })).toEqual({ covered: false });
  });

  it('lets a note expire, and refuses one from the future', () => {
    expect(read(JSON.stringify({ at: 1_000 }), 1_000 + QUEST_EXIT_BANNER_MAX_AGE_MS).covered).toBe(true);
    expect(read(JSON.stringify({ at: 1_000 }), 1_001 + QUEST_EXIT_BANNER_MAX_AGE_MS).covered).toBe(false);
    expect(read(JSON.stringify({ at: 2_000 }), 1_000).covered).toBe(false);
    // The note stands far longer than the handoff, because nothing tells the
    // page when the wearer presses Quit on the banner.
    expect(QUEST_EXIT_BANNER_MAX_AGE_MS).toBeGreaterThan(600_000);
  });
});

describe('what the page is given', () => {
  it('clears the 88 px row the banner covered', () => {
    // An earlier run’s capture puts the banner's lower edge just above the page's own
    // line at 92 px. Anything at or under that leaves the row covered.
    expect(QUEST_EXIT_BANNER_PX).toBeGreaterThan(92);
    expect(questExitBannerCss()).toBe(`body{--xr-banner:0px}body[data-xr-banner="on"]{--xr-banner:${QUEST_EXIT_BANNER_PX}px}`);
  });

  it('emits a self-contained reader, because the served bundle is minified', () => {
    const source = questExitBannerSource();
    expect(source).toContain(JSON.stringify(QUEST_EXIT_BANNER_KEY));
    expect(source).toContain(String(QUEST_EXIT_BANNER_MAX_AGE_MS));
    // No module identifier survives into the page: every value is an argument.
    expect(source).not.toMatch(/QUEST_EXIT_BANNER_(?:KEY|MAX_AGE_MS|PX)/u);
    // It runs in a page-shaped scope, and answers the way the module does.
    const run = (raw: string | null, at: number) => runInNewContext(source,
      { sessionStorage: { getItem: () => raw }, Date: { now: () => at } });
    expect(run(JSON.stringify({ at: 1_000 }), 1_500)).toEqual({ covered: true, ageMs: 500 });
    expect(run(null, 1_500)).toEqual({ covered: false });
    // A page whose sessionStorage getter throws still loads.
    expect(runInNewContext(source, { Date: { now: () => 1_500 },
      get sessionStorage(): unknown { throw Error('blocked'); } })).toEqual({ covered: false });
  });
});
