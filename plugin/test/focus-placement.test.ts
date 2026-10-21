import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
// @ts-ignore Shared XR focus placement maths.
import { FOCUS_FRAMINGS, GROWTH_TILT_DEGREES, GROWTH_TURN_MAX_MS, GROWTH_TURN_MIN_MS, GROWTH_WALL_AZIMUTH_DEGREES, focusPlacement, focusRotation, focusTravel, growthTurnDurationMs, longestAxis, obliqueGrowthTurn } from '../../lab/browser-roundtrip/focus-placement.mjs';
// @ts-ignore The plate rule the framing is bounded by.
import { ASSEMBLY_LENS_FRACTION, PLATE_NEAR_FALLBACK_METRES, PLATE_STANDOFF_METRES, SUBJECT_CENTRE_LENS, SUBJECT_GHOST_LENS_CEILING, SUBJECT_GHOST_LENS_LIMIT, SUBJECT_WHOLE_LENS_CEILING, SUBJECT_LENS_CEILING, SUBJECT_LENS_FLOOR, lensTangent, projectedExtent } from '../../lab/browser-roundtrip/plate-standoff.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
// @ts-ignore Shared lens geometry.
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Shared numerical placement guardrail.
import { PLACEMENT_MIN_SCALE } from '../../lab/browser-roundtrip/placement-limits.mjs';

const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const head = [...identity.slice(0,12), 0, 1.6, 0, 1];
const base = {
  headInRoom: head, renderFromRoom: identity, cameraScale: .01,
  center: [0,0,0], radius: 100,
  placement: { translation: [0,0,0], rotation: [0,0,0], scale: 1 },
  targetCenter: [0,0,0], targetRadius: 69.282,
};

// Acceptance 3, ring-v2 #365: the menu ends at lens y .319 and x -.162.
// With no caption, the old menu dodge raised a level target to y ~.64.
// Room height is intentionally varied: the local XR origin need not be a floor.
describe('acceptance focus stays in the middle lens band', () => {
  for (const height of [0, 1.1, 1.6]) {
    it(`keeps show-me and whole-scene targets level at head height ${height}`, () => {
      const tracked = Array.from(Mat4.fromRotation(Mat4(), 25 * Math.PI / 180, Vec3.create(0, 1, 0)));
      tracked.splice(12, 3, 1.5, height, .3);
      const menu = [[-.872, -.689], [-.162, -.689], [-.872, .319], [-.162, .319]]
        .map(([x, y]) => Array.from(Vec3.transformMat4(Vec3(),
          Vec3.create(x * EYE_TAN_HALF_HORIZONTAL, y * EYE_TAN_HALF_VERTICAL, -1), Mat4.fromArray(Mat4(), tracked, 0))));
      const extrema = [-70, 70].flatMap(x => [-35, 35].flatMap(y => [-20, 20].map(z => [x, y, z])));
      for (const wholeStructure of [false, true]) for (const measured of [false, true]) {
        const input = { ...base, headInRoom: tracked, wholeStructure, elevationDegrees: 0,
          ...(measured ? { subjectPoints: extrema, assemblyPoints: extrema } : {}),
          framing: 'context', platePoints: menu, menuPoints: menu, menuRows: [menu], captionPoints: [] };
        const placed = focusPlacement(input);
        const point = placedInRoom({ ...input, cameraScale: placed.cameraScale }, placed);
        const relative = Vec3.sub(Vec3(), point, Vec3.create(1.5, height, .3));
        const depth = Vec3.dot(relative, Vec3.create(-tracked[8], -tracked[9], -tracked[10]));
        const y = relative[1] / depth / EYE_TAN_HALF_VERTICAL;
        expect(Math.abs(y)).toBeLessThanOrEqual(SUBJECT_CENTRE_LENS + 1e-6);
        point.forEach((value, axis) => expect(placed.targetRoom[axis]).toBeCloseTo(value, 9));
        expect(placed.targetLens[1]).toBeCloseTo(y, 9);
        expect(placed.standoff.clears).toBe(true);
      }
    });
  }
});

/** Where the target sphere's centre actually lands, in room metres. */
function placedInRoom(input: any, placed: any) {
  const inner = Vec3.scale(Vec3(), Vec3.sub(Vec3(),
    Vec3.create(...input.targetCenter as [number,number,number]), Vec3.create(...input.center as [number,number,number])), placed.scale);
  Vec3.transformMat4(inner, inner, focusRotation(input.placement.rotation));
  const render = Vec3.add(Vec3(), Vec3.add(Vec3(), Vec3.create(...input.center as [number,number,number]), inner),
    Vec3.scale(Vec3(), Vec3.create(...placed.translation as [number,number,number]), input.radius));
  Vec3.scale(render, render, input.cameraScale);
  return Vec3.transformMat4(render, render, Mat4.invert(Mat4(), Mat4.fromArray(Mat4(), input.renderFromRoom as any, 0)));
}

/** The angular diameter the wearer sees, in degrees. */
function subtended(input: any, placed: any) {
  const point = placedInRoom(input, placed);
  const distance = Vec3.distance(point, Vec3.create(input.headInRoom[12], input.headInRoom[13], input.headInRoom[14]));
  return { degrees: 2 * Math.atan(placed.scale * input.targetRadius * input.cameraScale / distance) * 180 / Math.PI,
    distance, rise: point[1] - input.headInRoom[13] };
}

