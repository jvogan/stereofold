/**
 * What a session-bound panel does when direct coordinate hydration fails.
 *
 * `stereo_structure.open` is the sole render tool and gives every mounted
 * panel a session ID. A transient bridge failure can still make the panel's
 * first app-only cache read fail; treating that miss as an empty session would
 * leave a black stage with only Mol*'s camera-axes gizmo.
 *
 * The server therefore caches the last structure it opened and exposes it on
 * the app-only tool `stereo_structure.get_structure`. This module is the
 * decision that panel makes with the answer, kept pure so it can be tested
 * without a host, a browser, or Mol*.
 */

import type { LookColor, LookStyle } from './look.js';
import type { MotionSettings } from './motion-controller.js';

/** Private result-metadata payload of `stereo_structure.get_structure`. */
export interface CachedStructure {
  kind?: string;
  /** Server lifecycle UUID; scopes this safe state snapshot's revision. */
  serverEpoch?: string;
  /** True when the server has never opened a structure. */
  empty?: boolean;
  structureText?: string;
  format?: 'pdb' | 'mmcif';
  pdbId?: string;
  fixture?: 'three-depth-markers';
  /*
   * The colour theme and representation preset in force on the server. Carried
   * even on an empty cache: a panel with nothing to draw still has to come up
   * with the drawer set to the choice already made, so that a tool result
   * arriving later lands in the right look. The decision below ignores them —
   * they change how a structure is drawn, never whether it is.
   */
  color?: LookColor;
  style?: LookStyle;
  /*
   * The stereo view state in force on the server, carried for a harder reason
   * than the look. The panel applies it before the load, because
   * `fitCameraToStage` measures one eye's viewport and one eye is half a
   * capped stage in a pair and the whole stage in mono. See
   * `./stereo-state.ts`. The decision below ignores these too.
   */
  mode?: 'off' | 'parallel' | 'cross' | 'anaglyph';
  depthBudgetArcmin?: number;
  swapEyes?: boolean;
  variant?: 'balanced' | 'dubois';
  motion?: MotionSettings;
  /** Monotonic safe-state snapshot revision emitted with app-only hydration. */
  stateRevision?: number;
}

export type StructureFallbackDecision =
  /** A structure is already on the stage; the cache is irrelevant. */
  | { action: 'keep' }
  /** Load the built-in depth fixture through its own pinned-camera path. */
  | { action: 'fixture' }
  /** Load these coordinates through the normal structure path. */
  | { action: 'load'; structureText: string; format: 'pdb' | 'mmcif'; label: string }
  /** Nothing has ever been opened: say so on the stage. */
  | { action: 'empty' };

export interface StructureFallbackInput {
  /** True when this panel has already loaded (or is loading) a structure. */
  hasStructure: boolean;
  /** The cache, or `undefined` when the tool call failed or returned nothing. */
  cached: CachedStructure | undefined;
}

/**
 * A cache hit only counts when it carries coordinates this viewer can parse.
 *
 * A malformed or truncated cache is treated exactly like an empty one: the
 * honest empty state is a better outcome than a load that fails and leaves the
 * same black stage behind a red toast.
 */
export function decideStructureFallback(input: StructureFallbackInput): StructureFallbackDecision {
  if (input.hasStructure) return { action: 'keep' };
  const cached = input.cached;
  if (cached == null || cached.empty === true) return { action: 'empty' };
  if (cached.fixture === 'three-depth-markers') return { action: 'fixture' };
  const text = cached.structureText;
  const format = cached.format;
  if (typeof text !== 'string' || text.length === 0) return { action: 'empty' };
  if (format !== 'pdb' && format !== 'mmcif') return { action: 'empty' };
  return {
    action: 'load',
    structureText: text,
    format,
    label: cached.pdbId ?? 'pasted structure',
  };
}
