/**
 * Which Quest Browser tab is the live viewer, and what a
 * launch does with the ones that are not.
 *
 * Measured on a Quest 2:
 * twenty-one identical `/viewer` tabs were open at once. Every host restart
 * that evening ran `manage_companion {"action":"launch","launch":"adb"}`, and
 * an `am start -a VIEW` intent opens a NEW tab every time — it never focuses
 * the one already there — so each restart left one more behind. Exactly one of
 * the twenty-one held the immersive session and drew the spatial menu. The
 * driver picked a different one through CDP, spent three recovery steps on it,
 * and reported a broken headset while the live page was rendering correctly.
 *
 * Two decisions come out of that, and both are here so the host and the driver
 * cannot disagree about them:
 *
 * - `chooseLiveTab` ranks candidates by what the PAGE answered, not by tab id.
 *   A frozen tab answers nothing at all (Quest Browser suspends every tab that
 *   is not the visible one), so silence is the strongest possible evidence
 *   that a tab is not the one the wearer is looking at. "Newest" is only ever
 *   a tie-break between two tabs that both answered.
 * - `planLaunchHygiene` decides what a launch closes, so a launch leaves
 *   exactly one viewer tab. It closes nothing it cannot identify: the plan is
 *   fenced by the share's own origin upstream, and a probe that could not run
 *   at all downgrades to "launch anyway and say older tabs may remain".
 *
 * Drawing the menu is not the same as being on this share, and that is the
 * defect observed on a Quest 2. The demo host's ten-hour share
 * ended on its timer at 04:26 and a new one opened at 08:05. The headset still
 * had the old tab in front, showing the page's own "sharing from your Mac has
 * ended" plate — and that plate does not take the spatial-menu hook down, so
 * `__stereofoldMenu.rows()` still answered. The probe read the rows, ranked the
 * tab `menu`, kept it, closed five duplicates and sent no intent, so no
 * `#pair=` code ever reached the headset and `headset-drive.ts --steps enter`
 * failed three times on a page that could not be re-paired from inside the
 * headset. The drive could see the plate and the probe could not.
 *
 * So a reading now carries why a tab is finished as well as how live it looks,
 * and both reasons come from what the page itself publishes:
 * `document.body.dataset.startupFailure` for a share that closed, and
 * `document.body.dataset.sessionId` for a tab left over from another share.
 *
 * Everything in this file is pure except `probeTabs`, which needs a debugger
 * transport and is given one by its caller.
 */

import { SHARE_ENDED_STARTUP_FAILURE } from './companion-startup.js';
import { evaluateParameters, isSilentTargetError, parseTargets, pageTargets, readEvaluateResult,
  redactDevtoolsText, redactUrl, targetOrigin, isStereofoldTargetUrl, isStereofoldTarget,
  type DevtoolsTarget, type DevtoolsTransport } from './headset-devtools.js';

/**
 * What the probe asks a candidate tab, read-only.
 *
 * It calls `menu.rows()`, which the spatial-menu hook documents as a pure read
 * of the drawn rows, and it never calls `press`, `state`, `say` or any other
 * mutator: the wearer is usually in the headset while this runs, and a "which
 * tab are you" question that presses a menu row would be worse than the bug it
 * is diagnosing.
 *
 * `presenting` is derived exactly the way `PAGE_STATE_EXPRESSION` derives it,
 * from the diagnostics ring's last session-start / session-end pair, so the two
 * readings of the same page cannot disagree.
 *
 * `startupFailure` and `sessionId` are read raw and judged in TypeScript below,
 * against the same constant `inspector.ts` writes and the session id the host
 * knows it is sharing. Nothing is re-derived from the wearer's plate text: the
 * page already classified its own failure, and reading its verdict is what
 * stops this probe and `headset-drive.ts` disagreeing about one tab.
 */
export const TAB_LIVENESS_EXPRESSION = `(() => {
  const pick = fn => { try { const value = fn(); return value === undefined ? null : value; } catch { return null; } };
  const menu = pick(() => globalThis.__stereofoldMenu);
  const rows = menu && typeof menu.rows === 'function' ? (pick(() => menu.rows()) ?? []) : [];
  const diagnostics = pick(() => globalThis.__stereofoldDiagnostics);
  const entries = diagnostics ? (pick(() => diagnostics.entries()) ?? []) : [];
  const last = kind => { for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i] && entries[i].kind === kind) return entries[i]; return null; };
  const started = last('session-start'), ended = last('session-end');
  const startedAt = started ? (started.at ?? started.time ?? null) : null;
  const endedAt = ended ? (ended.at ?? ended.time ?? null) : null;
  const body = pick(() => document.body);
  return {
    url: pick(() => location.href),
    pathname: pick(() => location.pathname),
    visibility: pick(() => document.visibilityState),
    startupFailure: pick(() => (body && body.dataset.startupFailure) || null),
    sessionId: pick(() => (body && body.dataset.sessionId) || null),
    errorPage: pick(() => location.protocol) === 'chrome-error:',
    menu: Boolean(menu && typeof menu.rows === 'function'),
    menuRows: Array.isArray(rows) ? rows.length : 0,
    viewer: Boolean(diagnostics) || Boolean(pick(() => globalThis.__stereofoldRoundtrip)),
    presenting: Boolean(started) && (!ended || (startedAt !== null && endedAt !== null ? startedAt > endedAt : false)),
  };
})()`;

