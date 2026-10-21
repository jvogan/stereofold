import { projectPlateQuad } from './component-label-measurement.mjs';
import { screenRectFromPoints, plateViewBasis } from './label-layout.mjs';
import { HALF_IPD_METERS } from './placement-fit-envelope.mjs';

/** The fraction of the card both eyes must contain before anything may call it
 * shown. Below it the card is partly, or wholly, off the wearer's glass and the
 * seat says so instead. */
export const REPLY_CARD_INSIDE_THRESHOLD = 0.999999;

const shiftPoints = (points, offset) => points.map(point => point.map((value, i) => value + offset[i]));

/** Move a card clear of the exact menu obstacle used by component plates.
 * All points are room metres; separation is measured on the wearer's glass.
 * Moving along screen right leaves depth unchanged, so every corner (including
 * a tilted card's nearer corners) clears the obstacle by the same angular gap.
 *
 * `withinView` is the caller's upright, binocular band test, applied here to
 * the final room corners rather than after the fact. `onSeat` receives one
 * verdict for the seat that is returned: `shown` only when both eyes contain
 * the whole card, `partial` with the visible fraction when they contain part of
 * it, `blocked` when neither does.
 *
 * A caller that supplies no `clearance.views` is told `unmeasured`, not
 * `shown`. Nothing on that path knows where the wearer's eyes are, so it holds
 * no evidence that either eye contains the card, and every reader that derives
 * a draw from the outcome reads `unmeasured` as not drawn.
 */
export function replyCardOffset({ points, menuPoints = [], eye, target, up = [0, 1, 0], gap = 0.025, clearance,
  onFallback = () => {}, withinView = () => true, onSeat = () => {} }) {
  if (clearance?.views?.length === 2) {
    const search = clearReplyOffset({ points, menuPoints, eye, target, up, gap, clearance, onFallback, withinView, onSeat });
    let step; do { step = search.next(); } while (!step.done);
    return step.value;
  }
  let offset = designFrameOffset({ points, menuPoints, eye, target, up, gap });
  // An earlier run’s band, applied where the seat is chosen: a menu-only offset must not
  // push a wide reply beyond the glass, and its original seat stays available.
  if (!withinView(shiftPoints(points, offset))) { offset = [0, 0, 0]; onFallback('design-seat'); }
  onSeat({ outcome: 'unmeasured', measured: false });
  return offset;
}

/** The identical ranked search, cooperatively paced outside the XR callback.
 * A superseded caption owns no result and publishes no visibility receipt. */
export async function replyCardOffsetAsync(options, { isCurrent = () => true,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
  now = () => performance.now(), budgetMs = 2 } = {}) {
  const { points, menuPoints = [], eye, target, up = [0, 1, 0], belowMenu, gap = .025, clearance: initialClearance,
    onFallback = () => {}, withinView = () => true, onSeat = () => {} } = options;
  options = { points, menuPoints, eye, target, up, gap, clearance: initialClearance, onFallback, withinView, onSeat };
  if (!isCurrent()) return undefined;
  if (options.clearance?.views?.length !== 2) return replyCardOffset(options);
  if (belowMenu) {
    const offset = belowMenuOffset(points, menuPoints, belowMenu, initialClearance, gap);
    const corners = shiftPoints(points, offset);
    const verdict = measureReplyCardClearance(corners, menuPoints, initialClearance, gap);
    onSeat(withinView(corners) ? verdict : { outcome: 'blocked', measured: true });
    return offset;
  }
  // XR eye matrices and caller-owned geometry arrays may change on the next
  // frame. One search must keep one measured scene throughout every yield.
  const copyPoints = points => points?.map(point => Array.from(point));
  const stableMenu = Object.assign(copyPoints(options.menuPoints ?? []),
    options.menuPoints?.plates ? { plates: options.menuPoints.plates.map(copyPoints) } : {});
  const clearance = options.clearance;
  const stable = { ...options, points: copyPoints(options.points), menuPoints: stableMenu,
    eye: Array.from(options.eye), target: Array.from(options.target), up: options.up && Array.from(options.up),
    clearance: { ...clearance, renderFromRoom: clearance.renderFromRoom && Array.from(clearance.renderFromRoom),
      views: clearance.views.map(view => ({ ...view, projectionMatrix: Array.from(view.projectionMatrix),
        transform: { ...view.transform, inverse: { matrix: Array.from(view.transform.inverse.matrix) } } })),
      measured: clearance.measured?.map(value => value && ({ ...value,
        rects: value.rects?.map(rect => ({ ...rect })), silhouette: value.silhouette && Array.from(value.silhouette) })) } };
  if (!stable.up) stable.up = [0, 1, 0];
  const search = clearReplyOffset({ gap: .025, onFallback: () => {}, withinView: () => true, onSeat: () => {}, ...stable });
  let began = now();
  for (;;) {
    if (!isCurrent()) { search.return(); return undefined; }
    const step = search.next();
    if (step.done) return step.value;
    if (now() - began >= budgetMs) {
      await yieldTask();
      if (!isCurrent()) { search.return(); return undefined; }
      began = now();
    }
  }
}

