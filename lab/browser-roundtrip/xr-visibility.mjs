/**
 * What the page does when the headset stops showing it the session.
 *
 * An `XRSession` carries its own `visibilityState`, separate from the
 * document's. The three values are `visible`, `visible-blurred` (the session
 * is drawn but something else — the system menu, a guardian prompt — owns
 * input) and `hidden` (nothing is drawn and `requestAnimationFrame` stops).
 * The document stays `visible` through all of them, so
 * `document.visibilitychange` never fires and, until this module existed,
 * nothing on the page noticed.
 *
 * That mattered on the Quest 2 in three concrete ways, all of them reachable
 * by setting the headset down on a table mid-session:
 *
 *   - a held A or X kept its microphone open, so the Mac transcribed a room
 *     the wearer had walked away from and an agent could act on it;
 *   - the `poll_inspection` heartbeat kept answering `ready`, so the agent
 *     kept sending scene commands to a panel nobody could see; and
 *   - tour autoplay kept advancing scenes into an unwatched headset.
 *
 * The decisions live here, free of any session object, so they can be tested
 * without a runtime. `watchSessionVisibility` is the only part that touches
 * WebXR, and it does nothing but read `session.visibilityState` and hand the
 * transition to a caller.
 *
 * One deliberate asymmetry: `visible-blurred` is treated exactly like
 * `hidden`. A blurred session still draws, so the wearer can see the scene
 * behind the system menu, but the runtime withholds input and the wearer's
 * attention is on the menu, not the molecule. Recording them or driving a
 * tour at them is the same mistake in both states.
 *
 * Quest is reported not to fire this promptly on a plain doff — the state is
 * tied to the OpenXR session rather than the proximity sensor — so this is a
 * floor, not a complete answer. A pose-delta idle timeout would be the other
 * half and is not implemented here.
 */

/** Every value WebXR defines for `XRSession.visibilityState`. */
export const XR_VISIBILITY_STATES = Object.freeze(['visible', 'visible-blurred', 'hidden']);

/** The diagnostic kind each transition records on the headset log. */
export const XR_VISIBILITY_DIAGNOSTIC = 'xr-visibility';

/**
 * Read a session's visibility as one of the three defined values.
 *
 * Anything unrecognised — a runtime that does not implement the attribute, an
 * emulator that leaves it undefined — reads as `visible`. Treating an unknown
 * runtime as blind would pause every tour and refuse every agent command on
 * hardware that is working perfectly well.
 */
export function normalizeSessionVisibility(value) {
  return XR_VISIBILITY_STATES.includes(value) ? value : 'visible';
}

/** True when the wearer is not looking at a session that accepts their input. */
export function blindVisibility(value) {
  return normalizeSessionVisibility(value) !== 'visible';
}

/**
 * Decide what one visibility transition costs.
 *
 * @param {object} input
 * @param {string} input.from previous visibility, normalized on the way in
 * @param {string} input.to new visibility
 * @param {boolean} [input.talking] a push-to-talk press is open right now
 * @param {boolean} [input.autoplay] tour autoplay is running right now
 * @param {boolean} [input.resumeOnVisible] autoplay was paused by an earlier
 *   blind transition and is owed a resume
 * @param {boolean} [input.tourActive] a tour is selected and on a scene
 * @returns {{from:string,to:string,changed:boolean,blind:boolean,
 *   cancelTalk:boolean,tourAction:'pause'|'resume'|'none',
 *   resumeOnVisible:boolean,
 *   diagnostic:{kind:string,detail:object}}}
 */