/**
 * Why a tab that answers is finished anyway.
 *
 * `share-ended` is the page's own verdict on its startup: the Mac stopped
 * sharing and only the Mac can reopen it. `other-share` is a tab bound to an
 * inspection session this host is no longer sharing, which is the same tab one
 * host restart later.
 */
export type TabEnded = 'share-ended' | 'other-share';

/** One candidate tab and whatever it answered. `answered: false` is a frozen tab. */
export type TabReading = {
  id: string;
  url: string;
  title: string;
  /** Whether the page replied to the probe at all. */
  answered: boolean;
  /** `__stereofoldMenu.rows` is installed, so this page is a viewer that booted. */
  menu: boolean;
  menuRows: number;
  /** An immersive session is running in this tab right now. */
  presenting: boolean;
  visibility?: string;
  pathname?: string;
  /** Why the page said nothing, when it said nothing. */
  silence?: string;
  /** Why this page is not on this share any longer, when it is not. */
  ended?: TabEnded;
  /** The inspection session the page says it hydrated, when it says one. */
  sessionId?: string;
  /** What the page stamped on `document.body.dataset.startupFailure` when its boot failed. */
  startupFailure?: string;
  /** The tab shows a Chromium error page, such as the certificate warning, instead of the viewer. */
  errorPage?: boolean;
};

/**
 * How live a tab is, worst to best. The words appear in operator output.
 *
 * `ended` sits above silence and below every tab that can still be driven. It
 * has to: an ended tab answers the probe fluently, draws the spatial menu and
 * is worth nothing, because the one thing it cannot do is pair itself to the
 * share that is open now.
 */
export type TabLiveness = 'silent' | 'ended' | 'answered' | 'menu' | 'presenting';

export const TAB_LIVENESS_ORDER: readonly TabLiveness[] = Object.freeze(['silent', 'ended', 'answered', 'menu', 'presenting']);

/** What one reading amounts to. Nothing below `answered` may ever be driven. */
export function tabLiveness(reading: TabReading): TabLiveness {
  if (!reading.answered) return 'silent';
  // Before the menu and before the session: a page showing the share-ended
  // plate still answers both of those, and ranking it on them is the bug.
  if (reading.ended) return 'ended';
  if (reading.presenting && reading.menu) return 'presenting';
  if (reading.menu) return 'menu';
  return 'answered';
}

/** What an ended tab is, in the words an operator should read. */
export function describeEnded(ended: TabEnded): string {
  return ended === 'share-ended'
    ? 'the page says sharing from the Mac has ended, so it cannot pair itself to this share'
    : 'the page is still holding another inspection session, not the one being shared now';
}

/** Whether this tab could be driven: it answered, and it is still on this share. */
function driveable(reading: TabReading): boolean {
  return reading.answered && reading.ended === undefined;
}

/**
 * A tab on this share whose page never finished booting, such as a restored
 * viewer asking to pair again, or a viewer stopped at Quest Browser's
 * certificate warning.
 *
 * The drive may still reload or re-pair one, so it stays driveable there. A
 * launch must not keep one: it would report the wearer already on the page
 * and send no pairing code. Behind the certificate warning the kept tab holds
 * the address it failed on, so the person's Proceed would load a viewer with
 * no pairing code for this share.
 */
function failedStart(reading: TabReading): boolean {
  return driveable(reading) && (reading.startupFailure !== undefined || reading.errorPage === true);
}

function rank(reading: TabReading): number {
  return TAB_LIVENESS_ORDER.indexOf(tabLiveness(reading));
}

/**
 * Newest-first among equals: Quest Browser numbers tabs in creation order, so
 * the highest numeric id is the most recently opened. List order is the
 * fallback for a build that does not number them.
 */
function newer(a: TabReading, b: TabReading): boolean {
  if (/^\d+$/u.test(a.id) && /^\d+$/u.test(b.id)) return Number(a.id) > Number(b.id);
  return false;
}

