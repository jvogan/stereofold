import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sceneSchema, type InspectionScene } from './inspection-contract.js';

/**
 * The cinematic panel and the full Mol* viewer are two views of one structure,
 * not two synchronized sessions. A handoff is therefore a bounded one-shot
 * artifact: the exact coordinate bytes the panel is showing plus the saved
 * inspection scene, written once and read once by the detailed page.
 *
 * Nothing here is a Mol* state tree. Stereofold's appearance vocabulary is
 * already Mol*'s own (`cartoon`, `chain-id` and the rest are the stock
 * representation and color-theme names), so the detailed page rebuilds the
 * scene through the public builder API instead of replaying a hand-written
 * state snapshot that would break on any Mol* version bump.
 *
 * The return leg is different in kind: the full viewer's own Download State
 * produces a real `.molj`, and `detailed-view-import` reads that.
 */
export const DETAILED_VIEW_VERSION = 1;
export const DETAILED_VIEW_SNAPSHOT_ID = /^[a-f0-9]{32}$/;
export const detailedViewSnapshotIdSchema = z.string().regex(DETAILED_VIEW_SNAPSHOT_ID);

export const detailedViewHandoffSchema = z.object({
  version: z.literal(DETAILED_VIEW_VERSION),
  snapshotId: detailedViewSnapshotIdSchema,
  /** Set only for a public PDB source, and only so the page can title itself. */
  pdbId: z.string().regex(/^[0-9a-z]{4}$/i).optional(),
  sourceFormat: z.literal('mmcif'),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  structureText: z.string().min(20),
  scene: sceneSchema,
}).strict();
export type DetailedViewHandoff = z.output<typeof detailedViewHandoffSchema>;

/**
 * Derived from the coordinate digest and the scene, so the same saved
 * inspection reopens the same address instead of accumulating one artifact per
 * click. It is an addressing key, never a capability: the loopback bearer is
 * what authorizes the read.
 */
export function detailedViewSnapshotId(sourceSha256: string, scene: InspectionScene): string {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) throw Error('A detailed view needs the exact coordinate digest.');
  return createHash('sha256').update(`${sourceSha256} ${JSON.stringify(scene)}`, 'utf8').digest('hex').slice(0, 32);
}

export function detailedViewHandoff(input: {structureText: string; sourceSha256: string; scene: InspectionScene; pdbId?: string; densitySha256?: string; tierName?: string}): DetailedViewHandoff {
  // A map can have a seed model cached beside it, but that model is not the
  // saved scene. Never silently open that different structure as this tier.
  if (input.densitySha256 && input.scene.sourceSha256 === input.densitySha256)
    throw Error(`The ${input.tierName || 'density'} tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.`);
  const digest = createHash('sha256').update(input.structureText, 'utf8').digest('hex');
  if (digest !== input.sourceSha256) throw Error('The detailed view coordinates do not match the inspected structure.');
  if (input.scene.sourceSha256 !== input.sourceSha256) throw Error('The saved inspection belongs to a different structure.');
  return detailedViewHandoffSchema.parse({
    version: DETAILED_VIEW_VERSION,
    snapshotId: detailedViewSnapshotId(input.sourceSha256, input.scene),
    ...(input.pdbId ? {pdbId: input.pdbId} : {}),
    sourceFormat: 'mmcif',
    sourceSha256: input.sourceSha256,
    structureText: input.structureText,
    scene: input.scene,
  });
}
