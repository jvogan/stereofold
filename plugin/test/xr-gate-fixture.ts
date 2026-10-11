/**
 * A harness-shaped artifact set, built from the production geometry modules.
 *
 * The gate reads a directory `scripts/companion-browser.ts` wrote: paired
 * both-eye framebuffer PNGs plus `browser-report.json`. This builds one of
 * those directories without a browser, so `xr-gate.test.ts` runs in a second
 * and can then break exactly one thing at a time and watch the matching rule
 * fire. The frames are drawn from the same panel, orb and eye projection the
 * gate measures against, so a fixture and the gate can only disagree about
 * what is *painted*, which is what the breakages change.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildPanel, eyeOptics, plateLocal, projectToEye, type EyeOptics, type LayoutOverrides, type PlateFrame,
} from '../scripts/xr-gate.js';
import { createImage, decodePng, encodePng, type RasterImage } from '../scripts/png-image.js';

// A fixed headset-like eye: 42 horizontal degrees per side, 45 vertical.
// The label frame turns toward the peripheral panel; never widen the lens
// to hide clipping at the forward gaze.
const EYE_HEIGHT = 640;
const EYE_WIDTH = Math.round(EYE_HEIGHT * Math.tan(42 * Math.PI / 180));
const BACKGROUND: [number, number, number, number] = [16, 16, 20, 255];
const PLATE: [number, number, number] = [64, 74, 96];
const INK: [number, number, number] = [242, 244, 250];

function fillRect(image: RasterImage, left: number, top: number, right: number, bottom: number, color: [number, number, number]) {
  for (let y = Math.max(0, Math.round(top)); y < Math.min(image.height, Math.round(bottom)); y++) {
    for (let x = Math.max(0, Math.round(left)); x < Math.min(image.width, Math.round(right)); x++) {
      const index = (y * image.width + x) * 4;
      image.data[index] = color[0];
      image.data[index + 1] = color[1];
      image.data[index + 2] = color[2];
      image.data[index + 3] = 255;
    }
  }
}

function fillDisc(image: RasterImage, centreX: number, centreY: number, radius: number, color: [number, number, number]) {
  for (let y = Math.max(0, Math.round(centreY - radius)); y < Math.min(image.height, Math.round(centreY + radius)); y++) {
    for (let x = Math.max(0, Math.round(centreX - radius)); x < Math.min(image.width, Math.round(centreX + radius)); x++) {
      if (Math.hypot(x - centreX, y - centreY) > radius) continue;
      const index = (y * image.width + x) * 4;
      image.data[index] = color[0];
      image.data[index + 1] = color[1];
      image.data[index + 2] = color[2];
      image.data[index + 3] = 255;
    }
  }
}

interface DrawOptions {
  rows: string[];
  collapsed: boolean;
  /** Absent draws no structure at all, which is the harness's off-molecule frame. */
  moleculeRadiusMeters?: number;
  moleculeTint: [number, number, number];
  overrides?: LayoutOverrides;
  headYawDegrees?: number;
}

/** One row's plate and label in the plate's own metres, plus the axes to paint it on. */
export async function labelInkSpan(rows: string[], collapsed: boolean, row: string, overrides: LayoutOverrides = {}) {
  const geometry = await buildPanel(rows, collapsed, overrides);
  const button = geometry.buttons.find(candidate => candidate.label === row);
  if (!button) throw Error(`No row "${row}" in ${JSON.stringify(rows)}.`);
  const glyphMeters = geometry.fontMeters * geometry.glyphAspect;
  return {
    frame: { point: button.point, right: geometry.panel.right, up: geometry.panel.up, normal: geometry.panel.normal } as PlateFrame,
    corners: button.corners as number[][],
    plateHalfWidth: button.halfWidth as number, plateHalfHeight: button.halfHeight as number,
    textHalfWidth: Math.max(...(button.labelLines ?? [row]).map(line => line.length)) * glyphMeters / 2, glyphMeters,
    lines: (button.labelLines ?? [row]).map((text, index, lines) => ({
      textHalfWidth: text.length * glyphMeters / 2,
      offset: ((lines.length - 1) / 2 - index) * geometry.fontMeters * .7,
    })), fontMeters: geometry.fontMeters,
  };
}

/**
 * Paint one row on the plate's own plane: plate face, then the label band.
 *
 * The panel is tilted down toward the wearer and rolled with its seat, so a
 * row's picture in an eye is a tilted quad, and a label drawn as a level bar
 * across that quad's bounding box lies partly on the rows above and below.
 * The gate measures ink in plate metres for exactly that reason, so the
 * fixture paints in plate metres too and the two can only disagree about what
 * is painted.
 */
