import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
import { headViewBasis, placementFromRoom } from './room-anchor.mjs';
import { measurePlateSeat } from './plate-seat.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { preserveSourceTransitionAnchor } from './source-transition-anchor.mjs';
import { createInspectionState } from './inspection-state.mjs';
import { LABEL_CHARACTER_DEGREES } from './label-facing.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { HALF_IPD_METERS, createToolbarPanel, toolbarPlatePoints, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { syntheticViews } from './fixtures/component-label-diagnostics.mjs';
import { demoSourceIdentity } from './demo-source-identity.mjs';

/**
 * An agent's source swap on a real Quest 2: the wearer had 4HHB seated beside
 * the menu, asked to zoom in on the hemes, then asked for 1CRN. The transition
 * anchor kept 4HHB's zoomed room diameter, so crambin, half hemoglobin's
 * radius, arrived at that diameter, about twice its entry size, over the menu.
 *
 * This runs the shipped `seatSwappedSource` and `roomAnchorPlacement` closures
 * over the shipped toolbar glass, seat solver and anchor arithmetic. Mol*'s
 * draw is the only adapter; a plain structure draws no name plates.
 */
const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);

function closure(name) {
  const start = viewerSource.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `missing ${name}`);
  return viewerSource.slice(start, viewerSource.indexOf('\n  }', start) + 4);
}

// Roughly 4HHB's asymmetric unit and 1CRN, as bounding spheres in Angstroms,
// and the XR scene scale the hardware run entered 4HHB at.
const HEMOGLOBIN = { center: [8, 21, 4], radius: 34, sites: 4779 };
const CRAMBIN = { center: [9, 10, 7], radius: 17, sites: 327 };
const CAMERA_SCALE = 0.02348;

function wearer() {
  const headInRoom = Array.from(Mat4.fromRotation(Mat4(), .3, Vec3.create(0, 1, 0)));
  headInRoom[12] = .2; headInRoom[13] = 1.6; headInRoom[14] = .4;
  const head = { matrix: headInRoom, position: { x: .2, y: 1.6, z: .4 } };
  const tour = { selectedId: 'hemoglobin-quaternary-structure', menuOpen: false, active: false, title: '', progress: '' };
  const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ tour, collapsed: false }),
    readout: runtime.tourReadout(tour, { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chains: 4,
      assembly: 'asymmetric_unit', selectionCount: 0, representation: 'cartoon', color: 'chain-id' }) });
  const renderFromRoom = Array.from(Mat4.fromRotation(Mat4(), -.2, Vec3.create(0, 1, 0)));
  renderFromRoom[12] = .3; renderFromRoom[13] = -.4; renderFromRoom[14] = .1;
  return { headInRoom, renderFromRoom, basis: toolbarSeatBasis(head), points: toolbarPlatePoints(panel) };
}

function viewer(world) {
  const inspectionState = createInspectionState();
  const labelViews = syntheticViews().map(view => {
    const matrix = Mat4.mul(Mat4(), world.renderFromRoom, Mat4.mul(Mat4(), world.headInRoom, view.transform.matrix));
    return { ...view, transform: { matrix, inverse: { matrix: Mat4.invert(Mat4(), matrix) } } };
  });
  const context = vm.createContext({
    Array, Map, Math, Number, Error, Boolean, Object, performance, structuredClone, Mat4, Vec3,
    headViewBasis, placementFromRoom, measurePlateSeat, resetViewPlacement, LABEL_CHARACTER_DEGREES,
    // Plate text size only enters the seat through a plate, and none is drawn.
    xrLabelSizing: () => ({ characterUnits: 1 }), componentLabelTextWidth: () => 0,
    emphasisState: { parts: [] }, componentLabelsWanted: () => false,
    plugin: {}, sessionDeviceClass: () => 'quest2', structureAtomSites: () => context.sphere.sites,
    canvas: { camera: { scale: CAMERA_SCALE, getSnapshot: () => ({}) }, webgl: {}, xr: { isPresenting: { value: true } } },
    latestRoomPlacementPose: { headInRoom: world.headInRoom, renderFromRoom: world.renderFromRoom, labelViews },
    scientificRepresentations: () => [],
    presentationTransform: () => context.placementTransform(context.inspectionSnapshot().placement),
    latestHeadSample: performance.now(), latestSeatStandoffMeters: null, latestPlateSeat: null,
    roomAnchor: { floorY: () => null, applied: async value => { context.applied.push(value); } },
    roomEntry: {}, pendingRoomSeat: false, transforms: 0, sphere: HEMOGLOBIN, applied: [], records: [],
    __stereofoldDiagnostics: { record: (kind, detail) => { context.records.push({ kind, ...detail }); } },
    immersiveSession: { toolbarPlacementPoints: () => world.points },
    inspectionState, inspectionSnapshot: () => inspectionState.snapshot(),
    loadedSphere: () => ({ center: context.sphere.center, radius: context.sphere.radius }),
    applyInspectionTransform: () => { context.transforms++; },
  });
  for (const name of ['placementTransform', 'componentLabelViewBasis', 'roomAnchorPlacement', 'seatSwappedSource']) {
    vm.runInContext(closure(name), context);
  }
  return context;
}

