import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PLATE_CLEARANCE_LENS, SUBJECT_CENTRE_LENS, SUBJECT_GHOST_LENS_CEILING, SUBJECT_GHOST_LENS_LIMIT,
  SUBJECT_LENS_CEILING, SUBJECT_LENS_FLOOR, SUBJECT_SHIFT_LIMIT, SUBJECT_WHOLE_LENS_CEILING, ghostButtonAvoidance,
  lensRect, lensRectFromPoints, lensRectsOverlap, menuAvoidance, plateAvoidance, subjectCapShrink, viewBasis,
} from './plate-standoff.mjs';
import { SPATIAL_TOOLBAR_LAYOUT, createToolbarPanel, toolbarCaptionPoints, toolbarDrawnMenuPoints, toolbarMenuRowPoints,
  toolbarPlatePoints } from './spatial-toolbar-geometry.mjs';
import { focusPlacement } from './focus-placement.mjs';

/**
 * A bad growth seat, in the geometry that caused it.
 *
 * Chain 8 of the microtubule growth lesson passed every gate it had and still
 * gave the wearer the wrong picture: a correctly sized protofilament — 0.485 of
 * the lens, which is the product's half-a-lens rule — seated with its centre in
 * the RIGHT half of the view and its right edge parked on 0.98, against the
 * vignette, while the middle of the lens stood empty.
 *
 * The dodge was not broken. It was told to avoid a rectangle that spanned
 * x −0.87..−0.10 and y −0.64..0.84 — the caption card AND the menu column under
 * it, unioned — and it took the cheapest way out of that, which is right. Two
 * things are wrong with that instruction and both are fixed here: the rectangle
 * is the caption alone, and a sideways move is the last resort rather than the
 * first. Nothing below needs Mol*, and every rectangle is read off the real
 * panel rather than typed in.
 */

/** A wearer standing at the room origin, eyes level, looking down −z. */
const EYE = [0, 1.6, 0];
const AHEAD = viewBasis([0, 0, -1]);
const HEAD = { transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1],
  position: { x: 0, y: 1.6, z: 0 } } };

/** Historical forward-seat growth panel: retained to reproduce measured overlap. */
function lessonPanel() {
  return createToolbarPanel({ head: HEAD, constants: { ...SPATIAL_TOOLBAR_LAYOUT, peripheralSeat: false },
    rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Next' }, { label: 'Back' }, { label: 'Menu' },
      { label: 'Open in Mol*' }],
    readout: [{ text: 'Two dimers' }, { text: 'Pro 1 / 5' }, { text: 'A second dimer stacks on top.' }],
    status: 'Listening…' });
}
const lensRectOf = points => lensRectFromPoints({ points, origin: EYE, basis: AHEAD });

/**
 * The protofilament chapter's own subject, as the solver had it.
 *
 * The ring records the rectangle AFTER the dodge shrank it (`subject` left
 * −0.069, right 0.98, bottom −0.487, top 0.487) together with the shrink,
 * 0.809, and `fitted` 0.648 which is the half width before it. The half height
 * comes back the same way: 0.487 / 0.809.
 */
const PROTOFILAMENT = { x: 0, y: 0, halfWidth: 0.648, halfHeight: 0.487 / 0.809 };
/** The whole-structure chapter: the old seventy per cent, spread by its seat. */
const WALL = { x: 0, y: 0, halfWidth: 0.757, halfHeight: 0.604 };
/**
 * The Quest 2 wearer-view numbers, as fractions of one lens.
 *
 * Eye line at 47.9 per cent of lens height, larger capture-y is lower, so a
 * vertical centre of 59.5 per cent is 0.232 lens units below the eye line in
 * the solver's y-up frame. The lit part sat at 41 per cent of the lens width
 * and 55 per cent wide; the ghost around it was 85 per cent wide.
 */
const MEASURED_WALL = { x: 0, y: (0.479 - 0.595) * 2, halfWidth: 0.89, halfHeight: 0.71 };
const MEASURED_PART_LIT = { x: (0.41 - 0.5) * 2, y: (0.479 - 0.55) * 2, halfWidth: 0.55, halfHeight: 0.42 };
const MEASURED_PART_GHOST = { x: MEASURED_PART_LIT.x, y: MEASURED_PART_LIT.y, halfWidth: 0.85, halfHeight: 0.62 };
const floorFor = subject => Math.min(1, SUBJECT_LENS_FLOOR / subject.halfWidth);

