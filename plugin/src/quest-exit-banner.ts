/**
 * Laying the Mol* page out below Quest Browser's own exit banner.
 *
 * "Open in Mol*" ends the immersive session and sends the same Quest Browser
 * tab to `/detailed`. Quest Browser then draws its own banner across the top of
 * that tab — "The immersive web experience is still running in the background."
 * with Resume and Quit — and it is browser chrome, composited above the page
 * rather than laid out with it. The page cannot see it, measure it, or move it.
 *
 * The page's own 88 px top row is underneath it. On the Quest 2
 * that row carried "← Back to headset view", "Apply changes, then back to
 * headset", "Hold to talk" and the address chip, and a wearer could read none
 * of them: the banner's lower edge sat directly above `Selection sent: 0
 * residues.`, the line the page draws below that row
 * The way out of the page was
 * reachable only from a debugger.
 *
 * So the page has to be told. The tab that hands off is the only party that
 * knows an immersive session was running a moment ago, and it leaves a note in
 * this tab's `sessionStorage` on the way out; the detailed page reads it on
 * load and drops everything it anchors to the top of the viewport below the
 * banner's height.
 *
 * The note is deliberately weak, like the re-entry hint beside it: same origin,
 * same tab, gone when the tab closes, and it carries a timestamp and nothing
 * else. It is not cleared on read, because a reload of the detailed page while
 * the banner is still up has to lay out below it too.
 *
 * The bias is deliberate. A note that is wrong because the wearer has already
 * pressed Quit costs 112 px of overlay space over a canvas that still fills the
 * view. A missing note costs the wearer the way back out of the page, which is
 * the defect. Read the note generously.
 */

/** The same-tab note: "this tab left an immersive session for the Mol* page". */
export const QUEST_EXIT_BANNER_KEY = 'stereofold-xr-exit-banner';

/**
 * How far down the page starts while Quest Browser's banner is up.
 *
 * Not a reading of the banner — no page can take one. It is derived from the
 * one capture that has both layers in it: on a 1280x670 viewport the banner's lower edge sits just above the line the
 * page draws at `top: 92px`, so the covered band is about 92 px deep, and this
 * clears it with 20 px to spare at that viewport. A value that is slightly too
 * large costs overlay space, and one that is too small costs the row.
 */
export const QUEST_EXIT_BANNER_PX = 112;

/**
 * How long a note stands.
 *
 * Far longer than the handoff it describes, because the banner stands until the
 * wearer presses Quit and nothing tells the page when that happens. An hour is
 * past the LAN session's own lifetime, so a note that outlives this is
 * describing a tab whose way home has expired anyway.
 */
export const QUEST_EXIT_BANNER_MAX_AGE_MS = 3_600_000;

/** The subset of `Storage` these helpers need, so a test passes a plain object. */
export type BannerStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** What one note says: whether to lay out below the banner, and how old it is. */
export type QuestExitBannerReading = {covered: boolean; ageMs?: number};

/**
 * Leave the note as the tab hands off to the Mol* page.
 *
 * Never throws. A browser with storage off still reaches the page; it just
 * reaches it with its top row under the banner, which is where it was before.
 */
export function noteQuestExitBanner(storage?: BannerStorage | null, now: () => number = Date.now): boolean {
  try {
    storage?.setItem(QUEST_EXIT_BANNER_KEY, JSON.stringify({at: now()}));
    return Boolean(storage);
  } catch { return false; }
}

/**
 * Read the note without spending it.
 *
 * Self-contained and argument-fed, defaults included, because the served page
 * runs this function's own source: the server bundle is minified, so anything
 * this body named — a constant, a default — would name a renamed identifier
 * that does not exist in the page.
 */
export function readQuestExitBanner(storage: BannerStorage | null | undefined,
  key: string, maxAgeMs: number, at: number): QuestExitBannerReading {
  let raw: string | null = null;
  try { raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null; }
  catch (error) { return {covered: false}; }
  if (raw === null) return {covered: false};
  let parsed: {at?: unknown} | null = null;
  try { parsed = JSON.parse(raw) as {at?: unknown}; } catch (error) { return {covered: false}; }
  const noted = parsed && typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null;
  if (noted === null) return {covered: false};
  const ageMs = at - noted;
  return ageMs >= 0 && ageMs <= maxAgeMs ? {covered: true, ageMs} : {covered: false, ageMs};
}

/** The same reading with this build's own key, clock and lifetime. */
export function readQuestExitBannerHere(storage?: BannerStorage | null, now: () => number = Date.now): QuestExitBannerReading {
  return readQuestExitBanner(storage, QUEST_EXIT_BANNER_KEY, QUEST_EXIT_BANNER_MAX_AGE_MS, now());
}

/** How far the page's top row drops for one reading. */
export function questExitBannerInset(reading: QuestExitBannerReading | null | undefined): number {
  return reading?.covered === true ? QUEST_EXIT_BANNER_PX : 0;
}

/** The reader, as source the served page runs. See `pageKeySource` for why. */
export function questExitBannerSource(): string {
  const storage = '(function(){try{return sessionStorage}catch(error){return undefined}})()';
  return `(${readQuestExitBanner.toString()})(${storage},${JSON.stringify(QUEST_EXIT_BANNER_KEY)},`
    + `${QUEST_EXIT_BANNER_MAX_AGE_MS},Date.now())`;
}

/**
 * The rules that put the page below the banner, and nothing else.
 *
 * One custom property carries the whole decision, so every line the page pins
 * to the top of the viewport is written once, against `--xr-banner`, and the
 * banner state changes one number rather than nine rules.
 */
export function questExitBannerCss(): string {
  return `body{--xr-banner:0px}body[data-xr-banner="on"]{--xr-banner:${QUEST_EXIT_BANNER_PX}px}`;
}
