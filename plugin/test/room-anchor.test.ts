import { describe, expect, it } from 'vitest';
// @ts-ignore Shared XR room-anchoring implementation, exercised without a headset runtime.
import { plateSeatLimits } from '../../lab/browser-roundtrip/plate-seat.mjs';
// @ts-ignore Shared import-free plate field.
import { PLATE_FIELD } from '../../lab/browser-roundtrip/label-layout.mjs';
// @ts-ignore Shared XR room-anchoring implementation, exercised without a headset runtime.
import { anchorScene, createRoomAnchor, entrySeat, findFloor, monumentalMeters, placementFromRoom, planeArea, reachFraction, resolveMode, roomAnchorEnabled, shouldReplace, ENTRY_ELEVATION_DEGREES, ENTRY_STANDOFF_RANGE, ENTRY_VIEW_DEGREES, FLOORLESS_SETTLE_MS } from '../../lab/browser-roundtrip/room-anchor.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, y: number, z: number) => [...identity.slice(0, 12), x, y, z, 1];
/** A head 1.6 m up, looking down -Z, in a room whose floor is at y = 0. */
const head = at(0, 1.6, 0);
const square = (half: number) => [{ x: -half, y: 0, z: -half }, { x: half, y: 0, z: -half },
  { x: half, y: 0, z: half }, { x: -half, y: 0, z: half }];

function plane(y: number, half: number, extra: Record<string, unknown> = {}) {
  return { orientation: 'horizontal', planeSpace: { y }, polygon: square(half), ...extra };
}

/** A frame whose `getPose` reports each plane at its own height, normal up. */
function frameOf(planes: unknown[], options: { viewerY?: number; upsideDown?: Set<unknown> } = {}) {
  return {
    detectedPlanes: new Set(planes),
    getViewerPose: () => options.viewerY === undefined ? null
      : { transform: { position: { y: options.viewerY } } },
    getPose: (space: any) => {
      if (!space || typeof space.y !== 'number') return null;
      const flipped = options.upsideDown?.has(space) ? -1 : 1;
      return { transform: { matrix: [1, 0, 0, 0, 0, flipped, 0, 0, 0, 0, flipped, 0, 0, space.y, 0, 1] } };
    },
  };
}

describe('finding the floor in a detected room', () => {
  it('picks the largest horizontal plane below the head and ignores the table on it', () => {
    const floor = plane(0, 2), table = plane(0.75, 0.6);
    const found = findFloor(frameOf([table, floor]), null, {}, { headY: 1.6 });
    expect(found?.y).toBe(0);
    expect(found?.area).toBeCloseTo(16);
    expect(found?.planeCount).toBe(2);
  });

  it('reads head height from the frame when the caller does not supply one', () => {
    const found = findFloor(frameOf([plane(0, 2)], { viewerY: 1.6 }), null, {});
    expect(found?.y).toBe(0);
  });

  it('rejects a ceiling that reports the same horizontal orientation', () => {
    const ceiling = plane(2.6, 3);
    const upsideDown = new Set([ceiling.planeSpace]);
    // Read from a head that is itself below the ceiling, so only the normal
    // and not the height can disqualify it.
    expect(findFloor(frameOf([ceiling], { upsideDown }), null, {}, { headY: 4 })).toBeNull();
  });

  it('accepts the unlabelled plane an emulator reports with no orientation at all', () => {
    // IWER 2.3.0 derives `orientation` from the semantic label, so a plane
    // without a label has none. The plane's own normal decides instead.
    const bare = { planeSpace: { y: 0 }, polygon: square(2) };
    expect(findFloor(frameOf([bare]), null, {}, { headY: 1.6 })?.y).toBe(0);
  });

  it('discards a plane the runtime labelled as the ceiling', () => {
    const ceiling = plane(0, 4, { semanticLabel: 'ceiling' });
    expect(findFloor(frameOf([ceiling]), null, {}, { headY: 1.6 })).toBeNull();
  });

  it('prefers a runtime-labelled floor over a larger unlabelled plane', () => {
    const labelled = plane(0.02, 1, { semanticLabel: 'floor' }), bigger = plane(-0.4, 4);
    expect(findFloor(frameOf([bigger, labelled]), null, {}, { headY: 1.6 })?.y).toBeCloseTo(0.02);
  });

  it('falls back to null rather than throwing when the runtime has no plane detection', () => {
    expect(findFloor({ getPose: () => null }, {}, {}, { headY: 1.6 })).toBeNull();
    expect(findFloor(frameOf([]), { detectedPlanes: undefined }, {})).toBeNull();
    expect(findFloor(null as any, null, null)).toBeNull();
    // A frame that throws on every access is still a fallback, not a crash.
    const hostile = new Proxy({}, { get() { throw Error('no room understanding here'); } });
    expect(findFloor(hostile as any, null, {})).toBeNull();
  });

  it('measures a polygon area only when it is a real polygon', () => {
    expect(planeArea(square(1))).toBeCloseTo(4);
    expect(planeArea([{ x: 0, z: 0 }, { x: 1, z: 0 }])).toBe(0);
    expect(planeArea(undefined)).toBe(0);
  });
});