/** Caption seat, then the ghost-included menu pass, then the ghost off the buttons, matching focus-placement. */
function seatAgainstPanel(lit, ghost = lit, { x = 0, y = 0, ghostPoints = [] } = {}) {
  const panel = lessonPanel();
  const caption = lensRectOf(toolbarCaptionPoints(panel));
  const menu = lensRectOf(toolbarDrawnMenuPoints(panel));
  const rows = toolbarMenuRowPoints(panel).map(lensRectOf).filter(Boolean);
  const wholeRatio = ghost.halfWidth / lit.halfWidth;
  const riseRatio = ghost.halfHeight / lit.halfHeight;
  // The precedence lives in `subjectCapShrink` — the lit floor
  // wins over the ghost ceiling, and the ghost runs to SUBJECT_GHOST_LENS_LIMIT
  // before the lit part shrinks below its floor. A chapter that IS the
  // structure (ghost and lit the same width) draws the whole-structure ceiling.
  const cap = subjectCapShrink({ litHalfWidth: lit.halfWidth, wholeHalfWidth: ghost.halfWidth,
    litCeiling: Math.abs(wholeRatio - 1) < 1e-9 ? SUBJECT_WHOLE_LENS_CEILING : SUBJECT_LENS_CEILING });
  const sized = { x, y, halfWidth: lit.halfWidth * cap, halfHeight: lit.halfHeight * cap };
  const dodge = plateAvoidance({ subject: sized, plate: caption, shrinkFloor: floorFor(sized) });
  const ghostSeated = { x: dodge.x, y: dodge.y,
    halfWidth: dodge.rect.halfWidth * wholeRatio, halfHeight: dodge.rect.halfHeight * riseRatio };
  const cleared = menuAvoidance({ subject: ghostSeated, menu, caption,
    shrinkFloor: Math.min(1, (SUBJECT_LENS_FLOOR * wholeRatio) / ghostSeated.halfWidth) });
  const ghosted = ghostButtonAvoidance({ ghost: { x: cleared.x, y: cleared.y,
      halfWidth: cleared.rect.halfWidth, halfHeight: cleared.rect.halfHeight },
    ghostPoints, buttons: rows, menu, caption,
    litHalfWidth: cleared.rect.halfWidth / wholeRatio, litHalfHeight: cleared.rect.halfHeight / riseRatio,
    shrinkFloor: Math.min(1, (SUBJECT_LENS_FLOOR * wholeRatio) / cleared.rect.halfWidth) });
  return { cap, caption, menu, rows, dodge, cleared, ghosted, share: { whole: ghosted.rect.halfWidth,
    lit: ghosted.rect.halfWidth / wholeRatio } };
}

test('the caption card is a narrower, higher rectangle than the whole panel', () => {
  const panel = lessonPanel();
  const whole = lensRectOf(toolbarPlatePoints(panel));
  const caption = lensRectOf(toolbarCaptionPoints(panel));
  assert.ok(caption, 'a panel with a readout draws a caption card');
  // The two cards stack: the caption owns the top of the left column and the
  // menu the bottom, which is why the union could never be sat beside.
  assert.ok(caption.bottom > 0.2, `the caption's floor is at ${caption.bottom.toFixed(3)} of the lens`);
  assert.ok(caption.bottom - whole.bottom > 0.5,
    'the caption card starts well above the bottom of the menu column');
  assert.ok(caption.top <= whole.top + 1e-9 && caption.left >= whole.left - 1e-9,
    'and it is inside the panel it is part of');
  // A panel with nothing to say draws no caption, so there is nothing to dodge.
  assert.deepEqual(toolbarCaptionPoints(createToolbarPanel({ head: HEAD, rows: [{ label: 'Talk' }] })), []);
  assert.deepEqual(toolbarCaptionPoints(undefined), []);
});