describe('framing one region for the wearer without moving their head', () => {
  it('makes the target span the asked-for angle, slightly above the eye line', () => {
    // The ask is what the target gets unless the WHOLE assembly
    // — this target plus the rest of the structure around it — would then span
    // more than the ghost-included cap of the lens. This fixture's structure
    // reaches 1.44 times the target's own radius, so `fill` is cut back from
    // 60 degrees to the 41 that puts the assembly on that cap. `context` is
    // well inside it and is untouched.
    for (const framing of ['fill','context'] as const) {
      const placed = focusPlacement({ ...base, framing });
      const seen = subtended(base, placed);
      expect(seen.degrees).toBeCloseTo(placed.angleDegrees, 3);
      if (framing === 'fill') {
        expect(seen.degrees).toBeGreaterThan(38);
        expect(seen.degrees).toBeLessThan(42);
        expect(placed.standoff.assembly.assemblyWide).toBeLessThanOrEqual(ASSEMBLY_LENS_FRACTION + 1e-6);
      } else {
        expect(seen.degrees).toBeCloseTo(FOCUS_FRAMINGS[framing], 3);
      }
      expect(placed.angleDegrees).toBeCloseTo(seen.degrees, 6);
      // Slightly up, not overhead: the eight-degree rise at this distance.
      expect(Math.asin(seen.rise / seen.distance) * 180 / Math.PI).toBeCloseTo(8, 3);
    }
    // A region held close fills more of the view than one kept in context, so
    // the same target has to end up nearer, larger, or both.
    const fill = focusPlacement({ ...base, framing: 'fill' });
    const context = focusPlacement({ ...base, framing: 'context' });
    expect(fill.scale / subtended(base, fill).distance).toBeGreaterThan(context.scale / subtended(base, context).distance);
  });

  it('frames a small pocket at the preferred distance using scale above four', () => {
    const placed = focusPlacement({ ...base, targetRadius: 10, framing: 'fill' });
    expect(placed.scale).toBeGreaterThan(4);
    const seen = subtended({ ...base, targetRadius: 10 }, placed);
    expect(seen.degrees).toBeCloseTo(60, 3);
    expect(seen.distance).toBeCloseTo(1.2, 9);
  });

  // A grown tier previously exhausted the .25 placement floor.
  const huge = { ...base, radius: 2_400, targetRadius: 2_400 };

  /**
   * The seat a framing is solved at once both rules are on.
   *
   * The plate rule sets the distance — the whole assembly, held at the framing
   * it was allowed, has its near surface exactly on the plates' floor — and the
   * placement scale makes the framing fit there rather than at the
   * 1.2 m a focus would prefer on its own. `tanHalfAssembly` is the subject's
   * own tangent times its reach ratio, which is 1 for a subject that IS the
   * whole structure.
   */
  const floorMetres = PLATE_NEAR_FALLBACK_METRES + PLATE_STANDOFF_METRES;
  const standoffSeat = (tanHalfAssembly: number) => floorMetres / (1 - tanHalfAssembly);

  it('shrinks a large tier below the former floor without changing scene scale', () => {
    const placed = focusPlacement({ ...huge, framing: 'fill' });
    expect(placed.scale).toBeLessThan(.25);
    expect(placed.usedCameraScale).toBe(false);
    // The tier IS the whole assembly, so the ghost-included cap is what fill
    // is cut to, and the plate rule chooses where that sits.
    const tanHalf = lensTangent(ASSEMBLY_LENS_FRACTION);
    const seat = standoffSeat(tanHalf);
    expect(placed.distance).toBeCloseTo(seat, 9);
    expect(placed.cameraScale).toBe(base.cameraScale);
    // The final lens cap can now apply its small elevation correction below
    // .25, keeping the apparent assembly width inside the same physical cap.
    const elevatedTangent = tanHalf * Math.cos(8 * Math.PI / 180);
    expect(placed.scale).toBeCloseTo(seat * elevatedTangent / (2_400 * base.cameraScale), 12);
    expect(placed.angleDegrees).toBeCloseTo(2 * Math.atan(elevatedTangent) * 180 / Math.PI, 9);
    expect(placed.standoff.assembly.nearestMetres).toBeGreaterThanOrEqual(floorMetres);
    expect(placed.standoff.clears).toBe(true);
    const seen = subtended({ ...huge, cameraScale: placed.cameraScale }, placed);
    expect(seen.degrees).toBeCloseTo(placed.angleDegrees, 6);
    expect(seen.distance).toBeCloseTo(seat, 6);
  });

  it('leaves the scene scale alone for every framing that fits, including a tight zoom', () => {
    const fits = focusPlacement({ ...base, framing: 'fill' });
    expect(fits.usedCameraScale).toBe(false);
    expect(fits.cameraScale).toBe(base.cameraScale);
    // Physical framing sets the requested size independently of source units.
    const tight = focusPlacement({ ...base, targetRadius: 10, framing: 'fill' });
    expect(tight.scale).toBeGreaterThan(4);
    expect(tight.usedCameraScale).toBe(false);
    expect(tight.cameraScale).toBe(base.cameraScale);
  });

  it('takes the largest enclosure the plate rule allows, and never one that pierces it', () => {
    // An `enclosure` is a CEILING the assembly fit may cut, not
    // a floor it must reach. A bigger subject must never put molecular surface
    // nearer to the eye than the caption and the menu are, so the .85 a lesson
    // asks the whole structure for is answered with as much of it as the
    // ghost-included cap leaves.
    //
    // This fixture's ghost reaches 1.44 times the target's own radius, so .85
    // is cut hard — all the way down past the sixty degrees `fill` asks for —
    // and the plan says who cut it and what was asked.
    const reachRatio = base.radius / base.targetRadius;
    const capped = focusPlacement({ ...base, framing: 'fill', enclosure: .85 });
    expect(capped.askedEnclosure).toBe(.85);
    expect(capped.enclosure).toBeCloseTo(lensTangent(ASSEMBLY_LENS_FRACTION) / reachRatio, 12);
    expect(capped.standoff.limited).toBe('assembly');
    expect(capped.standoff.assembly.assemblyFraction).toBeLessThanOrEqual(ASSEMBLY_LENS_FRACTION + 1e-6);
    expect(capped.standoff.assembly.nearestMetres).toBeGreaterThanOrEqual(floorMetres - 1e-6);
    // A subject that IS the whole structure has no ghost to hold back, so the
    // cap hands it the ghost-included share of the lens: short of the .85 and
    // of the sixty degrees the same framing name used to keep.
    const whole = focusPlacement({ ...huge, framing: 'fill', enclosure: .85, wholeStructure: true });
    expect(whole.enclosure).toBeCloseTo(lensTangent(ASSEMBLY_LENS_FRACTION), 12);
    expect(whole.enclosure).toBeLessThan(Math.tan(Math.PI / 6));
    expect(whole.enclosure).toBeLessThan(.85);
    expect(whole.angleDegrees).toBeCloseTo(2 * Math.atan(lensTangent(ASSEMBLY_LENS_FRACTION) * Math.cos(8 * Math.PI / 180)) * 180 / Math.PI, 9);
    // It stays behind the plates without changing the scene scale.
    expect(whole.usedCameraScale).toBe(false);
    expect(whole.distance).toBeCloseTo(standoffSeat(lensTangent(ASSEMBLY_LENS_FRACTION)), 9);
    expect(whole.standoff.assembly.nearestMetres).toBeGreaterThanOrEqual(floorMetres - 1e-6);
    expect(whole.angleDegrees).toBeCloseTo(focusPlacement({ ...huge, framing: 'fill' }).angleDegrees, 6);
    const seen = subtended({ ...huge, cameraScale: whole.cameraScale }, whole);
    expect(seen.degrees).toBeCloseTo(whole.angleDegrees, 6);
    // Never closer than a sphere whose surface is already on the wearer's eye.
    expect(() => focusPlacement({ ...base, framing: 'fill', enclosure: 1.2 })).toThrow(/enclosure/);
    expect(() => focusPlacement({ ...base, framing: 'fill', enclosure: 0 })).toThrow(/enclosure/);
  });

  it('solves through the saved rotation, so a turned structure still lands in front', () => {
    const turned = { ...base, placement: { translation: [1,-2,.5], rotation: [0,90,0], scale: 12 },
      targetCenter: [30,0,0], targetRadius: 40 };
    const placed = focusPlacement({ ...turned, framing: 'context' });
    const seen = subtended(turned, placed);
    expect(seen.degrees).toBeCloseTo(30, 3);
    const point = placedInRoom(turned, placed);
    // The wearer looks down −z from (0, 1.6, 0); the region arrives ahead of them.
    expect(point[2]).toBeLessThan(0);
    expect(Math.abs(point[0])).toBeLessThan(.001);
  });

  it('never moves the wearer and never invents a pose it was not given', () => {
    expect(() => focusPlacement({ ...base, framing: 'anything' })).toThrow(/fill or context/);
    expect(() => focusPlacement({ ...base, cameraScale: NaN, framing: 'fill' })).toThrow(/tracked room pose/);
    expect(() => focusPlacement({ ...base, targetRadius: 0, framing: 'fill' })).toThrow(/tracked room pose/);
    // Looking straight down leaves no horizontal direction to place along.
    expect(() => focusPlacement({ ...base, headInRoom: [...identity.slice(0,8), 0, 1, 0, 0, 0, 1.6, 0, 1], framing: 'fill' })).toThrow(/Look ahead/);
    // Refuse a pose outside the shared numerical range rather than clip it.
    expect(() => focusPlacement({ ...base, radius: 1e-6, framing: 'fill' })).toThrow(/placement range/);
  });

  it.each([1e-4, 1, 1e4])('keeps physical framing invariant when normalized source units change by %s', factor => {
    const input = { ...base, radius: base.radius * factor, targetRadius: base.targetRadius * factor,
      cameraScale: base.cameraScale / factor,
      placement: { translation: [12, -15, 20], rotation: [0, 90, 0], scale: 12 } };
    const reference = focusPlacement({ ...base, framing: 'fill' });
    const placed = focusPlacement({ ...input, framing: 'fill' });
    expect(placed.scale).toBeGreaterThanOrEqual(.01);
    expect(placed.scale).toBeCloseTo(reference.scale, 9);
    expect(placed.cameraScale).toBe(base.cameraScale / factor);
    placedInRoom(input, placed).forEach((value: number, i: number) => expect(value).toBeCloseTo(placedInRoom(base, reference)[i], 8));
    expect(placed.standoff.clears).toBe(true);
    expect(placed.standoff.assembly.assemblyWide).toBeCloseTo(reference.standoff.assembly.assemblyWide, 9);
  });

  it('uses scene scale only after exhausting the shared numerical scale range', () => {
    const placed = focusPlacement({ ...base, radius: 1e9, targetRadius: 1e9, elevationDegrees: 0, framing: 'fill' });
    expect(placed.scale).toBe(PLACEMENT_MIN_SCALE);
    expect(placed.usedCameraScale).toBe(true);
    expect(placed.standoff.clears).toBe(true);
    expect(placed.angleDegrees).toBeCloseTo(focusPlacement({ ...huge, elevationDegrees: 0, framing: 'fill' }).angleDegrees, 9);
  });

  it('treats a 3.4 m plate reading as a unit leak and uses the fallback seat', () => {
    const leaked = focusPlacement({ ...base, framing: 'fill', plateNearMetres: 3.4 });
    const hidden = focusPlacement({ ...base, framing: 'fill' });
    expect(leaked.standoff.plateNearMetres).toBe(PLATE_NEAR_FALLBACK_METRES);
    expect(leaked.distance).toBeCloseTo(hidden.distance);
  });

  /**
   * The seat is solved against the CAPTION, not the panel.
   *
   * Avoiding the union of the caption card and the menu column, which spans the
   * whole left half of the lens, leaves only a seat hard right against the
   * vignette — a correctly sized protofilament with its centre in the wrong
   * half of the view. Here is the same pair of rectangles, a metre in front of
   * the wearer.
   */
  const captionCard = [[-.75, 1.85, -1], [-.1, 1.85, -1], [-.75, 2.3, -1], [-.1, 2.3, -1]];
  const menuColumn = [[-.75, 1.1, -1], [-.1, 1.1, -1], [-.75, 1.7, -1], [-.1, 1.7, -1]];

  it('seats the subject clear of the caption and leaves it centred', () => {
    const seated = focusPlacement({ ...base, framing: 'fill', elevationDegrees: 0,
      platePoints: [...captionCard, ...menuColumn], captionPoints: captionCard });
    const { frame } = seated.standoff;
    // The caption is the rectangle avoided; the whole panel is recorded beside
    // it, and it is the taller of the two.
    expect(frame.caption.bottom).toBeGreaterThan(frame.plate.bottom + .5);
    expect(frame.caption.left).toBeCloseTo(frame.plate.left, 6);
    // Down, dead centre — and the subject's edges nowhere near the 0.98 they
    // used to reach. The menu pass may then shrink the ghost.
    expect(frame.move === 'lower' || frame.move === 'shrink' || frame.move === 'shrink+lower'
      || frame.move === 'none').toBe(true);
    expect(frame.centred).toBe(true);
    expect(Math.abs(frame.subject.x)).toBeLessThanOrEqual(SUBJECT_CENTRE_LENS);
    expect(frame.subject.top).toBeLessThanOrEqual(frame.caption.bottom + 1e-6);
    expect(Math.max(frame.subject.right, -frame.subject.left)).toBeLessThan(.9);
    expect(frame.share.whole).toBeLessThanOrEqual(SUBJECT_GHOST_LENS_CEILING + 1e-6);
    expect(frame.menu).toEqual(expect.objectContaining({ cleared: expect.any(Boolean) }));
  });

  it('is the union of caption and menu that had no centred seat left', () => {
    // The same call with the menu folded into the rectangle to avoid: the only
    // way out is sideways, which is the defect this behaviour exists to undo.
    const shoved = focusPlacement({ ...base, framing: 'fill', elevationDegrees: 0,
      platePoints: [...captionCard, ...menuColumn], captionPoints: [...captionCard, ...menuColumn] });
    expect(shoved.standoff.frame.move).toBe('shift');
    expect(shoved.standoff.frame.centred).toBe(false);
    expect(shoved.standoff.frame.subject.x).toBeGreaterThan(.15);
    // An older caller that names no caption at all still behaves as it did.
    const legacy = focusPlacement({ ...base, framing: 'fill', elevationDegrees: 0,
      platePoints: [...captionCard, ...menuColumn] });
    expect(legacy.standoff.frame.subject.x).toBeCloseTo(shoved.standoff.frame.subject.x, 9);
    // And a panel drawing no caption leaves the framing alone entirely.
    const bare = focusPlacement({ ...base, framing: 'fill', elevationDegrees: 0,
      platePoints: [...captionCard, ...menuColumn], captionPoints: [] });
    expect(bare.standoff.frame.move).toBe('none');
    expect(bare.standoff.frame.caption).toBe(null);
  });

  it('caps the projected whole-subject width and records menu and share', () => {
    const seated = focusPlacement({ ...huge, framing: 'fill', enclosure: .85, wholeStructure: true,
      elevationDegrees: 0, platePoints: [...captionCard, ...menuColumn], captionPoints: captionCard,
      menuPoints: menuColumn });
    const { frame } = seated.standoff;
    expect(frame.share.whole).toBeLessThanOrEqual(SUBJECT_GHOST_LENS_CEILING + 1e-6);
    expect(frame.share.lit).toBeGreaterThanOrEqual(SUBJECT_LENS_FLOOR - 1e-6);
    expect(frame.share.lit).toBeLessThanOrEqual(SUBJECT_GHOST_LENS_CEILING + 1e-6);
    expect(Math.abs(frame.subject.x)).toBeLessThanOrEqual(SUBJECT_CENTRE_LENS + 1e-9);
    expect(frame.centred).toBe(true);
    expect(frame.menu.rect.right).toBeCloseTo(frame.plate.right, 6);
    expect(frame.menu.rect.bottom).toBeCloseTo(frame.plate.bottom, 6);
    expect(frame.menu.rect.top).toBeLessThan(frame.caption.bottom);
    expect(typeof frame.menu.move).toBe('string');
    expect(typeof frame.menu.cleared).toBe('boolean');
    expect(['none', 'shrink', 'raise', 'shrink+raise', 'shift', 'held']).toContain(frame.menu.move);
    if (!frame.menu.cleared) {
      expect(Math.abs(frame.subject.x)).toBeLessThanOrEqual(SUBJECT_CENTRE_LENS + 1e-9);
    }
  });

  it('caps a lit part that starts at 41 per cent centre and 55 per cent wide', () => {
    // The Quest 2 part-chapter: lit 55 per cent wide at 41 per cent of the lens,
    // ghost 85 per cent. Built as extrema so the solver sees a projected ribbon.
    const lit = 40, ghost = 62;
    const subjectPoints = [[-lit, 0, 0], [lit, 0, 0], [0, -30, 0], [0, 30, 0]];
    const assemblyPoints = [[-ghost, 0, 0], [ghost, 0, 0], [0, -45, 0], [0, 45, 0]];
    const seated = focusPlacement({ ...base, framing: 'fill', elevationDegrees: 0,
      targetRadius: lit, subjectPoints, assemblyPoints,
      platePoints: [...captionCard, ...menuColumn], captionPoints: captionCard, menuPoints: menuColumn });
    const { frame } = seated.standoff;
    expect(frame.share.lit).toBeGreaterThanOrEqual(SUBJECT_LENS_FLOOR - 1e-6);
    expect(frame.share.lit).toBeLessThanOrEqual(SUBJECT_LENS_CEILING + 1e-6);
    // The lit floor wins over the ghost ceiling, so the ghost
    // is allowed past the old 0.60 up to the 0.75 limit rather than pulling
    // the lit part under 0.40. This fixture lands there exactly: whole 0.621
    // (the old cap refused because shrinking to it took the lit part to
    // 0.387), lit 0.4005. The ghost outgrows its ceiling only while the lit
    // part holds the floor, so that pair is the assertion now.
    expect(frame.share.whole).toBeLessThanOrEqual(SUBJECT_GHOST_LENS_LIMIT + 1e-6);
    if (frame.share.whole > SUBJECT_GHOST_LENS_CEILING + 1e-6) {
      expect(frame.share.lit).toBeGreaterThanOrEqual(SUBJECT_LENS_FLOOR - 1e-6);
    }
    expect(Math.abs(frame.subject.x)).toBeLessThanOrEqual(SUBJECT_CENTRE_LENS + 1e-9);
    expect(frame.menu).toEqual(expect.objectContaining({ move: expect.any(String), cleared: expect.any(Boolean) }));
  });

  it('says which distance the seat came from', () => {
    // `standoff-floor` is the plate rule pushing the structure back; `angular`
    // is the preferred 1.2 m, where the subject's projected half width lands
    // exactly on the share of the lens the fit granted it. A dimer and a
    // protofilament take the second: `limited: inside-out` zeroes the floor, so
    // the wearer stands inside the ghost and not inside a floored seat.
    const floored = focusPlacement({ ...base, framing: 'fill' });
    expect(floored.standoff.seatReason).toBe('standoff-floor');
    expect(floored.distance).toBeCloseTo(floored.standoff.minDistanceMetres, 9);
    const inside = focusPlacement({ ...base, framing: 'fill', targetRadius: 30, enclosure: .85 });
    expect(inside.standoff.limited).toBe('inside-out');
    expect(inside.standoff.minDistanceMetres).toBe(0);
    expect(inside.standoff.seatReason).toBe('angular');
    expect(inside.distance).toBeCloseTo(1.2, 9);
    // And at that seat the subject really does project at the share of the lens
    // the fit granted it, which is what makes `angular` the right seat to keep.
    expect(inside.standoff.assembly.subjectFraction).toBeCloseTo(inside.enclosure / lensTangent(1), 6);
  });
});

