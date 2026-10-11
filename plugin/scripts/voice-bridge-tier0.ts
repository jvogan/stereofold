/**
 * Tier 0 of the voice bridge: a generous local synonym table over the
 * headset's spoken grammar, with no model and no network beyond the host.
 *
 * The companion page already executes part of this vocabulary instantly
 * (lab/browser-roundtrip/voice-command-runner.mjs
 * `spatialVoiceAction`) and speaks its own confirmation for those. This table
 * deliberately covers a wider net — the page-missed synonyms wearers actually
 * say, such as "make it small", plus the exact
 * page phrases for mapping completeness. The daemon (`voice-bridge.ts`)
 * yields to the page whenever the page's own resolver claims an utterance
 * with an action, so an overlap never fires twice; entries marked
 * page-owned below document that expectation.
 *
 * Every decision is pure: normalize, look up, scale against the current
 * placement. Nothing here touches the network, the filesystem, or a key.
 */

// @ts-ignore Shared page/host numerical placement envelope.
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE } from '../../lab/browser-roundtrip/placement-limits.mjs';

export type Tier0Tool = 'update_inspection' | 'control_tour' | 'focus_selection';

export type Tier0Decision = {
  tier: 'tier0';
  /** The loopback tool to call. */
  tool: Tier0Tool;
  /** Tool arguments minus the session binding (filled from state later). */
  change: Record<string, unknown>;
  /** Extra top-level tool fields besides change (e.g. framing). */
  fields?: Record<string, unknown>;
  /** Spoken confirmation, always under six words. */
  say: string;
  /** False when the wearer will hear the outcome anyway (tour narration). */
  speak: boolean;
  /** Short tag for the bridge log. */
  rule: string;
};

export type BridgeScale = { scale?: unknown };

const MAX_TRANSCRIPT_CHARS = 240;

const LEADING_FILLERS = new Set([
  'ok', 'okay', 'hey', 'hi', 'please', 'now', 'so', 'um', 'uh', 'well',
  'right', 'and', 'then', 'just', 'go', 'do', 'can', 'could', 'would',
  'you', 'to', 'lets', 'let', 'us', 'i', 'want', 'like', 'the', 'a',
  'come', 'please',
]);

const TRAILING_FILLERS = new Set([
  'please', 'now', 'thanks', 'thank', 'you', 'for', 'me', 'it', 'a',
]);

/**
 * Lowercase, de-punctuate, and walk off filler words at both ends, the way
 * the page's own runner does, so "ok, make it small please" still lands on
 * the same entry as "make it small". Negations are never stripped: only a
 * leading run of known fillers is skipped and any other word ends the walk.
 */
export function normalizeBridgeTranscript(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.normalize('NFKC').toLowerCase()
    // Keep a decimal point inside a number ("scale to 1.5"); every other
    // punctuation still separates words.
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
    .replace(/[^a-z0-9.]+/g, ' ')
    // A dot that is not inside a number is sentence punctuation, not a word.
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > MAX_TRANSCRIPT_CHARS) return undefined;
  const words = cleaned.split(' ');
  let start = 0;
  while (start < words.length - 1 && LEADING_FILLERS.has(words[start])) start++;
  let end = words.length;
  while (end > start + 1 && TRAILING_FILLERS.has(words[end - 1])) end--;
  const normalized = words.slice(start, end).join(' ');
  return normalized || undefined;
}

type ScaleEntry = { factor?: number; absolute?: number; say: string };

