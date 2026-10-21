import { arrayAtMost } from './array-bounds.js';
/** Rigid molecular motion is source- and chapter-bound. Shared scene captures
 * carry the definition and the last published playback sample; frame ticks never
 * create saved revisions. External movie export has no chain-track adapter.
 */
import { z } from 'zod';
import { labelOffsetSchema } from './lesson-figure.js';
export const ANIMATION_LIMITS = { tracks: 32, keyframesPerTrack: 512, eventsPerTrack: 512, chainsPerTrack: 64, tethers: 16 } as const;
const finite = z.number().finite();
const time = finite.min(0);
const id = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/iu);
const tetherAtom = z.object({
  chain: z.string().trim().min(1).max(256), residue: z.number().int(),
  atom: z.string().trim().min(1).max(64),
}).strict();
const residueRange = z.object({ from: z.number().int(), to: z.number().int() }).strict()
  .refine(range => range.to >= range.from, 'Residue ranges must not run backwards.');
const selector = z.object({
  residues: z.array(residueRange).refine(v => v.length >= 1, 'Expected at least one item.').superRefine(arrayAtMost(64)).optional()
    .describe('Inclusive author residue ranges, unioned across the track author chains. Includes insertion codes and alternate atoms at those numbers.'),
  componentIds: z.array(z.string().trim().min(1).max(16)).refine(v => v.length >= 1, 'Expected at least one item.').superRefine(arrayAtMost(64)).optional()
    .describe('Additional component IDs (for example ATP); unioned with residue ranges within the track author chains.'),
}).strict().refine(value => value.residues || value.componentIds, 'A selector needs residue ranges or component IDs.');

/** Possible owners without coordinates. Component-only matches may need source resolution. */
export function animationTargetOwners(tracks: MolecularAnimation['tracks'], target: {chain:string; residues?:{from:number;to:number}; residueNumbers?:number[]; componentId?:string}) {
  const owners = new Set<string | undefined>();
  let definite = false;
  for (const track of tracks) {
    if (!track.chains.includes(target.chain)) continue;
    const s = track.selector;
    const ranges = s?.residues ?? [];
    const numbers = target.residueNumbers?.filter(n => !target.residues || n >= target.residues.from && n <= target.residues.to);
    const withinRanges = numbers ? numbers.length > 0 && numbers.every(n => ranges.some(r => r.from <= n && r.to >= n))
      : Boolean(target.residues && ranges.some(r => r.from <= target.residues!.from && r.to >= target.residues!.to));
    const intersectsRanges = numbers ? numbers.some(n => ranges.some(r => r.from <= n && r.to >= n))
      : (!target.residues && ranges.length > 0) || Boolean(target.residues && ranges.some(r => r.from <= target.residues!.to && r.to >= target.residues!.from));
    const contains = !s || withinRanges
      || Boolean(target.componentId && s.componentIds?.includes(target.componentId));
    const possible = contains || intersectsRanges
      || Boolean(!target.componentId && s?.componentIds?.length);
    if (possible) owners.add(track.id);
    definite ||= contains;
  }
  if (!definite) owners.add(undefined);
  return owners;
}
export const molecularAnimationSchema = z.object({
  version: z.literal(1), durationSeconds: finite.positive().max(600),
  tracks: z.array(z.object({
    id, chains: z.array(z.string().trim().min(1).max(256)).refine(v => v.length >= 1, 'Expected at least one item.').superRefine(arrayAtMost(ANIMATION_LIMITS.chainsPerTrack)),
    selector: selector.optional().describe('Omit to own whole author chains. Selected atoms must be disjoint from every other track; checked again against the loaded source.'),
    pivot: z.array(finite.min(-1e6).max(1e6)).refine(v => v.length === 3, 'Expected exactly 3 items.').optional()
      .describe('Optional hinge point in source Angstrom coordinates. Pose is pivot + rotation * (point - pivot) + translation. Omit for model-origin poses.'),
    keyframes: z.array(z.object({ t: time,
      rotation: z.array(finite).refine(v => v.length === 4, 'Expected exactly 4 items.').refine(q => Math.abs(Math.hypot(...q) - 1) < 1e-5, 'Rotation quaternion must be normalized and nonzero.'),
      translation: z.array(finite.min(-1e6).max(1e6)).refine(v => v.length === 3, 'Expected exactly 3 items.'),
    }).strict()).refine(v => v.length >= 1, 'Expected at least one item.').superRefine(arrayAtMost(ANIMATION_LIMITS.keyframesPerTrack)),
    visibility: z.array(z.object({t: time, visible: z.boolean()}).strict()).superRefine(arrayAtMost(ANIMATION_LIMITS.eventsPerTrack)).optional(),
  }).strict()).refine(v => v.length >= 1, 'Expected at least one item.').superRefine(arrayAtMost(ANIMATION_LIMITS.tracks)),
  playback: z.object({autoplay: z.boolean().optional(), loop: z.boolean().optional(), speed: finite.positive().max(16).optional()}).strict().optional(),
  tethers: z.array(z.object({
    id, from: tetherAtom, to: tetherAtom,
    color: z.string().regex(/^#[0-9a-f]{6}$/iu).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    offsetX: labelOffsetSchema.optional(), offsetY: labelOffsetSchema.optional(),
  }).strict()).superRefine(arrayAtMost(ANIMATION_LIMITS.tethers)).optional(),
}).strict().superRefine((animation, ctx) => {
  const ids = new Set();
  animation.tracks.forEach((track, i) => {
    const issue = (message: string, field: string) => ctx.addIssue({code:'custom', message, path:['tracks',i,field]});
    if (ids.has(track.id)) issue('Animation track ids must be unique.', 'id'); ids.add(track.id);
    if (new Set(track.chains).size !== track.chains.length) issue('Author chains must be unique within a track.', 'chains');
    for (const other of animation.tracks.slice(0, i)) {
      if (!track.chains.some(chain => other.chains.includes(chain))) continue;
      const a = track.selector, b = other.selector;
      if (!a || !b || a.residues?.some(x => b.residues?.some(y => x.from <= y.to && y.from <= x.to))
        || a.componentIds?.some(c => b.componentIds?.includes(c)))
        issue(`Overlapping body ownership with track "${other.id}".`, 'selector');
    }
    for (const field of ['keyframes','visibility'] as const) {
      let previous = -1;
      for (const item of track[field] ?? []) {
        if (item.t <= previous) issue(`${field} times must be strictly increasing.`, field);
        if (item.t > animation.durationSeconds) issue(`${field} time exceeds animation durationSeconds.`, field);
        previous = item.t;
      }
    }
  });
  const tetherIds = new Set();
  animation.tethers?.forEach((tether, i) => {
    if (tetherIds.has(tether.id)) ctx.addIssue({code:'custom', message:'Animation tether ids must be unique.', path:['tethers',i,'id']});
    tetherIds.add(tether.id);
    const owners = (atom: z.output<typeof tetherAtom>) => animationTargetOwners(animation.tracks, {chain:atom.chain, residues:{from:atom.residue,to:atom.residue}});
    const a = owners(tether.from), b = owners(tether.to);
    if (a.size === 1 && b.size === 1 && [...a][0] === [...b][0]) ctx.addIssue({code:'custom',
      message:'Tether endpoints must lie on different bodies, with at least one moving body.', path:['tethers',i]});
  });
});
export type MolecularAnimation = z.output<typeof molecularAnimationSchema>;