test('a subject over the top-left caption is lowered, never shifted right', () => {
  const caption = lensRectOf(toolbarCaptionPoints(lessonPanel()));
  assert.ok(lensRectsOverlap(lensRect(PROTOFILAMENT), caption, PLATE_CLEARANCE_LENS),
    'the case only exists because the subject and the caption share the lens');
  const moved = plateAvoidance({ subject: PROTOFILAMENT, plate: caption,
    shrinkFloor: floorFor(PROTOFILAMENT) });
  assert.equal(moved.axis, 'down', `the dodge went ${moved.axis}`);
  assert.ok(moved.move === 'lower' || moved.move === 'shrink+lower', `the winning move was ${moved.move}`);
  assert.equal(moved.x, PROTOFILAMENT.x, 'it did not move sideways at all');
  assert.equal(moved.overlap, false, 'and it cleared the caption');
  assert.ok(moved.rect.top <= caption.bottom - PLATE_CLEARANCE_LENS + 1e-9,
    'its top sits under the caption plus the clearance');
  assert.ok(moved.rect.bottom >= -0.98 - 1e-9, 'its bottom stayed inside the lens margin');
  assert.ok(moved.rect.halfWidth >= SUBJECT_LENS_FLOOR - 1e-9,
    `the subject was left at ${moved.rect.halfWidth.toFixed(3)} of the lens`);
});

test('the subject comes out centred, which is the rule the hardware run broke', () => {
  const caption = lensRectOf(toolbarCaptionPoints(lessonPanel()));
  const moved = plateAvoidance({ subject: PROTOFILAMENT, plate: caption,
    shrinkFloor: floorFor(PROTOFILAMENT) });
  assert.equal(moved.centred, true);
  assert.ok(Math.abs(moved.rect.x) <= SUBJECT_CENTRE_LENS,
    `the subject's centre landed at ${moved.rect.x.toFixed(3)} of the lens`);
  // And it is bigger than the hardware run's 0.485, because the size it gave up
  // to get out of the corner bought nothing.
  assert.ok(moved.rect.halfWidth > 0.485,
    `the seat left the subject at ${moved.rect.halfWidth.toFixed(3)} of the lens`);
});

test('the menu column is ignored: seating against the union is what shoved it right', () => {
  const panel = lessonPanel();
  // Compare only the menu/caption column; replies now occupy separate glass.
  const union = lensRectOf(toolbarPlatePoints({ ...panel,
    statusPoints: [], statusPoint: undefined, statusBacking: undefined }));
  const caption = lensRectOf(toolbarCaptionPoints(panel));
  const floor = floorFor(PROTOFILAMENT);
  const against = plate => plateAvoidance({ subject: PROTOFILAMENT, plate, shrinkFloor: floor });
  // The union leaves no centred seat at all: the only way out of a rectangle
  // that tall is sideways, and sideways is now bounded rather than free.
  const shoved = against(union);
  assert.ok(shoved.x > SUBJECT_CENTRE_LENS, 'the union still forces the subject off centre');
  assert.equal(shoved.centred, false);
  // The caption alone does leave one, and that is the whole fix.
  assert.equal(against(caption).centred, true);
});

test('no subject edge passes the shift limit, whatever the dodge has to do', () => {
  // A caption tall enough that no lowering fits, so the rule runs out of
  // vertical room and reaches for the shift it would rather not take.
  const plate = { left: -1, right: -0.1, bottom: -0.9, top: 1 };
  const subject = { x: 0, y: 0, halfWidth: 0.5, halfHeight: 0.5 };
  const moved = plateAvoidance({ subject, plate, shrinkFloor: floorFor(subject) });
  assert.ok(moved.move === 'shift' || moved.move === 'held', `the winning move was ${moved.move}`);
  assert.ok(moved.rect.right <= SUBJECT_SHIFT_LIMIT + 1e-9 && moved.rect.left >= -SUBJECT_SHIFT_LIMIT - 1e-9,
    `the subject ran to ${moved.rect.left.toFixed(3)}..${moved.rect.right.toFixed(3)} of the lens`);
  // The seat this limit exists to refuse: right edge 0.98.
  assert.ok(moved.rect.right < 0.98);
  // Even a case with no legal seat at all is held inside the limit rather than
  // pushed out of the frame; `overlap` says the plates are on render order now.
  const trapped = plateAvoidance({ subject: { x: 0, y: 0, halfWidth: 0.8, halfHeight: 0.8 },
    plate: { left: -1, right: 1, bottom: -1, top: 1 }, shrinkFloor: 0.9 });
  assert.equal(trapped.move, 'held');
  assert.ok(trapped.rect.right <= SUBJECT_SHIFT_LIMIT + 1e-9 && trapped.rect.left >= -SUBJECT_SHIFT_LIMIT - 1e-9);
  assert.equal(trapped.overlap, true);
});

