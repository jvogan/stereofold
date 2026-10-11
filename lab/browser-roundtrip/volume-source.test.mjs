/**
 * The density fixture contract, Mol*-free.
 *
 * The digest check here is the last one the map gets. Everything before it is
 * on the Mac or on the wire; once these bytes reach `ParseCcp4` nothing checks
 * them again, and a truncated 8.4 MB download parses into a map that is simply
 * shorter than the one the lesson describes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  MIN_VOLUME_BYTES, VOLUME_REPRESENTATION, VOLUME_UNIFORM_COLOR,
  checkedVolumeFixture, digestHex, isVolumeFixture, volumeBytes, volumeIsosurfaceParams,
} from './volume-source.mjs';

const subtle = webcrypto.subtle;
const failure = (code, message) => Object.assign(new Error(message), { code });
/** A map-shaped buffer: the 1,024-byte MRC header plus a few float32 voxels. */
const mapBytes = (fill = 7) => {
  const bytes = new Uint8Array(1024 + 4 * 8);
  bytes.fill(fill, 0, 1024);
  return bytes;
};
const fixtureFor = async (bytes, overrides = {}) => ({
  id: 'microtubule-growth-filament', map: bytes,
  sha256: await digestHex(bytes, subtle), contour: 3.3, ...overrides,
});

test('a density fixture is told apart from a CIF one by its bytes', () => {
  assert.equal(isVolumeFixture({ map: mapBytes(), sha256: 'a'.repeat(64) }), true);
  assert.equal(isVolumeFixture({ cif: 'data_X', sha256: 'a'.repeat(64) }), false);
  assert.equal(isVolumeFixture(undefined), false);
  assert.equal(isVolumeFixture({}), false);
});

test('map bytes arrive as a Uint8Array whatever shape they came in', () => {
  const bytes = mapBytes();
  assert.equal(volumeBytes(bytes), bytes);
  assert.equal(volumeBytes(bytes.buffer) instanceof Uint8Array, true);
  assert.equal(volumeBytes(bytes.buffer).byteLength, bytes.byteLength);
  assert.equal(volumeBytes('not bytes'), undefined);
});

test('a matching digest passes and fixes the representation', async () => {
  const bytes = mapBytes();
  const { source, settings } = await checkedVolumeFixture(await fixtureFor(bytes), {}, failure, subtle);
  assert.equal(source.map, bytes);
  assert.equal(source.contour, 3.3);
  assert.equal(settings.representation, VOLUME_REPRESENTATION);
});

test('a map that does not match the digest the lesson names is refused', async () => {
  const bytes = mapBytes();
  const fixture = await fixtureFor(bytes);
  // One flipped byte: the shape, the length and the header are all still right.
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.byteLength - 1] ^= 0xff;
  await assert.rejects(() => checkedVolumeFixture({ ...fixture, map: tampered }, {}, failure, subtle),
    error => error.code === 'source_mismatch');
});

test('a truncated or unlabelled map never reaches the parser', async () => {
  const bytes = mapBytes();
  const fixture = await fixtureFor(bytes);
  const short = bytes.subarray(0, MIN_VOLUME_BYTES - 1);
  for (const broken of [
    { ...fixture, map: short, sha256: await digestHex(short, subtle) },
    { ...fixture, map: undefined },
    { ...fixture, id: '' },
    { ...fixture, sha256: 'not-a-digest' },
    { ...fixture, contour: undefined },
    { ...fixture, contour: Number.NaN },
  ]) {
    await assert.rejects(() => checkedVolumeFixture(broken, {}, failure, subtle),
      error => error.code === 'invalid_fixture' || error.code === 'source_mismatch');
  }
});

test('the contour travels as an absolute level, never a sigma', () => {
  const params = volumeIsosurfaceParams({ contour: 3.3 });
  assert.equal(params.isoValue.kind, 'absolute');
  assert.equal(params.isoValue.absoluteValue, 3.3);
  // `relative` would multiply a sigma by THIS map's RMS, and a mean-downsampled
  // map's RMS is not the deposited map's: 3.3 absolute is 5.47 sigma here and
  // the deposited recommendation of 5.0 is 5.46 sigma there. A relative level
  // would silently mean a different surface.
  assert.equal(params.doubleSided, false);
  assert.equal(params.alpha, 1);
  assert.equal(volumeIsosurfaceParams({ contour: 3.3, opacity: 0.4 }).alpha, 0.4);
  assert.equal(volumeIsosurfaceParams({ contour: 3.3, opacity: 0 }).alpha, 1);
  assert.throws(() => volumeIsosurfaceParams({}), /absolute contour/);
});

test('a density tier wears one radial key, grey only when the theme is refused', () => {
  // The uniform grey is the fallback, not the look. Every
  // chapter wears the radial key from `volume-color.mjs`, and tinting the
  // whole map the colour of one chapter's subject is still a false key — if
  // this value ever becomes per-chapter, it is a bug, not a feature.
  assert.match(VOLUME_UNIFORM_COLOR, /^#[0-9a-f]{6}$/);
  assert.equal(VOLUME_UNIFORM_COLOR, '#9aa5b0');
});