export function sessionVisibilityTransition({ from, to, talking = false, autoplay = false,
  resumeOnVisible = false, tourActive = false } = {}) {
  const previous = normalizeSessionVisibility(from);
  const next = normalizeSessionVisibility(to);
  const blind = blindVisibility(next);
  const changed = previous !== next;
  // A press is cancelled on the edge into blindness and on any later blind
  // transition too: `hidden` can follow `visible-blurred` while the same hold
  // is still open, and the second edge is the one that must not be missed.
  const cancelTalk = blind && talking;
  let tourAction = 'none';
  let owedResume = resumeOnVisible;
  if (blind) {
    if (autoplay) { tourAction = 'pause'; owedResume = true; }
  } else if (!resumeOnVisible) owedResume = false;
  // The wearer came back to a tour that is no longer on a scene, or to one
  // already running. Either way the owed resume is spent: replaying it would
  // restart scene work nobody asked for.
  else if (!tourActive || autoplay) owedResume = false;
  else { tourAction = 'resume'; owedResume = false; }
  return { from: previous, to: next, changed, blind, cancelTalk, tourAction, resumeOnVisible: owedResume,
    diagnostic: { kind: XR_VISIBILITY_DIAGNOSTIC,
      detail: { from: previous, to: next, blind, cancelTalk, tour: tourAction } } };
}

/**
 * Decide whether an owed autoplay resume can be spent right now.
 *
 * `sessionVisibilityTransition` says a resume is owed. It cannot say whether
 * the tour player will accept one: `togglePlay` begins with
 * `if (navigating) return serial`, so a resume that lands while a scene visit
 * is still settling is swallowed and autoplay stays off for the rest of the
 * lesson. The reachable case is the Quest universal menu opened and closed
 * inside a few hundred milliseconds while a scene was mid-transition — the
 * wearer comes back to a tour that simply stopped.
 *
 * So the intent is held rather than consumed. `keepIntent` means "ask me
 * again": the caller re-runs this from the tour player's own subscription,
 * which fires on every state change including the one where `navigating`
 * goes false.
 *
 * @param {object} input
 * @param {boolean} [input.wantsResume] an owed resume is outstanding
 * @param {boolean} [input.visible] the session is showing the wearer the page
 * @param {boolean} [input.navigating] the tour is rendering a scene right now
 * @param {boolean} [input.autoplay] autoplay is already running
 * @param {boolean} [input.active] a tour is selected and on a scene
 * @returns {{call:boolean,keepIntent:boolean,reason:string}}
 */
export function resumeAttempt({ wantsResume = false, visible = true, navigating = false,
  autoplay = false, active = false } = {}) {
  if (!wantsResume) return { call: false, keepIntent: false, reason: 'none-owed' };
  // Still blind. The intent belongs to the next visible edge, not to this.
  if (!visible) return { call: false, keepIntent: true, reason: 'blind' };
  // A scene is settling. Deciding now would spend the resume on a call the
  // player discards, so defer to the state change that clears `navigating`.
  if (navigating) return { call: false, keepIntent: true, reason: 'navigating' };
  // Already running: either the wearer pressed Play or an earlier attempt
  // landed. Replaying the intent would toggle autoplay back off.
  if (autoplay) return { call: false, keepIntent: false, reason: 'already-playing' };
  // The tour is no longer on a scene. `togglePlay` on an inactive tour starts
  // a lesson from the beginning, which is not what a doff-and-redon asked for.
  if (!active) return { call: false, keepIntent: false, reason: 'inactive' };
  return { call: true, keepIntent: false, reason: 'resume' };
}

/**
 * Hold one session's owed autoplay resume until the tour player accepts it.
 *
 * The holder is the immersive session, which creates one of these per XR
 * session and disposes it with that session. It keeps a single subscription to
 * the tour player's own state channel — the same `subscribe` the menu already
 * uses to refresh its rows — and spends the intent on the first state change
 * that leaves `navigating` false.
 *
 * @param {object} input
 * @param {()=>{getState?:Function,togglePlay?:Function,subscribe?:Function}|undefined} input.getTour
 * @param {()=>boolean} input.isVisible the session is showing the wearer the page
 * @param {()=>boolean} input.isCurrent this session is still the live one
 * @param {(detail:object)=>unknown} [input.onDiagnostic] one headset-log line per attempt
 */