describe('the travel to a new framing', () => {
  const step = () => { const seen: Array<[number[], number]> = []; return { seen, fn: (offset: number[], scale: number) => seen.push([offset, scale]) }; };

  it('throws when no frame scheduler is given, rather than defaulting to the window clock', () => {
    expect(() => focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [1,0,0], scale: 1 },
      radius: 1, step: () => undefined, durationMs: 0, now: () => 0 })).toThrow(/frame scheduler/);
  });

  it('eases from the saved placement to the target and lands exactly on it', async () => {
    let clock = 0;
    const pending: Array<() => void> = [];
    const { seen, fn } = step();
    const travel = focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [0,1,-2], scale: 2 },
      radius: 100, step: fn, durationMs: 600, now: () => clock, frame: (callback: () => void) => pending.push(callback) });
    while (pending.length) { clock += 100; pending.shift()!(); }
    await expect(travel).resolves.toEqual({ translation: [0,1,-2], scale: 2 });
    expect(seen[0][0].map(value => value + 0)).toEqual([0,0,0]);
    expect(seen[0][1]).toBe(1);
    expect(seen.at(-1)![0]).toEqual([0,100,-200]);
    expect(seen.at(-1)![1]).toBeCloseTo(2, 6);
    // Eased, not linear: the middle of the travel is past the middle of the
    // distance only because the ease is symmetric about it.
    const half = seen[Math.floor(seen.length / 2)];
    expect(half[0][1]).toBeGreaterThan(0);
    expect(half[0][1]).toBeLessThan(100);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0][1]).toBeGreaterThanOrEqual(seen[i-1][0][1]);
  });

  it('finishes in one step when there is no time to animate', async () => {
    const { seen, fn } = step();
    await focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [1,0,0], scale: .5 },
      radius: 10, step: fn, durationMs: 0, now: () => 0, frame: () => { throw Error('should not schedule'); } });
    expect(seen.map(([offset, scale]) => [offset.map(value => value + 0), scale])).toEqual([[[10,0,0], .5]]);
  });

  /**
   * A travel scheduled on the window's `requestAnimationFrame` stops ticking
   * for the whole length of an immersive session — Quest Browser runs only
   * `XRSession.requestAnimationFrame` there. When a chapter of the CRISPR
   * lesson framed the part it had just lit, this promise never settled, and
   * behind it the scene, the workspace queue and the page's heartbeat to the
   * Mac all stopped with no error while WebXR kept drawing at 72 fps.
   */
  it('lands and resolves even when no frame ever arrives', async () => {
    const { seen, fn } = step();
    const deferred: (() => void)[] = [];
    const travel = focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [0,1,-2], scale: 2 },
      radius: 100, step: fn, durationMs: 600, now: () => 0,
      // The window clock a live immersive session never services again.
      frame: () => undefined, defer: (callback: () => void) => deferred.push(callback) });
    expect(deferred).toHaveLength(1);
    deferred.shift()!();
    await expect(travel).resolves.toEqual({ translation: [0,1,-2], scale: 2 });
    // The placement still arrives; it simply arrives in one step.
    expect(seen.at(-1)![0]).toEqual([0,100,-200]);
    expect(seen.at(-1)![1]).toBeCloseTo(2, 6);
  });

  it('waits past its own duration before landing, so a real frame clock wins', () => {
    const deferred: number[] = [];
    void focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [1,0,0], scale: 1 },
      radius: 1, step: () => undefined, durationMs: 600, now: () => 0, frame: () => undefined,
      defer: (_callback: () => void, ms: number) => deferred.push(ms) });
    expect(deferred[0]).toBeGreaterThan(600);
  });

  it('does not double-settle when the deadline fires after a normal arrival', async () => {
    const deferred: (() => void)[] = [];
    let clock = 0;
    const pending: (() => void)[] = [];
    const travel = focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [1,0,0], scale: 1 },
      radius: 1, step: () => undefined, durationMs: 100, now: () => clock,
      frame: (callback: () => void) => pending.push(callback), defer: (callback: () => void) => deferred.push(callback) });
    while (pending.length) { clock += 100; pending.shift()!(); }
    await expect(travel).resolves.toEqual({ translation: [1,0,0], scale: 1 });
    deferred.shift()!();
    await expect(travel).resolves.toEqual({ translation: [1,0,0], scale: 1 });
  });
});

