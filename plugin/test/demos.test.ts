import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileMolecularLesson, MOLECULAR_LESSON_LIMITS, parseMolecularLesson } from '../src/molecular-lesson.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { growthStageOfLesson, growthStages, resolveGrowthTarget, stageFitsTier, QUEST2_TRIANGLE_CEILING } from '../src/molecular-growth.js';
import { MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';
import { availableChains, componentClassesPresent, emptyVisibility, resolveVisibility, sceneVisibilitySchema,
  visibilityHidesEverything } from '../src/inspection-contract.js';
import { compositeRecipePath } from '../src/demo-composite-cache.js';
import { readBundledDemoCoordinates } from '../src/bundled-demo-coordinates.js';
import { readAddressedDemoFile } from '../src/addressed-demo-cache.js';
import { parseRigidCompositeRecipe } from '../src/demo-rigid-composite.js';
import {
  DEMO_TIER_BY_DEVICE,
  demoCacheDirectory,
  formatDemoList,
  prefetchEntries,
  prefetchTier,
  readDemoIndex,
  readDemoLesson,
  resolveDemoStage,
  stageForDevice,
  subsetAssemblyOperators,
  warmPrefetches,
  type DemoCoordinates,
  type DemoEntry,
} from '../scripts/quest-demo.js';

const demosRoot = resolve(new URL('..', import.meta.url).pathname, 'demos');
const index = await readDemoIndex(demosRoot);
const named = (name: string): DemoEntry => {
  const entry = index.demos.find(demo => demo.name === name);
  if (!entry) throw Error(`The demo index has no ${name}.`);
  return entry;
};

/** Cinematic bounds the demos are authored to: four to six scenes, each 8 to 15 seconds. */
const MIN_SCENES = 4, MAX_SCENES = 6, MIN_SCENE_SECONDS = 8, MAX_SCENE_SECONDS = 15;

/**
 * The taught lessons, which are held to a different shape.
 *
 * A cinematic demo shows a structure off in five 8-to-15-second beats. A taught
 * lesson has to let someone find a named part and look at it, which takes 30 to
 * 50 seconds a chapter, and its chapters are named after the parts rather than
 * after the camera move. `crispr-cas9` is the first lesson converted; the other
 * eight demos keep the house arc below until they are converted too.
 */
const TAUGHT_LESSONS = new Set(['crispr-cas9']);
const MIN_TAUGHT_SECONDS = 30, MAX_TAUGHT_SECONDS = 50;
/**
 * A taught lesson may close with a run of short recap callouts.
 *
 * A teaching chapter takes 30 to 50 seconds because the wearer has to find the
 * part before they can look at it. A recap callout names a part they have
 * already been shown, so it is over in a breath. The old closing chapter read
 * as "the complex again, smaller" precisely because it was one long chapter
 * trying to be four.
 * Chapters whose id begins `recap-` are held to this window instead.
 */
const MIN_RECAP_SECONDS = 10, MAX_RECAP_SECONDS = 25, MAX_TAUGHT_SCENES = 10;
const recapChapter = (id: string) => id.startsWith('recap-');
const taught = (unit: Unit) => TAUGHT_LESSONS.has(unit.lessonId);
// The two source-backed illustrations are held for inspection, rather than
// following the five-beat cinematic arc.
const illustrated = (unit: Unit) => unit.lessonId === 'daraxonrasib';
// Arrival reveals deposited copies in one loaded source, then holds a density
// stage. Its timing and chapter sequence are checked separately below.
const arrival = (unit: Unit) => unit.lessonId.startsWith('microtubule-arrival-');
// Motion demos animate rigid bodies between deposited states, or step through
// them as a flipbook. They hold each state for inspection instead of following
// the cinematic arc.
const MOTION_DEMOS = ['hemoglobin-switch', 'kinesin-walk', 'atp-synthase-rotor'];
const gallery = (unit: Unit) => ['binder-gallery','binder-gallery-extended'].includes(unit.entry.name);
const extendedGallery = (unit: Unit) => unit.entry.name === 'binder-gallery-extended';
const motion = (unit: Unit) => MOTION_DEMOS.some(name => unit.lessonId.startsWith(`${name}-`));

/**
 * One playable unit: a plain demo, or one stage of a staged demo. A stage
 * carries its own lesson, coordinates and sources, so every lesson assertion
 * below runs against every tier rather than only the default one.
 */
type Unit = { label: string; lessonId: string; title: string; entry: DemoEntry };
const units: Unit[] = index.demos.flatMap(demo => demo.stages?.length
  ? demo.stages.map(stage => ({ label: `${demo.name} ${stage.id}`, lessonId: `${demo.name}-${stage.id}`,
    title: stage.title, entry: resolveDemoStage(demo, stage.id).entry }))
  : [{ label: demo.name, lessonId: demo.name, title: demo.title, entry: demo }]);
/** Every coordinate record the index names, stages included. */
const coordinateRecords: Array<[string, DemoCoordinates]> = index.demos.flatMap(demo =>
  [[demo.name, demo.coordinates] as [string, DemoCoordinates],
    ...(demo.stages ?? []).map(stage => [`${demo.name} ${stage.id}`, stage.coordinates] as [string, DemoCoordinates])]);

describe('the checked-in demo index', () => {
  it('names every lesson file in plugin/demos and nothing else', async () => {
    const walk = async (directory: string, prefix = ''): Promise<string[]> => {
      const entries = await readdir(resolve(demosRoot, directory), { withFileTypes: true });
      const files = await Promise.all(entries.map(async entry => entry.isDirectory()
        ? walk(resolve(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]));
      return files.flat();
    };
    const all = await walk(demosRoot);
    const recipes = new Set(units.flatMap(unit => unit.entry.coordinates.derivation?.kind === 'prepared-rigid-composite'
      ? [unit.entry.coordinates.derivation.recipe] : []));
    const jsonFiles = all.filter(name => name.endsWith('.json') && name !== 'index.json' && !recipes.has(name));
    const files = (await Promise.all(jsonFiles.map(async name =>
      Array.isArray(JSON.parse(await readFile(resolve(demosRoot, name), 'utf8')).chapters) ? name : undefined)))
      .filter((name): name is string => name !== undefined).sort();
    expect(units.map(unit => unit.entry.lesson).sort()).toEqual(files);
    for (const recipe of recipes) expect(all).toContain(recipe);
  });

  it('carries at least the six requested demos with distinct names', () => {
    expect(index.demos.length).toBeGreaterThanOrEqual(6);
    expect(new Set(index.demos.map(demo => demo.name)).size).toBe(index.demos.length);
    for (const name of ['crispr-cas9', 'microtubule-lattice', 'hemoglobin', 'nucleosome', 'spike', 'atp-synthase']) {
      expect(index.demos.map(demo => demo.name)).toContain(name);
    }
  });

  it('resolves every PDB id to recorded downloads or a composite recipe and digest', async () => {
    for (const unit of units) {
      const { pdbId, coordinates } = unit.entry;
      if (coordinates.derivation?.kind === 'bundled-file') {
        expect(pdbId).toBeUndefined();
        expect(unit.entry.sourceId).toBeTruthy();
      } else expect(pdbId).toMatch(/^[0-9A-Z]{4}$/);
      expect(coordinates.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(coordinates.bytes).toBeGreaterThan(0);
      // A density tier is measured in none of the units below.
      //
      // Its download is an EMDB map, not an RCSB coordinate file; it has no
      // atom sites at all; and the 16,777,216-byte bound is this plugin's
      // download policy, which a map does not travel through — it has its own
      // route and its own cap. What a volume is held to instead is the thing that decides
      // whether the headset can draw it: the measured triangle count of its
      // isosurface, and a byte count that is exactly the grid it claims.
      const volume = coordinates.volume;
      if (volume) {
        expect(coordinates.download).toMatch(/^https:\/\/ftp\.ebi\.ac\.uk\/pub\/databases\/emdb\/structures\/EMD-\d+\/map\/\S+\.map\.gz$/);
        expect(volume.emdbId).toMatch(/^EMD-\d+$/);
        expect(coordinates.atomSites).toBe(0);
        expect(volume.triangles).toBeGreaterThan(0);
        expect(volume.triangles).toBeLessThanOrEqual(QUEST2_TRIANGLE_CEILING);
        // MRC mode 2 is float32 after a 1,024-byte header, so the file size is
        // the grid it records. A map whose bytes and grid disagree is not the
        // map the measured triangle count was measured on.
        expect(volume.grid.reduce((product, axis) => product * axis, 1) * 4 + 1_024).toBe(coordinates.bytes);
        // The contour is quoted on the PREPARED map and is not the deposited
        // recommendation; both are recorded so nobody copies the wrong one.
        expect(volume.contour).toBeGreaterThan(0);
        expect(volume.contour).toBeLessThan(volume.depositedContour);
        continue;
      }
      // An operator subset is cut from the expanded assembly file; a chain
      // subset is cut from the deposited entry, because a deposited entity is
      // not something the assembly file adds.
      if (coordinates.derivation?.kind === 'bundled-file') {
        const text = await readBundledDemoCoordinates(coordinates.derivation.path, coordinates.sha256, demosRoot);
        expect(Buffer.byteLength(text)).toBe(coordinates.bytes);
        expect(coordinates.assemblyId).toBeUndefined();
      } else if (coordinates.derivation?.kind === 'prepared-rigid-composite') {
        const recipe = parseRigidCompositeRecipe(await readFile(compositeRecipePath(coordinates.derivation.recipe, demosRoot), 'utf8'));
        expect(recipe.sources.length).toBeGreaterThan(0);
        expect(coordinates.assemblyId).toBeUndefined();
      } else {
        expect(coordinates.download).toBe(coordinates.derivation?.kind === 'assembly-operator-subset'
          ? `https://files.rcsb.org/download/${pdbId}-assembly1.cif`
          : `https://files.rcsb.org/download/${pdbId}.cif`);
      }
      // This plugin's own download and local-read policy, which every demo
      // source travels through. It is not a viewer ceiling and no viewer was
      // measured at it.
      expect(coordinates.bytes).toBeLessThanOrEqual(MAX_STRUCTURE_SOURCE_BYTES);
      // The 200,000-atom-site and 30,000-row
      // assertions that used to sit here pinned limits nobody measured, and
      // those limits are gone. What is still worth asserting is that the index
      // records a real count for a coordinate tier, because `stageFitsTier`
      // compares that count with the measured Quest 2 ceiling.
      expect(coordinates.atomSites).toBeGreaterThan(0);
      expect(Number.isInteger(coordinates.catalogRows ?? 0)).toBe(true);
      // A named assembly is built by the renderer, so an expanded operator
      // subset of the same source would be a contradiction.
      if (coordinates.assemblyId) expect(coordinates.derivation).toBeUndefined();
    }
  });

  it('gives every demo a citation with a DOI and an RCSB entry URL', () => {
    for (const demo of units.map(unit => unit.entry)) {
      expect(demo.sources.length).toBeGreaterThanOrEqual(2);
      if (!demo.pdbId) {
        expect(demo.sourceId).toBeTruthy();
        expect(demo.sources.some(source => source.url.startsWith('https://'))).toBe(true);
        continue;
      }
      expect(demo.sources.some(source => source.url === `https://www.rcsb.org/structure/${demo.pdbId}`)).toBe(true);
      const citation = demo.sources.find(source => source.doi);
      expect(citation, `${demo.name} needs a citation with a DOI`).toBeDefined();
      expect(citation!.doi).toMatch(/^10\.\d{4,9}\/\S+$/);
      expect(citation!.url).toBe(`https://doi.org/${citation!.doi}`);
    }
  });

  it('records the microtubule fallback as an explicit operator subset', () => {
    const microtubule = named('microtubule-lattice');
    expect(microtubule.coordinates.derivation).toEqual({ kind: 'assembly-operator-subset', operators: ['2', '3', '4', '5', '6', '7'], ofOperators: 26 });
    expect(microtubule.coordinates.file).not.toBe(`${microtubule.pdbId}.cif`);
  });

  it('lists the demos with their entry and the subset it falls back to', () => {
    const listing = formatDemoList(index);
    expect(listing).toContain('hemoglobin');
    expect(listing).toContain('4HHB');
    expect(listing).toContain('6 of 26 assembly operators');
    expect(listing).toContain('--stage tube');
    expect(listing).toContain("assembly 1, built from the entry's operators");
    expect(listing).toContain('177,268 atom sites');
  });

  it('keeps the coordinate cache outside the checkout', () => {
    const cache = demoCacheDirectory('/home/example');
    expect(cache).toBe('/home/example/Library/Caches/Stereofold/demos');
    expect(index.cacheDirectory).toBe('~/Library/Caches/Stereofold/demos');
  });
});

describe.each(units.map(unit => [unit.label, unit] as const))('the %s lesson', (_label, unit) => {
  const demo = unit.entry;
  it('parses against the lesson contract and matches the recorded digest', async () => {
    const manifest = await readDemoLesson(demo, demosRoot);
    expect(manifest.id).toBe(unit.lessonId);
    expect(manifest.title).toContain(unit.title);
    expect(manifest.provenance.sourceSha256).toBe(demo.coordinates.sha256);
  });

  it('holds captioned scenes at its authored pacing', async () => {
    const manifest = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, demo.lesson), 'utf8')));
    expect(manifest.chapters.length).toBeGreaterThanOrEqual(extendedGallery(unit) ? 1 : gallery(unit) ? 17 : motion(unit) ? 1 : illustrated(unit) || arrival(unit) ? 2 : MIN_SCENES);
    expect(manifest.chapters.length).toBeLessThanOrEqual(extendedGallery(unit) ? 24 : gallery(unit) ? 17 : motion(unit) ? 12 : illustrated(unit) ? 2 : arrival(unit) ? 8 : taught(unit) ? MAX_TAUGHT_SCENES : MAX_SCENES);
    for (const chapter of manifest.chapters) {
      const [shortest, longest] = gallery(unit) ? [3, 3] : motion(unit) ? [4, 60] : illustrated(unit) ? [60, 60] : arrival(unit)
        ? chapter === manifest.chapters.at(-1) ? [15, 15] : [4, 7] : !taught(unit) ? [MIN_SCENE_SECONDS, MAX_SCENE_SECONDS]
        : recapChapter(chapter.id) ? [MIN_RECAP_SECONDS, MAX_RECAP_SECONDS] : [MIN_TAUGHT_SECONDS, MAX_TAUGHT_SECONDS];
      expect(chapter.durationSeconds, `${chapter.id} duration`).toBeGreaterThanOrEqual(shortest);
      expect(chapter.durationSeconds, `${chapter.id} duration`).toBeLessThanOrEqual(longest);
      expect(chapter.caption.length).toBeGreaterThan(40);
      expect(chapter.changes.reduce((sum, change) => sum + change.durationSeconds, 0)).toBeCloseTo(chapter.durationSeconds, 6);
    }
  });

  it.skipIf(taught(unit) || arrival(unit) || motion(unit) || gallery(unit))('opens on a wide reveal, orbits, highlights, reaches the working part and steps back', async () => {
    const manifest = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, demo.lesson), 'utf8')));
    const ids = manifest.chapters.map(chapter => chapter.id);
    if (illustrated(unit)) {
      expect(ids).toEqual(['overview', 'interface']);
      expect(manifest.presentation).toEqual({ captionCard: 'hidden', end: 'hold' });
      expect(demo.coordinates.assemblyId).toBe('1');
      for (const chapter of manifest.chapters) {
        expect(chapter.immersive?.figure?.labels).toHaveLength(3);
        expect(chapter.immersive?.figure?.distances).toHaveLength(2);
      }
      const portable = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot,
        '../skills/molecular-presentation/assets/9ax6-daraxonrasib.json'), 'utf8')));
      expect({ ...manifest, id: portable.id }).toEqual(portable);
      return;
    }
    // The five beats are the house shape of a demo, in this order. A lesson may
    // add a chapter of its own between them — crispr-cas9 carries `dead`, the
    // one scene that explains why this complex never cuts — but it may not drop
    // a beat, reorder them, or open or close on anything else.
    expect(ids.filter(id => ['reveal', 'orbit', 'highlight', 'site', 'wide'].includes(id)))
      .toEqual(['reveal', 'orbit', 'highlight', 'site', 'wide']);
    expect(ids[0]).toBe('reveal');
    expect(ids.at(-1)).toBe('wide');
    const chapter = (id: string) => {
      const found = manifest.chapters.find(entry => entry.id === id);
      if (!found) throw Error(`${unit.label} has no ${id} chapter.`);
      return found;
    };
    expect(chapter('orbit').changes.some(change => change.kind === 'camera_spin')).toBe(true);
    expect(chapter('site').changes.some(change => change.kind === 'focus')).toBe(true);
    expect(chapter('reveal').immersive?.view).toBe('fit');
    expect(chapter('wide').immersive?.view).toBe('fit');
    // Close-ups scale the molecule, never the wearer's own camera. Telomerase
    // keeps its cutaway open so both focused copies and their labels remain visible.
    expect(chapter('site').immersive?.placement?.scale ?? 1).toBeGreaterThan(1.5);
    if (unit.lessonId === 'telomerase-haca') {
      expect(chapter('site').immersive?.appearance?.clipping).toBe(0);
    } else {
      expect(chapter('site').immersive?.appearance?.clipping ?? 0).toBeGreaterThan(0);
    }
  });

  it('cites its sources inside the lesson and stays within the compiler limits', async () => {
    const raw = JSON.parse(await readFile(resolve(demosRoot, demo.lesson), 'utf8'));
    const compiled = compileMolecularLesson(raw);
    expect(compiled.timeline.length).toBeLessThanOrEqual(MOLECULAR_LESSON_LIMITS.maxTotalSteps);
    expect(compiled.totalDurationSeconds).toBeLessThanOrEqual(MOLECULAR_LESSON_LIMITS.maxLessonDurationSeconds);
    const refs = compiled.manifest.provenance.sourceRefs;
    if (demo.pdbId) {
      expect(refs.some(ref => ref.kind === 'public' && ref.ref === `https://www.rcsb.org/structure/${demo.pdbId}`)).toBe(true);
      expect(refs.some(ref => ref.kind === 'publication' && /^https:\/\/doi\.org\/10\./.test(ref.ref))).toBe(true);
    } else {
      expect(refs.some(ref => ref.kind === 'public' && demo.sources.some(source => source.url === ref.ref))).toBe(true);
    }
    expect(compiled.manifest.provenance.note?.length ?? 0).toBeGreaterThan(40);
  });

  it('becomes a headset tour whose every scene carries immersive intent', async () => {
    const tour = molecularLessonToTour(JSON.parse(await readFile(resolve(demosRoot, demo.lesson), 'utf8')));
    expect(tour.id).toBe(`lesson-${unit.lessonId}`);
    expect(tour.steps.length).toBeGreaterThanOrEqual(extendedGallery(unit) ? 1 : gallery(unit) ? 17 : motion(unit) ? 1 : illustrated(unit) || arrival(unit) ? 2 : MIN_SCENES);
    for (const step of tour.steps) {
      expect(step.body?.length ?? 0).toBeGreaterThan(20);
      expect(step.durationMs).toBeGreaterThanOrEqual((gallery(unit) ? 3 : arrival(unit) || motion(unit) ? 4 : MIN_SCENE_SECONDS) * 1_000);
      expect(step.appearance ?? step.placement ?? step.view ?? (arrival(unit) || motion(unit) ? step.visibility ?? step.motion : undefined)).toBeDefined();
      expect(step.sources?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // A chapter that shows `only` some chains hides the rest of its structure, so
  // whether the panel can draw and save it depends on the coordinates, not on
  // the lesson file alone. The kinesin flipbook's pages each hid 71 to 87 of its
  // 95 chains, every page was refused, and the lesson never finished loading.
  // Resolve each chapter against the cached coordinates the way the panel does.
  it('can show every chapter of its cached coordinates', async () => {
    const manifest = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, demo.lesson), 'utf8')));
    if (demo.coordinates.volume || !manifest.chapters.some(chapter => chapter.immersive?.visibility)) return;
    const cached = await readAddressedDemoFile(file => resolve(demoCacheDirectory(), file), demo.coordinates.file, demo.coordinates.sha256);
    if (!cached) return;
    const catalog: any = await extractInspectionCatalogBytes(cached.bytes,
      demo.coordinates.assemblyId ? { assemblyId: demo.coordinates.assemblyId } : undefined);
    const modelNumber = catalog.modelNumbers[0];
    const chains = availableChains(catalog.rows, modelNumber), classes = componentClassesPresent(catalog.rows, modelNumber);
    let visibility = emptyVisibility();
    for (const chapter of manifest.chapters) {
      if (!chapter.immersive?.visibility) continue;
      visibility = resolveVisibility(visibility, chapter.immersive.visibility, chains, { classes });
      expect(visibilityHidesEverything(catalog.rows, visibility, modelNumber), chapter.id).toBe(false);
      expect(sceneVisibilitySchema.safeParse(visibility).error?.issues, chapter.id).toBeUndefined();
    }
  }, 120_000);
});

