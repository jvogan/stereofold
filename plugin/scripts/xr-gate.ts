/**
 * The wearer-view gate.
 *
 * Asserting internal state and pixel drift is not enough to call the in-VR
 * menu verified. A menu sitting in the way, labels missing their first letter
 * and a button that does nothing are all visible in the emulator frames the
 * harness already writes, and none of them move a state assertion.
 *
 * This file judges those frames. It runs after `scripts/companion-browser.ts`,
 * reads only the artifact directory that harness wrote, and refuses to pass on
 * anything a wearer would see and reject. It adds nothing to the harness and
 * changes nothing in it: a gate that could edit what it judges is not a gate.
 *
 * Five rules, in order:
 *   1. Nothing but the molecule inside the central 60 degree cone.
 *   2. Every toolbar label is drawn where its plate can hold it, whole.
 *   3. Every press changes something the wearer can see.
 *   4. Frame rate against the tier target (a warning: this is not a Quest).
 *   5. One contact sheet, so frames can be judged by eye.
 *
 * Usage: pnpm --dir plugin run xr-gate /absolute/artifact/dir
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  blit, createImage, cropImage, decodePng, drawRect, drawText, encodePng,
  resizeImage, textWidth, type RasterImage,
} from './png-image.js';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { CENTRAL_CONE_HALF_ANGLE_DEGREES, EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES, EYE_HALF_FIELD_DEGREES, PANEL_FRAME_MARGIN_DEGREES, PERIPHERAL_MENU_CONE_HALF_ANGLE_DEGREES, CAPTION_FRAME_MARGIN, EYE_HALF_FIELD_VERTICAL_DEGREES } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';

const LAB_ROUNDTRIP = resolve(dirname(fileURLToPath(import.meta.url)), '../../lab/browser-roundtrip');
const labModule = (name: string) => import(pathToFileURL(resolve(LAB_ROUNDTRIP, name)).href) as Promise<any>;

// ---------------------------------------------------------------------------
// The wearer's optics, as the artifacts describe them.
// ---------------------------------------------------------------------------

/**
 * The IWER Meta Quest 2 device the harness installs: a symmetric 90 degree
 * vertical field, a 63 mm interpupillary distance, and a head seated at
 * 1.6 m. The horizontal field follows from the eye viewport's aspect ratio,
 * which the harness records per capture, so nothing here is a guess about the
 * frame it is measuring. A future harness that records real projection
 * matrices overrides all of it through `eye.projectionMatrix`.
 */
export const EMULATED_DEVICE = Object.freeze({
  verticalFieldOfViewDegrees: 90,
  interpupillaryDistanceMeters: 0.063,
  eyeHeightMeters: 1.6,
});

/**
 * Half-angle of the cone the structure is meant to have to itself.
 *
 * One number, shared with the geometry that honours it, so the gate and the
 * panel cannot disagree about where the structure's room ends. It was 30 here
 * and 30 there, separately; `spatial-toolbar-geometry.mjs` carries why it is
 * what it is now, and why the expanded grid is held to its own wider number
 * instead of being quietly exempt.
 */
export { CENTRAL_CONE_HALF_ANGLE_DEGREES, EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES, EYE_HALF_FIELD_DEGREES, PANEL_FRAME_MARGIN_DEGREES };
/** The cone a row set of this form has to leave empty. */
export const coneLimitDegrees = (collapsed: boolean, peripheral = true): number =>
  (collapsed ? peripheral ? PERIPHERAL_MENU_CONE_HALF_ANGLE_DEGREES : CENTRAL_CONE_HALF_ANGLE_DEGREES : EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES);
/**
 * Clear space a label needs inside its own plate, per side.
 *
 * Four millimetres at the panel's 0.95 m range. The failure this rule exists
 * for is a whole glyph off the plate, about two centimetres, so the bar is set
 * where a run is unambiguously inside its plate rather than where it is
 * comfortable. A run that clears by less than the plate's own drawn rim is
 * reported as a warning instead, because sitting on the rim is tight, not
 * broken.
 */
export const LABEL_PLATE_MARGIN_METERS = 0.004;
/**
 * How far a label's first ink may sit right of where a centred run would start
 * before the gate calls the leading glyph missing, in glyph widths.
 *
 * A complete centred label is symmetric about its row centre, but only to
 * within the side bearings of its own first and last glyphs: the shipped rows
 * measure under 0.15 of a glyph of natural drift. A blanked leading glyph
 * moves the start by twice its own width. One glyph separates the two.
 */
export const LEADING_GLYPH_TOLERANCE_GLYPHS = 1;
/** Quest 2 target, from `xr-render-budget.mjs`. Reported, never failed on. */
export const TARGET_FRAME_RATE = 72;
/** A pixel differs when any channel moves by more than this. */
const PIXEL_DELTA = 12;
/** Fraction of a region's pixels that must move for a change to count as seen. */
const REGION_CHANGE_FRACTION = 0.001;

const DEGREES = 180 / Math.PI;
const entryHead = Object.freeze({
  position: { x: 0, y: EMULATED_DEVICE.eyeHeightMeters, z: 0 },
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});

/** Angle between a world point and the forward axis, seen from an origin. */
function coneAngleDegrees(point: number[], origin: number[]): number {
  const dx = point[0] - origin[0], dy = point[1] - origin[1], dz = point[2] - origin[2];
  const forward = -dz;
  const length = Math.hypot(dx, dy, forward);
  if (length < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, forward / length))) * DEGREES;
}

/**
 * How far aside a point sits from one eye's forward axis, in degrees.
 *
 * The lens is wider than it is not, so the rule that matters for a menu seated
 * off to one side is the lateral angle, not the cone angle: a block high above
 * the horizon may be 40 degrees from the axis and still well inside the glass.
 */
function lateralDegrees(point: number[], origin: number[]): number {
  const dx = point[0] - origin[0], forward = -(point[2] - origin[2]);
  if (!(forward > 1e-9)) return 180;
  return Math.atan2(Math.abs(dx), forward) * DEGREES;
}

export interface EyeOptics {
  eye: 'left' | 'right';
  width: number;
  height: number;
  origin: number[];
  tanHalfX: number;
  tanHalfY: number;
  headYawDegrees: number;
  right: number[];
  forward: number[];
}

export function eyeOptics(eye: 'left' | 'right', width: number, height: number, headYawDegrees = 0): EyeOptics {
  const tanHalfY = Math.tan((EMULATED_DEVICE.verticalFieldOfViewDegrees / 2) * Math.PI / 180);
  const offset = (eye === 'left' ? -1 : 1) * EMULATED_DEVICE.interpupillaryDistanceMeters / 2;
  const yaw = headYawDegrees / DEGREES, right = [Math.cos(yaw), 0, -Math.sin(yaw)], forward = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  return { eye, width, height, origin: [right[0] * offset, EMULATED_DEVICE.eyeHeightMeters, right[2] * offset],
    tanHalfX: tanHalfY * (width / height), tanHalfY, headYawDegrees, right, forward };
}