describe('the frame clock a presenting session animates on', () => {
  // The fix is only real if the call site actually hands the session's clock to
  // the travel. Read as source, because the alternative is a live XR session.
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');

  it('passes the presenting session frame to the focus travel', () => {
    expect(viewer).toContain('focusTravel({ from, to: plan, radius: sphere.radius, frame: scheduleViewFrame');
  });

  it('prefers the XR session clock and falls back to the window only off-session', () => {
    const scheduler = viewer.slice(viewer.indexOf('function scheduleViewFrame'), viewer.indexOf('function startPresentationMotion'));
    expect(scheduler).toContain('canvas.xr.isPresenting.value');
    expect(scheduler).toContain('session.requestAnimationFrame(callback)');
    expect(scheduler).toContain(': requestAnimationFrame(callback)');
  });
});

describe('a grown tier lands obliquely and turns into it', () => {
  // Without the turn the strand's long axis runs into the screen, so the
  // protofilament draws 51.4 per cent of the lens against the dimer's 51.9 and
  // the step reads as thickening rather than lengthening. These fixtures are
  // that geometry: `girth` across the lens, `half` of the strand's length
  // straight down the view axis, which for the identity head below is -z.
  const strand = (half: number, girth = 20) => [
    [0, 0, half], [0, 0, -half], [girth, 0, 0], [-girth, 0, 0], [0, girth, 0], [0, -girth, 0],
  ];
  /** The same strand laid along x, which is a different tier's own file. */
  const acrossStrand = (half: number, girth = 20) => [
    [half, 0, 0], [-half, 0, 0], [0, 0, girth], [0, 0, -girth], [0, girth, 0], [0, -girth, 0],
  ];
  const dimer = strand(40), protofilament = strand(80), wall = acrossStrand(80, 45);
  const pose = { headInRoom: head, renderFromRoom: identity,
    placement: { translation: [0,0,0], rotation: [0,0,0], scale: 1 } };

  /**
   * The half width the wearer sees, in molecular units: the same measurement
   * `focusPlacement` solves its framing from, carried into the structure's own
   * frame through the placement rotation. It is what decides how much of the
   * molecule spans the lens once the lens band has fixed the width.
   */
  function acrossLens(points: number[][], rotation: number[]) {
    const outOfPlacement = Mat4.transpose(Mat4(), focusRotation(rotation));
    const into = (axis: number[]) => {
      const direction = Vec3.create(axis[0], axis[1], axis[2]);
      Vec3.transformDirection(direction, direction, outOfPlacement);
      return Array.from(Vec3.normalize(direction, direction));
    };
    return projectedExtent({ points, centre: [0,0,0],
      basis: { right: into([1,0,0]), up: into([0,1,0]), forward: into([0,0,-1]) } }).halfWidth;
  }

  it('turns a strand that stacks into the screen across the lens instead', () => {
    const turn = obliqueGrowthTurn({ ...pose, points: protofilament, centre: [0,0,0] });
    expect(turn.turned).toBe(true);
    // Straight down the view axis is 55 degrees off the oblique pose.
    expect(turn.deltaDegrees).toBeCloseTo(55, 0);
    // Four fifths of the strand's own length now reaches the lens.
    expect(turn.after).toBeCloseTo(Math.cos(GROWTH_TILT_DEGREES * Math.PI / 180), 6);
    expect(turn.before).toBeLessThan(.1);
    const before = acrossLens(protofilament, [0,0,0]);
    const after = acrossLens(protofilament, turn.rotation);
    expect(after / before).toBeGreaterThan(1.25);
    // And it is still an OBLIQUE pose, not a flat elevation: a third of the
    // strand still recedes, which is the depth cue that says it is solid.
    expect(Math.abs(Math.sin(GROWTH_TILT_DEGREES * Math.PI / 180))).toBeGreaterThan(.5);
  });

  it('makes the protofilament read a quarter longer than the dimer it grew from', () => {
    const dimerTurn = obliqueGrowthTurn({ ...pose, points: dimer, centre: [0,0,0] });
    const grownTurn = obliqueGrowthTurn({ ...pose, points: protofilament, centre: [0,0,0] });
    const grown = acrossLens(protofilament, grownTurn.rotation);
    // Both tiers land in the same pose, so the second dimer is length the
    // wearer can see rather than depth they cannot: twice the molecule, twice
    // the extent across the lens, against a dimer step that moved 0.5 per cent.
    expect(grown / acrossLens(dimer, dimerTurn.rotation)).toBeGreaterThan(1.25);
    // The defect it replaces: the same growth step, framed as it was.
    expect(acrossLens(protofilament, [0,0,0]) / acrossLens(dimer, [0,0,0])).toBeLessThan(1.05);
  });

  it('keeps the turned tier inside the lit lens band, seated on the eye line', () => {
    const turn = obliqueGrowthTurn({ ...pose, points: protofilament, centre: [0,0,0] });
    const placed = focusPlacement({ ...base, framing: 'fill', wholeStructure: true, enclosure: .85,
      elevationDegrees: 0, radius: 90, targetRadius: 90,
      placement: { ...base.placement, rotation: turn.rotation },
      subjectPoints: protofilament, assemblyPoints: protofilament });
    const share = placed.standoff.frame.share;
    expect(share.lit).toBeGreaterThanOrEqual(SUBJECT_LENS_FLOOR - 1e-6);
    expect(share.lit).toBeLessThanOrEqual(SUBJECT_GHOST_LENS_CEILING + 1e-6);
    expect(placed.standoff.frame.elevationTangent).toBeCloseTo(0, 6);
  });

  it('caps a growth landing with a long strand at SUBJECT_LENS_CEILING (0.50), not the whole-structure 0.55', () => {
    // On a growth landing the lit part obeys SUBJECT_LENS_CEILING
    // (0.50) rather than the whole-structure 0.60, so the oblique turn cannot
    // inflate the tier's width past the band.
    const longStrand = strand(160);
    const turn = obliqueGrowthTurn({ ...pose, points: longStrand, centre: [0,0,0] });
    expect(turn?.turned).toBe(true);
    const uncapped = focusPlacement({ ...base, framing: 'fill', wholeStructure: true, enclosure: .85,
      elevationDegrees: 0, radius: 170, targetRadius: 170,
      placement: { ...base.placement, rotation: turn!.rotation },
      subjectPoints: longStrand, assemblyPoints: longStrand });
    // The ceiling holds on the DRAWN rectangle, the turned
    // strand's own projection, so the grant sits under it by the drawn gain.
    expect(uncapped.standoff.frame.drawn.lit).toBeCloseTo(SUBJECT_WHOLE_LENS_CEILING, 3);
    expect(uncapped.standoff.frame.share.lit).toBeLessThanOrEqual(SUBJECT_WHOLE_LENS_CEILING + 1e-6);
    const landed = focusPlacement({ ...base, framing: 'fill', wholeStructure: true, enclosure: .85,
      elevationDegrees: 0, radius: 170, targetRadius: 170,
      placement: { ...base.placement, rotation: turn!.rotation },
      subjectPoints: longStrand, assemblyPoints: longStrand,
      subjectCeiling: SUBJECT_LENS_CEILING });
    const share = landed.standoff.frame.share;
    expect(share.lit).toBeGreaterThanOrEqual(SUBJECT_LENS_FLOOR - 1e-6);
    expect(share.lit).toBeLessThanOrEqual(SUBJECT_LENS_CEILING + 1e-6);
    expect(landed.standoff.frame.drawn.lit).toBeCloseTo(SUBJECT_LENS_CEILING, 3);
  });

  it('leaves a blob alone: a monomer has no long axis to show', () => {
    expect(obliqueGrowthTurn({ ...pose, points: strand(22), centre: [0,0,0] })).toBeUndefined();
  });

  it('reaches the wall from the protofilament without a perspective snap', () => {
    const grown = obliqueGrowthTurn({ ...pose, points: protofilament, centre: [0,0,0] });
    const landed = { ...pose, placement: { ...pose.placement, rotation: grown.rotation } };
    const next = obliqueGrowthTurn({ ...landed, points: wall, centre: [0,0,0] });
    // Both tiers are held to ONE canonical pose, so what is left between them
    // is the difference between two coordinate files' own axes, and it is
    // either already nothing or it is travelled over six-tenths of a second to
    // a second. It is never a cut.
    if (next?.turned) {
      expect(next.durationMs).toBeGreaterThanOrEqual(GROWTH_TURN_MIN_MS);
      expect(next.durationMs).toBeLessThanOrEqual(GROWTH_TURN_MAX_MS);
      expect(next.deltaDegrees).toBeLessThanOrEqual(90 + 1e-6);
    }
    const landedRotation = next?.turned ? next.rotation : grown.rotation;
    // And what the wearer sees of the two long axes agrees to within a degree:
    // the wall arrives lying the way the protofilament lay.
    const direction = (points: number[][], rotation: number[]) => {
      const axis = longestAxis({ points, centre: [0,0,0] }).axis;
      const placed = Vec3.transformDirection(Vec3(), Vec3.create(axis[0], axis[1], axis[2]), focusRotation(rotation));
      Vec3.normalize(placed, placed);
      return placed;
    };
    const before = direction(protofilament, grown.rotation);
    const after = direction(wall, landedRotation);
    const between = Math.acos(Math.min(1, Math.abs(Vec3.dot(before, after)))) * 180 / Math.PI;
    expect(between).toBeLessThan(1);
  });

  it('never cuts: the turn rides the travel easing and the travel is bounded', () => {
    for (const degrees of [0, 5, 30, 120, 179]) {
      const ms = growthTurnDurationMs(degrees);
      expect(ms).toBeGreaterThanOrEqual(GROWTH_TURN_MIN_MS);
      expect(ms).toBeLessThanOrEqual(GROWTH_TURN_MAX_MS);
    }
    expect(growthTurnDurationMs(120)).toBe(GROWTH_TURN_MAX_MS);
    // The eased share the travel hands its caller, which is what the viewer
    // turns by. Without it a turn would land in one frame.
    const eased: number[] = [];
    const pending: (() => void)[] = [];
    let clock = 0;
    void focusTravel({ from: { translation: [0,0,0], scale: 1 }, to: { translation: [1,0,0], scale: 2 },
      radius: 1, durationMs: 800, now: () => clock,
      step: (_offset: number[], _scale: number, share: number) => eased.push(share),
      frame: (callback: () => void) => pending.push(callback), defer: () => undefined });
    while (pending.length && clock < 800) { clock += 200; pending.shift()!(); }
    expect(eased[0]).toBe(0);
    expect(eased.at(-1)).toBeGreaterThan(0);
    expect(Math.max(...eased)).toBeLessThanOrEqual(1);
  });
});

