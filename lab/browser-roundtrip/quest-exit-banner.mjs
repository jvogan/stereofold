/**
 * Telling the Mol* page that Quest Browser's exit banner is up.
 *
 * The handoff ends the immersive session and sends this same tab to
 * `/detailed`. Quest Browser then draws "The immersive web experience is still
 * running in the background." with Resume and Quit across the top of the tab,
 * as chrome composited above the page, and on the Quest 2 it
 * covered the Mol* page's entire 88 px top row — the way back, the Apply
 * control, Hold to talk and the address chip
 *
 * The page cannot see that banner. This tab is the only party that knows an
 * immersive session was running a moment ago, so it leaves the note on the way
 * out and the page lays itself out below the banner's height.
 *
 * `plugin/src/quest-exit-banner.ts` owns the reading end and the key; this is
 * the writing end, and `quest-exit-banner.test.mjs` pins the two keys together
 * because the lab and the plugin do not share a module.
 */

/** The same-tab note. Must equal `QUEST_EXIT_BANNER_KEY` in the plugin. */
export const QUEST_EXIT_BANNER_KEY = 'stereofold-xr-exit-banner';

/**
 * Leave the note as this tab hands off.
 *
 * Never throws and never blocks the handoff: a browser with storage off still
 * reaches the Mol* page, just with its top row where it already was.
 */
export function noteQuestExitBanner(storage, now = Date.now) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(QUEST_EXIT_BANNER_KEY, JSON.stringify({ at: now() }));
    return true;
  } catch { return false; }
}