describe('the line the headset shows, wherever a lesson authors one', () => {
  // The taught lesson and every growth tier write one spoken line per chapter
  // under `immersive.narration`; the plate carries that line, so its authoring
  // rules are the plate's rules.
  const numericToken = /(?<![\w.])\d+(?:[.,]\d+)*(?![\w.])/u;
  const spokenLessons = ['crispr-cas9.json', 'microtubule-growth/dimer.json', 'microtubule-growth/filament.json',
    'microtubule-growth/monomer.json', 'microtubule-growth/protofilament.json', 'microtubule-growth/tip.json',
    'microtubule-growth/tube.json', 'microtubule-growth/wall.json',
    'microtubule-arrival/build.json', 'microtubule-arrival/density.json'];

  it('gives every chapter of a narrated lesson a spoken line for the plate', async () => {
    for (const lesson of spokenLessons) {
      const demo = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, lesson), 'utf8')));
      for (const chapter of demo.chapters) {
        const line = chapter.immersive?.narration ?? '';
        expect(line.length, `${lesson} / ${chapter.id} has a spoken line`).toBeGreaterThan(20);
      }
    }
  });

  it('keeps every spoken line free of numbers', async () => {
    // A spoken line once put "Operators 2 to 7, at 166.20, 138.50" in front
    // of a wearer. Coordinates, entry sizes and residue
    // ranges live on the desktop caption; the spoken line is prose. A digit
    // inside a name (`EB3`) is a name, not a measurement.
    for (const lesson of spokenLessons) {
      const demo = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, lesson), 'utf8')));
      for (const chapter of demo.chapters) {
        const line = chapter.immersive?.narration ?? '';
        expect(line.match(numericToken), `${lesson} / ${chapter.id}: ${line}`).toBeNull();
      }
    }
  });
});

