import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
const { mountTourPlayer } = await import(process.env.CHAPTER_RETURN_PLAYER ?? '../src/tour-player.js');
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Shared renderer harnesses adapt DOM/GPU and persistence only.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';
// @ts-ignore Executes the production XR focus/placement closures.
import { tourFocusHarness } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';
// @ts-ignore Real Mol* structure, body representations and animation registry.
import { molecularAnimationHarness } from '../../lab/browser-roundtrip/fixtures/molecular-animation-harness.mjs';
// @ts-ignore Shared viewer function extraction.
import { pageFunction } from '../../lab/browser-roundtrip/fixtures/label-action-harness.mjs';
// @ts-ignore Production motion fit and pose evaluator.
import { motionFocusPlacement } from '../../lab/browser-roundtrip/motion-framing.mjs';
// @ts-ignore Production track selection.
import { selectAnimationTrack } from '../../lab/browser-roundtrip/animation-selection.mjs';
// @ts-ignore Production keyframe evaluator.
import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
// @ts-ignore Production pose matrices and sphere transforms.
import { poseMatrix, transformSphere } from '../../lab/browser-roundtrip/molecular-animation.mjs';
// @ts-ignore Same eye field used by the layout tests.
import { EYE_TAN_HALF_HORIZONTAL, EYE_TAN_HALF_VERTICAL } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';

