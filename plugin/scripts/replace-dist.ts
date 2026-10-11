/**
 * How `scripts/build.ts` replaces `plugin/dist`.
 *
 * `plugin/dist` is checked in so a fresh clone can launch without building,
 * and a running host serves it. The build used to delete it before bundling,
 * so any failed build (on a fresh clone, one unresolved import was enough)
 * left the checkout with no runtime. Now the build writes into a sibling
 * directory and swaps it in only after every bundle is written. A build that
 * throws leaves the previous dist as it was.
 *
 * Both siblings sit beside the target, so the swap is a rename within one
 * filesystem, and at the same depth, so esbuild computes the same relative
 * paths it would for the target. Their names are fixed, which makes them this
 * build's own: the next build removes whatever an interrupted one left under
 * either name.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

/** The siblings a build of `target` writes into and retires the old copy to. */
export function distSiblings(target: string): { next: string; previous: string } {
  const parent = dirname(target);
  const name = basename(target);
  return { next: resolve(parent, `.${name}-next`), previous: resolve(parent, `.${name}-previous`) };
}

/**
 * Run `build` against an empty sibling of `target`, then swap the result in.
 * `target` is replaced only when `build` resolves; when it throws, the sibling
 * is removed and the error propagates.
 */
export async function replaceDistAfter(target: string, build: (outRoot: string) => Promise<void>): Promise<void> {
  const { next, previous } = distSiblings(target);
  await rm(next, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
  await mkdir(next, { recursive: true });
  try {
    await build(next);
  } catch (error) {
    await rm(next, { recursive: true, force: true });
    throw error;
  }
  await rename(target, previous).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  try {
    await rename(next, target);
  } catch (error) {
    await rename(previous, target).catch(() => undefined);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}
