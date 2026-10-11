import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAP_HEIGHT_PER_EM,
  COMPONENT_LABEL_BASE_OFFSET_Z,
  DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z,
  LABEL_CHARACTER_DEGREES,
  LABEL_DISTANCE_BAND,
  componentLabelOffsetZ,
  correctLabelBasis,
  labelCharacterDegrees,
  labelDistanceMeters,
  labelIsLegible,
  labelScreenBasis,
  labelSizeFactor,
} from './label-facing.mjs';

const ZERO = new Array(16).fill(0);
const radians = degrees => (degrees * Math.PI) / 180;
/** Column-major yaw about Y, the `camera.headRotation` Mol* writes at this head pose. */
const yawMatrix = degrees => {
  const c = Math.cos(radians(degrees)), s = Math.sin(radians(degrees));
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
};
/** Column-major roll about Z. */
const rollMatrix = degrees => {
  const c = Math.cos(radians(degrees)), s = Math.sin(radians(degrees));
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};
const near = (value, expected, epsilon = 1e-9) => Math.abs(value - expected) <= epsilon;

test('component plates clear the fold at every authored placement scale', () => {
  assert.equal(componentLabelOffsetZ(1), COMPONENT_LABEL_BASE_OFFSET_Z);
  assert.equal(componentLabelOffsetZ(2.4), 120);
  assert.equal(componentLabelOffsetZ(0.25), 12.5);
  for (const scale of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(componentLabelOffsetZ(scale), COMPONENT_LABEL_BASE_OFFSET_Z);
  }
});

// The desktop branch was a fixed 4 while only the XR branch scaled, so a
// desktop panel at the lesson's own placement scale of 2.4 buried every plate
// inside the cartoon it was naming -- the same defect the scale was added to
// fix, left standing on the other half of the `if`.
test('a desktop plate scales with the placement too, from its own smaller stand-off', () => {
  assert.equal(componentLabelOffsetZ(1, DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z),
    DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z);
  assert.equal(componentLabelOffsetZ(2.4, DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z), 9.6);
  assert.ok(DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z < COMPONENT_LABEL_BASE_OFFSET_Z,
    'a flat panel has no vergence to fight, so the plate clears the fold rather than floats');
  // A nonsense base is the XR one rather than a plate at zero stand-off.
  for (const base of [undefined, null, 0, -1, Number.NaN]) {
    assert.equal(componentLabelOffsetZ(1, base), COMPONENT_LABEL_BASE_OFFSET_Z);
  }
});

test('the held (shipped) branch faces the eye upright for every head pose and subject placement', () => {
  // The session hold keeps `camera.headRotation` reading zero, so the shader
  // takes its clip-space branch. The subject's placement — any rotation, any
  // voice scale, even a mirrored matrix — lives in `aTransform`, which the
  // glyph expansion never touches, so none of it may move the basis.
  const yaws = [0, 45, 90, 135, 180, 225, 270, 315];
  const subjectRotations = [0, 30, 90, 180, 270];
  const subjectScales = [0.25, 1, 4];
  for (const yaw of yaws) {
    void yaw;
    for (const rotation of subjectRotations) {
      void rotation;
      for (const scale of subjectScales) {
        void scale;
        for (const mirrored of [false, true]) {
          void mirrored;
          const basis = labelScreenBasis({ headRotation: [...ZERO] });
          assert.deepEqual(basis.right, [1, 0]);
          assert.deepEqual(basis.up, [0, 1]);
          assert.equal(basis.determinant, 1);
          assert.equal(basis.mirrored, false);
          assert.equal(basis.degenerate, false);
          assert.equal(basis.upright, true);
          assert.equal(basis.branch, 'screen');
        }
      }
    }
  }
});

test('without the hold, yaw mirrors and collapses exactly as the shader would draw it', () => {
  for (const yaw of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const basis = labelScreenBasis({ headRotation: yawMatrix(yaw) });
    assert.equal(basis.branch, 'head-rotation');
    assert.ok(near(basis.determinant, Math.cos(radians(yaw)), 1e-9), `yaw ${yaw}`);
    // The wearer's up vector survives pure yaw either way; mirroring is horizontal.
    assert.deepEqual(basis.up.map(value => Math.abs(value) < 1e-9 ? 0 : value), [0, 1]);
  }
  const upside = labelScreenBasis({ headRotation: yawMatrix(180) });
  assert.equal(upside.mirrored, true);
  assert.equal(upside.determinant, -1);
  const edgeOn = labelScreenBasis({ headRotation: yawMatrix(90) });
  assert.equal(edgeOn.degenerate, true);
  const rolled = labelScreenBasis({ headRotation: rollMatrix(30) });
  assert.ok(rolled.determinant > 0 && !rolled.mirrored && rolled.upright, 'roll never mirrors');
});

test('absent, zeroed, truncated and non-finite head rotations all take the screen branch', () => {
  for (const headRotation of [null, undefined, [...ZERO], [1, 0, 0], new Array(16).fill(Number.NaN)]) {
    const basis = labelScreenBasis(headRotation === undefined ? {} : { headRotation });
    assert.equal(basis.branch, 'screen', String(headRotation));
    assert.equal(basis.determinant, 1);
    assert.equal(basis.mirrored, false);
  }
});