describe('monumental placement against the real floor', () => {
  // 1 Å of radius maps to 0.01 m, so a 100 Å radius structure is 2 m across at scale 1.
  const scene = { headInRoom: head, renderFromRoom: identity, cameraScale: 0.01, center: [0, 0, 0], radius: 100 };

  it('stands a 40,000-site Quest 2 scene with its base on the detected floor', () => {
    const placed = placementFromRoom({ ...scene, mode: 'floor', floorY: 0, siteCount: 40_000, deviceClass: 'quest2' });
    expect(placed.mode).toBe('floor');
    expect(placed.floorLocked).toBe(true);
    expect(placed.metersAcross).toBeCloseTo(2.4);
    // Base on the floor means the centre sits one radius up.
    expect(placed.roomPoint[1]).toBeCloseTo(1.2);
    // In front of the wearer, along the head's own -Z, never on top of them.
    expect(placed.roomPoint[2]).toBeCloseTo(-placed.standoffMeters);
    expect(placed.standoffMeters).toBeCloseTo(2.28);
    expect(2 * scene.radius * scene.cameraScale * placed.scale).toBeCloseTo(2.4);
  });

  it('hangs a 177,000-site Quest 3 lattice above the wearer with real floor clearance', () => {
    // Overhead is now asked for by name; the automatic seat is `above`.
    const placed = placementFromRoom({ ...scene, mode: 'overhead', floorY: 0, siteCount: 177_000, deviceClass: 'quest3' });
    expect(placed.mode).toBe('overhead');
    expect(placed.metersAcross).toBeCloseTo(3.977, 2);
    expect(placed.roomPoint[0]).toBe(0);
    expect(placed.roomPoint[2]).toBeLessThan(0);
    expect(Math.atan2(placed.roomPoint[1] - scene.headInRoom[13],
      Math.hypot(placed.roomPoint[0], placed.roomPoint[2])) * 180 / Math.PI).toBeCloseTo(65);
    // 2.2 m of clear air under it, whatever the wearer's own height is.
    expect(placed.roomPoint[1] - placed.metersAcross / 2).toBeCloseTo(2.2);
    expect(placementFromRoom({ ...scene, mode: 'overhead', headInRoom: at(0, 1.1, 0), floorY: 0, siteCount: 177_000,
      deviceClass: 'quest3' }).roomPoint[1]).toBeCloseTo(placed.roomPoint[1]);
  });

  it('draws the same lattice smaller on a Quest 2 than on a Quest 3', () => {
    const lattice = { siteCount: 177_000, mode: 'overhead' as const };
    expect(monumentalMeters({ ...lattice, deviceClass: 'quest3' })).toBeGreaterThan(
      monumentalMeters({ ...lattice, deviceClass: 'quest2' }));
    expect(monumentalMeters({ ...lattice, deviceClass: 'quest2' })).toBeCloseTo(2.514, 2);
    // The shrink never falls past the size that stops it being monumental.
    expect(monumentalMeters({ mode: 'overhead', siteCount: 4_000_000, deviceClass: 'quest2' })).toBe(2);
    expect(monumentalMeters({ mode: 'floor', siteCount: 40_000, deviceClass: 'quest2' })).toBe(2.4);
  });

  it('gives a small source the full requested room size and floor position', () => {
    const small = placementFromRoom({ ...scene, radius: 5, mode: 'floor', floorY: 0, siteCount: 900 });
    expect(small.scale).toBeCloseTo(24);
    expect(small.metersAcross).toBeCloseTo(2.4);
    expect(small.roomPoint[1]).toBeCloseTo(1.2);
    expect(small.floorLocked).toBe(true);
    expect(small.standoffMeters).toBeCloseTo(2.28);
    expect(small.reach).toBe(1);
    expect(small.clamped).toBe(false);
  });

  it('falls back to the head-relative placement when no floor was detected', () => {
    const placed = placementFromRoom({ ...scene, mode: 'overhead', floorY: null, siteCount: 177_000 });
    expect(placed.floorLocked).toBe(false);
    // Exactly the height `room-placement.mjs` already uses: three metres over the head.
    expect(placed.roomPoint[1]).toBeCloseTo(4.6);
    const grounded = placementFromRoom({ ...scene, mode: 'floor', floorY: null, siteCount: 900 });
    expect(grounded.floorLocked).toBe(false);
    expect(grounded.roomPoint[1]).toBeCloseTo(1.6);
  });

  it('reports a clamped translation rather than claiming the scene is floor-locked', () => {
    // Only an extreme source-to-room conversion reaches the numerical bound.
    const placed = placementFromRoom({ ...scene, radius: 1e-7, mode: 'floor', floorY: -1.4, siteCount: 10 });
    expect(placed.clamped).toBe(true);
    expect(placed.floorLocked).toBe(false);
    expect(placed.translation.every((value: number) => Math.abs(value) <= 1e6)).toBe(true);
  });

  it('keeps a requested overhead lattice above the wearer without the old radius barrier', () => {
    const placed = placementFromRoom({ ...scene, radius: 20, mode: 'overhead', floorY: 0, siteCount: 900 });
    expect(placed.reach).toBe(1);
    // Still above the head, never dropped through it.
    expect(placed.roomPoint[1]).toBeGreaterThan(1.6);
    expect(placed.roomPoint[1]).toBeCloseTo(4.2);
    expect(placed.floorLocked).toBe(true);
  });

  it('places in front of a head that is looking straight down instead of onto the wearer', () => {
    const lookingDown = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 1.6, 0, 1];
    const placed = placementFromRoom({ ...scene, headInRoom: lookingDown, mode: 'floor', floorY: 0, siteCount: 900 });
    expect(Math.hypot(placed.roomPoint[0], placed.roomPoint[2])).toBeCloseTo(placed.standoffMeters);
  });

  it('refuses a pose it cannot trust rather than guessing a room position', () => {
    expect(() => placementFromRoom({ ...scene, cameraScale: NaN, floorY: 0 })).toThrow();
    expect(() => placementFromRoom({ ...scene, radius: 0, floorY: 0 })).toThrow();
    expect(() => placementFromRoom({ ...scene, headInRoom: [1, 2, 3], floorY: 0 })).toThrow();
  });

  it('lets the caller override the size heuristic in both directions', () => {
    // The automatic seat is `above`. A structure standing on the floor in
    // front of the wearer gives a chest-height view instead.
    expect(resolveMode({ siteCount: 40_000 })).toBe('above');
    // A lattice gets the same seat, drawn smaller. Straight overhead is a
    // ninety-degree neck tilt, which is an empty frame for a level head.
    expect(resolveMode({ siteCount: 177_000 })).toBe('above');
    expect(resolveMode({ mode: 'floor', siteCount: 177_000 })).toBe('floor');
    expect(resolveMode({ mode: 'above', siteCount: 177_000 })).toBe('above');
    expect(resolveMode({ mode: 'overhead', siteCount: 900 })).toBe('overhead');
  });
});