function paintRow(image: RasterImage, optics: EyeOptics,
  span: Awaited<ReturnType<typeof labelInkSpan>>, ink: 'label' | 'blank-leading-glyph' | 'none', blankLineIndex?: number) {
  const projected = span.corners.map(corner => projectToEye(optics, corner)).filter(point => !point.behind);
  if (!projected.length) return;
  const margin = 4;
  const left = Math.max(0, Math.floor(Math.min(...projected.map(point => point.x)) - margin));
  const right = Math.min(image.width - 1, Math.ceil(Math.max(...projected.map(point => point.x)) + margin));
  const top = Math.max(0, Math.floor(Math.min(...projected.map(point => point.y)) - margin));
  const bottom = Math.min(image.height - 1, Math.ceil(Math.max(...projected.map(point => point.y)) + margin));
  const inkHalfHeight = span.lines.length > 1 ? span.fontMeters * .25 : span.plateHalfHeight * 0.4;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const local = plateLocal(optics, span.frame, x, y);
      if (!local || Math.abs(local.u) > span.plateHalfWidth || Math.abs(local.v) > span.plateHalfHeight) continue;
      const onLabel = ink !== 'none' && span.lines.some((line, lineIndex) =>
        Math.abs(local.u) <= line.textHalfWidth && Math.abs(local.v - line.offset) <= inkHalfHeight
        && !(ink === 'blank-leading-glyph' && (blankLineIndex === undefined || blankLineIndex === lineIndex) && local.u < -line.textHalfWidth + span.glyphMeters * 1.4));
      const color = onLabel ? INK : PLATE;
      const index = (y * image.width + x) * 4;
      image.data[index] = color[0];
      image.data[index + 1] = color[1];
      image.data[index + 2] = color[2];
      image.data[index + 3] = 255;
    }
  }
}

async function drawEye(eye: 'left' | 'right', options: DrawOptions): Promise<RasterImage> {
  const image = createImage(EYE_WIDTH, EYE_HEIGHT, BACKGROUND);
  const optics = eyeOptics(eye, EYE_WIDTH, EYE_HEIGHT, options.headYawDegrees ?? 0);
  if (options.moleculeRadiusMeters) {
    const centre = projectToEye(optics, [0, 1.6, -1.2]);
    const edge = projectToEye(optics, [options.moleculeRadiusMeters, 1.6, -1.2]);
    fillDisc(image, centre.x, centre.y, Math.abs(edge.x - centre.x), options.moleculeTint);
  }
  const geometry = await buildPanel(options.rows, options.collapsed, options.overrides);
  for (const button of geometry.buttons) {
    const span = await labelInkSpan(options.rows, options.collapsed, button.label, options.overrides);
    paintRow(image, optics, span, 'label');
  }
  // Nothing floats beside the menu, so a fixture frame that lights a disc
  // anywhere is a fixture that no longer matches the page.
  return image;
}

async function drawPairedFrame(options: DrawOptions): Promise<RasterImage> {
  const left = await drawEye('left', options), right = await drawEye('right', options);
  const paired = createImage(EYE_WIDTH * 2, EYE_HEIGHT, BACKGROUND);
  for (let row = 0; row < EYE_HEIGHT; row++) {
    paired.data.set(left.data.subarray(row * EYE_WIDTH * 4, (row + 1) * EYE_WIDTH * 4), row * EYE_WIDTH * 2 * 4);
    paired.data.set(right.data.subarray(row * EYE_WIDTH * 4, (row + 1) * EYE_WIDTH * 4), (row * EYE_WIDTH * 2 + EYE_WIDTH) * 4);
  }
  return paired;
}

export interface FixtureStep { file: string; rows: string[]; collapsed: boolean; label: string }

/**
 * Five frames: the entry pose, two toolbar presses, the harness's
 * molecule-moved-aside frame, and a scale. Both eyes in every one.
 */
export async function requiredEyeHalfFieldDegrees(rows: string[], collapsed: boolean,
  overrides: LayoutOverrides = {}): Promise<number> {
  const geometry = await buildPanel(rows, collapsed, overrides);
  const points = geometry.points;
  const worst = Math.max(...points.map(point => {
    const depth = -(point[2] - 0);
    return depth > 0.05 ? Math.abs(point[0]) / depth : 0;
  }));
  return Math.atan(worst) * 180 / Math.PI;
}

