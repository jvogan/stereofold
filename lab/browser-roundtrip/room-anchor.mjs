import { ENTRY_STANDOFF_RANGE } from './placement-fit-envelope.mjs';
import { PLACEMENT_MAX_TRANSLATION, clampPlacementScale, clampPlacementTranslation } from './placement-limits.mjs';
export { ENTRY_STANDOFF_RANGE } from './placement-fit-envelope.mjs';
import { capPlateSeat, plateSeatLimits } from './plate-seat.mjs';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { overheadRoomPoint } from './overhead-seat.mjs';

/**
 * Lock the monumental scene to the real room instead of the entry head pose.
 *
 * `room-placement.mjs` measures from the head pose at the moment of the press,
 * so a wearer who entered sitting gets the structure placed below the real
 * floor and one who entered standing gets it too high. The viewer opens on a
 * `local` reference space, which does not know where the floor is, so the floor
 * height has to come from somewhere else: the WebXR plane-detection module,
 * which the Quest Browser supports on real Quest 2, Quest 3 and Quest Pro
 * hardware, with `detectedPlanes` populating two to three seconds after the
 * session starts.
 *
 * Everything here is pure or guarded. A runtime without plane detection, or a
 * session that was never granted the feature, produces `null` and the caller
 * keeps the current entry-pose placement — never an error and never a stall.
 *
 * The Meta reality-accelerator-toolkit was read for the API shapes only. It
 * builds on three.js `Object3D`s, and Mol* is not a three.js renderer, so the
 * raw WebXR calls are used directly and the toolkit is not a dependency.
 */

/** Plane-detection candidates whose normal tips more than this from room up are not floors. */
const MAX_FLOOR_TILT_COS = 0.94;
/** A floor lies at least this far below the head. Excludes desks and tables. */
const MIN_HEAD_CLEARANCE_M = 0.6;
/** Horizontal planes smaller than this are furniture, not the room's floor. */
const MIN_FLOOR_AREA_M2 = 0.8;

/**
 * The width each mode asks for, before the device budget reduces it. `floor`
 * puts the structure on the floor in front of the wearer; `overhead` puts it
 * above the wearer's head.
 */
export const ROOM_ANCHOR_PRESETS = Object.freeze({
  floor: Object.freeze({ metersAcross: 2.4, minMetersAcross: 1.2 }),
  above: Object.freeze({ metersAcross: 3.6, minMetersAcross: 1.8 }),
  overhead: Object.freeze({ metersAcross: 4, minMetersAcross: 2 }),
});

/**
 * How wide the entry seat should look, in degrees of the wearer's view.
 *
 * The owner asked for "a big structure almost above us", and named chest
 * height as the thing to avoid. Eighty degrees was the middle of the 70 to 90
 * the original brief asked for, and it was the right answer for a frame with
 * nothing else in it.
 *
 * Once a floorless session actually took this seat, the Quest 2 capture showed
 * what eighty degrees costs: the structure's own silhouette measured 0.93 in
 * tangent units, which is eighty-six degrees across, its top was clipped by
 * the elevation, and the ten name plates — which must be drawn OUTSIDE that
 * silhouette to stop covering it — were pushed past the edge of the display
 * where the wearer cannot see them at all.
 *
 * Sixty-two was the width of the capture judged right
 *, and a later
 * device run showed what that capture did not have to carry: ten
 * name plates. At sixty-two degrees inside a readable band of sixty-eight
 * there is no room at the sides at all, so every plate went to the bottom and
 * the right-hand edge and two of them were cut in half by it.
 *
 * Fifty is now only the requested width. After the reachable seat is known,
 * placementFromRoom caps its scale against the projected part silhouette and
 * a one-plate-HIGH band on each side. The standoff and six-degree rise stay
 * put. The band was a full plate WIDE until the seat band changed: the widest
 * name is far wider than it is tall, so reserving its width at the left and
 * right cost about a third of the field and seated the structure at 28.6
 * degrees, a third of the lens. A plate rests in the band slot above or below
 * its part wherever the sides are tight, so one plate height is what the band
 * actually has to carry, and the sides are still used where a plate fits.
 */
