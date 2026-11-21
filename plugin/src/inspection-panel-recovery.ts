/**
 * How a panel with no reachable button gets itself back to `ready`.
 *
 * A headset panel draws the inspector inside an immersive session. Its DOM
 * notice, its Retry save button and its Load saved view button are on a flat
 * page the wearer cannot see or click. A Quest 2 panel answered
 * `unsaved` for eight minutes after one rejected `control_tour play`, because
 * every recovery path the panel had was one of those buttons. These decisions
 * are here rather than inline in `inspector.ts` so a test can hold them.
 *
 * None of this weakens the optimistic-save protocol. The server still answers
 * `conflict` to a stale panel and still reserves the revision for a pending
 * command; only the panel's own response to those answers changes.
 */

export type PanelAvailability = 'ready' | 'busy' | 'unsaved';

/**
 * `unsaved` is scene work the server does not have. Everything transient is
 * `busy`: `InspectionCommands.poll` waits for a busy panel and cancels a
 * command aimed at an unsaved one (`inspection-commands.ts:145`).
 */
export function panelAvailability(input: {
  blocked: boolean; dirty: boolean; ready: boolean; interactionActive: boolean; navigating: boolean;
  /**
   * The XR session stopped being visible — the headset came off,
   * or the system menu took over. The panel is perfectly healthy and its
   * scene is saved, so this is not `unsaved`; it is the same transient "not
   * now" as a drag in progress. A blind panel that kept answering `ready`
   * let an agent drive a tour at a headset lying on a table.
   */
  blind?: boolean;
  /**
   * A lesson is presenting itself in this panel right now.
   *
   * A chapter's camera turn is a transient the viewer pins, so an autoplaying
   * lesson no longer dirties the scene tick by tick. What is left is the one
   * save per chapter that commits the turn, plus the chapter's own scene work
   * — a few hundred milliseconds each, during which the panel used to answer
   * `unsaved` and every agent command was refused outright ("No panel is ready
   * for a command right now (companion unsaved)"). That window is not scene
   * work the wearer did; it is the lesson pushing its own presentation, and
   * the panel will have pushed it within a beat. `busy` says exactly that:
   * `enqueue` admits the command and `poll` holds it until the panel answers
   * `ready`, inside the server's own 15 s delivery deadline.
   *
   * Only while a lesson is actually autoplaying. A paused lesson is real
   * unsaved work again.
   */
  presenting?: boolean;
  /**
   * The unsaved work only moved the structure or the camera.
   *
   * The wearer grabbed it, nudged it with a stick, or the page seated it on
   * VR entry. That save commits within a beat, even while a command waits
   * (`canSettleLocalSave`), and the waiting command follows it. Reported as
   * `unsaved`, it turned Claude's queued `control_tour start` into
   * "The target panel has newer or unsaved local work." every time the wearer
   * touched the molecule. `busy` holds the command for the save instead.
   * The caller decides this with `sameEntryScene`; a blocked panel is still
   * `unsaved`, whatever moved.
   */
  placementOnly?: boolean;
}): PanelAvailability {
  if (input.blocked) return 'unsaved';
  if (input.dirty) return input.presenting || input.placementOnly ? 'busy' : 'unsaved';
  if (!input.ready || input.interactionActive || input.navigating || input.blind) return 'busy';
  return 'ready';
}

/**
 * Whether a panel follows a transition it is holding unsaved
 * work against.
 *
 * The rule used to be the same for both halves of a transition: a panel
 * hydrated only once it was clean. For an experience revision that is right —
 * the source token is still current, so `sync_inspection` still commits and
 * the next beat hydrates a beat later with the wearer's work kept.
 *
 * For a SOURCE change it is a deadlock with no exit, and it is the one that
 * wedged the hardware grow. A scene captured against a source the
 * host has retired can never be saved: `sync_inspection` answers `conflict`
 * for a stale source token, and over the companion route the request never
 * even reaches that handler — `dispatch` in `inspection-server.ts` refuses it
 * outright with "This action belongs to a different structure." So the panel
 * saw a thrown error rather than a `conflict`, and `saveFailureRecovery`
 * below never answers `reload` to an `error` on a companion. `dirty` could
 * therefore never clear, the hydrate that would have cleared it was gated on
 * `dirty`, and the wearer was left inside the old tier with every post
 * refused 409 until the host was restarted.
 *
 * An authorized source replacement also retires the outgoing interaction and
 * any failure notice. Hydration cancels input before touching the menu or scene.
 * Same-source experience updates still preserve local work and interaction.
 */