/** The structure's sphere in the room: its centre, and its radius in metres. */
function roomSphere(world, sphere, placement) {
  return { center: applyMatrix4(sphere.center.map((value, axis) => (value + placement.translation[axis] * sphere.radius) * CAMERA_SCALE),
    invertMatrix4(world.renderFromRoom)), radius: sphere.radius * CAMERA_SCALE * placement.scale };
}

/** Angular radius from the head, which is the size the wearer sees. */
function apparent(world, room) {
  const head = world.basis.origin;
  return Math.asin(room.radius / Math.hypot(...room.center.map((value, axis) => value - head[axis])));
}

/** Per eye, the least clearance from any individual plate. Negative overlaps.
 * The forward card can clear vertically while the menu clears horizontally.
 * A rectangle around their union would falsely fill the gap with glass.
 */
function menuGaps(world, room) {
  const { basis, points } = world;
  return [-1, 1].map(side => {
    const eye = basis.origin.map((value, axis) => value + side * HALF_IPD_METERS * basis.right[axis]);
    const relative = point => point.map((value, axis) => value - eye[axis]);
    const v = relative(room.center), z = dot(v, basis.forward), r = room.radius;
    assert.ok(z > r, 'the structure stands in front of the eye');
    return Math.min(...points.plates.map(plate => Math.max(...[basis.right, basis.up].map(axis => {
      const value = dot(v, axis), spread = r * Math.sqrt(value * value + z * z - r * r);
      const denominator = z * z - r * r;
      const low = (value * z - spread) / denominator, high = (value * z + spread) / denominator;
      const glass = plate.map(point => dot(relative(point), axis) / dot(relative(point), basis.forward));
      return Math.max(low - Math.max(...glass), Math.min(...glass) - high);
    }))));
  });
}

/** 4HHB takes the entry seat, then a focus zooms it toward the wearer and the menu. */
function zoomedHemoglobin() {
  const world = wearer();
  const v = viewer(world);
  const entry = v.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: HEMOGLOBIN });
  v.inspectionState.place({ translation: entry.translation, scale: entry.scale }, 'entry-seat');
  const entered = roomSphere(world, HEMOGLOBIN, v.inspectionSnapshot().placement);
  const head = world.basis.origin;
  const focus = entered.center.map((value, axis) => head[axis] + .75 * (value - head[axis]) - .15 * world.basis.right[axis]);
  const translation = applyMatrix4(focus, world.renderFromRoom)
    .map((value, axis) => (value / CAMERA_SCALE - HEMOGLOBIN.center[axis]) / HEMOGLOBIN.radius);
  const zoomed = { translation, rotation: [0, 35, 0], scale: Math.min(4, entry.scale * 1.6) };
  v.inspectionState.place(zoomed, 'grab');
  const anchor = preserveSourceTransitionAnchor({ priorBase: HEMOGLOBIN, priorVisible: HEMOGLOBIN, priorPlacement: zoomed,
    priorCameraScale: CAMERA_SCALE, nextBase: CRAMBIN, nextVisible: CRAMBIN });
  // What `load` does for an agent's swap before the seat: a fresh inspection
  // state, then the anchor at the entry orientation.
  v.sphere = CRAMBIN;
  v.inspectionState.reset({ representation: 'cartoon' });
  v.inspectionState.place({ ...anchor.placement, rotation: v.inspectionSnapshot().placement.rotation }, 'source-transition');
  return { world, v, entered, anchor };
}

