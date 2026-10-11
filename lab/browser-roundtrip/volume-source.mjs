/**
 * What a DENSITY source is on the page, and what it is drawn as.
 *
 * The `filament` tier is EMD-6347 itself — a CCP4 map, not a structure. It
 * arrives as bytes rather than as text, it has no atoms, no chains, no
 * residues, no assembly and no catalog, so it cannot travel any of the paths
 * `viewer.mjs` built for an mmCIF source. This module is the small pure half of
 * the volume path: the shape a volume fixture must have, the digest check over
 * its bytes, and the isosurface parameters the representation is built with.
 *
 * Mol*-free on purpose, so `volume-source.test.mjs` can hold the contract
 * without a WebGL context. The Mol*-facing half — `rawData` -> `ParseCcp4` ->
 * `VolumeFromCcp4` -> `VolumeRepresentation3D` — is `buildVolumeCandidate` in
 * `viewer.mjs`, and it reads the values this module produces.
 */

/** The one Mol* representation a density map is drawn with. */
export const VOLUME_REPRESENTATION = 'isosurface';

/**
 * The neutral grey a density tier falls back to when its own key is refused.
 *
 * The map is no longer painted this. Every chapter wears the
 * radial two-colour key from `volume-color.mjs` — wall teal inside 135 A of
 * the measured tube axis, EB3 amber outside it — which a per-vertex theme can
 * tint without a second representation. What is still true is the sentence
 * this comment used to end on: a per-chapter colour could only mean repainting
 * the WHOLE map the colour of that chapter's subject, which is a false key,
 * so chapter emphasis on this tier is carried by placement, clipping, fog and
 * the spoken line instead. This grey survives for one case only: a plugin
 * whose theme registry refuses the radial registration keeps a drawable tier
 * and says so on the build record.
 */
export const VOLUME_UNIFORM_COLOR = '#9aa5b0';

/** Whether a fixture is a density map rather than an mmCIF source. */
export function isVolumeFixture(fixture) {
  return Boolean(fixture) && typeof fixture === 'object' && fixture.map != null && typeof fixture.cif !== 'string';
}

const HEX_DIGEST = /^[a-f0-9]{64}$/;

/** The bytes of a volume fixture as a Uint8Array, or `undefined` if it has none. */
export function volumeBytes(map) {
  if (map instanceof Uint8Array) return map;
  if (map instanceof ArrayBuffer) return new Uint8Array(map);
  if (ArrayBuffer.isView(map)) return new Uint8Array(map.buffer, map.byteOffset, map.byteLength);
  return undefined;
}

