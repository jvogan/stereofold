/**
 * Growing a staged demo inside one headset session.
 *
 * Every tier of `microtubule-growth` is a whole lesson with its own coordinate
 * file, so before this module growing meant restarting the host and re-opening
 * the page: the wearer left VR to see the next size. The source swap itself was
 * never the problem — `replace_inspection_source` and `navigate_experience`
 * already rebuild the structure in place and `preserveSourceTransitionAnchor`
 * holds the room centre and diameter across it, so an immersive session
 * survives. What those two drop is `customTour`, the authored lesson, because a
 * swap mints a fresh attachment and only `shared` and `commands` are carried
 * over. This module is the missing half: which tier comes next, whether the
 * paired device can hold it, and where its coordinates and lesson live.
 *
 * Nothing here invents coordinates. A tier is a file the demo index already
 * records with its digest, and the digest is still what is checked.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Types only: `scripts/quest-demo.ts` spawns processes and reaches the network,
// and none of that belongs in the bundled server. This module reads the same
// checked-in index itself.
import type { DemoEntry, DemoIndex, DemoStage, DemoTier } from '../scripts/quest-demo.js';

/**
 * The demo index, beside this module in the checkout and beside the bundle in
 * `dist`. `plugin/src/..` and `plugin/dist/..` both reach `plugin/demos`.
 */
export const DEMO_INDEX_PATH = fileURLToPath(new URL('../demos/index.json', import.meta.url));
/** Coordinates are downloads, so they live in the cache, never in the checkout. */
export const demoCoordinatePath = (file: string, home: string = homedir()): string =>
  resolve(home, 'Library/Caches/Stereofold/demos', file);

let cachedIndex: Promise<DemoIndex> | undefined;
/** The checked-in demo index, read once per server process. */
export async function readGrowthIndex(path: string = DEMO_INDEX_PATH): Promise<DemoIndex> {
  if (path !== DEMO_INDEX_PATH) return JSON.parse(await readFile(path, 'utf8')) as DemoIndex;
  cachedIndex ??= readFile(path, 'utf8').then(text => JSON.parse(text) as DemoIndex);
  return await cachedIndex;
}

/**
 * Which tier a paired headset can hold, from the device classes
 * `input-capabilities.mjs` reports. Only the Quest 2 has a measured ceiling
 * (`QUEST2_ATOM_SITE_CEILING` below), so only `quest2` is refused a tier.
 * A class this Mac cannot identify is NOT held to the Quest 2 ceiling: a
 * Quest always names its model in the user agent, visionOS Safari never
 * does, so `unknown` and `hand-only` are more likely a Vision Pro than a
 * Quest 2, and refusing them was a limit invented for hardware this project
 * has never measured.
 */
export const DEMO_TIER_BY_DEVICE: Readonly<Record<string, DemoTier>> = Object.freeze({
  quest2: 'quest2', quest3: 'quest3', 'quest-pro': 'quest3', 'vision-pro': 'quest3',
  'hand-only': 'quest3', unknown: 'quest3',
});

/** The lesson id a staged demo gives one tier: `<demo>-<stage>`. */
export function growthLessonId(demoName: string, stageId: string): string {
  return `${demoName}-${stageId}`;
}

/**
 * What `molecular-lesson-tour.ts` puts in front of a manifest id when it
 * compiles a lesson into the tour a session actually loads
 * (`molecular-lesson-tour.ts:12`).
 *
 * This prefix is why `grow_structure` refused every real session
 * before it was accounted for: the tier identity is the lesson id, the manifest spells it
 * `microtubule-growth-monomer`, and the loaded `customTour.id` spells the same
 * lesson `lesson-microtubule-growth-monomer`. Comparing the two spellings
 * matched nothing, so every grow in a live session answered "This session is
 * not playing a staged lesson" — including the first one the emulator drove.
 * The unit tests passed because they asked with a manifest id, which is not the
 * id the server ever reads.
 */
export const TOUR_LESSON_PREFIX = 'lesson-';
/** The manifest id behind a loaded tour id, whichever of the two spellings arrives. */
export function growthManifestId(lessonId: string): string {
  return lessonId.startsWith(TOUR_LESSON_PREFIX) ? lessonId.slice(TOUR_LESSON_PREFIX.length) : lessonId;
}

export type GrowthStage = {
  demo: string; stage: DemoStage; index: number; total: number;
  lessonId: string; lessonPath: string;
};

/** Every tier of every staged demo, in authored order. */
export function growthStages(index: DemoIndex): GrowthStage[] {
  return index.demos.flatMap((demo: DemoEntry) => (demo.stages ?? []).map((stage, position, all) => ({
    demo: demo.name, stage, index: position, total: all.length,
    lessonId: growthLessonId(demo.name, stage.id), lessonPath: stage.lesson,
  })));
}

