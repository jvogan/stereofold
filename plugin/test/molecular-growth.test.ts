import { describe, expect, it } from 'vitest';
import { DEMO_TIER_BY_DEVICE, createGrowthCaptionMailbox, growthConfirmation, growthLessonId, growthManifestId, growthStageOfLesson, growthStages,
  readGrowthIndex, resolveGrowthTarget, stageFitsTier, stageSize, QUEST2_ATOM_SITE_CEILING,
  QUEST2_TRIANGLE_CEILING } from '../src/molecular-growth.js';
import type { DemoStage } from '../scripts/quest-demo.js';

const index = await readGrowthIndex();
const stages = growthStages(index);
const growth = stages.filter(entry => entry.demo === 'microtubule-growth');
const at = (id: string) => {
  const found = growth.find(entry => entry.stage.id === id);
  if (!found) throw Error(`microtubule-growth has no ${id} tier.`);
  return found;
};

describe('the growth tiers', () => {
  it('reads the checked-in demo index and names every tier by its lesson id', () => {
    expect(growth.map(entry => entry.stage.id)).toEqual(['monomer', 'dimer', 'protofilament', 'wall', 'filament', 'tube', 'tip']);
    expect(growth.map(entry => entry.lessonId)).toEqual(growth.map(entry => growthLessonId('microtubule-growth', entry.stage.id)));
    expect(growthStageOfLesson(index, 'microtubule-growth-wall')?.stage.id).toBe('wall');
    // A plain lesson is not a tier, so growing from it is refused upstream.
    expect(growthStageOfLesson(index, 'crispr-cas9')).toBeUndefined();
    expect(growthStageOfLesson(index, undefined)).toBeUndefined();
  });

  it('recognises the id a live session actually reports, not only the manifest’s', () => {
    // `molecular-lesson-tour.ts:12` compiles a manifest into a tour whose id is
    // `lesson-` plus the manifest id, and that compiled id is what
    // `data.attachment.customTour.id` carries. Matching only the manifest
    // spelling made `grow_structure` answer "This session is not playing a
    // staged lesson" for every real session, while tests still passed because
    // they asked with the id the server never sees.
    for (const entry of growth) {
      expect(growthStageOfLesson(index, `lesson-${entry.lessonId}`)?.stage.id).toBe(entry.stage.id);
      expect(growthManifestId(`lesson-${entry.lessonId}`)).toBe(entry.lessonId);
    }
    expect(growthManifestId('microtubule-growth-wall')).toBe('microtubule-growth-wall');
    expect(growthStageOfLesson(index, 'lesson-crispr-cas9')).toBeUndefined();
  });

  it('holds the Quest 2 ceiling at the tip and keeps the tube off it', () => {
    expect(QUEST2_ATOM_SITE_CEILING).toBe(at('tip').stage.coordinates.atomSites);
    for (const id of ['monomer', 'dimer', 'protofilament', 'wall', 'tip']) expect(stageFitsTier(at(id).stage, 'quest2')).toBe(true);
    expect(stageFitsTier(at('tube').stage, 'quest2')).toBe(false);
    expect(stageFitsTier(at('tube').stage, 'quest3')).toBe(true);
    // The tip carries 43,066 sites and holds 68-72 fps on a Quest 2, so "cap
    // it" is allowed there; the tube (177K) is not.
    expect(at('tip').stage.tiers).toContain('quest2');
    expect(stageFitsTier(at('tip').stage, 'quest2')).toBe(true);
    // An unidentified headset is not held to the Quest 2 ceiling: only the
    // Quest 2 is measured, and a Quest names itself while visionOS does not.
    expect(DEMO_TIER_BY_DEVICE.unknown).toBe('quest3');
    expect(DEMO_TIER_BY_DEVICE['not-a-headset']).toBeUndefined();
  });

  it('steps one tier at a time and stops at both ends', () => {
    const next = resolveGrowthTarget(stages, at('monomer'), 'next', 'quest3');
    expect(next.refused).toBe(false);
    expect(next.refused === false && next.target.stage.id).toBe('dimer');
    const back = resolveGrowthTarget(stages, at('dimer'), 'back', 'quest3');
    expect(back.refused === false && back.target.stage.id).toBe('monomer');
    expect(resolveGrowthTarget(stages, at('monomer'), 'back', 'quest3').refused).toBe(true);
    expect(resolveGrowthTarget(stages, at('tip'), 'next', 'quest3').refused).toBe(true);
    expect(resolveGrowthTarget(stages, at('wall'), 'first', 'quest3')).toMatchObject({ refused: false });
    expect(resolveGrowthTarget(stages, at('wall'), 'tip', 'quest3')).toMatchObject({ refused: false });
    expect(resolveGrowthTarget(stages, at('wall'), 'wall', 'quest3').refused).toBe(true);
    expect(resolveGrowthTarget(stages, at('wall'), 'nonsense', 'quest3').refused).toBe(true);
  });

  it('refuses a tier past the device with a line short enough to speak', () => {
    for (const [from, request] of [['filament', 'next'], ['wall', 'tube'], ['tip', 'back']] as const) {
      const refusal = resolveGrowthTarget(stages, at(from), request, 'quest2');
      expect(refusal.refused, `${from} -> ${request} on a Quest 2`).toBe(true);
      if (!refusal.refused) throw Error('unreachable');
      expect(refusal.spoken.split(/\s+/).length).toBeLessThan(12);
      expect(refusal.spoken).not.toMatch(/EB1/);
    }
    // The tip (43,066 sites) is under the Quest 2 ceiling, so "cap it" lands.
    for (const request of ['last', 'tip'] as const) {
      expect(resolveGrowthTarget(stages, at('wall'), request, 'quest2').refused, `wall -> ${request} on a Quest 2`).toBe(false);
    }
    // The tube is allowed on a Quest 3.
    expect(resolveGrowthTarget(stages, at('wall'), 'next', 'quest3').refused).toBe(false);
  });

  it('offers the density tier to a Quest 2, now that the hold is lifted for the first run', () => {
    // The filament was held off a Quest 2 with tiers ["quest3"]. It fits on
    // size: 178,236 drawn triangles under the 500,000 ceiling.
    expect(at('filament').stage.tiers).toEqual(['quest2', 'quest3']);
    expect(stageFitsTier(at('filament').stage, 'quest2')).toBe(true);
    expect(stageSize(at('filament').stage).count).toBeLessThan(stageSize(at('filament').stage).ceiling);
    const grown = resolveGrowthTarget(stages, at('wall'), 'next', 'quest2');
    expect(grown.refused).toBe(false);
    expect(grown.refused === false && grown.target.stage.id).toBe('filament');
  });

  it('grows the wall into a whole microtubule, as density', () => {
    // Before the filament tier, "grow it" from the wall was refused on a headset
    // that could not hold the 177,268-site atomic tube. The whole filament
    // arrives as one isosurface
    // over EMD-6347 instead, at a size that headset can draw.
    const grown = resolveGrowthTarget(stages, at('wall'), 'next', 'quest3');
    expect(grown.refused).toBe(false);
    expect(grown.refused === false && grown.target.stage.id).toBe('filament');
    expect(growthConfirmation(at('filament'), true)).toBe('Grown to the whole decorated filament.');
    // And back down again, in the same session.
    expect(resolveGrowthTarget(stages, at('filament'), 'back', 'quest3')).toMatchObject({ refused: false });
  });

  it('measures a density tier in triangles and an atomic one in atom sites, never the other way', () => {
    expect(stageSize(at('wall').stage)).toEqual({ count: 40_908, unit: 'atom sites', ceiling: QUEST2_ATOM_SITE_CEILING });
    expect(stageSize(at('filament').stage)).toEqual({ count: 178_236, unit: 'triangles', ceiling: QUEST2_TRIANGLE_CEILING });
    // The filament carries no atoms at all, so an atom-site budget would wave
    // a mesh of any size through; a triangle budget applied to the atomic tube
    // would wave through the tier that drops the session. Both directions:
    const huge: DemoStage = { ...at('filament').stage,
      coordinates: { ...at('filament').stage.coordinates, volume: { ...at('filament').stage.coordinates.volume!, triangles: 600_000 } } };
    expect(at('filament').stage.coordinates.atomSites).toBe(0);
    expect(stageFitsTier(huge, 'quest2')).toBe(false);
    expect(stageFitsTier(huge, 'quest3')).toBe(true);
    expect(at('tube').stage.coordinates.volume).toBeUndefined();
    expect(stageFitsTier(at('tube').stage, 'quest2')).toBe(false);
  });

  it('refuses a density tier in the unit it is actually measured in', () => {
    const huge: DemoStage = { ...at('filament').stage,
      coordinates: { ...at('filament').stage.coordinates, volume: { ...at('filament').stage.coordinates.volume!, triangles: 600_000 } } };
    const refusal = resolveGrowthTarget(stages.map(entry => entry.stage.id === 'filament' ? { ...entry, stage: huge } : entry),
      at('wall'), 'next', 'quest2');
    expect(refusal.refused).toBe(true);
    if (!refusal.refused) throw Error('unreachable');
    expect(refusal.reason).toContain('600,000 triangles');
    expect(refusal.reason).not.toMatch(/atom sites/);
    expect(refusal.spoken.split(/\s+/).length).toBeLessThan(12);
  });

  it('confirms a landing tier in a few spoken words', () => {
    expect(growthConfirmation(at('dimer'), true)).toBe('Grown to one tubulin dimer.');
    expect(growthConfirmation(at('monomer'), false)).toBe('Back to one tubulin monomer.');
    for (const entry of growth) {
      expect(growthConfirmation(entry, true).split(/\s+/).length).toBeLessThan(12);
      expect(growthConfirmation(entry, true)).not.toMatch(/^[A-Z]\./);
    }
  });

  it('truncates a long tier title at a word boundary so the spoken line stays under twelve words', () => {
    const long = { ...at('dimer'), stage: { ...at('dimer').stage,
      title: 'A. one two three four five six seven eight nine ten eleven twelve thirteen' } };
    const spoken = growthConfirmation(long, true);
    expect(spoken).toBe('Grown to one two three four five six seven eight nine.');
    expect(spoken.split(/\s+/).length).toBe(11);
  });
});

describe('the growth caption mailbox a host refusal rides', () => {
  const refusal = { spoken: 'Too big for this headset. Staying here.', refused: true, from: 'wall' };

  it('gives a connected companion the notice on the next claim, and only once', () => {
    const box = createGrowthCaptionMailbox();
    expect(box.claim('panel-a')).toBeUndefined();
    expect(box.offer(refusal)).toEqual(refusal);
    expect(box.claim('panel-a')).toEqual(refusal);
    expect(box.claim('panel-a')).toBeUndefined();
  });

  it('does not replay a stale refusal onto a panel that attached afterwards', () => {
    const box = createGrowthCaptionMailbox();
    box.offer(refusal);
    expect(box.claim('late-panel')).toBeUndefined();
    expect(box.claim('late-panel')).toBeUndefined();
  });

  it('ignores a blank spoken line rather than arming an empty overlay', () => {
    const box = createGrowthCaptionMailbox();
    box.claim('panel-a');
    expect(box.offer({ spoken: '   ', refused: true })).toBeUndefined();
    expect(box.claim('panel-a')).toBeUndefined();
  });
});
