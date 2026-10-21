/**
 * One command from a terminal to a checked-in cinematic demo on a Meta Quest.
 *
 * `pnpm --dir plugin run demo hemoglobin` validates the authored lesson against
 * the lesson contract, resolves its coordinates into a cache outside this
 * repository, checks the recorded SHA-256, and then hands the whole thing to
 * `scripts/quest-share.ts` unchanged. Every quest-share flag passes through.
 *
 * This script owns no sharing behaviour of its own. It never prints a pairing
 * code, an address, or anything else quest-share does not print itself.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeRecipePath, resolveCompositeText } from '../src/demo-composite-cache.js';
import { readBundledDemoCoordinates } from '../src/bundled-demo-coordinates.js';
import { writeVerifiedCacheFile } from '../src/verified-cache-write.js';
import { addressedDemoPath, readAddressedDemoFile } from '../src/addressed-demo-cache.js';
import { encodeMap, prepareMap, readMap } from './prepare-map.js';
import { parseQuestArgs } from './quest-share.js';
import { DEMO_TIER_BY_DEVICE, stageFitsTier } from '../src/molecular-growth.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { parseMolecularLesson, type MolecularLessonManifest } from '../src/molecular-lesson.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const demosRoot = resolve(pluginRoot, 'demos');

export const usage = `Usage: pnpm --dir plugin run demo <demo name> [quest-share options]

  --list                            print the demos, their stages and what each one shows
  --stage <stage id>                play one tier of a staged demo (see --list)
  --device <class>                  pick the largest tier that class can hold
                                    (quest2, quest3, quest-pro, vision-pro, unknown)
  --help

The headset microphone and the Meta Web Launch link are on by default; --no-ptt
and --no-web-launch turn them off. Every other option is passed to quest-share
unchanged, including --headless, --browser <application>,
--web-launch[=code|=no-code], --open-on-quest[=no-code], --allow-stale-build,
--lan-host, --lan-port, --state and --no-remember.`;

export type DemoSource = { title: string; url: string; doi?: string };
/**
 * How cached coordinates are selected or rigidly placed from deposited sources.
 */
export type DemoDerivation =
  | { kind: 'assembly-operator-subset'; operators: string[]; ofOperators: number }
  | { kind: 'deposited-chain-subset'; chains: string[]; entityIds: string[] }
  | { kind: 'prepared-rigid-composite'; recipe: string }
  | { kind: 'bundled-file'; path: string };
/**
 * `assemblyId` names a biological assembly the entry itself declares. The
 * asymmetric unit is what travels and Mol* builds the repeats from the entry's
 * own operator list, so a 775 KB file can open as a 177,268-site assembly that
 * no expanded coordinate file could carry through the source-byte budget.
 */
/**
 * What a `volume` tier carries instead of atom sites.
 *
 * A density map has no atoms, so none of the atomic budgets describe it. What
 * decides whether a headset can hold one is the triangle count its isosurface
 * meshes to at the recorded contour, and that number is measured on the
 * PREPARED map (the one in the cache), never estimated from the deposited one.
 *
 * `contour` is the level on the prepared map. It is not the deposited map's
 * recommended contour and must not be copied from it: mean-downsampling is a
 * low-pass filter, so it lowers the peaks and the RMS together, and the level
 * that keeps the deposited contour's SIGMA is the one that keeps its shape.
 * EMD-6347 recommends 5.0 on a map whose RMS is 0.9139 — 5.46 sigma — and the
 * 4x map's RMS is 0.6016, so the same sigma is 3.3 there. Meshing the prepared
 * map at 5.0 instead leaves a perforated shell of the densest cores.
 */