test('the whole-structure chapter still gets its ghost-included cap when it fits', () => {
  const caption = lensRectOf(toolbarCaptionPoints(lessonPanel()));
  const sized = { ...WALL, halfWidth: SUBJECT_WHOLE_LENS_CEILING,
    halfHeight: WALL.halfHeight * (SUBJECT_WHOLE_LENS_CEILING / WALL.halfWidth) };
  const moved = plateAvoidance({ subject: sized, plate: caption, shrinkFloor: floorFor(sized) });
  assert.equal(moved.shrink, 1, 'the seat cost the capped whole-structure framing nothing extra');
  assert.equal(moved.move, 'lower');
  assert.equal(moved.centred, true);
  assert.equal(moved.overlap, false);
  assert.ok(moved.rect.halfWidth >= SUBJECT_WHOLE_LENS_CEILING - 1e-9,
    `the subject kept ${moved.rect.halfWidth.toFixed(3)} of the lens`);
  assert.ok(moved.rect.bottom >= -0.98 - 1e-9 && moved.rect.top <= 0.98 + 1e-9);
});

test('a subject that clears the caption is left exactly where the framing put it', () => {
  const caption = lensRectOf(toolbarCaptionPoints(lessonPanel()));
  const subject = { x: 0, y: -0.5, halfWidth: 0.4, halfHeight: 0.3 };
  const still = plateAvoidance({ subject, plate: caption });
  assert.equal(still.move, 'none');
  assert.equal(still.axis, 'none');
  assert.equal(still.shrink, 1);
  assert.equal(still.x, subject.x);
  assert.equal(still.y, subject.y);
  assert.equal(still.centred, true);
});

test('the menu column is the four button rows, with no caption glass', () => {
  const panel = createToolbarPanel({ head: HEAD,
    rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Next' }, { label: 'Menu' }],
    readout: [{ text: 'A wall' }, { text: '1 / 5' }, { text: 'Three protofilaments wide.' }] });
  const menu = lensRectOf(toolbarDrawnMenuPoints(panel));
  const caption = lensRectOf(toolbarCaptionPoints(panel));
  const whole = lensRectOf(toolbarPlatePoints(panel));
  assert.ok(menu, 'a panel with buttons draws a menu column');
  assert.ok(menu.top <= caption.bottom + 1e-6, 'the menu sits under the caption card');
  assert.ok(menu.bottom >= whole.bottom - 1e-6 && menu.left >= whole.left - 1e-6);
  assert.deepEqual(toolbarDrawnMenuPoints({ buttons: [] }), []);
  assert.deepEqual(toolbarDrawnMenuPoints(undefined), []);
});

