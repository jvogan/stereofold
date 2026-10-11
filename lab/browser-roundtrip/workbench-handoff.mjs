/**
 * The seconds between "Open in Mol*" and Quest Browser.
 *
 * Pressing the row used to do nothing the wearer could perceive. The host
 * round trip runs first, and a first `open_detailed_view` reads the whole
 * multi-megabyte Mol* bundle (`inspection-companion-client.ts` gives it a 55 s
 * timeout), so the scene simply sat there. Then a caption was set and the
 * session ended on the next tick, which tore down the presentation layer that
 * caption draws into, so it was never read either. Immersion dropped away with
 * no explanation and the 2D page arrived seconds later: the viewer did open,
 * but the wait was unexplained and needed a line of text to cover it.
 *
 * The transfer is therefore announced at the press and held before the
 * teardown. `announceWorkbenchTransfer` puts the caption up and says the same
 * sentence through the Mac's voice, which is the only channel a Quest 2 has
 * (the headset browser reports zero `speechSynthesis` voices; `reply-audio.mjs`
 * explains that). `beginWorkbenchHandoff` then keeps the wearer in the scene
 * until the announcement has had `WORKBENCH_HANDOFF_HOLD_MS` to land, and only
 * then ends the session and navigates.
 *
 * Three properties this module exists to keep testable without a headset:
 *
 * - Bounded. The hold is a deadline measured from the announcement, never a
 *   wait on speech. A Mac slow to render the clip, or a page with no speaker
 *   at all, delays nothing; a host round trip that already outlasted the
 *   deadline adds no further wait.
 * - Cancel-safe. `cancel()` before the timer fires stops the navigation and
 *   leaves the session alone, so a press that is overtaken never sends a page
 *   that has moved on to the viewer.
 * - Outside the action chain. The session teardown runs from the timer, not
 *   from the toolbar action that started it. `toolbar.dispose()` joins the
 *   action chain, so ending the session from inside that chain deadlocks
 *   disposal. The timer is what keeps that true.
 */

/**
 * Which side of the link opens Mol*, decided once.
 *
 * The press used to answer that with a live `fetch('/detailed')` on every
 * press, and read every non-200 as "this host cannot serve the viewer here",
 * which silently opened Mol* on a Mac monitor the wearer cannot see. A blur, a
 * busy listener or a LAN hiccup was enough. In the headset that reads as the
 * press having done nothing at all.
 *
 * Three answers, not two:
 * - `here`      this origin serves the viewer; the wearer stays in the headset.
 * - `mac`       this host genuinely does not serve it, or the wearer asked for
 *               the Mac by name. The monitor is the right answer.
 * - `unreachable` the question could not be asked. Say so and let the next
 *               press ask again; never downgrade a headset press on a guess.
 *
 * A host new enough to advertise `detailedViewAvailable` in its inspection
 * state answers the question without any fetch at all. The probe remains for
 * hosts too old to carry the field, and one success is cached for the session.
 */

/** What the wearer reads when the Mol* page could not be reached to ask. */
export const DETAILED_VIEW_UNREACHABLE_CAPTION = 'Mol* page unreachable. Trying again.';

/**
 * Read one probe answer as served here, genuinely absent, or unreachable.
 *
 * `404` is the only status that means "this host does not have that route":
 * the LAN listener and the companion both answer exactly that for a path they
 * do not serve. `409 viewer_unavailable`, a 5xx and a thrown request are all
 * "ask again later", because the route exists and something else went wrong.
 *
 * @param {{ok?: boolean, status?: number, contentType?: string, failed?: boolean}|undefined} outcome
 * @returns {'here'|'absent'|'unreachable'}
 */
export function classifyDetailedViewProbe(outcome) {
  if (!outcome || outcome.failed === true) return 'unreachable';
  if (outcome.ok === true) {
    return String(outcome.contentType ?? '').toLowerCase().startsWith('text/html') ? 'here' : 'absent';
  }
  return Number(outcome.status) === 404 ? 'absent' : 'unreachable';
}

/**
 * Where "Open in Mol*" should send the wearer, for the life of this page.
 *
 * @param {object} [options]
 * @param {() => Promise<{ok?: boolean, status?: number, contentType?: string, failed?: boolean}>} [options.probe]
 * @returns {{note: (state: unknown) => void, known: () => boolean|undefined,
 *   resolve: (press?: {target?: string}) => Promise<'here'|'mac'|'unreachable'>}}
 */
