/**
 * Aim at the menu the way a wearer does, and say so.
 *
 * `__stereofoldMenu.press(id)` hands a row's action straight to the toolbar's
 * action chain. That proves dispatch and nothing about targeting: it never
 * builds a ray, never crosses the panel plane, and never asks the hit test
 * whether the row it names is the row a controller pointed at would have hit.
 * A menu walk driven entirely by `press` therefore cannot fail the way the
 * session failed, which is with rows that dispatch fine and are
 * unreachable to a pointed hand.
 *
 * This module builds the missing half. `toolbarAimRay` turns a drawn row into
 * a target ray from a plausible controller pose, and the hook feeds that ray
 * through the toolbar's own `selectstart`/`select`/`selectend` handlers, so
 * row rectangles, hover ranking, the press debounce, the quiet-menu wake rule
 * and the recessed-row refusal are all exercised by the same code the wearer's
 * trigger runs.
 *
 * It is a SIMULATED CONTROLLER POSE, not a hand and not a person. Nothing here
 * observes tracking, reach, comfort, or whether a row can be read. Every
 * caller is required to print that, and `headset-drive.ts` does.
 */

import { hitToolbarPanel } from './spatial-toolbar-geometry.mjs';

const EPSILON = 1e-6;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const unit = value => {
  const length = Math.hypot(...value);
  return length > EPSILON ? scale(value, 1 / length) : undefined;
};

/**
 * Where the simulated controller is, relative to the levelled head the panel
 * was seated from: out to the right, down at waist height, in XR metres. It is
 * deliberately NOT the eye. A ray from the eye meets the panel square on and
 * would pass a hit test that an actual pointed controller — always oblique,
 * always off-axis — can still fail.
 */
export const AIM_CONTROLLER_OFFSET = Object.freeze({ right: 0.18, up: -0.4 });

/**
 * A target ray aimed at one point on the drawn panel.
 *
 * The ray's plane intersection is exactly `point`, by construction, so a row
 * this returns a ray for is a row a controller in that pose could hit. Nothing
 * is asserted here about whether the hit test accepts it: a recessed status
 * chip is `targetable: false` and must come back as a miss, which is the whole
 * reason the caller runs the real hit test rather than trusting this.
 */
export function aimRayAtPoint(panel, point, offset = AIM_CONTROLLER_OFFSET) {
  if (!panel || !finite3(point) || !finite3(panel.seatOrigin) || !finite3(panel.right) || !finite3(panel.up)) return undefined;
  const origin = add(add(panel.seatOrigin, scale(panel.right, offset.right ?? 0)), scale(panel.up, offset.up ?? 0));
  const direction = unit(sub(point, origin));
  return direction ? { origin, direction } : undefined;
}

/**
 * The point one aim step targets.
 *
 * `{ row: index }` is the centre of that row's plate. `{ point: [x, y, z] }`
 * is a point on the panel plane a caller already chose, which is how the miss
 * target below is aimed.
 */
export function aimTargetPoint(panel, target = {}) {
  if (finite3(target.point)) return [...target.point];
  const point = (panel?.buttons ?? [])[target.row]?.point;
  return finite3(point) ? [...point] : undefined;
}

export function toolbarAimRay(panel, target, offset = AIM_CONTROLLER_OFFSET) {
  const point = aimTargetPoint(panel, target);
  return point ? aimRayAtPoint(panel, point, offset) : undefined;
}

/**
 * Somewhere on the drawn panel that must press nothing.
 *
 * Measured on this layout, the row rectangles do NOT leave a
 * vertical gap. `rowStepMeters` is 0.075 and `rowHalfHeightFactor` 0.52, so
 * two rows in one column are 0.0465 m apart and each is 0.04836 m tall — they
 * overlap by about 1.9 mm, and the midpoint between two stacked rows is inside
 * the upper one. A miss test that aimed there would fail on a correct build,
 * which is worse than not running it.
 *
 * The two columns do leave a gap: 0.2232 m between centres against 0.08556 m
 * half-widths, so 0.052 m of nothing down the middle. That is the miss this
 * returns when the grid is open. A single-column menu has no such gap, so the
 * fallback is the band just above the top row, where the status line is drawn
 * and which is deliberately outside the hit grid.
 *
 * Every candidate is checked against the panel's own hit test before it is
 * returned, so this can never hand back a "miss" that is really a row.
 */
export function toolbarMissTarget(panel, hitTest = hitToolbarPanel) {
  const buttons = panel?.buttons ?? [];
  if (!buttons.length || !finite3(panel?.up)) return undefined;
  const candidates = [];
  for (let index = 0; index < buttons.length; index++) {
    for (let other = index + 1; other < buttons.length; other++) {
      if (buttons[index]?.line !== buttons[other]?.line || buttons[other]?.column !== buttons[index]?.column + 1) continue;
      candidates.push({ kind: 'between-columns', between: [index, other],
        point: scale(add(buttons[index].point, buttons[other].point), 0.5) });
    }
  }
  const top = buttons.reduce((best, button) => (!best || button.line < best.line ? button : best), undefined);
  if (top) {
    candidates.push({ kind: 'above-top-row', between: [buttons.indexOf(top)],
      point: add(top.point, scale(panel.up, top.halfHeight * 2)) });
  }
  for (const candidate of candidates) {
    const ray = aimRayAtPoint(panel, candidate.point);
    if (ray && !hitTest(panel, ray)) return { ...candidate, ray };
  }
  return undefined;
}

export function installSpatialAimHook({ readRows, aim }) {
  if (typeof readRows !== 'function' || typeof aim !== 'function') {
    throw new TypeError('A spatial aim hook needs row and aim functions.');
  }
  const hook = Object.freeze({
    /** What this hook simulates, in one sentence, for any log that prints it. */
    simulates: 'controller pose, not a hand or a wearer',
    rows() {
      const source = readRows();
      return (Array.isArray(source) ? source : []).map(row => ({
        id: String(row?.id ?? ''), label: String(row?.label ?? ''), active: row?.state !== true,
      }));
    },
    at(id) { return aim({ id: String(id ?? '') }); },
    miss() { return aim({ between: true }); },
  });
  globalThis.__stereofoldAim = hook;
  return () => {
    if (globalThis.__stereofoldAim === hook) delete globalThis.__stereofoldAim;
  };
}