test('a measured whole wall at 89 per cent is capped and kept off the menu', () => {
  // Chapters 1 and 5: subject 89 per cent wide, centred, vertical centre 59.5
  // per cent of lens height. The left ribbons covered the menu column.
  // The old expectation was the 0.60 ghost ceiling on the
  // whole, then a menu column the pass had to shrink its way out of. Both are
  // retired: the whole-structure cap is the drawn SUBJECT_WHOLE_LENS_CEILING
  // 0.55 (the 0.60 was granted on the on-axis width and the off-axis spread
  // spent the difference — 61.8 measured), and a wall this wide crosses the
  // dimmed menu column at full size (`held`), because a shrink that cannot
  // clear the column only buys a smaller subject in the same crowded corner.
  // What must hold instead: the caption plate's clearance, the centre band,
  // and the strand kept off the buttons by the ghost pass.
  assert.ok(MEASURED_WALL.halfWidth > SUBJECT_GHOST_LENS_CEILING);
  const seated = seatAgainstPanel(MEASURED_WALL);
  assert.ok(seated.share.whole <= SUBJECT_WHOLE_LENS_CEILING + 1e-6,
    `the projected whole width landed at ${seated.share.whole.toFixed(3)}`);
  assert.ok(seated.share.lit >= SUBJECT_LENS_FLOOR - 1e-6);
  assert.ok(Math.abs(seated.cleared.x) <= SUBJECT_CENTRE_LENS + 1e-9,
    `the centre sat at ${seated.cleared.x.toFixed(3)}`);
  assert.equal(seated.cleared.centred, true);
  // The menu itself did not move; the wall is held where the raise and the
  // shift left it, and says so.
  assert.equal(seated.cleared.move, 'held');
  // The column crossing is recorded and tolerated; the caption plate's
  // clearance is what holds, which is the edge the 61.8 draw touched.
  assert.equal(seated.ghosted.crossed, true);
  assert.equal(seated.ghosted.cleared, true);
  assert.equal(lensRectsOverlap(seated.ghosted.rect, seated.caption, PLATE_CLEARANCE_LENS), false);
});

test('a measured lit part at 41 per cent centre is capped and kept off Talk and Play', () => {
  // Chapters 2-4: lit part 55 per cent wide at 41 per cent centre; ghost 85
  // per cent. The lit strand's left tip pierced Talk and Play.
  // The old expectation shrank the lit part to the 0.40 floor
  // so the ghost fit the 0.60 ceiling, then demanded the menu column be
  // cleared. Retired for the measured ones: the lit floor wins (the part
  // holds 0.485 here), the ghost may run to SUBJECT_GHOST_LENS_LIMIT 0.75,
  // and the column may be crossed at full size — the buttons are what the
  // ghost pass protects, and the lit rect is what must stay off the caption.
  assert.ok(MEASURED_PART_LIT.x < -0.1);
  assert.ok(lensRectsOverlap(lensRect(MEASURED_PART_LIT),
    lensRectOf(toolbarDrawnMenuPoints(lessonPanel())), PLATE_CLEARANCE_LENS));
  const seated = seatAgainstPanel(MEASURED_PART_LIT, MEASURED_PART_GHOST,
    { x: MEASURED_PART_LIT.x, y: MEASURED_PART_LIT.y });
  assert.ok(seated.share.whole <= SUBJECT_GHOST_LENS_LIMIT + 1e-6,
    `whole ${seated.share.whole.toFixed(3)} lit ${seated.share.lit.toFixed(3)}`);
  // The precedence: the ghost outgrew its old ceiling only because the lit
  // floor won — the pairing is the assertion, not either number alone.
  assert.ok(seated.share.whole > SUBJECT_GHOST_LENS_CEILING + 1e-6);
  assert.ok(seated.share.lit >= SUBJECT_LENS_FLOOR - 1e-6);
  assert.ok(seated.share.lit <= SUBJECT_LENS_CEILING + 1e-6);
  assert.ok(Math.abs(seated.cleared.x) <= SUBJECT_CENTRE_LENS + 1e-9);
  assert.equal(seated.cleared.centred, true);
  // The lit rect stays clear of the caption plate; the ghost may cross it.
  const litRect = lensRect({ x: seated.ghosted.x, y: seated.ghosted.y,
    halfWidth: seated.ghosted.rect.halfWidth / (MEASURED_PART_GHOST.halfWidth / MEASURED_PART_LIT.halfWidth),
    halfHeight: seated.ghosted.rect.halfHeight / (MEASURED_PART_GHOST.halfHeight / MEASURED_PART_LIT.halfHeight) });
  assert.equal(lensRectsOverlap(litRect, seated.caption, PLATE_CLEARANCE_LENS), false);
  // The strand record: crossing recorded; with no measured strand points the
  // button check is clear by construction.
  assert.equal(seated.ghosted.crossed, true);
  assert.equal(seated.ghosted.cleared, true);
});