export const ENTRY_VIEW_DEGREES = 50;
/**
 * How far above the eye line the entry seat's centre sits.
 *
 * Twenty-five put the top of an eighty-degree structure off the top of the
 * display, and ten still spent most of the band above it. The owner asked for
 * a structure "almost above us" and named chest height as the thing to avoid,
 * so the rise stays — at the angle that leaves a row of plates above the
 * subject as well as below it.
 */
export const ENTRY_ELEVATION_DEGREES = 6;
/** Nearest and furthest the entry seat may stand, whatever the width asks for. */

/**
 * How far away a structure of this width must stand to fill the entry view,
 * and how far above the eye line its centre then sits.
 *
 * Half the width over the tangent of half the angle is the distance at which
 * that width subtends the angle. The elevation is applied along that line, so
 * a wider structure both stands further back and rides higher, which keeps the
 * angle the wearer tilts their head by the same for every structure.
 */
export function entrySeat(metersAcross, { viewDegrees = ENTRY_VIEW_DEGREES,
  elevationDegrees = ENTRY_ELEVATION_DEGREES, range = ENTRY_STANDOFF_RANGE } = {}) {
  if (!finite(metersAcross) || metersAcross <= 0) return { distance: range.min, rise: 0 };
  const half = Math.tan(clamp(viewDegrees, 10, 170) * Math.PI / 360);
  const wanted = half > 0 ? metersAcross / (2 * half) : range.max;
  const line = clamp(wanted, range.min, range.max);
  const elevation = clamp(elevationDegrees, 0, 80) * Math.PI / 180;
  return { distance: line * Math.cos(elevation), rise: line * Math.sin(elevation) };
}

/**
 * Atom sites each device class holds in the cartoon representation, from the
 * Quest 2 and Quest 3 sizing in `headset-matrix.md`. A heavier scene is not
 * refused; it is drawn smaller, because the frame is fill-rate bound and the
 * fragment count grows with the square of the structure's apparent size.
 */
export const SITE_BUDGET_BY_DEVICE = Object.freeze({
  quest2: 70_000, quest3: 175_000, 'quest-pro': 175_000, 'vision-pro': 175_000,
});
const DEFAULT_SITE_BUDGET = 70_000;

/** Vertical gap kept between the floor and the underside of an overhead lattice. */
const OVERHEAD_CLEARANCE_M = 2.2;
/** At or above this many atom sites the automatic mode chooses `overhead`. */
export const LATTICE_SITE_THRESHOLD = 100_000;

/**
 * How long a session with no floor waits before seating the structure anyway.
 *
 * Longer than the floor path's own settle, because a room that is going to
 * report a floor should be allowed to: the floor gives the placement a real
 * height, and this fallback measures from the head instead.
 */
export const FLOORLESS_SETTLE_MS = 5_000;

const finite = value => Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const matrix16 = value => value?.length === 16 && Array.from(value).every(finite);

/** The mode a structure of this size wants, unless the caller names one. */
export function resolveMode({ mode = 'auto', siteCount = 0 } = {}) {
  if (mode === 'floor' || mode === 'above' || mode === 'overhead') return mode;
  // The automatic seat is always `above`, whatever the scene weighs. `floor`
  // is the chest-height view this design rejects, and `overhead` puts the
  // structure at ninety degrees, where a level head sees nothing at all: a
  // 400,000-site lattice at that seat leaves an empty frame.
  // Both stay reachable from the menu's own rows. The device site budget in
  // `monumentalMeters` already draws a heavy scene smaller, so a lattice gets
  // the same seat, just less of it.
  void siteCount;
  return 'above';
}

/**
 * The physical width this scene should occupy, in metres.
 *
 * At or under the device's site budget the mode's full size is used. Past it
 * the size falls with the square root of the overload, which is the linear
 * shrink that holds the fragment count roughly flat.
 */
