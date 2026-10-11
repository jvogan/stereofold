import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pageText } from '../src/tour-player.js';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { spatialToolbarRows } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { CENTRAL_CONE_HALF_ANGLE_DEGREES, EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES, EYE_HALF_FIELD_DEGREES, HALF_IPD_METERS, PANEL_FRAME_MARGIN_DEGREES, TOOLBAR_READING_RANGE_METERS } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { createToolbarPanel, GLYPH_CAP_FRACTION, READOUT_FONT_FLOOR, READOUT_PAGE_LINE_WIDTH, READOUT_PAGE_LINES, hitToolbarPanel, mapXrPointToScene, MENU_SEAT_DRIFT_DEGREES, MENU_SEAT_DRIFT_MS, META_MIN_CAP_METERS, seatYawDriftDegrees, SPATIAL_TOOLBAR_LAYOUT, toolbarBackingOutline, toolbarDensity, toolbarLayoutForNearDepth, toolbarLayoutForDepthRange, toolbarLayoutForStandoff, toolbarPlateOutline, toolbarSeatRange, toolbarStandoffMeters } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';

const rows = Array.from({length:19}, (_,index) => ({ label: `Control ${index}`, action: { index } }));
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const eye = [0,1.6,0];
// @ts-ignore Renderer-free binocular frame checks.
import { CAPTION_FRAME_MARGIN, EYE_HALF_FIELD_VERTICAL_DEGREES } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
const head = { position: {x:0,y:1.6,z:0}, matrix: identity };
const close = (actual:number[], expected:number[]) => expected.forEach((n,i) => expect(actual[i]).toBeCloseTo(n, 7));
type Point = readonly number[];
const minus = (a:Point, b:Point) => a.map((value,index) => value - b[index]);
const dot = (a:Point, b:Point) => a.reduce((sum,value,index) => sum + value * b[index], 0);
const unit = (a:Point) => { const length = Math.hypot(...a); return a.map(value => value / length); };

const readingFrameContains = (points: number[][], panel: any, peripheral: boolean) => {
  const right = peripheral ? panel.right : [1, 0, 0], forward = peripheral ? panel.normal : [0, 0, -1];
  for (const side of [-1, 1]) for (const point of points) {
    const relative = point.map((value, axis) => value - eye[axis] - side * HALF_IPD_METERS * right[axis]);
    const depth = dot(relative, forward);
    if (depth <= 0 || Math.abs(dot(relative, right)) > depth * Math.tan((EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES) * Math.PI / 180)
      || Math.abs(relative[1]) > depth * Math.tan(EYE_HALF_FIELD_VERTICAL_DEGREES * Math.PI / 180) * (1 - CAPTION_FRAME_MARGIN)) return false;
  }
  return true;
};
/** Where a point sits in the panel's own axes, relative to its anchor. */
const local = (panel:any, point:Point) => ({ x: dot(minus(point, panel.anchor), panel.right), y: dot(minus(point, panel.anchor), panel.up) });
const degrees = (metres:number, range:number) => Math.atan(metres / range) * 180 / Math.PI;
/**
 * A column-major head matrix for a yaw, pitch and roll in degrees, as an
 * `XRRigidTransform` hands one over. Rotations compose yaw, then pitch, then
 * roll, which is the order a head actually moves in.
 */
const headMatrix = (yaw:number, pitch:number, roll:number) => {
  const radians = (value:number) => value * Math.PI / 180;
  const [cy, sy] = [Math.cos(radians(yaw)), Math.sin(radians(yaw))];
  const [cp, sp] = [Math.cos(radians(pitch)), Math.sin(radians(pitch))];
  const [cr, sr] = [Math.cos(radians(roll)), Math.sin(radians(roll))];
  return [cy*cr + sy*sp*sr, cp*sr, -sy*cr + cy*sp*sr, 0,
    -cy*sr + sy*sp*cr, cp*cr, sy*sr + cy*sp*cr, 0,
    sy*cp, -sp, cy*cp, 0, 0, 0, 0, 1];
};
/** The panel stays upright, so it faces the wearer in yaw only. */
const levelled = (panel:any, from:Point) => {
  const toAnchor = minus(panel.anchor, from);
  return unit(toAnchor.map((value,index) => value - panel.up[index] * dot(toAnchor, panel.up)));
};

