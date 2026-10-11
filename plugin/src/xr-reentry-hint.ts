/**
 * Coming back from the full Mol* viewer without hunting for a button.
 *
 * "Open in Mol*" ends the immersive session and sends the same Quest Browser
 * tab to `/detailed`. The way back is the page's own "Back to headset view"
 * link, which lands on the companion page in 2D with the wearer still in the
 * headset, looking at a flat panel and searching for Enter VR.
 *
 * A WebXR session cannot be requested without transient user activation, and a
 * navigation does not carry the click that caused it into the next document,
 * so the Back tap itself can never re-enter. What the two pages can share is a
 * hint: `/detailed` arms one in `sessionStorage` (same origin, same tab, gone
 * when the tab closes) and the companion page consumes it on load, puts Enter
 * VR in view and under focus, and arms the next tap on the page background as
 * the gesture that enters. That is one tap on the companion page rather than a
 * hunt, and it degrades to a focused button where anything is unavailable.
 *
 * The hint is deliberately weak: it carries no capability, only a timestamp,
 * it is consumed exactly once, and it expires, so a tab left open on the
 * detailed page for an hour cannot hijack a much later visit to the companion.
 */

/**
 * The hint is armed on the way out, not on one control.
 *
 * Only a click on the detailed page's own "Back to headset
 * view" link wrote it (`detailed-view-page.ts`). Quest Browser gives the
 * wearer three other ways out of that page — the browser's own Back arrow,
 * the controller's B button, and the back gesture — and every one of them
 * landed on the companion with no hint at all, so there was no "tap anywhere"
 * and the wearer hunted for a small Enter VR button on a flat page. The route
 * to Mol* read as one-way, with no way back.
 * Arming on `pagehide` covers all four, and `via` records which one so
 * the return diagnostic can say how the wearer actually left.
 */
export const XR_REENTRY_KEY = 'stereofold-reenter-xr';

/** How the wearer left the detailed page, for the returning diagnostic. */
export type XrReentryVia = 'back-link' | 'unload' | 'recall';

/** How long a hint stays good. Long enough for a slow companion load, no longer. */
export const XR_REENTRY_MAX_AGE_MS = 120_000;

/**
 * What the companion page says while the next tap is the way back in.
 *
 * The line now says why a tap is needed at all. "Tap
 * anywhere to return to VR." reads like a page that could have taken the
 * wearer back by itself and chose not to; the truth is that WebXR grants a
 * session only to a real click, and a navigation carries none into the next
 * document, so the tap is the mechanism rather than a courtesy. A wearer who
 * knows that stops waiting for the headset to come back on its own.
 */
export const XR_REENTRY_NOTICE = 'Tap Enter VR, or anywhere on this page — the headset needs one real tap to go back in.';

/**
 * What the companion shows a wearer coming back from
 * the full Mol* viewer.
 *
 * Coming home from Mol* is not the same moment as arriving on the companion
 * page for the first time. A first arrival is a person deciding how to enter,
 * and the page rightly offers passthrough, the opaque room under More options,
 * and a line explaining the difference. A return is a person who was in the
 * scene ninety seconds ago and wants to be in it again: one control, named
 * once, with the reason a tap is required. Three controls and a paragraph
 * about blend modes is where a device test watched a wearer
 * hunt on a flat panel.
 *
 * Pure, so `inspector.ts` reads it once per sync and the suite reads it
 * without a DOM. `single` is false for everything that is more urgent news
 * than the way back: a problem, an entry already running, a fallback waiting
 * for a press, or a session that is already up.
 */
export function xrReentryEntryView(state: {
  returning: boolean; presenting?: boolean; pending?: boolean; problem?: string; pendingEntry?: boolean;
  enterDisabled?: boolean;
}): {single: boolean; line?: string} {
  const quiet = state.returning && !state.presenting && !state.pending
    && !state.problem && !state.pendingEntry && !state.enterDisabled;
  return quiet ? {single: true, line: XR_REENTRY_NOTICE} : {single: false};
}

/** The subset of `Storage` these helpers need, so a test passes a plain object. */
export type HintStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Arm the hint as the wearer leaves the detailed page.
 *
 * Never throws: a browser with storage disabled still follows the link, and
 * the wearer still arrives at a page with an Enter VR button on it.
 */
export function armXrReentry(storage?: HintStorage | null, now: () => number = Date.now,
  via: XrReentryVia = 'back-link'): boolean {
  try {
    storage?.setItem(XR_REENTRY_KEY, JSON.stringify({at: now(), via}));
    return Boolean(storage);
  } catch { return false; }
}

/** What one consumed hint says: whether to arm, and what to record about it. */
export type XrReentryHint = {fresh: boolean; via?: XrReentryVia; awayMs?: number};

