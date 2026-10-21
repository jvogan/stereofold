import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { focusPlacement, turnSweptPoints, obliqueGrowthTurn, GROWTH_WALL_AZIMUTH_DEGREES } from './focus-placement.mjs';

// Geometric stand-ins for the landed growth stages; no external demo cache.
const stages = { protofilament: [25, 81.5, 25], wall: [81, 71.4, 12.5], tube: [125, 81.5, 125], tip: [125, 125, 125] };
for (const [stage, half] of Object.entries(stages)) test(`${stage}: safe swept seats retain their existing size and position`, t => {
  const points = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x * half[0], y * half[1], z * half[2]])));
  const pose = { headInRoom: Mat4.identity(), renderFromRoom: Mat4.identity(),
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } };
  const rotation = obliqueGrowthTurn({ ...pose, points, centre: [0, 0, 0], azimuthDegrees: GROWTH_WALL_AZIMUTH_DEGREES })?.rotation ?? pose.placement.rotation;
  for (const degrees of [360, 20, -15]) {
    const swept = turnSweptPoints(points, { axis: [0, 1, 0], degrees }, { pivot: [0, 0, 0], rotation });
    const options = { ...pose, placement: { ...pose.placement, rotation }, cameraScale: .003,
      center: [0, 0, 0], targetCenter: [0, 0, 0], radius: Math.hypot(...half), targetRadius: Math.hypot(...half),
      subjectPoints: swept, assemblyPoints: swept, framing: 'fill', wholeStructure: true, elevationDegrees: 0 };
    const before = focusPlacement(options), after = focusPlacement({ ...options, sweptTurn: true });
    assert.equal(after.scale, before.scale, `${degrees} degrees: scale`);
    assert.deepEqual(after.translation, before.translation, `${degrees} degrees: placement`);
    t.diagnostic(`${degrees} degrees: scale ${after.scale.toFixed(6)}, unchanged`);
  }
});