test('a swap to a smaller structure takes the entry seat instead of the zoomed diameter', () => {
  const { world, v, entered, anchor } = zoomedHemoglobin();
  assert.ok(menuGaps(world, entered).every(gap => gap > 0), 'the entry seat clears every plate in both eyes');
  const caption = world.points.plates[0];
  const underCard = { center: [0, 1, 2].map(axis => caption.reduce((sum, point) => sum + point[axis], 0) / caption.length), radius: .01 };
  assert.ok(menuGaps(world, underCard).every(gap => gap < 0),
    'the same witness rejects a subject inside the overhead card in both eyes');
  assert.equal(anchor.usedCameraScale, false, 'as on the headset, the scene scale is unchanged');
  const anchored = roomSphere(world, CRAMBIN, anchor.placement);
  assert.ok(apparent(world, anchored) > 1.5 * apparent(world, entered), 'the anchor alone grows crambin past the entry size');

  const seat = v.seatSwappedSource(anchor);
  assert.ok(seat, 'a tracked pose seats the swap before its first frame');
  assert.equal(v.pendingRoomSeat, false);
  assert.equal(v.transforms, 1, 'the seat measures the transform the geometry carries');
  assert.deepEqual(v.applied.map(value => value.roomPoint), [seat.roomPoint], 'the room anchor measures drift from the new seat');
  assert.deepEqual(v.records, [{ kind: 'source-anchor', anchor: 'entry-seat', anchoredScale: anchor.placement.scale,
    scale: seat.scale, metersAcross: Math.round(seat.metersAcross * 100) / 100 }]);
  const placed = v.inspectionSnapshot().placement;
  assert.deepEqual(placed.rotation, [0, 0, 0], 'the zoomed orientation is not carried over');

  const fresh = v.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: CRAMBIN });
  assert.deepEqual({ translation: placed.translation, scale: placed.scale },
    { translation: fresh.translation, scale: fresh.scale }, 'the seat a fresh load of crambin gets');
  const swapped = roomSphere(world, CRAMBIN, placed);
  assert.ok(apparent(world, swapped) <= apparent(world, entered) * 1.01,
    `crambin (${apparent(world, swapped)} rad) is no larger than 4HHB entered (${apparent(world, entered)} rad)`);
  assert.ok(menuGaps(world, swapped).every(gap => gap > 0), 'crambin clears the menu in both eyes');
});

test('a retained plain seat derives missing measurements through the current room mapping without moving', () => {
  const world = wearer(), v = viewer(world);
  const initial = v.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: HEMOGLOBIN });
  const pose = { translation: Array.from(initial.translation), rotation: [12, -24, 7], scale: initial.scale };
  v.inspectionState.place(pose, 'retained source'); v.roomEntry.seat = structuredClone(pose);
  // Isolate the solver's valid plain-pose return contract. The reset overlap
  // regression separately executes the real zero-motion geometry admission.
  v.resetViewPlacement = options => options.seat;
  v.canvas.camera.scale = CAMERA_SCALE * 1.3;
  const result = v.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: HEMOGLOBIN, resetMenu: true });
  const roomPoint = applyMatrix4(HEMOGLOBIN.center.map((value, axis) =>
    (value + pose.translation[axis] * HEMOGLOBIN.radius) * v.canvas.camera.scale), invertMatrix4(world.renderFromRoom));
  const depth = dot(roomPoint.map((value, axis) => value - world.headInRoom[12 + axis]), world.headInRoom.slice(8, 11).map(value => -value));
  assert.deepEqual(Array.from(result.roomPoint), roomPoint);
  assert.equal(result.metersAcross, 2 * HEMOGLOBIN.radius * v.canvas.camera.scale * pose.scale);
  assert.ok(Math.abs(result.standoffMeters - depth) < 1e-12);
  assert.equal(result.mode, 'auto');
  assert.deepEqual(v.inspectionSnapshot().placement, pose);
  assert.deepEqual(v.roomEntry.seat, pose);
  // Complete solver measurements remain authoritative rather than being
  // overwritten by a generic normalization or a previous camera scale.
  const measured = { ...pose, roomPoint: [3, 2, -4], metersAcross: .8, standoffMeters: 3, mode: 'above' };
  v.resetViewPlacement = () => measured;
  const preserved = v.roomAnchorPlacement({ mode: 'auto', floorY: null, sphere: HEMOGLOBIN, resetMenu: true });
  assert.deepEqual(Array.from(preserved.roomPoint), measured.roomPoint);
  assert.equal(preserved.metersAcross, .8); assert.equal(preserved.standoffMeters, 3); assert.equal(preserved.mode, 'above');
});