export function monumentalMeters({ mode = 'floor', siteCount = 0, deviceClass = 'unknown' } = {}) {
  const preset = ROOM_ANCHOR_PRESETS[mode] ?? ROOM_ANCHOR_PRESETS.floor;
  const budget = SITE_BUDGET_BY_DEVICE[deviceClass] ?? DEFAULT_SITE_BUDGET;
  const sites = finite(siteCount) && siteCount > 0 ? siteCount : 0;
  const factor = sites > budget ? Math.sqrt(budget / sites) : 1;
  return Math.max(preset.minMetersAcross, preset.metersAcross * factor);
}

/** Signed area of a plane polygon, in the plane's own X/Z axes. */
export function planeArea(polygon) {
  if (!polygon || typeof polygon[Symbol.iterator] !== 'function') return 0;
  const points = [...polygon].map(point => [point?.x, point?.z]).filter(([x, z]) => finite(x) && finite(z));
  if (points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index++) {
    const [x1, z1] = points[index], [x2, z2] = points[(index + 1) % points.length];
    total += x1 * z2 - x2 * z1;
  }
  return Math.abs(total) / 2;
}

/**
 * This frame's detected planes, or `null` when the runtime has none to give.
 *
 * Reading `detectedPlanes` on a session that was never granted
 * `plane-detection` raises rather than returning empty, and this runs inside
 * the ninety-frames-a-second head observer, so every read is guarded
 * individually. `worldInformation` is the older shape the same feature shipped
 * under, and the session is read last for a runtime that exposes it there.
 */
const planeSetOf = (frame, session) => {
  const read = get => { try { return get(); } catch { return undefined; } };
  for (const source of [read(() => frame?.detectedPlanes), read(() => frame?.worldInformation?.detectedPlanes),
    read(() => session?.detectedPlanes)]) {
    if (source && typeof source[Symbol.iterator] === 'function') { try { return [...source]; } catch { return null; } }
  }
  return null;
};

// An unlabelled plane reports no orientation at all under IWER 2.3.0, which
// derives the field from the semantic label. The plane's own normal is checked
// below either way, so an absent orientation is not a reason to discard it.
const horizontal = plane => {
  const value = plane?.orientation;
  return value === undefined || value === null || String(value).toLowerCase() === 'horizontal';
};
const labelOf = plane => String(plane?.semanticLabel ?? plane?.semanticType ?? '');
const looksLikeFloor = plane => /floor|ground/iu.test(labelOf(plane));
const looksLikeCeiling = plane => /ceiling/iu.test(labelOf(plane));

/**
 * The room's floor from this frame's detected planes, or `null`.
 *
 * A candidate must be horizontal, have its normal within about twenty degrees
 * of room up, lie at least `MIN_HEAD_CLEARANCE_M` below the head, and cover at
 * least `MIN_FLOOR_AREA_M2`. The largest remaining candidate wins, except that
 * a plane the runtime labelled as the floor wins over an unlabelled one of any
 * size.
 *
 * @param {XRFrame} frame current frame
 * @param {XRSession} session the presenting session, read only if the frame carries no plane set
 * @param {XRReferenceSpace} refSpace the space the returned height is measured in
 * @returns {{y:number, area:number, label:string|null, planeCount:number, plane:object}|null}
 */
