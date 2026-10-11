/**
 * The host's words for "not yet", shared by the unattended
 * driver and the headset page.
 *
 * A second command while one is still pending is a thrown error on the host.
 * The driver already treated that as a wait rather than a failure. The page
 * did not: a wearer who said "grow it" while the panel was mid-render got
 * HTTP 409 "The requested panel is unavailable, dirty, stale, or rendering
 * another command." recorded as a failed voice command, and heard nothing
 * useful. One predicate, one retry budget.
 */
import { panelWaitMs, PANEL_READY_WAIT } from '../scripts/panel-wait.js';

/** `inspection-commands.ts` refuses a second command while one is still pending. */
export const COMMAND_IN_FLIGHT = /already in progress/i;

/**
 * A pause's receipt can render while the very next command is refused because
 * the panel's beat has not caught up. Between beats is
 * "not yet", not "gone".
 */
export const PANEL_BETWEEN_BEATS = /No panel is (showing this inspection|ready for a command right now)/i;

/** `stop` one beat after `spin` answers "A molecular change is still rendering". */
export const CHANGE_STILL_RENDERING = /still rendering/i;

/**
 * Companion `/tool` 409 from `readyPanel`: the named panel is busy, dirty,
 * stale, or rendering another command. Same "not yet" as the three above.
 */
export const PANEL_BUSY = /unavailable, dirty, stale, or rendering another command/i;

/**
 * The grow (and source-replace) binding is one revision behind. Re-read and
 * ask again; this is not a refusal of the tier.
 */
export const STALE_INSPECTION_STATE = /Read the current inspection state before/i;

/** The sentence `grow_structure` throws when `readyPanel` is false. */
export const PANEL_BUSY_MESSAGE =
  'The requested panel is unavailable, dirty, stale, or rendering another command.';

/** Said once while the page waits out a busy panel. Two words. */
export const GROW_NOT_YET_SPOKEN = 'One moment.';

/** Said after the size-aware budget is spent and the panel is still busy. */
export const GROW_STILL_BUSY_SPOKEN = 'Still busy. Try again.';

/** Seconds between one not-yet answer and the next try. */
export const IN_FLIGHT_RETRY_SECONDS = 2;

/** How many times a command will wait for the one before it to finish, as a floor. */
export const IN_FLIGHT_ATTEMPTS = 6;

/**
 * Whether this answer means "not yet" rather than a refusal.
 *
 * A 4xx other than HTTP 409 is a genuine refusal (device ceiling arrives as a
 * normal `grow.refused` result, not here). Status is optional: the MCP driver
 * path has none, and a matching sentence there is still not-yet.
 */
export function isCommandInFlight(value: unknown): boolean {
  const status = value && typeof value === 'object' && typeof (value as {status?: unknown}).status === 'number'
    ? (value as {status: number}).status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 409) return false;
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return COMMAND_IN_FLIGHT.test(text) || PANEL_BETWEEN_BEATS.test(text) || CHANGE_STILL_RENDERING.test(text)
    || PANEL_BUSY.test(text) || STALE_INSPECTION_STATE.test(text);
}

/**
 * The same bound, scaled to the structure: a 40K-site wall re-renders for far
 * longer than six two-second beats. Uses the post-entry wait formula so one
 * number describes how patient the page and the driver are with a given atom
 * count.
 */
export function inFlightAttempts(atomSites?: number): number {
  return Math.max(IN_FLIGHT_ATTEMPTS, Math.ceil(panelWaitMs(atomSites, PANEL_READY_WAIT) / (IN_FLIGHT_RETRY_SECONDS * 1_000)));
}

export type RetryWhileNotYetOptions = {
  /** Atom-site count that sizes the budget. Unknown is the six-attempt floor. */
  atomSites?: number;
  /** Override the computed attempt count. */
  attempts?: number;
  /** Re-read binding / state between tries so the next post carries fresh revisions. */
  refresh?: () => Promise<void> | void;
  /** Delay between tries. Production waits two seconds; tests pass a no-op. */
  wait?: (seconds: number) => Promise<void>;
  /** Called once, on the first not-yet, so the wearer hears "One moment." */
  onNotYet?: () => void;
};

/**
 * Run `task` until it succeeds, or until a not-yet answer spends the budget.
 *
 * A genuine refusal is thrown on the first try. Spending the budget throws
 * `GROW_STILL_BUSY_SPOKEN` rather than the host's last busy sentence.
 */
export async function retryWhileNotYet<T>(task: () => Promise<T>, options: RetryWhileNotYetOptions = {}): Promise<T> {
  const attempts = options.attempts ?? inFlightAttempts(options.atomSites);
  const wait = options.wait ?? ((seconds: number) => new Promise<void>(resolve => setTimeout(resolve, seconds * 1_000)));
  let noticed = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (!isCommandInFlight(error) || attempt >= attempts) {
        if (isCommandInFlight(error)) {
          throw Object.assign(Error(GROW_STILL_BUSY_SPOKEN), {
            cause: error, retrying: noticed,
            status: (error as {status?: unknown})?.status,
          });
        }
        throw error;
      }
      if (!noticed) {
        noticed = true;
        options.onNotYet?.();
      }
      await options.refresh?.();
      await wait(IN_FLIGHT_RETRY_SECONDS);
    }
  }
}