export type DemoVolume = {
  /** The EMDB accession the map is deposited under, e.g. `EMD-6347`. */
  emdbId: string;
  /** The digest of the download, before preparation. */
  downloadSha256: string;
  /** Mean-downsample factor applied by `scripts/prepare-map.ts`. */
  downsample: number;
  grid: [number, number, number];
  voxelAngstroms: number;
  /** The absolute isosurface level on the PREPARED map. */
  contour: number;
  /** The deposited map's own recommended contour, and what it is in sigma. */
  depositedContour: number;
  contourSigma: number;
  /** Measured with Mol*'s own marching cubes on the prepared map at `contour`. */
  triangles: number;
  /**
   * The coordinates a density tier opens BESIDE.
   *
   * The map is what the wearer sees, and nothing here draws atoms. But an
   * inspection session is built on coordinates from end to end — the catalog,
   * the residue rows, the assembly, every budget and every agent query — and a
   * map has none of those. This field supplies a related coordinate model
   * for the session catalog. EMD-6347 uses 3JAK from the same study; RCSB links
   * that model to EMD-6349, so it is not an exact map/model pairing. The page
   * draws the map alone. Residue queries describe the reference model and
   * must not be presented as fitted positions in the displayed density.
   */
  structure: {
    file: string;
    sha256: string;
    bytes: number;
    atomSites: number;
    catalogRows: number;
    download: string;
  };
};
export type DemoCoordinates = { file: string; sha256: string; bytes: number; atomSites: number; catalogRows?: number } & (
  | { derivation: Extract<DemoDerivation, { kind: 'prepared-rigid-composite' | 'bundled-file' }>; download?: string; assemblyId?: never; volume?: never }
  | { assemblyId?: string; download: string; derivation?: Exclude<DemoDerivation, { kind: 'prepared-rigid-composite' | 'bundled-file' }>; volume?: DemoVolume }
);
/** The device classes `input-capabilities.mjs` reports, as a demo tier list. */
export type DemoTier = 'quest2' | 'quest3';
export type DemoStage = {
  id: string; order: string; title: string; pdbId?: string; sourceId?: string; tiers: DemoTier[];
  lesson: string; coordinates: DemoCoordinates; sources: DemoSource[];
};
export type DemoEntry = {
  name: string;
  title: string;
  pdbId?: string;
  /** Public source identifier when the coordinates are not a PDB entry. */
  sourceId?: string;
  lesson: string;
  coordinates: DemoCoordinates;
  sources: DemoSource[];
  /** A staged demo grows one subject across several sources; each stage is a whole lesson. */
  stages?: DemoStage[];
  defaultStage?: string;
  /** Sequential batches start at their authored opening instead of their largest tier. */
  stageMode?: 'sequence';
};
export type DemoIndex = { version: 1; cacheDirectory: string; demos: DemoEntry[] };

/**
 * Which tier a paired headset can hold. The map lives beside the in-session
 * growth rules in `src/molecular-growth.ts`, because the running server has to
 * apply the same budget when the wearer says "grow it"; this re-export keeps
 * the demo CLI's own name for it.
 */
export { DEMO_TIER_BY_DEVICE };

/** The stage view of an entry: its own lesson and coordinates, or one named stage's. */
export function resolveDemoStage(entry: DemoEntry, stageId?: string): { entry: DemoEntry; stage?: DemoStage } {
  if (!stageId) return { entry, stage: entry.stages?.find(stage => stage.id === entry.defaultStage) };
  const stages = entry.stages ?? [];
  if (stages.length === 0) throw Error(`Demo "${entry.name}" has no stages; drop --stage.`);
  const stage = stages.find(candidate => candidate.id === stageId);
  if (!stage) throw Error(`Unknown stage "${stageId}" for ${entry.name}. It has ${stages.map(candidate => candidate.id).join(', ')}.`);
  return { entry: { ...entry, pdbId: stage.pdbId, sourceId: stage.sourceId, lesson: stage.lesson, coordinates: stage.coordinates, sources: stage.sources }, stage };
}

/** The largest stage this device class can hold, or the entry's own default. */
export function stageForDevice(entry: DemoEntry, deviceClass: string): string | undefined {
  const stages = entry.stages;
  if (!stages?.length) return undefined;
  const tier = prefetchTier(deviceClass);
  const allowed = stages.filter(stage => stageFitsTier(stage, tier));
  if (!allowed.length) throw Error(`No stage of demo "${entry.name}" fits device class "${deviceClass}" (tier ${tier}).`);
  if (entry.stageMode === 'sequence') return allowed.find(stage => stage.id === entry.defaultStage)?.id ?? allowed[0].id;
  // Alternate presentations of identical coordinates have no larger tier to
  // prefer. Keep their authored default while still enforcing device admission.
  const coordinateIdentity = (stage: DemoStage) => JSON.stringify([
    stage.coordinates.sha256, stage.coordinates.assemblyId ?? null, stage.coordinates.volume ?? null,
  ]);
  const identity = coordinateIdentity(stages[0]);
  if (stages.every(stage => coordinateIdentity(stage) === identity)) {
    const preferred = allowed.find(stage => stage.id === entry.defaultStage);
    if (preferred) return preferred.id;
  }
  return allowed[allowed.length - 1].id;
}