export function findFloor(frame, session, refSpace, { headY, minArea = MIN_FLOOR_AREA_M2,
  minHeadClearance = MIN_HEAD_CLEARANCE_M } = {}) {
  try {
    const planes = planeSetOf(frame, session);
    if (!planes?.length || typeof frame?.getPose !== 'function') return null;
    let head = headY;
    if (!finite(head)) {
      const viewer = frame.getViewerPose?.(refSpace);
      head = finite(viewer?.transform?.position?.y) ? viewer.transform.position.y : undefined;
    }
    const candidates = [];
    for (const plane of planes) {
      if (!horizontal(plane) || looksLikeCeiling(plane) || !plane?.planeSpace) continue;
      const pose = frame.getPose(plane.planeSpace, refSpace);
      const m = pose?.transform?.matrix;
      if (!matrix16(m)) continue;
      // Column 1 of a plane's transform is its own up axis expressed in the
      // reference space. A ceiling reports the same `horizontal` orientation
      // and is rejected here rather than by its height alone.
      if (m[5] < MAX_FLOOR_TILT_COS) continue;
      const y = m[13];
      if (finite(head) && y > head - minHeadClearance) continue;
      const area = planeArea(plane.polygon);
      if (area < minArea && !looksLikeFloor(plane)) continue;
      candidates.push({ y, area, label: plane.semanticLabel ?? null, labelled: looksLikeFloor(plane), plane });
    }
    if (!candidates.length) return null;
    const labelled = candidates.filter(candidate => candidate.labelled);
    const pool = labelled.length ? labelled : candidates;
    const best = pool.reduce((winner, candidate) => candidate.area > winner.area ? candidate : winner);
    return { y: best.y, area: best.area, label: best.label, planeCount: planes.length, plane: best.plane };
  } catch { return null; }
}

/**
 * Pin one room point with a real `XRAnchor` and follow it every frame.
 *
 * The returned handle keeps the last pose the anchor reported. WebXR drops an
 * anchor from `frame.trackedAnchors` when the runtime loses what it was pinned
 * to. The scene must not return to the origin when that happens, so the handle
 * reports `tracked: false` and keeps returning the last valid pose.
 *
 * A runtime without `createAnchor` returns a handle that reports the requested
 * pose unchanged, so the caller has one code path either way.
 *
 * @param {XRFrame} frame current frame
 * @param {XRReferenceSpace} refSpace space `pose` is expressed in
 * @param {{position:{x:number,y:number,z:number}, orientation?:object}} pose room point to pin
 * @returns {Promise<object>} anchor handle
 */
export async function anchorScene(frame, refSpace, pose, { XRRigidTransform: Rigid = globalThis.XRRigidTransform } = {}) {
  const position = pose?.position ?? pose;
  const start = { x: position?.x, y: position?.y, z: position?.z };
  if (![start.x, start.y, start.z].every(finite)) throw Error('An anchor needs a finite room point.');
  const orientation = pose?.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
  let anchor = null, lastPose = { ...start }, tracked = false, lost = false;
  try {
    if (typeof frame?.createAnchor === 'function') {
      const transform = typeof Rigid === 'function' ? new Rigid(start, orientation) : { position: start, orientation };
      anchor = await frame.createAnchor(transform, refSpace);
      tracked = Boolean(anchor);
    }
  } catch { anchor = null; }
  return Object.freeze({
    get anchored() { return Boolean(anchor); },
    get tracked() { return tracked; },
    get lost() { return lost; },
    /** Current room point of the anchor, falling back to the last one it reported. */
    poseIn(currentFrame) {
      if (!anchor) return { point: { ...lastPose }, tracked: false, lost, moved: 0 };
      try {
        const set = currentFrame?.trackedAnchors;
        if (set && typeof set.has === 'function' && !set.has(anchor)) {
          tracked = false; lost = true;
          return { point: { ...lastPose }, tracked: false, lost: true, moved: 0 };
        }
        const next = currentFrame?.getPose?.(anchor.anchorSpace, refSpace);
        const m = next?.transform?.matrix;
        if (!matrix16(m)) { tracked = false; return { point: { ...lastPose }, tracked: false, lost, moved: 0 }; }
        const point = { x: m[12], y: m[13], z: m[14] };
        const moved = Math.hypot(point.x - lastPose.x, point.y - lastPose.y, point.z - lastPose.z);
        lastPose = point; tracked = true;
        return { point: { ...point }, tracked: true, lost, moved };
      } catch { tracked = false; return { point: { ...lastPose }, tracked: false, lost, moved: 0 }; }
    },
    release() {
      try { anchor?.delete?.(); } catch { /* A torn-down session deletes its own anchors. */ }
      anchor = null; tracked = false;
    },
  });
}