/** The hex SHA-256 of some bytes, in the page's own crypto. */
export async function digestHex(bytes, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The smallest MRC/CCP4 map worth calling a map: a 1,024-byte header plus one
 * float32 voxel. Anything shorter is a truncated download, and Mol*'s parser
 * would read past the end of it.
 */
export const MIN_VOLUME_BYTES = 1024 + 4;

/**
 * Validate a density fixture and confirm its digest over the BYTES.
 *
 * The mmCIF path digests a UTF-8 encoding of a string and cross-checks the
 * byte length against a catalog. Neither exists here, so the check is the one
 * that matters and it is not optional: these bytes came over the network from
 * the Mac, and the page is the last place that can tell a truncated or swapped
 * map from the one the lesson's provenance names.
 *
 * @param {{id?:string, map?:Uint8Array, sha256?:string, contour?:number}} fixture
 * @param {object} options the same settings object the mmCIF path takes
 * @param {(code:string, message:string)=>Error} failure the viewer's error maker
 */
export async function checkedVolumeFixture(fixture, options, failure, subtle = globalThis.crypto?.subtle) {
  const source = { ...fixture };
  const settings = { ...options };
  const bytes = volumeBytes(source.map);
  if (typeof source.id !== 'string' || !source.id || !bytes || bytes.byteLength < MIN_VOLUME_BYTES
      || typeof source.sha256 !== 'string' || !HEX_DIGEST.test(source.sha256)) {
    throw failure('invalid_fixture', 'The density fixture needs map bytes, a SHA-256 hash and an absolute contour.');
  }
  if (!Number.isFinite(source.contour)) {
    throw failure('invalid_fixture', 'A density fixture needs the absolute contour its lesson was authored at.');
  }
  const sha256 = await digestHex(bytes, subtle);
  if (sha256 !== source.sha256) {
    throw failure('source_mismatch', 'The loaded map bytes do not match the digest the lesson names.');
  }
  source.map = bytes;
  settings.representation = VOLUME_REPRESENTATION;
  if (settings.camera !== undefined && typeof settings.camera !== 'object') {
    throw failure('invalid_fixture', 'A camera snapshot must be an object.');
  }
  if (settings.preserveRoomPlacement !== undefined && typeof settings.preserveRoomPlacement !== 'boolean') {
    throw failure('invalid_fixture', 'preserveRoomPlacement must be a boolean.');
  }
  return { source, settings };
}

/**
 * The `VolumeRepresentation3D` type parameters for one absolute contour.
 *
 * `kind: 'absolute'` is the whole point. Mol*'s other kind is `'relative'`,
 * which multiplies a sigma by the map's own RMS — and this map's RMS is not the
 * deposited map's, because mean-downsampling lowers the peaks and the RMS
 * together. The lesson carries the level that was MEASURED on the prepared map
 * (3.3, sigma-matched to the deposited recommendation of 5.0), and an absolute
 * level is the only one that survives the trip unchanged.
 *
 * The mesh is built once and never rebuilt: the wearer's chapters change the
 * placement, the clipping and the fog, none of which touch this geometry.
 */
export function volumeIsosurfaceParams({ contour, opacity = 1 } = {}) {
  if (!Number.isFinite(contour)) throw Error('A volume isosurface needs an absolute contour.');
  return {
    isoValue: { kind: 'absolute', absoluteValue: contour },
    alpha: Number.isFinite(opacity) && opacity > 0 && opacity <= 1 ? opacity : 1,
    // The Quest 2 is fill-bound and this is the largest static mesh the product
    // ships; back faces of a closed shell are never seen and cost fill.
    doubleSided: false,
    // A wireframe of a 178,236-triangle mesh is a grey haze, and `flatShaded`
    // would show every marching-cubes facet at 5.28 A voxels.
    wireframe: false,
    flatShaded: false,
  };
}

/**
 * What a wearer hears when the map will not draw.
 *
 * When the isosurface build threw, the hydration threw with it, and the panel was never registered — so the Mac
 * timed out waiting to pair while the headset held a page reading "Loading
 * structure…" with nothing behind it and no way to say so. A failed build now
 * falls back to the picture that was already there and says this line, out loud
 * and on the caption plate.
 *
 * Four words and one clause, like every other spoken reply in the headset. It
 * names the map rather than the error, because the wearer has no console and a
 * Mol* message means nothing on someone's face; the error itself rides the
 * diagnostics ring, where it can be read back.
 */
export const MAP_DRAW_FAILED_SPOKEN = 'Could not draw the map.';

/**
 * The source identity a loaded density map carries.
 *
 * Every saved scene in this product names the exact picture it can be restored
 * onto: the digest of the source bytes, the model inside that source, and the
 * assembly built from that model. A map has bytes and a digest, and it has no
 * models and no assemblies at all — so the page answered `null` for the last
 * two, and `null` is what both the capture and the restore refuse. In the
 * headset that refusal was the whole failure: the restore threw
 * `inspection_identity_mismatch`, the save that followed threw
 * `unsupported_scene`, the page blocked, `attach()` was skipped, and the Mac
 * waited ninety seconds for a panel nothing had registered.
 *
 * The identity a map gets is therefore fixed rather than read out of geometry:
 *
 *   sourceSha256  the digest OF THE MAP BYTES, already checked twice before a
 *                 parse (`checkedVolumeFixture` here, `companionFetch` on the
 *                 way in). It is what makes a wrong map refuse: two maps are
 *                 the same source only if they are the same bytes.
 *   modelNumber   1. A CCP4 map holds one grid. There is no second model to
 *                 number, and every schema in the product requires a positive
 *                 integer here.
 *   assemblyId    "map". Not "1", which is a deposited assembly of a structure
 *                 and would let an atomic scene of the same bytes — impossible
 *                 today, but not impossible — read as the same picture.
 *
 * The contour is deliberately NOT in the identity. It is how the one grid is
 * drawn, not which grid it is, and it rides in the scene's own inspection state
 * with the rest of the appearance. Putting it here would make a re-authored
 * contour refuse every scene saved at the old one, and the hydration path that
 * restores a saved scene onto an unchanged source (`same && data.scene` in
 * inspector.ts) has no fallback for that refusal.
 */
export const VOLUME_MODEL_NUMBER = 1;
/** The assembly id of the one grid a density scene draws. See above. */
export const VOLUME_ASSEMBLY_ID = 'map';

/**
 * The scene identity of a density source, or all-null when it has no digest.
 *
 * The null answer is not a formality: it is the same refusal an atomic scene
 * gets when its models or assemblies are ambiguous, and it keeps a map that
 * arrived without provenance out of a saved scene. Nothing else can produce a
 * volume identity, so a caller cannot construct one around a missing digest.
 *
 * @param {{sha256?:string}|undefined} source the loaded source record
 */
export function volumeSceneIdentity(source) {
  const sha256 = typeof source?.sha256 === 'string' && HEX_DIGEST.test(source.sha256) ? source.sha256 : null;
  return sha256
    ? { sourceSha256: sha256, modelNumber: VOLUME_MODEL_NUMBER, assemblyId: VOLUME_ASSEMBLY_ID }
    : { sourceSha256: null, modelNumber: null, assemblyId: null };
}
