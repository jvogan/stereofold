import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { focusPlacement, focusRotation, turnSweptPoints } from './focus-placement.mjs';
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from './spatial-toolbar-geometry.mjs';
import { tourFocusHarness } from './fixtures/tour-focus-harness.mjs';

// A tube pointing at the wearer at t=0, as the filament's map first stands:
// long in z, thin in x and y, about the origin. A quarter turn lays it across.
const half = 100, girth = 12;
const tube = [[0, 0, -half], [0, 0, half], [girth, 0, 0], [-girth, 0, 0], [0, girth, 0], [0, -girth, 0],
  ...[-1, 1].flatMap(end => [[girth, 0, end * half], [-girth, 0, end * half], [0, girth, end * half], [0, -girth, end * half]])];
const options = { headInRoom: Mat4.identity(), renderFromRoom: Mat4.identity(), cameraScale: .003,
  center: [0, 0, 0], radius: Math.hypot(half, girth), targetCenter: [0, 0, 0], targetRadius: Math.hypot(half, girth),
  placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, framing: 'fill', wholeStructure: true, elevationDegrees: 0 };
const spin = { axis: [0, 1, 0], degrees: 360 };

/** The tube's points in the wearer's head frame at `degrees` into a turn about render up. */
function headPoints(plan, degrees) {
  const turn = Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, Vec3.create(0, 1, 0));
  const rotation = focusRotation(options.placement.rotation);
  return tube.map(point => {
    const local = Vec3.transformMat4(Vec3(), Vec3.create(...point), rotation);
    const render = Array.from(local).map((v, i) => v * plan.scale + options.center[i] + plan.translation[i] * options.radius);
    // The presentation turn is about the drawn centre, in render space.
    const pivot = options.center.map((v, i) => v + plan.translation[i] * options.radius);
    const turned = Vec3.add(Vec3(), Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), render, pivot), turn), pivot);
    return Array.from(turned).map(v => v * plan.cameraScale);
  });
}
/** The nearest depth and the widest lens share the tube reaches over a whole turn. */
function overTurn(plan) {
  let nearest = Infinity, widest = 0;
  for (let degrees = 0; degrees < 360; degrees += 5) for (const [x, , z] of headPoints(plan, degrees)) {
    nearest = Math.min(nearest, -z);
    if (-z > 0) widest = Math.max(widest, Math.abs(x) / -z);
  }
  return { nearest, widest };
}

test('a seat solved at t=0 lets a turning tube cross the glass and leave the lens', () => {
  const still = focusPlacement({ ...options, subjectPoints: tube, assemblyPoints: tube });
  const { nearest, widest } = overTurn(still);
  assert.ok(nearest < still.standoff.floorMetres - .05,
    `the tube's end comes to ${nearest.toFixed(2)} m against a ${still.standoff.floorMetres.toFixed(2)} m stand-off`);
  assert.ok(widest > EYE_TAN_HALF_HORIZONTAL, `laid across, the tube reaches ${widest.toFixed(2)} of the half lens`);
});

test('a seat solved for the volume the turn sweeps keeps the whole turn behind the stand-off and inside the lens', () => {
  const swept = turnSweptPoints(tube, spin, { pivot: options.center, rotation: options.placement.rotation });
  const plan = focusPlacement({ ...options, subjectPoints: swept, assemblyPoints: swept });
  const { nearest, widest } = overTurn(plan);
  assert.ok(nearest >= plan.standoff.floorMetres - .01,
    `the nearest point of the turn is ${nearest.toFixed(2)} m against a ${plan.standoff.floorMetres.toFixed(2)} m stand-off`);
  assert.ok(widest < EYE_TAN_HALF_HORIZONTAL, `the turn stays inside the lens (${widest.toFixed(2)})`);
});

