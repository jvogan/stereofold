/**
 * The source identity a density scene saves, and what admits it.
 *
 * Running `microtubule-growth --stage filament`, the page fetched, parsed and
 * meshed the 8.4 MB map in 1.1 s and then could not say what it was looking at.
 * A map has no models and no assemblies, `liveScene` answered `null` for both,
 * and `null` is what the capture and the restore each refuse:
 *
 *   grow  built  failed "A rich inspection can only be restored to its exact
 *                        source, model and assembly."
 *   page  "The current structure has no unique source identity. Retry save"
 *
 * The second sentence is the one that broke it. `save()` reads
 * `workspace.capture()` outside its own try, the throw reached `showProblem`,
 * `blocked` went true, and the `attach()` two lines later in `hydrate` is
 * guarded on `!blocked` — so the panel was never registered and the Mac's
 * ninety-second wait was for a panel nothing would ever create.
 *
 * `volumeSceneIdentity` is the one derivation of what a map's identity is, and
 * both ends of the wire read it: the page stamps it into the scene it saves,
 * and `validateScene` here admits exactly that and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { validateScene } from '../src/inspection-contract.js';
// @ts-ignore Shared JavaScript density module.
import { volumeSceneIdentity, VOLUME_ASSEMBLY_ID, VOLUME_MODEL_NUMBER } from '../../lab/browser-roundtrip/volume-source.mjs';

const MAP_SHA = '76040029d895758c3cad44226720685774b026fbcd706730ea5ccedb5fda152f';
const CIF_SHA = 'dbfd7c255adf93c49515188abe4061d36b75cdf5576b49766180be98ac9132e8';

/** The seed structure a density session opens beside, as the host holds it. */
const catalog = {
  source: { sha256: CIF_SHA },
  modelNumbers: [1],
  assemblyId: '1',
  rows: [{ key: 'A:1:ALA', identity: { modelNumber: 1 } }],
};