/** Room metres to molecular radii, the units an inspection placement travels in. */
function toRadii(point, { renderFromRoom, cameraScale, center, radius }) {
  const value = Vec3.create(point[0], point[1], point[2]);
  Vec3.transformMat4(value, value, renderFromRoom);
  Vec3.scale(value, value, 1 / cameraScale);
  Vec3.sub(value, value, center);
  Vec3.scale(value, value, 1 / radius);
  return Array.from(value);
}

/**
 * How far along `near` to `far` the placement can travel and still be
 * expressible.
 *
 * The numerical envelope is shared with saved placements. Ordinary small
 * structures can occupy the same room positions as large ones; their source
 * radius must not pull the requested room seat toward the wearer's face.
 */
export function reachFraction(near, far, limit = PLACEMENT_MAX_TRANSLATION) {
  let fraction = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = near[axis], delta = far[axis] - near[axis];
    if (!finite(start) || !finite(delta)) return 0;
    if (Math.abs(start + delta) <= limit) continue;
    if (Math.abs(delta) < 1e-9) continue;
    fraction = Math.min(fraction, Math.max(0, ((delta > 0 ? limit : -limit) - start) / delta));
  }
  return fraction;
}

/**
 * The head's own facing, flattened to the floor plane.
 *
 * A head looking straight up or down has no usable forward direction. Its own
 * up axis, flattened, points where the wearer is leaning, which avoids placing
 * a room-sized structure at the wearer's own position.
 */
function seatForward(headInRoom) {
  let forward = Vec3.create(-headInRoom[8], 0, -headInRoom[10]);
  if (Vec3.magnitude(forward) < 0.01) forward = Vec3.create(-headInRoom[4], 0, -headInRoom[6]);
  if (Vec3.magnitude(forward) < 0.01) forward = Vec3.create(0, 0, -1);
  return Vec3.normalize(forward, forward);
}

/**
 * The view the wearer actually has of the seat, in scene units.
 *
 * The seat is placed from the tracked head: `placementFromRoom` stands the
 * structure along the head's own flattened facing. The plate cap and the plate
 * layout then measured it from `canvas.camera` -- the Mol* camera, which in XR
 * is the ROOM ORIGIN looking down the room's -Z, not the wearer. The two agree
 * only while the head sits at that origin facing that way, which is where every
 * earlier capture happened to be taken.
 *
 * The first entry after the headset reboot was not there. The head
 * stood off the room origin, so the seat that was straight ahead of the wearer
 * projected at x 0.349 (nineteen degrees right) in the camera basis. The cap
 * then spent the field on that offset -- halfWidth 0.6 minus band minus 0.349
 * left 0.189, exactly the silhouette half width it recorded -- and shrank the
 * placement scale from 1.90 to 0.68, a fifty-five degree seat drawn at
 * twenty-one. The layout, seeing a subject against the right edge of its
 * field, put all nine plates at the LEFT edge (x -0.52 predicted, -0.76 drawn),
 * while the wearer saw the structure dead centre (the hTR plate drawn at
 * x 0.007). The re-entry seven minutes later, head near the origin, seated at
 * 54.8 degrees with the plates above and below. Same build, same code.
 *
 * So the measurement basis is the head: eye at the tracked head, looking level
 * along the same forward the seat stands the structure on, up along the
 * room's own up. With the head at the origin facing -Z this is the camera
 * basis exactly, so every earlier seat number is unchanged.
 *
 * @param {object} pose `headInRoom`, `renderFromRoom` and `cameraScale`, as
 *   `placementFromRoom` takes them
 * @returns {{eye:number[], target:number[], up:number[]}|undefined} the basis
 *   in scene units, or `undefined` without a tracked pose
 */
