/**
 * Growth feedback for the wearer's caption plate.
 *
 * What "grow it" looks like, not just what it says.
 *
 * A growth command is answered twice: once out loud, once on the caption
 * glass above the menu. The spoken half already worked — `grow_structure`
 * returns one sentence for both outcomes ("Grown to one tubulin dimer." and
 * "Too big for this headset. Staying here." travel the same return) and the
 * voice runner speaks it. The written half was missing: a refusal changed
 * nothing on the plate, and every confirmed tier opened its own lesson at
 * scene 1, so the plate's page row read "Scene 1 / 5" after every step and
 * looked stuck.
 *
 * Two behaviours live here, both pure and Mol*-free so `node --test` can
 * hold them:
 *
 * - The caption line: a growth sentence replaces the chapter caption for
 *   `GROWTH_CAPTION_MS` of XR frames, then the plate returns to the chapter
 *   caption. Time is read off XR frame timestamps through the presenting
 *   session's own scheduler (`scheduleViewFrame` in `viewer.mjs`), never
 *   `window.requestAnimationFrame`, which does not tick inside immersion.
 *   A refusal ("Too big for this headset. Staying here.") is not a chapter,
 *   so while it is armed the title reads `GROWTH_LIMIT_TITLE` and the page
 *   row names the tier with its ceiling (`growthLimitPageRow`); when the
 *   window ends the chapter title and row come back untouched.
 * - The page row: the tier name rides with the scene (`Wall 1/5` rather than
 *   `Scene 1 / 5`). The menu label budget does not apply here: this is a
 *   caption readout row, and the caption glass wraps it, so the full tier
 *   name is always kept (`Protofilament 1/5`, never `Protofil`). The plate
 *   width is unchanged; long rows wrap to a second line instead of clipping.
 */

/**
 * No budget import. The menu label budget belongs to
 * menu rows; this module draws caption rows, which the caption glass wraps.
 */

/**
 * How long a growth sentence stays on the caption plate, in milliseconds.
 *
 * About four seconds of XR frames: long enough to read a sentence under a
 * dozen words, short enough that the chapter caption is back before the new
 * tier's opening narration ends.
 */
export const GROWTH_CAPTION_MS = 4_000;

/**
 * The event the companion poll republishes when the host
 * refused a grow the page itself did not post. `inspector.ts` dispatches it
 * from `poll_inspection`; `viewer.mjs` arms the same overlay the grow-structure
 * branch arms for a wearer-asked grow. The name is the contract; both sides
 * have to spell it the same way.
 */
export const GROWTH_CAPTION_EVENT = 'stereofold-growth-caption';

/**
 * What the plate title reads while a growth refusal owns it.
 *
 * A refusal is not a lesson chapter, so the chapter title ("Three wide")
 * must not sit above the refusal sentence. Short enough for the title line.
 */
export const GROWTH_LIMIT_TITLE = 'Limit reached';

/** The ceiling named on the refusal page row. Kept short; the tier joins it. */
export const GROWTH_LIMIT_CEILING = 'Quest 2 limit';

/** The staged demo whose tiers share one growth run. */
export const GROWTH_DEMO_PREFIX = 'microtubule-growth-';
/** The compiled-tour prefix `molecular-lesson-tour.ts` puts on every id. */
const TOUR_LESSON_PREFIX = 'lesson-';

/** The tier ids of the growth run, in authored order. */
export const GROWTH_TIER_IDS = Object.freeze(['monomer', 'dimer', 'protofilament', 'wall', 'tube', 'tip']);

/**
 * The plate name of one tier: its id with a capital, nothing more.
 *
 * The lesson titles ("B. One tubulin dimer") are written for the desktop
 * sidebar; the plate has eight characters, so it gets the short noun.
 */