/**
 * The tier a loaded lesson is showing, or nothing when the lesson is not staged.
 *
 * Takes either spelling of the id: the manifest's own, and the `lesson-`
 * prefixed one the compiled tour carries, which is what a live session reports.
 */
export function growthStageOfLesson(index: DemoIndex, lessonId: string | undefined): GrowthStage | undefined {
  if (!lessonId) return undefined;
  const manifestId = growthManifestId(lessonId);
  return growthStages(index).find(entry => entry.lessonId === manifestId);
}

/**
 * The Quest 2 ceiling, in atom sites.
 *
 * This is the `tip` tier exactly (3JAK, EB3 on a microtubule end), the largest
 * structure a Quest 2 has rendered as cartoon on the unattended
 * driver (68-72 fps); the `wall` (40,908)
 * sits under it. A tier above it is refused on a quest2-class headset rather
 * than attempted: the failure mode is not a slow frame, it is the browser
 * dropping the immersive session with the headset on.
 */
export const QUEST2_ATOM_SITE_CEILING = 43_066;

/**
 * The Quest 2 ceiling, in triangles, for a tier that has no atoms.
 *
 * A density tier is one static marching-cubes mesh, built once
 * when the source loads and never rebuilt, so what it costs the headset is
 * per-frame vertex work rather than the per-atom build that the atom ceiling
 * above is measuring. The two units are not convertible and must never be
 * compared to each other: the `filament` tier carries ZERO atom sites and
 * 178,236 triangles, so an atom-site test would wave through a mesh of any
 * size, and a triangle test applied to an atomic tier would wave through the
 * 177,268-site tube that drops the session.
 *
 * 500,000 is the standing static-mesh budget for this headset — the measured
 * `xr-render-budget.mjs` surface table puts a `medium` marching-cubes surface
 * at 387,612 triangles and a `high` one at 1,006,332, and the Quest 2 draws
 * the first and not the second. `QUEST2_STATIC_TRIANGLE_CEILING` in
 * `xr-render-budget.mjs` is the page's copy of this same number; they are
 * asserted equal by the lab test, because a Mac that offers a tier the page
 * then refuses is worse than either rule alone.
 */
export const QUEST2_TRIANGLE_CEILING = 500_000;

/**
 * How big a tier is and in which unit, for the one headset that has a ceiling.
 *
 * The unit is a property of the tier, not of the caller, so it is decided here
 * once and the refusal text below reads it rather than assuming atoms.
 */
export function stageSize(stage: DemoStage): { count: number; unit: 'atom sites' | 'triangles'; ceiling: number } {
  const volume = stage.coordinates.volume;
  return volume
    ? { count: volume.triangles, unit: 'triangles', ceiling: QUEST2_TRIANGLE_CEILING }
    : { count: stage.coordinates.atomSites, unit: 'atom sites', ceiling: QUEST2_ATOM_SITE_CEILING };
}

export type GrowthRequest = 'next' | 'back' | 'first' | 'last' | (string & {});

export type GrowthRefusal = { refused: true; reason: string; spoken: string };
export type GrowthResolution = { refused: false; target: GrowthStage };

/** A spoken refusal is read out in the headset, so it stays under twelve words. */
const SPOKEN_MAX_WORDS = 11;
const spokenWords = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
const refuse = (reason: string, spoken: string): GrowthRefusal => {
  if (spokenWords(spoken).length > SPOKEN_MAX_WORDS) throw Error(`A spoken refusal must stay under twelve words: "${spoken}"`);
  return { refused: true, reason, spoken };
};

/** Whether a device class may hold a tier, from the tier list the stage declares. */
export function stageFitsTier(stage: DemoStage, tier: DemoTier): boolean {
  if (!stage.tiers.includes(tier)) return false;
  if (tier !== 'quest2') return true;
  const size = stageSize(stage);
  return size.count <= size.ceiling;
}

/**
 * Which tier a `grow` request means, or why it is refused.
 *
 * `next` and `back` step one tier; any other value names a tier by id. The
 * device tier is checked here rather than in the headset, because by the time
 * a Quest 2 is parsing 177,268 atom sites the wearer has already lost the
 * session.
 */