test('the sweep follows the placement and the arc it is given', () => {
  // No turn, or a degenerate one, leaves the points as they are.
  assert.equal(turnSweptPoints(tube, undefined, { pivot: [0, 0, 0], rotation: [0, 0, 0] }), tube);
  assert.equal(turnSweptPoints(tube, { axis: [0, 1, 0], degrees: 0 }, { pivot: [0, 0, 0], rotation: [0, 0, 0] }), tube);
  // A quarter turn about render up reaches the tube's end round to the
  // wearer's depth axis, and no further round than the quarter. Between steps
  // the points stand off the axis just enough to hold the arc between them.
  const quarter = turnSweptPoints([[half, 0, 0]], { axis: [0, 1, 0], degrees: 90 }, { pivot: [0, 0, 0], rotation: [0, 0, 0] });
  assert.ok(quarter.some(([x, , z]) => Math.abs(x) < 1e-6 && z <= -half), 'the end reaches -z after a quarter');
  assert.ok(quarter.every(([x, , z]) => x >= -1e-6 && z <= 1e-6), 'the sweep stays inside its quarter');
  const reach = Math.max(...quarter.map(([x, , z]) => Math.hypot(x, z)));
  assert.ok(reach > half && reach < half * 1.01, `the arc is held within ${((reach / half - 1) * 100).toFixed(2)} per cent`);
  // Every chord between two steps passes the pivot no nearer than the end
  // itself, so the arc never bulges out between them.
  for (let i = 0; i + 1 < quarter.length; i++) {
    const [a, b] = [quarter[i], quarter[i + 1]].map(([x, , z]) => [x, z]);
    const chord = Math.abs(a[0] * b[1] - a[1] * b[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert.ok(chord >= half - 1e-6, `the chord from step ${i} passes ${chord.toFixed(2)} from the pivot`);
  }
  // A placement turned 90 degrees about y carries render up unchanged but
  // render x into model z, so the same sweep is about the model's own y.
  const turned = turnSweptPoints([[half, 0, 0]], spin, { pivot: [0, 0, 0], rotation: [0, 90, 0] });
  assert.ok(turned.every(([, y]) => Math.abs(y) < 1e-6));
  assert.ok(Math.max(...turned.map(([x]) => x)) > half - 1e-6 && Math.min(...turned.map(([x]) => x)) < -half + 1e-6);
  // A tilted placement carries render up into a tilted model axis.
  const tilted = turnSweptPoints([[0, half, 0]], spin, { pivot: [0, 0, 0], rotation: [90, 0, 0] });
  assert.ok(tilted.every(point => {
    const reach = Vec3.distance(Vec3.create(...point), Vec3.create(0, 0, 0));
    return reach > half - 1e-6 && reach < half * 1.01;
  }));
});

/** The page's own `chapterPainting`, cut from the viewer into the harness context. */
function chapterPainting(h) {
  const source = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('\n    chapterPainting(');
  const end = source.indexOf('\n    },', start);
  assert.ok(start >= 0 && end > start, 'viewer method: chapterPainting');
  return vm.runInContext(`({${source.slice(start, end + 7)}})`, h).chapterPainting;
}

/**
 * The headset seat the page solves for `points` while chapter `id` paints
 * with `turn`, and where they reach as they turn that far about the stage
 * centre in render space.
 */
async function headsetSeat(points, id, turn) {
  const { h, records } = tourFocusHarness();
  const sphere = { center: [0, 0, 0], radius: Math.hypot(half, girth), extrema: points };
  Object.assign(h, { turnSweptPoints, recordBoundingSphere: () => sphere, loadedSphere: () => sphere,
    drawnCenter: () => Vec3.create(0, 0, 0) });
  if (id !== undefined) chapterPainting(h)(id, { turn });
  await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', durationMs: 0, elevationDegrees: 0 });
  const placement = h.inspectionSnapshot().placement;
  const { floorMetres } = records.findLast(record => record.kind === 'standoff').plan.standoff;
  const base = h.placementTransform(placement), head = h.latestRoomPlacementPose.headInRoom;
  const pivot = Vec3.transformMat4(Vec3(), Vec3.create(0, 0, 0), base);
  const degrees = Math.max(-360, Math.min(360, turn?.degrees ?? 0));
  let nearest = Infinity, wide = 0, tall = 0, minX = Infinity, maxX = -Infinity;
  for (let step = 0; step <= 72; step++) {
    const spin = Mat4.fromRotation(Mat4(), degrees * step / 72 * Math.PI / 180, Vec3.create(0, 1, 0));
    for (const point of points) {
      const render = Vec3.transformMat4(Vec3(), Vec3.create(...point), base);
      const turned = Vec3.add(Vec3(), Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), render, pivot), spin), pivot);
      const [x, y, z] = Vec3.scale(Vec3(), turned, h.canvas.camera.scale).map((v, i) => v - head[12 + i]);
      nearest = Math.min(nearest, -z);
      if (-z > 0) { wide = Math.max(wide, Math.abs(x) / -z); tall = Math.max(tall, Math.abs(y) / -z); minX = Math.min(minX, x / -z); maxX = Math.max(maxX, x / -z); }
    }
  }
  return { placement, floorMetres, nearest, wide, tall, lensShare: (maxX - minX) / (2 * EYE_TAN_HALF_HORIZONTAL) };
}