describe('the viewer spends the turn on a landed tier only', () => {
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');

  it('owes a turn after a source swap that kept the room placement', () => {
    expect(viewer).toContain("inspectionState.place(sourceAnchor.placement, 'source-transition');");
    const pending = viewer.match(/pendingGrowthTurn = !sourceAnchor\.preservesCoordinateFrame;/)?.[0];
    expect(pending).toBeDefined();
    for (const preservesCoordinateFrame of [false, true]) {
      const context = { sourceAnchor: { preservesCoordinateFrame }, pendingGrowthTurn: false };
      vm.runInNewContext(pending!, context);
      expect(context.pendingGrowthTurn).toBe(!preservesCoordinateFrame);
    }
  });

  it('spends it on the next framing and never on the chapter after that', () => {
    const focus = viewer.slice(viewer.indexOf('const owedTurn = pendingGrowthTurn'), viewer.indexOf("await bakeGrab({ gesture: 'focus' })"));
    expect(focus).toContain('pendingGrowthTurn = false;');
    expect(focus).toContain('obliqueGrowthTurn({');
    // The framing is solved in the pose the tier will stand in.
    expect(focus).toContain('placement: posed');
    // And the turn is eased onto the same transient a released grip bakes.
    expect(focus).toContain('grabRotation = Mat4.fromRotation(Mat4(), turn.angleRadians * eased');
    expect(focus).toContain('durationMs: turn?.turned ? turn.durationMs : (');
    expect(focus).toContain('subjectCeiling: SUBJECT_LENS_CEILING');
  });

  it('drops the turn when the wearer poses the tier with their own hands', () => {
    const grab = viewer.slice(viewer.indexOf('function applyGrabDelta'), viewer.indexOf('async function bakeGrab'));
    expect(grab).toContain('pendingGrowthTurn = false;');
  });

  it('writes the turn into the plate-standoff ring for the next hardware run', () => {
    const record = viewer.slice(viewer.indexOf("record?.('plate-standoff'"), viewer.indexOf('plateNear: round(rule.plateNearMetres)'));
    expect(record).toContain('growth: turn ?');
    for (const field of ['delta:', 'ms:', 'tilt:', 'across:', 'was:', 'lit:']) expect(record).toContain(field);
  });
});