/** Room-metre corners in the render space the eye transforms are written in.
 * `renderFromRoom` is column-major; without one the two spaces are the same. */
function renderer(clearance) {
  const matrix = clearance?.renderFromRoom;
  return point => (matrix ? [0, 1, 2].map(i => matrix[i] * point[0] + matrix[i + 4] * point[1]
    + matrix[i + 8] * point[2] + matrix[i + 12]) : point);
}

/** Convert the tangent margin into a room-space drop beneath the menu.
 * Solve (y - d*upY)/(-z + d*upZ) <= menuBottom - gap for
 * every corner in each eye, including pitched eyes and render-space scaling. */
function belowMenuOffset(points, menuPoints, up, clearance, gap) {
  if (!menuPoints.length) return [0, 0, 0];
  const render = renderer(clearance);
  const transform = (m, p) => [0, 1, 2].map(i => m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12]);
  let distance = 0;
  for (const view of clearance.views) {
    const eye = p => transform(view.transform.inverse.matrix, render(p));
    const origin = eye([0, 0, 0]), axis = eye(up).map((v, i) => v - origin[i]);
    const edge = Math.min(...menuPoints.map(eye).map(p => p[1] / -p[2])) - gap;
    for (const p of points.map(eye)) {
      const slope = axis[1] + edge * axis[2];
      if (slope > 1e-9) distance = Math.max(distance, (p[1] + edge * p[2]) / slope);
    }
  }
  // A micron avoids a roundoff overlap at exact equality in either eye.
  return up.map(v => -v * (distance > 0 ? distance + 1e-6 : 0));
}

/**
 * What both eyes hold of a card that is already on the glass.
 *
 * `replyCardOffset` measures the seat it chooses against the eyes of the pose
 * it was handed. A card outlives that pose -- the head moves while the mesh is
 * built, and the same sentence can arrive again minutes later -- so the seat
 * has to be re-measured against the eyes that have to read it now before
 * anything says `shown` a second time.
 *
 * @param {number[][]} points the committed card's room-metre corners
 * @param {object} [clearance] the caller's current `views` and `renderFromRoom`
 * @returns {{outcome: string, inside: number, measured: true}|undefined}
 *   `undefined` when the caller has no eye transforms to measure against
 */
export function measureReplyCard(points, clearance) {
  if (clearance?.views?.length !== 2 || !points?.length) return undefined;
  const corners = points.map(renderer(clearance));
  const inside = Math.min(...clearance.views.map(view => projectPlateQuad(corners, view).inside));
  if (!Number.isFinite(inside)) return undefined;
  return { measured: true, inside: Math.round(inside * 1e4) / 1e4,
    outcome: inside > REPLY_CARD_INSIDE_THRESHOLD ? 'shown' : inside > 0 ? 'partial' : 'blocked' };
}

/** Slide past the menu in both design eyes. These assumed offsets keep the
 * fallback binocular; they cannot prove visibility without tracked views. */
function designFrameOffset({ points, menuPoints, eye, target, up, gap }) {
  const menu = screenRectFromPoints({ points: menuPoints, eye, target, up });
  if (!menu || !points?.length) return [0, 0, 0];
  const basis = plateViewBasis({ eye, target, up });
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  // Move inboard: a left menu yields space to its right, and vice versa.
  const right = menu.x <= 0;
  const eyes = [];
  let overlaps = false;
  for (const side of [-1, 1]) {
    const eyeOffset = basis.right.map(value => side * HALF_IPD_METERS * value);
    const designEye = eye.map((value, i) => value + eyeOffset[i]);
    const designTarget = target.map((value, i) => value + eyeOffset[i]);
    const obstacle = screenRectFromPoints({ points: menuPoints, eye: designEye, target: designTarget, up });
    const card = screenRectFromPoints({ points, eye: designEye, target: designTarget, up });
    if (!obstacle || !card || Math.abs(card.y - obstacle.y) >= card.halfHeight + obstacle.halfHeight + gap) continue;
    overlaps ||= Math.abs(card.x - obstacle.x) < card.halfWidth + obstacle.halfWidth + gap;
    eyes.push({ designEye, obstacle });
  }
  if (!overlaps) return [0, 0, 0];
  const offsets = [];
  for (const { designEye, obstacle } of eyes) {
    const edge = obstacle.x + (right ? 1 : -1) * (obstacle.halfWidth + gap);
    for (const point of points) {
      const corner = point.map((value, i) => value - designEye[i]);
      offsets.push(edge * dot(corner, basis.forward) - dot(corner, basis.right));
    }
  }
  const distance = right ? Math.max(...offsets) : Math.min(...offsets);
  return basis.right.map(value => value * distance);
}