/**
 * The coordinate tier an explicit device class is allowed to hold. Only
 * `quest2` is held to a ceiling; an explicit `unknown` (or anything
 * unrecognised) warms every tier, because nothing measured says it cannot. This is only the launcher's per-class mapping: the running
 * server decides a grow from the device class the panel reports
 * (`headsetDeviceClass` in `src/inspector.ts`), not from this flag, so a
 * launch with no `--device` warms the union of every class's tiers instead of
 * assuming the smallest.
 */
export function prefetchTier(deviceClass?: string): DemoTier {
  return DEMO_TIER_BY_DEVICE[deviceClass ?? 'unknown'] ?? 'quest3';
}

/**
 * Every lesson entry whose coordinates the launcher warms into the demo cache
 * before the headset goes on.
 *
 * Growing happens inside one session: `grow_structure` swaps to whichever tier
 * the wearer names, and a tier whose coordinates were never fetched fails
 * mid-session ("run the demo once on this Mac"). So a staged demo resolves
 * every tier the selected device class allows up front — the same tier list
 * `stageForDevice` chooses from — plus the selected stage itself when it sits
 * outside that tier (e.g. `--stage tube` on a quest2 device). A plain demo has
 * no tiers and warms exactly what it opens.
 *
 * With no `--device` the launcher cannot know what the wearer will grow into:
 * the running server decides a grow from the device class the panel reports,
 * not from this flag. So the no-flag case warms the union of every device
 * class's tiers (every stage), while an explicit `--device` — `unknown`
 * included — keeps that class's own set.
 */
export function prefetchEntries(
  found: DemoEntry,
  selected: { entry: DemoEntry; stage?: DemoStage },
  deviceClass?: string,
): DemoEntry[] {
  const stages = found.stages;
  if (!stages?.length) return [selected.entry];
  const tier = deviceClass === undefined ? undefined : prefetchTier(deviceClass);
  const prefetches: DemoEntry[] = [selected.entry];
  const seen = new Set([selected.entry.lesson]);
  for (const candidate of stages) {
    if (tier !== undefined && !stageFitsTier(candidate, tier)) continue;
    const resolved = resolveDemoStage(found, candidate.id).entry;
    if (seen.has(resolved.lesson)) continue;
    seen.add(resolved.lesson);
    prefetches.push(resolved);
  }
  return prefetches;
}

/** One prefetched tier the launcher could not warm, and why. */
export type SkippedPrefetch = { lesson: string; reason: string };

/** What warming the prefetched tiers left behind. */
export type WarmedPrefetches = {
  coordinates: string;
  selectedStructure?: string;
  warmed: string[];
  skipped: SkippedPrefetch[];
};

/** The per-tier work `warmPrefetches` performs, injectable for tests. */
export type PrefetchWarmer = {
  readLesson?: (entry: DemoEntry) => Promise<unknown>;
  resolveCoordinates?: (entry: DemoEntry, cache: string, log: (message: string) => void) => Promise<string>;
  resolveStructure?: (entry: DemoEntry, cache: string, log: (message: string) => void) => Promise<string>;
};

/**
 * Warm every prefetched tier into the cache. The selected stage must resolve:
 * its failure throws, exactly as a lone resolve did before. Every other tier
 * is best-effort — a transient network miss or SHA-256 mismatch on a tier the
 * wearer may never grow into logs one line naming the tier and the reason and
 * the launch continues. Ends with a summary of what warmed and what did not.
 */