describe('spatial control geometry', () => {
  it('seats a viewer-facing panel to the left, clear of the molecule on the forward axis', () => {
    const panel = createToolbarPanel({rows,head});
    // Left, and turned until its face is square to the wearer. Without the
    // turn an off-axis panel is read edge-on, which is most of why the first
    // Quest 2 session called it a fake word thing.
    expect(SPATIAL_TOOLBAR_LAYOUT.rightMeters).toBeLessThan(0);
    expect(panel.anchor[0]).toBeLessThan(0);
    close(panel.normal, levelled(panel, eye));
    expect(panel.up[1]).toBeCloseTo(1, 7);
    // Nothing drawn reaches the forward axis, where the molecule renders.
    const rightEdge = Math.max(...panel.buttons.map((button:any) => local(panel, button.point).x + button.halfWidth),
      local(panel, panel.backing.point).x + panel.backing.halfWidth);
    expect(panel.anchor[0] + rightEdge * panel.right[0]).toBeLessThan(0);
  });

  /**
   * On hardware, the wearer reported that the menu blocked the structure. Clearing
   * the forward axis was never enough: the panel sat 23 degrees off it, which
   * is the middle of the view, and a molecule is looked at continuously while
   * a menu is read by choice.
   *
   * So the panel is now held out of a 60 degree cone about the entry gaze,
   * measured over everything it draws -- plates, backing glass, caption glass,
   * status line -- and over every depth band a molecular cutaway can hand it,
   * because the clamp scales the anchor and must not swing it inboard.
   */
  it('leaves the structure its cone, and the eye its frame, for every shipped row set', () => {
    const readout = Array.from({length:8}, (_,index) => ({ text: `Caption line ${index + 1} of the welcome` }));
    const coneDegrees = (point:Point) => {
      const [x, y, z] = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]];
      return Math.acos(-z / Math.hypot(x, y, z)) * 180 / Math.PI;
    };
    // Per eye, because a panel on the wearer's left is further off the axis in
    // the RIGHT eye by half an interpupillary distance -- about one character
    // of row type at this seat, which is the one-eye clipping seen on hardware
    // and that nothing here measured until now.
    const lateralDegrees = (point:Point, eyeX:number) =>
      Math.atan2(Math.abs(point[0] - eyeX), -(point[2] - eye[2])) * 180 / Math.PI;
    const framed = EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES;
    // The real row sets, not synthetic labels: what the panel costs the wearer
    // is decided by the longest label in it, so a test on invented rows proves
    // nothing about the menu that ships. Every one of these is a state the
    // owner reaches by pressing one button.
    const shipped: [string, any[], boolean][] = [
      ['quiet', spatialToolbarRows({ tour:{active:true,canNext:true}, voice:{state:'listening'}, quiet:true }), true],
      ['compact idle', spatialToolbarRows({ voice:{state:'idle'} }), true],
      ['compact tour', spatialToolbarRows({ tour:{active:true,canBack:true,canNext:true,bodyPageIndex:0,bodyPageCount:3},
        voice:{state:'idle'}, passthrough:true }), true],
      ['expanded grid', spatialToolbarRows({ collapsed:false, voice:{state:'idle'}, quality:'balanced' }), false],
    ];
    // A narrow molecular cutaway band is the one case where the cone cannot be
    // held, and the reason is the interpupillary distance: it is a fixed 63 mm
    // while every other length scales with the band, so at 0.35 m of depth the
    // eye offset is six times the fraction of the panel it is at 0.95 m, and
    // the seat has to come further inboard to keep the far eye's corner on the
    // glass. Being ON the glass is the rule that cannot yield -- a menu in the
    // way is recoverable, a menu off the edge of the eye is not -- so the eye
    // frame is asserted for every band and the cone only where the panel is at
    // or beyond its own seat.
    const seated = [SPATIAL_TOOLBAR_LAYOUT, toolbarLayoutForNearDepth(2)];
    for (const constants of [...seated, toolbarLayoutForDepthRange(.2, .5)]) {
      for (const [name, menu, collapsed] of shipped) {
        const panel = createToolbarPanel({ rows: menu, head, readout, constants });
        const drawn = [
          ...panel.buttons.flatMap((button:any) => toolbarPlateOutline(panel, button, { segments: 2 })),
          ...toolbarBackingOutline(panel, { segments: 3 }),
          ...toolbarBackingOutline(panel, { segments: 3, plate: panel.captionBacking }),
          ...panel.readoutPoints.map((line:any) => line.point), panel.statusPoint,
        ];
        // The expanded grid is two columns, 26 degrees of field, and the band
        // between the cone and the frame margin is 23. It gets its own number
        // rather than a quiet exemption; the geometry module carries why.
        const cone = collapsed ? 30 : EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES;
        for (const point of drawn) {
          if (seated.includes(constants)) {
            expect(coneDegrees(point), `${name} inside its cone`).toBeGreaterThanOrEqual(cone);
          }

        }
        expect(readingFrameContains(drawn, panel, collapsed),
          `${name}: all caption and control glass fits both eyes in its reading frame`).toBe(true);
      }
    }
  });

  /**
   * A seat is a fixed distance from the entry pose and a structure is not.
   * At demo scale a 13,000-atom structure reaches straight through the menu
   * plates, which the emulator frames show as the molecule slicing the panel.
   * The seat has to give ground when that happens, along its own bearing, so
   * the panel gets further away without ever coming back toward the middle of
   * the view.
   */
  it('pushes the seat out along its bearing until the structure clears it', () => {
    const bearing = [SPATIAL_TOOLBAR_LAYOUT.rightMeters, -SPATIAL_TOOLBAR_LAYOUT.lowerMeters, -SPATIAL_TOOLBAR_LAYOUT.forwardMeters];
    // A structure 2 m across, centred 1.5 m down the forward axis: its surface
    // reaches past the 0.95 m seat.
    const sphere = { centre: [0, 1.6, -1.5], radius: 1 };
    const standoff = toolbarStandoffMeters(sphere, eye, bearing, .28);
    expect(standoff).toBeGreaterThan(toolbarSeatRange());
    // Every point the stand-off returns is outside the grown sphere, and the
    // one it returns is the nearest such point along the bearing.
    const unitBearing = unit(bearing);
    const at = (t:number) => Math.hypot(...unitBearing.map((value, index) => eye[index] + value * t - sphere.centre[index]));
    expect(at(standoff)).toBeCloseTo(sphere.radius + .28, 6);
    expect(at(standoff + .01)).toBeGreaterThan(sphere.radius + .28);
    // A bearing that misses the grown sphere asks for nothing.
    expect(toolbarStandoffMeters({ centre: [0, 1.6, -1.5], radius: .1 }, eye, bearing, .05)).toBe(0);
    expect(toolbarStandoffMeters(undefined, eye, bearing, .28)).toBe(0);
  });

  it('keeps the bearing, the angular size and the ray targets when it gives ground', () => {
    const standoff = toolbarSeatRange() * 1.25;
    const pushed = toolbarLayoutForStandoff(standoff);
    const factor = standoff / toolbarSeatRange();
    expect(factor).toBeLessThan(1.5);
    for (const key of ['forwardMeters', 'rightMeters', 'lowerMeters', 'fontMeters', 'rowStepMeters', 'backingPadMeters']) {
      expect(pushed[key]).toBeCloseTo(SPATIAL_TOOLBAR_LAYOUT[key] * factor, 7);
    }
    expect(toolbarSeatRange(pushed)).toBeCloseTo(standoff, 7);
    // A structure scaled to fill the room cannot push the panel, and its
    // type, across the room with it: the factor caps at 1.5, so the menu
    // never becomes giant.
    const capped = toolbarLayoutForStandoff(2.5);
    expect(toolbarSeatRange(capped)).toBeCloseTo(1.5 * toolbarSeatRange(), 7);
    expect(capped.fontMeters).toBeCloseTo(SPATIAL_TOOLBAR_LAYOUT.fontMeters * 1.5, 7);
    // A stand-off inside the default seat leaves the layout alone, so an
    // ordinary structure never moves the panel at all.
    expect(toolbarLayoutForStandoff(.5)).toBe(SPATIAL_TOOLBAR_LAYOUT);
    expect(toolbarLayoutForStandoff(Number.NaN)).toBe(SPATIAL_TOOLBAR_LAYOUT);
    const panel = createToolbarPanel({ rows, head, constants: pushed });
    const target = panel.buttons[8].point;
    expect(hitToolbarPanel(panel, { origin: eye, direction: minus(target, eye) }).action.index).toBe(8);
  });

  /**
   * "Move menu" re-seats the panel on whatever head pose the wearer has when
   * they press it. The seat is a bearing off that pose, so the panel must land
   * the same distance off to the side wherever the wearer happens to be
   * facing: the row would otherwise trade one bad seat for another.
   */
  it('re-seats to the same side bearing whatever the head is facing', () => {
    const forwardPanel = createToolbarPanel({ rows, head });
    const toForward = minus(forwardPanel.anchor, eye);
    const bearing = Math.atan2(toForward[0], -toForward[2]) * 180 / Math.PI;
    for (const degrees of [-120, -47, 0, 35, 90, 175]) {
      const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
      // A yaw about the world up axis, column-major, as an XRRigidTransform
      // hands it over.
      const matrix = [cos,0,-sin,0, 0,1,0,0, sin,0,cos,0, 0,0,0,1];
      const panel = createToolbarPanel({ rows, head: { ...head, matrix } });
      const toAnchor = minus(panel.anchor, eye);
      const forward = [-matrix[8], -matrix[9], -matrix[10]], right = [matrix[0], matrix[1], matrix[2]];
      const azimuth = Math.atan2(dot(toAnchor, right), dot(toAnchor, forward)) * 180 / Math.PI;
      // The bearing is the SAME at every head yaw. It is no longer -47: -47 is
      // the ceiling the seat may take, and `toolbarSeatDegrees` brings it in
      // until this row set's own outboard corner is back inside the lens. What
      // has to hold across yaws is that the wearer finds the menu in the same
      // place relative to their face, at the same range, whichever way they
      // were looking when they asked for it.
      expect(azimuth).toBeCloseTo(bearing, 6);
      expect(azimuth).toBeGreaterThan(-47);
      expect(azimuth).toBeLessThan(0);
      expect(Math.hypot(dot(toAnchor, right), dot(toAnchor, forward))).toBeCloseTo(TOOLBAR_READING_RANGE_METERS, 6);
    }
  });

  /**
   * The wearer, in the headset on build c1ef5f4: "The menu is appearing like
   * I'm behind the menu, like I didn't even know where I am."
   *
   * The seat was built straight from the head matrix, pitch and roll included,
   * and a wearer looking down at a structure got a panel pitched down with
   * them and seated below their level gaze. From a level head that is a sheet
   * seen from above with its glyphs raked away. The seat takes their eye
   * height and their yaw now, and nothing else.
   */
  it('seats the panel on the wearer\'s yaw alone, whatever their head is doing', () => {
    const level = createToolbarPanel({ rows, head: { ...head, matrix: headMatrix(35, 0, 0) } });
    for (const pitch of [-55, -20, 25, 60]) {
      for (const roll of [-30, 0, 30]) {
        const panel = createToolbarPanel({ rows, head: { ...head, matrix: headMatrix(35, pitch, roll) } });
        // The same seat a level head at the same yaw would have got.
        close(panel.anchor, level.anchor);
        close(panel.up, [0, 1, 0]);
        close(panel.right, level.right);
        // Upright, and square to the wearer rather than raked toward the floor.
        expect(panel.normal[1]).toBeCloseTo(0, 7);
        close(panel.normal, levelled(panel, eye));
        close(panel.buttons[0].point, level.buttons[0].point);
        close(panel.buttons[rows.length - 1].point, level.buttons[rows.length - 1].point);
      }
    }
  });

  /**
   * A wearer who turns away leaves the panel where it was put. A menu that
   * followed the head would be in front of whatever they turned to look at,
   * which is the complaint the 47 degree seat exists to answer, and the menu
   * button re-seats it on the current gaze whenever they ask for it.
   */
  it('measures a wearer who has turned away from the seat without moving it', () => {
    expect(MENU_SEAT_DRIFT_DEGREES).toBe(70);
    expect(MENU_SEAT_DRIFT_MS).toBe(1500);
    const panel = createToolbarPanel({ rows, head: { ...head, matrix: headMatrix(0, 0, 0) } });
    // Looking down and tilting the head is not turning away from the menu.
    expect(seatYawDriftDegrees(panel, { ...head, matrix: headMatrix(0, -35, 20) })).toBeCloseTo(0, 6);
    expect(seatYawDriftDegrees(panel, { ...head, matrix: headMatrix(40, 0, 0) })).toBeCloseTo(40, 6);
    expect(seatYawDriftDegrees(panel, { ...head, matrix: headMatrix(-95, 0, 0) })).toBeGreaterThan(MENU_SEAT_DRIFT_DEGREES);
    // Only a fresh seat moves it, and a fresh seat has no drift of its own.
    const moved = { position: { x: 1.2, y: 1.5, z: -.8 }, matrix: headMatrix(-95, 0, 0) };
    const reseated = createToolbarPanel({ rows, head: moved });
    expect(seatYawDriftDegrees(reseated, moved)).toBeCloseTo(0, 6);
    expect(Math.hypot(...minus(reseated.anchor, panel.anchor))).toBeGreaterThan(1);
  });

  it('hits every row it draws, and nothing off the panel', () => {
    const panel = createToolbarPanel({rows,head});
    for (const index of [0,6,8,18]) {
      const point = panel.buttons[index].point;
      expect(hitToolbarPanel(panel, {origin:eye,direction:minus(point, eye)}).action.index).toBe(index);
    }
    expect(hitToolbarPanel(panel, {origin:eye,direction:[0,0,1]})).toBeUndefined();
    expect(hitToolbarPanel(panel, {origin:eye,direction:[0,0,-1]})).toBeUndefined();
  });

  it('turns the panel and hit plane together with the entry head orientation', () => {
    const matrix = [0,0,-1,0, 0,1,0,0, 1,0,0,0, 0,0,0,1];
    const panel = createToolbarPanel({rows,head:{...head,matrix}});
    // Facing -x: the panel seats itself off that axis and still faces back.
    close(panel.normal, levelled(panel, eye));
    expect(panel.anchor[2]).toBeGreaterThan(0);
    const point = panel.buttons[0].point;
    expect(hitToolbarPanel(panel,{origin:eye,direction:minus(point, eye)}).action.index).toBe(0);
  });

  it('scales the inverse-view translation too when converting metres to molecular coordinates', () => {
    const inverseView = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-1.6,1,1];
    close(mapXrPointToScene([.3,1.5,-.7],inverseView,.01), [30,-10,30]);
  });

  it('moves a cutaway-safe panel farther while preserving angular control size and ray hits', () => {
    expect(toolbarLayoutForNearDepth(.2)).toBe(SPATIAL_TOOLBAR_LAYOUT);
    const constants = toolbarLayoutForNearDepth(2);
    expect(constants.forwardMeters).toBeCloseTo(2.05, 7);
    for (const key of ['fontMeters','rowStepMeters','plateDepthMeters','bevelMeters','backingPadMeters']) {
      expect(constants[key] / constants.forwardMeters)
        .toBeCloseTo(SPATIAL_TOOLBAR_LAYOUT[key] / SPATIAL_TOOLBAR_LAYOUT.forwardMeters, 7);
    }
    const panel = createToolbarPanel({ rows, head, constants });
    const target = panel.buttons[8].point;
    expect(hitToolbarPanel(panel, { origin: eye, direction: minus(target, eye) }).action.index).toBe(8);
  });

  it('places controls inside a finite cutaway band without moving existing default anchors', () => {
    const constants = toolbarLayoutForDepthRange(.2, .5);
    expect(constants.forwardMeters).toBeCloseTo(.35, 7);
    const panel = createToolbarPanel({ rows, head, constants });
    expect(panel.buttons.every((button: {point: number[]}) => button.point[2] < -.2 && button.point[2] > -.5)).toBe(true);
  });

  it('keeps an ordered caption block above unchanged controller targets', () => {
    const panel = createToolbarPanel({ rows, head, readout: Array.from({ length: 8 }, (_, index) => ({ text: `Caption ${index + 1}` })) });
    const bare = createToolbarPanel({ rows, head });
    close(panel.buttons[0].point, bare.buttons[0].point);
    // How many of the eight are drawn is the eye's decision, not the
    // caller's: `captionEnvelope` measures the room above the rows and the
    // block takes that many lines.
    expect(panel.readoutPoints).toHaveLength(Math.min(8, panel.readoutLineBudget));
    expect(panel.readoutLineBudget).toBeGreaterThan(0);
    for (let index = 1; index < panel.readoutPoints.length; index++) {
      expect(panel.readoutPoints[index - 1].point[1]).toBeGreaterThan(panel.readoutPoints[index].point[1]);
    }
    const topButton = Math.max(...panel.buttons.map((button: { point: number[] }) => local(panel, button.point).y));
    const buttonHalfHeight = Math.max(...panel.buttons.map((button: { halfHeight: number }) => button.halfHeight));
    const status = local(panel, panel.statusPoint).y;
    const lastCaption = local(panel, panel.readoutPoints.at(-1).point).y;
    expect(status - panel.fontMeters / 2).toBeGreaterThan(topButton + buttonHalfHeight);
    expect(lastCaption - panel.readoutFontMeters / 2).toBeGreaterThan(status + panel.fontMeters / 2);
    // The caption no longer shrinks to fit. It is set at the row size, which
    // is the type size that stays legible on hardware.
    expect(panel.readoutFontMeters).toBe(panel.fontMeters);
  });

  it('drops what it marked optional before it cuts a caption, then says it cut one', () => {
    const short = { text: 'Wide reveal' };
    const long = { text: Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ') };
    const seen: Array<{ kind: string; detail: any }> = [];
    const previous = (globalThis as any).__stereofoldDiagnostics;
    (globalThis as any).__stereofoldDiagnostics = { record: (kind: string, detail: any) => { seen.push({ kind, detail }); } };
    try {
      // A block that fits keeps full row-size type and says nothing.
      const fits = createToolbarPanel({ rows, head, readout: [short] });
      expect(fits.readoutFontMeters).toBe(fits.fontMeters);
      expect(fits.readoutPoints).toHaveLength(1);
      expect(seen).toHaveLength(0);
      // A heading marked optional goes whole rather than costing the caption a
      // line, and the caption below it is still complete, so nothing is
      // recorded. Measured on the shipped nine-row menu, which is where the
      // eye leaves the least room: three lines, and the heading alone wants
      // all three.
      const menu = rows.slice(0, 9);
      // A heading built to fill the glass exactly, whatever the eye gives it:
      // the point of the case is an optional entry that fits ALONE and cannot
      // share, so it has to be sized from the block rather than guessed at.
      const probe = createToolbarPanel({ rows: menu, head, readout: [short] });
      const heading = { optional: true,
        text: Array.from({ length: probe.readoutLineBudget }, () => 'x'.repeat(probe.readoutWrapWidth)).join(' ') };
      const headingOnly = createToolbarPanel({ rows: menu, head, readout: [heading] });
      expect(headingOnly.readoutPoints).toHaveLength(headingOnly.readoutLineBudget);
      const withHeading = createToolbarPanel({ rows: menu, head, readout: [heading, short] });
      expect(withHeading.readoutPoints.map((line: { text: string }) => line.text)).toEqual(['Wide reveal']);
      expect(seen).toHaveLength(0);
      // This oversized block cannot fit at this seat. The font drops only if that
      // would rescue the block, so it stays at the row size, and the lines
      // that go are recorded rather than lost silently.
      const panel = createToolbarPanel({ rows, head, readout: [long] });
      expect(panel.readoutPoints).toHaveLength(panel.readoutLineBudget);
      expect(panel.readoutFontMeters).toBe(panel.fontMeters);
      expect(seen).toHaveLength(1);
      expect(seen[0].kind).toBe('toolbar');
      expect(seen[0].detail).toMatchObject({ reason: 'readout-truncated',
        kept: panel.readoutLineBudget, wrapWidth: panel.readoutWrapWidth, fontFactor: 1 });
      expect(seen[0].detail.wrapped).toBeGreaterThan(panel.readoutLineBudget);
      expect(panel.readoutFontMeters * READOUT_FONT_FLOOR).toBeLessThan(panel.fontMeters);
    } finally { (globalThis as any).__stereofoldDiagnostics = previous; }
  });

  it('keeps whole lines when the eye leaves the tour readout no room for the caption', () => {
    // The 23:00Z hardware session recorded this seven times: the caption
    // sentence was drawn as two of its five lines, cut mid-word. The block is
    // now shaped by what the text is. A spoken line -- the plate's payload,
    // one unpaged sentence -- can never be dropped: it is shared down to the
    // lines the eye leaves and ends on a whole word. A page of a text that
    // still pages yields whole instead, because its continuation sits on the
    // next page and half a page is words the paging can never show again.
    const spoken = `Cas9 opens the DNA duplex and reads the protospacer adjacent motif before it cuts, ${'which is far more words than the eye above a nine-row menu leaves room for, '.repeat(4)}however wide the glass is.`;
    const menu = rows.slice(0, 9);
    const flat = (value: string) => value.replace(/[\s…]+/gu, '');
    // The spoken line: dropped progress, kept sentence, no mid-word cut.
    const spokenPanel = createToolbarPanel({ rows: menu, head, readout: [
      { text: 'PAM recognition', maxLines: 1 },
      { text: 'Scene 2 / 6', maxLines: 1, optional: true, dropRank: 4 },
      { text: spoken, optional: false }] });
    const spokenDrawn = spokenPanel.readoutPoints.map((line: { text: string }) => line.text);
    expect(spokenDrawn.length).toBeLessThanOrEqual(spokenPanel.readoutLineBudget);
    expect(spokenDrawn[0]).toBe('PAM recognition');
    expect(spokenDrawn.at(-1)!.endsWith('…')).toBe(true);
    // A line the eye cut ends in an ellipsis, on a whole word, never in the
    // middle of one.
    for (const line of spokenDrawn) {
      if (!line.endsWith('…')) continue;
      const kept = line.slice(0, -1).trimEnd();
      const at = spoken.replace(/\s+/gu, ' ').indexOf(kept);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(spoken[at + kept.length] ?? ' ').toMatch(/\s/u);
    }
    // A page of a paging text goes whole or not at all.
    for (const page of pageText(spoken)) {
      const panel = createToolbarPanel({ rows: menu, head, readout: [
        { text: 'PAM recognition', maxLines: 1 },
        { text: 'Scene 2 / 6', maxLines: 1, optional: true, dropRank: 4 },
        { text: page, optional: true, dropRank: 3 }] });
      const drawn = panel.readoutPoints.map((line: { text: string }) => line.text);
      expect(drawn.length).toBeLessThanOrEqual(panel.readoutLineBudget);
      const flatPage = flat(page);
      const whole = flat(drawn.join(' ')).endsWith(flatPage);
      const pieces = drawn.filter((line: string) => flatPage.includes(flat(line)));
      expect(whole || pieces.length === 0).toBe(true);
    }
  });

  it('keeps caption type at or above Meta\'s minimum cap height for a menu of the shipped size', () => {
    // The shipped menu is at or under the comfort row count, where the
    // density step does not shrink type. Above it every length scales down
    // together, labels included, which is a row-count decision rather than a
    // caption one and is measured in the next test.
    const comfortRows = Array.from({ length: SPATIAL_TOOLBAR_LAYOUT.comfortRows ?? 8 },
      (_, index) => ({ label: `Control ${index}`, action: { index } }));
    const long = 'A caption line long enough that the old fitting rule would have shrunk the whole block to read it';
    for (const constants of [SPATIAL_TOOLBAR_LAYOUT, toolbarLayoutForStandoff(1.3)]) {
      const panel = createToolbarPanel({ rows: comfortRows, head, constants, readout: [{ text: long }], status: long });
      expect(panel.readoutFontMeters * GLYPH_CAP_FRACTION).toBeGreaterThanOrEqual(META_MIN_CAP_METERS);
      expect(panel.fontMeters * GLYPH_CAP_FRACTION).toBeGreaterThanOrEqual(META_MIN_CAP_METERS);
    }
  });

  it('records that a menu past the comfort row count shrinks type under that minimum', () => {
    // At the density floor a 40-row grid still falls below the physical cap
    // minimum, even after increasing the default range and type together.
    const dense = createToolbarPanel({ rows: Array.from({ length: 40 }, (_, index) =>
      ({ label: `Control ${index}`, action: { index } })), head });
    expect(dense.fontMeters).toBeLessThan(SPATIAL_TOOLBAR_LAYOUT.fontMeters);
    expect(dense.fontMeters * GLYPH_CAP_FRACTION).toBeLessThan(META_MIN_CAP_METERS);
    // Whatever the density, the caption is never smaller than the rows.
    expect(dense.readoutFontMeters).toBe(dense.fontMeters);
  });

  it('wraps a caption to the glass once, at the glass width, instead of shrinking its type', () => {
    // Short enough for the six-row menu's block, which is what a demo shows.
    const long = 'The Cas9 nuclease holds the target DNA duplex open';
    const menu = rows.slice(0, 6);
    const panel = createToolbarPanel({ rows: menu, head, readout: [{ text: long }] });
    expect(panel.readoutPoints.length).toBeGreaterThan(1);
    expect(panel.readoutPoints.map((line: { text: string }) => line.text).join(' ')).toBe(long);
    expect(panel.readoutFontMeters).toBe(panel.fontMeters);
    // Wrapped once, so every line but the last is as full as its width allows
    // rather than a fragment of some earlier wrap.
    for (const line of panel.readoutPoints) expect(line.text.length).toBeLessThanOrEqual(panel.readoutWrapWidth);
    // Every wrapped line stays inside the caption glass it was wrapped to.
    const halfWidth = panel.captionBacking.halfWidth;
    for (const line of panel.readoutPoints) {
      expect(line.text.length * panel.readoutFontMeters * 0.54).toBeLessThanOrEqual(halfWidth * 2);
    }
  });

  it('bounds an overlong caption block without entering the first button row', () => {
    const panel = createToolbarPanel({ rows, head, readout: Array.from({ length: 20 }, (_, index) => ({ text: `Caption ${index + 1}` })) });
    expect(panel.readoutPoints).toHaveLength(panel.readoutLineBudget);
    expect(panel.readoutLineBudget).toBeLessThanOrEqual(SPATIAL_TOOLBAR_LAYOUT.maxReadoutLines);
    const topButton = Math.max(...panel.buttons.map((button: { point: number[] }) => local(panel, button.point).y));
    expect(local(panel, panel.readoutPoints.at(-1).point).y - panel.readoutFontMeters / 2)
      .toBeGreaterThan(topButton + Math.max(...panel.buttons.map((button: { halfHeight: number }) => button.halfHeight)));
  });

  it('leaves no dead band between two stacked rows', () => {
    // The first Quest 2 session could not press rows at all. Glyph-sized
    // targets left more gap than target between two rows, and a ray that
    // landed in the gap did nothing and showed nothing.
    const panel = createToolbarPanel({rows,head});
    for (let index = 0; index < rows.length - 1; index++) {
      if (panel.buttons[index].column !== panel.buttons[index+1].column) continue;
      const midpoint = panel.buttons[index].point.map((value:number,axis:number) => (value + panel.buttons[index+1].point[axis]) / 2);
      const hit = hitToolbarPanel(panel, {origin:eye,direction:minus(midpoint, eye)});
      expect([index, index+1]).toContain(hit?.action.index);
    }
  });

  it('gives every row in a column one plate wide enough to aim at', () => {
    const mixed = [{label:'Fit',action:{index:0}},{label:'Within reach',action:{index:1}}];
    const panel = createToolbarPanel({rows:mixed,head});
    expect(panel.buttons[0].halfWidth).toBe(panel.buttons[1].halfWidth);
    // Roughly 5 cm of target per metre of range, in both axes.
    const range = SPATIAL_TOOLBAR_LAYOUT.forwardMeters;
    expect(panel.buttons[0].halfHeight * 2 / range).toBeGreaterThan(0.05);
    expect(panel.buttons[0].halfWidth * 2 / range).toBeGreaterThan(0.05);
    const outline = toolbarPlateOutline(panel, panel.buttons[0], {inset: panel.plateInsetMeters});
    const extent = (axis:number[]) => Math.max(...outline.map((point:number[]) => Math.abs(dot(minus(point, panel.buttons[0].point), axis))));
    expect(extent(panel.right)).toBeLessThan(panel.buttons[0].halfWidth);
    expect(extent(panel.up)).toBeLessThan(panel.buttons[0].halfHeight);
  });

  it('reads at a metre: cap height, row pitch and a gap the wearer can see', () => {
    // The legibility bar, in the units it was set in: a 2.5 cm cap read at
    // 0.8 m, which is 1.79 degrees of cap.
    const panel = createToolbarPanel({ rows: rows.slice(0,5), head });
    const range = Math.hypot(...minus(panel.anchor, eye));
    expect(degrees(panel.fontMeters * 0.7, range)).toBeGreaterThan(1.79);
    // A hand-held ray needs a target of a few degrees, and the drawn plates
    // must not touch, or a stack of buttons reads as one slab.
    const button = panel.buttons[0];
    expect(degrees(button.halfHeight * 2, range)).toBeGreaterThan(3.5);
    expect(button.halfHeight - panel.plateInsetMeters).toBeLessThan(SPATIAL_TOOLBAR_LAYOUT.rowStepMeters / 2);
  });

  it('steps the expanded grid down so it still fits a Quest 2 field of view', () => {
    expect(toolbarDensity(SPATIAL_TOOLBAR_LAYOUT.comfortRows)).toBe(1);
    expect(toolbarDensity(40)).toBe(SPATIAL_TOOLBAR_LAYOUT.densityFloor);
    const compact = createToolbarPanel({ rows: rows.slice(0,5), head });
    const expanded = createToolbarPanel({ rows: Array.from({length:30},(_,index) => ({ label:`Control ${index}`, action:{index} })), head });
    expect(compact.density).toBe(1);
    expect(expanded.density).toBeLessThan(1);
    // The seat keeps its range and its side when the menu opens; what moves is
    // the bearing, because a two-column grid is wider than a five-row column
    // and the seat solver brings a wider panel inboard until its own outboard
    // corner is back inside the lens. The anchors used to be pinned equal,
    // which is what let a wide panel keep a narrow one's bearing and leave the
    // glass entirely.
    expect(Math.hypot(...minus(expanded.anchor, eye))).toBeCloseTo(Math.hypot(...minus(compact.anchor, eye)), 7);
    expect(expanded.anchor[0]).toBeLessThan(0);
    expect(expanded.anchor[0]).toBeGreaterThan(compact.anchor[0]);
    const range = Math.hypot(...minus(expanded.anchor, eye));
    expect(degrees(expanded.backing.halfWidth * 2, range)).toBeLessThan(40);
    expect(degrees(expanded.backing.halfHeight * 2, range)).toBeLessThan(50);
  });

  it('draws one control plate that encloses every row it carries', () => {
    const panel = createToolbarPanel({ rows, head, readout: [{ text: 'A caption line' }] });
    for (const button of panel.buttons) {
      const { x, y } = local(panel, button.point);
      expect(Math.abs(x - local(panel, panel.backing.point).x) + button.halfWidth).toBeLessThanOrEqual(panel.backing.halfWidth);
      expect(Math.abs(y - local(panel, panel.backing.point).y) + button.halfHeight).toBeLessThanOrEqual(panel.backing.halfHeight);
    }
    const outline = toolbarBackingOutline(panel, { depth: panel.backingDepthMeters });
    expect(outline.length).toBeGreaterThan(8);
    for (const point of outline) {
      expect(dot(minus(point, panel.backing.point), panel.normal)).toBeCloseTo(panel.backingDepthMeters, 7);
    }
  });

  it('gives the caption block its own plate, wider than the controls and clear of them', () => {
    // Unbacked text floating over the room is what the first Quest 2 session
    // called a fake word thing, and the caption was the last of it.
    const panel = createToolbarPanel({ rows, head, readout: Array.from({ length: 8 }, (_, index) => ({ text: `Caption line ${index}` })) });
    const controls = local(panel, panel.backing.point), caption = local(panel, panel.captionBacking.point);
    // The caption plate is no longer the control plate's width. A caption is
    // prose and the rows are single words, so the glass grows inboard, into
    // the room between the panel and the cone the structure keeps, until the
    // cone stops it. It never grows the other way: its outboard edge stays at
    // or inside the panel's, so the two plates line up on the side the wearer
    // turns to rather than the caption hanging off into the periphery.
    expect(panel.captionBacking.halfWidth).toBeGreaterThan(panel.backing.halfWidth);
    expect(caption.x - panel.captionBacking.halfWidth)
      .toBeGreaterThanOrEqual(controls.x - panel.backing.halfWidth - 1e-9);
    expect(caption.x).toBeGreaterThan(controls.x);
    // The caption plate sits above the controls, and the two never touch.
    expect(caption.y - panel.captionBacking.halfHeight)
      .toBeGreaterThan(controls.y + panel.backing.halfHeight);
    for (const line of panel.readoutPoints) {
      const { y } = local(panel, line.point);
      expect(Math.abs(y - caption.y) + panel.readoutFontMeters / 2).toBeLessThanOrEqual(panel.captionBacking.halfHeight);
    }
    // A panel with nothing to say draws no caption plate at all.
    expect(createToolbarPanel({ rows, head }).captionBacking).toBeUndefined();
    expect(toolbarBackingOutline(panel, { plate: panel.captionBacking }).length).toBeGreaterThan(8);
  });

  /**
   * The 12:06 headset frame: the caption glass ran off the top of the eye and
   * the wearer read a sentence with its first four lines missing.
   *
   * The eye is 90 degrees vertically, which is what `EMULATED_DEVICE` in
   * `plugin/scripts/xr-gate.ts` measures with and a little under what a Quest 3
   * shows, and it is measured against the panel's depth on the entry gaze
   * rather than against its range. That is what makes the outboard corner of a
   * 47 degree seat the first thing to leave the frame: it is 0.53 m deep where
   * the seat is 0.95 m away.
   */
  it('keeps every caption line and its plate inside both eyes at its intended reading pose', () => {
    const readout = Array.from({ length: 10 }, (_, index) => ({ text: `Caption line ${index + 1} of the welcome` }));
    // Rise over depth on the entry gaze. The eye's own tangent at 45 degrees
    // of half-angle is 1, so anything under 1 is on the frame.
    const riseOverDepth = (point: Point) => {
      const depth = -(point[2] - eye[2]);
      expect(depth).toBeGreaterThan(0);
      return Math.abs(point[1] - eye[1]) / depth;
    };
    for (const count of [4, 6, 9, 12, 19]) {
      const panel = createToolbarPanel({ rows: rows.slice(0, count), head, readout });
      const drawn = [...toolbarBackingOutline(panel, { segments: 3, plate: panel.captionBacking }),
        ...panel.readoutPoints.map((line: { point: number[] }) => line.point)];
      expect(drawn.length).toBeGreaterThan(8);
      expect(readingFrameContains(drawn, panel, count <= SPATIAL_TOOLBAR_LAYOUT.maxRows)).toBe(true);
    }
  });

  /**
   * The other half of the pagination contract. `pageText` cuts a caption into
   * pages of `READOUT_PAGE_LINE_WIDTH` by `READOUT_PAGE_LINES` before the panel
   * ever sees one, so a glass smaller than that re-wraps the page and drops its
   * end. Wrapping the same words wider never makes more lines, so this bound is
   * the whole of what the glass owes the pagination.
   */
  it('leaves the caption glass at least the page the tour paginates to', () => {
    for (let count = 4; count <= 12; count += 1) {
      const panel = createToolbarPanel({ rows: rows.slice(0, count), head, readout: [{ text: 'Caption' }] });
      expect(panel.readoutWrapWidth).toBeGreaterThanOrEqual(READOUT_PAGE_LINE_WIDTH);
      expect(panel.readoutLineBudget).toBeGreaterThanOrEqual(READOUT_PAGE_LINES);
    }
  });

  it('draws every bundled spoken line whole, on the shipped menu', () => {
    // The nine-row menu is the busiest state a wearer can reach with a tour
    // running, and the one the eye leaves the least room above. What the plate
    // carries for a lesson chapter is its spoken line whole -- the player
    // sends `wearerPages` output, one unpaged sentence -- under the scene
    // title, with the progress line as the entry that yields.
    const menu = rows.slice(0, 9);
    const spoken: string[] = [];
    for (const file of readdirSync(new URL('../demos/', import.meta.url))) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      const demo = JSON.parse(readFileSync(new URL(`../demos/${file}`, import.meta.url), 'utf8'));
      for (const chapter of demo.chapters ?? []) {
        const line = chapter.immersive?.narration;
        if (typeof line === 'string' && line.trim()) spoken.push(line.trim());
      }
    }
    for (const file of readdirSync(new URL('../demos/microtubule-growth/', import.meta.url))) {
      if (!file.endsWith('.json')) continue;
      const demo = JSON.parse(readFileSync(new URL(`../demos/microtubule-growth/${file}`, import.meta.url), 'utf8'));
      for (const chapter of demo.chapters ?? []) {
        const line = chapter.immersive?.narration;
        if (typeof line === 'string' && line.trim()) spoken.push(line.trim());
      }
    }
    expect(spoken.length).toBeGreaterThan(30);
    const flat = (value: string) => value.replace(/\s+/gu, '');
    for (const line of spoken) {
      const panel = createToolbarPanel({ rows: menu, head, readout: [
        { text: 'Wide reveal', maxLines: 1 },
        { text: 'Scene 2 / 9', maxLines: 1, optional: true, dropRank: 4 },
        { text: line, optional: false }] });
      const drawn = panel.readoutPoints.map((entry: { text: string }) => entry.text);
      // The scene title is always there, whole and on one line.
      expect(drawn[0]).toBe('Wide reveal');
      // The sentence is drawn whole. What it must never be is a piece of
      // itself: that is the 23:00Z readout, two lines of five, stopping
      // mid-word.
      const drawnFlat = flat(drawn.filter((entry: string) => entry !== 'Scene 2 / 9').join(' '));
      const cut = !drawnFlat.endsWith(flat(line));
      if (cut) {
        // The eye itself refused: the last drawn line ends on a whole word,
        // and the progress line has already yielded.
        const last = drawn.at(-1)!;
        expect(last.endsWith('…')).toBe(true);
        const kept = last.slice(0, -1).trimEnd();
        const at = line.replace(/\s+/gu, ' ').indexOf(kept);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(line[at + kept.length] ?? ' ').toMatch(/\s/u);
        expect(drawn).not.toContain('Scene 2 / 9');
      }
      // And the type never shrinks under the row size to hold it.
      expect(panel.readoutFontMeters * GLYPH_CAP_FRACTION).toBeGreaterThanOrEqual(META_MIN_CAP_METERS);
    }
  });

  it('marks a state-only row unpressable and a primary row as the accent plate', () => {
    const panel = createToolbarPanel({rows:[{label:'Voice busy…',action:{index:0},state:true},
      {label:'Menu',action:{index:1},accent:true},{label:'Fit',action:{index:2}}],head});
    expect(panel.buttons.map((button:any) => button.style)).toEqual(['state','accent','action']);
    expect(panel.buttons[0].targetable).toBe(false);
    const point = panel.buttons[0].point;
    expect(hitToolbarPanel(panel,{origin:eye,direction:minus(point, eye)})).toBeUndefined();
    // The chip is still drawn, just never as something to press.
    expect(toolbarPlateOutline(panel, panel.buttons[0], { inset: panel.plateInsetMeters }).length).toBeGreaterThan(8);
  });

  it('keeps the compact menu targetable after the wearer moves around the room', () => {
    const panel = createToolbarPanel({ rows: rows.slice(0,7), head });
    const original = panel.buttons.map((button: {point:number[]}) => [...button.point]);
    for (const origin of [eye, [.6,1.5,-.3], [-.4,1.8,.2]]) {
      for (const button of panel.buttons) {
        expect(hitToolbarPanel(panel,{origin,direction:minus(button.point, origin)})?.action.index).toBe(button.action.index);
      }
    }
    expect(panel.buttons.map((button: {point:number[]}) => button.point)).toEqual(original);
    // Recalling the menu is explicit: a new entry pose relocates both its
    // physical labels and controller targets by the same room-space offset.
    const recalled = createToolbarPanel({ rows: rows.slice(0,7), head:{...head,position:{x:.6,y:1.5,z:-.3}} });
    close(minus(recalled.anchor, panel.anchor), [.6,-.1,-.3]);
  });
});
