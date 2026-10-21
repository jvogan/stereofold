import { createToolbarPanel, toolbarGlassPlates, toolbarPlatePoints, toolbarSeatBasis, toolbarStatusGlass } from './spatial-toolbar-geometry.mjs';
import { menuSeatWithinView, menuSeatInEyeViews } from './menu-view-band.mjs';
import { glassPlatesOverlap, seatEyeViews } from './glass-overlap.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { MAX_FRAME_TRANSLATION, GRIP_DEPTH_GAIN } from './xr-manipulate.mjs';

const multiply = (a, b) => Array.from({ length: 16 }, (_, index) => {
  const row = index % 4, column = Math.floor(index / 4);
  return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
});

// Whether a card draws its title line whole, as the readout gives it, with a
// caption line under it when the readout has one.
function holdsTitle(panel, readout = []) {
  const given = readout.filter(line => typeof line?.text === 'string' && line.text);
  const drawn = panel.readoutPoints ?? [];
  return !given.length || (drawn[0]?.text === given[0].text && drawn.length >= Math.min(2, given.length));
}

/** Complete, readable alternate glass. This proposes menu seats only. */
export function menuRelocationCandidates(options, head, { labelViews, renderFromRoom, cardOnly = false, shortCard = false } = {}) {
  const candidates = [];
  const withoutStatus = panel => {
    const plain = { ...panel, statusBacking: undefined, statusPoints: [], statusPoint: panel.buttons[0].point };
    return { panel: plain, points: toolbarPlatePoints(plain), glass: toolbarGlassPlates(plain) };
  };
  const admitted = seat => menuSeatWithinView(seat.points, seat.head)
    && !glassPlatesOverlap(seat.glass, seatEyeViews(seat.head))
    && menuSeatInEyeViews(seat.points, labelViews, renderFromRoom);
  if (options.stableLesson) {
    // The chapter frames around this complete glass. Do not buy clearance by
    // dropping status or folding controls to a tilted pill. Prefer the held
    // side; alternate seats retain the complete shape and prove every plate.
    // `shortCard` asks for the same seats with a card of the title and one
    // paged caption line. The clearance search keeps one only where every
    // full card covers the chapter under the status card, a name plate or
    // the controls.
    for (const below of [false, true]) for (const side of [options.constants.lessonSide ?? 1, -(options.constants.lessonSide ?? 1)]) for (const lift of [0, .2, -.2, .4, -.4, .6, -.6, .8, -.8]) {
      const constants = { ...options.constants, rightMeters: side * Math.abs(options.constants.rightMeters), lessonSide: side,
        faceViewer: false, peripheralSeat: false, chapterCardBelow: below,
        lowerMeters: options.constants.lowerMeters - lift, ...(shortCard ? { shortCard } : {}) };
      const panel = createToolbarPanel({ ...options, head, constants, seatAnchor: undefined });
      const seat = { id: `lesson-${below ? 'bottom' : 'top'}-${side}-${lift}${shortCard ? '-short' : ''}`, band: below ? 'bottom' : 'top', stableLesson: true, glance: true,
        points: toolbarPlatePoints(panel), glass: toolbarGlassPlates(panel), statusGlass: toolbarStatusGlass(panel),
        panel, anchor: panel.anchor, head, constants, ...(shortCard ? { shortCard } : {}) };
      if (admitted(seat)) candidates.push(seat);
    }
    return candidates;
  }
  const addSeat = seat => {
    const plain = seat.panel?.statusBacking ? withoutStatus(seat.panel) : undefined;
    const statusless = plain && admitted({ ...seat, ...plain }) ? plain : undefined;
    if (seat.panel?.statusPoints?.length === 1) seat = { ...seat, glance: true };
    // A compact control keeps its status beneath it. Its seats that cannot
    // show a line are not offered; the clearance search still has each
    // offered seat's `statusless` form for a status that covers the molecule.
    if (seat.compact && options.assistantLines?.length && !(seat.panel?.statusBacking && admitted(seat))) return;
    if (seat.panel && !seat.panel.statusBacking && options.assistantLines?.length) seat = { ...seat, statusAside: true };
    if (admitted(seat)) candidates.push({ ...seat, ...(statusless ? { statusless } : {}) });
    else if (statusless) candidates.push({ ...seat, ...statusless, statusGlass: [], statusAside: true });
  };
  // Centered card seats are tried before any beside seat. Keep the controls
  // in the candidate's clearance proof and in its committed draw.
  const statuses = [options.assistantLines, ...(options.assistantLines?.length > 1 && options.assistantGlance?.length
    ? [options.assistantGlance] : [])];
  if (cardOnly) for (const [glance, assistantLines] of statuses.entries()) for (const below of [false, true]) for (const side of [-1, 1]) {
    const constants = { ...options.constants, chapterCardBelow: below,
      rightMeters: side * Math.abs(options.constants.rightMeters) };
    const panel = createToolbarPanel({ ...options, assistantLines, head, constants, seatAnchor: undefined });
    const points = toolbarPlatePoints(panel);
    addSeat({ id: `card-${below ? 'bottom' : 'top'}-${side}${glance ? '-glance' : ''}`,
      points, glass: toolbarGlassPlates(panel), statusGlass: toolbarStatusGlass(panel), panel, anchor: panel.anchor, head, constants,
      ...(glance ? { glance: true } : {}), band: below ? 'bottom' : 'top' });
  }
  if (cardOnly) {
    const rows = options.rows.filter(row => row.action?.kind === 'collapse');
    // Fold to the Menu control while retaining a target that reopens all rows.
    // The assistant status plate folds with it and stays beneath the control.
    const compact = { ...options, rows: rows.length ? rows : options.rows.slice(0, 1) };
    // Where its three lines would cover the structure, the status card also
    // offers itself at one line (`glance`), after every seat at three.
    statuses.forEach((assistantLines, glance) => {
      for (const below of [false, true]) for (const controlRise of [-.76, -.5, 0, .5, .76]) for (const side of [-1, 1]) {
        const constants = { ...options.constants, chapterCardBelow: below,
          rightMeters: side * Math.abs(options.constants.rightMeters) };
        let panel = createToolbarPanel({ ...compact, assistantLines, head, constants, seatAnchor: undefined });
        const basis = toolbarSeatBasis(head);
        // Try vertical gaps for the compact control independently of the card.
        const depth = panel.anchor.reduce((sum, v, i) => sum + (v - basis.origin[i]) * basis.forward[i], 0);
        const rise = controlRise * depth;
        const dy = rise - (panel.buttons[0].point[1] - basis.origin[1]);
        const move = point => point.map((v, i) => v + dy * basis.up[i]);
        panel = { ...panel, buttons: panel.buttons.map(button => ({ ...button, point: move(button.point) })),
          backing: undefined, statusPoints: (panel.statusPoints ?? []).map(line => ({ ...line, point: move(line.point) })),
          statusBacking: panel.statusBacking ? { ...panel.statusBacking, point: move(panel.statusBacking.point) } : undefined,
          statusPoint: move(panel.statusPoint ?? panel.buttons[0].point) };
        const add = (candidate, meta) => addSeat({ id: `compact-${candidates.length}`, points: toolbarPlatePoints(candidate),
          glass: toolbarGlassPlates(candidate), statusGlass: toolbarStatusGlass(candidate), panel: candidate,
          anchor: candidate.anchor, head, constants, compact: true, ...(glance ? { glance: true } : {}), ...meta });
        add(panel, { band: below ? 'bottom' : 'top' });
        // A large subject leaves corner seats. Preserve the current text size
        // and page a narrower card, accepting every corner in both eyes. A
        // card is its title line (`Title · n/N`) over its caption: a side card
        // that cannot hold that line whole and one caption line under it is
        // no card, and is not offered.
        const sidePanel = createToolbarPanel({ ...compact, assistantLines, head,
          constants: { ...constants, chapterCardSide: true, peripheralSeat: false }, seatAnchor: undefined });
        if (sidePanel.captionBacking && holdsTitle(sidePanel, options.readout)) add({ ...panel, captionBacking: sidePanel.captionBacking,
          readoutPoints: sidePanel.readoutPoints, readoutFontMeters: sidePanel.readoutFontMeters,
          readoutWrapWidth: sidePanel.readoutWrapWidth, readoutLineBudget: sidePanel.readoutLineBudget,
          readoutPageCount: sidePanel.readoutPageCount, readoutPageIndex: sidePanel.readoutPageIndex, readoutPageCue: sidePanel.readoutPageCue }, { beside: true });
      }
    });
  }
  if (!cardOnly) for (const [glance, assistantLines] of statuses.entries()) for (const below of [false, true]) for (const side of [-1, 1]) for (const lift of [0, .15, -.15, .3, -.3]) {
    const constants = { ...options.constants, chapterCardBelow: below, peripheralSeat: false,
      rightMeters: side * Math.abs(options.constants.rightMeters),
      lowerMeters: options.constants.lowerMeters - lift };
    const panel = createToolbarPanel({ ...options, assistantLines, head, constants, seatAnchor: undefined });
    const points = toolbarPlatePoints(panel);
    addSeat({ id: candidates.length, points, glass: toolbarGlassPlates(panel), statusGlass: toolbarStatusGlass(panel), panel, anchor: panel.anchor, head, constants, ...(glance ? { glance: true } : {}), band: below ? 'bottom' : 'top' });
  }
  // If the current gaze is full of molecule, park to a side. The hypothetical
  // turned head is only a measurement frame; tracked head/camera never change.
  const roomFromRender = invertMatrix4(renderFromRoom);
  if (!cardOnly && roomFromRender && labelViews?.length) for (const yaw of [55]) for (const side of [-1, 1]) {
    const angle = side * yaw * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const matrix = [...head.matrix];
    for (const column of [0, 4, 8]) {
      matrix[column] = c * head.matrix[column] + s * head.matrix[column + 2];
      matrix[column + 2] = -s * head.matrix[column] + c * head.matrix[column + 2];
    }
    const turned = { ...head, matrix };
    const constants = { ...options.constants, peripheralSeat: false, rightMeters: -side * Math.abs(options.constants.rightMeters) };
    let panel = createToolbarPanel({ ...options, head: turned, constants, seatAnchor: undefined });
    if (!panel) continue;
    const points = toolbarPlatePoints(panel);
    if (!menuSeatWithinView(points, turned)) continue;
    const views = labelViews.map(view => {
      // Rotate the projection basis, never the tracked eye origins. This
      // proves clearance along the same stereo rays as the current gaze.
      const eye = [...matrix];
      const renderEye = invertMatrix4(view.transform.inverse.matrix).slice(12, 15);
      const roomEye = applyMatrix4(renderEye, roomFromRender);
      for (let axis = 0; axis < 3; axis++) eye[12 + axis] = roomEye[axis];
      return { eye: view.eye, projectionMatrix: Array.from(view.projectionMatrix),
        transform: { inverse: { matrix: multiply(invertMatrix4(eye), roomFromRender) } } };
    });
    candidates.push({ id: candidates.length, points, glass: toolbarGlassPlates(panel), anchor: panel.anchor, head: turned, constants, views, parked: true });
  }
  // No seat lays one plate over another in either eye: a compact control
  // beside a narrow card was drawn over it, with its status plate over both.
  return candidates.filter(admitted);
}