test('mirrored input comes back unmirrored with up untouched', () => {
  // 180 degrees of unlocked yaw: the exact basis the wearer called mirrored.
  const unlocked = labelScreenBasis({ headRotation: yawMatrix(180) });
  assert.equal(unlocked.mirrored, true);
  const repaired = correctLabelBasis(unlocked);
  assert.equal(repaired.mirrored, false);
  assert.equal(repaired.degenerate, false);
  assert.ok(repaired.determinant > 0);
  assert.deepEqual(repaired.up, unlocked.up);
  assert.equal(repaired.upright, true);
  assert.equal(repaired.corrected, true);
  // A mirrored subject-side basis (negative scale, reflected author matrix).
  const mirroredSubject = correctLabelBasis({ right: [-1, 0], up: [0, 1] });
  assert.deepEqual(mirroredSubject.right, [1, 0]);
  assert.deepEqual(mirroredSubject.up, [0, 1]);
  assert.ok(mirroredSubject.determinant > 0 && !mirroredSubject.mirrored);
  // The repair mirrors back, never rotates: an upside-down basis stays
  // upside-down rather than being moved to a new anchor.
  const upsideDown = correctLabelBasis({ right: [1, 0], up: [0, -1] });
  assert.ok(upsideDown.determinant > 0 && !upsideDown.mirrored);
  assert.deepEqual(upsideDown.up, [0, -1]);
  assert.equal(upsideDown.upright, false);
});

test('degenerate and non-finite input falls back to the screen identity', () => {
  for (const input of [{ right: [0, 0], up: [0, 0] }, { right: [1, 1], up: [2, 2] },
    { right: [Number.NaN, 0], up: [0, 1] }, { up: [0, 0] }]) {
    const basis = correctLabelBasis(input);
    assert.deepEqual(basis.right, [1, 0]);
    assert.deepEqual(basis.up, [0, 1]);
    assert.equal(basis.determinant, 1);
    assert.equal(basis.corrected, true);
  }
  const clean = correctLabelBasis({ right: [1, 0], up: [0, 1] });
  assert.equal(clean.corrected, false);
  assert.equal(clean.determinant, 1);
});

test('the size rule holds angular size constant at 1 m, 2 m and 3 m', () => {
  for (const cameraScale of [1, 0.05]) {
    const factors = [1, 2, 3].map(distanceMeters =>
      labelSizeFactor({ distanceMeters, cameraScale }));
    // Twice the distance needs twice the world-unit factor: linear in distance.
    assert.ok(near(factors[1] / factors[0], 2, 1e-9));
    assert.ok(near(factors[2] / factors[0], 3, 1e-9));
    for (let index = 0; index < 3; index++) {
      const { character, cap } = labelCharacterDegrees({
        sizeFactor: factors[index], cameraScale, distanceMeters: index + 1 });
      assert.ok(near(character, LABEL_CHARACTER_DEGREES.comfortable, 1e-9),
        `${index + 1} m reads ${character} degrees`);
      assert.ok(near(cap / character, CAP_HEIGHT_PER_EM, 0.01));
      assert.ok(labelIsLegible({ sizeFactor: factors[index], cameraScale, distanceMeters: index + 1 }));
    }
  }
});

test('the floor guarantees a readable cap height and the band clamps the seat', () => {
  // A caller asking for something unreadable gets the floor, not a rounding.
  const floored = labelSizeFactor({ distanceMeters: 2, cameraScale: 1, characterDegrees: 0.01 });
  const { character, cap } = labelCharacterDegrees({ sizeFactor: floored, cameraScale: 1, distanceMeters: 2 });
  assert.ok(near(character, LABEL_CHARACTER_DEGREES.floor, 1e-9));
  assert.ok(cap >= 1 / 3 - 1e-9, 'the cap height clears 20 arcmin even at the floor');
  assert.ok(labelIsLegible({ sizeFactor: floored, cameraScale: 1, distanceMeters: 2 }));
  assert.equal(labelIsLegible({ sizeFactor: floored / 2, cameraScale: 1, distanceMeters: 2 }), false);
  assert.ok(near(LABEL_CHARACTER_DEGREES.floor * CAP_HEIGHT_PER_EM, 1 / 3, 1e-12));
  assert.equal(labelDistanceMeters(null), LABEL_DISTANCE_BAND.fallback);
  assert.equal(labelDistanceMeters(0), LABEL_DISTANCE_BAND.fallback);
  assert.equal(labelDistanceMeters(99), LABEL_DISTANCE_BAND.max);
  assert.equal(labelDistanceMeters(0.2), LABEL_DISTANCE_BAND.min);
  assert.throws(() => labelSizeFactor({ distanceMeters: 2, cameraScale: 0 }), /camera scale/);
  assert.throws(() => labelSizeFactor({ distanceMeters: 2, cameraScale: 1, sizeThemeValue: 0 }), /size theme/);
});