/** World point to pixel in that eye's crop. `behind` marks points the eye cannot see. */
export function projectToEye(optics: EyeOptics, point: number[]): { x: number; y: number; behind: boolean } {
  const relative = point.map((value, axis) => value - optics.origin[axis]);
  const vx = dot(relative, optics.right), vy = relative[1], vz = -dot(relative, optics.forward);
  if (vz >= -1e-6) return { x: NaN, y: NaN, behind: true };
  const ndcX = vx / (optics.tanHalfX * -vz), ndcY = vy / (optics.tanHalfY * -vz);
  return { x: (ndcX + 1) / 2 * optics.width, y: (1 - ndcY) / 2 * optics.height, behind: false };
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A row plate's own axes in the room: its centre, its right, its up, its normal. */
export interface PlateFrame { point: number[]; right: number[]; up: number[]; normal: number[] }

/**
 * Where a pixel lands on a row plate, in that plate's own metres.
 *
 * A plate is a rectangle in the room, tilted down toward the wearer and rolled
 * with the panel, so its picture in an eye is a tilted quad whose axis-aligned
 * bounding box spills over the rows above and below it. Measuring a label
 * inside that box measures its neighbours as well: in the CRISPR frames the
 * tail of `Move menu` fell inside the band the gate was calling the `Menu`
 * row, which made a complete label look shifted by most of a glyph.
 *
 * Casting the pixel's ray back onto the plate's own plane puts every
 * measurement in the plate's own metres, where the label is centred on u = 0
 * and the plate runs to plus or minus its half width whatever the tilt.
 * `undefined` means the ray never reaches the plane in front of the eye.
 */
export function plateLocal(optics: EyeOptics, frame: PlateFrame, x: number, y: number): { u: number; v: number } | undefined {
  const ndcX = 2 * ((x + 0.5) / optics.width) - 1, ndcY = 1 - 2 * ((y + 0.5) / optics.height);
  const direction = optics.forward.map((value, axis) => value + optics.right[axis] * ndcX * optics.tanHalfX + (axis === 1 ? ndcY * optics.tanHalfY : 0));
  const denominator = dot(direction, frame.normal);
  if (Math.abs(denominator) < 1e-9) return undefined;
  const toPlate = [frame.point[0] - optics.origin[0], frame.point[1] - optics.origin[1], frame.point[2] - optics.origin[2]];
  const distance = dot(toPlate, frame.normal) / denominator;
  if (!(distance > 0)) return undefined;
  const hit = [optics.origin[0] + direction[0] * distance - frame.point[0],
    optics.origin[1] + direction[1] * distance - frame.point[1],
    optics.origin[2] + direction[2] * distance - frame.point[2]];
  return { u: dot(hit, frame.right), v: dot(hit, frame.up) };
}

/** Angle between a pixel's ray and that eye's forward axis. */
function pixelConeAngleDegrees(optics: EyeOptics, x: number, y: number): number {
  const ndcX = 2 * ((x + 0.5) / optics.width) - 1, ndcY = 1 - 2 * ((y + 0.5) / optics.height);
  const ray = optics.forward.map((value, axis) => value + optics.right[axis] * ndcX * optics.tanHalfX + (axis === 1 ? ndcY * optics.tanHalfY : 0));
  return coneAngleDegrees(ray, [0, 0, 0]);
}

/** Map known control glass to the production head-centred cone, including IPD.
 * Unknown pixels retain the conservative eye-ray measurement. */
export function toolbarPixelConeDegrees(optics: EyeOptics, x: number, y: number, geometry: PanelGeometry): number | undefined {
  if (![optics.width, optics.height, optics.tanHalfX, optics.tanHalfY].every(value => Number.isFinite(value) && value > 0)
    || ![...optics.origin, x, y].every(Number.isFinite)) return undefined;
  const panel = geometry.panel;
  if (![panel.right, panel.up, panel.normal].every(axis => Array.isArray(axis) && axis.length === 3 && axis.every(Number.isFinite))) return undefined;
  const plates = [...geometry.buttons, panel.backing].filter(Boolean);
  const angles: number[] = [];
  for (const plate of plates) {
    // Text is on the reference plane, while the slab extends behind it. Use
    // the smaller angle across that complete depth interval, never a more
    // favourable plane chosen to forgive a pixel inside the reserved cone.
    const depth = Math.max(panel.plateDepthMeters ?? 0, panel.backingDepthMeters ?? 0);
    for (const offset of [-depth, 0, depth]) {
      const point = plate.point.map((value: number, index: number) => value + panel.normal[index] * offset);
      const local = plateLocal(optics, { point, right: panel.right, up: panel.up, normal: panel.normal }, x, y);
      if (!local || !Number.isFinite(local.u) || !Number.isFinite(local.v)
        || Math.abs(local.u) > plate.halfWidth || Math.abs(local.v) > plate.halfHeight) continue;
      const hit = point.map((value: number, index: number) => value + local.u * panel.right[index] + local.v * panel.up[index]);
      angles.push(coneAngleDegrees(hit, [0, EMULATED_DEVICE.eyeHeightMeters, 0]));
    }
  }
  return angles.length ? Math.min(...angles) : undefined;
}

// ---------------------------------------------------------------------------
// Artifacts.
// ---------------------------------------------------------------------------

export interface GateFinding { rule: string; reason: string; frame?: string }
export interface GateResult {
  artifactDir: string;
  gateDir: string;
  contactSheet: string;
  failures: GateFinding[];
  warnings: GateFinding[];
  notes: string[];
  labelCrops: string[];
  measurements: Record<string, unknown>;
}

interface XrCapture {
  file: string;
  path: string;
  width: number;
  height: number;
  eyes: { eye: 'left' | 'right'; viewport: [number, number, number, number] }[];
  order: number;
  headYawDegrees: number;
}

function xrCaptures(report: any, artifactDir: string): XrCapture[] {
  const screenshots: any[] = Array.isArray(report?.screenshots) ? report.screenshots : [];
  return screenshots
    .filter(shot => shot?.kind === 'emulated_xr_raw_paired_framebuffer' && typeof shot.file === 'string')
    .map((shot, order) => ({
      file: shot.file, path: resolve(artifactDir, shot.file),
      width: shot.width, height: shot.height,
      headYawDegrees: Number.isFinite(shot.headYawDegrees) ? shot.headYawDegrees : 0,
      eyes: (shot.eyes ?? []).map((eye: any) => ({ eye: eye.eye, viewport: eye.viewport })),
      order,
    }));
}

/** The row sets the harness actually put in front of the emulated wearer. */
export function drawnRowLayout(points: unknown): LayoutOverrides {
  if (!Array.isArray(points) || points.length < 2 || !points.every(point =>
    Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))) return {};
  const sameColumn = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]) < 1e-5;
  const maxRows = points.findIndex(point => !sameColumn(point, points[0]));
  if (maxRows < 1 || !points.every((point, index) => sameColumn(point, points[Math.floor(index / maxRows) * maxRows]))) return {};
  return { toolbarConstants: { maxRows } };
}