export function followsSourceTransition(input: {
  sourceChanged: boolean; experienceChanged: boolean;
  dirty: boolean; blocked: boolean; interactionActive: boolean;
}): boolean {
  if (!input.sourceChanged && !input.experienceChanged) return false;
  if (input.sourceChanged) return true;
  return !input.blocked && !input.interactionActive && !input.dirty;
}

export type SaveRecovery = { action: 'retry'; delayMs: number } | { action: 'reload' } | { action: 'block' };

/** The panel re-asks while the server holds the revision for a command. */
export const SAVE_BUSY_RETRY_MS = 500;
/**
 * A rendering claim gets 120 s (`inspection-commands.ts:151`). A busy answer
 * that outlives that deadline is not a command in flight any more.
 */
export const SAVE_BUSY_MAX_ATTEMPTS = 240;
/**
 * The cadence a headset panel drops to once the rendering deadline has passed.
 *
 * A desktop panel blocks there and shows Retry save. A companion has no
 * reachable button, so blocking is the eight-minute wedge in another costume:
 * it answers `unsaved`, `enqueue` refuses every further command, and the
 * wearer has no way to say so. It keeps asking instead, slowly enough that a
 * genuinely stuck server is not hammered, and forever, because the only other
 * way out of the immersive session is taking the headset off.
 */
export const SAVE_BUSY_SLOW_RETRY_MS = 2_000;
/** One automatic reload per interval, so two writers cannot loop on each other. */
export const SAVE_RELOAD_INTERVAL_MS = 5_000;
export const SAVE_ERROR_MAX_ATTEMPTS = 4;
export const SAVE_ERROR_FIRST_DELAY_MS = 1_000;

/**
 * What the panel does when `sync_inspection` refuses its scene.
 *
 * `reload` is the automatic form of Load saved view: hydrate the saved scene
 * and keep polling. A desktop panel keeps the button and blocks instead, so a
 * visible desktop edit is never discarded without a click.
 */
export function saveFailureRecovery(input: {
  kind: 'busy' | 'conflict' | 'error'; companion: boolean; attempt: number; msSinceReload: number;
}): SaveRecovery {
  if (input.kind === 'busy') {
    if (input.attempt < SAVE_BUSY_MAX_ATTEMPTS) return { action: 'retry', delayMs: SAVE_BUSY_RETRY_MS };
    return input.companion ? { action: 'retry', delayMs: SAVE_BUSY_SLOW_RETRY_MS } : { action: 'block' };
  }
  if (!input.companion) return { action: 'block' };
  if (input.kind === 'conflict')
    // Between two reloads the companion keeps asking rather than blocking, so
    // the interval is a rate limit on the reload and not a wedge of its own.
    return input.msSinceReload >= SAVE_RELOAD_INTERVAL_MS ? { action: 'reload' } : { action: 'retry', delayMs: SAVE_BUSY_SLOW_RETRY_MS };
  // The backoff stops doubling at the last attempt a desktop panel would have
  // taken; past it a companion keeps asking at that cadence. No branch of this
  // function returns `block` for a companion, which is the whole invariant:
  // `block` sets `blocked`, `blocked` answers `unsaved`, and `unsaved` is what
  // refused every agent command for eight minutes.
  const attempt = Math.min(Math.max(1, input.attempt), SAVE_ERROR_MAX_ATTEMPTS);
  return { action: 'retry', delayMs: SAVE_ERROR_FIRST_DELAY_MS * 2 ** (attempt - 1) };
}

/** The wait before each of a desktop panel's own retries; one entry per attempt. */
export const DESKTOP_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000] as const;