describe('the CRISPR lesson a wearer meets first', () => {
  const lesson = async () => parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, 'crispr-cas9.json'), 'utf8')));

  it('starts turning before it rebuilds anything, and says so out loud', async () => {
    const manifest = await lesson();
    const first = manifest.chapters[0];
    // Play used to be followed by eighteen seconds of caption pages over a
    // molecule that never moved. The opening chapter now asks for
    // the presentation turn, which lands in the next frame, and the player
    // applies placement and motion before any representation rebuild.
    expect(first.immersive?.motion).toBe('spin');
    expect(first.immersive?.narration?.length ?? 0).toBeGreaterThan(20);
    expect(manifest.chapters.every(chapter => (chapter.immersive?.narration ?? '').length > 20)).toBe(true);
  });

  it('keeps every spoken line short enough to say in a few seconds', async () => {
    const manifest = await lesson();
    for (const chapter of manifest.chapters) {
      const words = (chapter.immersive?.narration ?? '').trim().split(/\s+/u).filter(Boolean);
      expect(words.length, `${chapter.id} narration`).toBeLessThan(18);
      expect(words.length, `${chapter.id} narration`).toBeGreaterThan(5);
    }
  });

  it('pays for at most two representation rebuilds across the whole tour', async () => {
    const manifest = await lesson();
    let previous: string | undefined, rebuilds = 0;
    for (const chapter of manifest.chapters) {
      const representation = chapter.immersive?.appearance?.representation;
      if (representation && previous && representation !== previous) rebuilds++;
      if (representation) previous = representation;
    }
    expect(rebuilds).toBeLessThanOrEqual(2);
  });

  it('names every chapter after the part it teaches, and runs four to five minutes', async () => {
    const manifest = await lesson();
    // The chapters used to run "reveal, orbit, surface, torn cutaway,
    // transparent soup, repeat of chapter one" — five camera moves and no
    // named parts. A chapter is now named for what it points at, and lasts
    // long enough for a wearer to find that part and look at it.
    // The closing chapter used to be `cut-sites`, which was neither a cut-site
    // chapter nor a recap — every colour at half brightness and nothing
    // leading. The cut sites moved
    // into the nuclease chapter that owns them, and the close is four numbered
    // callouts that name each part again before asking the wearer to name one.
    expect(manifest.chapters.map(chapter => chapter.id)).toEqual([
      'complex', 'guide-rna', 'target-dna', 'rec-lobe', 'nucleases',
      'recap-guide', 'recap-dna', 'recap-rec', 'recap-nucleases']);
    // The chapter number is gone from the title, and the title is short. The
    // title is drawn on a one-line glass whose outboard half falls outside a
    // Quest 2 lens: on headset captures the left 1.5 to 4 characters of every
    // title were cut off — "HE GUIDE RNA", "ECAP 1 OF 4",
    // "E NUCLEASES" — and the number was the part that got eaten. The text is
    // centred on that glass, so a shorter title starts further inboard and
    // survives the cut; and the line below it already reads "Scene 3 / 9", so
    // the number was never the title's to carry.
    for (const chapter of manifest.chapters) {
      expect(chapter.title, `${chapter.id} title`).toMatch(/^[A-Z][A-Z0-9 +:]*[A-Z]$/u);
      expect(chapter.title.length, `${chapter.id} title length`).toBeLessThanOrEqual(12);
    }
    const total = manifest.chapters.reduce((sum, chapter) => sum + chapter.durationSeconds, 0);
    expect(total).toBeGreaterThanOrEqual(240);
    expect(total).toBeLessThanOrEqual(MOLECULAR_LESSON_LIMITS.maxLessonDurationSeconds);
  });

  it('carries one fixed colour key through every chapter and emphasises one thing at a time', async () => {
    const manifest = await lesson();
    const keys = manifest.chapters.map(chapter => JSON.stringify(chapter.immersive?.emphasis?.parts));
    // A wearer learns one mapping for the whole lesson, so the key may not
    // drift between chapters: grey Cas9 stays grey when the guide RNA is lit.
    expect(new Set(keys).size, 'the colour key differs between chapters').toBe(1);
    const first = manifest.chapters[0].immersive?.emphasis;
    expect(first?.parts.length).toBeGreaterThanOrEqual(4);
    expect(first?.focus, 'the opening chapter shows the whole key').toBeUndefined();
    for (const chapter of manifest.chapters.slice(1)) {
      const emphasis = chapter.immersive?.emphasis;
      expect(emphasis?.focus, `${chapter.id} emphasises nothing`).toBeDefined();
      // Context stays visible rather than hidden: an isolated part with no
      // surroundings cannot be placed in the complex it came from.
      expect(emphasis?.contextOpacity ?? 0).toBeGreaterThan(0);
      expect(emphasis?.contextOpacity ?? 1).toBeLessThan(0.5);
    }
  });

  it('names a real chain or residue range for every part of its colour key', async () => {
    const manifest = await lesson();
    // 9KJ6 is A Cas9, B single-guide RNA, C target DNA, D non-target DNA, and
    // the protein is modelled over author residues 2-1351. A colour key that
    // names anything else would light nothing in the headset.
    const chains = new Set(['A', 'B', 'C', 'D']);
    for (const part of manifest.chapters[0].immersive?.emphasis?.parts ?? []) {
      expect(chains, `${part.id} chain`).toContain(part.chain);
      expect(part.label.length).toBeGreaterThan(3);
      if (!part.residues) continue;
      expect(part.residues.to, `${part.id} range`).toBeGreaterThanOrEqual(part.residues.from);
      const limit = part.chain === 'A' ? 1351 : 98;
      expect(part.residues.to, `${part.id} range`).toBeLessThanOrEqual(limit);
    }
  });

  it('records the dead nuclease sites and the shifted author numbering in its provenance', async () => {
    const manifest = await lesson();
    const note = manifest.provenance.note ?? '';
    // Both are read straight from the deposited coordinates: residue 10 and
    // residue 840 are alanine, and the Gly-Ser linker shifts every author
    // number after 1241 fifteen below canonical SpCas9 numbering.
    expect(note).toContain('D10A');
    expect(note).toContain('H840A');
    expect(note).toContain('1318');
  });
});