function replyObstacles(clearance, menuPoints, render) {
  return clearance.views.map((view, i) => {
    const measured = clearance.measured?.[i];
    const rects = [...(measured?.rects ?? [])];
    if (measured?.silhouette) {
      const [x, y, hw, hh] = measured.silhouette;
      rects.push({ x, y, hw, hh });
    }
    const m = view.transform.inverse.matrix;
    // Menu points that carry their drawn plates (`points.plates`) are cleared
    // plate by plate. One rectangle around a compact control, its status and
    // the label space reserved above it spans the glass from top to bottom.
    const menus = (menuPoints.plates?.length ? menuPoints.plates : [menuPoints]).map(points => {
      const menu = screenRectFromPoints({ points: points.map(render).map(p => [0, 1, 2].map(i =>
        m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12])),
        eye: [0, 0, 0], target: [0, 0, -1] });
      return menu && { x: menu.x, y: menu.y, hw: menu.halfWidth, hh: menu.halfHeight };
    }).filter(Boolean);
    return { rects, menus };
  });
}
const clearsRect = (rect, obstacle, gap) => !obstacle || Math.abs(rect.x - obstacle.x) >= rect.hw + obstacle.hw + gap
  || Math.abs(rect.y - obstacle.y) >= rect.hh + obstacle.hh + gap;

/** Revalidate the committed seat without searching for a different one.
 * The grid always tries zero offset first; if it fails, that old mesh cannot
 * be mounted. Both eyes and every scientific/menu obstacle still participate. */
export function measureReplyCardClearance(points, menuPoints, clearance, gap = .025) {
  if (clearance?.views?.length !== 2 || !points?.length) return { outcome: 'unmeasured', measured: false };
  const render = renderer(clearance), obstacles = replyObstacles(clearance, menuPoints, render);
  const projected = clearance.views.map(view => projectPlateQuad(points.map(render), view));
  const inside = Math.min(...projected.map(view => view.inside));
  const clear = projected.every(({ rect }, i) => rect && obstacles[i].menus.every(menu => clearsRect(rect, menu, gap))
    && obstacles[i].rects.every(obstacle => clearsRect(rect, obstacle, gap)));
  return { measured: true, inside: Math.round(inside * 1e4) / 1e4,
    outcome: inside > REPLY_CARD_INSIDE_THRESHOLD && clear ? 'shown' : 'blocked' };
}

/** Search only on a card/scene change, with the committed rectangles in BOTH
 * eyes. The near candidates preserve the head seat depth; every candidate
 * preserves the font size. Each is projected exactly, including tilted corners.
 * A reply owns its reading window: prefer clearing every obstacle, then clear
 * a farther readable seat if the near band is full. An entirely occupied
 * glass returns an obstructed verdict so the caller can keep the card down.
 *
 * The design seat is itself one of the candidates that has just failed,
 * and the band test that followed it is levelled, so a pitched head could be
 * handed a seat neither eye contains and told the card was shown. Every seat
 * returned here is measured in both eyes, and the verdict reported is that
 * measurement rather than the rank the seat was chosen at.
 */