const SCALE_PHRASES = new Map<string, ScaleEntry>([
  // Exact page phrases, kept so the mapping is total; the daemon yields these
  // to the page, which acts and speaks first.
  ['bigger', { factor: 1.5, say: 'Bigger.' }],
  ['make it bigger', { factor: 1.5, say: 'Bigger.' }],
  ['make it larger', { factor: 1.5, say: 'Bigger.' }],
  ['scale up', { factor: 1.5, say: 'Bigger.' }],
  ['scale larger', { factor: 1.5, say: 'Bigger.' }],
  ['zoom in', { factor: 1.5, say: 'Bigger.' }],
  ['a bit bigger', { factor: 1.5, say: 'Bigger.' }],
  ['smaller', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['make it smaller', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['make it smaller please', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['scale down', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['scale smaller', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['zoom out', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['a bit smaller', { factor: 1 / 1.5, say: 'Smaller.' }],
  // Page-missed synonyms the page's own grammar drops, such as "make it
  // small"; every row here acts within ~2 s.
  ['make it small', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['small', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['little', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['make it little', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['reduce', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['reduce it', { factor: 1 / 1.5, say: 'Smaller.' }],
  ['big', { factor: 1.5, say: 'Bigger.' }],
  ['make it big', { factor: 1.5, say: 'Bigger.' }],
  ['large', { factor: 1.5, say: 'Bigger.' }],
  ['larger', { factor: 1.5, say: 'Bigger.' }],
  ['make it large', { factor: 1.5, say: 'Bigger.' }],
  ['enlarge', { factor: 1.5, say: 'Bigger.' }],
  ['enlarge it', { factor: 1.5, say: 'Bigger.' }],
  ['magnify', { factor: 1.5, say: 'Bigger.' }],
  ['magnify it', { factor: 1.5, say: 'Bigger.' }],
  ['tiny', { factor: 0.5, say: 'Much smaller.' }],
  ['make it tiny', { factor: 0.5, say: 'Much smaller.' }],
  ['teeny', { factor: 0.5, say: 'Much smaller.' }],
  ['teeny tiny', { factor: 0.5, say: 'Much smaller.' }],
  ['huge', { factor: 2, say: 'Much bigger.' }],
  ['make it huge', { factor: 2, say: 'Much bigger.' }],
  ['enormous', { factor: 2, say: 'Much bigger.' }],
  ['make it enormous', { factor: 2, say: 'Much bigger.' }],
  ['giant', { factor: 2, say: 'Much bigger.' }],
  ['make it giant', { factor: 2, say: 'Much bigger.' }],
  ['massive', { factor: 2, say: 'Much bigger.' }],
  ['make it massive', { factor: 2, say: 'Much bigger.' }],
  // Multipliers and fractions, in spoken form.
  ['twice as big', { factor: 2, say: 'Twice as big.' }],
  ['twice bigger', { factor: 2, say: 'Twice as big.' }],
  ['two times bigger', { factor: 2, say: 'Twice as big.' }],
  ['three times bigger', { factor: 3, say: 'Much bigger.' }],
  ['double', { factor: 2, say: 'Twice as big.' }],
  ['double it', { factor: 2, say: 'Twice as big.' }],
  ['double the size', { factor: 2, say: 'Twice as big.' }],
  ['half', { factor: 0.5, say: 'Half size.' }],
  ['half the size', { factor: 0.5, say: 'Half size.' }],
  ['half as big', { factor: 0.5, say: 'Half size.' }],
  ['halve it', { factor: 0.5, say: 'Half size.' }],
  ['halve', { factor: 0.5, say: 'Half size.' }],
  ['twice as small', { factor: 0.5, say: 'Half size.' }],
  ['three times smaller', { factor: 1 / 3, say: 'Much smaller.' }],
  ['a lot bigger', { factor: 2, say: 'Much bigger.' }],
  ['a lot smaller', { factor: 0.5, say: 'Much smaller.' }],
  ['much bigger', { factor: 2, say: 'Much bigger.' }],
  ['much smaller', { factor: 0.5, say: 'Much smaller.' }],
  ['way bigger', { factor: 2, say: 'Much bigger.' }],
  ['way smaller', { factor: 0.5, say: 'Much smaller.' }],
  ['slightly bigger', { factor: 1.25, say: 'Bigger.' }],
  ['slightly smaller', { factor: 1 / 1.25, say: 'Smaller.' }],
  ['a little bigger', { factor: 1.25, say: 'Bigger.' }],
  ['a little smaller', { factor: 1 / 1.25, say: 'Smaller.' }],
  // The normalizer walks off a leading "a", so the bare stems below are the
  // forms that actually arrive; both spellings are kept for a reader.
  ['bit bigger', { factor: 1.5, say: 'Bigger.' }],
  ['little bigger', { factor: 1.25, say: 'Bigger.' }],
  ['little smaller', { factor: 1 / 1.25, say: 'Smaller.' }],
  ['tad bigger', { factor: 1.25, say: 'Bigger.' }],
  ['tad smaller', { factor: 1 / 1.25, say: 'Smaller.' }],
  ['lot bigger', { factor: 2, say: 'Much bigger.' }],
  ['lot smaller', { factor: 0.5, say: 'Much smaller.' }],
  ['a tad bigger', { factor: 1.25, say: 'Bigger.' }],
  ['a tad smaller', { factor: 1 / 1.25, say: 'Smaller.' }],
  ['bit smaller', { factor: 1 / 1.25, say: 'Smaller.' }],
  ['fifty percent bigger', { factor: 1.5, say: 'Bigger.' }],
  ['fifty percent smaller', { factor: 1 / 1.5, say: 'Smaller.' }],
]);

const ABSOLUTE_SCALE = /^(?:set |make it |scale |size |zoom )?(?:size|scale)(?: to| at)? (\d+(?:\.\d+)?)$/;
const PERCENT_SCALE = /^(\d+)\s*percent(?: size)?$/;
export const MIN_SCALE = PLACEMENT_MIN_SCALE;
export const MAX_SCALE = PLACEMENT_MAX_SCALE;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function currentScaleOf(state: BridgeScale): number | undefined {
  const scale = state?.scale;
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : undefined;
}

/** Absolute scale for a relative factor, read off the saved placement. */
export function scaledPlacement(factor: number, state: BridgeScale): Record<string, unknown> {
  const current = currentScaleOf(state);
  // Unknown placement falls back to the documented SKILL.md step: bigger
  // means 2, smaller means 0.5. Known placement multiplies and clamps.
  const scale = current === undefined
    ? (factor >= 1 ? 2 : 0.5)
    : clampScale(Math.round(current * factor * 100) / 100);
  return { scale };
}

type MotionEntry = { state: 'spin' | 'stop'; say: string };
const MOTION_PHRASES = new Map<string, MotionEntry>([
  ['spin', { state: 'spin', say: 'Spinning.' }],
  ['spin it', { state: 'spin', say: 'Spinning.' }],
  ['start spinning', { state: 'spin', say: 'Spinning.' }],
  ['keep spinning', { state: 'spin', say: 'Spinning.' }],
  ['rotate', { state: 'spin', say: 'Spinning.' }],
  ['rotate it', { state: 'spin', say: 'Spinning.' }],
  ['turn', { state: 'spin', say: 'Spinning.' }],
  ['turn it', { state: 'spin', say: 'Spinning.' }],
  ['stop', { state: 'stop', say: 'Stopped.' }],
  ['stop it', { state: 'stop', say: 'Stopped.' }],
  ['halt', { state: 'stop', say: 'Stopped.' }],
  ['freeze', { state: 'stop', say: 'Stopped.' }],
  ['hold still', { state: 'stop', say: 'Stopped.' }],
]);

type TourEntry = { action: 'play' | 'pause' | 'next' | 'back' | 'menu'; say: string; speak: boolean };
const TOUR_PHRASES = new Map<string, TourEntry>([
  ['next', { action: 'next', say: 'Next step.', speak: false }],
  ['back', { action: 'back', say: 'Back one step.', speak: false }],
  ['previous', { action: 'back', say: 'Back one step.', speak: false }],
  ['go back', { action: 'back', say: 'Back one step.', speak: false }],
  ['go next', { action: 'next', say: 'Next step.', speak: false }],
  ['skip', { action: 'next', say: 'Next step.', speak: false }],
  ['skip ahead', { action: 'next', say: 'Next step.', speak: false }],
  ['pause', { action: 'pause', say: 'Tour paused.', speak: true }],
  ['pause it', { action: 'pause', say: 'Tour paused.', speak: true }],
  ['stop the tour', { action: 'pause', say: 'Tour paused.', speak: true }],
  ['play', { action: 'play', say: 'Tour started.', speak: false }],
  ['play it', { action: 'play', say: 'Tour started.', speak: false }],
  ['play the tour', { action: 'play', say: 'Tour started.', speak: false }],
  ['start the tour', { action: 'play', say: 'Tour started.', speak: false }],
  ['start tour', { action: 'play', say: 'Tour started.', speak: false }],
  ['resume the tour', { action: 'play', say: 'Tour started.', speak: false }],
  ['continue', { action: 'play', say: 'Tour started.', speak: false }],
  ['continue the tour', { action: 'play', say: 'Tour started.', speak: false }],
  ['unpause', { action: 'play', say: 'Tour started.', speak: false }],
  ['tour menu', { action: 'menu', say: 'Tour menu.', speak: true }],
]);

type QualityEntry = { level: 'fast' | 'balanced' | 'best'; say: string };
const QUALITY_PHRASES = new Map<string, QualityEntry>([
  ['better quality', { level: 'best', say: 'Max quality.' }],
  ['best quality', { level: 'best', say: 'Max quality.' }],
  ['max quality', { level: 'best', say: 'Max quality.' }],
  ['maximum quality', { level: 'best', say: 'Max quality.' }],
  ['high quality', { level: 'best', say: 'Max quality.' }],
  ['highest quality', { level: 'best', say: 'Max quality.' }],
  ['ultra quality', { level: 'best', say: 'Max quality.' }],
  ['make it look better', { level: 'best', say: 'Max quality.' }],
  ['sharper', { level: 'best', say: 'Max quality.' }],
  ['crisper', { level: 'best', say: 'Max quality.' }],
  ['balanced quality', { level: 'balanced', say: 'Balanced.' }],
  ['normal quality', { level: 'balanced', say: 'Balanced.' }],
  ['medium quality', { level: 'balanced', say: 'Balanced.' }],
  ['mid quality', { level: 'balanced', say: 'Balanced.' }],
  ['smoother', { level: 'fast', say: 'Fast.' }],
  ['faster', { level: 'fast', say: 'Fast.' }],
  ['fast quality', { level: 'fast', say: 'Fast.' }],
  ['low quality', { level: 'fast', say: 'Fast.' }],
  ['lowest quality', { level: 'fast', say: 'Fast.' }],
]);

const RESET_PHRASES = new Set([
  'reset', 'reset it', 'reset view', 'reset the view', 'reset everything',
  'show everything', 'show all', 'whole thing', 'the whole thing',
]);

/**
 * "go to residue 141", said to the Mac rather than to the page.
 *
 * The page has owned this sentence since then, through its own closed grammar,
 * and moves the open residue browser to that row. The Mac had no route to it
 * at all: on the Quest 2 "go to residue 141" and "go to 141"
 * both reached the host's conversation consumer and the browser did not move
 *`focus_selection` with the author
 * residue range is the route that does work from here — the same call reached
 * residue 141 first attempt in that session, drawing `✓ARG 141` as the
 * browser's only row — so the sentence is mapped onto it.
 *
 * A bare "go to 141" is included because the recognizer writes it and a wearer
 * says it; nothing else in this scene is numbered, which is the same reading
 * `bare-residue-range` makes of a bare range on the Mac. An optional chain
 * letter rides along, because 4HHB has four chains and a residue number alone
 * names one row in each.
 */
const RESIDUE_GOTO = /^(?:go|jump|page|skip|take me|scroll|zoom|move) to (?:the )?(?:residue |author residue )?(\d{1,6})(?: (?:on|in|of) chain ([a-z0-9]))?$/;
const RESIDUE_SHOW = /^(?:show|show me|find|focus on|focus) (?:the )?(?:residue|author residue) (\d{1,6})(?: (?:on|in|of) chain ([a-z0-9]))?$/;

/** The residue a spoken jump names, or nothing. */
export function residueGoto(normalized: string): { residue: number; chain?: string } | undefined {
  const match = RESIDUE_GOTO.exec(normalized) ?? RESIDUE_SHOW.exec(normalized);
  if (!match) return undefined;
  const residue = Number(match[1]);
  if (!Number.isInteger(residue) || residue < 1) return undefined;
  return { residue, ...(match[2] ? { chain: match[2].toUpperCase() } : {}) };
}

/**
 * Match one normalized utterance against the local table. Returns undefined
 * for anything Tier 0 cannot do, which the daemon sends to Tier 1.
 */
export function matchTier0(normalized: string, state: BridgeScale = {}): Tier0Decision | undefined {
  const scale = SCALE_PHRASES.get(normalized);
  if (scale) {
    const factor = scale.factor ?? 1;
    return {
      tier: 'tier0', tool: 'update_inspection',
      change: { kind: 'placement', patch: scaledPlacement(factor, state) },
      say: scale.say, speak: true, rule: `scale-x${factor}`,
    };
  }
  const absolute = ABSOLUTE_SCALE.exec(normalized);
  if (absolute) {
    return {
      tier: 'tier0', tool: 'update_inspection',
      change: { kind: 'placement', patch: { scale: clampScale(Number(absolute[1])) } },
      say: 'Size set.', speak: true, rule: 'scale-absolute',
    };
  }
  const percent = PERCENT_SCALE.exec(normalized);
  if (percent) {
    return {
      tier: 'tier0', tool: 'update_inspection',
      change: { kind: 'placement', patch: { scale: clampScale(Number(percent[1]) / 100) } },
      say: 'Size set.', speak: true, rule: 'scale-percent',
    };
  }
  const motion = MOTION_PHRASES.get(normalized);
  if (motion) {
    return {
      tier: 'tier0', tool: 'update_inspection',
      change: { kind: 'motion', patch: { state: motion.state } },
      say: motion.say, speak: true, rule: `motion-${motion.state}`,
    };
  }
  const tour = TOUR_PHRASES.get(normalized);
  if (tour) {
    return {
      tier: 'tier0', tool: 'control_tour',
      change: { action: tour.action },
      say: tour.say, speak: tour.speak, rule: `tour-${tour.action}`,
    };
  }
  const quality = QUALITY_PHRASES.get(normalized);
  if (quality) {
    return {
      tier: 'tier0', tool: 'update_inspection',
      change: { kind: 'render-quality', patch: { level: quality.level } },
      say: quality.say, speak: true, rule: `quality-${quality.level}`,
    };
  }
  // "reset" has no safe server-side placement equivalent (recentring is a
  // presentation-local move), so it reframes the current selection instead:
  // the server route to "show everything again".
  if (RESET_PHRASES.has(normalized)) {
    return {
      tier: 'tier0', tool: 'focus_selection',
      change: {},
      fields: { framing: 'context' },
      say: 'Whole structure.', speak: true, rule: 'reset-reframe',
    };
  }
  const jump = residueGoto(normalized);
  if (jump) {
    return {
      tier: 'tier0', tool: 'focus_selection',
      change: { residues: { authorResidueRange: [jump.residue, jump.residue],
        ...(jump.chain ? { authorChain: jump.chain } : {}) } },
      fields: { framing: 'context' },
      say: `Residue ${jump.residue}${jump.chain ? ` chain ${jump.chain}` : ''}.`, speak: true, rule: 'residue-goto',
    };
  }
  return undefined;
}