describe('a grown wall lands face-on, balanced and clear of the plate', () => {
  // Without the wall azimuth the grown wall reads 75.6 per cent amber, because
  // the shortest-arc turn leaves the twist about the landed long axis wherever
  // the arrival pose had it — an open sheet can land edge-on, its lateral
  // neighbours stacked in depth, with the beta plus-ends covering the view —
  // and it grazes the caption plate by 20 px. These fixtures are a
  // labeled wall sheet (axial alpha/beta alternation, lateral neighbours,
  // thin normal) arriving in the protofilament's landed pose, the canonical
  // growth sequence.
  const wallSubs: { point: number[]; label: 'alpha' | 'beta' }[] = [];
  for (const xi of [-60, -20, 20, 60]) for (const zi of [-30, 0, 30]) {
    const row = Math.round((xi + 60) / 40);
    wallSubs.push({ point: [xi, 0, zi + (Math.round((zi + 30) / 30) % 2 ? 10 : 0)],
      label: row % 2 === 0 ? 'alpha' : 'beta' });
  }
  const wallPoints = [...wallSubs.map(sub => sub.point), [85, 0, 0], [-85, 0, 0], [0, 12, 0], [0, -12, 0]];
  const strand = (half: number, girth = 20) => [
    [0, 0, half], [0, 0, -half], [girth, 0, 0], [-girth, 0, 0], [0, girth, 0], [0, -girth, 0],
  ];
  const arrival = (() => {
    const proto = obliqueGrowthTurn({ headInRoom: head, renderFromRoom: identity,
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      points: strand(80), centre: [0, 0, 0] });
    return { translation: [0, 0, 0], rotation: proto!.rotation, scale: 1 };
  })();
  const land = (azimuthDegrees = 0) => obliqueGrowthTurn({ headInRoom: head, renderFromRoom: identity,
    placement: arrival, points: wallPoints, centre: [0, 0, 0], azimuthDegrees })!;
  /** Pose measures in the lens frame: axial/lateral spread across it, face toward it. */
  const poseOf = (rotation: number[]) => {
    const to = (axis: number[]) => Vec3.transformDirection(Vec3(), Vec3.create(axis[0], axis[1], axis[2]), focusRotation(rotation));
    const right = Vec3.create(1, 0, 0), up = Vec3.create(0, 1, 0), fwd = Vec3.create(0, 0, -1);
    const across = (direction: any) => Math.hypot(Vec3.dot(direction, right), Vec3.dot(direction, up));
    return { axialAcross: across(to([1, 0, 0])), lateralAcross: across(to([0, 0, 1])),
      faceOn: Math.abs(Vec3.dot(to([0, 1, 0]), fwd)) };
  };
  /** Alpha share of the subunits nothing hides, by projected occlusion. */
  const facingRatioOf = (rotation: number[]) => {
    const R = focusRotation(rotation);
    const projected = wallSubs.map(sub => {
      const p = Vec3.transformDirection(Vec3(), Vec3.create(sub.point[0], sub.point[1], sub.point[2]), R);
      return { label: sub.label, depth: Vec3.dot(p, Vec3.create(0, 0, -1)),
        lx: Vec3.dot(p, Vec3.create(1, 0, 0)), ly: Vec3.dot(p, Vec3.create(0, 1, 0)) };
    });
    let alpha = 0, visible = 0;
    for (const one of projected) {
      const hidden = projected.some(other => other !== one
        && Math.hypot(other.lx - one.lx, other.ly - one.ly) < 0.09 && other.depth > one.depth + 1e-6);
      if (!hidden) { visible += 1; if (one.label === 'alpha') alpha += 1; }
    }
    return visible ? alpha / visible : NaN;
  };

  it('leaves the twist wherever the arrival had it without an azimuth, edge-on here', () => {
    const turn = land();
    expect(turn.azimuthDegrees).toBe(0);
    const pose = poseOf(turn.rotation);
    // The axis is across the lens but the sheet is edge-on: neighbours stack
    // in depth instead of spreading across the lens.
    expect(pose.axialAcross).toBeGreaterThan(0.75);
    expect(pose.faceOn).toBeLessThan(0.3);
  });

  it('lands the wall face-on with the wall azimuth: axis across, neighbours spread, alpha/beta even', () => {
    const plain = land(), walled = land(GROWTH_WALL_AZIMUTH_DEGREES);
    // The arc itself is untouched: same degrees, same window, same reach.
    expect(walled.deltaDegrees).toBeCloseTo(plain.deltaDegrees, 9);
    expect(walled.durationMs).toBe(plain.durationMs);
    expect(walled.azimuthDegrees).toBe(GROWTH_WALL_AZIMUTH_DEGREES);
    const pose = poseOf(walled.rotation);
    expect(pose.axialAcross).toBeGreaterThanOrEqual(0.75);
    expect(pose.lateralAcross).toBeGreaterThanOrEqual(0.9);
    expect(pose.faceOn).toBeGreaterThanOrEqual(0.75);
    // And the landed face reads balanced: the visible alpha share sits in the
    // 40-60 per cent band instead of the 75 per cent amber of an untwisted
    // landing.
    const ratio = facingRatioOf(walled.rotation);
    expect(ratio).toBeGreaterThanOrEqual(0.4);
    expect(ratio).toBeLessThanOrEqual(0.6);
  });

  it('clears the caption plate on a wall-sized growth landing and records its rectangle', () => {
    // The growth landing runs the same plate avoidance as a tour chapter:
    // subject ceiling, caption points, and the recorded caption rectangle.
    const captionCard = [[-.75, 1.85, -1], [-.1, 1.85, -1], [-.75, 2.3, -1], [-.1, 2.3, -1]];
    const menuColumn = [[-1.05, .2, -1], [-.55, .2, -1], [-1.05, 1.7, -1], [-.55, 1.7, -1]];
    const wallish = strand(160, 60);
    const turn = land(GROWTH_WALL_AZIMUTH_DEGREES);
    expect(turn.turned).toBe(true);
    const landed = focusPlacement({ ...base, framing: 'fill', wholeStructure: true, enclosure: .85,
      elevationDegrees: 0, radius: 170, targetRadius: 170,
      placement: { ...base.placement, rotation: turn.rotation },
      subjectPoints: wallish, assemblyPoints: wallish,
      platePoints: [...captionCard, ...menuColumn], captionPoints: captionCard, menuPoints: menuColumn,
      subjectCeiling: SUBJECT_LENS_CEILING });
    const frame = landed.standoff.frame;
    // The caption rectangle is recorded for the growth landing and the subject
    // sits clear of it. Size is covered elsewhere; this test is the clearance
    // one.
    expect(frame.caption).not.toBe(null);
    expect(frame.overlap).toBe(false);
  });
});

