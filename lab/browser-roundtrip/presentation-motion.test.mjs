import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  IMMERSIVE_DEGREES_PER_SECOND, NON_MANIPULATION_BUTTONS, PRESENTATION_DEGREES_PER_SECOND,
  manipulationButtons, pointerManipulates, presentationDegreesPerSecond,
} from './presentation-motion.mjs';
import { FACE_LOWER, FACE_UPPER, STICK_PRESS } from './xr-buttons.mjs';

const TRIGGER = 1; // ButtonsType.Flag.Primary
const GRIP = 2; // ButtonsType.Flag.Secondary

test('the talk and menu buttons are the only ones excused from manipulation', () => {
  assert.equal(NON_MANIPULATION_BUTTONS, FACE_LOWER | FACE_UPPER);
  assert.equal(manipulationButtons(FACE_LOWER), 0);
  assert.equal(manipulationButtons(FACE_UPPER), 0);
  assert.equal(manipulationButtons(FACE_LOWER | FACE_UPPER), 0);
});

test('a talk hold does not manipulate the structure', () => {
  assert.equal(pointerManipulates({ buttons: FACE_LOWER, axes: [0, 0, 0, 0] }), false);
});

test('a menu tap does not manipulate the structure', () => {
  assert.equal(pointerManipulates({ buttons: FACE_UPPER, axes: [0, 0, 0, 0] }), false);
});

test('a trigger, a grip and a stick click all manipulate the structure', () => {
  for (const mask of [TRIGGER, GRIP, STICK_PRESS]) {
    assert.equal(pointerManipulates({ buttons: mask, axes: [0, 0, 0, 0] }), true, `mask ${mask}`);
  }
});

test('a deflected stick manipulates the structure even under a held talk button', () => {
  assert.equal(pointerManipulates({ buttons: 0, axes: [0, 0, 0.8, 0] }), true);
  assert.equal(pointerManipulates({ buttons: FACE_LOWER, axes: [0, 0, 0.8, 0] }), true);
});

test('stick noise inside the deadzone is not manipulation', () => {
  assert.equal(pointerManipulates({ buttons: 0, axes: [0.05, -0.09, 0, 0] }), false);
});

test('an idle pointer, a missing pointer and a missing axes array are not manipulation', () => {
  assert.equal(pointerManipulates({ buttons: 0, axes: [0, 0, 0, 0] }), false);
  assert.equal(pointerManipulates(undefined), false);
  assert.equal(pointerManipulates({ buttons: 0 }), false);
  assert.equal(manipulationButtons(undefined), 0);
});

test('trigger plus stick still manipulates, so the depth gesture stops the spin', () => {
  assert.equal(pointerManipulates({ buttons: TRIGGER, axes: [0, 0, 0, 0.6] }), true);
});

test('the headset turns three times faster than the panel', () => {
  assert.equal(PRESENTATION_DEGREES_PER_SECOND, 4);
  assert.equal(IMMERSIVE_DEGREES_PER_SECOND, 12);
  assert.equal(presentationDegreesPerSecond(false), 4);
  assert.equal(presentationDegreesPerSecond(true), 12);
});

test('a revolution takes 30 s in the headset and 90 s on the panel', () => {
  assert.equal(360 / presentationDegreesPerSecond(true), 30);
  assert.equal(360 / presentationDegreesPerSecond(false), 90);
});
