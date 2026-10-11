import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';
const KEY = 'stereofold.room-seat.v1';
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const validPlacement = value => finite3(value?.translation) && value.translation.every(v => Math.abs(v) <= PLACEMENT_MAX_TRANSLATION) && finite3(value?.rotation)
  && Number.isFinite(value.scale) && value.scale >= PLACEMENT_MIN_SCALE && value.scale <= PLACEMENT_MAX_SCALE;
const identity = scene => typeof scene?.sourceSha256 === 'string' && scene.sourceSha256.length === 64
  && Number.isSafeInteger(scene.modelNumber) && typeof scene.assemblyId === 'string'
  ? [scene.sourceSha256, scene.modelNumber, scene.assemblyId] : undefined;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const placementKey = p => [p.translation, p.rotation, p.scale];

/** Same-tab, one-use XR return state. No eye/head matrices, commands or receipts.
 * The saved scene remains the placement authority; any intervening placement,
 * model, assembly or source change invalidates the record instead of replaying it.
 */
export function createRoomSeatMemory(storage) {
  let pending;
  return {
    remember({ scene, placement, cameraScale, camera }) {
      const source = identity(scene);
      if (!source || !validPlacement(placement) || !(cameraScale > 0) || !Number.isFinite(cameraScale)
        || !finite3(camera?.position) || !finite3(camera?.target) || !finite3(camera?.up)) return false;
      pending = structuredClone({ source, placement, cameraScale, camera });
      try { storage?.setItem(KEY, JSON.stringify(pending)); } catch { /* Same-document re-entry still works. */ }
      return true;
    },
    take({ scene, placement }) {
      let saved = pending; pending = undefined;
      try { saved ??= JSON.parse(storage?.getItem(KEY) ?? 'null'); } catch { /* Retain the in-memory record. */ }
      try { storage?.removeItem(KEY); } catch { /* Storage is unavailable. */ }
      if (!saved || !same(saved.source, identity(scene)) || !validPlacement(saved.placement)
        || !validPlacement(placement) || !same(placementKey(saved.placement), placementKey(placement))
        || !Number.isFinite(saved.cameraScale) || saved.cameraScale <= 0
        || !finite3(saved.camera?.position) || !finite3(saved.camera?.target) || !finite3(saved.camera?.up)) return undefined;
      return saved;
    },
  };
}

/** A fresh Mol* manager measured already-placed bounds. Remove that scale once
 * when no return record exists, so a reload cannot compound it at the next Fit.
 * Use molecular bounds only: UI geometry has no part in scene units.
 */
export function initialRoomCameraScale({ radius, placementScale, sceneRadiusMeters = .9 }) {
  if (!(radius > 0) || !(placementScale > 0) || !Number.isFinite(radius) || !Number.isFinite(placementScale)) return undefined;
  return sceneRadiusMeters / (radius / placementScale);
}