/** Ray-depth translation; parking outside the current gaze is intentional. */
export function menuDragOffset(anchor, startRay, ray, origin) {
  const unit = value => {
    const length = Math.hypot(...value);
    return length > 1e-8 && value.every(Number.isFinite) ? value.map(v => v / length) : undefined;
  };
  const initial = unit(startRay?.direction ?? []), direction = unit(ray?.direction ?? []);
  if (!initial || !direction || ![anchor, origin, startRay.origin, ray.origin].every(p => p?.length === 3 && p.every(Number.isFinite))) return undefined;
  const depth = anchor.reduce((sum, value, axis) => sum + (value - startRay.origin[axis]) * initial[axis], 0);
  // A controller may be close to a row or point at a deliberately distant
  // menu. The caller checks the glass's full clearance from the wearer's head;
  // controller-to-anchor distance must not make an otherwise valid drag inert.
  if (!(depth > 0)) return undefined;
  // An arm-model origin can move with a wrist turn. Only measured positions
  // supply hand travel; orientation remains useful with tracking disabled.
  const measured = startRay.emulatedPosition === false && ray.emulatedPosition === false;
  const offset = ray.origin.map((value, axis) => (measured ? value - startRay.origin[axis] : 0)
    + depth * (direction[axis] - initial[axis]));
  return offset.every(Number.isFinite) ? offset : undefined;
}