export async function buildXrGateFixture(directory: string, overrides: LayoutOverrides = {}): Promise<FixtureStep[]> {
  await mkdir(directory, { recursive: true });
  const content = await import(
    new URL('../../lab/browser-roundtrip/spatial-toolbar-content.mjs', import.meta.url).href) as any;
  const rowsFor = (collapsed: boolean, menuOpen: boolean) => (content.spatialToolbarRows({
    collapsed, mode: 'move', paused: true, voice: { state: 'idle' },
    tour: { active: true, autoplay: false, menuOpen, navigating: false, canBack: true, canNext: true,
      bodyPageIndex: 0, bodyPageCount: 3, selectedId: 'a' },
  }) as { label: string }[]).map(row => row.label);

  const compact = rowsFor(true, false), expanded = rowsFor(false, false), menu = rowsFor(true, true);
  const entryYaw = (await buildPanel(compact, true, overrides)).readingYawDegrees;
  const steps: (FixtureStep & DrawOptions)[] = [
    { file: '07-entry-xr.png', rows: compact, collapsed: true, label: 'entry', headYawDegrees: entryYaw, moleculeRadiusMeters: 0.30, moleculeTint: [190, 110, 80], overrides },
    { file: '07a-companion-xr-toolbar-expanded.png', rows: expanded, collapsed: false, label: 'More controls', moleculeRadiusMeters: 0.30, moleculeTint: [190, 110, 80], overrides },
    { file: '07b-companion-xr-tour-menu.png', rows: menu, collapsed: true, label: 'Tour menu', moleculeRadiusMeters: 0.30, moleculeTint: [90, 170, 200], overrides },
    // The harness takes its molecule-moved-aside frame with the grid OPEN and
    // names it so, and the gate's pixel rule reads that name to pick which
    // cone the frame is held to. The fixture used to draw the compact tour
    // menu under the `toolbar-expanded` name, which quietly held a compact row
    // set to the grid's looser cone -- the one thing this frame exists to
    // check. Name and content agree now.
    { file: '07f-companion-xr-off-molecule-toolbar-collapsed.png', rows: menu, collapsed: true, label: 'Off molecule', moleculeTint: [0, 0, 0], overrides },
    { file: '08-companion-xr-after-scale.png', rows: menu, collapsed: true, label: 'Scale up', moleculeRadiusMeters: 0.55, moleculeTint: [90, 170, 200], overrides },
  ];

  const screenshots: unknown[] = [];
  for (const step of steps) {
    const paired = await drawPairedFrame(step);
    await writeFile(resolve(directory, step.file), encodePng(paired));
    screenshots.push({
      file: step.file, headYawDegrees: step.headYawDegrees ?? 0, kind: 'emulated_xr_raw_paired_framebuffer', width: EYE_WIDTH * 2, height: EYE_HEIGHT,
      eyes: [{ eye: 'left', viewport: [0, 0, EYE_WIDTH, EYE_HEIGHT] }, { eye: 'right', viewport: [EYE_WIDTH, 0, EYE_WIDTH, EYE_HEIGHT] }],
    });
  }
  // One recorded target per step, in the order the harness records them: the
  // rows live when that press was resolved.
  const toolbarTargets = steps.map(step => ({ query: { kind: 'fixture' }, label: step.label,
    collapsed: step.collapsed, rows: step.rows, target: { x: 0, y: 1.6, z: -1 } }));
  await writeFile(resolve(directory, 'browser-report.json'), JSON.stringify({
    status: 'passed', cases: ['fixture'], screenshots, errors: [], externalRequests: [], cleanup: {},
    emulatedXr: { runtime: 'IWER 2.3.0 (fixture)', toolbarTargets },
    failureDiagnostics: [[{ kind: 'frame-rate', detail: { fps: 61.4, frames: 300, seconds: 4.9 } }]],
  }, null, 2) + '\n');
  return steps.map(({ file, rows, collapsed, label }) => ({ file, rows, collapsed, label }));
}

async function loadFrame(directory: string, file: string) {
  return decodePng(await readFile(resolve(directory, file)));
}

async function saveFrame(directory: string, file: string, image: RasterImage) {
  await writeFile(resolve(directory, file), encodePng(image));
}

/** Paste a menu plate straight into the middle of both eyes of one frame. */
export async function breakCentralCone(directory: string, file: string): Promise<void> {
  const image = await loadFrame(directory, file);
  for (const offset of [0, EYE_WIDTH]) {
    const cx = offset + EYE_WIDTH / 2, cy = EYE_HEIGHT / 2;
    fillRect(image, cx - 90, cy - 40, cx + 90, cy + 40, PLATE);
    fillRect(image, cx - 70, cy - 8, cx + 70, cy + 8, INK);
  }
  await saveFrame(directory, file, image);
}

/** Blank one row's leading glyph, so "move menu" renders as "ove menu". */
export async function breakLeadingGlyph(directory: string, file: string, rows: string[], collapsed: boolean,
  row: string, overrides: LayoutOverrides = {}, lineIndex?: number): Promise<{ blankedMeters: number }> {
  const image = await loadFrame(directory, file);
  const span = await labelInkSpan(rows, collapsed, row, overrides);
  // The left eye seats at x = 0 in the paired frame, so its pixel coordinates
  // are the frame's. It is also the eye the gate judges a row in first.
  const report = JSON.parse(await readFile(resolve(directory, 'browser-report.json'), 'utf8'));
  const yaw = report.screenshots.find((shot: any) => shot.file === file)?.headYawDegrees ?? 0;
  paintRow(image, eyeOptics('left', EYE_WIDTH, EYE_HEIGHT, yaw), span, 'blank-leading-glyph', lineIndex);
  await saveFrame(directory, file, image);
  return { blankedMeters: span.glyphMeters * 1.4 };
}

/** Make one press produce the frame before it, byte for byte. */
export async function breakActionVisibility(directory: string, before: string, after: string): Promise<void> {
  await writeFile(resolve(directory, after), await readFile(resolve(directory, before)));
}

/** Report a frame rate under the tier target. */
export async function breakFrameBudget(directory: string, fps: number): Promise<void> {
  const path = resolve(directory, 'browser-report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.failureDiagnostics = [[{ kind: 'frame-rate', detail: { fps, frames: 120, seconds: 4 } }]];
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
}