/**
 * Read the hint once and clear it, whether or not it was still fresh.
 *
 * Clearing an expired hint matters as much as honouring a fresh one: a stale
 * entry that survived would arm a tap on some unrelated later load.
 *
 * The reading also carries how long the wearer was over in
 * Mol* and which way they came back, because the companion is the only place
 * that can put a return on the diagnostics ring — the detailed page is a plain
 * Mol* document with none of this page's modules in it.
 */
export function readXrReentry(storage?: HintStorage | null, now: () => number = Date.now): XrReentryHint {
  let raw: string | null = null;
  try { raw = storage?.getItem(XR_REENTRY_KEY) ?? null; } catch { return {fresh: false}; }
  if (raw === null) return {fresh: false};
  try { storage?.removeItem(XR_REENTRY_KEY); } catch { /* A hint that cannot be cleared is still used once. */ }
  let parsed: {at?: unknown; via?: unknown};
  try { parsed = JSON.parse(raw) as {at?: unknown; via?: unknown}; } catch { return {fresh: false}; }
  const at = parsed?.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return {fresh: false};
  const age = now() - at;
  const via = parsed?.via === 'unload' || parsed?.via === 'recall' ? parsed.via : 'back-link';
  if (!(age >= 0 && age <= XR_REENTRY_MAX_AGE_MS)) return {fresh: false, via, awayMs: Math.max(0, age)};
  return {fresh: true, via, awayMs: age};
}

/** The boolean half of `readXrReentry`, for callers that only arm on it. */
export function consumeXrReentry(storage?: HintStorage | null, now: () => number = Date.now): boolean {
  return readXrReentry(storage, now).fresh;
}

/**
 * Whether one tap should be taken as "put me back in VR".
 *
 * A tap that lands on a real control is that control's, never the shortcut's:
 * the wearer reaching for More options, or for Enter plain VR, means it. Only
 * the page background stands in for Enter VR.
 */
export function xrReentryTapTarget(target: {closest?: (selector: string) => unknown} | null | undefined): boolean {
  if (!target) return true;
  try { return !target.closest?.('button, a, select, input, textarea, summary, label, [role="button"]'); }
  catch { return false; }
}

/** What the arming reports, in the order it can happen: armed, then one of the other two. */
export type XrReentryState = 'armed' | 'tapped' | 'expired';

type TapDocument = {
  addEventListener(type: string, handler: (event: {target?: unknown}) => void, capture?: boolean): void;
  removeEventListener(type: string, handler: (event: {target?: unknown}) => void, capture?: boolean): void;
};
type EnterButton = {
  disabled?: boolean;
  click(): void;
  focus?(options?: {preventScroll?: boolean}): void;
  scrollIntoView?(options?: boolean | {block?: 'center' | 'start' | 'end' | 'nearest'}): void;
};

/**
 * Put Enter VR under the wearer's eyes and under their next tap.
 *
 * The tap is spent by calling `click()` synchronously inside the real event,
 * so the session request the button makes still holds the activation that tap
 * granted. A tap while the button is disabled is left alone rather than
 * wasted, and the arming expires so a page left open cannot ambush a later
 * tap with a headset entry.
 */
export function armXrReentryTap(options: {
  document: TapDocument;
  button: EnterButton;
  onState?: (state: XrReentryState) => void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): {disarm: () => void; armed: () => boolean} {
  const {document: target, button, onState, timeoutMs = XR_REENTRY_MAX_AGE_MS,
    setTimer = setTimeout, clearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)} = options;
  let armed = true;
  const settle = (state: XrReentryState) => {
    if (!armed) return false;
    armed = false;
    try { clearTimer(timer); } catch { /* An already-fired timer is inert. */ }
    try { target.removeEventListener('click', onTap, true); } catch { /* Already detached. */ }
    try { onState?.(state); } catch { /* Reporting is not the mechanism. */ }
    return true;
  };
  const onTap = (event: {target?: unknown}) => {
    if (!armed) return;
    if (!xrReentryTapTarget(event?.target as {closest?: (selector: string) => unknown} | null)) return;
    if (button.disabled) return;
    settle('tapped');
    button.click();
  };
  const timer = setTimer(() => settle('expired'), timeoutMs);
  try { target.addEventListener('click', onTap, true); }
  catch { /* A page with no event target still shows a focused button. */ }
  try { button.scrollIntoView?.({block: 'center'}); } catch { /* An old layout still focuses. */ }
  try { button.focus?.({preventScroll: true}); } catch { /* Focus is the hint, not the mechanism. */ }
  try { onState?.('armed'); } catch { /* Same. */ }
  return {disarm: () => { settle('expired'); }, armed: () => armed};
}