describe('the assembly-operator fallback', () => {
  const assembly = [
    'data_TEST', '#', 'loop_', '_struct_asym.id', '_struct_asym.entity_id', 'A 1', 'A-2 1', 'A-3 1', '#',
    'loop_', '_struct_conf.id', '_struct_conf.beg_label_asym_id', 'HELX1 A', 'HELX2 A-2', 'HELX3 A-3', '#',
    'loop_', '_atom_site.group_PDB', '_atom_site.id', '_atom_site.label_asym_id', '_atom_site.auth_asym_id',
    'ATOM 1 A A', 'ATOM 2 A-2 A-2', 'ATOM 3 A-3 A-3', '#',
  ].join('\n');

  it('keeps only the named operators and the header rows that describe them', () => {
    const kept = subsetAssemblyOperators(assembly, ['2']);
    expect(kept).toContain('ATOM 2 A-2 A-2');
    expect(kept).not.toContain('ATOM 3 A-3 A-3');
    expect(kept).not.toContain('HELX3 A-3');
    expect(kept).toContain('HELX2 A-2');
    expect(kept).toContain('A-2 1');
    expect(kept).not.toContain('A-3 1');
  });

  it('treats the unsuffixed deposited chains as operator one', () => {
    const kept = subsetAssemblyOperators(assembly, ['1']);
    expect(kept).toContain('ATOM 1 A A');
    expect(kept).not.toContain('ATOM 2 A-2 A-2');
  });

  it('refuses an operator that no deposited chain belongs to', () => {
    expect(() => subsetAssemblyOperators(assembly, ['9'])).toThrow(/No deposited chain/);
  });

  it('alters no retained coordinate line', () => {
    const kept = subsetAssemblyOperators(assembly, ['2', '3']).split('\n');
    for (const line of ['ATOM 2 A-2 A-2', 'ATOM 3 A-3 A-3']) expect(kept).toContain(line);
  });
});

describe('the cached coordinates', () => {
  // The cache is a download directory, so it is present on a machine that has
  // run a demo and absent on a clean checkout. Check it only when it is there.
  it.each(coordinateRecords)('match the digest recorded for %s when cached', async (_name, coordinates) => {
    const cached = await readAddressedDemoFile(file => resolve(demoCacheDirectory(), file), coordinates.file, coordinates.sha256);
    if (!cached) return;
    const bytes = cached.bytes;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(coordinates.sha256);
    expect(bytes.length).toBe(coordinates.bytes);
  });
});

describe('the staged microtubule-arrival demo', () => {
  const demo = named('microtubule-arrival');
  const lesson = async (stage: string) => readDemoLesson(resolveDemoStage(demo, stage).entry, demosRoot);

  it('opens the build by default and reaches density on Quest 2 with the actual tour binding', () => {
    expect(demo.defaultStage).toBe('build');
    expect(resolveDemoStage(demo).stage?.id).toBe('build');
    expect(demo.lesson).toBe('microtubule-arrival/build.json');
    expect(demo.stages?.map(stage => stage.id)).toEqual(['build', 'density']);
    const stages = growthStages(index);
    const current = growthStageOfLesson(index, 'lesson-microtubule-arrival-build')!;
    expect(current.demo).toBe('microtubule-arrival');
    const next = resolveGrowthTarget(stages, current, 'next', 'quest2');
    expect(next.refused).toBe(false);
    if (next.refused) throw Error(next.reason);
    expect(next.target.stage.id).toBe('density');
    expect(next.target.stage.coordinates.volume?.emdbId).toBe('EMD-6347');
    expect(resolveGrowthTarget(stages, next.target, 'back', 'quest2')).toMatchObject({
      refused: false, target: { stage: { id: 'build' } },
    });
  });

  it('reuses the checked wall and prepared density cache records without a new download', () => {
    const growth = named('microtubule-growth');
    expect(resolveDemoStage(demo, 'build').entry.coordinates).toEqual(resolveDemoStage(growth, 'wall').entry.coordinates);
    expect(resolveDemoStage(demo, 'density').entry.coordinates).toEqual(resolveDemoStage(growth, 'filament').entry.coordinates);
  });

  it('opens at one oblique angle, then replays cumulative masks without chapter framing', async () => {
    const manifest = await lesson('build');
    const tour = molecularLessonToTour(manifest);
    const additions = [['A-2'], ['B-2'], ['A-3', 'B-3'], ['A-4', 'B-4'],
      ['A-5', 'B-5'], ['A-6', 'B-6'], ['A-7', 'B-7'], []];
    expect(manifest.chapters.map(chapter => chapter.id)).toEqual([
      'alpha', 'dimer', 'extend', 'neighbor', 'neighbor-extend', 'third-strand', 'wall', 'inspect',
    ]);
    expect(manifest.presentation).toEqual({ captionCard: 'shown', end: 'hold' });
    const visible: string[] = [];
    for (const [position, step] of tour.steps.entries()) {
      visible.push(...additions[position]!);
      // Each chapter names the whole final mask, so Back does not depend on
      // which intermediate reveals were previously played.
      expect(step.visibility).toEqual({ op: 'only', chains: [...visible], classes: ['polymer'] });
      expect(step.motion).toBe('hold');
      expect(step.placement).toEqual(position === 0 ? { rotation: [60, -25, 10] } : undefined);
      expect(step.view).toBeUndefined();
      expect(step.emphasis?.focus).toBeUndefined();
      expect(step.emphasis?.framing).toBeUndefined();
      expect(manifest.chapters[position]!.changes).toEqual([{ kind: 'hold', durationSeconds: step.durationMs! / 1_000 }]);
      expect(manifest.chapters[position]!.caption.trim().split(/\s+/u).length).toBeLessThanOrEqual(18);
    }
    expect(tour.steps.slice(1).every(step => step.appearance === undefined)).toBe(true);
    expect(tour.steps[0]!.appearance).toMatchObject({ labels: false, componentLabels: false, clipping: 0, opacity: 1 });
    const key = tour.steps[0]!.emphasis!;
    for (const step of tour.steps) expect(step.emphasis).toEqual(key);
    expect(key.contextOpacity).toBe(1);
    expect(key.parts).toHaveLength(12);
    expect(key.parts.map(part => part.chain)).toEqual(additions.flat());
    for (const part of key.parts) expect(part.color).toBe(part.chain?.startsWith('A-') ? '#4a90e2' : '#f5a623');
  });

  it('holds the distinct density specimen and leaves the large overhead reveal to the wearer', async () => {
    const manifest = await lesson('density');
    const tour = molecularLessonToTour(manifest);
    expect(tour.steps.map(step => step.id)).toEqual(['density', 'overhead']);
    expect(manifest.coordinates).toMatchObject({ kind: 'volume', ref: 'emd_6347-4x.map', contour: 3.3, downsample: 4 });
    expect(manifest.provenance.note).toContain('3.4 Angstrom');
    expect(manifest.provenance.note).toContain('different experimental specimen');
    expect(manifest.provenance.note).toContain('RCSB links 3JAK to EMD-6349');
    expect(manifest.provenance.note).toContain('not molecular segmentation');
    expect(manifest.provenance.note).toContain('begins from the prior displayed center and diameter');
    expect(manifest.provenance.note).toContain('active opening chapter can fit the density when no wearer placement is held');
    expect(manifest.chapters[1]!.caption).toContain('Above us after loading settles');
    for (const step of tour.steps) {
      expect(step.motion).toBe('hold');
      expect(step.placement).toBeUndefined();
      expect(step.view).toBeUndefined();
      expect(step.emphasis).toBeUndefined();
    }
    expect(tour.steps[0]!.appearance).toMatchObject({ representation: 'isosurface', labels: false, componentLabels: false, clipping: 0, opacity: 1 });
    expect(tour.steps[1]!.appearance).toEqual({ clipping: 0, opacity: 1 });
  });
});