for (const [name, reason, spoil] of [
  ['no tracked pose', 'no fresh tracked pose', (v) => { v.latestRoomPlacementPose = null; }],
  ['a stale tracked pose', 'no fresh tracked pose', (v) => { v.latestHeadSample = performance.now() - 5000; }],
  ['a scene-scale change that has not been drawn yet', 'scene scale changed', (_v, anchor) => { anchor.usedCameraScale = true; }],
  ['a rebased render origin', 'scene scale changed', (_v, anchor) => { anchor.cameraOffset = [1, 0, 0]; }],
  ['a seat the menu refuses', 'Could not reset: no room beside the menu.',
    (v) => { v.resetViewPlacement = () => { throw Error('Could not reset: no room beside the menu.'); }; }],
]) test(`a swap with ${name} leaves the seat to the next tracked frame`, () => {
  const { v, anchor } = zoomedHemoglobin();
  spoil(v, anchor);
  const before = v.inspectionSnapshot().placement;
  assert.equal(v.seatSwappedSource(anchor), undefined);
  assert.equal(v.pendingRoomSeat, true, '`settleInRoom` seats it, with its refusal handling');
  assert.deepEqual(v.inspectionSnapshot().placement, before);
  assert.deepEqual(v.applied, []);
  assert.deepEqual(v.records, [{ kind: 'source-anchor', anchor: 'entry-seat-next-frame', reason }]);
});

test('a lesson tier keeps the room anchor; only an agent swap asks for the entry seat', () => {
  const load = closure('load');
  const anchored = load.slice(load.indexOf('if (sourceAnchor) {'), load.indexOf("after_room_anchor"));
  assert.match(anchored, /if \(settings\.seatForEntry && !sourceAnchor\.preservesCoordinateFrame\) \{[\s\S]*seatSwappedSource\(sourceAnchor, \{ deferAnchor: true \}\);[\s\S]*\} else \{[\s\S]*inspectionState\.place\(sourceAnchor\.placement, 'source-transition'\);[\s\S]*pendingGrowthTurn = !sourceAnchor\.preservesCoordinateFrame;/);
});

test('the workspace asks for the entry seat only for a swap it anchors in the room', async () => {
  const workspaceSource = readFileSync(new URL('../inspection/workspace.mjs', import.meta.url), 'utf8');
  const start = workspaceSource.indexOf('async function loadSource(');
  const source = workspaceSource.slice(start, workspaceSource.indexOf('\n}', start) + 2);
  const element = () => ({ dataset: {}, value: '', textContent: '', hidden: false, className: '',
    replaceChildren() {}, append() {} });
  const next = { id: 'session', catalog: { modelNumbers: [1], assemblyId: '1' } };
  for (const [presenting, seatForEntry, expected] of [[true, true, true], [true, false, undefined], [false, true, undefined]]) {
    const loads = [];
    const context = vm.createContext({
      demoSourceIdentity, run: async (_label, action) => action(), $: element, document: { body: { dataset: {} }, createElement: element,
        createTextNode: text => text }, currentRows: () => [], options: { enableXr: true }, renderSequence() {},
      viewer: { snapshot: () => ({ ready: true, xrPresenting: presenting }), inspection: { capture: () => ({}) },
        load: async (_next, settings) => { loads.push(settings); } },
    });
    vm.runInContext(source, context);
    await context.loadSource(next, { preserveCamera: true, seatForEntry });
    assert.equal(loads[0].seatForEntry, expected, `presenting ${presenting}, seatForEntry ${seatForEntry}`);
    assert.equal(loads[0].preserveRoomPlacement, presenting ? true : undefined);
  }
});
