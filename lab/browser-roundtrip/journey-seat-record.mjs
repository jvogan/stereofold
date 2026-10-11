/**
 * The `journey-seat` diagnostics record.
 *
 * Three in-memory fixes for that defect — a model-driven Done that restores the
 * pre-tour view and then halves it — passed their tests and failed on the
 * headset, because every one of them was written against an approximation of
 * what the clearance solver is handed. This module turns one Done into one
 * record of the solver's actual inputs: the glass it measured, the subject it
 * measured against, the panel that was drawn afterwards, and the branch it
 * took. Nothing here decides anything. It reads what `restoreJourneySeat` has
 * already built and returns a plain JSON-safe object.
 *
 * Every length is a metre and every rect is a tangent — x/−z and y/−z at the
 * eye — which is the unit `plate-standoff` records already use, so a
 * `menuHalfWidth` from that ring and a `right` from this one are the same
 * measurement. Numbers are rounded to four decimals, matching the rounding
 * `resetEntryLateralTravel` already assumes of the ring.
 */
import { applyMatrix4 } from './room-lock.mjs';
import { resetEntryGeometry, resetEntryLateralTravel, resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';

/** Diagnostics precision. A non-finite reading is recorded as null, never NaN. */
export const round4 = value => (Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null);

const eyeMatrix = view => {
  const matrix = view?.transform?.inverse?.matrix;
  return matrix?.length === 16 ? matrix : undefined;
};

const emptyRect = (view, extra) => ({ eye: view?.eye ?? null, points: 0,
  left: null, right: null, bottom: null, top: null, ...extra });

/**
 * The tangent rect a set of XR room-metre points occupies at each eye.
 *
 * Points behind the eye carry no tangent and are dropped, exactly as the
 * clearance solvers drop them. An eye that keeps none reports a zero count
 * rather than an invented rectangle.
 */
export function tangentRectsForPoints({ views = [], renderFromRoom, points = [] } = {}) {
  const rendered = renderFromRoom?.length === 16 ? points.map(p => applyMatrix4(p, renderFromRoom)) : [];
  return views.map(view => {
    const matrix = eyeMatrix(view);
    if (!matrix) return emptyRect(view);
    const seen = rendered.map(p => applyMatrix4(p, matrix)).filter(p => p[2] < -1e-9);
    if (!seen.length) return emptyRect(view);
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    for (const p of seen) {
      const x = p[0] / -p[2], y = p[1] / -p[2];
      left = Math.min(left, x); right = Math.max(right, x);
      bottom = Math.min(bottom, y); top = Math.max(top, y);
    }
    return { eye: view.eye ?? null, points: seen.length,
      left: round4(left), right: round4(right), bottom: round4(bottom), top: round4(top) };
  });
}

/**
 * The tangent rect the subject's bounding sphere fills at each eye.
 *
 * This is the silhouette, not a projected centre: a sphere close to the eye
 * subtends more than its centre's tangent suggests, and the same tangent
 * formula the lateral solver uses for its centre-band check is used here. A
 * sphere the eye is inside, or nearly, has no silhouette and says so.
 */
export function tangentRectsForSphere({ views = [], center, radius } = {}) {
  return views.map(view => {
    const matrix = eyeMatrix(view);
    if (!matrix || center?.length !== 3 || !(radius > 0)) return emptyRect(view, { points: 0 });
    const p = applyMatrix4(center, matrix), depth = -p[2];
    if (!(depth > radius)) return emptyRect(view, { points: 1, behind: true });
    const denominator = depth * depth - radius * radius;
    const span = axis => {
      const spread = radius * Math.sqrt(p[axis] * p[axis] + depth * depth - radius * radius);
      return [(p[axis] * depth - spread) / denominator, (p[axis] * depth + spread) / denominator];
    };
    const [left, right] = span(0), [bottom, top] = span(1);
    return { eye: view.eye ?? null, points: 1, left: round4(left), right: round4(right),
      bottom: round4(bottom), top: round4(top) };
  });
}

/** The eight constants `layoutSignature` compares, so two panels can be told apart. */
export function layoutConstants(layout) {
  if (!layout) return null;
  return { forwardMeters: round4(layout.forwardMeters), rightMeters: round4(layout.rightMeters),
    lowerMeters: round4(layout.lowerMeters), fontMeters: round4(layout.fontMeters),
    rowStepMeters: round4(layout.rowStepMeters), columnStepMeters: round4(layout.columnStepMeters),
    maxRows: layout.maxRows ?? null, maxReadoutLines: layout.maxReadoutLines ?? null };
}

/** A head as position and forward bearing: enough to tell a held seat from a live one. */
export function headReading(head) {
  const matrix = head?.matrix;
  if (matrix?.length !== 16) return null;
  return [round4(matrix[12]), round4(matrix[13]), round4(matrix[14]),
    round4(-matrix[8]), round4(-matrix[9]), round4(-matrix[10])];
}

const rowIds = rows => (Array.isArray(rows) ? rows.map(row => String(row?.id ?? '')) : []);
const textLines = lines => (Array.isArray(lines) ? lines.map(line => String(typeof line === 'string' ? line : line?.text ?? '')) : []);
const placementOf = seat => (seat ? { scale: round4(seat.scale),
  x: round4(seat.translation?.[0]), y: round4(seat.translation?.[1]), z: round4(seat.translation?.[2]) } : null);

/**
 * Assemble one `journey-seat` detail.
 *
 * `preview` is the single build of the upcoming panel the solver measured,
 * from `placementPreview`. `committed` is what the toolbar actually drew after
 * Done, read once `restoreTourSeat` has returned. `cleared` is the seat
 * `resetViewPlacement` returned, or a falsy value when Done fell through to
 * entry fitting. Everything else is the pose and geometry the solve ran on.
 */
export function journeySeatDetail({ pose, immersive, before, cleared, fitted, placementRestored,
  cameraScale, sphere, geometry, roomPose, preview, committed, savedReading, failureReason } = {}) {
  const views = roomPose?.labelViews ?? [];
  const renderFromRoom = roomPose?.renderFromRoom;
  const anchor = sphere && before
    ? sphere.center.map((value, axis) => (value + before.translation[axis] * sphere.radius) * cameraScale)
    : undefined;
  const rendered = savedReading ? savedReading.geometry : geometry && renderFromRoom
    ? resetEntryGeometry({ ...geometry, cameraScale, renderFromRoom }) : undefined;
  const lateralPoints = preview?.points ?? savedReading?.points ?? [];
  const samePoints = savedReading && (savedReading.points === lateralPoints
    || (!savedReading.points?.length && !lateralPoints.length));
  let lateralTravel, breakdown;
  if (rendered) {
    try { lateralTravel = samePoints && Object.hasOwn(savedReading, 'lateralTravel')
      ? savedReading.lateralTravel : resetEntryLateralTravel({ geometry: rendered, points: lateralPoints,
      right: roomPose.headInRoom.slice(0, 3), clearance: 0 }); } catch { lateralTravel = undefined; }
    try { breakdown = samePoints && Object.hasOwn(savedReading, 'breakdown')
      ? savedReading.breakdown : resetEntryLateralBreakdown({ geometry: rendered, points: lateralPoints, clearance: 0 }); } catch { breakdown = undefined; }
  }
  // `Infinity` is the lateral solver's "use the entry seat instead" and is the
  // one answer a Done that shrank the view must be read for. JSON cannot carry
  // it, so it is spelled out; unreadable geometry stays null.
  const lateralReading = lateralTravel === undefined || lateralTravel === null ? null
    : Number.isFinite(lateralTravel) ? round4(lateralTravel) : 'infinite';
  const path = cleared ? 'cleared' : fitted ? 'seatStructureForEntry' : 'none';
  return {
    pose: Boolean(pose), immersive: Boolean(immersive), path,
    ...(failureReason ? { failureReason } : {}),
    placementRestored: Boolean(placementRestored), fitted: Boolean(fitted),
    cameraScale: round4(cameraScale), radius: round4(sphere?.radius),
    before: placementOf(before),
    after: cleared && cleared !== true ? placementOf(cleared) : null,
    standoffMeters: round4(cleared?.standoffMeters), resetTravelMeters: round4(cleared?.resetTravelMeters),
    metersAcross: round4(cleared?.metersAcross),
    previewRects: tangentRectsForPoints({ views, renderFromRoom, points: lateralPoints }),
    previewMenuRects: tangentRectsForPoints({ views, renderFromRoom, points: preview?.menuPoints?.() ?? [] }),
    subjectRects: tangentRectsForSphere({ views, center: anchor,
      radius: sphere && before ? sphere.radius * cameraScale * before.scale : 0 }),
    menuRects: tangentRectsForPoints({ views, renderFromRoom, points: committed?.menuPoints ?? [] }),
    plateRects: tangentRectsForPoints({ views, renderFromRoom, points: committed?.platePoints ?? [] }),
    lateralTravel: lateralReading,
    lateralAlreadyClear: breakdown?.alreadyClear ?? null,
    lateralSeparated: breakdown?.separated ?? null,
    lateralEyes: (breakdown?.eyes ?? []).map(eye => ({ ...eye,
      edgeMinus: round4(eye.edgeMinus), edgePlus: round4(eye.edgePlus),
      separationX: round4(eye.separationX), separationY: round4(eye.separationY) })),
    previewRows: rowIds(preview?.rows), committedRows: rowIds(committed?.rows),
    previewReadout: textLines(preview?.readout), committedReadout: textLines(committed?.readout),
    previewCollapsed: preview?.collapsed ?? null, committedCollapsed: committed?.collapsed ?? null,
    previewLayout: layoutConstants(preview?.layout), committedLayout: layoutConstants(committed?.layout),
    previewHead: headReading(preview?.head), committedHead: headReading(committed?.head),
  };
}