describe('the staged microtubule-growth demo', () => {
  const growth = named('microtubule-growth');
  const stages = growth.stages ?? [];

  it('grows from one monomer to the complete tube and then to a tip protein', () => {
    // `filament` sits between the wall and the tube on purpose.
    // The growth resolver steps ONE tier and refuses rather than skipping, so
    // this is the position at which "grow it" from the wall reaches a whole
    // microtubule on a Quest 2 — as density, which fits, rather than as the
    // 177,268-site atomic tube, which does not.
    expect(stages.map(stage => stage.id)).toEqual(['monomer', 'dimer', 'protofilament', 'wall', 'filament', 'tube', 'tip']);
    expect(stages.map(stage => stage.order)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    // The story starts at one chain, so the first tier is one deposited
    // entity of 5SYF rather than its whole asymmetric unit.
    const monomer = stages[0]!;
    expect(monomer.coordinates.derivation).toEqual({ kind: 'deposited-chain-subset', chains: ['A'], entityIds: ['1'] });
    expect(monomer.coordinates.atomSites).toBe(3_343);
    expect(monomer.coordinates.file).toBe('5SYF-monomer-alpha.cif');
    // Every 5SYF stage is larger than the one before it.
    const tubulin = stages.filter(stage => stage.pdbId === '5SYF').map(stage => stage.coordinates.atomSites);
    expect(tubulin).toEqual([...tubulin].sort((left, right) => left - right));
    expect(new Set(tubulin).size).toBe(tubulin.length);
    expect(stages.at(-1)!.pdbId).toBe('3JAK');
  });

  it('reaches the complete 26-operator assembly without shipping an expanded file', () => {
    const tube = stages.find(stage => stage.id === 'tube')!;
    expect(tube.coordinates.assemblyId).toBe('1');
    expect(tube.coordinates.atomSites).toBe(177_268);
    expect(tube.coordinates.catalogRows).toBe(22_542);
    // The asymmetric unit travels; the renderer instances the 26 operators.
    expect(tube.coordinates.file).toBe('5SYF.cif');
    expect(tube.coordinates.bytes).toBe(775_288);
    expect(tube.coordinates.bytes).toBeLessThan(stages.find(stage => stage.id === 'wall')!.coordinates.bytes);
  });

  it('opens the Quest 2 tier by default and never the tube', () => {
    expect(growth.defaultStage).toBe('wall');
    expect(growth.lesson).toBe('microtubule-growth/wall.json');
    expect(stageForDevice(growth, 'quest2')).toBe('tip');
    expect(stageForDevice(growth, 'unknown')).toBe('tip');
    expect(stageForDevice(growth, 'not-a-device')).toBe('tip');
    expect(stageForDevice(growth, 'quest3')).toBe('tip');
    expect(stages.find(stage => stage.id === stageForDevice(growth, 'quest2'))!.tiers).toContain('quest2');
    expect(stages.find(stage => stage.id === 'tube')!.tiers).toEqual(['quest3']);
  });

  it('maps only the measured Quest 2 class to its restricted tier', () => {
    expect(DEMO_TIER_BY_DEVICE.quest2).toBe('quest2');
    // Only the Quest 2 is measured; an unidentified headset is not held to its ceiling.
    expect(DEMO_TIER_BY_DEVICE.unknown).toBe('quest3');
    expect(DEMO_TIER_BY_DEVICE['hand-only']).toBe('quest3');
    expect(DEMO_TIER_BY_DEVICE.quest3).toBe('quest3');
    expect(DEMO_TIER_BY_DEVICE['quest-pro']).toBe('quest3');
    expect(DEMO_TIER_BY_DEVICE['vision-pro']).toBe('quest3');
  });

  it('resolves one stage into a whole demo entry and refuses an unknown one', () => {
    const resolved = resolveDemoStage(growth, 'tip');
    expect(resolved.stage?.id).toBe('tip');
    expect(resolved.entry.pdbId).toBe('3JAK');
    expect(resolved.entry.lesson).toBe('microtubule-growth/tip.json');
    expect(resolved.entry.sources.some(source => source.doi === '10.1016/j.cell.2015.07.012')).toBe(true);
    expect(resolveDemoStage(growth).stage?.id).toBe('wall');
    expect(() => resolveDemoStage(growth, 'nope')).toThrow(/Unknown stage/);
    expect(() => resolveDemoStage(named('hemoglobin'), 'tube')).toThrow(/no stages/);
    expect(resolveDemoStage(named('hemoglobin')).stage).toBeUndefined();
  });

  it('names EB3 rather than EB1 wherever it names the tip protein', async () => {
    const tip = JSON.parse(await readFile(resolve(demosRoot, 'microtubule-growth/tip.json'), 'utf8'));
    const text = JSON.stringify(tip);
    expect(text).toContain('EB3');
    // 3JAK deposits EB3. EB1 may be named only to say this is not it.
    for (const match of text.matchAll(/.{0,12}\bEB1\b/gu)) expect(match[0]).toMatch(/not EB1$/);
    expect(text).toMatch(/not EB1/);
    expect(tip.provenance.note).toContain('3JAK');
  });

  it('places every stage at the scale the overhead anchor solves for', async () => {
    for (const stage of stages) {
      const manifest = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, stage.lesson), 'utf8')));
      // 4 m across a 1.8 m default bounding diameter is 2.22 placement units;
      // the wide beats are authored at that magnitude, inside the 0.25-4 clamp.
      for (const chapter of [manifest.chapters[0], manifest.chapters[4]]) {
        expect(chapter.immersive?.placement?.scale ?? 1).toBeGreaterThan(2);
        expect(chapter.immersive?.placement?.scale ?? 1).toBeLessThanOrEqual(4);
        // A saved translation would move the structure off the desktop panel;
        // the head-relative lift is the runtime placeInRoom('overhead') call.
        expect(chapter.immersive?.placement?.translation).toEqual([0, 0, 0]);
      }
    }
  });
});

