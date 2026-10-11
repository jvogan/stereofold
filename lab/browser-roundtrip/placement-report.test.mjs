/**
 * The four placement rows, read back from the pose each
 * one actually produced.
 *
 * Every case below builds the pose the shipped code builds — `room-placement.mjs`
 * for `Above us` and `In reach`, `reset-view-placement.mjs` for `Fit` and
 * `Reset` — and then asks what the plate would say about it. Nothing here
 * passes a row name, a target or a label into the sentence, which is the point:
 * the wearer is told where the structure IS, not what was pressed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLACEMENT_REACH_METERS, placementNoteFor, placementPlateLines, placementSentence, wearerPlacementReading,
} from './placement-report.mjs';
import { roomPlacement } from './room-placement.mjs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EYE_HEIGHT = 1.6;

/** A tracked head at eye height, turned `yaw` degrees to the wearer's left. */
const head = (yaw = 0, position = [0, EYE_HEIGHT, 0]) => {
  const angle = yaw * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, ...position, 1];
};

/**
 * The scene the readings are taken in: room metres and molecular radii are the
 * same unit, so a translation reads directly as a room point and every expected
 * number below can be checked by hand.
 */
const scene = { center: [0, 0, 0], radius: 1, cameraScale: 1, renderFromRoom: IDENTITY };

/** The toolbar glass, as a bearing band to the wearer's left at 1.2 m. */
const menuGlass = (fromDegrees = -45, toDegrees = -22, distance = 1.2) =>
  [fromDegrees, toDegrees].flatMap(bearing => {
    const angle = bearing * Math.PI / 180;
    return [-0.15, 0.15].map(rise =>
      [Math.sin(angle) * distance, EYE_HEIGHT + rise, -Math.cos(angle) * distance]);
  });

/** A placement whose structure centre sits at one room point, `across` wide. */
const at = (roomPoint, metersAcross) => ({ translation: [...roomPoint], scale: metersAcross / 2 });

test('completed Fit and Reset receipts disambiguate the same measured entry seat', () => {
  const placement = at([1.1, EYE_HEIGHT + .2, -3.8], 1.2);
  const input = { ...placement, ...scene, headInRoom: head(), menuPoints: menuGlass(), startRoomPoint: placement.translation };
  assert.equal(placementNoteFor({ ...input, reason: 'fit' }).text, 'Fitted to the right of the menu');
  assert.equal(placementNoteFor({ ...input, reason: 'reset' }).text, 'Back at the start');
  const overhead = { ...input, translation: [0, EYE_HEIGHT + 3, 0], reason: 'fit' };
  assert.equal(placementNoteFor(overhead).text, 'Above you · look up');
  assert.equal(placementNoteFor({ ...input, headInRoom: null, reason: 'fit' }), undefined);
});

test('the overhead row is read as overhead, and says which way to look', () => {
  // The centre stays three metres above the eye, a little forward at 65 degrees.
  const placement = roomPlacement({ headInRoom: head(), renderFromRoom: IDENTITY,
    cameraScale: 1, center: [0, 0, 0], radius: 1, target: 'overhead' });
  const reading = wearerPlacementReading({ ...placement, ...scene, headInRoom: head() });
  assert.ok(Math.abs(reading.elevationDegrees - 65) < 1e-9, `elevation ${reading.elevationDegrees}`);
  assert.equal(placementSentence(reading), 'Above you · look up');
});

test('the in-reach row is read as in front and within arm’s length', () => {
  const placement = roomPlacement({ headInRoom: head(), renderFromRoom: IDENTITY,
    cameraScale: 1, center: [0, 0, 0], radius: 1, target: 'front' });
  const reading = wearerPlacementReading({ ...placement, ...scene, headInRoom: head(), menuPoints: menuGlass() });
  assert.ok(Math.abs(reading.bearingDegrees) < 1e-9, `bearing ${reading.bearingDegrees}`);
  assert.ok(reading.reachMeters <= PLACEMENT_REACH_METERS, `reach ${reading.reachMeters}`);
  assert.equal(placementSentence(reading), 'In front of you, within reach');
});

test('a structure slid clear of the menu is read as beside the menu, on the measured side', () => {
  // What Fit does: keep the size and the depth, slide sideways until the whole
  // sphere clears the glass. The glass is to the wearer's left, so the slide is
  // to the right — and the sentence names the side it measured, not the row.
  const menuPoints = menuGlass();
  const right = wearerPlacementReading({ ...at([0.75, EYE_HEIGHT, -1.9], 1), ...scene,
    headInRoom: head(), menuPoints });
  assert.equal(placementSentence(right), 'Fitted to the right of the menu');
  // The mirrored room: glass on the right, structure slid left.
  const mirrored = menuGlass(22, 45);
  const left = wearerPlacementReading({ ...at([-0.75, EYE_HEIGHT, -1.9], 1), ...scene,
    headInRoom: head(), menuPoints: mirrored });
  assert.equal(placementSentence(left), 'Fitted to the left of the menu');
  // With no glass reading there is no menu to relate it to, and the plate falls
  // back to the plain position rather than inventing a relationship.
  assert.equal(placementSentence(wearerPlacementReading({ ...at([0.75, EYE_HEIGHT, -1.9], 1), ...scene,
    headInRoom: head() })), 'To your right');
  // A structure the wearer is looking straight at is described as in front,
  // even when it is also clear of the menu — which is what a centred Reset
  // leaves behind. The menu sentence is for a structure off the gaze.
  assert.equal(placementSentence(wearerPlacementReading({ ...at([0, EYE_HEIGHT, -1.9], 1), ...scene,
    headInRoom: head(), menuPoints })), 'In front of you, within reach');
});

