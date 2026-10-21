import { arrayAtMost } from './array-bounds.js';
import { z } from 'zod';

/** A bounded, explicitly authored atomic illustration; never a desktop-camera replay. */
const color = z.string().regex(/^#[0-9a-f]{6}$/iu);
const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/iu);
export const figureTargetSchema = z.object({
  chain: z.string().trim().min(1).max(8),
  residues: z.object({ from: z.number().int().min(-9999).max(99999), to: z.number().int().min(-9999).max(99999) })
    .strict().refine(v => v.to >= v.from, 'A figure residue range must not run backwards.').optional(),
  residueNumbers: z.array(z.number().int().min(-9999).max(99999))
    .refine(v => v.length > 0, 'Expected at least one author residue number.').superRefine(arrayAtMost(256))
    .refine(v => new Set(v).size === v.length, 'Author residue numbers must be unique.').optional()
    .describe('Noncontiguous author residue numbers, intersected with any range, component and atom filters. Includes insertion codes and alternate atoms at those numbers.'),
  componentId: z.string().trim().min(1).max(16).optional(),
  atomName: z.string().trim().min(1).max(16).optional(),
}).strict();
const target = figureTargetSchema;
export const labelOffsetSchema = z.number().finite().min(-100).max(100);
const offset = labelOffsetSchema;
export const lessonFigureSchema = z.object({
  // Explicit whole-figure choice by the wearer, preserving each authored layer
  // for undo and a later chapter. Absent retains the original layered figure.
  representationOverride: z.enum(['cartoon', 'ball-and-stick', 'spacefill', 'molecular-surface']).optional(),
  layers: z.array(z.object({
    id, target,
    representation: z.enum(['cartoon', 'gaussian-surface', 'ball-and-stick', 'sticks', 'spacefill']),
    color, opacity: z.number().finite().min(0).max(1).default(1),
    // Faint reference geometry remains visible without defining the closeup's
    // substantive silhouette for menu clearance.
    context: z.boolean().default(false),
    sizeFactor: z.number().finite().min(0.1).max(2).optional(),
    colorOverrides: z.array(z.object({ target, color }).strict()).superRefine(arrayAtMost(8)).optional(),
  }).strict()).superRefine(arrayAtMost(16)).superRefine((v,ctx) => { if(!v.length) ctx.addIssue({code:'custom',message:'A figure needs at least one layer.'}); }),
  labels: z.array(z.object({
    id, target, text: z.string().trim().min(1).max(60), color,
    // Opt-in exterior placement in XR; ordinary attached labels keep their layout.
    placement: z.enum(['attached', 'outside-figure']).optional(),
    offsetX: offset.default(0), offsetY: offset.default(0),
    // Attached XR offset cap and preferred exterior offset; exterior repairs
    // may travel at most 12 em. Explicit desktop sizing uses this authored cap.
    maxOffsetEm: z.number().finite().min(2).max(5).default(2),
    sizeFactor: z.number().finite().min(0.2).max(3).default(1),
    desktopSizePx: z.number().finite().min(14).max(48).optional(),
  }).strict()).superRefine(arrayAtMost(16)).default([]),
  distances: z.array(z.object({
    id, a: target, b: target, color,
    // Checked against the loaded atoms. This is not a substitute for a measurement.
    expectedAngstrom: z.number().finite().positive().max(100).optional(),
    showText: z.boolean().default(true),
    offsetX: offset.default(0), offsetY: offset.default(0),
    sizeFactor: z.number().finite().min(0.2).max(3).default(0.6),
  }).strict()).superRefine(arrayAtMost(8)).default([]),
  // Empty/absent frames the whole source. Named targets frame a close-up in XR.
  focus: z.array(target).superRefine(arrayAtMost(8)).superRefine((v,ctx) => { if(!v.length) ctx.addIssue({code:'custom',message:'Figure focus needs at least one target.'}); }).optional(),
}).strict().superRefine((v, ctx) => {
  const ids = [...v.layers, ...v.labels, ...v.distances].map(item => item.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Figure ids must be unique.' });
  if (v.layers.every(layer => layer.context)) ctx.addIssue({ code: 'custom', message: 'A figure needs a substantive layer.' });
  for (const [i, layer] of v.layers.entries()) if (layer.context && layer.opacity > .2)
    ctx.addIssue({ code: 'custom', path: ['layers', i, 'context'], message: 'Context layers must have opacity at most 0.2.' });
  for (const [i, distance] of v.distances.entries()) for (const end of ['a', 'b'] as const) {
    const t = distance[end];
    const numbers = t.residueNumbers?.filter(n => !t.residues || n >= t.residues.from && n <= t.residues.to);
    const singleResidue = numbers ? numbers.length === 1 : t.residues?.from === t.residues?.to && t.residues !== undefined;
    if (!t.atomName || !singleResidue)
      ctx.addIssue({ code: 'custom', path: ['distances', i, end], message: 'A distance endpoint must identify one residue and atom.' });
  }
});
export type LessonFigure = z.infer<typeof lessonFigureSchema>;