test('a measured whole wall at 61.8 per cent is capped to about 55 with the plate clearance held', () => {
  // The Quest 2 captures, chapters 1 and 5: whole width 61.8 per
  // cent of the lens, centre x 53.7, vertical centre 51 (eye line 47.9). The
  // top-left alpha helix crossed the menu column's x range with no button
  // overlap, and touched the caption plate's bottom edge. The 0.60 cap was
  // granted on the on-axis width and the off-axis spread spent the
  // difference, so the whole-structure cap is the drawn 0.55 and the plate
  // clearance is asserted, not assumed.
  const WALL618 = { x: (0.537 - 0.5) * 2, y: (0.479 - 0.51) * 2, halfWidth: 0.618, halfHeight: 0.49 };
  assert.ok(WALL618.halfWidth > SUBJECT_WHOLE_LENS_CEILING);
  const seated = seatAgainstPanel(WALL618, WALL618, { x: WALL618.x, y: WALL618.y });
  assert.ok(seated.share.whole <= SUBJECT_WHOLE_LENS_CEILING + 1e-6,
    `the projected whole width landed at ${seated.share.whole.toFixed(3)}`);
  assert.ok(seated.share.lit >= SUBJECT_LENS_FLOOR - 1e-6);
  assert.ok(Math.abs(seated.ghosted.x) <= SUBJECT_CENTRE_LENS + 1e-9);
  // The measured crossings: the column, yes; the buttons and the plate, no.
  assert.equal(seated.ghosted.crossed, true);
  assert.equal(seated.ghosted.cleared, true);
  assert.equal(lensRectsOverlap(seated.ghosted.rect, seated.caption, PLATE_CLEARANCE_LENS), false);
});

test('a measured lit part at 29.7 per cent inside a 62.8 per cent ghost is drawn as framed', () => {
  // Chapter 2, one lit protofilament: lit width 29.7 per cent (floor 40),
  // whole with ghost 62.8. The context framing's own ask is what drew the lit
  // part under the floor, and no cap here grows it — but the ghost ceiling no
  // longer shrinks it either: 0.628 sits inside the 0.75 limit, so the seat
  // the framing solved is the seat that draws, at the measured numbers.
  const CH2_LIT = { x: (0.41 - 0.5) * 2, y: (0.479 - 0.55) * 2, halfWidth: 0.297, halfHeight: 0.25 };
  const CH2_GHOST = { x: CH2_LIT.x, y: CH2_LIT.y, halfWidth: 0.628, halfHeight: 0.35 };
  const seated = seatAgainstPanel(CH2_LIT, CH2_GHOST, { x: CH2_LIT.x, y: CH2_LIT.y });
  assert.equal(seated.cap, 1);
  assert.ok(Math.abs(seated.share.whole - 0.628) < 1e-3,
    `whole drew at ${seated.share.whole.toFixed(3)}`);
  assert.ok(Math.abs(seated.share.lit - 0.297) < 1e-3,
    `lit drew at ${seated.share.lit.toFixed(3)}`);
  // The old 0.60 ceiling would have refused; the limit is what lets the
  // measured numbers stand.
  assert.ok(seated.share.whole > SUBJECT_GHOST_LENS_CEILING - 1e-6);
  assert.ok(seated.share.whole <= SUBJECT_GHOST_LENS_LIMIT + 1e-6);
  assert.ok(Math.abs(seated.ghosted.x) <= SUBJECT_CENTRE_LENS + 1e-9);
  assert.equal(seated.ghosted.crossed, true);
  assert.equal(seated.ghosted.cleared, true);
});

