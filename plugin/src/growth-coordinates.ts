/**
 * Getting a tier's coordinates in hand, on a Mac that has never run the demo.
 *
 * Growing is one session: `grow_structure` swaps the wearer from one tier of a
 * staged demo to the next without leaving VR. Every tier is its own coordinate
 * file, and those files are downloads, so they live in the demo cache and not
 * in this repository.
 *
 * Before this module a tier nobody had warmed failed the grow outright: the
 * wearer asked for the wall, the cache had no wall, and the session said "run
 * the demo once on this Mac". On a fresh machine that is every tier, which
 * made "grow it" a feature only the author had. So a missing tier is fetched
 * here, from the public address the demo index already records, and checked
 * against the digest the index already carries. The wearer hears one short
 * line while it downloads.
 *
 * A density tier is the exception. Its download is a 164 MB gzipped map that
 * has to be mean-downsampled before anything can draw it, which is minutes of
 * work and gigabytes of memory. That is a job for the launcher, so a density
 * tier that is not in the cache is refused with the command that prepares it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { subsetAssemblyOperators, subsetDepositedEntities } from './demo-cif-subset.js';
import { demoCoordinatePath } from './molecular-growth.js';
import { GROWTH_FETCH_TIMEOUT_MS } from './inspection-limits.js';
// Types only: the demo index shapes live with the launcher that writes them.
import type { DemoDerivation } from '../scripts/quest-demo.js';

/** Long enough for a 20 MB assembly on a slow link, short enough to give up. */
export { GROWTH_FETCH_TIMEOUT_MS };
/** The largest tier download is the 26-operator assembly; this is well past it. */
export const GROWTH_FETCH_MAX_CHARS = 64 * 1024 * 1024;

/** What the wearer hears while a tier downloads. Eight words, because it is spoken. */
export const GROWTH_FETCH_SPOKEN = 'Fetching those coordinates now. Give me a moment.';

export type GrowthCoordinateRequest = {
  demo: string;
  stageId: string;
  file: string;
  sha256: string;
  download: string;
  derivation?: DemoDerivation;
  /**
   * True for a density map, which the launcher prepares and this session will
   * not. A prepared tier is only ever read from the cache.
   */
  prepared?: boolean;
};

export type GrowthCoordinateHooks = {
  /** Where the cache keeps a file. Defaults to the shared demo cache. */
  cachePath?: (file: string) => string;
  /** Test seam; defaults to one bounded https GET. */
  fetchText?: (url: string) => Promise<string>;
  /** Called once, before the download starts. Speaks and prints. */
  announce?: (notice: { spoken: string; printed: string }) => void;
};

export type GrowthCoordinateResult = { path: string; text: string; fetched: boolean; fetchedAt: number | null };

/** The one command that warms a tier from a terminal. */
export function growthRecoveryCommand(demo: string, stageId: string): string {
  return `pnpm --dir plugin run demo ${demo} --stage ${stageId}`;
}

/** One sentence, then the command that fixes it. */
export function growthFetchFailure(request: GrowthCoordinateRequest, detail: string): Error {
  return Error(`The ${request.stageId} coordinates could not be fetched from ${request.download}: ${detail} `
    + `Run ${growthRecoveryCommand(request.demo, request.stageId)} on this Mac, then grow.`);
}

async function boundedFetchText(url: string): Promise<string> {
  if (!url.startsWith('https://')) throw Error(`${url} is not an https download.`);
  const response = await fetch(url, { signal: AbortSignal.timeout(GROWTH_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw Error(`it returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text || text.length > GROWTH_FETCH_MAX_CHARS) throw Error('it returned nothing usable.');
  return text;
}

const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Cut the download down to the chains this tier shows, if it is a subset. */
export function applyGrowthDerivation(text: string, derivation?: DemoDerivation): string {
  if (!derivation) return text;
  if (derivation.kind === 'assembly-operator-subset') return subsetAssemblyOperators(text, derivation.operators);
  if (derivation.kind === 'deposited-chain-subset') return subsetDepositedEntities(text, derivation.entityIds);
  return text;
}

/**
 * The tier's coordinates, fetching them once if this Mac does not have them.
 *
 * The digest the index records is the whole check, before and after the
 * download. A file that does not match it is not the structure the captions
 * describe, so it is never handed to the headset.
 */
export async function ensureGrowthCoordinates(
  request: GrowthCoordinateRequest,
  hooks: GrowthCoordinateHooks = {},
): Promise<GrowthCoordinateResult> {
  const path = (hooks.cachePath ?? demoCoordinatePath)(request.file);
  const cached = await stat(path).then(entry => entry.isFile(), () => false);
  if (cached) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text !== undefined && digestOf(text) === request.sha256) return { path, text, fetched: false, fetchedAt: null };
  }
  if (request.prepared) {
    throw Error(`The ${request.stageId} density map is not in the demo cache, and preparing it is too big a job for a live session. `
      + `Run ${growthRecoveryCommand(request.demo, request.stageId)} on this Mac, then grow.`);
  }
  (hooks.announce ?? announceToStderr)({
    spoken: GROWTH_FETCH_SPOKEN,
    printed: `Fetching the ${request.stageId} coordinates from ${request.download}. The grow continues when they land.`,
  });
  let text: string;
  let fetchedAt: number;
  try {
    const downloaded = await (hooks.fetchText ?? boundedFetchText)(request.download);
    fetchedAt = Date.now();
    text = applyGrowthDerivation(downloaded, request.derivation);
  } catch (error) {
    throw growthFetchFailure(request, error instanceof Error ? error.message : 'the download failed.');
  }
  const sha256 = digestOf(text);
  if (sha256 !== request.sha256) {
    throw Error(`${request.download} no longer serves the ${request.stageId} coordinates this demo records (${sha256}). `
      + `Update the plugin, or run ${growthRecoveryCommand(request.demo, request.stageId)} to see the same mismatch from a terminal.`);
  }
  // Write beside the target and rename, so an interrupted download never
  // leaves a half file that matches nothing and is fetched again every time.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = resolve(`${path}.partial`);
  await writeFile(staging, text, { mode: 0o600 });
  await rename(staging, path);
  return { path, text, fetched: true, fetchedAt };
}

/** stdout is the MCP transport, so a progress line goes to stderr. */
function announceToStderr(notice: { spoken: string; printed: string }): void {
  console.error(notice.printed);
}