describe('the launcher prefetch', () => {
  const growth = named('microtubule-growth');
  const lessons = (entries: DemoEntry[]) => entries.map(entry => entry.lesson);
  const quest2Lessons = [
    'microtubule-growth/monomer.json',
    'microtubule-growth/dimer.json',
    'microtubule-growth/protofilament.json',
    'microtubule-growth/wall.json',
    'microtubule-growth/filament.json',
    'microtubule-growth/tip.json',
  ];

  it('keeps the admitted gallery default for identical coordinates and recognizes both lesson stages', async () => {
    const gallery = named('binder-gallery');
    for (const device of ['quest2', 'quest3', 'unknown'])
      expect(stageForDevice(gallery, device)).toBe('steady-target');
    for (const stage of gallery.stages!) {
      const resolved = resolveDemoStage(gallery, stage.id);
      const manifest = await readDemoLesson(resolved.entry, demosRoot);
      expect(growthStageOfLesson(index, manifest.id)?.stage.id).toBe(stage.id);
      expect(manifest.title).toBe(stage.title);
    }
    // An inadmissible default still cannot override the device's allowed set.
    const restricted: DemoEntry = { ...gallery, stages: gallery.stages!.map(stage =>
      stage.id === gallery.defaultStage ? { ...stage, tiers: ['quest3'] } : stage) };
    expect(stageForDevice(restricted, 'quest2')).toBe('original-pairs');
    // Different coordinates retain the established largest-allowed behavior.
    const different: DemoEntry = { ...gallery, stages: gallery.stages!.map((stage, i) => i === 1
      ? { ...stage, coordinates: { ...stage.coordinates, sha256: 'f'.repeat(64) } } : stage) };
    expect(stageForDevice(different, 'quest2')).toBe('original-pairs');
  });

  it('uses the growth admission budget when selecting and warming a Quest 2 stage', () => {
    const kinesin = named('kinesin-walk');
    // The live catalog labels cycle quest2, but its 48,423 atom sites exceed
    // the shared 43,066-site ceiling. A tier label alone cannot admit it.
    const selected = resolveDemoStage(kinesin, stageForDevice(kinesin, 'quest2'));
    expect(selected.stage?.id).toBe('flipbook');
    expect(lessons(prefetchEntries(kinesin, selected, 'quest2')).sort()).toEqual([
      'kinesin-walk/flipbook.json', 'kinesin-walk/motion.json',
    ]);
    for (const demo of index.demos.filter(demo => demo.stages?.length)) {
      const stage = demo.stages!.find(stage => stage.id === stageForDevice(demo, 'quest2'))!;
      expect(stageFitsTier(stage, 'quest2'), `${demo.name}/${stage.id}`).toBe(true);
    }
  });

  it('keeps unrestricted devices, the authored default and explicit selected stages available', () => {
    const kinesin = named('kinesin-walk');
    expect(resolveDemoStage(kinesin).stage?.id).toBe('motion');
    for (const device of ['quest3', 'quest-pro', 'vision-pro', 'unknown', 'future-headset']) {
      const selected = resolveDemoStage(kinesin, stageForDevice(kinesin, device));
      expect(selected.stage?.id, device).toBe('cycle');
      expect(lessons(prefetchEntries(kinesin, selected, device)).sort()).toEqual(kinesin.stages!.map(stage => stage.lesson).sort());
    }
    const explicit = resolveDemoStage(kinesin, 'cycle');
    expect(prefetchEntries(kinesin, explicit, 'quest2')[0]!.lesson).toBe('kinesin-walk/cycle.json');
    expect(lessons(prefetchEntries(kinesin, resolveDemoStage(kinesin))).sort()).toEqual(kinesin.stages!.map(stage => stage.lesson).sort());
  });

  it('refuses automatic device selection if no stage fits instead of loading the first disallowed stage', () => {
    const kinesin = named('kinesin-walk');
    const onlyOversized: DemoEntry = { ...kinesin, stages: kinesin.stages!.filter(stage => stage.id === 'cycle') };
    expect(() => stageForDevice(onlyOversized, 'quest2')).toThrow(/No stage.*kinesin-walk.*quest2/);
    expect(stageForDevice(onlyOversized, 'unknown')).toBe('cycle');
  });

  it('maps unidentified device classes to the unrestricted coordinate tier', () => {
    expect(prefetchTier('quest2')).toBe('quest2');
    expect(prefetchTier('quest3')).toBe('quest3');
    expect(prefetchTier('quest-pro')).toBe('quest3');
    expect(prefetchTier('vision-pro')).toBe('quest3');
    expect(prefetchTier('unknown')).toBe('quest3');
    expect(prefetchTier('not-a-device')).toBe('quest3');
    expect(prefetchTier(undefined)).toBe('quest3');
  });

  it('starts and warms the full tube for a future headset class while preserving Quest 2 restrictions', () => {
    // The real index ends with tip, which both tiers allow. Put the tube last
    // to expose a mistaken Quest 2 fallback in launch-stage selection.
    const tube = growth.stages!.find(stage => stage.id === 'tube')!;
    const fixture: DemoEntry = { ...growth, stages: [...growth.stages!.filter(stage => stage.id !== 'tube'), tube] };
    const selected = resolveDemoStage(fixture, stageForDevice(fixture, 'future-headset'));
    expect(selected.stage?.id).toBe('tube');
    expect(selected.entry.coordinates.atomSites).toBe(177_268);
    const warmed = prefetchEntries(fixture, selected, 'future-headset');
    expect(warmed[0]!.lesson).toBe('microtubule-growth/tube.json');
    expect(lessons(warmed).sort()).toEqual(fixture.stages!.map(stage => stage.lesson).sort());

    const quest2 = resolveDemoStage(fixture, stageForDevice(fixture, 'quest2'));
    expect(quest2.stage?.id).toBe('tip');
    expect(quest2.entry.coordinates.atomSites).toBe(43_066);
    expect(lessons(prefetchEntries(fixture, quest2, 'quest2')).sort()).toEqual([...quest2Lessons].sort());
  });

  it('warms one entry for a plain demo, whatever the device', () => {
    const hemoglobin = named('hemoglobin');
    for (const device of [undefined, 'quest2', 'quest3'] as const) {
      const prefetched = prefetchEntries(hemoglobin, resolveDemoStage(hemoglobin), device);
      expect(prefetched).toHaveLength(1);
      expect(prefetched[0]!.lesson).toBe('hemoglobin.json');
    }
  });

  it('warms every tier the device class allows, starting with the selected stage', () => {
    // A grow swaps to whichever tier the wearer names, so everything quest2
    // may hold is cached before the headset goes on — everything but the
    // quest3-only tube.
    const quest2 = prefetchEntries(growth, resolveDemoStage(growth, 'wall'), 'quest2');
    expect(lessons(quest2).sort()).toEqual([...quest2Lessons].sort());
    expect(quest2[0]!.lesson).toBe('microtubule-growth/wall.json');
    expect(lessons(quest2)).not.toContain('microtubule-growth/tube.json');

    const quest3 = prefetchEntries(growth, resolveDemoStage(growth, 'tip'), 'quest3');
    expect(quest3).toHaveLength(quest2Lessons.length + 1);
    expect(lessons(quest3)).toContain('microtubule-growth/tube.json');
    expect(quest3[0]!.lesson).toBe('microtubule-growth/tip.json');
  });

  it('warms the union of every device class with no device, and keeps the per-class set otherwise', () => {
    // No --device warms everything: the running server grows from the device
    // the panel reports, not the launcher flag, so the quest3-only tube must
    // be cached too or a Quest 3 wearer hits the miss in VR.
    const wall = prefetchEntries(growth, resolveDemoStage(growth), undefined);
    expect(lessons(wall).sort()).toEqual([...quest2Lessons, 'microtubule-growth/tube.json'].sort());
    // --stage tube with no --device still opens the tube first.
    const tube = prefetchEntries(growth, resolveDemoStage(growth, 'tube'), undefined);
    expect(tube[0]!.lesson).toBe('microtubule-growth/tube.json');
    expect(lessons(tube).sort()).toEqual([...quest2Lessons, 'microtubule-growth/tube.json'].sort());
    // An explicit --device keeps that class's own set. An explicit quest2 is
    // the one class with a measured ceiling, so it alone leaves the tube out;
    // an explicit unknown is not held to that ceiling and warms the tube too.
    const quest2 = prefetchEntries(growth, resolveDemoStage(growth), 'quest2');
    expect(lessons(quest2).sort()).toEqual([...quest2Lessons].sort());
    expect(lessons(quest2)).not.toContain('microtubule-growth/tube.json');
    const unknown = prefetchEntries(growth, resolveDemoStage(growth), 'unknown');
    expect(lessons(unknown)).toContain('microtubule-growth/tube.json');
  });

  it('warms only lessons the checked-in index actually carries', async () => {
    const prefetched = prefetchEntries(growth, resolveDemoStage(growth, 'wall'), 'quest2');
    for (const entry of prefetched) {
      const manifest = parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, entry.lesson), 'utf8')));
      expect(manifest.provenance.sourceSha256).toBe(entry.coordinates.sha256);
    }
  });

  it('continues the launch when a non-selected tier fails, naming it and the reason', async () => {
    const selected = resolveDemoStage(growth, 'wall');
    const prefetches = prefetchEntries(growth, selected, 'quest2');
    const failing = prefetches[1]!.lesson;
    const messages: string[] = [];
    const result = await warmPrefetches(prefetches, selected.entry.lesson, '/tmp/stereofold-demo-cache', message => messages.push(message), {
      readLesson: async () => undefined,
      resolveCoordinates: async entry => {
        if (entry.lesson === failing) throw Error('https://example.invalid/tier.cif returned HTTP 503.');
        return `/cache/${entry.coordinates.file}`;
      },
    });
    expect(result.coordinates).toBe(`/cache/${selected.entry.coordinates.file}`);
    expect(result.warmed).toContain(selected.entry.lesson);
    expect(result.warmed).not.toContain(failing);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.lesson).toBe(failing);
    expect(result.skipped[0]!.reason).toContain('503');
    const skip = messages.find(message => message.includes('prefetch skipped') && message.includes(failing));
    expect(skip, 'one log line names the skipped tier').toBeDefined();
    expect(skip).toContain('503');
    expect(messages.some(message => /warmed \d+ of \d+ tiers/.test(message) && message.includes(failing))).toBe(true);
  });

  it('still aborts when the selected stage itself fails', async () => {
    const selected = resolveDemoStage(growth, 'wall');
    const prefetches = prefetchEntries(growth, selected, 'quest2');
    await expect(warmPrefetches(prefetches, selected.entry.lesson, '/tmp/stereofold-demo-cache', () => {}, {
      readLesson: async () => undefined,
      resolveCoordinates: async entry => {
        if (entry.lesson === selected.entry.lesson) throw Error('the selected tier no longer matches its recorded SHA-256.');
        return `/cache/${entry.coordinates.file}`;
      },
    })).rejects.toThrow(/recorded SHA-256/);
  });
});

/**
 * The six tiers are one lesson at six sizes, so the thing that has to hold
 * across them is not any single manifest but the mapping between a colour and a
 * protein. In the headset the dimer and protofilament tiers failed exactly
 * that: four arbitrary colours implied four unrelated proteins, the palette
 * mutated to pink and olive green, and alpha and beta were never identifiable.
 * These assert the rule the README states, over every chapter of every tier at
 * once.
 */
const growthTiers = await Promise.all((named('microtubule-growth').stages ?? []).map(async stage => ({
  id: stage.id,
  manifest: parseMolecularLesson(JSON.parse(await readFile(resolve(demosRoot, stage.lesson), 'utf8'))),
})));

/**
 * The colour key is an ATOMIC instrument, so it has an audience.
 *
 * Every rule below resolves a part by author chain and residue range. A density
 * tier has neither — it is one marching-cubes mesh over a 128-cubed grid, and
 * there is no chain to name, no residue to number, and no way to tint one
 * region of a single mesh. Asserting a colour key over it would either force a
 * key that names chains the file does not contain, or force the whole map to be
 * painted one subject's colour, which claims an identity for density that is
 * mostly something else. The density tier gets its own rules instead, below.
 */
const atomicTiers = growthTiers.filter(tier => tier.manifest.coordinates?.kind !== 'volume');
const volumeTiers = growthTiers.filter(tier => tier.manifest.coordinates?.kind === 'volume');

