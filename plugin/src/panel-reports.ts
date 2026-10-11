/**
 * Which panel's numbers `stereo_structure.get_state` answers with.
 *
 * Codex can keep earlier `stereo_structure.open` cards mounted, so one session
 * can accumulate panels and every live panel keeps reporting. The server used
 * to hold one slot and store whichever report arrived last, which means a
 * hidden panel from six messages ago could overwrite the one on screen,
 * and `sequence` could not order the two because it counts per panel. The
 * reader would then get valid-looking numbers from a build that is not on
 * screen — the exact failure this diagnostics channel exists to prevent.
 *
 * So reports are kept per panel and the answer is chosen, not inherited.
 *
 * The first version of that choice was "the panel whose last fit is newest",
 * and it had the failure it was written to prevent built into it. A freshly
 * mounted panel spends up to 7.5 s inside its `get_structure` fallback with an
 * empty fit ring, and an empty ring loses to any hidden card that ever fitted.
 * That reports `fill` 0.86 off a card six messages up while the panel
 * on screen is still blank — valid-looking numbers from a viewer that is
 * not visible, which is the whole failure mode.
 *
 * The rule is therefore "the panel that is live now, and settled": among panels
 * seen inside {@link PANEL_PRESENT_WINDOW_MS}, prefer one whose report says no
 * load is in flight, then the newest report clock, then the newest last fit
 * event, then the sequence. Liveness comes first because a panel that is still
 * reporting is a panel that still exists; a panel outside the window never
 * answers while any panel is inside it. Settledness comes next because a report
 * taken mid-load describes a camera the load is about to move. Only then does
 * the fit history break a tie.
 *
 * Pure: the clock is injected, nothing here reaches the network or the SDK.
 */

/** The fields this module needs. The real payload carries far more. */
export interface PanelReport {
  /** Random per mounted viewer. Absent from older viewer builds. */
  panelId?: string;
  at: string;
  sequence: number;
  viewerBuild: string;
  fit: {
    /** True while a structure load owns the camera. */
    loadInFlight: boolean;
    events: ReadonlyArray<{ at: string; trigger: string }>;
  };
}

/** One line per panel, for a reader deciding whether to believe the answer. */
export interface PanelSummary {
  panelId: string;
  at: string;
  sequence: number;
  viewerBuild: string;
  /** Trigger of that panel's newest fit event. Absent until it has fitted. */
  lastTrigger?: string;
  /**
   * Present, and always `true`, on the one panel `diagnostics` came from.
   *
   * Absent on every other entry, and absent from the whole list when the
   * answering panel has been quiet longer than the presence window — which is
   * itself the reading that the answer is stale.
   */
  answering?: true;
}

/** The slot a viewer too old to send a `panelId` reports into. */
export const ANONYMOUS_PANEL_ID = 'unidentified';

/** How many panels are kept. Codex tool cards accumulate; memory does not. */
export const PANEL_REPORT_LIMIT = 8;

/** How recently a panel must have reported to be listed as present. */
export const PANEL_PRESENT_WINDOW_MS = 30_000;

export interface PanelReportStore<T extends PanelReport> {
  /**
   * Store a report, unless it is stale.
   *
   * A report is stale when the same panel has already reported a *higher*
   * sequence: reports are not ordered by the channel, and a late-delivered
   * older one would otherwise undo a newer one. Sequences from different
   * panels are never compared, because each panel counts from one.
   */
  accept(report: T): boolean;
  /** The report to answer `get_state` with, or undefined when none exists. */
  newest(): T | undefined;
  /** Panels that reported within the window, the answering one first. */
  panels(): PanelSummary[];
  /** Every stored report, oldest report first. For tests. */
  all(): T[];
}

/** The last fit event's timestamp, or '' for a panel that has never fitted. */
function lastFitAt(report: PanelReport): string {
  return report.fit.events.at(-1)?.at ?? '';
}

