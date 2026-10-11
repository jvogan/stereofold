/**
 * How long to wait for a panel, given how big the structure is.
 *
 * Two waits in this repo had fixed deadlines that were written for a 13,121-site
 * structure and then met a 40,908-site one:
 *
 * - `quest-share.ts` waits 120 s for the Mac's renderer panel to save its first
 *   scene. The microtubule `tip` stage (3JAK, 43,066 atom sites)
 *   blew through that and the host exited before the headset was ever involved.
 *   The same stage passed a full seven-step hardware drive on the next start, so
 *   the deadline was the failure, not the structure.
 * - `headset-drive.ts` waits a fixed six heartbeats after entering the immersive
 *   session before it sends its first tour command. The `wall` stage
 *   (5SYF assembly-1, operators 2-7, 40,908 atom sites) spent that window and
 *   twenty-two seconds of retries loading, and the drive failed a step that was
 *   never given time to start.
 *
 * Loading and first-render cost scales with the coordinate count, so the wait
 * does too: a base, a slope per thousand atom sites, and a cap so a wrong or
 * absurd count cannot hang a run. Two profiles, because the two waits start from
 * different places — one is a cold Mol* load on a Mac, the other is a page that
 * is already up and has just entered XR — and both keep their original deadline
 * as the floor, so nothing gets shorter than it is today.
 *
 * The atom-site counts themselves come from `plugin/demos/index.json`
 * (`coordinates.atomSites`, per demo and per stage), which is the only place a
 * count is known before anything is loaded.
 */

export type PanelWaitProfile = {
  /** The wait for a structure of unknown or negligible size. */
  baseMs: number;
  /** Added per thousand atom sites. */
  perThousandSitesMs: number;
  /**
   * Added per ten thousand triangles, for a tier drawn as a mesh.
   *
   * A density tier has no atoms at all: `coordinates.atomSites`
   * is an honest 0 and what the page holds is one marching-cubes surface. The
   * `filament` tier is 178,236 triangles, and sizing its waits off its atom
   * count would give every one of them the base wait — the shortest deadline
   * in the file for the largest thing this product has ever put in a headset.
   */
  perTenThousandTrianglesMs: number;
  /** The longest this wait can ever become. */
  capMs: number;
};

/**
 * How big the thing the page is holding is, in whichever units it has.
 *
 * A number still means atom sites, which is what every caller but the density
 * tier passes and what every existing deadline was measured in.
 */
export type PanelLoad = { atomSites?: number; triangles?: number };

/**
 * The Mac renderer panel's first saved scene, from a cold host start.
 *
 * 120 s is what this wait has always been and remains the floor. The slope is
 * measured against the pass that did work: the `tip` stage needed more than
 * 120 s once and under it the next time, so a structure that size needs
 * headroom of roughly its own load again, not a different order of magnitude.
 */
export const PANEL_SAVE_WAIT: PanelWaitProfile =
  Object.freeze({ baseMs: 120_000, perThousandSitesMs: 2_000, perTenThousandTrianglesMs: 2_000, capMs: 300_000 });

/**
 * A headset panel becoming ready again after the immersive session starts.
 *
 * 30 s is roughly five times the six beats this replaced, which is what a
 * 13,121-site structure actually wanted; the slope carries the heavy stages.
 * 180 s is the cap because past three minutes the honest answer is that
 * something is wrong, not that the structure is large.
 */
export const PANEL_READY_WAIT: PanelWaitProfile =
  Object.freeze({ baseMs: 30_000, perThousandSitesMs: 2_000, perTenThousandTrianglesMs: 2_000, capMs: 180_000 });

/**
 * How long to wait for `atomSites` coordinates under `profile`.
 *
 * An unknown, zero, negative or non-finite count is the base wait: not knowing
 * the size is a reason to use the old deadline, never a reason to shorten it.
 */
export function panelWaitMs(load: unknown, profile: PanelWaitProfile): number {
  const { sites, triangles } = panelLoad(load);
  // The two terms are not added. A page holds one picture: a density tier draws
  // its mesh and never parses the atoms it opened beside, and an atomic tier has
  // no mesh at all. So the wait covers whichever redraw is the heavier one —
  // which also means adding a triangle count can only ever lengthen a wait, and
  // no deadline in this repo gets shorter than it was.
  const load_ = Math.max((sites / 1_000) * profile.perThousandSitesMs,
    (triangles / 10_000) * profile.perTenThousandTrianglesMs);
  // Rounded to whole seconds: this is printed to a person, and a deadline of
  // 201,816 ms says nothing 202 s does not.
  const scaled = 1_000 * Math.round((profile.baseMs + load_) / 1_000);
  return Math.min(profile.capMs, Math.max(profile.baseMs, scaled));
}

/** One line saying what a wait is and why it is that long. */
export function describePanelWait(load: unknown, profile: PanelWaitProfile): string {
  const { sites, triangles } = panelLoad(load);
  const waitMs = panelWaitMs(load, profile);
  const seconds = Math.round(waitMs / 1_000);
  if (sites === 0 && triangles === 0) return `${seconds}s (no atom-site count was given, so this is the base wait)`;
  const capped = waitMs === profile.capMs ? ', at the cap' : '';
  // The triangles lead when there are any, because a tier that has them is a
  // mesh tier and the atom sites beside it are its identity, not its picture.
  if (triangles > 0) {
    const beside = sites > 0 ? ` beside ${sites.toLocaleString()} atom sites` : '';
    return `${seconds}s for ${triangles.toLocaleString()} triangles${beside}${capped}`;
  }
  return `${seconds}s for ${sites.toLocaleString()} atom sites${capped}`;
}

/** A count that is a real, positive, finite number, or 0 for "not known". */
const counted = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Read a wait's size argument, whichever of the two shapes it arrived in.
 *
 * An unknown, zero, negative or non-finite count is the base wait: not knowing
 * the size is a reason to use the old deadline, never a reason to shorten it.
 */
function panelLoad(load: unknown): { sites: number; triangles: number } {
  if (load !== null && typeof load === 'object') {
    const record = load as PanelLoad;
    return { sites: counted(record.atomSites), triangles: counted(record.triangles) };
  }
  return { sites: counted(load), triangles: 0 };
}