/** One printable line per tab: id, what it answered, and where it is. */
export function describeTab(reading: TabReading): string {
  const rows = reading.menu ? `, ${reading.menuRows} menu row${reading.menuRows === 1 ? '' : 's'}` : '';
  const seen = reading.visibility ? `, document ${reading.visibility}` : '';
  const why = reading.silence ? ` — ${reading.silence}`
    : reading.ended ? ` — ${describeEnded(reading.ended)}` : '';
  return `${reading.id}  ${tabLiveness(reading).padEnd(10)}  ${redactUrl(reading.url)}  ${redactDevtoolsText(reading.title)}${rows}${seen}${why}`;
}

/** The whole candidate list, for a failure that has to name what it saw. */
export function describeTabs(readings: readonly TabReading[]): string {
  if (!readings.length) return 'no candidate tabs';
  return readings.map(describeTab).join('\n');
}

export type TabChoice = {
  chosen?: TabReading;
  /** Why that tab, or why none of them, in one sentence. */
  reason: string;
  /** Every tab that was not chosen, with the reason it lost. */
  rejected: { id: string; reason: string }[];
};

/**
 * Which of these tabs is the live viewer.
 *
 * The order is: a tab that is presenting and draws the menu, then one that
 * draws the menu, then one that merely answered, then nothing. A silent tab is
 * never chosen — that is the whole point of the probe, and driving one is what
 * the session did for three recovery steps.
 */
export function chooseLiveTab(readings: readonly TabReading[]): TabChoice {
  const live = readings.filter(driveable);
  if (!live.length) {
    if (!readings.length) return { reason: 'The debugger listed no candidate tab.', rejected: [] };
    const many = readings.length === 1 ? '' : 's';
    const ended = readings.filter(reading => reading.ended !== undefined).length;
    // Two different failures, and telling them apart is the whole point. All
    // silent means the wearer is looking at something else. Ended means the
    // wearer is looking at this product, on a share that is over, and no
    // amount of probing or reloading in the headset will bring it back.
    const reason = !ended
      ? `None of the ${readings.length} candidate tab${many} answered the page probe. `
        + 'Quest Browser freezes every tab that is not the visible one, so a tab that says nothing is not the tab the wearer is looking at.'
      : `None of the ${readings.length} candidate tab${many} is on this share: ${countedTabs(readings)}. `
        + 'A share that has ended reopens only from the Mac, and the page in the headset cannot pair itself to the new one.';
    return { reason, rejected: readings.map(reading => ({ id: reading.id, reason: rejection(reading) })) };
  }
  let chosen = live[0]!;
  for (const reading of live.slice(1)) {
    if (rank(reading) > rank(chosen) || (rank(reading) === rank(chosen) && newer(reading, chosen))) chosen = reading;
  }
  const why = tabLiveness(chosen) === 'presenting'
    ? 'it is presenting an immersive session and draws the spatial menu'
    : tabLiveness(chosen) === 'menu'
      ? 'it draws the spatial menu; no tab reported an immersive session'
      : 'it answered the page probe; no tab draws the spatial menu yet';
  const among = readings.length > 1 ? ` (of ${readings.length} candidate tabs)` : '';
  return {
    chosen,
    reason: `Tab ${chosen.id}${among}: ${why}.`,
    rejected: readings.filter(reading => reading.id !== chosen.id)
      .map(reading => ({ id: reading.id, reason: rejection(reading, chosen.id) })),
  };
}

/** Why one tab lost, in its own terms rather than the winner's. */
function rejection(reading: TabReading, winner?: string): string {
  if (!reading.answered) return reading.silence ?? 'the page did not answer';
  if (reading.ended) return describeEnded(reading.ended);
  return winner ? `${tabLiveness(reading)}, and tab ${winner} ranked higher` : `${tabLiveness(reading)}`;
}

/**
 * The candidates counted by what is wrong with them, for one sentence.
 *
 * Ended tabs are counted apart from frozen ones because they are apart: a
 * frozen tab is a duplicate nobody is looking at, and an ended tab is usually
 * the page in front of the wearer's eyes.
 */
function countedTabs(readings: readonly TabReading[]): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => { if (n) parts.push(`${n} ${n === 1 ? one : many}`); };
  count(readings.filter(reading => reading.ended === 'share-ended').length,
    'says its share has ended', 'say their share has ended');
  count(readings.filter(reading => reading.ended === 'other-share').length,
    'is still on another share', 'are still on another share');
  count(readings.filter(reading => !reading.answered).length, 'answered nothing', 'answered nothing');
  count(readings.filter(reading => driveable(reading)).length, 'is live', 'are live');
  if (parts.length <= 1) return parts[0] ?? 'nothing was readable';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export type LaunchHygienePlan = {
  /** Tab ids to close before anything else happens. */
  close: string[];
  /** Whether the VIEW intent still has to be sent. */
  launch: boolean;
  /** The tab that is kept, when one is live. */
  keep?: string;
  /** One sentence for the tool text, always honest about what was not checked. */
  note: string;
};