test('a measured lit part at 35.9 per cent inside a 76.4 per cent ghost is kept off the Menu button', () => {
  // Chapter 3, lateral neighbour: lit 35.9 per cent (floor 40), whole 76.4,
  // and the foreground ghost strand lay over the Menu button.
  // The ghost is capped to the 0.75 limit (the lit part gives up 0.007, and
  // it was drawn under the floor by the context ask to begin with); the
  // strand over the button is what the ghost pass moves — the raise is
  // refused by the lit part's caption guard, and the shift right inside the
  // centre band is what clears it. The column stays crossed; the buttons and
  // the lit part's caption clearance are what must hold.
  const CH3_LIT = { x: (0.41 - 0.5) * 2, y: (0.479 - 0.55) * 2, halfWidth: 0.359, halfHeight: 0.28 };
  const CH3_GHOST = { x: CH3_LIT.x, y: CH3_LIT.y, halfWidth: 0.764, halfHeight: 0.42 };
  const rows = toolbarMenuRowPoints(lessonPanel()).map(lensRectOf).filter(Boolean);
  const button = rows[rows.length - 1];
  const strand = { x: (button.left + button.right) / 2, y: (button.bottom + button.top) / 2 };
  const seated = seatAgainstPanel(CH3_LIT, CH3_GHOST,
    { x: CH3_LIT.x, y: CH3_LIT.y, ghostPoints: [strand] });
  assert.ok(Math.abs(seated.share.whole - 0.75) < 1e-3,
    `whole drew at ${seated.share.whole.toFixed(3)}`);
  assert.ok(seated.share.whole <= SUBJECT_GHOST_LENS_LIMIT + 1e-6);
  assert.ok(seated.share.lit < SUBJECT_LENS_FLOOR,
    `lit drew at ${seated.share.lit.toFixed(3)} — the context ask, not the cap`);
  // The strand pass: raise first (refused), then the shift that cleared it.
  assert.equal(seated.ghosted.move, 'shift');
  assert.ok(Math.abs(seated.ghosted.x) <= SUBJECT_CENTRE_LENS + 1e-9);
  assert.equal(seated.ghosted.crossed, true);
  assert.equal(seated.ghosted.cleared, true);
  // The lit part never covered the caption plate to get there.
  const litRect = lensRect({ x: seated.ghosted.x, y: seated.ghosted.y,
    halfWidth: seated.ghosted.rect.halfWidth * (CH3_LIT.halfWidth / CH3_GHOST.halfWidth),
    halfHeight: seated.ghosted.rect.halfHeight * (CH3_LIT.halfHeight / CH3_GHOST.halfHeight) });
  assert.equal(lensRectsOverlap(litRect, seated.caption, PLATE_CLEARANCE_LENS), false);
});

test('the default vertical seat is the eye line when nothing forces it down', () => {
  const caption = lensRectOf(toolbarCaptionPoints(lessonPanel()));
  const menu = lensRectOf(toolbarDrawnMenuPoints(lessonPanel()));
  // Small enough that it shares no lens with the caption or the menu.
  const subject = { x: 0.1, y: 0, halfWidth: 0.15, halfHeight: 0.15 };
  assert.equal(lensRectsOverlap(lensRect(subject), caption, PLATE_CLEARANCE_LENS), false);
  assert.equal(lensRectsOverlap(lensRect(subject), menu, PLATE_CLEARANCE_LENS), false);
  const moved = plateAvoidance({ subject, plate: caption });
  assert.equal(moved.move, 'none');
  assert.equal(moved.y, 0);
  const cleared = menuAvoidance({ subject, menu, caption });
  assert.equal(cleared.y, 0);
  assert.equal(cleared.move, 'none');
  // A subject the caption dodge had lowered, now small enough to sit on the
  // eye line, is raised back. That is the 0.2-lens-unit hardware seat.
  const lifted = menuAvoidance({ subject: { ...subject, y: -0.2 }, menu, caption });
  assert.ok(Math.abs(lifted.y) < 1e-6, `raised to ${lifted.y.toFixed(3)} rather than left low`);
  assert.equal(lifted.move, 'raise');
});

/**
 * The hemoglobin heme close-up, in the glass a headset draws for it: the
 * chapter card at the top, the assistant status card beneath the menu column.
 * The box around the two spans the middle of the lens, and the heme, framed
 * level in the gap between them and clear of both, was shifted to the lens
 * edge. With the status beneath the column it was lowered or raised instead.
 * Status lines are measured with the headset's glyph advances, so the panel
 * draws the status card a wearer would see, or sets it aside.
 */