export function headViewBasis({ headInRoom, renderFromRoom, cameraScale } = {}) {
  if (!matrix16(headInRoom) || !matrix16(renderFromRoom) || !finite(cameraScale) || cameraScale <= 0) return undefined;
  const head = [headInRoom[12], headInRoom[13], headInRoom[14]];
  const forward = seatForward(headInRoom);
  const toScene = point => {
    const value = Vec3.transformMat4(Vec3(), Vec3.create(point[0], point[1], point[2]), renderFromRoom);
    return Array.from(Vec3.scale(value, value, 1 / cameraScale));
  };
  const eye = toScene(head);
  const target = toScene([head[0] + forward[0], head[1] + forward[1], head[2] + forward[2]]);
  const above = toScene([head[0], head[1] + 1, head[2]]);
  const up = above.map((value, axis) => value - eye[axis]);
  return [...eye, ...target, ...up].every(finite) ? { eye, target, up } : undefined;
}

/**
 * The monumental placement for one room, in the units the inspection placement
 * takes: translation in molecular radii, scale against the structure's own
 * bounding sphere.
 *
 * `floor` puts the base of the structure on the detected floor, in front of the
 * wearer. `overhead` puts it above the wearer's head at a fixed height over the
 * floor, so crouching or sitting no longer moves it. Without a floor height
 * both fall back to the head-relative geometry `room-placement.mjs` already
 * uses, and say so through `floorLocked: false`.
 *
 * @returns {{mode:string, floorLocked:boolean, clamped:boolean, metersAcross:number,
 *   standoffMeters:number, reach:number, roomPoint:number[], translation:number[], scale:number}}
 */
export function placementFromRoom({ mode = 'auto', floorY = null, headInRoom, renderFromRoom,
  cameraScale, center, radius, siteCount = 0, deviceClass = 'unknown', measureSeat = null } = {}) {
  if (!matrix16(headInRoom) || !matrix16(renderFromRoom) || center?.length !== 3
    || !Array.from(center).every(finite) || !finite(cameraScale) || cameraScale <= 0
    || !finite(radius) || radius <= 0) throw Error('A current tracked room pose is required.');
  const target = resolveMode({ mode, siteCount });
  const wanted = monumentalMeters({ mode: target, siteCount, deviceClass });
  const unitMeters = 2 * radius * cameraScale;
  // The placement scale is clamped by `inspection-state.mjs`, so the size the
  // wearer sees can be smaller than the size asked for. Derive the base height
  // from the size that will be drawn, not the size requested.
  const scale = clampPlacementScale(wanted / unitMeters);
  const metersAcross = scale * unitMeters;
  const locked = finite(floorY);
  const head = [headInRoom[12], headInRoom[13], headInRoom[14]];
  const frame = { renderFromRoom, cameraScale, center, radius };
  let near, far, standoffMeters = 0;
  if (target === 'overhead') {
    // A shortened placement lowers the structure towards the wearer's head,
    // which is still above them. It never goes below the head.
    near = [head[0], head[1], head[2]];
    const height = locked ? floorY + OVERHEAD_CLEARANCE_M + metersAcross / 2 : head[1] + 3;
    const seat = overheadRoomPoint(head, seatForward(headInRoom), height);
    far = seat.point;
    standoffMeters = seat.distance;
  } else {
    // A head looking straight up or down has no usable forward direction. Its
    // own up axis, flattened, points where the wearer is leaning, which avoids
    // placing a room-sized structure at the wearer's own position.
    const forward = seatForward(headInRoom);
    if (target === 'above') {
      // The entry seat. The width sets the distance and the distance sets the
      // rise, so the wearer looks up into the structure whatever its size.
      const seat = entrySeat(metersAcross);
      standoffMeters = seat.distance;
      near = [head[0], head[1] + seat.rise, head[2]];
      far = [head[0] + forward[0] * standoffMeters, head[1] + seat.rise, head[2] + forward[2] * standoffMeters];
    } else {
      standoffMeters = clamp(metersAcross * 0.7 + 0.6, 1.2, 4);
      // Only the standoff is shortened. The height stays on the floor, which is
      // what this mode exists for.
      const y = locked ? floorY + metersAcross / 2 : head[1];
      near = [head[0], y, head[2]];
      far = [head[0] + forward[0] * standoffMeters, y, head[2] + forward[2] * standoffMeters];
    }
  }
  const start = toRadii(near, frame), end = toRadii(far, frame);
  if (![...start, ...end].every(finite)) throw Error('A current tracked room pose is required.');
  const reach = reachFraction(start, end);
  const exact = start.map((value, axis) => value + reach * (end[axis] - value));
  const translation = exact.map(clampPlacementTranslation);
  const clamped = translation.some((value, axis) => value !== exact[axis]);
  const roomPoint = near.map((value, axis) => value + reach * (far[axis] - value));
  const placement = { mode: target, floorLocked: locked && !clamped && (target === 'floor' || reach === 1),
    clamped, reach, metersAcross, standoffMeters: standoffMeters * reach, roomPoint, translation, scale };
  if (target !== 'above') return placement;
  // Apply after reach shortening, so both first settle and B-button re-seat
  // budget the silhouette at the distance the wearer will actually get.
  return capPlateSeat(placement, measureSeat ?? (candidate => plateSeatLimits({
    silhouette: { x: 0, y: (roomPoint[1] - head[1]) / candidate.standoffMeters,
      halfWidth: radius * cameraScale * candidate.scale / candidate.standoffMeters,
      halfHeight: radius * cameraScale * candidate.scale / candidate.standoffMeters },
    band: { x: 0, y: 0 },
  })));
}

