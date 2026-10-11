/**
 * The four ways a structure is drawn, in the words a wearer uses.
 *
 * On the Quest 2 `{"representation":"surface"}` was refused with
 * an `invalid_union` zod issue list while the menu row the wearer was reading
 * said Surface. What is pinned here
 * is that the words resolve, that nothing else does, and that a refusal is one
 * sentence with no schema text in it.
 */
import { describe, expect, it } from 'vitest';
import { commandAppearanceSchema, inspectionChangeSchema, REPRESENTATION_WORDS,
  readRepresentationWord, representationWordKey } from '../src/inspection-contract.js';

const CANONICAL = ['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill'];

describe('representation words', () => {
  it('reads the wearer’s word as one of the four canonical looks', () => {
    const read = (value: string) => commandAppearanceSchema.partial().parse({ representation: value }).representation;
    expect(read('surface')).toBe('molecular-surface');
    expect(read('Surface')).toBe('molecular-surface');
    expect(read('molecular surface')).toBe('molecular-surface');
    expect(read('molecular-surface')).toBe('molecular-surface');
    expect(read('sticks')).toBe('ball-and-stick');
    expect(read('ball and stick')).toBe('ball-and-stick');
    expect(read('BALL_AND_STICK')).toBe('ball-and-stick');
    expect(read('ribbon')).toBe('cartoon');
    expect(read('ribbons')).toBe('cartoon');
    expect(read('spheres')).toBe('spacefill');
    expect(read('space filling')).toBe('spacefill');
  });

  it('yields only the four canonical looks, and never the map’s own', () => {
    for (const word of Object.keys(REPRESENTATION_WORDS)) expect(CANONICAL).toContain(readRepresentationWord(word));
    for (const value of CANONICAL) expect(readRepresentationWord(value)).toBe(value);
    expect(readRepresentationWord('isosurface')).toBeUndefined();
    expect(commandAppearanceSchema.partial().safeParse({ representation: 'isosurface' }).success).toBe(false);
  });

  it('refuses an unknown word in one sentence, with no schema path in it', () => {
    const refused = inspectionChangeSchema.safeParse({ kind: 'appearance', patch: { representation: 'blobs' } });
    expect(refused.success).toBe(false);
    const messages = refused.success ? [] : refused.error.issues.map(issue => issue.message);
    expect(messages).toContain('A structure is drawn as a cartoon, as ball and stick, as a molecular surface or as '
      + 'spacefill. The words a wearer says for those are accepted too: ribbon, sticks, surface, spheres. Anything else '
      + 'is refused with this sentence, and a density map has only its isosurface.');
    const printed = JSON.stringify(refused.success ? {} : refused.error.issues);
    expect(printed).not.toMatch(/invalid_union|invalid_enum_value|unionErrors|expected/u);
  });

  it('collapses spacing, hyphens and underscores into one key', () => {
    expect(representationWordKey(' Ball-and_Stick ')).toBe('ball and stick');
    expect(representationWordKey('MOLECULAR   SURFACE')).toBe('molecular surface');
    expect(readRepresentationWord(42)).toBeUndefined();
    expect(readRepresentationWord(undefined)).toBeUndefined();
  });
});