/**
 * Whether a desktop panel presses its own Retry, and after how long.
 *
 * `showProblem` sets `blocked`, and a blocked panel follows neither a newer
 * saved view nor a new source. One failed host request therefore left a
 * visible Mac panel on an old lesson for the rest of a session while the
 * headset followed every change an agent made. A desktop panel now presses
 * its own Load saved view or Retry (`armDesktopRetry` in inspector.ts picks
 * which), after a growing wait, and stops after the last one: the banner and
 * its buttons then stay for the person.
 *
 * A save the host refused keeps its button when the person has touched the
 * panel since it last stood clean on the host's scene (`untouched` false):
 * that work is theirs. A save that never reached the host is recovered, and
 * so is one refused from a panel nobody touched, whose unsaved state is only
 * the lesson's own drawing. A failed load is tried again only when the
 * request never arrived or the source moved on while it was being delivered
 * (`sourceMoved`); a source the viewer itself refused would fail the same way
 * again. `attempt` counts presses since the panel last showed the host's
 * scene.
 */
export function desktopProblemRetry(input: {
  kind: 'save' | 'poll' | 'reconnect' | 'delivery' | 'confirmation' | 'loading';
  attempt: number; transportFailure: boolean; sourceRefused: boolean; untouched: boolean;
  loadFailure: boolean; sourceMoved: boolean;
}): { retry: true; delayMs: number } | { retry: false } {
  if (input.sourceRefused) return { retry: false };
  if (input.loadFailure && !input.transportFailure && !input.sourceMoved) return { retry: false };
  if (input.kind === 'save' && !input.transportFailure && !input.untouched) return { retry: false };
  const delayMs = Number.isInteger(input.attempt) && input.attempt >= 0 ? DESKTOP_RETRY_DELAYS_MS[input.attempt] : undefined;
  return delayMs === undefined ? { retry: false } : { retry: true, delayMs };
}

export type ConfirmRecovery = { action: 'retry'; delayMs: number } | { action: 'drop' } | { action: 'block' };

/** How many times a headset panel re-sends a confirmation before dropping it. */
export const CONFIRM_RETRY_ATTEMPTS = 3;
export const CONFIRM_RETRY_DELAY_MS = 750;

/**
 * What the panel does when `complete_inspection` itself fails.
 *
 * The receipt is the last step of a command the agent sent: it says the scene
 * was drawn, or says why it was not. When that RPC throws — the companion
 * socket dropped, the desktop was asleep — the panel used to call
 * `showProblem`, which sets `blocked`, which answers `unsaved`, which refuses
 * every following command. A wearer cannot press Retry confirmation.
 *
 * So a companion re-sends the same receipt a few times and then drops it. The
 * command is lost, which is visible and recoverable: the agent sees no receipt
 * and the server releases the claim when it expires. A wedged panel is not.
 * A desktop panel keeps the button.
 */
export function confirmFailureRecovery(input: { companion: boolean; attempt: number }): ConfirmRecovery {
  if (!input.companion) return { action: 'block' };
  if (input.attempt < CONFIRM_RETRY_ATTEMPTS) return { action: 'retry', delayMs: CONFIRM_RETRY_DELAY_MS * input.attempt };
  return { action: 'drop' };
}

/**
 * How long an in-headset `Waiting` may stand before it is read as stale.
 *
 * A command the panel takes is drawn in well under a second; the server's own
 * delivery deadline for one it is holding is fifteen. Ten sits between the two:
 * long enough that no command a panel is actually running is retired early,
 * short enough that a wearer does not read an orange plate for a command
 * nobody holds any more.
 */
export const HUD_WAIT_EXPIRY_MS = 10_000;

/**
 * Whether the wearer's status plate is showing a `Waiting` for
 * a command that no longer exists.
 *
 * A dropped confirmation (`confirmFailureRecovery` above) loses a command
 * without any later outcome to overdraw its plate, and so does a panel that
 * re-attaches under a new id. Both leave the last thing the wearer can read
 * saying that something is still coming. This says when to clear it: the plate
 * is on `Waiting`, the panel is not holding a receipt of its own, the server's
 * latest outcome is not queued or rendering, and the plate has stood for
 * longer than a command ever takes.
 */
export function staleHudWaiting(input: {
  waitingSince: number; now: number; pendingReceipt: boolean; latestStatus?: string;
}): boolean {
  if (!input.waitingSince) return false;
  if (input.pendingReceipt) return false;
  if (input.latestStatus === 'queued' || input.latestStatus === 'rendering') return false;
  return input.now - input.waitingSince >= HUD_WAIT_EXPIRY_MS;
}