export function createTourResumeIntent({ getTour = () => undefined, isVisible = () => true,
  isCurrent = () => true, onDiagnostic = () => {} } = {}) {
  let owed = false;
  let detach;
  const tour = () => { try { return getTour(); } catch { return undefined; } };
  const stateOf = controller => { try { return controller?.getState?.(); } catch { return undefined; } };

  const watch = () => {
    if (detach || !isCurrent()) return;
    let unsubscribe;
    try {
      unsubscribe = tour()?.subscribe?.(() => {
        // The player syncs on every decision it makes, including the one that
        // ends a scene visit. Only a visible session with an intent acts.
        if (owed && isCurrent() && isVisible()) attempt('tour-state');
      });
    } catch { /* No subscription means no late retry; the next visible edge still asks. */ }
    if (typeof unsubscribe === 'function') detach = unsubscribe;
  };

  function attempt(source = 'visible-edge') {
    if (!isCurrent()) return { call: false, keepIntent: owed, reason: 'session-gone' };
    const controller = tour(), state = stateOf(controller);
    const decision = resumeAttempt({
      wantsResume: owed,
      visible: isVisible() === true,
      navigating: state?.navigating === true,
      autoplay: state?.autoplay === true,
      active: state?.active === true,
    });
    // The intent is cleared before the call, so the sync `togglePlay` triggers
    // cannot re-enter this through the subscription above.
    owed = decision.keepIntent;
    if (owed) watch();
    if (decision.call) {
      // `togglePlay` is the same resume the Play row and the agent's
      // `control_tour play` use, so a resumed tour is on one code path.
      try { void Promise.resolve(controller?.togglePlay?.()).catch(() => {}); }
      catch { /* The tour controller is optional; visibility handling is not. */ }
    }
    if (decision.reason !== 'none-owed') {
      try { onDiagnostic({ stage: 'resume', source, outcome: decision.reason, called: decision.call, owed }); }
      catch { /* The page may have no diagnostics hook installed. */ }
    }
    return decision;
  }

  return Object.freeze({
    owed: () => owed,
    navigating: () => stateOf(tour())?.navigating === true,
    /** Record that autoplay is owed a resume, and arm the late retry. */
    set(next) { owed = next === true; if (owed) watch(); },
    attempt,
    dispose() {
      owed = false;
      const stop = detach; detach = undefined;
      if (stop) { try { stop(); } catch { /* The player may already be gone. */ } }
    },
  });
}

/**
 * Watch one session's visibility and report every transition.
 *
 * The listener is called for the initial reading only when the session starts
 * somewhere other than `visible`, which a session entered from an already
 * backgrounded page can do. Every later `visibilitychange` is reported whether
 * or not the value actually moved, because a runtime that re-fires the same
 * state while a press is open still wants the press cancelled.
 *
 * @param {XRSession} session
 * @param {(transition:ReturnType<typeof sessionVisibilityTransition>)=>unknown} onTransition
 * @param {object} [options]
 * @param {()=>object} [options.context] live `talking`/`autoplay`/`tourActive` readings
 * @returns {{state:()=>string, blind:()=>boolean, stop:()=>void}}
 */
export function watchSessionVisibility(session, onTransition, { context = () => ({}) } = {}) {
  if (!session || typeof session.addEventListener !== 'function') {
    throw new TypeError('A visibility watch needs a live XR session.');
  }
  let current = normalizeSessionVisibility(session.visibilityState);
  let stopped = false;

  const report = to => {
    const previous = current;
    let live = {};
    try { live = context() ?? {}; }
    catch { /* A caller mid-teardown must not block the cancel below. */ }
    const transition = sessionVisibilityTransition({ ...live, from: previous, to });
    current = transition.to;
    try { onTransition(transition); }
    catch { /* A visibility handler is advisory; never break the session on it. */ }
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    report(session.visibilityState);
  };
  session.addEventListener('visibilitychange', onVisibilityChange);
  // A session granted while the page was already backgrounded starts blind.
  if (current !== 'visible') report(current);

  return {
    state: () => current,
    blind: () => blindVisibility(current),
    stop() {
      if (stopped) return;
      stopped = true;
      try { session.removeEventListener('visibilitychange', onVisibilityChange); }
      catch { /* The UA may have detached the session already. */ }
    },
  };
}
