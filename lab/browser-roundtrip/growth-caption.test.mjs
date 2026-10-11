/**
 * The plate answers "grow it" in writing, not just in speech.
 *
 * The growth sentence owns the caption line for about four seconds of XR
 * frames, then the chapter caption is back; and the page row carries the
 * tier with the scene inside the row's eight-character budget. These run
 * the real module with a fake clock, so no headset and no Mol* are needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GROWTH_CAPTION_EVENT, GROWTH_CAPTION_MS, GROWTH_LIMIT_CEILING, GROWTH_LIMIT_TITLE,
  createGrowthOverlay, growthLimitPageRow, growthOverlayActive, growthOverlayFromNotice,
  growthPageRow, growthRefusalActive, growthSpokenFromNotice, growthTierFromLessonId,
  isGrowthRefusal, resolveGrowthCaption, resolveGrowthProgress, resolveGrowthTitle,
  tierCaptionName, tierShortName } from './growth-caption.mjs';

const CONFIRMED = 'Grown to one tubulin dimer.';
const REFUSED = 'Too big for this headset. Staying here.';
const CHAPTER = 'Beta tubulin joins in amber. Alpha stays blue.';

test('the growth window lasts about four seconds', () => {
  assert.equal(GROWTH_CAPTION_MS, 4_000);
  const overlay = createGrowthOverlay(CONFIRMED, 1_000);
  assert.equal(growthOverlayActive(overlay, 1_000), true);
  assert.equal(growthOverlayActive(overlay, 1_000 + GROWTH_CAPTION_MS - 1), true);
  assert.equal(growthOverlayActive(overlay, 1_000 + GROWTH_CAPTION_MS), false);
  assert.equal(growthOverlayActive(overlay, 1_000 + GROWTH_CAPTION_MS + 5_000), false);
});

test('a refusal owns the plate exactly like a confirmation', () => {
  const overlay = createGrowthOverlay(REFUSED, 0);
  assert.equal(growthOverlayActive(overlay, 0), true);
  assert.equal(growthOverlayActive(overlay, GROWTH_CAPTION_MS - 1), true);
  assert.equal(growthOverlayActive(overlay, GROWTH_CAPTION_MS), false);
});

test('the plate returns to the chapter caption when the window ends', () => {
  const overlay = createGrowthOverlay(CONFIRMED, 500);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay, nowMs: 500 }), CONFIRMED);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay, nowMs: 500 + GROWTH_CAPTION_MS - 1 }), CONFIRMED);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay, nowMs: 500 + GROWTH_CAPTION_MS }), CHAPTER);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay, nowMs: 500 + 60_000 }), CHAPTER);
});

test('no overlay, or a broken one, leaves the chapter caption alone', () => {
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, nowMs: 0 }), CHAPTER);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay: undefined, nowMs: 0 }), CHAPTER);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay: { spoken: '', atMs: 0 }, nowMs: 0 }), CHAPTER);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay: createGrowthOverlay(CONFIRMED, 100), nowMs: 50 }), CHAPTER);
  assert.equal(createGrowthOverlay('   ', 0), undefined);
  assert.equal(createGrowthOverlay(CONFIRMED, Number.NaN), undefined);
});

test('the page row names the tier with the scene, in full', () => {
  assert.equal(growthPageRow({ tier: 'wall', scene: 1, total: 5 }), 'Wall 1/5');
  assert.equal(growthPageRow({ tier: 'tip', scene: 3, total: 5 }), 'Tip 3/5');
  assert.equal(growthPageRow({ tier: 'tube', scene: 5, total: 5 }), 'Tube 5/5');
  // The menu label budget never trims this row. The
  // caption glass wraps it, so the full tier name is always kept.
  assert.equal(growthPageRow({ tier: 'dimer', scene: 1, total: 5 }), 'Dimer 1/5');
  assert.equal(growthPageRow({ tier: 'monomer', scene: 1, total: 5 }), 'Monomer 1/5');
  assert.equal(growthPageRow({ tier: 'protofilament', scene: 2, total: 5 }), 'Protofilament 2/5');
  assert.notEqual(growthPageRow({ tier: 'protofilament', scene: 2, total: 5 }), 'Protofil');
  assert.notEqual(growthPageRow({ tier: 'dimer', scene: 1, total: 5 }), 'Dim 1/5');
});

test('a tier whose tour has not started reads as its name alone', () => {
  assert.equal(growthPageRow({ tier: 'wall' }), 'Wall');
  assert.equal(growthPageRow({ tier: 'protofilament' }), 'Protofilament');
  assert.equal(growthPageRow({ tier: 'wall', scene: 1 }), 'Wall');
  assert.equal(growthPageRow({ tier: '' }), '');
});

test('a refusal reads as a limit, not as a lesson chapter', () => {
  assert.equal(isGrowthRefusal(REFUSED), true);
  assert.equal(isGrowthRefusal(CONFIRMED), false);
  assert.equal(isGrowthRefusal(CHAPTER), false);
  assert.equal(isGrowthRefusal(''), false);
  assert.equal(isGrowthRefusal(undefined), false);
  assert.equal(GROWTH_LIMIT_TITLE, 'Limit reached');
  assert.equal(GROWTH_LIMIT_CEILING, 'Quest 2 limit');
  assert.equal(growthLimitPageRow('wall'), 'Wall · Quest 2 limit');
  assert.equal(growthLimitPageRow('protofilament'), 'Protofilament · Quest 2 limit');
  assert.equal(growthLimitPageRow(undefined), 'Quest 2 limit');
  // A confirmation arms the caption line but never the refusal title or row.
  const confirmed = createGrowthOverlay(CONFIRMED, 1_000);
  assert.equal(confirmed.refused, undefined);
  assert.equal(growthRefusalActive(confirmed, 1_000), false);
  assert.equal(resolveGrowthTitle({ chapterTitle: 'Three wide', overlay: confirmed, nowMs: 1_000 }), 'Three wide');
  assert.equal(resolveGrowthProgress({ chapterProgress: 'Wall 1/5', tier: 'wall', overlay: confirmed, nowMs: 1_000 }), 'Wall 1/5');
});

test('while a refusal is armed the title and page row name the limit', () => {
  const overlay = createGrowthOverlay(REFUSED, 2_000);
  assert.equal(overlay.refused, true);
  assert.equal(growthRefusalActive(overlay, 2_000), true);
  assert.equal(growthRefusalActive(overlay, 2_000 + GROWTH_CAPTION_MS - 1), true);
  assert.equal(resolveGrowthTitle({ chapterTitle: 'Three wide', overlay, nowMs: 2_000 }), 'Limit reached');
  assert.equal(resolveGrowthProgress({ chapterProgress: 'Wall 1/5', tier: 'wall', overlay, nowMs: 2_000 }),
    'Wall · Quest 2 limit');
  // When the window ends the chapter title and row come back.
  assert.equal(growthRefusalActive(overlay, 2_000 + GROWTH_CAPTION_MS), false);
  assert.equal(resolveGrowthCaption({ chapterCaption: CHAPTER, overlay, nowMs: 2_000 + GROWTH_CAPTION_MS }), CHAPTER);
  assert.equal(resolveGrowthTitle({ chapterTitle: 'Three wide', overlay, nowMs: 2_000 + GROWTH_CAPTION_MS }), 'Three wide');
  assert.equal(resolveGrowthProgress({ chapterProgress: 'Wall 1/5', tier: 'wall', overlay,
    nowMs: 2_000 + GROWTH_CAPTION_MS }), 'Wall 1/5');
  // No overlay at all leaves the chapter headings alone.
  assert.equal(resolveGrowthTitle({ chapterTitle: 'Three wide', nowMs: 0 }), 'Three wide');
  assert.equal(resolveGrowthProgress({ chapterProgress: 'Wall 1/5', tier: 'wall', nowMs: 0 }), 'Wall 1/5');
});

test('a host refusal notice arms the refusal title and row, with its flag kept', () => {
  const overlay = growthOverlayFromNotice({ spoken: REFUSED, refused: true, from: 'wall' }, 0);
  assert.equal(overlay.spoken, REFUSED);
  assert.equal(overlay.refused, true);
  assert.equal(resolveGrowthTitle({ chapterTitle: 'Three wide', overlay, nowMs: 0 }), 'Limit reached');
  assert.equal(resolveGrowthProgress({ chapterProgress: 'Wall 1/5', tier: 'wall', overlay, nowMs: 0 }),
    'Wall · Quest 2 limit');
  assert.equal(growthOverlayFromNotice({ spoken: '', refused: true }, 0), undefined);
  assert.equal(growthOverlayFromNotice(undefined, 0), undefined);
  assert.equal(growthOverlayFromNotice(null, 0), undefined);
  // A host confirmation notice arms the caption line but not the limit title.
  const confirmed = growthOverlayFromNotice({ spoken: CONFIRMED, refused: false }, 0);
  assert.equal(confirmed.refused, undefined);
  assert.equal(resolveGrowthTitle({ chapterTitle: 'Three wide', overlay: confirmed, nowMs: 0 }), 'Three wide');
});

test('the spoken line inside a host notice is trimmed, and blank is empty', () => {
  assert.equal(GROWTH_CAPTION_EVENT, 'stereofold-growth-caption');
  assert.equal(growthSpokenFromNotice({ spoken: REFUSED, refused: true, from: 'wall' }), REFUSED);
  assert.equal(growthSpokenFromNotice({ spoken: `  ${REFUSED}  `, refused: true }), REFUSED);
  assert.equal(growthSpokenFromNotice({ spoken: '', refused: true }), '');
  assert.equal(growthSpokenFromNotice({ spoken: 42, refused: true }), '');
  assert.equal(growthSpokenFromNotice(undefined), '');
  assert.equal(growthSpokenFromNotice(null), '');
});

test('the tier comes from the loaded lesson, whichever spelling it uses', () => {
  assert.equal(growthTierFromLessonId('microtubule-growth-dimer'), 'dimer');
  assert.equal(growthTierFromLessonId('lesson-microtubule-growth-dimer'), 'dimer');
  assert.equal(growthTierFromLessonId('microtubule-growth-monomer'), 'monomer');
  assert.equal(growthTierFromLessonId('lesson-microtubule-growth-tip'), 'tip');
  assert.equal(growthTierFromLessonId('lesson-some-other-lesson'), undefined);
  assert.equal(growthTierFromLessonId('microtubule-growth-unknown'), undefined);
  assert.equal(growthTierFromLessonId(undefined), undefined);
});

test('tier names are capitalised ids, shortened to leading letters', () => {
  assert.equal(tierCaptionName('dimer'), 'Dimer');
  assert.equal(tierCaptionName('protofilament'), 'Protofilament');
  assert.equal(tierShortName('dimer'), 'Dim');
  assert.equal(tierShortName('protofilament'), 'Pro');
});
