import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEPTH_FIXTURE_CAMERA_Z,
  DEPTH_FIXTURE_ID,
  DEPTH_FIXTURE_OBSERVER_SIZE_FACTOR,
  DEPTH_FIXTURE_PDB,
  DEPTH_FIXTURE_SIZE_FACTOR,
} from '../src/depth-fixture.js';
import { openInputSchema } from '../src/schemas.js';

const fixturePath = fileURLToPath(new URL('./fixtures/three-depth-markers.pdb', import.meta.url));

describe('bundled depth fixture', () => {
  it('is byte-identical to the file the pixel gate loads', async () => {
    // The observer and the numeric gate must fuse and measure the same
    // coordinates. The viewer cannot read the repository at runtime, so the
    // text is embedded; this keeps the two copies from drifting apart.
    expect(DEPTH_FIXTURE_PDB).toBe(await readFile(fixturePath, 'utf8'));
  });

  it('carries the three markers at the depths the protocol quotes', () => {
    const markers = DEPTH_FIXTURE_PDB.split('\n').filter((line) => line.startsWith('HETATM'));
    expect(markers).toHaveLength(3);
    expect(markers.map((line) => Number(line.slice(46, 54)))).toEqual([20, 0, -20]);
  });

  it('is selectable as a named open source instead of pasted coordinates', () => {
    expect(openInputSchema.parse({ fixture: DEPTH_FIXTURE_ID })).toMatchObject({ fixture: 'three-depth-markers' });
    expect(openInputSchema.safeParse({ fixture: 'not-a-fixture' }).success).toBe(false);
    expect(openInputSchema.safeParse({ fixture: DEPTH_FIXTURE_ID, pdbId: '1EMA' }).success).toBe(false);
  });

  it('enlarges the markers past the ball-and-stick default for both viewers', () => {
    // Mol*'s ball-and-stick default is 0.15 x van der Waals radius, which is
    // about 1.5 CSS px across at 65 Angstrom.
    expect(DEPTH_FIXTURE_SIZE_FACTOR).toBeGreaterThan(0.15);
    expect(DEPTH_FIXTURE_OBSERVER_SIZE_FACTOR).toBeGreaterThan(DEPTH_FIXTURE_SIZE_FACTOR);
  });

  it('keeps the observer markers clear of the 4 Angstrom vertical stagger', () => {
    // The stagger exists so the near marker cannot occlude the other two. The
    // largest van der Waals radius in the fixture is nitrogen at 1.55 A.
    const largestRadius = DEPTH_FIXTURE_OBSERVER_SIZE_FACTOR * 1.55;
    expect(2 * largestRadius).toBeLessThan(4);
  });

  it('quotes the camera distance the protocol depths are derived from', () => {
    expect(DEPTH_FIXTURE_CAMERA_Z).toBe(65);
  });
});