/** Continue a held menu from its last drawn offset after a pose discontinuity. */
export function menuDragStep(drag, ray, origin) {
  if (!ray || !origin) { drag.rebase = true; return undefined; }
  const previous = drag.lastRay ?? drag.ray;
  const snapshot = { ...ray, origin: [...ray.origin], direction: [...ray.direction] };
  drag.lastRay = snapshot;
  const jumped = previous.emulatedPosition === false && ray.emulatedPosition === false
    && Math.hypot(...ray.origin.map((value, axis) => value - previous.origin[axis])) > MAX_FRAME_TRANSLATION;
  if (drag.rebase || drag.ray.emulatedPosition !== ray.emulatedPosition || jumped) {
    drag.ray = snapshot;
    drag.baseOffset = [...drag.offset];
    drag.rebase = false;
    return [...drag.offset];
  }
  const base = drag.baseOffset ?? [0, 0, 0];
  const anchor = drag.anchor.map((value, axis) => value + base[axis]);
  const offset = menuDragOffset(anchor, drag.ray, ray, origin);
  return offset?.map((value, axis) => value + base[axis]);
}

/** Measured grip travel and wrist rotation carry the captured menu anchor.
 * Pulling toward the wearer changes apparent size by changing distance; it
 * does not silently resize text or turn arm-model motion into translation.
 * Rotate the anchor's lever arm, while keeping the menu's room plane fixed.
 */