export function createDetailedViewAvailability({ probe } = {}) {
  /** What the host said about itself, if it is new enough to say anything. */
  let advertised;
  /** A probe that answered `here` once. Success only: a failure is not a fact. */
  let confirmed = false;
  /** Presses overlap while the first probe is in flight; they share it. */
  let pending;

  async function askOnce() {
    let outcome;
    try { outcome = await probe?.(); }
    catch { outcome = { failed: true }; }
    const verdict = classifyDetailedViewProbe(outcome);
    if (verdict === 'here') confirmed = true;
    return verdict;
  }

  return {
    /** Record `detailedViewAvailable` from any host answer that carries it. */
    note(state) {
      const value = state && typeof state === 'object' ? state.detailedViewAvailable : undefined;
      if (typeof value === 'boolean') advertised = value;
    },
    /** True/false once the answer is settled without a probe, else undefined. */
    known: () => (confirmed ? true : advertised),
    async resolve(press = {}) {
      // The one phrase that means a monitor rather than the headset. It asks
      // nothing of this origin and teaches the page nothing about it.
      if (press.target === 'mac') return 'mac';
      if (confirmed || advertised === true) return 'here';
      if (advertised === false) return 'mac';
      if (typeof probe !== 'function') return 'unreachable';
      if (!pending) pending = askOnce().finally(() => { pending = undefined; });
      const verdict = await pending;
      return verdict === 'absent' ? 'mac' : verdict;
    },
  };
}

/** How long the announcement gets in front of the wearer before the teardown. */
export const WORKBENCH_HANDOFF_HOLD_MS = 1500;

/**
 * What the wearer reads while the transfer runs.
 *
 * It names the way home in the same breath as the way
 * out. "Transferring to Mol*…" told the wearer a page was coming and nothing
 * about how to leave it, and a device test found a wearer in
 * the flat viewer with no idea that saying one word brings the headset back.
 * The full viewer is what the person asked for, so it is called that rather
 * than by the library's name.
 */
export const WORKBENCH_TRANSFER_CAPTION = 'Opening the full viewer. Say return when done.';

/** The same sentence out loud. Kept to the settled short-reply length. */
export const WORKBENCH_TRANSFER_SPOKEN = 'Opening the full viewer. Say return when done.';

/**
 * What the wearer reads when the headset view refused to close.
 *
 * What to do when the immersive session will not close.
 * Quest Browser draws a 2D page over a live immersive session as a flat panel
 * behind the system banner "The immersive web experience is still running in
 * the background", with Resume, Quit and the Quest home tiles beside it, which
 * looks like a crash. So a teardown that did not
 * finish is a reason to stay in the scene, never a reason to navigate anyway.
 */
export const WORKBENCH_HANDOFF_STAYED_CAPTION = 'The headset view would not close. Staying here.';

const ignore = () => {};

/** Best-effort narration: a rejected or missing speaker never fails a press. */
function sayQuietly(speak, spoken) {
  try {
    const pending = speak?.(spoken);
    if (pending && typeof pending.catch === 'function') pending.catch(ignore);
    return true;
  } catch { return false; }
}

/**
 * Tell the wearer the transfer has started, before the host is asked.
 *
 * Both halves are best-effort: a page with no presentation layer still
 * transfers, and a page that registered no speaker still shows the caption.
 *
 * @param {object} options
 * @param {(caption: string) => void} [options.showCaption]
 * @param {(spoken: string) => unknown} [options.speak]
 * @param {string} [options.caption]
 * @param {string} [options.spoken]
 * @param {() => number} [options.now]
 * @returns {{at: number, caption: string, spoken: string, captioned: boolean, said: boolean}}
 */
export function announceWorkbenchTransfer({
  showCaption,
  speak,
  caption = WORKBENCH_TRANSFER_CAPTION,
  spoken = WORKBENCH_TRANSFER_SPOKEN,
  now = Date.now,
} = {}) {
  let captioned = false;
  try { showCaption?.(caption); captioned = true; }
  catch { /* The layer can leave with the session. */ }
  const said = sayQuietly(speak, spoken);
  return { at: now(), caption, spoken, captioned, said };
}

/**
 * What is left of the hold once the host round trip has already run.
 *
 * Never negative and never longer than the whole hold, so a clock that jumps
 * backwards cannot strand the wearer in the scene.
 */