export async function warmPrefetches(
  prefetches: readonly DemoEntry[],
  selectedLesson: string,
  cache: string,
  log: (message: string) => void,
  warmer: PrefetchWarmer = {},
): Promise<WarmedPrefetches> {
  const readLesson = warmer.readLesson ?? readDemoLesson;
  const resolveCoords = warmer.resolveCoordinates ?? ((entry: DemoEntry) => resolveCoordinates(entry, cache, log));
  const resolveStruct = warmer.resolveStructure ?? ((entry: DemoEntry) => resolveVolumeStructure(entry, cache, log));
  let coordinates = '';
  let selectedStructure: string | undefined;
  const warmed: string[] = [];
  const skipped: SkippedPrefetch[] = [];
  for (const target of prefetches) {
    const selected = target.lesson === selectedLesson;
    try {
      await readLesson(target);
      log(`  lesson validated · ${target.lesson}`);
      const targetCoordinates = await resolveCoords(target, cache, log);
      const targetStructure = target.coordinates.volume
        ? await resolveStruct(target, cache, log) : undefined;
      warmed.push(target.lesson);
      if (selected) {
        coordinates = targetCoordinates;
        selectedStructure = targetStructure;
      }
    } catch (error) {
      if (selected) throw error;
      const reason = (error as Error).message;
      skipped.push({ lesson: target.lesson, reason });
      log(`  prefetch skipped · ${target.lesson} · ${reason}`);
    }
  }
  if (coordinates === '') throw Error(`The selected lesson ${selectedLesson} was not prefetched.`);
  if (prefetches.length > 1) {
    log(skipped.length === 0
      ? `  prefetch complete · warmed ${warmed.length} of ${prefetches.length} tiers`
      : `  prefetch complete · warmed ${warmed.length} of ${prefetches.length} tiers · skipped ${skipped.length}: ${skipped.map(entry => entry.lesson).join(', ')}`);
  }
  return { coordinates, selectedStructure, warmed, skipped };
}

/** The cache lives outside the checkout: coordinates are downloads, not sources. */
export function demoCacheDirectory(home: string = homedir()): string {
  return resolve(home, 'Library/Caches/Stereofold/demos');
}

export async function readDemoIndex(root: string = demosRoot): Promise<DemoIndex> {
  const index = JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')) as DemoIndex;
  if (index.version !== 1 || !Array.isArray(index.demos) || index.demos.length === 0) throw Error('plugin/demos/index.json is not a demo index.');
  return index;
}

export async function readDemoLesson(entry: DemoEntry, root: string = demosRoot): Promise<MolecularLessonManifest> {
  const manifest = parseMolecularLesson(JSON.parse(await readFile(resolve(root, entry.lesson), 'utf8')));
  // Refuse here rather than in the headset: a chapter with no immersive intent
  // cannot become a tour step, and quest-share would only report a missing tour.
  molecularLessonToTour(manifest);
  if (manifest.provenance.sourceSha256 !== entry.coordinates.sha256)
    throw Error(`Demo ${entry.name}: the lesson provenance SHA-256 and the index coordinate SHA-256 disagree.`);
  return manifest;
}

function describeScope(coordinates: DemoCoordinates): string {
  const volume = coordinates.volume;
  if (volume) return ` · ${volume.emdbId} density, ${volume.downsample}x mean-downsampled, contour ${volume.contour}`;
  if (coordinates.assemblyId) return ` · assembly ${coordinates.assemblyId}, built from the entry's operators`;
  const subset = coordinates.derivation;
  if (subset?.kind === 'bundled-file') return ` · bundled coordinates from ${subset.path}`;
  if (subset?.kind === 'prepared-rigid-composite') return ` · rigid composite from ${subset.recipe}`;
  if (subset?.kind === 'assembly-operator-subset') return ` · ${subset.operators.length} of ${subset.ofOperators} assembly operators`;
  if (subset?.kind === 'deposited-chain-subset') return ` · deposited chain${subset.chains.length === 1 ? '' : 's'} ${subset.chains.join(', ')}`;
  return '';
}

/** How big a tier is, in whatever unit it is actually measured in. */
export function describeSize(coordinates: DemoCoordinates): string {
  return coordinates.volume
    ? `${coordinates.volume.triangles.toLocaleString()} triangles`
    : `${coordinates.atomSites.toLocaleString()} atom sites`;
}