describe('the entry seat: big, in front, above the eye line', () => {
  const scene = { headInRoom: head, renderFromRoom: identity, cameraScale: 0.01, center: [0, 0, 0], radius: 100 };
  const EYE = head[13];

  it('stands the structure back far enough to fill eighty degrees of view', () => {
    const seat = entrySeat(3.6);
    const line = Math.hypot(seat.distance, seat.rise);
    expect(2 * Math.atan(1.8 / line) * 180 / Math.PI).toBeCloseTo(ENTRY_VIEW_DEGREES, 6);
    expect(Math.atan2(seat.rise, seat.distance) * 180 / Math.PI).toBeCloseTo(ENTRY_ELEVATION_DEGREES, 6);
  });

  it('holds the angle the wearer tilts their head by, whatever the size', () => {
    for (const across of [1.2, 2.4, 3.6, 5]) {
      const seat = entrySeat(across);
      expect(Math.atan2(seat.rise, seat.distance) * 180 / Math.PI).toBeCloseTo(ENTRY_ELEVATION_DEGREES, 6);
    }
  });

  it('never puts the structure inside the wearer or across the room', () => {
    const line = (across: number) => { const seat = entrySeat(across); return Math.hypot(seat.distance, seat.rise); };
    expect(line(0.05)).toBeCloseTo(ENTRY_STANDOFF_RANGE.min, 9);
    expect(line(40)).toBeCloseTo(ENTRY_STANDOFF_RANGE.max, 9);
    expect(entrySeat(0).distance).toBe(ENTRY_STANDOFF_RANGE.min);
    expect(entrySeat(NaN).distance).toBe(ENTRY_STANDOFF_RANGE.min);
  });

  it('caps both settle and re-seat after measuring the reachable plate field', () => {
    const measureSeat = (candidate: any) => plateSeatLimits({
      silhouette: { x: 0.02, y: 0.092,
        halfWidth: 0.549 * candidate.scale / 1.8,
        halfHeight: 0.42 * candidate.scale / 1.8 },
      band: { x: 0.0532, y: 0.0532 },
    });
    const before = placementFromRoom(scene);
    const settle = placementFromRoom({ ...scene, measureSeat });
    const reseat = placementFromRoom({ ...scene, mode: 'above', measureSeat });
    expect(reseat).toEqual(settle);
    expect(settle.scale).toBeLessThan(before.scale);
    expect(settle.roomPoint).toEqual(before.roomPoint);
    expect(settle.standoffMeters).toBe(before.standoffMeters);
    expect(settle.plateSeat.factor).toBe(1);
    expect(measureSeat({ scale: settle.scale + 1e-8 }).factor).toBeLessThan(1);
  });

  it('keeps an oversized unlabelled seat in the field and never grows a small one', () => {
    for (const radius of [5, 20, 100, 700]) {
      const placed = placementFromRoom({ ...scene, radius });
      const half = radius * scene.cameraScale * placed.scale / placed.standoffMeters;
      const rise = (placed.roomPoint[1] - EYE) / placed.standoffMeters;
      expect(half).toBeLessThanOrEqual(PLATE_FIELD.halfWidth);
      expect(half + rise).toBeLessThanOrEqual(PLATE_FIELD.halfHeight + 1e-12);
      expect(placed.scale).toBeLessThanOrEqual(3.6 / (2 * radius * scene.cameraScale));
    }
  });

  it('fits a large source by shrinking below the former quarter-scale floor', () => {
    const placed = placementFromRoom({ ...scene, radius: 1000 });
    expect(placed.scale).toBeLessThan(0.25);
    expect(placed.metersAcross).toBeLessThanOrEqual(3.6);
    expect(placed.standoffMeters).toBeGreaterThanOrEqual(1);
    const half = 1000 * scene.cameraScale * placed.scale / placed.standoffMeters;
    expect(half).toBeLessThanOrEqual(PLATE_FIELD.halfWidth);
  });

  it('seats a 13,000-site structure above the eye line, not at chest height', () => {
    const placed = placementFromRoom({ ...scene, floorY: 0, siteCount: 13_121, deviceClass: 'quest2' });
    expect(placed.mode).toBe('above');
    expect(placed.metersAcross).toBeCloseTo(3.6, 6);
    // The centre rides above the eye, and the whole structure clears the chest.
    expect(placed.roomPoint[1]).toBeGreaterThan(EYE);
    expect(placed.roomPoint[1] - EYE).toBeCloseTo(entrySeat(3.6).rise, 6);
    expect(placed.roomPoint[2]).toBeCloseTo(-entrySeat(3.6).distance, 6);
    // The old floor seat put the same structure below the eye line.
    const old = placementFromRoom({ ...scene, mode: 'floor', floorY: 0, siteCount: 13_121, deviceClass: 'quest2' });
    expect(old.roomPoint[1]).toBeLessThan(EYE);
  });

  it('seats a lattice on the same entry seat, drawn smaller for the budget', () => {
    const lattice = placementFromRoom({ ...scene, floorY: 0, siteCount: 400_000, deviceClass: 'quest2' });
    const small = placementFromRoom({ ...scene, floorY: 0, siteCount: 13_121, deviceClass: 'quest2' });
    expect(lattice.mode).toBe('above');
    expect(lattice.metersAcross).toBeLessThan(small.metersAcross);
    expect(lattice.roomPoint[1]).toBeGreaterThan(EYE);
    // Explicitly asking for overhead still gets it.
    expect(placementFromRoom({ ...scene, mode: 'overhead', floorY: 0, siteCount: 400_000 }).mode).toBe('overhead');
  });

  it('seats the structure without a detected floor, because entry does not wait', () => {
    const placed = placementFromRoom({ ...scene, floorY: null, siteCount: 13_121, deviceClass: 'quest2' });
    expect(placed.mode).toBe('above');
    expect(placed.roomPoint[1]).toBeCloseTo(EYE + entrySeat(3.6).rise, 6);
  });
});