function* clearReplyOffset({ points, menuPoints, eye, target, up, gap, clearance, onFallback, withinView, onSeat }) {
  const basis = plateViewBasis({ eye, target, up });
  const render = renderer(clearance);
  const obstacles = replyObstacles(clearance, menuPoints, render);
  const center = points[0].map((_, i) => points.reduce((n, p) => n + p[i], 0) / points.length);
  const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
  const relative = center.map((v, i) => v - eye[i]);
  const depth = dot(relative, basis.forward);
  const candidates = [];
  // A bounded centimetre grid, ranked by travel from the familiar lower seat.
  // The card remains within a 35-degree glance and 25 degrees sideways.
  for (let y = -50; y <= 50; y++) for (let x = -20; x <= 20; x++) {
    const dx = x * .02, dy = y * .02;
    if (Math.abs(dot(relative, basis.right) + dx) > depth * Math.tan(25 * Math.PI / 180)
      || Math.abs(dot(relative, basis.up) + dy) > depth * Math.tan(35 * Math.PI / 180)) continue;
    candidates.push({ dx, dy, cost: dx * dx + dy * dy });
  }
  candidates.sort((a, b) => a.cost - b.cost);
  const clears = (rect, obstacle) => clearsRect(rect, obstacle, gap);
  // What one candidate seat is worth in the eyes that have to read it. The
  // structure test stays lazy: only a whole, menu-clear seat is ever asked.
  const measure = offset => {
    const corners = shiftPoints(points, offset).map(render);
    const projected = clearance.views.map(view => projectPlateQuad(corners, view));
    return { offset,
      inside: Math.min(...projected.map(view => view.inside)),
      menuClear: projected.every(({ rect }, i) => Boolean(rect) && obstacles[i].menus.every(menu => clears(rect, menu))),
      structureClear: () => projected.every(({ rect }, i) => Boolean(rect) && obstacles[i].rects.every(o => clears(rect, o))) };
  };
  const whole = seat => seat.inside > REPLY_CARD_INSIDE_THRESHOLD;
  let designSeat;
  const design = () => (designSeat ??= measure([0, 0, 0]));
  // The most readable seat the grid holds, for the case where no candidate is
  // both whole and clear of the menu.
  const better = (seat, best) => !best || (seat.menuClear !== best.menuClear ? seat.menuClear : seat.inside > best.inside);
  let best, chosen, fallback, measuredCandidates = 0;
  for (const { dx, dy } of candidates) {
    if (++measuredCandidates % 32 === 0) yield;
    const seat = measure(basis.right.map((v, i) => v * dx + basis.up[i] * dy));
    if (better(seat, best)) best = seat;
    // Only an entirely visible, menu-clear candidate can be selected. Testing
    // its molecular obstacles earlier cannot rescue an ineligible seat and
    // repeats that work when it is eligible. `best` alone owns blocked output.
    if (!(whole(seat) && seat.menuClear)) continue;
    if (seat.structureClear()) { chosen = seat; break; }
  }
  if (!chosen) {
    // Move the reading window outward only after the familiar depth has no
    // clear seat. Its font remains at the same physical size and the furthest
    // seat is still close enough to read without a long head sweep.
    const farCandidates = [];
    for (let y = -30; y <= 30; y++) for (let x = -30; x <= 30; x++) {
      const dx = x * .04, dy = y * .04;
      farCandidates.push({ dx, dy, cost: dx * dx + dy * dy });
    }
    farCandidates.sort((a, b) => a.cost - b.cost);
    for (const dz of [.15, .3, .45, .6]) {
      for (const { dx, dy } of farCandidates) {
        if (Math.abs(dot(relative, basis.right) + dx) > (depth + dz) * Math.tan(35 * Math.PI / 180)
          || Math.abs(dot(relative, basis.up) + dy) > (depth + dz) * Math.tan(40 * Math.PI / 180)) continue;
        if (++measuredCandidates % 32 === 0) yield;
        const seat = measure(basis.right.map((v, i) => v * dx + basis.up[i] * dy + basis.forward[i] * dz));
        if (whole(seat) && seat.menuClear && seat.structureClear()) {
          chosen = seat; fallback = 'farther-seat'; break;
        }
      }
      if (chosen) break;
    }
  }
  if (!chosen) {
    // No seat can clear the drawn structure and menu. Report the obstruction;
    // a partly visible or overprinted plate must not be called readable.
    chosen = best ?? design(); fallback = 'no-clear-seat';
    onFallback(fallback);
    onSeat({ measured: true, inside: Math.round(chosen.inside * 1e4) / 1e4,
      outcome: 'blocked', obstructed: true });
    return chosen.offset;
  }
  // The levelled band still keeps a wide reply from being slid off the glass,
  // but it may never trade a seat both eyes contain for one they do not.
  if (!withinView(shiftPoints(points, chosen.offset)) && design().inside >= chosen.inside
    && whole(design()) && design().menuClear && design().structureClear()) {
    chosen = design(); fallback = 'design-seat';
  }
  if (fallback) onFallback(fallback);
  onSeat({ measured: true, inside: Math.round(chosen.inside * 1e4) / 1e4,
    outcome: whole(chosen) ? 'shown' : chosen.inside > 0 ? 'partial' : 'blocked' });
  return chosen.offset;
}