/**
 * What a launch should do with the tabs that are already open.
 *
 * `probed: false` is the no-debugger case and the reason this function exists
 * rather than a bare "close everything": with no CDP the host cannot tell its
 * own tabs from the wearer's, cannot tell a live tab from a frozen one, and
 * must not close anything. It launches and says so.
 */
export function planLaunchHygiene({ readings, probed }:
  { readings: readonly TabReading[]; probed: boolean }): LaunchHygienePlan {
  if (!probed) {
    return { close: [], launch: true,
      note: 'The headset debugger did not answer, so no older Quest Browser tab could be identified or closed; '
        + 'older viewer tabs may still be open behind this one. Close them in the headset if the wearer sees a stale page.' };
  }
  if (!readings.length) {
    return { close: [], launch: true, note: 'Quest Browser had no viewer tab open, so this launch opened the first one.' };
  }
  const choice = chooseLiveTab(readings.filter(reading => !failedStart(reading)));
  const stale = readings.filter(reading => reading.id !== choice.chosen?.id);
  const ids = stale.map(reading => reading.id);
  if (!choice.chosen) {
    // Every candidate is finished, so the launch is the point of this call.
    // Saying only "closed N tabs" was the failure read backwards:
    // the operator needs to know a fresh intent went out, because the tab that
    // was closed was the one the wearer was reading.
    const closed = ids.length === readings.length ? readings.map(reading => reading.id) : ids;
    return { close: closed, launch: true,
      note: `Closed ${closedTabs(readings)}, then opened one fresh tab. ${launchedBecause(readings)}`.trim() };
  }
  return { close: ids, launch: false, keep: choice.chosen.id,
    note: ids.length
      ? `Kept the live viewer tab ${choice.chosen.id} (${tabLiveness(choice.chosen)}) and closed ${closedTabs(stale)}; no new tab was opened.`
      : `The live viewer tab ${choice.chosen.id} (${tabLiveness(choice.chosen)}) was already the only one; no new tab was opened.` };
}

/** What a launch closed, counted by kind, for the tool text. */
function closedTabs(readings: readonly TabReading[]): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => { if (n) parts.push(`${n} ${n === 1 ? one : many}`); };
  count(readings.filter(reading => reading.ended === 'share-ended').length,
    'viewer tab whose share had ended', 'viewer tabs whose share had ended');
  count(readings.filter(reading => reading.ended === 'other-share').length,
    'viewer tab left on another share', 'viewer tabs left on another share');
  count(readings.filter(reading => !reading.answered).length,
    'frozen viewer tab that answered nothing', 'frozen viewer tabs that answered nothing');
  count(readings.filter(failedStart).length,
    'viewer tab whose page failed to start', 'viewer tabs whose page failed to start');
  count(readings.filter(reading => driveable(reading) && !failedStart(reading)).length, 'stale duplicate', 'stale duplicates');
  if (parts.length <= 1) return parts[0] ?? 'no viewer tab';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Why the intent had to go out, when the tabs already there looked alive.
 *
 * Only an ended tab needs this sentence. A launch over frozen tabs is the case
 * the note has always described, and a second sentence claiming where the
 * wearer is now looking would be a claim this function cannot check.
 */
function launchedBecause(readings: readonly TabReading[]): string {
  const ended = readings.some(reading => reading.ended === 'share-ended');
  const other = readings.some(reading => reading.ended === 'other-share');
  const failed = readings.some(failedStart);
  if (!ended && !other && !failed) return '';
  return `${ended ? 'A tab whose share has ended still draws the spatial menu, but it cannot pair itself to the share that is open now'
    : other ? 'A tab left on another share cannot pair itself to the share that is open now'
      : 'A tab whose page failed to start, such as one asking to pair again, cannot load this share by itself'}, `
    + 'so the launch was sent rather than skipped and the wearer gets a fresh tab on this share.';
}

/**
 * Ask every candidate tab what it is, one short connection each.
 *
 * A tab that is frozen completes the websocket handshake and then answers
 * nothing, so `Runtime.evaluate` is given a short budget and its silence is
 * recorded as the answer rather than thrown. Nothing here closes or activates
 * a tab; the caller applies the plan.
 *
 * `expectedSessionId` is the inspection session this host is sharing right
 * now. It is optional and it stays optional: a caller that does not know which
 * session it is serving passes nothing and no tab is ever judged on it.
 */
export async function probeTabs(transport: DevtoolsTransport, { port, expectedOrigin, expectedSessionId, probeMs = 1_500 }:
  { port: number; expectedOrigin?: string; expectedSessionId?: string; probeMs?: number }): Promise<TabReading[]> {
  const listed = pageTargets(parseTargets(await transport.fetch(port, '/json')));
  const candidates = listed.filter(target => isStereofoldTarget(target, expectedOrigin)
    && (expectedOrigin === undefined || targetOrigin(target.url) === expectedOrigin));
  const readings: TabReading[] = [];
  for (const target of candidates) readings.push(await probeOneTab(transport, port, target, probeMs, expectedSessionId));
  return readings;
}