test('the headset seats a turning chapter for its whole turn and a still one as before', async () => {
  const spin = { axis: [0, 1, 0], degrees: 360, continuous: true };
  const still = await headsetSeat(tube);
  // A chapter that does not turn keeps the seat it always had.
  assert.deepEqual((await headsetSeat(tube, 'highlight', undefined)).placement, still.placement);
  // That seat is sized for the tube end on. Turned in it, the tube is laid
  // across far past the lens and swings through the glass.
  const stillTurned = await headsetSeat(tube, undefined, spin);
  assert.ok(stillTurned.wide > EYE_TAN_HALF_HORIZONTAL, `laid across, the tube reaches ${stillTurned.wide.toFixed(2)}`);
  assert.ok(stillTurned.nearest < stillTurned.floorMetres - .05,
    `a t=0 seat lets the turning tube come to ${stillTurned.nearest.toFixed(2)} m`);

  // The presentation spin: the seat holds the whole turn behind the stand-off
  // and inside the lens.
  const spun = await headsetSeat(tube, 'reveal', spin);
  assert.ok(spun.nearest >= spun.floorMetres - .02,
    `the turn comes to ${spun.nearest.toFixed(2)} m against a ${spun.floorMetres.toFixed(2)} m stand-off`);
  assert.ok(spun.wide < EYE_TAN_HALF_HORIZONTAL && spun.tall < EYE_TAN_HALF_VERTICAL, 'the whole turn stays in the lens');

  // A tube lying across the lens loses little to a whole turn, and a short
  // orbit, sweeping a narrow arc, gives up less than that.
  const across = tube.map(([x, y, z]) => [z, y, x]);
  const [level, nudged, round] = [await headsetSeat(across), await headsetSeat(across, 'orbit', { axis: [0, 1, 0], degrees: -20 }),
    await headsetSeat(across, 'reveal', spin)];
  for (const seat of [nudged, round]) assert.ok(seat.nearest >= seat.floorMetres - .02 && seat.wide < EYE_TAN_HALF_HORIZONTAL);
  assert.ok(round.placement.scale < nudged.placement.scale && nudged.placement.scale <= level.placement.scale
    && round.placement.scale > level.placement.scale * .9, `still ${level.placement.scale.toFixed(3)}, `
    + `20 degrees ${nudged.placement.scale.toFixed(3)}, whole turn ${round.placement.scale.toFixed(3)}`);
});

for (const degrees of [15, 20]) test(`an end-on ${degrees} degree turn stays clear and visibly fills the lens`, async t => {
  const seat = await headsetSeat(tube, 'short-orbit', { axis: [0, 1, 0], degrees });
  assert.ok(seat.nearest >= .05, `nearest extent ${seat.nearest} m`);
  assert.ok(seat.nearest >= seat.floorMetres - .02, `stand-off ${seat.nearest} < ${seat.floorMetres}`);
  const share = seat.lensShare;
  t.diagnostic(`nearest ${seat.nearest.toFixed(3)} m; swept lens width ${(100 * share).toFixed(1)}%; scale ${seat.placement.scale.toFixed(3)}`);
  assert.ok(share >= .3, `visible lens share ${share}`);
  assert.ok(share <= .56 && seat.wide < EYE_TAN_HALF_HORIZONTAL && seat.tall < EYE_TAN_HALF_VERTICAL, `swept lens share ${share}, horizontal reach ${seat.wide}`);
});
