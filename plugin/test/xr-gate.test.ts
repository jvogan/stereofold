/**
 * The gate has to fail on the three defects seen on hardware that the harness
 * had already photographed. Each case below builds a harness-
 * shaped artifact set, checks the gate passes it, breaks exactly one thing,
 * and checks the matching rule fires with a reason a person can act on.
 *
 * A gate nobody has watched fail is a gate nobody should trust.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  CENTRAL_CONE_HALF_ANGLE_DEGREES, EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES, EYE_FRAME_LIMIT_DEGREES,
  EYE_HALF_FIELD_DEGREES, PANEL_FRAME_MARGIN_DEGREES, EYE_FRAME_VERTICAL_LIMIT_DEGREES, TARGET_FRAME_RATE,
  buildPanel, drawnRowLayout, eyeOptics, projectToEye, toolbarPixelConeDegrees, measureCentralCone, measureEyeFrame, measureLabelMargins, runXrGate,
} from '../scripts/xr-gate.js';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { MENU_LABEL_BUDGET_CHARACTERS } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { HALF_IPD_METERS, SPATIAL_TOOLBAR_LAYOUT, TOOLBAR_READING_RANGE_METERS, toolbarSeatDegrees } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
import { decodePng } from '../scripts/png-image.js';
import {
  breakActionVisibility, breakCentralCone, breakFrameBudget, breakLeadingGlyph, buildXrGateFixture,
} from './xr-gate-fixture.js';

const reasons = (findings: { rule: string; reason: string }[], rule: string) =>
  findings.filter(finding => finding.rule === rule).map(finding => finding.reason);

it('measures known toolbar pixels about the head without forgiving true cone intrusions', async () => {
  const rows = ['Talk','Play','Done','Back','Next','Pg 1/2','Close','Mol*','Rotate','Above us','In reach','Spin','Fit','Reset','Detail 2','Sequence','Scale −','Scale +','X −','X +','Y −','Y +','Z −','Z +','Cartoon','Surface','Atoms','Chain','Element','Opaque −','Opaque +','Move'];
  const geometry = await buildPanel(rows, false, { toolbarConstants: { maxRows: 16 } });
  const optics = eyeOptics('left', 1120, 630);
  const known = toolbarPixelConeDegrees(optics, 494, 314, geometry);
  expect(known).toBeGreaterThanOrEqual(EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES);
  const intruding = structuredClone(geometry);
  // Keep the deliberate intrusion's angular travel when the reading range
  // and all physical menu dimensions grow together from the .95 m design.
  for (const plate of [...intruding.buttons, intruding.panel.backing])
    plate.point[0] += 0.15 * TOOLBAR_READING_RANGE_METERS / .95;
  const edge = intruding.buttons[22];
  const pixel = projectToEye(optics, edge.point);
  expect(toolbarPixelConeDegrees(optics, pixel.x, pixel.y, intruding)).toBeLessThan(EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES);
  expect(toolbarPixelConeDegrees(optics, 560, 100, geometry)).toBeUndefined();
  expect(toolbarPixelConeDegrees({ ...optics, tanHalfX: NaN }, 494, 314, geometry)).toBeUndefined();
});

it('measures the runtime two-column fold from drawn row positions without relaxing its cone', async () => {
  const rows = ['Talk','Pause','Done','Back','Next','Pg 1/2','Close','Mol*','Rotate','Above us','In reach','Spin','Fit','Reset','Detail 2','Sequence','Scale −','Scale +','X −','X +','Y −','Y +','Z −','Z +','Cartoon','Surface','Atoms','Chain','Element','Opaque −','Opaque +','Move'];
  const drawn = await buildPanel(rows, false, { toolbarConstants: { maxRows: 16 } });
  const layout = drawnRowLayout(drawn.buttons.map(button => button.point));
  expect(layout).toEqual({ toolbarConstants: { maxRows: 16 } });
  expect((await measureCentralCone(rows, false)).breaches).toBe(true);
  expect((await measureCentralCone(rows, false, layout)).breaches).toBe(false);
  expect(drawnRowLayout([[0,0,0],[NaN,0,0]])).toEqual({});
});

async function withFixture<T>(work: (directory: string, steps: Awaited<ReturnType<typeof buildXrGateFixture>>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(resolve(tmpdir(), 'stereofold-xr-gate-'));
  try { return await work(directory, await buildXrGateFixture(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('the wearer-view gate', () => {
  it('refuses malformed captured row centres before enabling pixel remapping', async () => {
    await withFixture(async directory => {
      const { writeFile } = await import('node:fs/promises');
      const path = resolve(directory, 'browser-report.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      const rows = ['Talk', 'Tour', 'Tours', 'Menu', 'Move'];
      report.emulatedXr.toolbarFrames = [{ label: 'malformed-frame', rows, collapsed: true,
        drawnRowPoints: [[], [null, 0, 0], [], [], []] }];
      await writeFile(path, JSON.stringify(report));
      const result = await runXrGate(directory);
      expect(reasons(result.failures, 'artifacts').join(' ')).toContain('malformed-frame');
    });
  }, 120_000);

  it('checks a captured recovery toolbar even when no controller pressed its new layout', async () => {
    await withFixture(async directory => {
      const { writeFile } = await import('node:fs/promises');
      const path = resolve(directory, 'browser-report.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      const rows = ['Talk','Play','Done','Back','Next','Pg 1/2','Close','Mol*','Rotate','Above us','In reach','Spin','Fit','Reset','Detail 2','Sequence','Scale −','Scale +','X −','X +','Y −','Y +','Z −','Z +','Cartoon','Surface','Atoms','Chain','Element','Opaque −','Opaque +','Move'];
      const geometry = await buildPanel(rows, false);
      report.emulatedXr.toolbarFrames = [{ label: 'recovery-frame', rows, collapsed: false,
        drawnRowPoints: geometry.buttons.map(button => [button.point[0], button.point[1] - 1.6, button.point[2]]) }];
      await writeFile(path, JSON.stringify(report));
      const result = await runXrGate(directory);
      expect(reasons(result.failures, 'central-cone').join(' ')).toContain('recovery-frame');
    });
  }, 120_000);

  it('passes a clean harness artifact set and writes the contact sheet and one crop per row', async () => {
    await withFixture(async (directory, steps) => {
      const result = await runXrGate(directory);
      expect(result.failures).toEqual([]);
      const resetLines = (result.measurements.labels as { row: string; line: string; lineIndex: number; inkPixels: number }[])
        .filter(line => line.row === 'Reset');
      expect(resetLines.map(line => line.line)).toEqual(['Reset']);
      expect(resetLines.map(line => line.lineIndex)).toEqual([0]);
      expect(resetLines.every(line => line.inkPixels >= 6)).toBe(true);
      expect((await stat(result.contactSheet)).size).toBeGreaterThan(1_000);
      const sheet = decodePng(await readFile(result.contactSheet));
      expect(sheet.width).toBeGreaterThan(400);
      expect(sheet.height).toBeGreaterThan(250);
      // Every row of the frame the label rule measures gets its own crop.
      expect(result.labelCrops.length).toBeGreaterThanOrEqual(steps[0].rows.length);
      for (const crop of result.labelCrops) expect((await stat(crop)).size).toBeGreaterThan(200);
    });
  }, 120_000);

  it('captures the complete menu in the forward frame without a required reading turn', async () => {
    await withFixture(async directory => {
      const { writeFile } = await import('node:fs/promises');
      const path = resolve(directory, 'browser-report.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      expect(report.screenshots[0].headYawDegrees).toBe(0);
      delete report.screenshots[0].headYawDegrees;
      await writeFile(path, JSON.stringify(report));
      const result = await runXrGate(directory);
      expect(result.failures).toEqual([]);
    });
  }, 120_000);

  it('fails when anything the menu or orb draws enters the central cone', async () => {
    await withFixture(async (directory, steps) => {
      await breakCentralCone(directory, steps[3].file);
      const result = await runXrGate(directory);
      const found = reasons(result.failures, 'central-cone');
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain('off-molecule');
      // The inboard compact panel leaves a central thirty-two-degree cone.
      // This forward capture proves that clearance separately from the
      // forward frame used to inspect labels.
      expect(found.join(' ')).toContain('inside the central 32 degree cone');
      expect(CENTRAL_CONE_HALF_ANGLE_DEGREES).toBeGreaterThan(EXPANDED_GRID_CONE_HALF_ANGLE_DEGREES);
      expect(result.failures.some(failure => failure.frame?.includes(steps[3].file))).toBe(true);
    });
  }, 120_000);

  it('reports the pre-fix menu seat as a cone breach and the shipped seat as clear', async () => {
    // The rows the compact menu actually carries now, every one inside
    // `MENU_LABEL_BUDGET_CHARACTERS`. They used to read "Start tour", "Tour
    // menu", "Move menu" -- ten characters and up -- and a row's width is what
    // seats the panel, so the old wording is the old seat.
    const rows = ['Talk', 'Tour', 'Tours', 'Menu', 'Move'];
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(MENU_LABEL_BUDGET_CHARACTERS);
    // The rejected geometry, which sat in the way of the structure: 0.95 m
    // forward, 0.40 m to the left, 23 degrees off the forward axis.
    const before = await measureCentralCone(rows, true, {
      toolbarConstants: { forwardMeters: 0.95, rightMeters: -0.40, lowerMeters: 0.18 },
    });
    expect(before.breaches).toBe(true);
    expect(before.degrees).toBeLessThan(CENTRAL_CONE_HALF_ANGLE_DEGREES);
    const shipped = await measureCentralCone(rows, true);
    expect(shipped.breaches).toBe(false);
    expect(shipped.degrees).toBeGreaterThanOrEqual(CENTRAL_CONE_HALF_ANGLE_DEGREES);
    // Preserve the historical forward-lens solver regression explicitly.
    // Its wider labels drove the old seat into the molecular cone.
    const wordy = await measureCentralCone(['Talk', 'Start tour', 'Tour menu', 'Menu', 'Move menu'], true, { toolbarConstants: { peripheralSeat: false } });
    expect(wordy.degrees).toBeLessThan(shipped.degrees);
    expect(wordy.breaches).toBe(true);
  }, 60_000);

  it('holds every row set inside the eye the wearer has, in both eyes, at the IPD offset', async () => {
    // The rule whose absence let four passes ship a menu drawn where there is
    // no glass. `EYE_HALF_FIELD_DEGREES` is the Quest 2 half-lens measured off
    // hardware captures (x9-1720 of an 1832 px half-frame at
    // 20.4 px per degree); `PANEL_FRAME_MARGIN_DEGREES` is what the panel
    // keeps off that edge; `EYE_FRAME_LIMIT_DEGREES` is the two subtracted.
    expect(EYE_FRAME_LIMIT_DEGREES).toBe(EYE_HALF_FIELD_DEGREES - PANEL_FRAME_MARGIN_DEGREES);
    const sets: { name: string; rows: string[]; collapsed: boolean }[] = [
      { name: 'quiet', rows: ['Talk', 'Play', 'Next', 'Menu'], collapsed: true },
      { name: 'compact idle', rows: ['Talk', 'Tour', 'Tours', 'Menu', 'Move'], collapsed: true },
      { name: 'compact tour', rows: ['Talk', 'Tour', 'Back', 'Next', 'Tours', 'Mol*', 'Room on', 'Detail 2', 'Move'], collapsed: true },
      { name: 'expanded grid', rows: ['Close', 'Mol*', 'Slide', 'Above us', 'In reach', 'Spin', 'Fit', 'Reset',
        'Scale −', 'Scale +', 'Cartoon', 'Surface', 'Atoms', 'Chain', 'Element', 'Opaque −', 'Opaque +'], collapsed: false },
    ];
    for (const set of sets) {
      const eyes = await measureEyeFrame(set.rows, set.collapsed);
      expect(eyes.map(eye => eye.eye)).toEqual(['left', 'right']);
      for (const eye of eyes) {
        expect(eye.degrees, `${set.name} in the ${eye.eye} eye`).toBeLessThanOrEqual(EYE_FRAME_LIMIT_DEGREES);
        expect(eye.breaches, `${set.name} in the ${eye.eye} eye`).toBe(false);
      }
      // Both physical eye offsets are measured in the actual reading orientation.
      expect(eyes.every(eye => eye.verticalDegrees <= EYE_FRAME_VERTICAL_LIMIT_DEGREES)).toBe(true);
      if (set.collapsed) {
        expect(eyes.every(eye => eye.headYawDegrees === 0)).toBe(true);
        const forward = await measureEyeFrame(set.rows, true, {}, 'forward');
        expect(forward.every(eye => !eye.breaches), 'complete glass stays inside both forward lenses').toBe(true);
        expect((await measureCentralCone(set.rows, true)).degrees).toBeGreaterThanOrEqual(CENTRAL_CONE_HALF_ANGLE_DEGREES);
      } else expect(eyes.every(eye => eye.headYawDegrees === 0)).toBe(true);
    }
    // And this is what the preferred bearing alone did, which is the bug: the
    // 47 degree ceiling the constants carry is the panel CENTRE, so a panel
    // with any half-width at all put its outboard corner past the lens. The
    // formula is the one `toolbarSeatDegrees` bisects on -- at bearing s and
    // range R the corner is `R sin s + w cos s` aside over `R cos s - w sin s`
    // deep, plus the far eye's half-IPD on the numerator.
    const ceiling = Math.atan2(Math.abs(SPATIAL_TOOLBAR_LAYOUT.rightMeters), SPATIAL_TOOLBAR_LAYOUT.forwardMeters);
    const range = Math.hypot(SPATIAL_TOOLBAR_LAYOUT.forwardMeters, SPATIAL_TOOLBAR_LAYOUT.rightMeters);
    for (const halfWidth of [0.10, 0.16, 0.22]) {
      const cornerDegrees = Math.atan2(
        range * Math.sin(ceiling) + halfWidth * Math.cos(ceiling) + HALF_IPD_METERS,
        range * Math.cos(ceiling) - halfWidth * Math.sin(ceiling)) * 180 / Math.PI;
      expect(cornerDegrees, `a ${halfWidth} m half-panel at the preferred bearing`).toBeGreaterThan(EYE_HALF_FIELD_DEGREES);
      // The solver refuses that bearing and returns one whose corner fits.
      const solved = toolbarSeatDegrees(halfWidth, range, ceiling * 180 / Math.PI);
      expect(solved, `solved seat for a ${halfWidth} m half-panel`).toBeLessThan(ceiling * 180 / Math.PI);
    }
  }, 120_000);

  it('fails when a row loses its leading glyph', async () => {
    await withFixture(async (directory, steps) => {
      // A shipped compact row must retain its leading glyph in the captured reading glance.
      const row = 'Reset';
      await breakLeadingGlyph(directory, steps[0].file, steps[0].rows, steps[0].collapsed, row, {}, 0);
      const result = await runXrGate(directory);
      const found = reasons(result.failures, 'label-completeness');
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain(row);
      expect(found.join(' ')).toContain('missing its leading glyph');
      const measured = (result.measurements.labels as { row: string; lineIndex: number; startDriftGlyphs: number }[])
        .filter(line => line.row === row);
      expect(measured).toHaveLength(1);
      expect(measured[0].startDriftGlyphs).toBeGreaterThan(1);
    });
  }, 120_000);

  it('fails a label that needs more plate than its row has, and passes the shipped font', async () => {
    const rows = ['Start tour', 'Tour menu', 'Move menu', 'Open in Mol*'];
    const shipped = await measureLabelMargins(rows, true);
    expect(shipped.filter(margin => margin.fails)).toEqual([]);
    // A 44% larger font overruns the column-width clamp, which is
    // rule 2 measured from geometry rather than from ink.
    const wide = await measureLabelMargins(rows, true, {
      toolbarConstants: { fontMeters: SPATIAL_TOOLBAR_LAYOUT.fontMeters * 1.44 },
    });
    expect(wide.filter(margin => margin.fails).map(margin => margin.row)).toEqual(rows);
    expect(wide.find(margin => margin.row === 'Move menu')?.fails).toBe(true);
    expect(Math.min(...wide.map(margin => margin.marginMeters))).toBeLessThan(0);
  }, 60_000);

  it('warns on rows whose glyph run sits on the plate rim', async () => {
    const rows = ['Fit', 'Tour menu', 'Open in Mol*', 'Within reach'];
    // The shipped rows clear their rim. A rim 2.6 times as wide puts the
    // longest rows on the bevel without overrunning their plates, which is
    // the state this warning is for at either reading range.
    const shipped = await measureLabelMargins(rows, true);
    expect(shipped.filter(margin => margin.fails || margin.tight)).toEqual([]);
    const wideRim = await measureLabelMargins(rows, true, {
      toolbarConstants: { plateBorderMeters: SPATIAL_TOOLBAR_LAYOUT.plateBorderMeters * 2.6 },
    });
    const tight = wideRim.filter(margin => margin.tight).map(margin => margin.row);
    expect(tight).toContain('Open in Mol*');
    expect(tight).toContain('Within reach');
    expect(wideRim.find(margin => margin.row === 'Fit')?.tight).toBe(false);
    expect(wideRim.filter(margin => margin.fails)).toEqual([]);
  }, 60_000);

  it('fails a press that changes nothing a wearer can see, naming the row', async () => {
    await withFixture(async (directory, steps) => {
      await breakActionVisibility(directory, steps[1].file, steps[2].file);
      const result = await runXrGate(directory);
      const found = reasons(result.failures, 'action-visibility');
      expect(found.length).toBeGreaterThan(0);
      expect(found.join(' ')).toContain('changed nothing a wearer can see');
      expect(found.join(' ')).toContain(steps[2].file);
    });
  }, 120_000);

  it('warns, and does not fail, on a frame rate under the tier target', async () => {
    await withFixture(async directory => {
      await breakFrameBudget(directory, 31.2);
      const result = await runXrGate(directory);
      expect(result.failures).toEqual([]);
      const warned = reasons(result.warnings, 'frame-budget');
      expect(warned.join(' ')).toContain('31.2');
      expect(warned.join(' ')).toContain(String(TARGET_FRAME_RATE));
    });
  }, 120_000);

  it('rejects failed acceptance even when its partial frames pass visual checks', async () => {
    await withFixture(async directory => {
      const { writeFile } = await import('node:fs/promises');
      const path = resolve(directory, 'browser-report.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      report.status = 'failed';
      await writeFile(path, JSON.stringify(report));
      const result = await runXrGate(directory);
      expect(reasons(result.failures, 'artifacts').join(' ')).toContain('partial frames cannot certify');
      expect(reasons(result.failures, 'central-cone')).toEqual([]);
    });
  }, 120_000);

  it('refuses an artifact set with no both-eye XR capture at all', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'stereofold-xr-gate-empty-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(resolve(directory, 'browser-report.json'), JSON.stringify({
        status: 'failed', screenshots: [], emulatedXr: { toolbarTargets: [] },
      }));
      const result = await runXrGate(directory);
      expect(reasons(result.failures, 'artifacts').join(' ')).toContain('never rendered the headset view');
      expect((await stat(result.contactSheet)).size).toBeGreaterThan(100);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);
});