export function workbenchHoldRemaining(announcedAt, at, holdMs = WORKBENCH_HANDOFF_HOLD_MS) {
  const full = Math.max(0, holdMs);
  if (!Number.isFinite(announcedAt) || !Number.isFinite(at)) return full;
  const elapsed = at - announcedAt;
  if (!(elapsed > 0)) return full;
  return Math.max(0, Math.min(full, full - elapsed));
}

/**
 * Hold what is left of the announcement, end the session, and navigate only
 * once the session is confirmed gone.
 *
 * The confirmation is the whole point of this rewrite.
 * The first version ended the session, swallowed whatever the teardown said
 * and navigated regardless, on the reasoning that a session already gone is no
 * reason to strand the wearer. That is true of an *already-gone* session and
 * false of a teardown that failed: `immersive-session.mjs` resolves `end()`
 * quietly for a session that was never there and rejects when the renderer or
 * the native session would not close, so a rejection is exactly the case where
 * navigating puts a 2D page over a live session — the background-session
 * banner the wearer reads as a crash. `confirmEnded` is the second reading,
 * taken from the renderer itself after the teardown resolves, for a teardown
 * that reports success while the headset is still presenting.
 *
 * Four terminal states, not two: `navigated`, `stayed` (the session is still
 * up, so the wearer keeps the scene and is told), and `cancelled`.
 *
 * Every collaborator is injected so the sequence runs under `node --test`
 * against plain functions and mocked timers.
 *
 * @param {object} options
 * @param {() => unknown} [options.endSession] ends the immersive session
 * @param {() => boolean|undefined} [options.confirmEnded] false while still presenting
 * @param {() => void} options.navigate sends this tab to the Mol* page
 * @param {number} [options.announcedAt] when the caption and line went out
 * @param {number} [options.holdMs]
 * @param {(caption: string) => void} [options.showCaption] refreshes the caption
 * @param {string} [options.caption]
 * @param {string} [options.stayedCaption] what a refused teardown says
 * @param {(caption: string, reason?: string) => void} [options.onStayed]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 * @returns {{cancel: () => boolean, settled: Promise<'navigated'|'stayed'|'cancelled'>,
 *   state: () => string, holdMs: number, reason: () => string|undefined}}
 */
export function beginWorkbenchHandoff({
  endSession,
  confirmEnded,
  navigate,
  announcedAt,
  holdMs = WORKBENCH_HANDOFF_HOLD_MS,
  showCaption,
  caption = WORKBENCH_TRANSFER_CAPTION,
  stayedCaption = WORKBENCH_HANDOFF_STAYED_CAPTION,
  onStayed,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof navigate !== 'function') throw Error('A workbench handoff needs somewhere to navigate.');
  let status = 'holding';
  let refusal;
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  // Captions expire by themselves, so the one raised before the host round
  // trip is refreshed here to carry the wearer through the teardown.
  try { showCaption?.(caption); } catch { /* The layer can leave with the session. */ }

  const remaining = workbenchHoldRemaining(announcedAt, now(), holdMs);
  const stay = () => {
    status = 'stayed';
    try { showCaption?.(stayedCaption); } catch { /* The layer can leave with the session. */ }
    try { onStayed?.(stayedCaption, refusal); } catch { /* Reporting is not the mechanism. */ }
    resolveSettled('stayed');
  };
  const finish = () => {
    if (status !== 'holding') return;
    status = 'leaving';
    // The teardown is deliberately outside the toolbar action chain: see the
    // module comment. `toolbar.dispose()` joins that chain, so ending the
    // session from inside it deadlocks disposal.
    void Promise.resolve().then(() => endSession?.()).then(
      () => {
        // A probe that cannot answer answers `undefined`, which is not `false`
        // and so is not taken as "still presenting". Only a definite no stays.
        try { return confirmEnded?.() !== false; }
        catch (error) { refusal = error?.message; return false; }
      },
      error => { refusal = error?.message ?? 'The headset session would not close.'; return false; },
    ).then(ended => {
      if (status !== 'leaving') return;
      if (!ended) return stay();
      status = 'navigated';
      try { navigate(); } finally { resolveSettled('navigated'); }
    }).catch(ignore);
  };
  const timer = setTimer(finish, remaining);

  return {
    /** True when this press was still holding and has now been called off. */
    cancel() {
      if (status !== 'holding') return false;
      status = 'cancelled';
      try { clearTimer(timer); } catch { /* An already-fired timer is inert. */ }
      resolveSettled('cancelled');
      return true;
    },
    settled,
    state: () => status,
    holdMs: remaining,
    /** Why the wearer stayed, where the teardown said anything. */
    reason: () => refusal,
  };
}