test('a structure back on the seat the session started at says so, and only from where it started', () => {
  const startRoomPoint = [0, EYE_HEIGHT + 0.17, -1.6];
  const back = wearerPlacementReading({ ...at(startRoomPoint, 1.4), ...scene,
    headInRoom: head(), startRoomPoint });
  assert.equal(back.atStart, true);
  assert.equal(placementSentence(back), 'Back at the start');
  // The same room point, read by a wearer who has since turned ninety degrees:
  // it is no longer in front of them, so the plate says where it is instead of
  // claiming a homecoming they cannot see.
  const turned = wearerPlacementReading({ ...at(startRoomPoint, 1.4), ...scene,
    headInRoom: head(90), startRoomPoint });
  assert.equal(turned.atStart, true);
  assert.equal(placementSentence(turned), 'To your right');
  // A placement a quarter-metre-and-more off the seat is not the seat.
  const near = wearerPlacementReading({ ...at([0.6, EYE_HEIGHT + 0.17, -1.6], 1.4), ...scene,
    headInRoom: head(), startRoomPoint });
  assert.equal(near.atStart, false);
});

test('the sentence follows the pose, not the row: one target, two rooms, two sentences', () => {
  // `In reach` from a head that is looking at the floor puts the structure two
  // metres along the wearer's LEVELLED forward, and the sentence still reads
  // off where that landed rather than off the row that asked for it.
  const behind = wearerPlacementReading({ ...at([0, EYE_HEIGHT, 2.2], 1.2), ...scene, headInRoom: head() });
  assert.equal(placementSentence(behind), 'Behind you · turn around');
  const rightOf = wearerPlacementReading({ ...at([2.2, EYE_HEIGHT, 0], 1.2), ...scene, headInRoom: head() });
  assert.equal(placementSentence(rightOf), 'To your right');
  const leftOf = wearerPlacementReading({ ...at([-2.2, EYE_HEIGHT, 0], 1.2), ...scene, headInRoom: head() });
  assert.equal(placementSentence(leftOf), 'To your left');
  const far = wearerPlacementReading({ ...at([0, EYE_HEIGHT, -4], 1.2), ...scene, headInRoom: head() });
  assert.equal(placementSentence(far), 'In front of you, a step away');
});

test('a reading that cannot be taken draws nothing rather than guessing a direction', () => {
  for (const broken of [
    undefined,
    { ...at([0, EYE_HEIGHT, -2], 1), ...scene, headInRoom: undefined },
    { ...at([0, EYE_HEIGHT, -2], 1), ...scene, headInRoom: new Array(16).fill(0) },
    { ...at([0, EYE_HEIGHT, -2], 1), ...scene, renderFromRoom: undefined, headInRoom: head() },
    { ...at([0, EYE_HEIGHT, -2], 1), ...scene, cameraScale: 0, headInRoom: head() },
    { ...at([0, EYE_HEIGHT, -2], 1), ...scene, radius: 0, headInRoom: head() },
    { translation: [0, 0, Number.NaN], scale: 1, ...scene, headInRoom: head() },
    { translation: [0, 0, -2], scale: -1, ...scene, headInRoom: head() },
    { ...at([0, EYE_HEIGHT, -2], 1), ...scene, center: [0, 0], headInRoom: head() },
  ]) {
    assert.equal(wearerPlacementReading(broken), undefined);
  }
  assert.equal(placementSentence(undefined), undefined);
  assert.equal(placementNoteFor({ ...at([0, EYE_HEIGHT, -2], 1), ...scene, headInRoom: new Array(16).fill(0) }), undefined);
});

test('the note carries the sentence and its reading, and the plate reserves the whole sentence', () => {
  const note = placementNoteFor({ ...at([0, EYE_HEIGHT + 3, 0], 1), ...scene, headInRoom: head() });
  assert.equal(note.text, 'Above you · look up');
  assert.ok(note.reading.elevationDegrees > 80);
  const lines = placementPlateLines(note);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Above you · look up');
  assert.equal(lines[0].maxLines, 2);
  // The placement is reserved as a whole sentence, with room to wrap.
  assert.equal(lines[0].whole, true);
  assert.deepEqual(placementPlateLines(undefined), []);
  assert.deepEqual(placementPlateLines({ text: '   ' }), []);
  assert.deepEqual(placementPlateLines('To your right'), [{ text: 'To your right', compactText: 'To your right', maxLines: 2, whole: true }]);
});

test('a wearer standing off the room origin still gets their own bearings', () => {
  // Every earlier case sits the wearer at the room origin, where a bearing and
  // a room coordinate look alike. This one does not: the head is two metres
  // along +X and turned, and the structure is directly behind it.
  const position = [2, EYE_HEIGHT, 1];
  const reading = wearerPlacementReading({ ...at([2, EYE_HEIGHT, 3], 1), ...scene, headInRoom: head(0, position) });
  assert.equal(placementSentence(reading), 'Behind you · turn around');
  const turned = wearerPlacementReading({ ...at([2, EYE_HEIGHT, 3], 1.4), ...scene, headInRoom: head(180, position) });
  assert.ok(Math.abs(turned.bearingDegrees) < 1e-9, `bearing ${turned.bearingDegrees}`);
  assert.equal(placementSentence(turned), 'In front of you, within reach');
});