/**
 * Whether the scene may move to a newly-found floor.
 *
 * Plane estimates keep changing for the whole session. Moving the structure
 * every time a plane grows costs the wearer more than a few centimetres of
 * error, so one automatic placement is allowed, when the floor first arrives.
 * After that only the wearer's own "Above us" or "Within reach" press moves
 * the structure.
 *
 * `wearerPlaced` carries that decision across a session boundary. Taking the
 * headset off to read the Mac ends the WebXR session, and the next entry used
 * to spend its one automatic settle overriding a placement the wearer had
 * chosen minutes earlier.
 */
export function shouldReplace({ floorY, appliedFloorY = null, wearerRequested = false, placements = 0,
  wearerPlaced = false, tolerance = 0.05, floorless = false } = {}) {
  if (wearerRequested) return true;
  if (wearerPlaced) return false;
  // A session with no floor is still a session the wearer
  // entered. Quest Browser grants plane detection only when the page asked for
  // it and the room has been set up, and on the telomerase entries
  // it granted none: `watch` never found a floor, this returned false on every
  // frame, and the one automatic settle was never spent. The wearer arrived to
  // the authored placement — scale 1, framed for a desktop panel — which is
  // the "structure rests small" in question. The `above` seat in
  // `placementFromRoom` needs no floor at all; it measures from the head. So a
  // floorless session settles once too, and a floor that turns up later is
  // still allowed to replace it through the clause below.
  if (!finite(floorY)) return floorless === true && placements < 1;
  if (!finite(appliedFloorY)) return placements < 1;
  return placements < 1 && Math.abs(floorY - appliedFloorY) > tolerance;
}

/** Off switch, matching the render budget's `xrRenderBudget` override. */
export function roomAnchorEnabled(scope = globalThis) {
  try {
    const value = new URLSearchParams(String(scope?.location?.search ?? '')).get('roomAnchor');
    return value === null || !['0', 'off', 'false', 'no'].includes(value.trim().toLowerCase());
  } catch { return true; }
}

/**
 * Session-scoped room tracking: find the floor, hold one anchor, and report
 * when the scene should be placed on it.
 *
 * `observe` runs inside the existing per-frame head observer, so it must stay
 * cheap at ninety frames a second. Plane scanning is throttled to
 * `scanIntervalMs`.
 */