describe('holding the anchor across tracking loss', () => {
  class FakeAnchor { deleted = false; anchorSpace = { anchor: true }; delete() { this.deleted = true; } }

  function anchorFrame(anchor: FakeAnchor | null, point: number[] | null, tracked = true) {
    return {
      createAnchor: async () => { if (!anchor) throw Error('anchors are not enabled'); return anchor; },
      trackedAnchors: new Set(anchor && tracked ? [anchor] : []),
      getPose: () => point ? { transform: { matrix: at(point[0], point[1], point[2]) } } : null,
    };
  }

  it('follows the anchor and keeps its last pose after the anchor is dropped', async () => {
    const anchor = new FakeAnchor();
    const handle = await anchorScene(anchorFrame(anchor, [0, 0, -2]) as any, {}, { position: { x: 0, y: 0, z: -2 } });
    expect(handle.anchored).toBe(true);
    expect(handle.poseIn(anchorFrame(anchor, [0.03, 0, -2]) as any).point).toEqual({ x: 0.03, y: 0, z: -2 });
    const lost = handle.poseIn(anchorFrame(anchor, [9, 9, 9], false) as any);
    expect(lost.tracked).toBe(false);
    expect(lost.lost).toBe(true);
    // The scene must stay where the wearer last saw it, not snap to the origin.
    expect(lost.point).toEqual({ x: 0.03, y: 0, z: -2 });
    expect(handle.poseIn(anchorFrame(anchor, null) as any).point).toEqual({ x: 0.03, y: 0, z: -2 });
    handle.release();
    expect(anchor.deleted).toBe(true);
  });

  it('serves the requested point unchanged when the runtime has no anchors', async () => {
    const handle = await anchorScene({} as any, {}, { position: { x: 1, y: 2, z: 3 } });
    expect(handle.anchored).toBe(false);
    expect(handle.poseIn({} as any).point).toEqual({ x: 1, y: 2, z: 3 });
    const refused = await anchorScene(anchorFrame(null, null) as any, {}, { position: { x: 1, y: 2, z: 3 } });
    expect(refused.anchored).toBe(false);
    expect(refused.poseIn({} as any).point).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('needs a finite room point', async () => {
    await expect(anchorScene({} as any, {}, { position: { x: NaN, y: 0, z: 0 } })).rejects.toThrow(/finite/);
  });
});

describe('one settle per session', () => {
  it('waits for the floor estimate to stop moving, then reports once', () => {
    let clock = 0;
    const anchor = createRoomAnchor({ scanIntervalMs: 400, settleMs: 2_000, now: () => clock });
    const observe = (planes: unknown[]) => anchor.observe({ frame: frameOf(planes), space: {}, headY: 1.6 });
    // Nothing detected yet: the first seconds of a session report no floor.
    expect(observe([])).toBe(false);
    expect(anchor.status().supported).toBe(true);
    expect(anchor.floorY()).toBeNull();
    clock = 500;
    expect(observe([plane(-0.1, 1)])).toBe(false);
    // The estimate moves as the plane grows, which restarts the settle clock.
    clock = 2_400;
    expect(observe([plane(0, 2)])).toBe(false);
    clock = 3_000;
    expect(observe([plane(0, 2)])).toBe(false);
    clock = 4_500;
    expect(observe([plane(0, 2)])).toBe(true);
    expect(anchor.floorY()).toBe(0);
  });

  it('does not move the scene a second time on its own', async () => {
    let clock = 0;
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => clock });
    const observe = () => anchor.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 });
    expect(observe()).toBe(true);
    await anchor.applied({ frame: {}, space: {}, roomPoint: [0, 1.2, -2] });
    expect(anchor.status().placements).toBe(1);
    clock = 10_000;
    expect(observe()).toBe(false);
    // A floor that moves half a metre still does not move the scene by itself.
    expect(anchor.observe({ frame: frameOf([plane(-0.5, 4)]), space: {}, headY: 1.6 })).toBe(false);
    expect(shouldReplace({ floorY: -0.5, appliedFloorY: 0, placements: 1 })).toBe(false);
    // Only the wearer's own press does.
    expect(shouldReplace({ floorY: -0.5, appliedFloorY: 0, placements: 1, wearerRequested: true })).toBe(true);
  });

  // Reading the Mac ends the WebXR session, so re-entry builds a fresh anchor
  // with placements back at 0. Without the marker the first settle overrode
  // the placement the wearer had chosen before taking the headset off.
  it('leaves a placement the wearer chose in an earlier session alone', async () => {
    const seeded = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => 0, wearerPlaced: true });
    expect(seeded.status().wearerPlaced).toBe(true);
    expect(seeded.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 })).toBe(false);
    expect(shouldReplace({ floorY: 0, appliedFloorY: null, placements: 0, wearerPlaced: true })).toBe(false);
    // The wearer's own press still moves it, in this session as in the last.
    expect(shouldReplace({ floorY: 0, placements: 0, wearerPlaced: true, wearerRequested: true })).toBe(true);

    // The saved scene usually hydrates after the anchor is built, so the same
    // decision has to be adoptable a moment later.
    const late = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => 0 });
    late.rememberWearerPlacement();
    expect(late.status().wearerPlaced).toBe(true);
    expect(late.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 })).toBe(false);

    // A first session with no marker still gets its one automatic settle.
    const fresh = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => 0 });
    expect(fresh.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 })).toBe(true);
  });

  it('reports drift from the point the scene was placed at', async () => {
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => 0 });
    const tracked = { anchorSpace: {}, delete() {} };
    const frame = {
      createAnchor: async () => tracked,
      trackedAnchors: new Set([tracked]),
      getPose: () => ({ transform: { matrix: at(0, 1.24, -2) } }),
      detectedPlanes: new Set([plane(0, 2)]),
      getViewerPose: () => null,
      getPose_: null,
    };
    await anchor.applied({ frame: frame as any, space: {}, roomPoint: [0, 1.2, -2] });
    anchor.observe({ frame: frame as any, space: {}, headY: 1.6 });
    expect(anchor.status().driftMeters).toBeCloseTo(0.04, 3);
    expect(anchor.status().anchored).toBe(true);
  });

  it('records a wearer placement as the one placement the session gets', async () => {
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => 0 });
    anchor.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 });
    // No frame: a toolbar press happens between frames, so there is no live
    // XRFrame to pin an anchor against. It still counts as the placement.
    await anchor.applied({ roomPoint: [0, 1.2, -2], wearerRequested: true });
    expect(anchor.status()).toMatchObject({ placements: 1, wearerPlaced: true, anchored: false });
    expect(anchor.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 })).toBe(false);
  });

  it('is on unless the page asks for it to be off', () => {
    expect(roomAnchorEnabled({ location: { search: '' } })).toBe(true);
    expect(roomAnchorEnabled({ location: { search: '?roomAnchor=off' } })).toBe(false);
    expect(roomAnchorEnabled({ location: { search: '?roomAnchor=1' } })).toBe(true);
    expect(roomAnchorEnabled(undefined)).toBe(true);
  });

  it('fits a travelling placement inside the ten-radii box', () => {
    expect(reachFraction([0, 0, 0], [0, 0, 5])).toBe(1);
    expect(reachFraction([0, 0, 0], [0, 0, 20], 10)).toBeCloseTo(0.5);
    expect(reachFraction([0, 0, 0], [0, 0, -20], 10)).toBeCloseTo(0.5);
    // A start already outside the box cannot be rescued by travelling less far.
    expect(reachFraction([12, 0, 0], [12, 0, 0])).toBe(1);
    expect(reachFraction([0, 0, 0], [NaN, 0, 0])).toBe(0);
  });

  it('reports an unsupported runtime instead of failing the session', () => {
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => 0 });
    expect(anchor.observe({ frame: { getPose: () => null }, space: {}, session: {} })).toBe(false);
    // Reading `detectedPlanes` on a session that was never granted the feature
    // raises. The frame loop must not carry that out.
    const ungranted = { get detectedPlanes(): never { throw Error('feature not enabled'); }, getPose: () => null };
    expect(anchor.observe({ frame: ungranted as any, space: {}, session: {} })).toBe(false);
    expect(anchor.observe()).toBe(false);
    expect(anchor.status()).toMatchObject({ supported: false, planeCount: 0, floorY: null, anchored: false });
    expect(anchor.floor()).toBeNull();
  });
});