describe('the one colour rule the six microtubule tiers share', () => {
  const ALPHA = '#4a90e2', BETA = '#f5a623', EB3 = '#35c46a', CONTEXT_GREY = '#9aa5b0';
  const tiers = growthTiers;
  // The wall tier is six operators — three strands, two dimers deep — and
  // every chapter of it lights whole strands, never a half of one.
  const WALL_STRANDS = [
    ['alpha-tubulin', 'beta-tubulin', 'alpha-above', 'beta-above'],
    ['middle-alpha', 'middle-beta', 'middle-alpha-above', 'middle-beta-above'],
    ['new-alpha', 'new-beta', 'new-alpha-above', 'new-beta-above'],
  ];

  it('paints the structure itself one neutral grey and never by chain or element', () => {
    for (const { id, manifest } of tiers) {
      for (const chapter of manifest.chapters) {
        const appearance = chapter.immersive?.appearance;
        if (!appearance?.color) continue;
        expect(appearance.color, `${id}/${chapter.id} colour`).toBe('uniform');
        expect(appearance.uniformColor, `${id}/${chapter.id} grey`).toBe(CONTEXT_GREY);
      }
    }
  });

  it('keeps the identity key except in the two measured contact-face chapters', () => {
    for (const { id, manifest } of atomicTiers) {
      // Contact-face chapters teach interfaces rather than whole-chain identity.
      // microtubule-faces.test.ts pins their complete, measured selections.
      const identityChapters = manifest.chapters.filter(chapter =>
        !(['monomer', 'dimer'].includes(id) && chapter.id === 'highlight'));
      const keys = identityChapters.map(chapter => JSON.stringify(chapter.immersive?.emphasis?.parts));
      expect(keys[0]).toBeDefined();
      expect(keys.every(key => key === keys[0]), `${id} key drifts between chapters`).toBe(true);
      for (const chapter of identityChapters) {
        expect(chapter.immersive?.emphasis?.contextOpacity, `${id}/${chapter.id}`).toBe(0.18);
      }
    }
  });

  it('gives alpha, beta and EB3 the same three colours in every tier and nothing else', () => {
    for (const { id, manifest } of atomicTiers) {
      for (const part of manifest.chapters[0]!.immersive!.emphasis!.parts) {
        expect([ALPHA, BETA, EB3], `${id} part ${part.id} colour ${part.color}`).toContain(part.color);
        if (/^alpha/u.test(part.id) || part.id === 'gtp') expect(part.color, `${id} ${part.id}`).toBe(ALPHA);
        if (/^beta/u.test(part.id) || ['gdp', 'taxol', 'gtpgammas'].includes(part.id)) expect(part.color, `${id} ${part.id}`).toBe(BETA);
        if (part.id.startsWith('eb3')) expect(part.color, `${id} ${part.id}`).toBe(EB3);
      }
    }
  });

  it('names the author chains the deposited or subset file actually carries', () => {
    // An emphasis part is resolved by exact author chain id, and the operator
    // subsets suffix theirs, so a key that said "A" for a wall chain would
    // resolve nothing and throw the whole chapter's emphasis away.
    const chainsOf = (id: string) => new Set(tiers.find(tier => tier.id === id)!
      .manifest.chapters[0]!.immersive!.emphasis!.parts.map(part => part.chain));
    expect(chainsOf('monomer')).toEqual(new Set(['A']));
    expect(chainsOf('dimer')).toEqual(new Set(['A', 'B']));
    expect(chainsOf('protofilament')).toEqual(new Set(['A', 'B', 'A-14', 'B-14']));
    expect(chainsOf('wall')).toEqual(new Set(['A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6', 'B-7']));
    // Mol* instances the tube's 26 operators from the asymmetric unit, so its
    // author chains stay the deposited two and one part covers every copy.
    expect(chainsOf('tube')).toEqual(new Set(['A', 'B']));
    expect(chainsOf('tip')).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N']));
  });

  it('lights the copy each tier just added, so a grown tier reads as the same thing bigger', () => {
    const reveal = (id: string) => tiers.find(tier => tier.id === id)!.manifest.chapters[0]!.immersive!.emphasis!;
    expect(reveal('monomer').focus).toBeUndefined();
    // With only beta lit, the dimer read as a solitary amber monomer with a
    // ghost shadow rather than an assembled heterodimer, against its own
    // narration "Alpha stays blue." A two-piece structure cannot ghost one
    // half and still read as the same thing bigger, so the dimer lights both
    // halves.
    expect(reveal('dimer').focus).toEqual(['alpha-tubulin', 'beta-tubulin']);
    // Quest 2 captures showed the grown protofilament with its new dimer as a
    // 35 per cent grey ghost while the first dimer stayed lit, so the lit
    // subject shrank (38.6 % to 22.3 % of the lens) even though
    // the strand grew — against its own narration "same two colours". Like the
    // dimer above and the wall below, a grown tier lights every subunit; the
    // opening chapter's focus is all four tubulins, and only the ligand cargo
    // (GTP, Taxol) stays in the ghost.
    expect(reveal('protofilament').focus).toEqual(['alpha-tubulin', 'beta-tubulin', 'new-alpha', 'new-beta']);
    // The wall tier is the documented exception, and the headset is why. Its
    // opening chapter is titled "Three wide" and captioned "three neighbouring
    // protofilaments", and lighting only the two dimers this tier added left
    // the other two strands as an 18 per cent ghost over a dark desk, so the
    // chapter read as showing ONE strand. A chapter whose own words say "the
    // whole wall" lights the whole
    // wall; the wall tier carries its growth continuity in the caption instead.
    // It says "the whole wall" the only way this planner has: no focus at all,
    // which paints the whole colour key and fades nothing.
    expect(reveal('wall').focus).toBeUndefined();
    expect(reveal('tube').focus).toBeUndefined();
    expect(reveal('tip').focus).toEqual(['eb3', 'eb3-second']);
  });

  it('lights every tubulin subunit of a grown tier, so the lit subject grows with the strand', () => {
    // The protofilament landing used to light one dimer and ghost the new
    // one, so the lit subject shrank while the strand grew. A grown
    // tier's opening chapter lights every tubulin subunit — the lit part count
    // equals the subunit count — and only non-subunit cargo (nucleotides,
    // Taxol) may sit in the ghost. The tip tier is the explicit exception: its
    // subject is the EB3 cap, so it fades the tubulins on purpose.
    const reveal = (id: string) => tiers.find(tier => tier.id === id)!.manifest.chapters[0]!.immersive!.emphasis!;
    const focusOf = (id: string) => {
      const focus = reveal(id).focus;
      return focus == null ? undefined : (Array.isArray(focus) ? [...focus] : [focus]);
    };
    for (const id of ['dimer', 'protofilament']) {
      const parts = reveal(id).parts;
      const subunits = parts.filter(part => part.residues?.from === 1).map(part => part.id);
      expect(subunits.length, `${id} tubulin subunits`).toBeGreaterThan(0);
      expect(focusOf(id)?.sort(), `${id} lit parts`).toEqual([...subunits].sort());
    }
    // Whole-key tiers light every subunit by painting the key with no focus.
    for (const id of ['monomer', 'wall', 'tube']) {
      expect(focusOf(id), `${id} lights the whole key`).toBeUndefined();
      expect(reveal(id).parts.some(part => part.residues?.from === 1), `${id} names tubulin`).toBe(true);
    }
  });

  it('lights exactly the subject each wall chapter says it is about', () => {
    // On a Quest 2 this tier lit the wrong thing in four of its five
    // chapters: chapter 1 lit one strand under the
    // title "Three wide", chapters 2 and 3 authored NO focus at all — which
    // paints the whole colour key and fades nothing, so all three strands came
    // up solid with no subject — and chapter 4 lit two buried ligands inside a
    // 40,908-atom spacefill, which rendered as a uniform grey cloud.
    //
    // A chapter's focus is its subject, so it is asserted against the words the
    // same chapter speaks, per chapter, rather than left to the eye.
    //
    // `undefined` is a subject here, not a missing one: it is the planner's
    // word for "the whole key at full strength, nothing faded", which is what
    // a chapter about the whole wall wants. Naming all twelve parts instead
    // draws the same picture and is deliberately NOT used: it hung the opening
    // chapter in the emulator.
    const wall = tiers.find(tier => tier.id === 'wall')!.manifest;
    const [first, middle, neighbour] = WALL_STRANDS;
    const subjects: Record<string, string[] | undefined> = {
      reveal: undefined,                      // "Three wide": all three strands, no ghost.
      orbit: first,                           // "Two contacts": one strand, its joints.
      highlight: neighbour,                   // "Open sheet": the lateral neighbour.
      site: [...first, 'gtp', 'taxol'],       // "Same cargo": alternation plus its cargo.
      wide: undefined,                        // "Six of many": the wall again, no ghost.
    };
    expect(middle.length).toBe(4);
    for (const chapter of wall.chapters) {
      const emphasis = chapter.immersive!.emphasis!;
      const wanted = subjects[chapter.id];
      if (!wanted) { expect(emphasis.focus, `${chapter.id} lights the whole wall`).toBeUndefined(); continue; }
      const focus = emphasis.focus == null ? [] : (Array.isArray(emphasis.focus) ? emphasis.focus : [emphasis.focus]);
      // Whole strands, never a half of one: lighting two of a strand's four
      // chains is what made chapter 1 read as a single protofilament.
      expect(focus, `${chapter.id} subject`).toEqual(wanted);
      for (const id of focus) expect(emphasis.parts.map(part => part.id), `${chapter.id} focus`).toContain(id);
    }
  });

  it('closes every tier on a named subject rather than an unfocused key', () => {
    // A lesson that ends with nothing focused hands the wearer a molecule with
    // no subject, and the emulator's takeover check has nothing to clear. Each
    // closing chapter lights the thing its own line names.
    for (const { id, manifest } of atomicTiers) {
      const closing = manifest.chapters.at(-1)!.immersive!.emphasis!;
      const focus = closing.focus == null ? [] : (Array.isArray(closing.focus) ? closing.focus : [closing.focus]);
      // The wall tier closes on the whole wall, which this
      // planner spells as no focus. Its closing subject is asserted by the
      // per-chapter test above instead.
      if (id === 'wall') { expect(focus.length, 'wall closes on the whole wall').toBe(0); continue; }
      expect(focus.length, `${id} closes with nothing focused`).toBeGreaterThan(0);
      for (const wanted of focus) {
        expect(closing.parts.map(part => part.id), `${id} closing focus`).toContain(wanted);
      }
    }
  });

  it('speaks one short line per chapter and keeps turning while it says it', () => {
    for (const { id, manifest } of tiers) {
      for (const chapter of manifest.chapters) {
        const line = chapter.immersive?.narration ?? '';
        expect(line.length, `${id}/${chapter.id} has no narration`).toBeGreaterThan(0);
        // A spoken line has to be heard out before the chapter has finished
        // arriving. Twelve words is about four seconds.
        expect(line.trim().split(/\s+/u).length, `${id}/${chapter.id} narration`).toBeLessThan(12);
        const motionKind = typeof chapter.immersive?.motion === 'string'
          ? chapter.immersive?.motion
          : chapter.immersive?.motion?.kind;
        expect(['spin', 'hold', 'orbit', 'dolly', 'turntable'], `${id}/${chapter.id} motion`).toContain(motionKind);
        expect(chapter.title.length, `${id}/${chapter.id} title`).toBeLessThanOrEqual(12);
        expect(chapter.caption.trim().split(/\s+/u).length, `${id}/${chapter.id} caption`).toBeLessThanOrEqual(18);
      }
    }
  });

describe('the wall tier strand tint', () => {
  const wall = () => growthTiers.find(tier => tier.id === 'wall')!.manifest;

  it('shades whole-structure chapters only, and leaves part chapters exact', async () => {
    // Chapters 1 and 5 light every copy, so the three protofilaments need one
    // lightness step each to stay countable. Part chapters light one strand
    // and ghost the rest, so they carry no flag and keep their colours.
    const flagged = new Map(wall().chapters.map(chapter =>
      [chapter.id, (chapter.immersive?.emphasis as { strandShades?: unknown } | undefined)?.strandShades]));
    expect(flagged.get('reveal')).toBe(true);
    expect(flagged.get('wide')).toBe(true);
    for (const id of ['orbit', 'highlight', 'site']) expect(flagged.get(id)).toBeUndefined();
  });

  it('keeps the base colours verbatim in the JSON, even on shaded chapters', async () => {
    for (const chapter of wall().chapters) {
      for (const part of chapter.immersive?.emphasis?.parts ?? []) {
        expect(['#4a90e2', '#f5a623'], `${chapter.id} part ${part.id}`).toContain(part.color);
      }
    }
  });

  it('appears in no other tier and no other lesson file', async () => {
    for (const { id, manifest } of growthTiers) {
      for (const chapter of manifest.chapters) {
        const emphasis = chapter.immersive?.emphasis as { strandShades?: unknown } | undefined;
        if (id === 'wall') continue;
        expect(emphasis?.strandShades, `${id}/${chapter.id}`).toBeUndefined();
      }
    }
  });

  it('is an optional boolean on the emphasis schema', async () => {
    const raw = JSON.parse(await readFile(resolve(demosRoot, 'microtubule-growth/wall.json'), 'utf8'));
    const shaded = { ...raw.chapters[0].immersive.emphasis, strandShades: 'yes' };
    expect(() => parseMolecularLesson({ ...raw, chapters: [{ ...raw.chapters[0], immersive: { ...raw.chapters[0].immersive, emphasis: shaded } }] }))
      .toThrow(/strandShades/);
    const unflagged = { ...raw.chapters[0].immersive.emphasis };
    delete (unflagged as { strandShades?: unknown }).strandShades;
    expect(() => parseMolecularLesson({ ...raw, chapters: [{ ...raw.chapters[0], immersive: { ...raw.chapters[0].immersive, emphasis: unflagged } }] }))
      .not.toThrow();
  });
});
  it('says what the coordinates are, once per tier, and never invents a tip protein', () => {
    for (const { id, manifest } of tiers) {
      const text = JSON.stringify(manifest);
      if (id === 'tip') {
        expect(text).toContain('GTPgammaS');
        expect(text).toMatch(/not EB1/u);
      } else if (id === 'filament') {
        // EMD-6347 is a separate specimen from 5SYF. 3JAK belongs to the
        // same study, but RCSB links it to EMD-6349; it is a related reference.
        // The preparation and display colors also need their actual scope.
        expect(text).toContain('GTPgammaS');
        expect(text).toContain('EB3');
        expect(text).toContain('EMD-6347');
        expect(text).toContain('averages each 4 by 4 by 4 voxel block');
        expect(text).toContain('different experimental specimen');
        expect(text).toContain('RCSB links 3JAK to EMD-6349');
        expect(text).toContain('not molecular segmentation');
      } else {
        // 5SYF is a Taxol-stabilised cryo-EM reconstruction, and every tier of
        // it says so in its own words rather than relying on the tier before.
        expect(text, `${id} never says Taxol`).toMatch(/Taxol/u);
      }
    }
  });
});