/**
 * Which of the two endings this page is at, from what it published about
 * itself.
 *
 * The startup flag is the page's own verdict, written beside the plate the
 * wearer is reading, so it is trusted first and on its own. The session id is
 * only ever read as a disagreement: a page that names no session, or a host
 * that names none, proves nothing and is left alone. Guessing there would
 * close the tab the wearer is in, which is a worse bug than the one this fixes.
 */
function endedTab(value: Record<string, unknown>, expectedSessionId?: string): TabEnded | undefined {
  if (value.startupFailure === SHARE_ENDED_STARTUP_FAILURE) return 'share-ended';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  if (sessionId && expectedSessionId && sessionId !== expectedSessionId) return 'other-share';
  return undefined;
}

async function probeOneTab(transport: DevtoolsTransport, port: number, target: DevtoolsTarget, probeMs: number,
  expectedSessionId?: string): Promise<TabReading> {
  const base = { id: target.id, url: target.url, title: target.title, answered: false, menu: false, menuRows: 0, presenting: false };
  let session;
  try { session = await transport.open(port, target.webSocketDebuggerUrl); }
  catch (error) { return { ...base, silence: `the debugger would not attach (${shortly(error)})` }; }
  try {
    await session.send('Runtime.enable', {}, probeMs);
    const outcome = readEvaluateResult(await session.send('Runtime.evaluate', evaluateParameters(TAB_LIVENESS_EXPRESSION), probeMs));
    if (!outcome.ok) return { ...base, silence: `the page threw (${outcome.reason})` };
    const value = (outcome.value ?? {}) as Record<string, unknown>;
    const ended = endedTab(value, expectedSessionId);
    // The page's own address says error page, and the
    // listing title says which one when the page answers without it.
    const errorPage = value.errorPage === true || /^privacy error$/iu.test(target.title);
    return {
      ...base,
      answered: true,
      menu: value.menu === true,
      menuRows: typeof value.menuRows === 'number' ? value.menuRows : 0,
      presenting: value.presenting === true,
      ...(typeof value.visibility === 'string' ? { visibility: value.visibility } : {}),
      ...(typeof value.pathname === 'string' ? { pathname: value.pathname } : {}),
      ...(typeof value.sessionId === 'string' && value.sessionId ? { sessionId: value.sessionId } : {}),
      ...(typeof value.startupFailure === 'string' && value.startupFailure ? { startupFailure: value.startupFailure } : {}),
      ...(errorPage ? { errorPage } : {}),
      ...(ended ? { ended } : {}),
    };
  } catch (error) {
    return { ...base, silence: isSilentTargetError(error) ? 'the tab is frozen and answered nothing' : `the probe failed (${shortly(error)})` };
  } finally {
    session.close();
  }
}

function shortly(error: unknown): string {
  return redactDevtoolsText(String(error instanceof Error ? error.message : error)).slice(0, 120);
}

/**
 * Probe, decide, close — the whole launch hygiene step in one call.
 *
 * The caller supplies the tunnel (`forward`) and the transport, because
 * resolving adb and choosing a serial is the host's business and opening a
 * socket is not something the pure decisions above should ever do. Every
 * failure downgrades to `probed: false`, which plans a plain launch and says
 * that older tabs may remain: a hygiene step is a convenience, and it must
 * never be the reason a wearer cannot get a page.
 */
export async function sweepLaunchTabs({ transport, port, expectedOrigin, expectedSessionId, forward, probeMs = 1_500 }: {
  transport: DevtoolsTransport; port: number; expectedOrigin?: string; expectedSessionId?: string;
  forward: () => Promise<boolean>; probeMs?: number;
}): Promise<LaunchHygienePlan & { readings: TabReading[]; probed: boolean; closed: string[]; strip: StripSweep }> {
  const unprobed = (reason: string): LaunchHygienePlan & { readings: TabReading[]; probed: boolean; closed: string[]; strip: StripSweep } => {
    const plan = planLaunchHygiene({ readings: [], probed: false });
    const strip: StripSweep = { enumerated: false, stranded: [], closed: [], reason };
    return { ...plan, note: `${plan.note} ${describeStripSweep(strip)}`, readings: [], probed: false, closed: [], strip };
  };
  let readings: TabReading[];
  try {
    if (!await forward()) return unprobed('the debugger port could not be forwarded');
    readings = await probeTabs(transport, { port, ...(expectedOrigin === undefined ? {} : { expectedOrigin }),
      ...(expectedSessionId === undefined ? {} : { expectedSessionId }), probeMs });
  } catch (error) {
    return unprobed(shortly(error));
  }
  const plan = planLaunchHygiene({ readings, probed: true });
  const closed: string[] = [];
  for (const id of plan.close) {
    try { await transport.fetch(port, `/json/close/${encodeURIComponent(id)}`); closed.push(id); }
    catch { /* A tab that will not close is left; the note below counts what did. */ }
  }
  // Say what actually happened, not what was planned: a tab that refused to
  // close is still open, and the wearer will see it.
  const listedNote = closed.length === plan.close.length ? plan.note
    : `${plan.note} ${plan.close.length - closed.length} of them would not close and may still be open.`;
  // The page list is not the tab strip. Closing everything the
  // debugger could name still left eleven entries in front of the wearer on
  // so the strip is swept separately and reported either way.
  const strip = await sweepStrandedTabs(transport, { port, ...(expectedOrigin === undefined ? {} : { expectedOrigin }) });
  return { ...plan, note: `${listedNote} ${describeStripSweep(strip)}`, readings, probed: true, closed, strip };
}