export function formatDemoList(index: DemoIndex): string {
  const width = Math.max(...index.demos.map(demo => demo.name.length));
  return index.demos.map(demo => {
    const head = `  ${demo.name.padEnd(width)}  ${demo.pdbId ?? demo.sourceId ?? 'Local coordinates'}  ${demo.title}${demo.stages ? '' : describeScope(demo.coordinates)}`;
    if (!demo.stages?.length) return head;
    const stageWidth = Math.max(...demo.stages.map(stage => stage.id.length));
    return [head, ...demo.stages.map(stage =>
      `    ${stage.order} --stage ${stage.id.padEnd(stageWidth)}  ${stage.pdbId ?? stage.sourceId ?? 'Local coordinates'}  ${describeSize(stage.coordinates)}  ${stage.tiers.join('/')}  ${stage.title}${describeScope(stage.coordinates)}`)].join('\n');
  }).join('\n');
}

// The mmCIF chain subsetting lives in src/, because the running server needs
// the same cut when a grow fetches a tier nobody warmed. Re-exported here so
// the launcher and its tests keep one name for it.
export { subsetAssemblyOperators, subsetDepositedEntities } from '../src/demo-cif-subset.js';
import { subsetAssemblyOperators, subsetDepositedEntities } from '../src/demo-cif-subset.js';

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw Error(`${url} returned HTTP ${response.status}.`);
  return await response.text();
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(900_000) });
  if (!response.ok) throw Error(`${url} returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The cached file for a `volume` tier.
 *
 * A deposited map is not what travels. EMD-6347 downloads as 164 MB gzipped
 * and expands to 512 MB of float32, so the cache holds the prepared map
 * instead: cropped and mean-downsampled by `scripts/prepare-map.ts`, with a
 * header rewritten so the isosurface lands in the fitted model's own angstrom
 * frame. Both digests are checked — the download against `downloadSha256`, so
 * a re-deposited map is caught before it is prepared, and the prepared bytes
 * against `sha256`, which is the digest the lesson provenance carries and the
 * headset verifies.
 */
async function prepareVolumeCoordinates(entry: DemoEntry, path: string, log: (message: string) => void): Promise<void> {
  if (!entry.coordinates.volume || !entry.coordinates.download) throw Error(`Demo ${entry.name}: no density download recorded.`);
  const volume = entry.coordinates.volume!;
  log(`  fetching ${entry.coordinates.download}`);
  const downloaded = await fetchBytes(entry.coordinates.download);
  const downloadSha256 = createHash('sha256').update(downloaded).digest('hex');
  if (downloadSha256 !== volume.downloadSha256)
    throw Error(`Demo ${entry.name}: ${entry.coordinates.download} no longer serves the map this demo records (${downloadSha256}).`);
  log(`  mean-downsampling ${volume.emdbId} by ${volume.downsample}`);
  const prepared = prepareMap(readMap(downloaded), { downsample: volume.downsample, label: `${volume.emdbId} mean-downsampled ${volume.downsample}x for Stereofold` });
  const grid = [prepared.header.columns, prepared.header.rows, prepared.header.sections];
  if (grid.some((value, axis) => value !== volume.grid[axis]))
    throw Error(`Demo ${entry.name}: preparing ${volume.emdbId} gave a ${grid.join('x')} grid, not the ${volume.grid.join('x')} the index records.`);
  await writeVerifiedCacheFile(path, encodeMap(prepared), entry.coordinates.sha256);
}

/**
 * Resolve the demo's coordinates in the cache, downloading them once. The
 * recorded SHA-256 is the whole check: a file that does not match it is not the
 * structure the captions describe.
 */
export async function resolveCoordinates(entry: DemoEntry, cache: string, log: (message: string) => void,
  hooks: { demosRoot?: string; fetchText?: (url: string) => Promise<string> } = {}): Promise<string> {
  const cachePath = (file: string) => resolve(cache, file);
  const path = addressedDemoPath(cachePath, entry.coordinates.file, entry.coordinates.sha256);
  const digest = async () => createHash('sha256').update(await readFile(path)).digest('hex');
  if (await readAddressedDemoFile(cachePath, entry.coordinates.file, entry.coordinates.sha256)) {
    log(`  coordinates cached · ${entry.coordinates.file}`);
    return path;
  }
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if (entry.coordinates.volume) {
    await prepareVolumeCoordinates(entry, path, log);
    const sha256 = await digest();
    if (sha256 !== entry.coordinates.sha256)
      throw Error(`Demo ${entry.name}: preparing ${entry.coordinates.download} no longer produces the map this demo records (${sha256}).`);
    return path;
  }
  const subset = entry.coordinates.derivation;
  let text: string;
  if (subset?.kind === 'bundled-file') {
    log(`  reading bundled coordinates ${subset.path}`);
    text = await readBundledDemoCoordinates(subset.path, entry.coordinates.sha256, hooks.demosRoot ?? demosRoot);
  } else if (subset?.kind === 'prepared-rigid-composite') {
    text = await resolveCompositeText(compositeRecipePath(subset.recipe, hooks.demosRoot ?? demosRoot), {
      demosRoot: hooks.demosRoot ?? demosRoot, cachePath: file => resolve(cache, file), fetchText: hooks.fetchText ?? fetchText, log,
    });
  } else {
    if (!entry.coordinates.download) throw Error(`Demo ${entry.name}: no coordinate download recorded.`);
    log(`  fetching ${entry.coordinates.download}`);
    text = await (hooks.fetchText ?? fetchText)(entry.coordinates.download);
  }
  if (subset?.kind === 'assembly-operator-subset') {
    text = subsetAssemblyOperators(text, subset.operators);
    log(`  keeping assembly operators ${subset.operators.join(', ')} of ${subset.ofOperators}`);
  } else if (subset?.kind === 'deposited-chain-subset') {
    text = subsetDepositedEntities(text, subset.entityIds);
    log(`  keeping deposited entit${subset.entityIds.length === 1 ? 'y' : 'ies'} ${subset.entityIds.join(', ')} as chain${subset.chains.length === 1 ? '' : 's'} ${subset.chains.join(', ')}`);
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  if (sha256 !== entry.coordinates.sha256)
    throw Error(`Demo ${entry.name}: ${subset?.kind === 'prepared-rigid-composite' ? subset.recipe : entry.coordinates.download} no longer produces the coordinates this demo records (${sha256}).`);
  // Write beside the target and rename, so an interrupted download never leaves
  // a half file that matches nothing and is fetched again on every run.
  await writeVerifiedCacheFile(path, text, entry.coordinates.sha256);
  return path;
}

/**
 * The coordinates a density tier opens beside, in the cache.
 *
 * A volume tier's own `coordinates` are the map, and `resolveCoordinates` above
 * prepares that. This resolves the OTHER half — the deposited model of the same
 * specimen, which the session is actually built on. It is an ordinary mmCIF
 * download checked against its recorded digest, so it is the plain path above
 * with the derivation steps removed: a volume tier's structure is never a
 * subset, because it is not the thing being drawn.
 */
export async function resolveVolumeStructure(entry: DemoEntry, cache: string, log: (message: string) => void): Promise<string> {
  const structure = entry.coordinates.volume?.structure;
  if (!structure) throw Error(`Demo ${entry.name} is not a density tier, so it has no accompanying structure.`);
  const cachePath = (file: string) => resolve(cache, file);
  const path = addressedDemoPath(cachePath, structure.file, structure.sha256);
  const digest = async () => createHash('sha256').update(await readFile(path)).digest('hex');
  if (await readAddressedDemoFile(cachePath, structure.file, structure.sha256)) { log(`  structure cached · ${structure.file}`); return path; }
  await mkdir(cache, { recursive: true, mode: 0o700 });
  log(`  fetching ${structure.download}`);
  await writeVerifiedCacheFile(path, await fetchText(structure.download), structure.sha256);
  const sha256 = await digest();
  if (sha256 !== structure.sha256)
    throw Error(`Demo ${entry.name}: ${structure.download} no longer serves the coordinates this demo records (${sha256}).`);
  return path;
}

export async function main(argv: readonly string[], log: (message: string) => void = message => process.stdout.write(`${message}\n`)): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { log(usage); return 0; }
  const index = await readDemoIndex();
  if (args[0] === '--list') {
    log('Stereofold demos');
    log(formatDemoList(index));
    log('');
    log('Run one with: pnpm --dir plugin run demo <name> [quest-share options]');
    return 0;
  }
  const [name, ...rest] = args;
  const found = index.demos.find(demo => demo.name === name);
  if (!found) throw Error(`Unknown demo "${name}". Run with --list to see them.`);
  if (rest.some(argument => argument === '--lesson' || argument === '--tour')) throw Error('A demo supplies its own lesson; --lesson and --tour are not available here.');
  // --stage and --device are this script's own; everything else goes through.
  const passthrough: string[] = [];
  let stageId: string | undefined, deviceClass: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument !== '--stage' && argument !== '--device') { passthrough.push(argument); continue; }
    const value = rest[++index];
    if (!value || value.startsWith('-')) throw Error(`${argument} needs a value.`);
    if (argument === '--stage') stageId = value; else deviceClass = value;
  }
  if (stageId && deviceClass) throw Error('Pass --stage or --device, not both: --device is how the tier gets chosen when no stage is named.');
  const wanted = stageId ?? (deviceClass ? stageForDevice(found, deviceClass) : undefined);
  const { entry, stage } = resolveDemoStage(found, wanted);

  log(`Stereofold demo · ${found.title}`);
  if (stage) log(`  stage ${stage.order} · ${stage.id} · ${stage.title} · ${describeSize(stage.coordinates)}`);
  if (deviceClass) log(`  ${deviceClass} holds tier ${prefetchTier(deviceClass)}`);
  // Warm every tier the wearer may grow into before the headset goes on: a
  // grow whose coordinates are not cached fails mid-session with the
  // cache-miss sentence, after the wearer is already in VR. The selected
  // stage must resolve; every other tier is best-effort (see warmPrefetches).
  const prefetches = prefetchEntries(found, { entry, stage }, deviceClass);
  if (prefetches.length > 1) {
    if (deviceClass === undefined) log(`  prefetching ${prefetches.length} tiers for every device class (no --device; union of all tiers)`);
    else log(`  prefetching ${prefetches.length} tiers this ${deviceClass} device allows (tier ${prefetchTier(deviceClass)})`);
  }
  const cache = demoCacheDirectory();
  const warmed = await warmPrefetches(prefetches, entry.lesson, cache, log);
  if (warmed.coordinates === '') throw Error(`Demo ${found.name}: the selected lesson ${entry.lesson} was not prefetched.`);
  const coordinates = warmed.coordinates;
  const selectedStructure = warmed.selectedStructure;
  // The index knows how big this stage is, so hand that on.
  // quest-share's wait for the panel's first saved scene scales with it; a flat
  // 120 s is what the 43,066-site `tip` stage overran. A caller
  // that passed its own --atom-sites or --panel-timeout keeps it.
  // A volume tier has no atom sites to scale that wait by, and
  // `--atom-sites 0` is a flag quest-share refuses outright.
  const sized = entry.coordinates.volume || passthrough.some(argument => argument === '--atom-sites' || argument === '--panel-timeout')
    ? [] : ['--atom-sites', String(entry.coordinates.atomSites)];
  // A density tier hands the host two files. The positional is
  // the deposited model the session opens on, and `--density` is the map the
  // headset page is actually given to draw. The map is never the positional:
  // the host admits only .cif/.mmcif there, and rightly so. Both were warmed
  // into the cache by the prefetch loop above; the selected tier's pair is
  // what travels.
  const volumeStructure = selectedStructure;
  const questArgs = [volumeStructure ?? coordinates, '--lesson', resolve(demosRoot, entry.lesson),
    ...(volumeStructure ? ['--density', coordinates] : []),
    ...(entry.coordinates.assemblyId ? ['--assembly', entry.coordinates.assemblyId] : []), ...sized, ...passthrough];
  // Fail on a bad flag here, before a host, a browser and a listener start.
  parseQuestArgs(questArgs);
  log(`  handing over to quest-share`);
  log('');
  // Run the TypeScript file in this process layer. The tsx CLI adds another
  // signal-relaying process which can force-kill the sharing launcher before
  // it reaps its detached host and closes the private listener.
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(pluginRoot, 'scripts/quest-share.ts'), ...questArgs], { cwd: pluginRoot, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => { if (child.exitCode == null) child.kill(signal); };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  return await new Promise<number>(done => child.on('exit', code => done(code ?? 1)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exit(1); }
}