/**
 * The density tier, held to the rules a mesh actually has.
 *
 * `filament` is the one tier drawn from a cryo-EM map instead of coordinates,
 * and the things that can go silently wrong with it are different in kind from
 * anything the atomic tiers can do. A contour copied from the deposited map
 * meshes a perforated shell; a triangle count that drifts from the asset turns
 * the growth refusal into a guess; a lesson that forgets to say the map was
 * downsampled is a picture nobody can reproduce.
 */
describe('the density tier', () => {
  const growth = named('microtubule-growth');
  const stage = (growth.stages ?? []).find(entry => entry.id === 'filament')!;
  const tier = volumeTiers.find(entry => entry.id === 'filament')!;

  it('is the only volume tier, and the index and the lesson agree on the map', () => {
    expect(volumeTiers.map(entry => entry.id)).toEqual(['filament']);
    const volume = stage.coordinates.volume!;
    const coordinates = tier.manifest.coordinates!;
    expect(coordinates.kind).toBe('volume');
    // The lesson names the CACHED file, which is the prepared map, not the
    // download: the digest beside it is the prepared map's digest, and that is
    // the digest the headset verifies.
    expect(coordinates.ref).toBe(stage.coordinates.file);
    expect(coordinates.sha256).toBe(stage.coordinates.sha256);
    expect(coordinates.contour).toBe(volume.contour);
    expect(coordinates.downsample).toBe(volume.downsample);
    expect(stage.coordinates.file.endsWith('.map')).toBe(true);
  });

  it('quotes the contour on the prepared map and records the deposited one beside it', () => {
    const volume = stage.coordinates.volume!;
    // 3.3 on the 4x map is 5.47 sigma; 5.0 on the deposited map is 5.46 sigma.
    // The two levels are the SAME picture, which is the whole point of not
    // carrying 5.0 forward: at 5.0 on this map only 4,264 voxels survive.
    expect(volume.contour).toBe(3.3);
    expect(volume.depositedContour).toBe(5);
    expect(volume.contourSigma).toBeCloseTo(5.47, 2);
    expect(volume.downsample).toBe(4);
    expect(volume.grid).toEqual([128, 128, 128]);
    // 1.32 A deposited voxels, downsampled four times.
    expect(volume.voxelAngstroms).toBeCloseTo(1.32 * volume.downsample, 6);
  });

  it('fits the Quest 2 triangle budget on a measured number, not an estimate', () => {
    const volume = stage.coordinates.volume!;
    // This is the count the HEADSET draws, which is not the
    // count Mol*'s CPU marching cubes gives for the same map and the same
    // contour. A Quest takes `IsosurfaceTextureMeshVisual`, which uploads the
    // grid as a uint8 texture (`gpuDataType: 'byte'`, the default) and extracts
    // the surface from that quantized copy: 178,236 triangles, against 177,604
    // over the float32 field. The 632 are reproduced exactly in Node by
    // quantizing the grid the way `createVolumeTexture2d` does; the test below
    // holds every Mol* default that choice rests on. Re-measure after any
    // change to the downsample, the crop or the contour.
    expect(volume.triangles).toBe(178_236);
    expect(volume.triangles).toBeLessThan(QUEST2_TRIANGLE_CEILING);
    // The old quest3-only hold is gone: the tier is offered to both headsets
    // on its measured size.
    expect(stage.tiers).toEqual(['quest2', 'quest3']);
  });

  it('draws every chapter as one uniform grey isosurface and never as atoms', () => {
    for (const chapter of tier.manifest.chapters) {
      const appearance = chapter.immersive?.appearance;
      expect(appearance?.representation, `filament/${chapter.id}`).toBe('isosurface');
      // A single mesh has one colour, so the grey is the whole colour scheme:
      // there is no region of it that could be lit a second colour honestly.
      expect(appearance?.color).toBe('uniform');
      expect(appearance?.uniformColor).toBe('#9aa5b0');
      // An emphasis part resolves by author chain; this file has no chains.
      expect(chapter.immersive?.emphasis).toBeUndefined();
      expect(chapter.immersive?.selection).toBeUndefined();
    }
  });
});