export function menuGripDragStep(drag, grip, headOrigin) {
  if (!grip || !headOrigin || grip.emulatedPosition !== false) { drag.rebase = true; return undefined; }
  const snapshot = { origin: [...grip.origin], emulatedPosition: grip.emulatedPosition,
    ...(grip.rotation?.length === 9 && grip.rotation.every(Number.isFinite) ? { rotation: [...grip.rotation] } : {}) };
  const previous = drag.lastGrip ?? drag.grip;
  drag.lastGrip = snapshot;
  if (!previous || previous.emulatedPosition !== false || drag.rebase
      || Boolean(snapshot.rotation) !== Boolean(previous.rotation)
      || Math.hypot(...grip.origin.map((v, i) => v - previous.origin[i])) > MAX_FRAME_TRANSLATION) {
    drag.grip = snapshot; drag.baseOffset = [...drag.offset]; drag.rebase = false;
    return [...drag.offset];
  }
  const base = drag.baseOffset ?? [0, 0, 0];
  const delta = grip.origin.map((v, i) => v - drag.grip.origin[i]);
  // A peripheral menu must not project a sideways hand move onto its radial
  // depth axis: that made lateral travel weak and also moved it in depth.
  // Retain the established reach, consistently for sideways/up/down too.
  const translated = delta.map(value => value * GRIP_DEPTH_GAIN);
  const start = drag.grip.rotation, current = snapshot.rotation;
  let angular = [0, 0, 0];
  if (start && current) {
    const lever = drag.anchor.map((v, i) => v + base[i] - drag.grip.origin[i]);
    // Express the captured lever in grip coordinates, then carry it through
    // the current grip orientation. Position-only motion misses the sideways
    // arc of a natural forearm/wrist sweep, unlike the trigger's aimed drag.
    const local = [0, 1, 2].map(c => lever.reduce((sum, v, r) => sum + start[c * 3 + r] * v, 0));
    angular = lever.map((v, r) => current[r] * local[0] + current[3 + r] * local[1] + current[6 + r] * local[2] - v);
  }
  return translated.map((v, i) => base[i] + v + angular[i]);
}

/** Clamp a proposed translation to the first clearance contact along its travel. */
export function clampMenuDragOffset(previous, proposed, clearance, minimum) {
  if (clearance(proposed) >= minimum) return proposed;
  if (!(clearance(previous) >= minimum)) return undefined;
  let low = 0, high = 1;
  const at = fraction => previous.map((v, i) => v + (proposed[i] - v) * fraction);
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (clearance(at(mid)) >= minimum) low = mid; else high = mid;
  }
  return at(low);
}