/**
 * The tabs the debugger cannot see.
 *
 * Measured on the Quest 2: eleven Stereofold
 * entries sat in the wearer's tab strip while `/json/list` on the forwarded
 * debugger port reported two pages. The sweep above closed both of the two and
 * honestly reported "one viewer tab left", and the wearer was still looking at
 * eleven, any one of which is a tap away from becoming a second viewer.
 *
 * The reason is not a bug in the sweep. `/json/list` enumerates targets that
 * have a live renderer, and Quest Browser — Chromium for Android — discards the
 * renderer of every tab that is not in front. The tab-strip entry survives; the
 * page behind it does not, so there is no page target to list, attach to, probe
 * or close.
 *
 * Chromium's browser-level endpoint does know about them. `Target.getTargets`
 * with a `{type: 'tab'}` filter answers with the tab targets, which are the
 * strip itself rather than the renderers inside it, and `Target.closeTarget`
 * takes a tab target id. That route is not present on every build: the tab
 * target type landed in Chromium 115, an older Quest Browser answers the same
 * call with an error or with page targets only, and a build that lists tab
 * targets may still refuse to close one.
 *
 * So nothing here assumes. The discovery is attempted, every outcome is named,
 * and the one outcome that must never be silent — strip entries found that
 * could not be closed — is counted and said in the tool text, with the wearer's
 * own one-tap cleanup in `docs/quest-operator-runbook.md`.
 */

/** Chromium's browser-level websocket, from `/json/version`. */
export function browserSocketUrl(body: string): string | undefined {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return undefined; }
  if (raw === null || typeof raw !== 'object') return undefined;
  const url = (raw as Record<string, unknown>).webSocketDebuggerUrl;
  return typeof url === 'string' && url ? url : undefined;
}

/** The `targetInfos` of a `Target.getTargets` reply, narrowed to what is read here. */
export function parseTargetInfos(raw: unknown): DevtoolsTarget[] {
  const result = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).result : undefined;
  const infos = result !== null && typeof result === 'object' ? (result as Record<string, unknown>).targetInfos : undefined;
  if (!Array.isArray(infos)) return [];
  return infos.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const id = String(record.targetId ?? '');
    if (!id) return [];
    return [{ id, type: String(record.type ?? ''), title: String(record.title ?? ''),
      url: String(record.url ?? ''), webSocketDebuggerUrl: '' }];
  });
}

/** One tab-strip entry with no live page behind it. */
export type StrandedTab = { id: string; url: string; title: string };

/**
 * Strip entries the page list does not account for.
 *
 * Counted per address rather than matched per entry, because the whole defect
 * is duplicates: eleven `/viewer` entries against two live pages is nine
 * stranded, and matching by URL alone would have called it one.
 *
 * Only this product's own addresses are ever counted. A wearer's unrelated tabs
 * are their own business and closing one would be the worse bug.
 */
export function strandedTabs({ tabs, listed, expectedOrigin }: {
  tabs: readonly DevtoolsTarget[]; listed: readonly DevtoolsTarget[]; expectedOrigin?: string;
}): StrandedTab[] {
  const ours = (url: string) => isStereofoldTargetUrl(url, expectedOrigin)
    && (expectedOrigin === undefined || targetOrigin(url) === expectedOrigin);
  // Keyed without the fragment: a booting viewer moves its page key out of the
  // address with `replaceState`, and a page listed just before that must
  // still account for its own strip entry listed just after, or the live tab
  // reads as stranded and is closed.
  const key = (url: string) => url.split('#')[0]!;
  const live = new Map<string, number>();
  for (const target of listed) if (ours(target.url)) live.set(key(target.url), (live.get(key(target.url)) ?? 0) + 1);
  const stranded: StrandedTab[] = [];
  for (const tab of tabs) {
    if (tab.type !== 'tab' || !ours(tab.url)) continue;
    const accounted = live.get(key(tab.url)) ?? 0;
    if (accounted > 0) { live.set(key(tab.url), accounted - 1); continue; }
    stranded.push({ id: tab.id, url: tab.url, title: tab.title });
  }
  return stranded;
}