/**
 * Whether `candidate` is the better answer than `incumbent`, both being panels
 * already known to be on the same side of the presence window.
 *
 * Settled before loading, then the newest report clock, then the newest last
 * fit event, then the sequence. ISO-8601 UTC strings compare
 * lexicographically, and every timestamp in this object is produced by
 * `new Date().toISOString()`.
 *
 * The load test is `=== false` rather than a truthiness check on purpose: the
 * field is required by the schema, and a report that somehow arrived without it
 * has not shown that it is settled, so it does not get the preference.
 */
function answersBetter(candidate: PanelReport, incumbent: PanelReport): boolean {
  const candidateSettled = candidate.fit.loadInFlight === false;
  const incumbentSettled = incumbent.fit.loadInFlight === false;
  if (candidateSettled !== incumbentSettled) return candidateSettled;
  if (candidate.at !== incumbent.at) return candidate.at > incumbent.at;
  const a = lastFitAt(candidate);
  const b = lastFitAt(incumbent);
  if (a !== b) return a > b;
  return candidate.sequence > incumbent.sequence;
}

/**
 * Total order over {@link answersBetter}: -1 when `a` answers better, 1 when
 * `b` does, 0 when they compare equal. `Array.prototype.sort` requires 0 for
 * equals; returning 1 there is not a comparator.
 */
export function compareAnswers(a: PanelReport, b: PanelReport): number {
  return answersBetter(a, b) ? -1 : answersBetter(b, a) ? 1 : 0;
}

/** Whether a report's own clock puts it inside the presence window. */
function isPresent(report: PanelReport, cutoffMs: number): boolean {
  const at = Date.parse(report.at);
  // An unparseable timestamp cannot be shown to be inside the window, so it is
  // not claimed to be.
  return Number.isFinite(at) && at >= cutoffMs;
}

function bestOf<T extends PanelReport>(candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const report of candidates) {
    if (best === undefined || answersBetter(report, best)) best = report;
  }
  return best;
}

export function createPanelReportStore<T extends PanelReport>(options: {
  limit?: number;
  windowMs?: number;
  /** Epoch ms. Injected so the presence window is testable. */
  now?: () => number;
} = {}): PanelReportStore<T> {
  const limit = Math.max(1, options.limit ?? PANEL_REPORT_LIMIT);
  const windowMs = options.windowMs ?? PANEL_PRESENT_WINDOW_MS;
  const now = options.now ?? Date.now;
  /** Insertion order is last-report order: the first key is the stalest. */
  const reports = new Map<string, T>();

  return {
    accept(report: T): boolean {
      const key = report.panelId ?? ANONYMOUS_PANEL_ID;
      const stored = reports.get(key);
      if (stored != null && report.sequence < stored.sequence) return false;
      // Re-inserting moves the key to the end, so eviction always takes the
      // panel that has been quiet longest rather than the one that mounted
      // first.
      reports.delete(key);
      reports.set(key, report);
      while (reports.size > limit) {
        const oldest = reports.keys().next();
        if (oldest.done === true) break;
        reports.delete(oldest.value);
      }
      return true;
    },
    newest(): T | undefined {
      const cutoff = now() - windowMs;
      const stored = [...reports.values()];
      const present = stored.filter((report) => isPresent(report, cutoff));
      // A panel outside the window never answers while any panel is inside it.
      // When none is, the best of what there is still answers rather than
      // nothing: an old report is a reading, and the reader can see it is old
      // because `diagnosticsPanels` will not list it.
      return bestOf(present.length > 0 ? present : stored);
    },
    panels(): PanelSummary[] {
      const cutoff = now() - windowMs;
      const stored = [...reports.values()];
      const present = stored.filter((report) => isPresent(report, cutoff));
      const answering = bestOf(present.length > 0 ? present : stored);
      present.sort(compareAnswers);
      return present.map((report) => {
        const trigger = report.fit.events.at(-1)?.trigger;
        return {
          panelId: report.panelId ?? ANONYMOUS_PANEL_ID,
          at: report.at,
          sequence: report.sequence,
          viewerBuild: report.viewerBuild,
          ...(trigger === undefined ? {} : { lastTrigger: trigger }),
          ...(report === answering ? { answering: true as const } : {}),
        };
      });
    },
    all(): T[] {
      return [...reports.values()];
    },
  };
}