describe('a session with no floor still seats the structure', () => {
  /** A frame from a session that was never granted plane detection at all. */
  const blind = { detectedPlanes: undefined, getViewerPose: () => null, getPose: () => null };

  it('settles once on the head-relative seat after the floorless wait', () => {
    let clock = 0;
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => clock });
    const observe = () => anchor.observe({ frame: blind, space: {}, headY: 1.6 });
    // The telomerase entries sat here for the whole session: no
    // planes, so no floor, so nothing ever asked for the monumental seat and
    // the wearer got the authored desktop placement.
    expect(observe()).toBe(false);
    expect(anchor.status().supported).toBe(false);
    expect(anchor.floorY()).toBeNull();
    clock = FLOORLESS_SETTLE_MS - 1;
    expect(observe()).toBe(false);
    clock = FLOORLESS_SETTLE_MS;
    expect(observe()).toBe(true);
  });

  it('spends that settle once, like the floor path does', async () => {
    let clock = 0;
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => clock });
    const observe = () => anchor.observe({ frame: blind, space: {}, headY: 1.6 });
    expect(observe()).toBe(false);
    clock = FLOORLESS_SETTLE_MS;
    expect(observe()).toBe(true);
    await anchor.applied({ frame: {}, space: {}, roomPoint: [0, 1.2, -2] });
    clock = 30_000;
    expect(observe()).toBe(false);
  });

  it('leaves a placement the wearer chose alone', () => {
    let clock = FLOORLESS_SETTLE_MS;
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 0, now: () => clock, wearerPlaced: true });
    expect(anchor.observe({ frame: blind, space: {}, headY: 1.6 })).toBe(false);
    expect(shouldReplace({ floorY: null, floorless: true, placements: 0, wearerPlaced: true })).toBe(false);
  });

  it('still prefers a floor that turns up inside the wait', () => {
    let clock = 0;
    const anchor = createRoomAnchor({ scanIntervalMs: 0, settleMs: 500, now: () => clock });
    expect(anchor.observe({ frame: blind, space: {}, headY: 1.6 })).toBe(false);
    clock = 1_000;
    // A floor arrives before the floorless wait is up, so the settle comes
    // from the floor path with a real height rather than from the head.
    expect(anchor.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 })).toBe(false);
    clock = 2_000;
    expect(anchor.observe({ frame: frameOf([plane(0, 2)]), space: {}, headY: 1.6 })).toBe(true);
    expect(anchor.floorY()).toBe(0);
  });

  it('says no on its own, without the floorless flag', () => {
    expect(shouldReplace({ floorY: null, placements: 0 })).toBe(false);
    expect(shouldReplace({ floorY: null, floorless: true, placements: 0 })).toBe(true);
    expect(shouldReplace({ floorY: null, floorless: true, placements: 1 })).toBe(false);
  });
});
