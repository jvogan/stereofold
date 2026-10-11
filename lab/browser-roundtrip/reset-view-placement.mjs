import { SUBJECT_CENTRE_TANGENT } from './placement-fit-envelope.mjs';
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { SUBJECT_SHIFT_LIMIT, lensTangent } from './plate-standoff.mjs';
import { ENTRY_STANDOFF_RANGE } from './room-anchor.mjs';
import { resetEntryGeometry, fitEntryGeometry, resetEntryTravel, resetEntryLateralTravel,
  resetEntryLateralBreakdown, subjectVisibleInEyes } from './reset-entry-geometry.mjs';
import { EYE_HALF_FIELD_DEGREES, EYE_HALF_FIELD_VERTICAL_DEGREES,
  PANEL_FRAME_MARGIN_DEGREES, HALF_IPD_METERS, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';

/**
 * Fixed-size Reset restores the entry pose with forward-only clearance.
 * Done first retains a saved placement that clears the full rendered glass.
 * Entry and Reset opt into fitting: retain size when possible, then use
 * the existing depth/scale freedom until clearance and the centre band agree.
 * Other seating/scale actions keep their size and clear the menu sideways.
 * Radial menu standoff separates objects in the room, but leaves their
 * projections overlapping. Translate the structure sideways until its whole
 * sphere clears the controls AND caption in both eyes; retain size and depth.
 *
 * The toolbar supplies its renderer's full plate geometry, including backing
 * depth and the caption envelope. Entry/reset can measure the upcoming seat;
 * a committed scale measures the glass already drawn in the room.
 */
/**
 * The band `focus-placement.mjs` seats against, in tangent, rounded the way
 * `resetEntryLateralTravel` rounds it so the two readings cannot drift apart.
 */
const SEATED_CENTRE_TANGENT = SUBJECT_CENTRE_TANGENT;
// The existing whole-subject edge limit also bounds its centre. Automatic
// seating may use this free field before shrinking, while Reset and saved
// placements retain their original centring contract.
const FREE_FIELD_CENTRE_TANGENT = lensTangent(SUBJECT_SHIFT_LIMIT);

/**
 * Where the subject's silhouette sits across the lens, read from the head
 * rather than from one eye.
 *
 * The per-eye formula is `resetEntryLateralTravel`'s own, so a seat this
 * accepts is one that solver would accept if its band were head-centred. The
 * mean of the two eyes is the head reading: the eyes are symmetric about it,
 * and the seating projects from that same midpoint. Unreadable geometry — a
 * missing eye matrix, or a sphere the eye is inside — returns undefined and
 * the caller keeps its conservative fit.
 */
function headCentredSubjectTangent(geometry) {
  const centres = [];
  for (const view of geometry.views ?? []) {
    const matrix = view.transform?.inverse?.matrix;
    if (matrix?.length !== 16) return undefined;
    let low = Infinity, high = -Infinity;
    for (const sphere of geometry.subject ?? []) {
      const point = applyMatrix4(sphere.center, matrix), z = -point[2], r = sphere.radius;
      if (!(z > r)) return undefined;
      const spread = r * Math.sqrt(point[0] * point[0] + z * z - r * r), denominator = z * z - r * r;
      low = Math.min(low, (point[0] * z - spread) / denominator);
      high = Math.max(high, (point[0] * z + spread) / denominator);
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return undefined;
    centres.push((low + high) / 2);
  }
  return centres.length ? centres.reduce((sum, value) => sum + value, 0) / centres.length : undefined;
}

export function resetViewPlacement(options) {
  if (!options.fit) return fixedViewPlacement(options);
  const { seat, headInRoom, renderFromRoom, cameraScale, center, radius, geometry } = options;
  const anchor = center.map((v, i) => (v + seat.translation[i] * radius) * cameraScale);
  const rendered = options.renderedGeometry ?? (geometry && resetEntryGeometry({ ...geometry, cameraScale, renderFromRoom }));
  // An explicit room placement may be above or behind the current gaze. The
  // wearer will turn to it. Prove menu separation without requiring a framed
  // subject; automatic entry, Fit and saved-seat recovery keep their frusta.
  if (options.allowOffscreen) {
    if (rendered && resetEntryLateralBreakdown({ geometry: rendered, points: options.points ?? [], clearance: 0 })?.separated)
      return seat;
    throw Object.assign(Error('The requested room placement would cover the menu. Move the menu, then try again.'), { code: 'MENU_OVERLAP' });
  }
  if (options.savedReading) options.savedReading.geometry = rendered;
  const roomPoint = applyMatrix4(anchor, invertMatrix4(renderFromRoom));
  const origin = headInRoom.slice(12, 15), forward = headInRoom.slice(8, 11).map(v => -v);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const depth = dot(roomPoint.map((v, i) => v - origin[i]), forward);
  // A saved mesh can clear the menu with less than the fit's extra degree of
  // margin. Check it in both eyes, frusta and centre bands before spending
  // translation or scale. Keep the fit's margin for an actual adjustment.
  // Unreadable geometry retains the existing conservative fit below.
  //
  // The second reading below
  // exists because the two ends of the same rule disagree about which frame it
  // is read in. `focus-placement.mjs` seats the subject against
  // `SUBJECT_CENTRE_LENS` HEAD-CENTRED; `resetEntryLateralTravel` re-reads the
  // same constant PER EYE, and the 32 mm eye offset moves a 3.6 m subject
  // about 0.009 tangent. The entry seat the app itself chose sat at 0.1322
  // tangent head-centred, inside the 0.1350 band, and at 0.1411 in the left
  // eye, outside it. The zero-clearance call therefore returned Infinity and
  // Done refit a molecule nobody had moved, from 0.9336 to 0.4224.
  //
  // So a saved seat is also kept when the whole subject is off one side of the
  // drawn glass in both eyes AND its head-centred silhouette is inside the
  // band the seating used. `separated` is the question the zero-clearance path
  // says it asks, without the travel clips; the band reading keeps Done's
  // re-centring of a saved seat that is genuinely off to one side (a device run,
  // 0.565 tangent out, is refused by both readings). Written as an `||` so
  // every seat retained today is still retained.
  //
  // Those two questions are both about where the subject
  // sits ACROSS the glass, and neither asks whether the wearer can see it. Off
  // one side and inside the band is equally true of a subject wholly nearer
  // than the near plane, wholly beyond the far plane, or wholly above the
  // field — a saved seat showing nothing, which Done would then hand back
  // untouched. The frusta clips the first reading already applies answer that,
  // so the second reading asks them too, at their weakest: some of the subject
  // inside every plane of both eyes. A large molecule the wearer seated with
  // its edges off the field is still seen, and still keeps its seat; the first
  // reading's stricter whole-subject clips are unchanged.
  // An appearance edit (keepClearSeat) keeps the requested pose too when the
  // new rendered silhouette already clears both eyes: the one-degree margin is
  // for a correction, not a reason to move an accepted pose on every edit.
  // Entry, Fit and host placement edits still take the margin path.
  // A caller may identify this exact pose as the current session's automatic
  // entry seat. Retain it only with a fresh, zero-motion proof; this does not
  // grant saved/Reset paths any wider relocation or fitting policy.
  if (options.retainFreeFieldSeat && rendered
    && resetEntryLateralTravel({ geometry: rendered, points: options.points ?? [],
      right: headInRoom.slice(0, 3), clearance: 0, centreLimit: FREE_FIELD_CENTRE_TANGENT }) === 0) return seat;
  if ((options.restoreSaved || options.keepClearSeat) && rendered) {
    if (options.savedReading) options.savedReading.points = options.points;
    const lateralTravel = resetEntryLateralTravel({ geometry: rendered,
      points: options.points ?? [], right: headInRoom.slice(0, 3), clearance: 0 });
    if (options.savedReading) options.savedReading.lateralTravel = lateralTravel;
    if (lateralTravel === 0) return seat;
    if (options.keepClearSeat && !options.restoreSaved && !options.centered
      && resetEntryLateralTravel({ geometry: rendered, points: options.points ?? [],
        right: headInRoom.slice(0, 3), clearance: 0, centreLimit: FREE_FIELD_CENTRE_TANGENT }) === 0) return seat;
    const breakdown = resetEntryLateralBreakdown({ geometry: rendered, points: options.points ?? [], clearance: 0 });
    if (options.savedReading) options.savedReading.breakdown = breakdown;
    if (breakdown?.separated === true && subjectVisibleInEyes(rendered)
      && Math.abs(headCentredSubjectTangent(rendered) ?? Infinity) <= SEATED_CENTRE_TANGENT + 1e-9) return seat;
  }
  const trySeat = (candidate, centreLimit) => {
    const moved = center.map((v, i) => (v + candidate.translation[i] * radius) * cameraScale);
    return fixedViewPlacement({ ...options, seat: candidate, centered: false, bounded: true, centreLimit,
      renderedGeometry: rendered ? fitEntryGeometry(rendered, { anchor, moved, ratio: candidate.scale / seat.scale }) : null });
  };
  // Reset first retains its rendered entry exactly, or spends forward travel.
  // A failed fixed-size solve is only a request to fit, never a refusal yet.
  if (options.centered) {
    try {
      const restored = fixedViewPlacement({ ...options, renderedGeometry: rendered ?? null });
      const clear = trySeat(restored);
      if (clear) return clear;
    } catch (error) {
      if (!error.message.startsWith('Could not reset: the entry size cannot fit')) throw error;
    }
  }
  const current = trySeat(seat);
  if (current === seat && depth <= ENTRY_STANDOFF_RANGE.max) return seat;
  if (current && depth <= ENTRY_STANDOFF_RANGE.max) return { ...current, standoffMeters: depth,
    metersAcross: radius * cameraScale * current.scale * 2 };

  // Use the existing depth freedom before reducing size. Recenter the anchor
  // laterally so an old off-screen entry cannot make every size unreachable.
  const right = headInRoom.slice(0, 3);
  const lateral = dot(roomPoint.map((v, i) => v - origin[i]), right);
  const movedRoom = roomPoint.map((v, i) => v - lateral * right[i]
    + (ENTRY_STANDOFF_RANGE.max - depth) * forward[i]);
  const moved = applyMatrix4(movedRoom, renderFromRoom);
  const base = { ...seat, roomPoint: movedRoom,
    translation: moved.map((v, i) => (v / cameraScale - center[i]) / radius),
    standoffMeters: ENTRY_STANDOFF_RANGE.max };
  const atScale = scale => {
    const candidate = trySeat({ ...base, scale });
    return candidate && { ...candidate, metersAcross: radius * cameraScale * scale * 2,
      resetTravelMeters: ENTRY_STANDOFF_RANGE.max - depth };
  };
  const deeper = atScale(seat.scale);
  if (deeper) return deeper;
  // A left menu can occupy nearly all of the narrow centre band while the
  // right side of both eyes is free. Try the requested size there before
  // spending scale. These candidates keep the same mesh, stereo frusta,
  // whole-subject edge limit and full menu clearance. Saved/manual poses and
  // centred Reset continue through their existing fitting policy.
  if (rendered && !options.centered && !options.restoreSaved) {
    const lateral = depth <= ENTRY_STANDOFF_RANGE.max
      ? trySeat(seat, FREE_FIELD_CENTRE_TANGENT) : undefined;
    if (lateral) return { ...lateral, standoffMeters: depth,
      metersAcross: radius * cameraScale * lateral.scale * 2 };
    const farther = trySeat(base, FREE_FIELD_CENTRE_TANGENT);
    if (farther) return { ...farther, standoffMeters: ENTRY_STANDOFF_RANGE.max,
      metersAcross: radius * cameraScale * farther.scale * 2,
      resetTravelMeters: ENTRY_STANDOFF_RANGE.max - depth };
  }
  // Use the saved-placement range so even a large coordinate assembly can
  // shrink into the same physical field of view as a small source.
  let low = PLACEMENT_MIN_SCALE, high = seat.scale, best = atScale(low);
  if (!best && rendered && (options.points ?? []).length) {
    // A wide menu can consume the whole sideways band even at the smallest
    // size. Try the free glass above and below it before declaring no fit.
    const up = headInRoom.slice(4, 7);
    const small = { ...base, scale: low };
    const geometry = fitEntryGeometry(rendered, { anchor, moved, ratio: low / seat.scale });
    const vertical = [up, up.map(value => -value)].flatMap(direction => {
      const travel = resetEntryTravel({ geometry, points: options.points, forward: direction,
        maximum: ENTRY_STANDOFF_RANGE.max });
      if (!(travel > 0) || !Number.isFinite(travel)) return [];
      const roomPoint = movedRoom.map((value, i) => value + travel * direction[i]);
      const scene = applyMatrix4(roomPoint, renderFromRoom);
      const translation = scene.map((value, i) => (value / cameraScale - center[i]) / radius);
      if (translation.some(value => !Number.isFinite(value) || Math.abs(value) > PLACEMENT_MAX_TRANSLATION)) return [];
      return [{ ...small, roomPoint, translation, metersAcross: radius * cameraScale * low * 2,
        standoffMeters: ENTRY_STANDOFF_RANGE.max, verticalTravelMeters: travel }];
    });
    best = vertical.sort((a, b) => a.verticalTravelMeters - b.verticalTravelMeters)[0];
  }
  if (!best) throw Error('Could not reset: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.');
  // Refine the largest fitting size to placement precision. Every candidate
  // passes both eyes, the centre band, the frusta and the complete glass.
  while (high - low > 1e-6) {
    const mid = (low + high) / 2, candidate = atScale(mid);
    if (candidate) { best = candidate; low = mid; } else high = mid;
  }
  return best;
}

function fixedViewPlacement({ seat, points = [], headInRoom, renderFromRoom, cameraScale, center, radius, centered = false, geometry, bounded = false, renderedGeometry, centreLimit }) {
  if (centered) {
    // Restore the committed entry size and lateral position. A forward-only
    // adjustment can make room for a moved menu or a changed head pose.
    const origin = [headInRoom[12], headInRoom[13], headInRoom[14]];
    const right = headInRoom.slice(0, 3), up = headInRoom.slice(4, 7);
    const forward = headInRoom.slice(8, 11).map(value => -value);
    const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
    const roomPoint = applyMatrix4(center.map((value, axis) =>
      (value + seat.translation[axis] * radius) * cameraScale), invertMatrix4(renderFromRoom));
    const roomRadius = radius * cameraScale * seat.scale;
    const depth = dot(roomPoint.map((value, axis) => value - origin[axis]), forward);
    const maximum = Math.max(0, ENTRY_STANDOFF_RANGE.max - depth);
    const rendered = renderedGeometry !== undefined ? renderedGeometry
      : geometry && resetEntryGeometry({ ...geometry, cameraScale, renderFromRoom });
    const measuredTravel = rendered && resetEntryTravel({ geometry: rendered, points, forward, maximum });
    if (measuredTravel !== undefined && measuredTravel !== null) {
      if (!Number.isFinite(measuredTravel)) throw Error('Could not reset: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.');
      if (measuredTravel <= 1e-10) return { ...seat, roomPoint, metersAcross: roomRadius * 2, standoffMeters: depth };
      const moved = roomPoint.map((value, axis) => value + measuredTravel * forward[axis]);
      const scene = applyMatrix4(moved, renderFromRoom);
      const translation = scene.map((value, axis) => (value / cameraScale - center[axis]) / radius);
      if (translation.some(value => !Number.isFinite(value) || Math.abs(value) > PLACEMENT_MAX_TRANSLATION))
        throw Error('Could not reset: the entry seat is beyond the placement range. Press Fit, or move the menu.');
      return { ...seat, roomPoint: moved, translation, metersAcross: roomRadius * 2,
        standoffMeters: depth + measuredTravel, resetTravelMeters: measuredTravel };
    }
    let intervals = [[0, maximum]];
    // Intersect travel intervals with one half-space a + b*t >= 0.
    const clip = (ranges, a, b) => ranges.flatMap(([low, high]) => {
      if (Math.abs(b) < 1e-12) return a >= -1e-10 ? [[low, high]] : [];
      if (b > 0) low = Math.max(low, -a / b);
      else high = Math.min(high, -a / b);
      return low <= high + 1e-10 ? [[low, Math.max(low, high)]] : [];
    });
    const horizontal = Math.tan((EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180);
    const vertical = Math.tan((EYE_HALF_FIELD_VERTICAL_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180);
    for (const side of [-1, 1]) {
      const eye = origin.map((value, axis) => value + side * HALF_IPD_METERS * right[axis]);
      const relative = roomPoint.map((value, axis) => value - eye[axis]);
      for (const [axis, tangent] of [[right, horizontal], [up, vertical]]) {
        for (const sign of [-1, 1]) intervals = clip(intervals,
          tangent * dot(relative, forward) + sign * dot(relative, axis) - roomRadius * Math.hypot(1, tangent), tangent);
      }
      const visible = points.map(point => point.map((value, axis) => value - eye[axis]))
        .filter(point => dot(point, forward) > 0);
      if (!visible.length) continue;
      const clear = [];
      for (let degrees = 0; degrees < 360; degrees += 5) {
        const angle = degrees * Math.PI / 180;
        const normal = right.map((value, axis) => value * Math.cos(angle) + up[axis] * Math.sin(angle));
        const edge = Math.max(...visible.map(point => dot(point, normal) / dot(point, forward))) + Math.tan(Math.PI / 180);
        clear.push(...clip(intervals, dot(relative, normal) - edge * dot(relative, forward)
          - roomRadius * Math.hypot(1, edge), -edge));
      }
      intervals = clear;
    }
    if (!intervals.length || !Number.isFinite(roomRadius) || roomRadius <= 0)
      throw Error('Could not reset: the entry size cannot fit inside both eyes and clear the menu within 4 m. Press Fit, or move the menu.');
    const travel = Math.max(0, Math.min(...intervals.map(([low]) => low)));
    if (travel <= 1e-10) return { ...seat, roomPoint, metersAcross: roomRadius * 2, standoffMeters: depth };
    const moved = roomPoint.map((value, axis) => value + travel * forward[axis]);
    const scene = applyMatrix4(moved, renderFromRoom);
    const translation = scene.map((value, axis) => (value / cameraScale - center[axis]) / radius);
    return { ...seat, roomPoint: moved, translation, metersAcross: roomRadius * 2,
      standoffMeters: depth + travel, resetTravelMeters: travel };
  }
  if (!points.length && !bounded) return seat;
  const head = { matrix: headInRoom,
    position: { x: headInRoom[12], y: headInRoom[13], z: headInRoom[14] } };
  const basis = toolbarSeatBasis(head);
  const roomCenter = seat.roomPoint ?? applyMatrix4(
    center.map((value, axis) => (value + seat.translation[axis] * radius) * cameraScale),
    invertMatrix4(renderFromRoom));
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const relative = (point, eye) => point.map((value, axis) => value - eye[axis]);
  const roomRadius = radius * cameraScale * seat.scale;
  let shift = 0;
  const rendered = renderedGeometry !== undefined ? renderedGeometry
    : bounded && geometry && resetEntryGeometry({ ...geometry, cameraScale, renderFromRoom });
  const measured = rendered && resetEntryLateralTravel({ geometry: rendered, points, right: basis.right, centreLimit });
  if (typeof measured === 'number') {
    if (!Number.isFinite(measured)) return undefined;
    shift = measured;
  } else for (const side of (points.length ? [-1, 1] : [])) {
    const eye = basis.origin.map((value, axis) => value + side * HALF_IPD_METERS * basis.right[axis]);
    // A plane through the eye at the menu's inboard tangent separates every
    // point of the menu from the sphere. One degree of air in tangent units
    // avoids contact without changing any menu dimensions or scale limits.
    const edge = Math.max(...points.map(point => {
      const v = relative(point, eye);
      return dot(v, basis.right) / dot(v, basis.forward);
    })) + Math.tan(Math.PI / 180);
    const v = relative(roomCenter, eye);
    shift = Math.max(shift, edge * dot(v, basis.forward) - dot(v, basis.right)
      + roomRadius * Math.hypot(1, edge));
  }
  const roomPoint = roomCenter.map((value, axis) => value + shift * basis.right[axis]);
  if (bounded && typeof measured !== 'number') {
    // Missing/unreadable render geometry keeps the conservative sphere test.
    // It may request Fit, but can never authorize an off-screen dodge.
    for (const side of [-1, 1]) {
      const eye = basis.origin.map((v, i) => v + side * HALF_IPD_METERS * basis.right[i]);
      const v = relative(roomPoint, eye), x = dot(v, basis.right), z = dot(v, basis.forward);
      if (!(z > roomRadius)) return undefined;
      const y = dot(v, basis.up);
      const vertical = Math.tan((EYE_HALF_FIELD_VERTICAL_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180);
      if (Math.abs(y) + roomRadius * Math.hypot(1, vertical) > vertical * z) return undefined;
      const spread = roomRadius * Math.sqrt(x * x + z * z - roomRadius * roomRadius);
      const low = (x * z - spread) / (z * z - roomRadius * roomRadius);
      const high = (x * z + spread) / (z * z - roomRadius * roomRadius);
      if (Math.abs((low + high) / 2) > SUBJECT_CENTRE_TANGENT
        || Math.max(Math.abs(low), Math.abs(high)) > lensTangent(SUBJECT_SHIFT_LIMIT)) return undefined;
    }
  }
  if (Math.abs(shift) <= 1e-10) return seat;
  const scene = applyMatrix4(roomPoint, renderFromRoom);
  const translation = scene.map((value, axis) => (value / cameraScale - center[axis]) / radius);
  if (bounded && translation.some(v => !Number.isFinite(v) || Math.abs(v) > PLACEMENT_MAX_TRANSLATION)) return undefined;
  return { ...seat, roomPoint, translation };
}