export function resolveGrowthTarget(stages: readonly GrowthStage[], current: GrowthStage,
  request: GrowthRequest, tier: DemoTier): GrowthResolution | GrowthRefusal {
  const siblings = stages.filter(entry => entry.demo === current.demo);
  const position = siblings.findIndex(entry => entry.lessonId === current.lessonId);
  const wanted = request === 'next' ? siblings[position + 1]
    : request === 'back' ? siblings[position - 1]
      : request === 'first' ? siblings[0]
        : request === 'last' ? siblings[siblings.length - 1]
          : siblings.find(entry => entry.stage.id === request);
  if (!wanted) {
    if (request === 'next') return refuse(`${current.stage.id} is the largest tier of ${current.demo}.`, 'That is the last one. Nothing bigger here.');
    if (request === 'back') return refuse(`${current.stage.id} is the smallest tier of ${current.demo}.`, 'That is the smallest one already.');
    return refuse(`${current.demo} has no tier called "${request}". It has ${siblings.map(entry => entry.stage.id).join(', ')}.`,
      'I do not know that one. Try grow it.');
  }
  if (wanted.lessonId === current.lessonId) return refuse(`${current.stage.id} is already loaded.`, 'You are looking at that one already.');
  if (!stageFitsTier(wanted.stage, tier)) {
    // The unit comes from the tier, so a density tier is refused
    // in triangles and never in atom sites it does not have.
    const size = stageSize(wanted.stage);
    return refuse(`${wanted.stage.id} needs ${wanted.stage.tiers.join(' or ')} and carries ${size.count.toLocaleString()} ${size.unit}; this headset is ${tier}.`,
      'Too big for this headset. Staying here.');
  }
  return { refused: false, target: wanted };
}

/** What the wearer hears when a tier lands. Short: it is spoken, not read. */
export function growthConfirmation(target: GrowthStage, grew: boolean): string {
  const prefix = grew ? 'Grown to' : 'Back to';
  const title = target.stage.title.replace(/^[A-Z]\.\s*/, '').toLowerCase();
  const room = SPOKEN_MAX_WORDS - spokenWords(prefix).length;
  const clipped = spokenWords(title).slice(0, Math.max(0, room)).join(' ');
  const spoken = clipped ? `${prefix} ${clipped}.` : `${prefix}.`;
  if (spokenWords(spoken).length > SPOKEN_MAX_WORDS) throw Error(`A spoken confirmation must stay under twelve words: "${spoken}"`);
  return spoken;
}

/**
 * A host-initiated refusal has to reach the page.
 *
 * `grow_structure` decides the ceiling on this Mac and returns the spoken
 * line to whoever called it. A grow the wearer asked for from inside the
 * headset is that caller — `inspector.ts` `growStructure` — so the page
 * already has the sentence and can put it on the caption plate. A grow the
 * Mac asked for (`headset-drive.ts` `host.agent('grow_structure')`, or an
 * agent following "Say this in the headset") is not: the tool returns to
 * the Mac, the structure does not change, and the page's 1 Hz poll sees
 * nothing. The 91bdaff `grow-refused.png` is that gap: the wearer heard
 * the line (or the driver recorded it) and the plate stayed on Wall 1/5.
 *
 * This mailbox rides `poll_inspection` the same way `say_to_headset` does.
 * A connected companion panel claims the next notice; a panel that has
 * only just attached starts from now, so a stale refusal is never replayed
 * into a session that did not ask.
 */
export type GrowthCaptionNotice = { spoken: string; refused: boolean; from?: string };

export type GrowthCaptionMailbox = {
  offer(notice: GrowthCaptionNotice): GrowthCaptionNotice | undefined;
  claim(panelId: string): GrowthCaptionNotice | undefined;
};

export function createGrowthCaptionMailbox({ maxPending = 4 }: { maxPending?: number } = {}): GrowthCaptionMailbox {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError('Growth caption mailbox requires a bounded pending capacity.');
  }
  let seq = 0;
  const entries: Array<GrowthCaptionNotice & { seq: number }> = [];
  const cursors = new Map<string, number>();

  return {
    offer(notice) {
      const spoken = typeof notice?.spoken === 'string' ? notice.spoken.trim() : '';
      if (!spoken) return undefined;
      const entry = {
        spoken,
        refused: notice.refused === true,
        ...(typeof notice.from === 'string' && notice.from ? { from: notice.from } : {}),
        seq: ++seq,
      };
      entries.push(entry);
      while (entries.length > maxPending) entries.shift();
      const { seq: _seq, ...offered } = entry;
      return offered;
    },
    claim(panelId) {
      if (typeof panelId !== 'string' || !panelId) return undefined;
      const cursor = cursors.get(panelId);
      if (cursor === undefined) {
        cursors.set(panelId, seq);
        return undefined;
      }
      const next = entries.find(entry => entry.seq > cursor);
      if (!next) return undefined;
      cursors.set(panelId, next.seq);
      const { seq: _seq, ...notice } = next;
      return notice;
    },
  };
}