function recordedRowSets(report: any): { name: string; rows: string[]; collapsed: boolean; layout: LayoutOverrides; drawnRowPoints?: number[][] }[] {
  const targets: any[] = [...report?.emulatedXr?.toolbarTargets ?? [], ...report?.emulatedXr?.toolbarFrames ?? []];
  const seen = new Map<string, { name: string; rows: string[]; collapsed: boolean; layout: LayoutOverrides; drawnRowPoints?: number[][] }>();
  targets.forEach((target, index) => {
    if (!Array.isArray(target?.rows)) return;
    const layout = drawnRowLayout(target.drawnRowPoints);
    const key = `${target.collapsed === true}:${JSON.stringify(layout)}:${target.rows.join('|')}:${JSON.stringify(target.drawnRowPoints)}`;
    if (!seen.has(key)) seen.set(key, { name: `press ${index + 1} (${target.label ?? 'unnamed'})`, rows: target.rows,
      collapsed: target.collapsed === true, layout, drawnRowPoints: target.drawnRowPoints });
  });
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Panel geometry, rebuilt from the modules the headset runs.
// ---------------------------------------------------------------------------

export interface PanelGeometry {
  panel: any;
  points: number[][];
  buttons: { label: string; labelLines?: string[]; point: number[]; halfWidth: number; halfHeight: number; corners: number[][] }[];
  fontMeters: number;
  glyphAspect: number;
  readingYawDegrees: number;
}

export interface LayoutOverrides {
  /** Stand-in for `SPATIAL_TOOLBAR_LAYOUT`, so a test can measure a past seat. */
  toolbarConstants?: Record<string, unknown>;
}

export async function buildPanel(rows: string[], collapsed: boolean, overrides: LayoutOverrides = {}): Promise<PanelGeometry> {
  const geometry = await labModule('spatial-toolbar-geometry.mjs');
  const content = await labModule('spatial-toolbar-content.mjs');
  // Rebuild the row objects the geometry module wants from the labels the
  // harness recorded, so plate widths come from the same content module the
  // headset used rather than from a label string alone.
  const live = content.spatialToolbarRows({
    collapsed, mode: 'move', paused: true, voice: { state: 'idle' },
    tour: { active: true, autoplay: false, menuOpen: false, navigating: false, canBack: true, canNext: true,
      bodyPageIndex: 0, bodyPageCount: 3, selectedId: 'a' },
  }) as { label: string }[];
  const byLabel = new Map(live.map(row => [row.label, row]));
  const rowObjects = rows.map(label => ({ ...(byLabel.get(label) ?? {}), label }));
  const readout = Array.from({ length: geometry.SPATIAL_TOOLBAR_LAYOUT.maxReadoutLines },
    (_, index) => ({ text: `Caption line ${index + 1} of the tour readout` }));
  const constants = overrides.toolbarConstants
    ? { ...geometry.SPATIAL_TOOLBAR_LAYOUT, ...overrides.toolbarConstants }
    : geometry.SPATIAL_TOOLBAR_LAYOUT;
  const panel = geometry.createToolbarPanel({ rows: rowObjects, head: entryHead, readout, constants });
  if (!panel) throw Error(`The production geometry module refused to lay out ${rows.length} rows.`);
  const buttons = panel.buttons.map((button: any) => ({
    label: button.label, labelLines: button.labelLines, point: button.point, halfWidth: button.halfWidth, halfHeight: button.halfHeight,
    corners: geometry.toolbarPlateOutline(panel, button, { segments: 1 }),
  }));
  // Include complete control, caption and status glass, including slab depth.
  const points = geometry.toolbarPlatePoints(panel);
  return { panel, points, buttons, fontMeters: panel.fontMeters,
    glyphAspect: (constants as any).glyphAspect ?? 0.54,
    readingYawDegrees: constants.peripheralSeat === true && rows.length <= constants.maxRows
      ? Math.atan2(-panel.anchor[0], -panel.anchor[2]) * DEGREES : 0 };
}

/**
 * The closest anything the menu draws comes to the forward axis, in degrees,
 * at the immersive entry pose.
 *
 * The floating talk orb was measured here too until it was deleted. It was the
 * worst offender: on hardware it sat directly in front of the structure's DNA.
 * Nothing floats beside the menu now, so the menu is the whole measurement.
 *
 * Pure and exported, so the wearer-view rule can be measured against a past
 * seat as well as the shipped one. The pre-fix constants -- 0.95 m forward and
 * 0.40 m left -- put the menu in the way of the structure, and passing them
 * here must report a breach.
 */
export async function measureCentralCone(rows: string[], collapsed: boolean,
  overrides: LayoutOverrides = {}): Promise<{ degrees: number; breaches: boolean }> {
  const geometry = await buildPanel(rows, collapsed, overrides);
  const origin = [0, EMULATED_DEVICE.eyeHeightMeters, 0];
  const degrees = Math.min(...geometry.points.map(point => coneAngleDegrees(point, origin)));
  return { degrees, breaches: degrees < coneLimitDegrees(collapsed, geometry.readingYawDegrees !== 0) };
}

/**
 * How far off each eye's forward axis a row set's furthest geometry reaches.
 *
 * The other half of rule 1, and the half whose absence let a menu ship drawn
 * where the wearer has no glass. `EYE_FRAME_LIMIT_DEGREES` is the bar:
 * `EYE_HALF_FIELD_DEGREES` is the Quest 2 half-lens measured off hardware
 * captures, and `PANEL_FRAME_MARGIN_DEGREES` is what the panel keeps off that
 * edge.
 *
 * Measured PER EYE, never from the head centre. A panel on the wearer's left
 * is further off the axis in the RIGHT eye by half an interpupillary distance,
 * and at the menu's range that half-IPD is about one character of row type --
 * enough to leave a row caption whole in one eye and cut in the other.
 * `eyeOptics` carries the emulated device's own 63 mm IPD, so the offset here
 * is the one the harness renders with rather than a second copy of it.
 *
 * Pure and exported so the rule can be measured against any row set without a
 * frame, the way `measureCentralCone` can.
 */
export const EYE_FRAME_LIMIT_DEGREES = EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES;
// Caption geometry reserves a tangent margin vertically. Honour that same
// tighter-than-the-physical-lens envelope rather than inventing another margin.
export const EYE_FRAME_VERTICAL_LIMIT_DEGREES = Math.atan(Math.tan(EYE_HALF_FIELD_VERTICAL_DEGREES / DEGREES)
  * (1 - CAPTION_FRAME_MARGIN)) * DEGREES;

export interface EyeFrameMeasurement {
  eye: 'left' | 'right';
  /** Furthest lateral angle any point of the panel reaches in this eye. */
  degrees: number;
  verticalDegrees: number;
  headYawDegrees: number;
  breaches: boolean;
}

/** The intended reading frame is an explicit glance for a peripheral column.
 * Passing forward still reports its real off-screen extent; no pixels rotate. */
export async function measureEyeFrame(rows: string[], collapsed: boolean,
  overrides: LayoutOverrides = {}, view: 'reading' | 'forward' = 'reading'): Promise<EyeFrameMeasurement[]> {
  return panelEyeFrame(await buildPanel(rows, collapsed, overrides), view);
}

function panelEyeFrame(geometry: PanelGeometry, view: 'reading' | 'forward' = 'reading'): EyeFrameMeasurement[] {
  const yaw = view === 'reading' ? geometry.readingYawDegrees : 0;
  return (['left', 'right'] as const).map(eye => {
    const optics = eyeOptics(eye, 2, 2, yaw);
    const angles = geometry.points.map(point => {
      const relative = point.map((value, axis) => value - optics.origin[axis]);
      const depth = dot(relative, optics.forward);
      return depth > 0 ? [Math.atan2(Math.abs(dot(relative, optics.right)), depth) * DEGREES,
        Math.atan2(Math.abs(relative[1]), depth) * DEGREES] : [180, 180];
    });
    const degrees = Math.max(...angles.map(angle => angle[0]));
    const verticalDegrees = Math.max(...angles.map(angle => angle[1]));
    return { eye, degrees, verticalDegrees, headYawDegrees: yaw,
      breaches: degrees > EYE_FRAME_LIMIT_DEGREES || verticalDegrees > EYE_FRAME_VERTICAL_LIMIT_DEGREES };
  });
}

export interface LabelMargin {
  row: string;
  /** Half the width of the glyph run the label builder will lay down. */
  textHalfWidthMeters: number;
  plateHalfWidthMeters: number;
  /** Clear plate on each side of the run. Negative means the run overhangs. */
  marginMeters: number;
  /** The plate's own drawn rim. A run inside this sits on the bevel. */
  rimMeters: number;
  fails: boolean;
  tight: boolean;
}

/**
 * How much plate each label has left over, per side, before anything is drawn.
 *
 * The pixel half of rule 2 can only judge rows a frame actually contains; this
 * half judges every row in every recorded set and needs no frame at all.
 */
export async function measureLabelMargins(rows: string[], collapsed: boolean,
  overrides: LayoutOverrides = {}): Promise<LabelMargin[]> {
  const geometry = await buildPanel(rows, collapsed, overrides);
  const rim = geometry.panel.plateBorderMeters ?? 0;
  return geometry.buttons.map(button => {
    const textHalfWidthMeters = Math.max(...(button.labelLines ?? [button.label]).map(line => line.length)) * geometry.fontMeters * geometry.glyphAspect / 2;
    const marginMeters = button.halfWidth - textHalfWidthMeters;
    return { row: button.label, textHalfWidthMeters, plateHalfWidthMeters: button.halfWidth, marginMeters,
      rimMeters: rim, fails: marginMeters < LABEL_PLATE_MARGIN_METERS,
      tight: marginMeters >= LABEL_PLATE_MARGIN_METERS && marginMeters < rim };
  });
}

// ---------------------------------------------------------------------------
// Pixel helpers.
// ---------------------------------------------------------------------------

function eyeCrop(image: RasterImage, viewport: [number, number, number, number]): RasterImage {
  return cropImage(image, viewport[0], viewport[1], viewport[2], viewport[3]);
}

/** The frame's clear colour, taken from its four corners. */
function backgroundColor(image: RasterImage): [number, number, number] {
  const corners = [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]];
  const sums = [0, 0, 0];
  for (const [x, y] of corners) {
    const index = (y * image.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) sums[channel] += image.data[index + channel];
  }
  return [Math.round(sums[0] / 4), Math.round(sums[1] / 4), Math.round(sums[2] / 4)];
}