const viewer = readFileSync(process.env.CHAPTER_RETURN_VIEWER ?? new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/hemoglobin-chapter-return.json', import.meta.url), 'utf8'));

it.each(['context', 'fill'] as const)('authored %s framing keeps both offset hemoglobin bodies in both eyes on chapter returns', async framing => {
  const cleanup: (() => void)[] = [];
  const animation = await molecularAnimationHarness({ after: (fn: () => void) => cleanup.push(fn) }, {
    structureText: readFileSync(new URL('./fixtures/hemoglobin-chapter-return.cif', import.meta.url), 'utf8'),
    schedule: () => 0, cancel() {},
  });
  const end = tourEndHarness();
  const { h, hold, records } = tourFocusHarness();
  const data = animation.structure.obj.data, sphere = data.boundary.sphere;
  const lesson = structuredClone(fixture);
  for (const chapter of lesson.chapters) chapter.immersive.emphasis.framing = framing;
  const tour = molecularLessonToTour(lesson);
  let figure: unknown;
  // Keep the production focus, animated installer, envelope, placement hold and
  // player. The draw/save boundary and colour/figure painting have no GPU here.
  Object.assign(h, {
    structure: animation.structure, molecularAnimation: animation.registry, motionFocusPlacement,
    recordBoundingSphere: () => sphere, loadedSphere: () => sphere,
    pivotBounds: () => ({ baseCenter: sphere.center, visibleCenter: sphere.center, radius: sphere.radius }),
    lessonFigure: { definition: () => figure },
    currentEmphasisPlan: () => ({ lit: ['all'] }),
    selection: { rows: [], toLoci: () => StructureElement.Loci.all(data) },
    immersiveSession: undefined,
  });
  h.canvas.camera.scale = .003;
  vm.runInContext(pageFunction(viewer, 'installMolecularChapter'), h);
  const contextStart = viewer.indexOf('    animationFramingContext(');
  const animationFramingContext = vm.runInContext('({' + viewer.slice(contextStart,
    viewer.indexOf('    setMolecularAnimation:', contextStart)) + '}).animationFramingContext', h);
  const originalSnapshot = end.workspace.snapshot;
  end.workspace.snapshot = () => ({ ...originalSnapshot(), inspection: h.inspectionSnapshot() });
  end.workspace.capture = () => ({ ...end.capture(), placement: structuredClone(h.inspectionSnapshot().placement) });
  Object.assign(end.workspace.viewer.inspection, {
    animationFramingContext,
    holdsWearerPlacement: () => hold.holdsPlacement(),
    setMolecularAnimation: h.installMolecularChapter,
    controlMolecularAnimation: (patch: unknown) => animation.registry.control(patch),
    restore: async (saved: any, options: any) => {
      if (!options?.preservePlacement) h.inspectionState.place(saved.placement);
    },
    emphasize: async (value: any) => {
      h.emphasisState = value; h.emphasisOrigin = 'lesson';
      if (value.framing && !hold.holdsPlacement())
        await h.focusSelection({ wholeStructure: true, framing: value.framing, liftEmphasis: false, durationMs: 0 });
    },
    setLessonFigure: async (value: unknown, options: any) => {
      figure = value;
      if (value && options?.frame && !hold.holdsPlacement())
        await h.focusSelection({ wholeStructure: true, framing: 'fill', liftEmphasis: false, durationMs: 0 });
    },
  });
  const player = mountTourPlayer({ ...end, tours: [tour] });
  const results: { action: string; scale: number; horizontal: number; vertical: number }[] = [];
  const check = (action: string) => {
    const placement = h.inspectionSnapshot().placement;
    const transform = h.placementTransform(placement);
    const headFromRoom = Mat4.invert(Mat4(), h.latestRoomPlacementPose.headInRoom);
    let horizontal = 0, vertical = 0;
    const definition = tour.steps[0].animation!;
    const envelope = animation.registry.framingEnvelope();
    for (const track of definition.tracks) {
      const body = StructureElement.Loci.getBoundingSphere(selectAnimationTrack(data, track))!;
      for (const t of [0, 7, 14]) {
        const posed = transformSphere(body, poseMatrix(evaluateTrack(track, t)));
        expect(Vec3.distance(posed.center, envelope.center) + posed.radius).toBeLessThanOrEqual(envelope.radius + 1e-6);
        const room = Vec3.scale(Vec3(), Vec3.transformMat4(Vec3(), posed.center, transform), h.canvas.camera.scale);
        const head = Vec3.transformMat4(Vec3(), room, headFromRoom);
        const radius = posed.radius * placement.scale * h.canvas.camera.scale;
        const near = -head[2] - radius;
        expect(near, `${action}: body stays in front`).toBeGreaterThan(0);
        for (const eye of [-.032, .032]) horizontal = Math.max(horizontal,
          (Math.abs(head[0] - eye) + radius) / near / EYE_TAN_HALF_HORIZONTAL);
        vertical = Math.max(vertical, (Math.abs(head[1]) + radius) / near / EYE_TAN_HALF_VERTICAL);
      }
    }
    results.push({ action, scale: placement.scale, horizontal, vertical });
    expect(horizontal, `${action}: both complete bodies inside both eye fields`).toBeLessThan(1);
    expect(vertical, `${action}: both complete bodies inside vertical field`).toBeLessThan(1);
    const first = results[0].scale;
    expect(placement.scale, `${action}: chapter returns keep the same scale`).toBeCloseTo(first, 6);
  };
  try {
    await player.installLesson(tour, { chapterId: tour.steps[0].id, autoplay: false, narration: false }, undefined, true);
    check('first install');
    await player.start(false, 0, { narration: false }); check('start');
    await player.next();
    expect(player.getState().step).toBe(1);
    await player.back(); check('back');
    await player.start(false, 0, { narration: false }); check('restart');
    for (const seekSeconds of [0, 7, 14]) {
      const placement = structuredClone(h.inspectionSnapshot().placement);
      animation.registry.control({ seekSeconds, state: 'pause' });
      check(`seek ${seekSeconds}`);
      expect(h.inspectionSnapshot().placement).toEqual(placement);
    }
    // A hand that takes placement during the animation install outranks its fit.
    const install = animation.registry.install;
    animation.registry.install = async (...args: any[]) => {
      const result = await install(...args); hold.takeover('grab'); return result;
    };
    const placement = structuredClone(h.inspectionSnapshot().placement);
    const count = records.filter((r: any) => r.kind === 'animation-framing').length;
    await h.installMolecularChapter(tour.steps[0].animation, tour.steps[0].id, { framing });
    expect(h.inspectionSnapshot().placement).toEqual(placement);
    expect(records.filter((r: any) => r.kind === 'animation-framing')).toHaveLength(count);
  } finally {
    console.log(JSON.stringify({ framing, results }));
    player.pause(); end.cleanup();
    for (const dispose of cleanup.reverse()) dispose();
  }
}, 30000);
