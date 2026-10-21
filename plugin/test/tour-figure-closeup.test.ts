import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif.js';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { applyTourStep } from '../src/tour-player.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Production source identity extractor.
import extraction from '../../lab/identity/extract.cjs';
// @ts-ignore CPU harness executes the production viewer's emphasis and focus closures.
import { tourFocusHarness } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';
// @ts-ignore Production viewer closure extraction.
import { pageFunction } from '../../lab/browser-roundtrip/fixtures/label-action-harness.mjs';
// @ts-ignore Production catalog to Mol* selection binding.
import { createSelectionAdapter } from '../../lab/browser-roundtrip/selection.mjs';
// @ts-ignore Production figure target resolution.
import { resolveFigureLoci, figureTargetMatchesRow } from '../../lab/browser-roundtrip/lesson-figure.mjs';
// @ts-ignore Same conservative plate projection as motion-label-layout.
import { drawnPlateRects, PLATE_FIELD } from '../../lab/browser-roundtrip/label-layout.mjs';
// @ts-ignore Production physical annotation scale.
import { FIGURE_REFERENCE_SCALE } from '../../lab/browser-roundtrip/immersive-annotations.mjs';

it.skipIf(!process.env.STEREOFOLD_DEMO_CACHE)('CRISPR ch5/ch9 preserve their authored pre-figure framing and fit the HNH plate in both eyes', async () => {
  const lesson = JSON.parse(readFileSync(new URL('../demos/crispr-cas9.json', import.meta.url), 'utf8'));
  const bytes = readFileSync(`${process.env.STEREOFOLD_DEMO_CACHE}/9KJ6.cif`);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(lesson.provenance.sourceSha256);
  const parsed = await CIF.parse(bytes.toString()).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const data = Structure.ofModel(trajectory.representative), sphere = data.boundary.sphere;
  const selection = createSelectionAdapter(data, await extraction.extractBytes(bytes, { sourceLabel: '9KJ6' }));
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const steps = molecularLessonToTour(lesson).steps.filter(s => ['nucleases', 'recap-nucleases'].includes(s.id));
  expect(steps).toHaveLength(2);
  for (const step of steps) for (const restored of [false, true]) {
    const { h, workspace, records } = tourFocusHarness();
    let figure: unknown;
    Object.assign(h, {
      structure: { obj: { data } }, selection, spokenSelectionCache: undefined, StructureElement, figureTargetMatchesRow,
      recordBoundingSphere: () => sphere, loadedSphere: () => sphere, pivotCenter: () => sphere.center,
      pivotBounds: () => ({ baseCenter: sphere.center, visibleCenter: sphere.center, radius: sphere.radius }),
      molecularAnimation: { ...h.molecularAnimation, poseSample: () => undefined, selectionSphere: (loci: any) => StructureElement.Loci.getBoundingSphere(loci) },
      // Adapt figure drawing only; use the real figure installer/framing closure below.
      lessonFigure: { install: async (value: unknown) => { figure = value; }, snapshot: () => figure, annotations: () => [], placement: () => [] },
    });
    h.canvas.camera.scale = .9 / sphere.radius;
    for (const name of ['spokenSelectionKeys', 'setLessonFigure']) vm.runInContext(pageFunction(viewer, name), h);
    Object.assign(workspace.viewer.inspection, { setLessonFigure: h.setLessonFigure,
      place: async (patch: unknown) => h.inspectionState.place(patch) });
    workspace.rows = () => selection.rows;
    // The original chapter, before figure annotations were added, is the reference seat.
    await applyTourStep(workspace, { ...step, figure: undefined }, () => true, false);
    const original = structuredClone(h.inspectionSnapshot().placement);
    figure = step.figure; // Cached/previous figure must not enlarge the new focus frame.
    await applyTourStep(workspace, step, () => true, false, 1000, undefined, undefined, false, restored);
    const placement = h.inspectionSnapshot().placement;
    expect(placement.scale).toBeCloseTo(original.scale, 8);
    placement.translation.forEach((v: number, i: number) => expect(v).toBeCloseTo(original.translation[i], 8));
    expect(figure).toEqual(step.figure);
    const room = (point: Vec3) => Vec3.scale(Vec3(), Vec3.transformMat4(Vec3(), point, h.placementTransform(placement)), h.canvas.camera.scale);
    const head = h.latestRoomPlacementPose.headInRoom.slice(12, 15);
    const distance = Vec3.distance(room(sphere.center), head);
    // Chapter 5 authors a fill close-up; the recap authors a context view.
    // Figure annotations must preserve each seat, including the wider recap.
    expect(records.filter((record: any) => record.kind === 'xr-focus').at(-1).framing).toBe(step.emphasis!.framing);
    const [near, far] = step.emphasis!.framing === 'context' ? [2.5, 2.7] : [.9, 1.2];
    expect(distance).toBeGreaterThan(near); expect(distance).toBeLessThan(far);
    for (const label of step.figure!.labels) for (const eyeX of [-.032, .032]) {
      const anchor = room(StructureElement.Loci.getBoundingSphere(resolveFigureLoci(label.target, data))!.center);
      const [plate] = drawnPlateRects({ plates: [{ ...label, anchor }],
        placements: [{ ...label, offsetX: label.offsetX * FIGURE_REFERENCE_SCALE, offsetY: label.offsetY * FIGURE_REFERENCE_SCALE }],
        characterUnits: .8 * 6 * label.sizeFactor * FIGURE_REFERENCE_SCALE, backgroundMargin: .25,
        maxWidthEm: Infinity, standoff: 3 * FIGURE_REFERENCE_SCALE,
        eye: [head[0] + eyeX, head[1], head[2]], target: [head[0] + eyeX, head[1], head[2] - 1] });
      expect(Math.abs(plate.rect.x) + plate.rect.halfWidth).toBeLessThan(PLATE_FIELD.halfWidth);
      expect(Math.abs(plate.rect.y) + plate.rect.halfHeight).toBeLessThan(PLATE_FIELD.halfHeight);
    }
    console.log(`${step.id}, cached=${restored}: molecule center ${distance.toFixed(6)} m`);
  }
});
