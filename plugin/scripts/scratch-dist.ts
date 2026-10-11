/**
 * The guard in front of the one recursive delete this repository performs.
 *
 * `scripts/build.ts --out <dir>` empties its output directory first, and the
 * directory comes from a command line, an environment variable, or a caller's
 * scratchpad path. The old test for "is this a dist I may delete" was that the
 * directory held `viewer.html` or `server.mjs`, which is a test any checkout of
 * any web project passes: pointing `--out` at a source tree that happened to
 * hold either name would have deleted it whole, and the person who typed it
 * would have had no warning.
 *
 * So a build no longer recognises its own output by guesswork. It writes a
 * marker file into every scratch dist it creates and deletes only what carries
 * that marker or is already empty. Nothing else is touched, and the refusal
 * says what to do about it. The marker is written before the bundles are, so a
 * build that crashes halfway still leaves a directory the next build may
 * replace.
 *
 * `plugin/dist` is not covered here: it is this package's own build output,
 * never a path a caller chose. `replace-dist.ts` swaps it for a new build.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The file a Stereofold scratch build leaves behind to identify its own output. */
export const SCRATCH_DIST_MARKER = '.stereofold-dist';

export type ScratchDistPlan = { action: 'create' } | { action: 'replace'; reason: 'empty' | 'marked' };

/**
 * What to do with an output directory, given its entries, or `undefined` when
 * it does not exist. Throws the refusal a person reads when it is someone
 * else's directory.
 */
export function planScratchDist(distRoot: string, entries: readonly string[] | undefined): ScratchDistPlan {
  if (entries === undefined) return { action: 'create' };
  if (entries.length === 0) return { action: 'replace', reason: 'empty' };
  if (entries.includes(SCRATCH_DIST_MARKER)) return { action: 'replace', reason: 'marked' };
  throw new Error(`Refusing to delete ${distRoot}: it is not empty and holds no ${SCRATCH_DIST_MARKER} marker, `
    + 'so this build did not create it. Build into a new or empty directory, or remove that one yourself first.');
}

/** Read a directory as `planScratchDist` wants it: entries, or nothing when absent. */
export async function readDistEntries(distRoot: string): Promise<string[] | undefined> {
  return await readdir(distRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

/** The marker's content: enough to say which build wrote it, and nothing private. */
export function scratchDistMarker(input: { at?: string; buildId?: string } = {}): string {
  return `${JSON.stringify({ tool: 'stereofold-build', at: input.at ?? new Date().toISOString(),
    ...(input.buildId ? { buildId: input.buildId } : {}) }, null, 2)}\n`;
}

/** Whether this directory is one a Stereofold build wrote and may replace. */
export async function isScratchDist(distRoot: string): Promise<boolean> {
  try { return JSON.parse(await readFile(resolve(distRoot, SCRATCH_DIST_MARKER), 'utf8')).tool === 'stereofold-build'; }
  catch { return false; }
}

/**
 * Empty a scratch output directory, or refuse to. Returns the plan it acted on
 * so a caller can say which of the two happened.
 */
export async function prepareScratchDist(distRoot: string): Promise<ScratchDistPlan> {
  const plan = planScratchDist(distRoot, await readDistEntries(distRoot));
  // The name alone is not the marker: a file someone else left under that name
  // must not authorise a recursive delete. Its content is checked too.
  if (plan.action === 'replace' && plan.reason === 'marked' && !await isScratchDist(distRoot)) {
    throw new Error(`Refusing to delete ${distRoot}: its ${SCRATCH_DIST_MARKER} was not written by a Stereofold build.`);
  }
  if (plan.action === 'replace') await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  await writeFile(resolve(distRoot, SCRATCH_DIST_MARKER), scratchDistMarker());
  return plan;
}