export function tierCaptionName(tier) {
  const id = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  if (!id) return '';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * The honest shortening of one tier name: its leading letters, no vowels
 * dropped, no synonyms invented.
 *
 * Three letters, because that is what the budget leaves beside a scene
 * count: `Dim 1/5` is seven characters against the eight the seat is solved
 * for, while `Dimer 1/5` is nine.
 */
export function tierShortName(tier) {
  return tierCaptionName(tier).slice(0, 3);
}

/**
 * The growth tier behind a loaded tour id, or `undefined` for a lesson that
 * is not part of the growth run.
 *
 * Takes either spelling of the id: the manifest's own
 * (`microtubule-growth-dimer`) and the `lesson-` prefixed one the compiled
 * tour carries (`lesson-microtubule-growth-dimer`), which is what a live
 * session reports. Anything outside the `microtubule-growth-` demo is not a
 * tier and returns `undefined`, so those lessons keep their `Scene n/m` row.
 */
export function growthTierFromLessonId(lessonId) {
  if (typeof lessonId !== 'string' || !lessonId) return undefined;
  const manifest = lessonId.startsWith(TOUR_LESSON_PREFIX) ? lessonId.slice(TOUR_LESSON_PREFIX.length) : lessonId;
  if (!manifest.startsWith(GROWTH_DEMO_PREFIX)) return undefined;
  const tier = manifest.slice(GROWTH_DEMO_PREFIX.length);
  return GROWTH_TIER_IDS.includes(tier) ? tier : undefined;
}

/**
 * The plate's page row for one growth tier: the tier name with the scene.
 *
 * `scene` is 1-based, `total` the tier lesson's scene count, so the wall's
 * opening chapter reads `Wall 1/5` and the protofilament's reads
 * `Protofilament 2/5`. The full tier name is always kept: the caption glass
 * wraps a long row to a second line, and the plate width never changes, so
 * there is nothing to clip for. When the tour has not started (no scene or
 * total yet) the row is the tier name alone.
 *
 * @param {{tier:string, scene?:number, total?:number}} input
 * @returns {string} the row text, never clipped
 */
export function growthPageRow({ tier, scene, total } = {}) {
  const name = tierCaptionName(tier);
  if (!name) return '';
  const count = (value) => Number.isFinite(Number(value)) && Math.floor(Number(value)) >= 1
    ? Math.floor(Number(value)) : undefined;
  const at = count(scene), of = count(total);
  if (at === undefined || of === undefined) return name;
  return `${name} ${at}/${of}`;
}

/**
 * The plate's page row while a growth refusal owns it: the tier with its
 * ceiling (`Wall · Quest 2 limit`). Short by construction; the caption
 * glass wraps it rather than clipping it. Without a tier it is the ceiling
 * alone.
 *
 * @param {string} tier the growth tier id
 * @returns {string} the refusal row text
 */
export function growthLimitPageRow(tier) {
  const name = tierCaptionName(tier);
  return name ? `${name} · ${GROWTH_LIMIT_CEILING}` : GROWTH_LIMIT_CEILING;
}

/**
 * Whether a growth sentence is a ceiling refusal rather than a confirmation.
 *
 * The host's refusal line ("Too big for this headset. Staying here.") is the
 * contract; a confirmation ("Grown to ...") never contains it. Case is
 * ignored so a reworded host line still reads as a limit.
 *
 * @param {unknown} spoken
 * @returns {boolean}
 */
export function isGrowthRefusal(spoken) {
  return typeof spoken === 'string' && /too big/i.test(spoken);
}

/**
 * The spoken line inside a host growth notice, or empty.
 *
 * The companion poll delivers `{ spoken, refused, from }` when the Mac
 * refused a grow the page did not post. This is the one field the caption
 * plate needs; a missing or blank notice is not an overlay.
 *
 * @param {unknown} notice
 * @returns {string}
 */
export function growthSpokenFromNotice(notice) {
  if (!notice || typeof notice !== 'object') return '';
  const spoken = typeof notice.spoken === 'string' ? notice.spoken.trim() : '';
  return spoken;
}

/**
 * One growth sentence waiting out its four seconds on the plate.
 *
 * `refused` marks a ceiling refusal decided on the Mac: the companion poll
 * carries it explicitly on the host notice, and the wearer-asked path
 * derives it from the sentence itself. It is what swaps the title and the
 * page row while the sentence is armed; the tour player never sees it.
 *
 * @param {string} spoken the host's own sentence, confirm or refusal
 * @param {number} atMs when it landed, on the same clock `nowMs` uses
 * @param {{refused?:boolean}} [options]
 * @returns {{spoken:string, atMs:number, refused?:true}|undefined}
 */
export function createGrowthOverlay(spoken, atMs, { refused = false } = {}) {
  const line = typeof spoken === 'string' ? spoken.trim() : '';
  if (!line || !Number.isFinite(atMs)) return undefined;
  const denied = refused === true || isGrowthRefusal(line);
  return denied ? { spoken: line, atMs, refused: true } : { spoken: line, atMs };
}

/**
 * The arm path for a host growth notice.
 *
 * The companion poll delivers `{ spoken, refused, from }` when the Mac
 * refused a grow the page did not post. This keeps the notice's explicit
 * refusal flag on the overlay the plate arms, so the title swap does not
 * depend on matching the sentence text alone. A missing or blank notice is
 * not an overlay.
 *
 * @param {unknown} notice
 * @param {number} atMs when it landed, on the same clock `nowMs` uses
 * @returns {{spoken:string, atMs:number, refused?:true}|undefined}
 */
export function growthOverlayFromNotice(notice, atMs) {
  const spoken = growthSpokenFromNotice(notice);
  if (!spoken) return undefined;
  const refused = (notice !== null && typeof notice === 'object' && notice.refused === true)
    || isGrowthRefusal(spoken);
  return createGrowthOverlay(spoken, atMs, { refused });
}

/**
 * Whether a growth sentence still owns the plate.
 *
 * Half-open at the far end: at exactly `GROWTH_CAPTION_MS` the chapter
 * caption is back. A negative elapsed (a clock that moved backwards) reads
 * as expired rather than as a sentence owed forever.
 */
export function growthOverlayActive(overlay, nowMs, durationMs = GROWTH_CAPTION_MS) {
  if (!overlay || typeof overlay.spoken !== 'string' || !overlay.spoken) return false;
  if (!Number.isFinite(overlay.atMs) || !Number.isFinite(nowMs) || !Number.isFinite(durationMs)) return false;
  const elapsed = nowMs - overlay.atMs;
  return elapsed >= 0 && elapsed < durationMs;
}

/**
 * What the caption plate reads right now: the growth sentence while it owns
 * the plate, the chapter caption otherwise — including when there never was
 * a growth sentence at all.
 */
export function resolveGrowthCaption({ chapterCaption, overlay, nowMs, durationMs = GROWTH_CAPTION_MS } = {}) {
  const chapter = typeof chapterCaption === 'string' ? chapterCaption : '';
  return growthOverlayActive(overlay, nowMs, durationMs) ? overlay.spoken : chapter;
}

/**
 * Whether a growth refusal still owns the plate title and page row.
 *
 * Armed means live (inside the window) AND a refusal: a confirmation leaves
 * the chapter title and row alone, and an expired refusal hands them back.
 */
export function growthRefusalActive(overlay, nowMs, durationMs = GROWTH_CAPTION_MS) {
  if (!growthOverlayActive(overlay, nowMs, durationMs)) return false;
  return overlay.refused === true || isGrowthRefusal(overlay.spoken);
}

/**
 * What the plate title reads right now: `GROWTH_LIMIT_TITLE` while a
 * refusal is armed, the chapter title otherwise — including after the
 * window ends, when the chapter title comes back.
 */
export function resolveGrowthTitle({ chapterTitle, overlay, nowMs, durationMs = GROWTH_CAPTION_MS } = {}) {
  const chapter = typeof chapterTitle === 'string' ? chapterTitle : '';
  return growthRefusalActive(overlay, nowMs, durationMs) ? GROWTH_LIMIT_TITLE : chapter;
}

/**
 * What the page row reads right now: the tier with its ceiling while a
 * refusal is armed, the chapter row otherwise — including after the window
 * ends, when the chapter row comes back.
 */
export function resolveGrowthProgress({ chapterProgress, tier, overlay, nowMs, durationMs = GROWTH_CAPTION_MS } = {}) {
  if (growthRefusalActive(overlay, nowMs, durationMs)) return growthLimitPageRow(tier);
  return typeof chapterProgress === 'string' ? chapterProgress : '';
}

/**
 * What the caption plate draws for a lesson that asked to be shown as a plain
 * labelled structure with no tour chrome.
 *
 * A lesson's `presentation.captionCard === 'hidden'` reaches the readout as
 * `captionCard: 'hidden'` on the tour state (`tour-player.ts` state()). The
 * card — the chapter title, the `Scene n / m` counter and the narration
 * line — is then not drawn at all: with no readout lines the geometry builds
 * no caption backing glass either (`spatial-toolbar-geometry.mjs` leaves
 * `captionBacking` undefined at zero lines), so the wearer sees the labelled
 * structure and the menu alone. The menu rows and the Talk button are
 * separate rows and keep working, and narration still plays — voice is a
 * control, not chrome.
 *
 * A live growth sentence is the host answering the wearer's own press, not
 * tour chrome, so it still draws alone on the plate. No growth tier lesson
 * hides its card, so this branch is a safety net rather than a usual path.
 *
 * @param {{growthSpoken?:string}} [input]
 * @returns {Array<{text:string}>} the rows to draw, possibly none
 */
export function hiddenCaptionCardRows({ growthSpoken = '' } = {}) {
  const spoken = typeof growthSpoken === 'string' ? growthSpoken.trim() : '';
  return spoken ? [{ text: spoken }] : [];
}