/** What the strip sweep found and what it managed to do about it. */
export type StripSweep = {
  /** Whether the browser endpoint answered with tab targets at all. */
  enumerated: boolean;
  /** Strip entries with no live page behind them. */
  stranded: StrandedTab[];
  /** Which of those the browser actually closed. */
  closed: string[];
  /** Why nothing could be enumerated, when nothing could. */
  reason?: string;
};

/**
 * One sentence for the operator, which must be honest in all four cases:
 * nothing there, all closed, some left, and could not look.
 *
 * The "could not look" sentence never claims a count. A sweep that reports
 * zero stale tabs because it could not ask is exactly the answer that sent an
 * operator to the device believing the strip was clean.
 */
export function describeStripSweep(sweep: StripSweep): string {
  if (!sweep.enumerated) {
    return 'This headset browser does not let the debugger enumerate its tab strip'
      + `${sweep.reason ? ` (${sweep.reason})` : ''}, so discarded Stereofold tabs may still be sitting in it. `
      + 'Quest Browser keeps a discarded tab in the strip with no page behind it, and one tap on it opens a second viewer. '
      + 'Have the wearer clear them: Quest Browser menu, Tabs, then Close all tabs, and reopen from the Mac. '
      + 'See docs/quest-operator-runbook.md, "Clearing the tab strip".';
  }
  const found = sweep.stranded.length;
  if (!found) return 'The headset tab strip held no discarded Stereofold tabs behind the live one.';
  const left = found - sweep.closed.length;
  if (!left) return `Closed ${found} discarded Stereofold tab${found === 1 ? '' : 's'} that were still in the headset tab strip with no page behind them.`;
  return `${sweep.closed.length} of ${found} discarded Stereofold tab${found === 1 ? '' : 's'} in the headset tab strip closed; `
    + `${left} would not close and ${left === 1 ? 'is' : 'are'} still in the strip, one tap from opening a second viewer. `
    + 'Have the wearer clear them: Quest Browser menu, Tabs, then Close all tabs. '
    + 'See docs/quest-operator-runbook.md, "Clearing the tab strip".';
}

/**
 * Ask the browser endpoint for the tab strip, and close what the page list
 * does not account for.
 *
 * Every failure is an `enumerated: false` with a reason, never a throw: this
 * runs inside a launch, and a launch must not fail because a debugger route is
 * missing on this build. Nothing outside `keep` and the live page list is ever
 * closed, and a tab whose address is not this product's is never touched.
 */
export async function sweepStrandedTabs(transport: DevtoolsTransport, { port, expectedOrigin, timeoutMs = 2_000 }:
  { port: number; expectedOrigin?: string; timeoutMs?: number }): Promise<StripSweep> {
  let socketUrl: string | undefined;
  try { socketUrl = browserSocketUrl(await transport.fetch(port, '/json/version')); }
  catch (error) { return { enumerated: false, stranded: [], closed: [], reason: shortly(error) }; }
  if (!socketUrl) return { enumerated: false, stranded: [], closed: [], reason: 'the debugger named no browser endpoint' };
  let listed: DevtoolsTarget[];
  try { listed = pageTargets(parseTargets(await transport.fetch(port, '/json'))); }
  catch (error) { return { enumerated: false, stranded: [], closed: [], reason: shortly(error) }; }
  let session;
  try { session = await transport.open(port, socketUrl); }
  catch (error) { return { enumerated: false, stranded: [], closed: [], reason: shortly(error) }; }
  try {
    let tabs: DevtoolsTarget[];
    try { tabs = parseTargetInfos(await session.send('Target.getTargets', { filter: [{ type: 'tab' }] }, timeoutMs)); }
    catch (error) { return { enumerated: false, stranded: [], closed: [], reason: shortly(error) }; }
    // A build with no tab-target type answers the same call with its page
    // targets, which are exactly the ones `/json/list` already showed. That is
    // not an empty strip; it is a build that cannot show one.
    if (!tabs.some(target => target.type === 'tab')) {
      return { enumerated: false, stranded: [], closed: [],
        reason: 'this build lists no tab targets, only the renderers the page list already shows' };
    }
    const stranded = strandedTabs({ tabs, listed, ...(expectedOrigin === undefined ? {} : { expectedOrigin }) });
    const closed: string[] = [];
    for (const tab of stranded) {
      try {
        const reply = await session.send('Target.closeTarget', { targetId: tab.id }, timeoutMs) as Record<string, unknown>;
        const result = reply?.result as Record<string, unknown> | undefined;
        // Chromium answers `{success: true}` on the builds that have the field
        // and `{}` on the ones that do not; only an explicit false is a refusal.
        if (result?.success !== false) closed.push(tab.id);
      } catch { /* Counted as left behind by describeStripSweep. */ }
    }
    return { enumerated: true, stranded, closed };
  } finally { session.close(); }
}