function isLit(image: RasterImage, x: number, y: number, background: [number, number, number], tolerance = 18): boolean {
  const index = (y * image.width + x) * 4;
  return Math.abs(image.data[index] - background[0]) > tolerance
    || Math.abs(image.data[index + 1] - background[1]) > tolerance
    || Math.abs(image.data[index + 2] - background[2]) > tolerance;
}

interface Box { left: number; top: number; right: number; bottom: number }

function projectedBox(optics: EyeOptics, points: number[][]): Box | undefined {
  const projected = points.map(point => projectToEye(optics, point)).filter(point => !point.behind);
  if (!projected.length) return undefined;
  return {
    left: Math.min(...projected.map(point => point.x)), right: Math.max(...projected.map(point => point.x)),
    top: Math.min(...projected.map(point => point.y)), bottom: Math.max(...projected.map(point => point.y)),
  };
}

function inBox(box: Box | undefined, x: number, y: number, pad = 2): boolean {
  return Boolean(box) && x >= box!.left - pad && x <= box!.right + pad && y >= box!.top - pad && y <= box!.bottom + pad;
}

/** Fraction of pixels that moved, counted only outside the excluded boxes. */
function changedFraction(before: RasterImage, after: RasterImage, exclude: (Box | undefined)[], inside: boolean): number {
  if (before.width !== after.width || before.height !== after.height) return 1;
  let counted = 0, changed = 0;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const covered = exclude.some(box => inBox(box, x, y));
      if (covered !== inside) continue;
      counted++;
      const index = (y * before.width + x) * 4;
      if (Math.abs(before.data[index] - after.data[index]) > PIXEL_DELTA
        || Math.abs(before.data[index + 1] - after.data[index + 1]) > PIXEL_DELTA
        || Math.abs(before.data[index + 2] - after.data[index + 2]) > PIXEL_DELTA) changed++;
    }
  }
  return counted ? changed / counted : 0;
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