describe('the viewer lands a grown tier with the new key, face and clearance', () => {
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');

  it('forgets the previous chapter framing key across a source swap', () => {
    expect(viewer).toContain('lastLessonChapterKey = undefined;');
  });

  it('twists whole-structure growth landings by the wall azimuth', () => {
    const focus = viewer.slice(viewer.indexOf('const owedTurn = pendingGrowthTurn'), viewer.indexOf("await bakeGrab({ gesture: 'focus' })"));
    expect(focus).toContain('azimuthDegrees: GROWTH_WALL_AZIMUTH_DEGREES');
    // Stable atomic lesson glass is fitted jointly after the natural frame;
    // density and other landings still avoid the current caption directly.
    expect(focus).toContain('const jointLessonGlass = !volume && offeredSeats.some(seat => seat.stableLesson)');
    expect(focus).toContain('captionPoints: jointLessonGlass ? [] : captions');
    expect(focus).toContain('menuPoints: jointLessonGlass ? [] : menus');
    expect(focus).toContain('menuPoints: seat.points, menuGlass: seat.glass');
    expect(focus).toContain('fitChapterField({ ...glassFor(seat), clearanceOnly: true');
  });

  it('records the landing azimuth beside the tilt and the roll', () => {
    const record = viewer.slice(viewer.indexOf("record?.('plate-standoff'"), viewer.indexOf('plateNear: round(rule.plateNearMetres)'));
    expect(record).toContain('azimuth:');
  });
});