// `representation` is a parameter, because a map and a
// structure are not drawn the same way and the host checks which is which.
const scene = (identity: {sourceSha256:string;modelNumber:number;assemblyId:string}, selectionKeys: string[] = [],
  representation = 'cartoon') => ({
  ...identity, selectionKeys,
  camera: { mode: 'perspective', fov: 0.8, position: [0, 0, 40], target: [0, 0, 0], up: [0, 1, 0],
    radius: 10, radiusMax: 100, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
  inspection: {
    appearance: { representation, color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
      highlightColor: '#f2c47c', opacity: 1, labels: false, clipping: 0, fog: 0 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  },
});

describe('the identity a density scene carries', () => {
  it('is the map bytes, one model and the assembly named map', () => {
    expect(volumeSceneIdentity({ sha256: MAP_SHA }))
      .toEqual({ sourceSha256: MAP_SHA, modelNumber: 1, assemblyId: 'map' });
    // The scene schema requires a positive integer model number, and the
    // assembly must not be one a deposited structure could also produce.
    expect(Number.isSafeInteger(VOLUME_MODEL_NUMBER) && VOLUME_MODEL_NUMBER > 0).toBe(true);
    expect(VOLUME_ASSEMBLY_ID).not.toBe('1');
  });

  it('is all-null without a digest, so an unprovenanced map still cannot be saved', () => {
    const none = { sourceSha256: null, modelNumber: null, assemblyId: null };
    for (const source of [undefined, {}, { sha256: '' }, { sha256: 'not-a-digest' }, { sha256: MAP_SHA.toUpperCase() }]) {
      expect(volumeSceneIdentity(source)).toEqual(none);
    }
  });
});

describe('what the host admits for a density session', () => {
  const density = { sha256: MAP_SHA };
  // An isosurface, because that is what the page builds over a
  // grid and what `workspace.capture()` therefore reports. A map scene wearing
  // one of the four structure representations is refused; see the case below.
  const mapScene = scene(volumeSceneIdentity(density) as any, [], 'isosurface');

  it('admits the scene the page saves while the catalog is the seed structure', () => {
    expect(validateScene(mapScene, catalog, density).assemblyId).toBe(VOLUME_ASSEMBLY_ID);
    expect(validateScene(mapScene, catalog, density).inspection.appearance.representation).toBe('isosurface');
    // And the same scene is refused for the session with no map: nothing here
    // widens what an atomic session will take. The sentence is the
    // representation one because a session with no map has nothing an
    // isosurface could be of; the digest would refuse it a line later.
    expect(() => validateScene(mapScene, catalog)).toThrow(/Only a density map is drawn as an isosurface/);
  });

  /**
   * The look, which is the half of the scene that had never been checked.
   *
   * `sceneSchema` listed the four representations OF A STRUCTURE, so the map
   * scene the headset captures could not be parsed at all — the refusal landed
   * in the tool's input schema, ahead of every identity rule above it. The
   * schema now admits the map's own representation, and this is the pair of
   * rules that keeps that from being a widening: the map is drawn as an
   * isosurface and nothing else, and nothing else is drawn as an isosurface.
   */
  it('holds each source to the way it is actually drawn', () => {
    expect(() => validateScene(scene(volumeSceneIdentity(density) as any, [], 'molecular-surface'), catalog, density))
      .toThrow(/drawn as an isosurface and nothing else/);
    expect(() => validateScene(scene({ sourceSha256: CIF_SHA, modelNumber: 1, assemblyId: '1' }, [], 'isosurface'), catalog, density))
      .toThrow(/Only a density map is drawn as an isosurface/);
    expect(() => validateScene(scene({ sourceSha256: CIF_SHA, modelNumber: 1, assemblyId: '1' }, [], 'isosurface'), catalog))
      .toThrow(/Only a density map is drawn as an isosurface/);
  });

  it('refuses a different map and a borrowed assembly', () => {
    // The seed structure's own identity used to be on this list
    // and is now on the one below it. A digest that is neither of this
    // session's two sources is still refused, and so is the right map under the
    // wrong model or assembly.
    expect(() => validateScene(scene({ ...volumeSceneIdentity(density) as any, sourceSha256: 'a'.repeat(64) }), catalog, density))
      .toThrow(/density map, or the exact coordinates/);
    expect(() => validateScene(scene({ sourceSha256: MAP_SHA, modelNumber: 2, assemblyId: VOLUME_ASSEMBLY_ID }), catalog, density))
      .toThrow(/exact density map/);
    expect(() => validateScene(scene({ sourceSha256: MAP_SHA, modelNumber: VOLUME_MODEL_NUMBER, assemblyId: '1' }), catalog, density))
      .toThrow(/exact density map/);
  });

  /**
   * The Mac's own panel draws the coordinates, not the map.
   *
   * The map is 8.4 MB of binary and cannot ride inside the JSON hydration a
   * desktop panel is handed, so only a companion fetches `/density`. Admitting
   * only the map's identity refused every save the desktop could make, the
   * panel blocked, `attach()` was skipped, and the filament run timed out
   * waiting for a panel that was never going to register. The reproduction is
   * the same sentence, off the wire:
   *
   *   POST /rpc sync_inspection -> 409
   *   {"error":"The inspection must match this exact density map."}
   */
  it('admits the seed coordinates too, because that is what the Mac draws', () => {
    const desktop = scene({ sourceSha256: CIF_SHA, modelNumber: 1, assemblyId: '1' }, ['A:1:ALA']);
    expect(validateScene(desktop, catalog, density).sourceSha256).toBe(CIF_SHA);
    // It is the catalog's own rules that admit it, not a relaxation of them: a
    // model the catalog does not hold and a key outside it are still refused.
    expect(() => validateScene(scene({ sourceSha256: CIF_SHA, modelNumber: 7, assemblyId: '1' }), catalog, density))
      .toThrow(/density map, or the exact coordinates/);
    expect(() => validateScene(scene({ sourceSha256: CIF_SHA, modelNumber: 1, assemblyId: '1' }, ['A:2:GLY']), catalog, density))
      .toThrow(/unique canonical identities/);
  });

  it('refuses a selection, because a map has no residues to name', () => {
    expect(() => validateScene(scene(volumeSceneIdentity(density) as any, ['A:1:ALA']), catalog, density))
      .toThrow(/no residues to select/);
  });

  it('leaves the atomic rules exactly as they were', () => {
    const atomic = scene({ sourceSha256: CIF_SHA, modelNumber: 1, assemblyId: '1' }, ['A:1:ALA']);
    expect(validateScene(atomic, catalog).selectionKeys).toEqual(['A:1:ALA']);
    expect(() => validateScene(scene({ sourceSha256: CIF_SHA, modelNumber: 1, assemblyId: '1' }, ['A:2:GLY']), catalog))
      .toThrow(/unique canonical identities/);
    expect(() => validateScene(scene({ sourceSha256: MAP_SHA, modelNumber: 1, assemblyId: 'map' }), catalog))
      .toThrow(/exact structure, model and assembly/);
  });
});