export async function runXrGate(artifactDirArgument: string): Promise<GateResult> {
  const artifactDir = resolve(artifactDirArgument);
  const gateDir = resolve(artifactDir, 'gate');
  await mkdir(gateDir, { recursive: true });
  const failures: GateFinding[] = [], warnings: GateFinding[] = [], notes: string[] = [];
  const labelCrops: string[] = [];
  const measurements: Record<string, unknown> = {};

  const reportPath = resolve(artifactDir, 'browser-report.json');
  let report: any;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch { failures.push({ rule: 'artifacts', reason: `No readable browser-report.json in ${artifactDir}; the harness did not finish.` });
    return { artifactDir, gateDir, contactSheet: '', failures, warnings, notes, labelCrops, measurements }; }
  if (report.status !== 'passed') failures.push({ rule: 'artifacts',
    reason: `The browser harness status is ${String(report.status ?? 'missing')}; partial frames cannot certify completed XR acceptance.` });

  const present = new Set(await readdir(artifactDir));
  const captures = xrCaptures(report, artifactDir).filter(capture => present.has(capture.file));
  const decoded = new Map<string, RasterImage>();
  const imageOf = async (capture: XrCapture) => {
    if (!decoded.has(capture.file)) decoded.set(capture.file, decodePng(await readFile(capture.path)));
    return decoded.get(capture.file)!;
  };

  if (captures.length < 2) {
    failures.push({ rule: 'artifacts', reason: `Only ${captures.length} both-eye XR capture(s) in these artifacts; the gate cannot judge a run that never rendered the headset view.` });
  }

  // -- Rule 1: nothing but the molecule in the central cone --------------
  const rowSets = recordedRowSets(report);
  if (!rowSets.length) {
    failures.push({ rule: 'central-cone', reason: 'The harness recorded no toolbar row set, so the gate has no panel to measure. A run that never resolved a toolbar target proves nothing about the wearer view.' });
  }
  const coneByRowSet: Record<string, number> = {};
  const lensByRowSet: Record<string, number> = {};
  let worstPanelPoints: number[][] = [];
  const validatedPanels = new Map<string, PanelGeometry>();
  for (const set of rowSets) {
    const geometry = await buildPanel(set.rows, set.collapsed, set.layout);
    // Runtime folds can keep an active journey in two columns. The inferred
    // fold is valid only if the reconstructed row centres match every drawn
    // centre; otherwise geometry cannot certify the actual panel.
    if (set.drawnRowPoints && (set.drawnRowPoints.length !== geometry.buttons.length
      || geometry.buttons.some((button, index) => {
        const point = set.drawnRowPoints![index];
        return !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite) || Math.hypot(button.point[0] - point[0],
          button.point[1] - point[1] - EMULATED_DEVICE.eyeHeightMeters, button.point[2] - point[2]) > 0.001;
      }))) failures.push({ rule: 'artifacts', reason: `Reconstructed toolbar geometry does not match the drawn row centres at ${set.name}; its cone measurement cannot certify the live panel.` });
    else if (set.drawnRowPoints) validatedPanels.set(JSON.stringify(set.drawnRowPoints), geometry);
    const all = geometry.points;
    const worst = Math.min(...all.map(point => coneAngleDegrees(point, [0, EMULATED_DEVICE.eyeHeightMeters, 0])));
    const coneLimit = coneLimitDegrees(set.collapsed !== false, geometry.readingYawDegrees !== 0);
    coneByRowSet[set.name] = Number(worst.toFixed(2));
    if (!worstPanelPoints.length) worstPanelPoints = all;
    if (worst < coneLimit) {
      failures.push({ rule: 'central-cone',
        reason: `Menu geometry reaches ${worst.toFixed(1)} degrees off the forward axis at ${set.name}, inside the central ${coneLimit * 2} degree cone the structure needs to itself.` });
    }
    // -- Rule 1b: and none of it outside the lens either --------------------
    //
    // The other half of rule 1. Asking only whether the menu is far enough OFF
    // the forward axis, and never whether it is still on the glass, lets a seat
    // pushed out to clear the cone pass here and reach the headset with its
    // first letter shorn off, a caption cut in one eye and the menu half off
    // screen. The measurement is per eye, because a panel on the wearer's left
    // is further off the axis in the right eye by half an interpupillary
    // distance.
    for (const measurement of panelEyeFrame(geometry)) {
      const { eye, degrees: furthest, verticalDegrees, headYawDegrees } = measurement;
      lensByRowSet[`${set.name}:${eye}`] = Number(furthest.toFixed(2));
      if (measurement.breaches) {
        failures.push({ rule: 'eye-frame',
          reason: `Menu geometry reaches ${furthest.toFixed(1)} degrees laterally and ${verticalDegrees.toFixed(1)} vertically at ${set.name} in the ${eye} eye after a ${headYawDegrees.toFixed(1)} degree reading glance; complete glass must fit within ${EYE_FRAME_LIMIT_DEGREES} lateral and ${EYE_FRAME_VERTICAL_LIMIT_DEGREES.toFixed(1)} vertical degrees.` });
      }
    }
  }
  measurements.centralConeDegreesByRowSet = coneByRowSet;
  measurements.eyeFrameDegreesByRowSet = lensByRowSet;

  // The pixel half of rule 1. The harness translates the molecule 8 radii aside
  // for its `off-molecule` captures, so whatever is lit in those frames is
  // menu, caption or readout and nothing else.
  const bareFrames = captures.filter(capture => capture.file.includes('off-molecule'));
  const conePixelWorst: Record<string, number> = {};
  if (!bareFrames.length) {
    notes.push('No molecule-hidden capture in these artifacts, so rule 1 rests on geometry alone here.');
  }
  for (const capture of bareFrames) {
    const image = await imageOf(capture);
    const frame = report?.emulatedXr?.toolbarFrames?.find((candidate: any) => `${candidate.label}.png` === capture.file);
    const drawnPanel = frame ? validatedPanels.get(JSON.stringify(frame.drawnRowPoints)) : undefined;
    // A frame the harness took with the expanded grid open is held to the
    // grid's own cone. The harness names those frames `toolbar-expanded`; a
    // frame that does not say so is a compact menu and gets the tighter rule.
    const pixelConeLimit = coneLimitDegrees(!capture.file.includes('toolbar-expanded'));
    for (const eye of capture.eyes) {
      const crop = eyeCrop(image, eye.viewport);
      const background = backgroundColor(crop);
      const optics = eyeOptics(eye.eye, crop.width, crop.height, capture.headYawDegrees);
      let worst = 180, worstAt: [number, number] = [0, 0], litInside = 0;
      for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
          if (!isLit(crop, x, y, background)) continue;
          const angle = (drawnPanel ? toolbarPixelConeDegrees(optics, x, y, drawnPanel) : undefined)
            ?? pixelConeAngleDegrees(optics, x, y);
          if (angle < worst) { worst = angle; worstAt = [x, y]; }
          if (angle < pixelConeLimit) litInside++;
        }
      }
      conePixelWorst[`${capture.file}:${eye.eye}`] = Number(worst.toFixed(2));
      if (litInside > 0) {
        failures.push({ rule: 'central-cone', frame: capture.path,
          reason: `${litInside} lit user-interface pixels sit inside the central ${pixelConeLimit * 2} degree cone in the ${eye.eye} eye of ${capture.file}; the closest is ${worst.toFixed(1)} degrees off the forward axis at pixel ${worstAt[0]},${worstAt[1]}.` });
      }
    }
  }
  measurements.centralConeDrawnPixelDegrees = conePixelWorst;

  // -- Rule 2: every label whole, inside its own plate --------------------
  const labelFrame = captures[0];
  const firstSet = rowSets[0];
  const labelMeasurements: Record<string, unknown>[] = [];
  const seenMargin = new Set<string>();
  for (const set of rowSets) {
    for (const margin of await measureLabelMargins(set.rows, set.collapsed, set.layout)) {
      if (seenMargin.has(margin.row)) continue;
      seenMargin.add(margin.row);
      if (margin.fails) {
        failures.push({ rule: 'label-completeness',
          reason: `Toolbar row "${margin.row}" needs ${(margin.textHalfWidthMeters * 2 * 100).toFixed(1)} cm of plate and has ${(margin.plateHalfWidthMeters * 2 * 100).toFixed(1)} cm, leaving ${(margin.marginMeters * 100).toFixed(2)} cm a side; its first and last glyphs run off the plate.` });
      } else if (margin.tight) {
        warnings.push({ rule: 'label-completeness',
          reason: `Toolbar row "${margin.row}" clears its plate by only ${(margin.marginMeters * 1000).toFixed(1)} mm a side against a ${(margin.rimMeters * 1000).toFixed(1)} mm drawn rim, so its first and last glyphs sit on the bevel.` });
      }
    }
  }

  if (labelFrame && firstSet) {
    const geometry = await buildPanel(firstSet.rows, firstSet.collapsed, firstSet.layout);
    const image = await imageOf(labelFrame);
    const rightAxis: number[] = geometry.panel.right;
    const upAxis: number[] = geometry.panel.up;
    const panelNormal: number[] = geometry.panel.normal;
    for (const [index, button] of geometry.buttons.entries()) {
      const lines = button.labelLines ?? [button.label];
      for (const [lineIndex, line] of lines.entries()) {
        // Match the renderer's centered lines, including their vertical spacing.
        const lineOffset = ((lines.length - 1) / 2 - lineIndex) * geometry.fontMeters * .7;
        const linePoint = button.point.map((value, axis) => value + upAxis[axis] * lineOffset);
        const textHalfWidth = line.length * geometry.fontMeters * geometry.glyphAspect / 2;
        const glyphMeters = geometry.fontMeters * geometry.glyphAspect;
        const shift = (metres: number) => linePoint.map((value, axis) => value + rightAxis[axis] * metres);
        const safeName = button.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `row-${index + 1}`;
        const lineSuffix = lines.length > 1 ? `-line-${lineIndex + 1}` : '';
        // A row is judged in whichever eye actually contains its whole plate.
        // The emulated eye's horizontal field comes from its viewport aspect, so
        // a panel seated wide enough can fall off the edge of both eyes; when it
        // does, these frames cannot show whether the label is complete and the
        // gate says exactly that instead of measuring the clipped remains.
        let chosen: { crop: RasterImage; optics: EyeOptics; plateBox: Box;
          predictedLeft: { x: number; y: number; behind: boolean }; predictedRight: { x: number; y: number; behind: boolean };
          glyphPixels: number; eye: string } | undefined;
        const clipReports: string[] = [];
        for (const eyeRecord of labelFrame.eyes) {
          const crop = eyeCrop(image, eyeRecord.viewport);
          const optics = eyeOptics(eyeRecord.eye, crop.width, crop.height, labelFrame.headYawDegrees);
          const plateBox = projectedBox(optics, button.corners);
          const predictedLeft = projectToEye(optics, shift(-textHalfWidth));
          const predictedRight = projectToEye(optics, shift(textHalfWidth));
          if (!plateBox || predictedLeft.behind || predictedRight.behind) {
            clipReports.push(`${eyeRecord.eye}: behind the eye`);
            continue;
          }
          const inside = plateBox.left >= 0 && plateBox.right <= crop.width
            && plateBox.top >= 0 && plateBox.bottom <= crop.height
            && predictedLeft.x >= 0 && predictedRight.x <= crop.width;
          if (!inside) {
            clipReports.push(`${eyeRecord.eye}: plate x ${plateBox.left.toFixed(0)}..${plateBox.right.toFixed(0)} against a ${crop.width} px eye`);
            continue;
          }
          chosen ??= { crop, optics, plateBox, predictedLeft, predictedRight, eye: eyeRecord.eye,
            glyphPixels: Math.abs(projectToEye(optics, shift(glyphMeters)).x - projectToEye(optics, shift(0)).x) };
        }
        if (clipReports.length || labelFrame.eyes.length !== 2) failures.push({ rule: 'eye-frame', frame: labelFrame.path,
          reason: `Toolbar row "${button.label}" must have its whole plate visible in both captured eyes (${clipReports.join('; ') || 'missing stereo eye'}).` });
        if (!chosen) {
          failures.push({ rule: 'label-completeness', frame: labelFrame.path,
            reason: `Toolbar row "${button.label}" lies outside every emulated eye viewport in ${labelFrame.file} (${clipReports.join('; ')}), so these artifacts cannot show whether its label is complete. Capture the actual reading glance with its head yaw before claiming the menu was reviewed.` });
          continue;
        }
        const { crop, optics, plateBox, glyphPixels } = chosen;
        const frame: PlateFrame = { point: linePoint, right: rightAxis, up: upAxis, normal: panelNormal };
        const plateFrame: PlateFrame = { ...frame, point: button.point };

        // The drawn ink, measured on the plate's own plane rather than inside the
        // plate's bounding box. Three things can occupy a row band: the plate
        // face, the room behind it, and glyph. The plate face is the band's modal
        // colour and the room is the frame's clear colour, so ink is whatever is
        // neither. The band runs a glyph past the plate on each side, so a label
        // that overruns its plate is measured rather than clipped away.
        const room = backgroundColor(crop);
        // Nine tenths of the row's own half height. The drawn plate face is
        // lifted off the geometric mid-plane toward the wearer and its glyphs
        // ride with it, so a band cut tight around the mid-plane can miss the
        // label it is measuring; the next row is a whole row step away, so this
        // still cannot reach a neighbour.
        const bandHalfHeight = lines.length > 1 ? geometry.fontMeters * .3 : button.halfHeight * 0.9;
        const scanLeft = Math.max(0, Math.floor(plateBox.left - glyphPixels * 2));
        const scanRight = Math.min(crop.width - 1, Math.ceil(plateBox.right + glyphPixels * 2));
        const scanTop = Math.max(0, Math.floor(plateBox.top)), scanBottom = Math.min(crop.height - 1, Math.ceil(plateBox.bottom));
        const histogram = new Map<string, number>();
        const band: { x: number; y: number; u: number }[] = [];
        for (let y = scanTop; y <= scanBottom; y++) {
          for (let x = scanLeft; x <= scanRight; x++) {
            const local = plateLocal(optics, frame, x, y);
            const plateLocalPoint = plateLocal(optics, plateFrame, x, y);
            if (!local || !plateLocalPoint || Math.abs(plateLocalPoint.v) > button.halfHeight) continue;
            // The plate's own colour is sampled from the whole plate, not from
            // the label band: a label is at most half the height of its plate,
            // but on a row whose text fills the plate's width it is the majority
            // colour inside the band, and the modal test would then call the
            // plate the ink and the ink the plate.
            if (Math.abs(plateLocalPoint.u) <= button.halfWidth * 0.9 && Math.abs(plateLocalPoint.v) <= button.halfHeight * 0.95) {
              const at = (y * crop.width + x) * 4;
              const key = `${crop.data[at] >> 3},${crop.data[at + 1] >> 3},${crop.data[at + 2] >> 3}`;
              histogram.set(key, (histogram.get(key) ?? 0) + 1);
            }
            if (Math.abs(local.v) <= bandHalfHeight && Math.abs(local.u) <= button.halfWidth + glyphMeters) {
              band.push({ x, y, u: local.u });
            }
          }
        }
        const plateKey = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const plateColor = (plateKey ?? '0,0,0').split(',').map(value => Number(value) << 3) as [number, number, number];
        let inkLeftMeters = Infinity, inkRightMeters = -Infinity, inkPixels = 0;
        let inkLeft = Infinity, inkRight = -Infinity;
        for (const pixel of band) {
          if (!isLit(crop, pixel.x, pixel.y, plateColor, 45) || !isLit(crop, pixel.x, pixel.y, room, 45)) continue;
          inkPixels++;
          inkLeftMeters = Math.min(inkLeftMeters, pixel.u);
          inkRightMeters = Math.max(inkRightMeters, pixel.u);
          inkLeft = Math.min(inkLeft, pixel.x);
          inkRight = Math.max(inkRight, pixel.x);
        }
        // `addGlyphs` in `spatial-toolbar.mjs` centres a label on its row: it
        // sums the font atlas advances and starts the run at minus half that
        // width. Those advances are proportional, so the gate cannot predict the
        // run's width from the label's length -- the nominal 0.54 em the plate is
        // sized with is half again too wide, and comparing ink against it failed
        // every complete row in the CRISPR frames. What a centred run does
        // promise is symmetry: it starts as far left of the row centre as it
        // ends right of it. That is what is checked, to a tolerance of one glyph.
        const centredStartMeters = -inkRightMeters;
        const startDriftGlyphs = (inkLeftMeters - centredStartMeters) / glyphMeters;

        // A crop a person can judge without the gate's numbers: the plate in
        // orange, and green ticks where a centred run of this ink would start and
        // stop. Ink outside the orange box, or short of the left green tick, is
        // the defect, visible at a glance.
        const padX = Math.max(8, (plateBox.right - plateBox.left) * 0.15);
        const padY = Math.max(6, (plateBox.bottom - plateBox.top) * 0.35);
        const originX = Math.max(0, Math.round(plateBox.left - padX));
        const originY = Math.max(0, Math.round(plateBox.top - padY));
        const region = cropImage(crop, originX, originY,
          plateBox.right - plateBox.left + padX * 2, plateBox.bottom - plateBox.top + padY * 2);
        const zoom = 4;
        const zoomed = resizeImage(region, region.width * zoom, region.height * zoom);
        // The band the rule actually measured, drawn on the plate's own plane
        // rather than as a bounding box. The box spans the rows above and below,
        // so a reader shown it would read a centred label as one that overruns
        // its plate, and would not see when the band caught a neighbour's tail.
        const outline = [[-1, 1], [1, 1], [1, -1], [-1, -1]]
          .map(([u, v]) => projectToEye(optics, [
            linePoint[0] + rightAxis[0] * u * button.halfWidth + upAxis[0] * v * bandHalfHeight,
            linePoint[1] + rightAxis[1] * u * button.halfWidth + upAxis[1] * v * bandHalfHeight,
            linePoint[2] + rightAxis[2] * u * button.halfWidth + upAxis[2] * v * bandHalfHeight]))
          .filter(point => !point.behind)
          .map(point => ({ x: (point.x - originX) * zoom, y: (point.y - originY) * zoom }));
        for (let corner = 0; corner < outline.length; corner++) {
          const from = outline[corner], to = outline[(corner + 1) % outline.length];
          const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
          for (let step = 0; step <= steps; step++) {
            drawRect(zoomed, Math.round(from.x + (to.x - from.x) * step / steps),
              Math.round(from.y + (to.y - from.y) * step / steps), 0, 0, [255, 96, 0], 1);
          }
        }
        const tickMeters = Number.isFinite(inkRightMeters) ? [centredStartMeters, inkRightMeters] : [-textHalfWidth, textHalfWidth];
        for (const tick of tickMeters.map(metres => projectToEye(optics, shift(metres)).x)) {
          const at = Math.round((tick - originX) * zoom);
          drawRect(zoomed, at, 0, 0, zoomed.height - 1, [80, 230, 120], 1);
        }
        const caption = `${button.label}${lines.length > 1 ? ` line ${lineIndex + 1}` : ''}  measured band orange, centred run green`;
        const banner = createImage(Math.max(zoomed.width, textWidth(caption, 2) + 12), zoomed.height + 24, [16, 16, 20, 255]);
        blit(banner, zoomed, 0, 24);
        drawText(banner, caption, 6, 6, [255, 255, 255], 2);
        const cropPath = resolve(gateDir, `labels-${safeName}${lineSuffix}.png`);
        await writeFile(cropPath, encodePng(banner));
        labelCrops.push(cropPath);

        const centimetres = (metres: number) => (metres * 100).toFixed(2);
        const record = { row: button.label, line, lineIndex, eye: chosen.eye, plateHalfWidthMeters: button.halfWidth,
          inkLeftMeters, inkRightMeters, centredStartMeters, startDriftGlyphs, glyphMeters,
          inkLeft, inkRight, inkPixels, glyphPixels, crop: cropPath };
        labelMeasurements.push(record);
        if (inkPixels < 6) {
          failures.push({ rule: 'label-completeness', frame: cropPath,
            reason: `Toolbar row "${button.label}" draws no readable text on its plate in ${labelFrame.file}; only ${inkPixels} ink pixels were found inside the plate.` });
          continue;
        }
        if (inkLeftMeters < -button.halfWidth) {
          failures.push({ rule: 'label-completeness', frame: cropPath,
            reason: `Toolbar row "${button.label}" starts ${centimetres(-button.halfWidth - inkLeftMeters)} cm outside the left edge of its own plate in ${labelFrame.file}.` });
        } else if (startDriftGlyphs > LEADING_GLYPH_TOLERANCE_GLYPHS) {
          failures.push({ rule: 'label-completeness', frame: cropPath,
            reason: `Toolbar row "${button.label}" is missing its leading glyph in ${labelFrame.file}: its ink ends ${centimetres(inkRightMeters)} cm right of the row centre but starts only ${centimetres(-inkLeftMeters)} cm left of it, so the run begins ${startDriftGlyphs.toFixed(1)} glyph widths right of where a centred label starts.` });
        }
        if (inkRightMeters > button.halfWidth) {
          failures.push({ rule: 'label-completeness', frame: cropPath,
            reason: `Toolbar row "${button.label}" runs ${centimetres(inkRightMeters - button.halfWidth)} cm past the right edge of its own plate in ${labelFrame.file}.` });
        }
      }
    }
  }
  measurements.labels = labelMeasurements;

  // -- Rule 3: every press changes something the wearer can see -----------
  const targets: any[] = report?.emulatedXr?.toolbarTargets ?? [];
  const stepRecords: Record<string, unknown>[] = [];
  for (let index = 1; index < captures.length; index++) {
    const before = captures[index - 1], after = captures[index];
    const beforeImage = await imageOf(before), afterImage = await imageOf(after);
    const eye = after.eyes.find(candidate => candidate.eye === 'left') ?? after.eyes[0];
    const beforeEye = before.eyes.find(candidate => candidate.eye === eye.eye) ?? before.eyes[0];
    const beforeCrop = eyeCrop(beforeImage, beforeEye.viewport), afterCrop = eyeCrop(afterImage, eye.viewport);
    const optics = eyeOptics(eye.eye, afterCrop.width, afterCrop.height, after.headYawDegrees);
    const panelBox = projectedBox(optics, worstPanelPoints);
    const structure = changedFraction(beforeCrop, afterCrop, [panelBox], false);
    const panel = changedFraction(beforeCrop, afterCrop, [panelBox], true);
    // A press is named by the row the harness resolved for it when the counts
    // line up; otherwise the frame carries the name, which is still the thing
    // a person opens.
    const row = targets[index - 1]?.label ?? null;
    const rowsBefore = targets[index - 1]?.rows, rowsAfter = targets[index]?.rows;
    const panelStateChanged = Array.isArray(rowsBefore) && Array.isArray(rowsAfter)
      ? rowsBefore.join('|') !== rowsAfter.join('|') || targets[index - 1]?.collapsed !== targets[index]?.collapsed
      : null;
    stepRecords.push({ step: `${before.file} -> ${after.file}`, row, structure: Number(structure.toFixed(5)),
      panel: Number(panel.toFixed(5)), panelStateChanged });
    // Recorded panel state does not rescue a frame that did not change. That
    // substitution is exactly what let "pressing play tour does nothing" pass
    // for days: the state moved, the wearer's view did not.
    if (structure < REGION_CHANGE_FRACTION && panel < REGION_CHANGE_FRACTION) {
      failures.push({ rule: 'action-visibility', frame: after.path,
        reason: `${row ? `Pressing "${row}"` : `The step reaching ${after.file}`} changed nothing a wearer can see: ${(structure * 100).toFixed(3)}% of the structure region and ${(panel * 100).toFixed(3)}% of the panel region moved between ${before.file} and ${after.file}.` });
    }
  }
  measurements.actionSteps = stepRecords;

  // -- Rule 4: frame budget, reported not enforced ------------------------
  const rates: number[] = [];
  for (const ring of report?.failureDiagnostics ?? []) {
    for (const entry of ring ?? []) {
      if (entry?.kind === 'frame-rate' && Number.isFinite(entry?.detail?.fps)) rates.push(entry.detail.fps);
    }
  }
  if (Number.isFinite(report?.emulatedXr?.frameRate)) rates.push(report.emulatedXr.frameRate);
  measurements.frameRates = rates;
  if (!rates.length) {
    warnings.push({ rule: 'frame-budget', reason: `These artifacts carry no frame-rate record, so the ${TARGET_FRAME_RATE} Hz target is unmeasured here. The emulator is not a Quest; the headset log is the only real source.` });
  } else {
    const lowest = Math.min(...rates);
    if (lowest < TARGET_FRAME_RATE) {
      warnings.push({ rule: 'frame-budget', reason: `Lowest recorded frame rate ${lowest.toFixed(1)} fps against a ${TARGET_FRAME_RATE} Hz target. A desktop emulator misses that target for its own reasons, so this is a signal, not a verdict.` });
    }
  }

  // -- Rule 5: one image a human looks at ---------------------------------
  const contactSheet = await writeContactSheet(gateDir, captures, decoded, imageOf, failures, warnings);

  await writeFile(resolve(gateDir, 'gate-report.json'), JSON.stringify({
    artifactDir, contactSheet, failures, warnings, notes, labelCrops, measurements,
    reportSha256: createHash('sha256').update(await readFile(reportPath)).digest('hex'),
  }, null, 2) + '\n');
  return { artifactDir, gateDir, contactSheet, failures, warnings, notes, labelCrops, measurements };
}