/** What the sweep after a cold start found and did. */
export type RestoredSweep = {
  /** Whether the restarted browser's debugger answered at all. */
  answered: boolean;
  /** The tab the intent opened, when it could be told apart. */
  keep?: string;
  /** Every page on this share's origin that the browser listed. */
  listed: string[];
  closed: string[];
  /** The strip sweep, when the new tab had reached the viewer. */
  strip?: StripSweep;
  note: string;
};

const COLD_START = 'Quest Browser was not running, so this launch started it.';

/**
 * After an intent that started Quest Browser cold: close the tabs it reopened
 * from its last session, and keep the one the intent opened.
 *
 * Before that intent there was no browser to ask, so the sweep ahead of the
 * launch could close nothing, and a cold start restores the last session
 * behind the new tab. In one headset run, two viewer tabs from three days
 * earlier came back asking to pair again.
 *
 * No page is asked anything: nobody may be wearing the headset, and Quest
 * Browser freezes every tab that is not in front. The browser's own list
 * decides. Quest Browser numbers tabs in creation order, and Chromium restores
 * a tab under the number it was saved with and numbers new tabs above every
 * saved one, so the tab the intent opened is the highest. Only this share's
 * origin is touched, and nothing is closed when the numbers cannot be
 * compared or the list has not settled.
 *
 * The strip is swept only once the new tab is on the viewer. Before that it
 * is on the pairing route, and a page listed there while its strip entry is
 * listed on the viewer would read as stranded.
 */
export async function sweepRestoredTabs({ transport, port, expectedOrigin, forward, attempts = 10, pollMs = 1_000,
  pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }) }: {
  transport: DevtoolsTransport; port: number; expectedOrigin: string; forward: () => Promise<boolean>;
  attempts?: number; pollMs?: number; pause?: (ms: number) => Promise<void>;
}): Promise<RestoredSweep> {
  const nothing = (answered: boolean, note: string): RestoredSweep => ({ answered, listed: [], closed: [], note: `${COLD_START} ${note}` });
  if (!await forward().catch(() => false)) return nothing(false, 'Its debugger port could not be forwarded, so any tabs it reopened are still open behind the new one.');
  let answered = false, settled = false;
  let ours: DevtoolsTarget[] = [];
  let previous = '';
  for (let attempt = 0; attempt < attempts && !settled; attempt += 1) {
    if (attempt) await pause(pollMs);
    try { ours = pageTargets(parseTargets(await transport.fetch(port, '/json'))).filter(target => targetOrigin(target.url) === expectedOrigin); }
    catch { continue; }
    answered = true;
    // The same tabs twice in a row: the restart has finished adding them.
    const seen = ours.map(target => target.id).sort().join(',');
    settled = ours.length > 0 && seen === previous;
    previous = seen;
  }
  const seconds = Math.round(attempts * pollMs / 1000);
  if (!answered) return nothing(false, `Its debugger did not answer within ${seconds} s, so any tabs it reopened are still open behind the new one.`);
  if (!settled) return { ...nothing(true, `Its tab list did not settle within ${seconds} s, so nothing was closed.`), listed: ours.map(target => target.id) };
  const listed = ours.map(target => target.id);
  if (!ours.every(target => /^\d+$/u.test(target.id))) {
    return { ...nothing(true, 'Its tab ids are not numbers, so the new tab could not be told from the reopened ones and nothing was closed.'), listed };
  }
  const keep = ours.reduce((best, target) => Number(target.id) > Number(best.id) ? target : best);
  const closed: string[] = [];
  for (const target of ours) {
    if (target.id === keep.id) continue;
    try { await transport.fetch(port, `/json/close/${encodeURIComponent(target.id)}`); closed.push(target.id); }
    catch { /* Counted below as still open. */ }
  }
  const reopened = ours.length - 1;
  const pages = !reopened ? 'It reopened no other tab on this share.'
    : `It reopened ${reopened} older tab${reopened === 1 ? '' : 's'} on this share; this Mac closed ${closed.length} and kept tab ${keep.id}, the one this launch opened.`;
  if (!isStereofoldTargetUrl(keep.url, expectedOrigin)) {
    return { answered, keep: keep.id, listed, closed,
      note: `${COLD_START} ${pages} The new tab was still pairing, so its tab strip was left for the next launch to sweep.` };
  }
  const strip = await sweepStrandedTabs(transport, { port, expectedOrigin });
  return { answered, keep: keep.id, listed, closed, strip, note: `${COLD_START} ${pages} ${describeStripSweep(strip)}` };
}