export function createRoomAnchor({ scanIntervalMs = 400, settleMs = 2_500,
  floorlessMs = FLOORLESS_SETTLE_MS, now = () => Date.now(),
  wearerPlaced: wearerPlacedBefore = false } = {}) {
  let floor = null, planeCount = 0, lastScan = -Infinity, steadySince = null, watching = null;
  let handle = null, appliedFloorY = null, appliedPoint = null, placements = 0, wearerPlaced = wearerPlacedBefore === true, drift = 0, supported = null;
  function watch({ frame, space, session, headY } = {}) {
    const at = now();
    // The first frame this anchor sees is when the wearer entered. A floorless
    // session has nothing else to time its one settle from.
    if (watching === null) watching = at;
    if (handle && appliedPoint) {
      const { point } = handle.poseIn(frame);
      drift = Math.hypot(point.x - appliedPoint[0], point.y - appliedPoint[1], point.z - appliedPoint[2]);
    }
    if (at - lastScan < scanIntervalMs) return false;
    lastScan = at;
    const planes = planeSetOf(frame, session);
    supported = planes !== null;
    planeCount = planes?.length ?? 0;
    const found = findFloor(frame, session, space, { headY });
    if (found) {
      // Planes keep growing for the first few seconds of a session. Record the
      // height at once, but restart the settle clock whenever the estimate
      // moves, so the scene is placed once, at a height that has stopped
      // changing.
      if (!floor || Math.abs(found.y - floor.y) > 0.02) steadySince = at;
      floor = found;
    }
    if (floor) {
      return at - steadySince >= settleMs
        && shouldReplace({ floorY: floor.y, appliedFloorY, placements, wearerPlaced });
    }
    // No floor, and by now there may never be one. Wait longer than the floor
    // path does before giving up on it, so a room that is about to report one
    // still gets its height rather than the head-relative fallback.
    return at - watching >= floorlessMs
      && shouldReplace({ floorY: null, floorless: true, appliedFloorY, placements, wearerPlaced });
  }

  return {
    /**
     * Watch this frame. Returns true when the scene should settle onto the
     * floor. Never raises: a frame loop is the worst place to introduce one.
     *
     * @returns {boolean}
     */
    observe(context = {}) { try { return watch(context); } catch { return false; } },
    /**
     * Adopt a placement the wearer chose in an earlier session, read from the
     * saved scene after it hydrates. The scene usually arrives after this
     * anchor is created, so the seed option alone cannot cover it.
     */
    rememberWearerPlacement() { wearerPlaced = true; },
    floorY() { return floor ? floor.y : null; },
    floor() { return floor ? { y: floor.y, area: floor.area, label: floor.label } : null; },
    status() {
      return { supported, planeCount, floorY: floor ? floor.y : null, anchored: Boolean(handle?.anchored),
        tracked: Boolean(handle?.tracked), lost: Boolean(handle?.lost), appliedFloorY, placements,
        wearerPlaced, driftMeters: Math.round(drift * 1000) / 1000 };
    },
    /** Record that the scene was placed, and anchor the point it was placed at. */
    async applied({ frame, space, roomPoint, wearerRequested = false } = {}) {
      appliedFloorY = floor ? floor.y : null;
      // Any placement, the wearer's own included, spends the one automatic
      // settle. Nothing but another press moves the scene after this.
      placements += 1;
      wearerPlaced ||= wearerRequested;
      try { handle?.release(); } catch { /* Replaced below either way. */ }
      handle = null; appliedPoint = null; drift = 0;
      if (!Array.isArray(roomPoint) || roomPoint.length !== 3 || !roomPoint.every(finite)) return null;
      appliedPoint = [...roomPoint];
      try {
        handle = await anchorScene(frame, space, { position: { x: roomPoint[0], y: roomPoint[1], z: roomPoint[2] } });
      } catch { handle = null; }
      return handle;
    },
    release() { try { handle?.release(); } catch { /* The session may already be gone. */ } handle = null; appliedPoint = null; drift = 0; },
  };
}