/**
 * Entry, after every action, after the scale, both eyes, labelled, in one
 * image. The harness's paired framebuffer already holds both eyes side by
 * side, so a cell is one frame and the sheet is the run in order.
 */
async function writeContactSheet(gateDir: string, captures: XrCapture[],
  _decoded: Map<string, RasterImage>, imageOf: (capture: XrCapture) => Promise<RasterImage>,
  failures: GateFinding[], warnings: GateFinding[]): Promise<string> {
  const path = resolve(gateDir, 'CONTACT-SHEET.png');
  const cellWidth = 480, captionHeight = 22, columns = Math.min(3, Math.max(1, captures.length));
  if (!captures.length) {
    const empty = createImage(640, 120, [24, 12, 12, 255]);
    drawText(empty, 'NO XR CAPTURES IN THESE ARTIFACTS', 12, 20, [255, 120, 120], 2);
    drawText(empty, 'THE HARNESS NEVER RENDERED THE WEARER VIEW', 12, 48, [220, 220, 220], 2);
    await writeFile(path, encodePng(empty));
    return path;
  }
  const cells: { image: RasterImage; caption: string }[] = [];
  for (const capture of captures) {
    const image = await imageOf(capture);
    const scale = cellWidth / image.width;
    cells.push({ image: resizeImage(image, cellWidth, Math.max(1, Math.round(image.height * scale))),
      caption: capture.file.replace(/\.png$/, '') });
  }
  const cellHeight = Math.max(...cells.map(cell => cell.image.height)) + captionHeight;
  const rows = Math.ceil(cells.length / columns);
  const headerHeight = 64;
  const sheet = createImage(columns * (cellWidth + 8) + 8, headerHeight + rows * (cellHeight + 8) + 8, [18, 18, 22, 255]);
  const verdict = failures.length ? `FAIL: ${failures.length} RULE BREACH(ES)` : 'PASS';
  drawText(sheet, 'STEREOFOLD WEARER-VIEW GATE CONTACT SHEET', 10, 8, [255, 255, 255], 2);
  drawText(sheet, verdict, 10, 30, failures.length ? [255, 110, 110] : [120, 230, 140], 2);
  drawText(sheet, `${warnings.length} WARNING(S) - EACH CELL IS ONE FRAME, LEFT EYE THEN RIGHT EYE`, 10, 48, [190, 190, 200], 1);
  cells.forEach((cell, index) => {
    const column = index % columns, row = Math.floor(index / columns);
    const x = 8 + column * (cellWidth + 8), y = headerHeight + row * (cellHeight + 8);
    drawText(sheet, cell.caption.slice(0, Math.floor(cellWidth / 12)), x + 2, y + 4, [230, 230, 120], 2);
    blit(sheet, cell.image, x, y + captionHeight);
    // The central cone, marked in each eye, so what rule 1 measures is what a
    // reader sees. Each half of the paired frame is one eye.
    const eyeWidth = cell.image.width / 2;
    const coneRadius = Math.tan(CENTRAL_CONE_HALF_ANGLE_DEGREES * Math.PI / 180) * (cell.image.height / 2)
      / Math.tan((EMULATED_DEVICE.verticalFieldOfViewDegrees / 2) * Math.PI / 180);
    for (const half of [0, 1]) {
      const centreX = x + half * eyeWidth + eyeWidth / 2, centreY = y + captionHeight + cell.image.height / 2;
      drawRect(sheet, Math.round(centreX - coneRadius), Math.round(centreY - coneRadius),
        Math.round(coneRadius * 2), Math.round(coneRadius * 2), [255, 80, 80], 1);
    }
  });
  await writeFile(path, encodePng(sheet));
  return path;
}

export function formatGateResult(result: GateResult): string {
  const lines = [`Wearer-view gate over ${result.artifactDir}`];
  for (const failure of result.failures) lines.push(`FAIL [${failure.rule}] ${failure.reason}${failure.frame ? ` -> ${failure.frame}` : ''}`);
  for (const warning of result.warnings) lines.push(`WARN [${warning.rule}] ${warning.reason}`);
  for (const note of result.notes) lines.push(`note: ${note}`);
  lines.push(`Contact sheet: ${result.contactSheet}`);
  lines.push(result.failures.length ? `Gate failed: ${result.failures.length} rule breach(es).` : 'Gate passed.');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: pnpm --dir plugin run xr-gate /absolute/artifact/dir');
    process.exit(2);
  }
  const result = await runXrGate(target);
  console.log(formatGateResult(result));
  process.exit(result.failures.length ? 1 : 0);
}
