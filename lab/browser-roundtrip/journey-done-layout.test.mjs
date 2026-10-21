import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { placementFromRoom } from './room-anchor.mjs';
import { SUBJECT_CENTRE_LENS, lensTangent } from './plate-standoff.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { HALF_IPD_METERS, createToolbarPanel, toolbarPlatePoints, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { cameraSnapshot } from './camera-snapshot.mjs';
import { journeySeatDetail } from './journey-seat-record.mjs';

/**
 * Failure C.
 *
 * Two wearer captures, both taken after Done, hold both eyes. In each of them the restored 4HHB
 * cartoon crosses the left-edge menu column and passes in front of the caption
 * plate, in both eyes. The published state says the placement Done restored is
 * the pre-journey one, so the defect is not a wrong placement: it is that
 * nothing re-applied the clearance rule after the restore, the way Reset, a
 * committed scale and a lesson tour's ending all do.
 *
 * This runs the shipped `restoreJourneySeat` closure over the shipped plate
 * geometry and the shipped clearance solver. Only Mol*'s draw, the toolbar's
 * re-seat and Fit are adapters.
 */
const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);

function closure(name, indent = '  ') {
  // The Done chain is asynchronous, its diagnostics record is not.
  const start = viewerSource.search(new RegExp(`^${indent}(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `missing ${name}`);
  return viewerSource.slice(start, viewerSource.indexOf(`\n${indent}}`, start) + indent.length + 2);
}

/**
 * A wearer standing in the pose the runs were captured from: the structure
 * seated straight ahead at a size whose projected disc swallows the menu column
 * and the caption plate beside it.
 */
function wedgedSession({ collapsed = false } = {}) {
  const headInRoom = Array.from(Mat4.fromRotation(Mat4(), .6, Vec3.create(0, 1, 0)));
  headInRoom[12] = .3; headInRoom[13] = 1.6; headInRoom[14] = .7;
  const head = { matrix: headInRoom, position: { x: .3, y: 1.6, z: .7 } };
  const basis = toolbarSeatBasis(head);
  const tour = { selectedId: 'hemoglobin-quaternary-structure', menuOpen: false, active: false, title: '', progress: '' };
  const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ tour, collapsed }),
    readout: runtime.tourReadout(tour, { title: 'Hemoglobin tetramer', pdbId: '4HHB', chains: 4,
      assembly: 'asymmetric_unit', selectionCount: 0, representation: 'cartoon', color: 'chain-id' }) });
  const renderFromRoom = Array.from(Mat4.fromRotation(Mat4(), -.4, Vec3.create(0, 1, 0)));
  renderFromRoom[12] = .4; renderFromRoom[13] = -.5; renderFromRoom[14] = .2;
  const center = [12, -7, 20], radius = 100, cameraScale = .01;
  const roomPoint = basis.origin.map((value, axis) => value + 3.8 * basis.forward[axis]);
  const placement = { scale: 1.7, rotation: [0, 0, 0],
    translation: applyMatrix4(roomPoint, renderFromRoom).map((value, axis) => (value / cameraScale - center[axis]) / radius) };
  const points = toolbarPlatePoints(panel);
  // The per-eye gap between the structure's projected disc and the inboard
  // edge of the panel's own glass. Negative is the overprint the capture shows.
  const gapsFor = seat => {
    const seatRoom = applyMatrix4(center.map((value, axis) => (value + seat.translation[axis] * radius) * cameraScale),
      invertMatrix4(renderFromRoom));
    const r = radius * cameraScale * seat.scale;
    return [-1, 1].map(side => {
      const eye = basis.origin.map((value, axis) => value + side * HALF_IPD_METERS * basis.right[axis]);
      const relative = point => point.map((value, axis) => value - eye[axis]);
      const v = relative(seatRoom), x = dot(v, basis.right), z = dot(v, basis.forward);
      return Math.min(...(points.plates ?? [points]).map(plate => {
        const rays = plate.map(relative);
        let gap = -Infinity;
        for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
          const normal = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), rays[i], rays[j]));
          for (const sign of [-1, 1]) if (rays.every(ray => sign * dot(ray, normal) <= 1e-10))
            gap = Math.max(gap, sign * dot(v, normal) - r);
        }
        return gap;
      }));
    });
  };
  return { basis, panel, points, placement, center, radius, cameraScale, headInRoom, renderFromRoom, gapsFor };
}

/** A complete Mol* capture, as the panel saves one. */
const savedCamera = { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 };

function session({ presenting = true, scene = { camera: savedCamera }, collapsed = false, seat, large = false, menuRender } = {}) {
  const world = wedgedSession({ collapsed });
  // A bounded overlap keeps the clearance contract test meaningful. The
  // original oversized sphere is exercised separately as an entry fallback.
  if (!large) {
    world.placement.scale = .25;
    world.points.splice(0, world.points.length, ...[-.3, -.05].flatMap(x => [-.2, .2].map(y =>
      world.basis.origin.map((v, i) => v + x * world.basis.right[i] + y * world.basis.up[i] + world.basis.forward[i]))));
  }
  if (!large) delete world.points.plates;
  const calls = { fits: 0, cameraFits: 0, seats: 0, places: [], menuOptions: [], placementReleases: [] };
  const roomEntry = {};
  let placement = { ...world.placement, ...(seat ?? {}) };
  const context = vm.createContext({
    Array, Math, Error, Boolean,
    resetViewPlacement, cameraSnapshot, structuredClone, roomEntry, applyMatrix4, Mat4,
    releaseWearerPlacement: reason => { calls.placementReleases.push(reason); },
    scientificRepresentations: () => [], presentationTransform: () => Mat4.identity(), placementTransform: () => Mat4.identity(),
    canvas: { xr: { isPresenting: { value: presenting } }, camera: { scale: world.cameraScale } },
    latestRoomPlacementPose: { headInRoom: world.headInRoom, renderFromRoom: world.renderFromRoom },
    loadedSphere: () => ({ center: world.center, radius: world.radius }),
    inspectionSnapshot: () => ({ placement }),
    immersiveSession: { platePoints: () => world.points },
    fitInspection: async () => { calls.cameraFits++; },
    seatStructureForEntry: async options => {
      assert.equal(options.bounded, true); calls.fits++;
      placement = { ...world.placement, scale: .25 };
      const fitted = resetViewPlacement({ seat: placement, points: large ? [] : world.points,
        headInRoom: world.headInRoom, renderFromRoom: world.renderFromRoom,
        center: world.center, radius: world.radius, cameraScale: world.cameraScale });
      placement = fitted;
    },
    restoreTourSeat: async options => { await menuRender?.(); calls.seats++; calls.menuOptions.push(options); },
    placeInspection: async (patch, action) => {
      calls.places.push({ patch, action });
      placement = { ...placement, ...patch };
    },
  });
  context.journeySeatDetail = journeySeatDetail;
  for (const name of ['restoreJourneySeat', 'recordJourneySeat']) vm.runInContext(closure(name), context);
  return { world, calls, run: () => context.restoreJourneySeat({ scene }), seat: () => placement, roomEntry };
}

test('Done clears the restored structure off the menu and the caption in both eyes', async () => {
  const s = session();
  const before = s.world.gapsFor(s.world.placement);
  assert.ok(before.some(gap => gap < 0), 'the captured seat overprints the panel in at least one eye');
  await s.run();
  assert.equal(s.calls.places.length, 1, 'one clearance move, not a re-seat every frame');
  assert.equal(s.calls.places[0].action, 'journey-end');
  const after = s.seat();
  assert.equal(after.scale, s.world.placement.scale, 'clearance retains the restored size');
  assert.deepEqual(after.rotation, s.world.placement.rotation, 'clearance retains the restored rotation');
  assert.ok(s.world.gapsFor(after).every(gap => gap > 0), 'both eyes clear the drawn menu and caption glass');
  assert.equal(s.calls.seats, 1, 'the resting menu column is put back, as a lesson tour ending does');
  assert.equal(s.calls.fits, 0, 'a saved pose is returned to, never overwritten by Fit');
});

// Each of these is a saved view the renderer's own validator refuses, so none
// of them names a framing Done could return the wearer to.
for (const [name, scene] of [
  ['no saved scene at all', null],
  ['a capture with no camera', {}],
  ['an eye sitting on its own target', { camera: { ...savedCamera, position: [0, 0, 0] } }],
  ['a camera whose up is parallel to its view', { camera: { ...savedCamera, up: [0, 0, 1] } }],
]) test(`Done fits when the saved view named no pose to return to: ${name}`, async () => {
  const s = session({ scene });
  await s.run();
  assert.equal(s.calls.fits, 1, 'no saved pose means Fit, not the chapter framing');
  assert.ok(s.world.gapsFor(s.seat()).every(gap => gap > 0), 'the fitted view still clears the panel');
  assert.equal(s.calls.seats, 1);
});

test('a seat that already clears the panel is left exactly where the journey found it', async () => {
  const setup = session();
  const world = setup.world;
  const shifted = resetViewPlacement({ seat: world.placement, points: world.points, headInRoom: world.headInRoom,
    renderFromRoom: world.renderFromRoom, cameraScale: world.cameraScale, center: world.center, radius: world.radius });
  const moved = session();
  await moved.run();
  assert.deepEqual(moved.seat().translation, shifted.translation, 'the clearance is the solver\'s, not this test\'s');
  const already = session({ seat: { translation: shifted.translation } });
  await already.run();
  assert.equal(already.calls.places.length, 0, 'an already-clear seat does not move');
  assert.equal(already.calls.seats, 1, 'and the menu column is still restored');
});

test('outside an immersive session the journey ending re-seats the menu and moves nothing', async () => {
  const s = session({ presenting: false });
  await s.run();
  assert.equal(s.calls.places.length, 0);
  assert.equal(s.calls.seats, 1);
  assert.deepEqual(s.seat(), s.world.placement);
});

// A device run retained placements and projected centres, but no raw XR matrices
// or molecular buffers. Reconstruct a yaw-only room mapping (63 mm IPD) that
// reproduces those centres and the old sphere shift; this is not a device mesh.
test('row 6 reproduces 0.9243 / 0.8863 and requires the bounded entry fallback', () => {
  const recorded = { frame: { menu: { clear: true } }, eyes: [
    { subjectX: .9243, subjectY: .0567, subjectHalfWidth: .0755, subjectHalfHeight: .1489,
      menuX: -.0312, menuY: -.0448, menuHalfWidth: .0795, menuHalfHeight: .0973, clearance: .8004 },
    { subjectX: .8863, subjectY: .0454, subjectHalfWidth: .0461, subjectHalfHeight: .0965,
      menuX: -.0486, menuY: -.0448, menuHalfWidth: .0799, menuHalfHeight: .0973, clearance: .8088 },
  ] };
  assert.equal(recorded.frame.menu.clear, true);
  for (const eye of recorded.eyes) {
    assert.ok(Math.abs(Math.abs(eye.subjectX - eye.menuX) - eye.subjectHalfWidth - eye.menuHalfWidth - eye.clearance) < .0002);
    assert.ok(eye.subjectX > lensTangent(SUBJECT_CENTRE_LENS), 'a clear menu alone did not prove a comfortable subject');
  }
  const before = { translation: [3.534342595101174, .3913907702699335, -1.5964784566972445],
    scale: 1.817021190808593, rotation: [0, 0, 0] };
  const after = [7.675740786999276, .3913907702699335, -1.6210855526875758];
  const cameraScale = .33, radius = 1, center = [0, 0, 0];
  const delta = after.map((v, i) => v - before.translation[i]), length = Math.hypot(...delta);
  const right = delta.map(v => v / length), forward = [right[2], 0, -right[0]];
  const depth = 2 * HALF_IPD_METERS / (.9243 - .8863), x = depth * (.9243 + .8863) / 2;
  const origin = after.map((v, i) => v * cameraScale - x * right[i] - depth * forward[i]);
  const headInRoom = [right[0], 0, right[2], 0, 0, 1, 0, 0, -forward[0], 0, -forward[2], 0, ...origin, 1];
  const renderFromRoom = Array.from(Mat4.identity());
  const r = before.scale * cameraScale;
  // Solve the caption's reconstructed inboard edge from the observed sphere
  // shift, retaining the solver's existing one-degree air margin.
  const eyeX = x + HALF_IPD_METERS;
  const edge = (eyeX * depth - r * Math.sqrt(eyeX * eyeX + depth * depth - r * r)) / (depth * depth - r * r);
  const captionX = edge - Math.tan(Math.PI / 180) - HALF_IPD_METERS;
  const points = [-.12, captionX].flatMap(px => [-.15, .15].map(y => origin.map((v, i) =>
    v + px * right[i] + y * (i === 1 ? 1 : 0) + forward[i])));
  const options = { seat: before, points, headInRoom, renderFromRoom, cameraScale, center, radius };
  const legacy = resetViewPlacement(options);
  assert.ok(legacy.translation.every((v, i) => Math.abs(v - after[i]) < 1e-9));
  const projected = seat => [-1, 1].map(side => {
    const relative = seat.translation.map((v, i) => v * cameraScale - origin[i] - side * HALF_IPD_METERS * right[i]);
    return dot(relative, right) / dot(relative, forward);
  });
  assert.ok(projected(legacy).every((v, i) => Math.abs(v - [.9243, .8863][i]) < 1e-9));
  assert.throws(() => resetViewPlacement({ ...options, seat: legacy, centered: true }), /within 4 m/u,
    'capturing the off-screen dodge as entry makes the forward-only Reset refuse before its success diagnostic');
  const bounded = resetViewPlacement({ ...options, bounded: true });
  assert.equal(bounded, undefined, 'the caption cannot clear inside SUBJECT_CENTRE_LENS; use the entry/Fit route');
  // The same entry fit and bounded fallback used by roomAnchorPlacement.
  const entry = placementFromRoom({ ...options, mode: 'auto', floorY: null });
  const fitted = resetViewPlacement({ ...options, seat: entry, bounded: true }) ?? entry;
  assert.ok(projected(fitted).every(x => Math.abs(x) <= lensTangent(SUBJECT_CENTRE_LENS)));
  console.log('row-6 reconstructed fixture', JSON.stringify({ legacy: projected(legacy),
    fitted: projected(fitted), translation: fitted.translation, scale: fitted.scale,
    centreLimitTangent: lensTangent(SUBJECT_CENTRE_LENS) }));
});


test('an oversized restored sphere shrinks to clear the full glass inside the centre band without changing the XR camera', async () => {
  const s = session({ large: true });
  await s.run();
  assert.equal(s.calls.fits, 0);
  assert.equal(s.calls.cameraFits, 0);
  assert.equal(s.calls.places.length, 1);
  assert.ok(s.seat().scale < s.world.placement.scale);
  assert.ok(s.world.gapsFor(s.seat()).every(gap => gap > 0));
  assert.deepEqual(s.roomEntry.seat, s.world.placement, 'Reset keeps the restored target and may refit it');
});


test('Done keeps the pre-clearance entry and waits for the menu render before publishing Reset state', async () => {
  let finish;
  const rendered = new Promise(resolve => { finish = resolve; });
  const s = session({ menuRender: () => rendered });
  const done = s.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.roomEntry.seat, undefined, 'no Reset target before the menu render completes');
  assert.deepEqual(s.calls.placementReleases, [], 'the pending draw must retain the wearer placement hold');
  finish(); await done;
  assert.deepEqual(s.calls.placementReleases, ['entry-seat']);
  assert.deepEqual(s.roomEntry.seat.translation, s.world.placement.translation);
  assert.notDeepEqual(s.roomEntry.seat.translation, s.seat().translation);
  assert.equal(s.calls.cameraFits, 0);
});

test('failed Done rendering cannot publish a new Reset target', async () => {
  const s = session({ menuRender: () => { throw Error('menu render failed'); } });
  const old = { translation: [1, 2, 3], rotation: [0, 0, 0], scale: 1 };
  s.roomEntry.seat = old;
  await assert.rejects(s.run(), /menu render failed/u);
  assert.equal(s.roomEntry.seat, old);
  assert.deepEqual(s.calls.placementReleases, [], 'failed Done must retain the wearer placement hold');
});