const glyphAdvances = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8')).advances;
const NO_ASSISTANT = ['No assistant connected', 'Hold A or X to talk', 'Assistant: next tour'];
function hemeCloseUp(status) {
  const panel = createToolbarPanel({ head: HEAD, rows: [{ label: 'Talk' }, { label: 'Play' }, { label: 'Done' },
    { label: 'Menu' }], readout: [{ text: 'Iron and oxygen · 5/5' },
    { text: 'Iron: 0.4 Å above in T; within 0.05 Å of the plane in R.' }],
    measureText: text => Array.from(text).reduce((width, glyph) => width + (glyphAdvances[glyph] ?? .6), 0), ...status });
  const captions = toolbarCaptionPoints(panel);
  const corners = (half, centre = [0, 0, 0]) => [-1, 1].flatMap(sx => [-1, 1].flatMap(sy => [-1, 1]
    .map(sz => [centre[0] + sx * half[0], centre[1] + sy * half[1], centre[2] + sz * half[2]])));
  const chain = [22, 20, 18], heme = [6, 6, 3];
  const plan = focusPlacement({ headInRoom: HEAD.transform.matrix, renderFromRoom: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    cameraScale: 0.0242, center: [0, 0, 0], radius: Math.hypot(...chain),
    placement: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: 1 },
    targetCenter: [0, 0, 0], targetRadius: Math.hypot(...heme), framing: 'fill',
    subjectPoints: corners(heme), assemblyPoints: corners(chain), platePoints: toolbarPlatePoints(panel),
    captionPoints: captions, menuPoints: toolbarDrawnMenuPoints(panel), menuRows: toolbarMenuRowPoints(panel),
    minExtentFraction: 0.15, elevationDegrees: 0 });
  return { panel, captions, frame: plan.standoff.frame };
}

for (const [name, status, shown] of [
  ['its one-line glance', { assistantLines: NO_ASSISTANT, assistantGlance: ['No assistant · A/X to talk'] }, ['No assistant']],
  ['three lines', { assistantLines: ['Claude', 'A/X: talk', 'Ready'] }, ['Claude', 'A/X: talk', 'Ready']],
]) test(`a close-up framed in the gap between the caption and a status card showing ${name} stays centred`, () => {
  const { panel, captions, frame } = hemeCloseUp(status);
  assert.deepEqual(panel.statusPoints.map(line => line.text), shown, 'the status card is drawn');
  assert.equal(captions.plates?.length, 2, 'the caption card and the status card, each on its own');
  const [card, statusCard] = captions.plates.map(lensRectOf);
  const box = lensRectOf(captions);
  assert.ok(box.bottom < 0 && box.top > 0 && card.bottom > 0 && statusCard.top < 0,
    'the box spans the eye line, and the gap between the two cards holds it');
  assert.equal(frame.move, 'none', 'nothing it overlaps moves it');
  assert.ok(Math.hypot(frame.subject.x, frame.subject.y) < 1e-9,
    `centred where it was framed, not at ${frame.subject.x.toFixed(3)}, ${frame.subject.y.toFixed(3)} of the lens`);
  for (const plate of [card, statusCard])
    assert.equal(lensRectsOverlap(lensRect(frame.subject), plate, PLATE_CLEARANCE_LENS), false);
});

test('a close-up beneath the caption card stays in the centre band when the status is set aside', () => {
  const { panel, captions, frame } = hemeCloseUp({ assistantLines: NO_ASSISTANT });
  assert.equal(panel.statusBacking, undefined, 'no status line fits the column, so the status is set aside');
  assert.equal(captions.plates, undefined, 'one card, so there is no gap to keep');
  const card = lensRectOf(captions);
  assert.ok(card.bottom > 0, 'the card sits above the eye line');
  assert.notEqual(frame.move, 'shift');
  assert.ok(Math.abs(frame.subject.x) <= SUBJECT_CENTRE_LENS && Math.abs(frame.subject.y) <= SUBJECT_CENTRE_LENS,
    `centred, not at ${frame.subject.x.toFixed(3)}, ${frame.subject.y.toFixed(3)} of the lens`);
  assert.equal(lensRectsOverlap(lensRect(frame.subject), card, PLATE_CLEARANCE_LENS), false);
});
