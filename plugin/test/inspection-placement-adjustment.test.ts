import { describe, expect, it } from 'vitest';
import { matchesInspectionChange, type InspectionScene } from '../src/inspection-contract.js';

const expected = {
  sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: [],
  camera: { mode: 'perspective', fov: 1, position: [0, 0, 8], target: [0, 0, 0], up: [0, 1, 0],
    radius: 1, radiusMax: 1, fog: 0, clipFar: true, minNear: 0, minFar: 0 },
  inspection: { appearance: {}, placement: { translation: [-1, 0, 0], rotation: [0, 0, 0], scale: 2 } },
} as unknown as InspectionScene;
const evidence = { metersPerRadius: 1, centerMeters: [0, 0, -4] as [number, number, number],
  headFromScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
const change = { kind: 'placement' as const, patch: { translation: [-1, 0, 0] as [number, number, number], scale: 2 } };
const drawn = (scale: number, translation: [number, number, number]) => {
  const scene = structuredClone(expected);
  scene.inspection.placement.scale = scale;
  scene.inspection.placement.translation = translation;
  return scene;
};

describe('a lesson that keeps the placement, when the wearer moves the structure while it draws', () => {
  const lessonChange = { kind: 'lesson', patch: { frame: false, lesson: { id: 'walk', chapters: [{ id: 'one' }] } } } as any;
  const shown = (scale: number, selectionKeys: string[] = []) => {
    const scene = drawn(scale, [-1, 0, 0]) as any;
    scene.selectionKeys = selectionKeys;
    scene.inspection.lessonPlayback = { tourId: 'lesson-walk', chapterId: 'one', stopped: false };
    return scene as InspectionScene;
  };
  it('confirms the lesson at the placement the wearer chose, and only for a placement', () => {
    expect(matchesInspectionChange(shown(2), expected, lessonChange)).toBe(true);
    // The wearer resized it to 1.4 during the draw.
    expect(matchesInspectionChange(shown(1.4), expected, lessonChange)).toBe(false);
    expect(matchesInspectionChange(shown(1.4), expected, lessonChange, undefined, false, undefined, true)).toBe(true);
    // The flag never covers a scientific difference the matcher checks.
    expect(matchesInspectionChange(shown(1.4, ['A:1']), expected, lessonChange, undefined, false, undefined, true)).toBe(false);
  });
});

describe('stereo placement adjustment receipt', () => {
  it('accepts a bounded move and shrink, including one caused by appearance geometry', () => {
    expect(matchesInspectionChange(drawn(1.5, [1, 0, 0]), expected, change, undefined, true, evidence)).toBe(true);
    const appearance = { kind: 'appearance' as const, patch: { opacity: .5 } };
    expect(matchesInspectionChange(drawn(1.5, [1, 0, 0]), expected, appearance, undefined, true, evidence)).toBe(true);
    const styles = { kind: 'styles' as const, patch: { styles: [] } };
    expect(matchesInspectionChange(drawn(1.5, [1, 0, 0]), expected, styles, undefined, true, evidence)).toBe(true);
  });

  it('rejects a forged far seat, excessive shrink, larger scale and rotation', () => {
    for (const scene of [drawn(1.5, [10.0001, 0, 0]), drawn(1e-7, [1, 0, 0]),
      drawn(2.1, [1, 0, 0])]) {
      expect(matchesInspectionChange(scene, expected, change, undefined, true, evidence)).toBe(false);
    }
    const rotated = drawn(1.5, [1, 0, 0]);
    rotated.inspection.placement.rotation = [0, 45, 0];
    expect(matchesInspectionChange(rotated, expected, change, undefined, true, evidence)).toBe(false);
  });

  it('admits the fitter limits, including a quarter-scale repair from scale four', () => {
    const request = drawn(4, [-10, 0, 0]);
    const changeAtFour = { kind: 'placement' as const,
      patch: { translation: [-10, 0, 0] as [number, number, number], scale: 4 } };
    expect(matchesInspectionChange(drawn(.25, [-6, 0, 0]), request, changeAtFour, undefined, true, { ...evidence, centerMeters: [6, 0, -4] })).toBe(true);
    expect(matchesInspectionChange(drawn(.25, [10, 0, 0]), request, changeAtFour, undefined, true, evidence)).toBe(false);
    expect(matchesInspectionChange(drawn(.2499, [10, 0, 0]), request, changeAtFour, undefined, true, evidence)).toBe(false);
    expect(matchesInspectionChange(drawn(.25, [10.0001, 0, 0]), request, changeAtFour, undefined, true, evidence)).toBe(false);
  });
});

it('accepts the real scale-one undo travel and rejects missing or non-rigid evidence', () => {
  const request = drawn(1, [0, 0, 0]);
  const actual = drawn(1, [.481, 0, -4]);
  const proof = { ...evidence, centerMeters: [0, 0, 0] as [number, number, number] };
  expect(matchesInspectionChange(actual, request, change, undefined, true, proof)).toBe(true);
  expect(matchesInspectionChange(actual, request, change, undefined, true)).toBe(false);
  expect(matchesInspectionChange(actual, request, change, undefined, true,
    { ...proof, headFromScene: proof.headFromScene.map((v, i) => i === 0 ? .01 : v) })).toBe(false);
});

it.each([.5, 1, 2])('converts metre limits at %s metres per molecular radius', unit => {
  const request = drawn(1, [0, 0, 0]);
  const actual = drawn(.25, [.481 / unit, 0, -4 / unit]);
  expect(matchesInspectionChange(actual, request, change, undefined, true,
    { ...evidence, metersPerRadius: unit, centerMeters: [0, 0, 0] })).toBe(true);
});

it('documents that evidence is an attestation, not a defence against a lying page', () => {
  const request = drawn(4, [-10, 0, 0]);
  const actual = drawn(.25, [10, 0, 0]);
  expect(matchesInspectionChange(actual, request, change, undefined, true, evidence)).toBe(false);
  // Forging the origin can make the same jump look head-centred. The host has
  // no independent measurement with which to disprove this page's assertion.
  expect(matchesInspectionChange(actual, request, change, undefined, true,
    { ...evidence, centerMeters: [-10, 0, -4] })).toBe(true);
});

// @ts-ignore Real public-coordinate geometry and production page fitting.
import { questTourFit } from '../../lab/browser-roundtrip/fixtures/quest-tour-fit.mjs';
import { MOLECULAR_EXPERIENCES } from '../src/molecular-experience.js';

it('accepts every 4HHB tour page receipt with a non-axis-aligned tracked basis', async () => {
  const h = await questTourFit('4HHB');
  try {
    const tour = MOLECULAR_EXPERIENCES.find(t => t.id === 'hemoglobin-quaternary-structure')!;
    let first: any;
    for (const chapter of tour.steps) {
      const { requested, actual, evidence: proof } = await h.step(chapter);
      expect(proof.headFromScene[15]).not.toBe(1); // ordinary inverse/multiply roundoff
      const request = drawn(requested.scale, requested.translation);
      request.inspection.placement = requested;
      const scene = drawn(actual.scale, actual.translation);
      scene.inspection.placement = actual;
      expect(matchesInspectionChange(scene, request, { kind: 'appearance', patch: { opacity: .5 } }, undefined, true, proof)).toBe(true);
      first ??= { proof, scene, request };
    }
    const { proof, scene, request } = first;
    const projective = { ...proof, headFromScene: [...proof.headFromScene] };
    projective.headFromScene[15] = 1.01;
    expect(matchesInspectionChange(scene, request, change, undefined, true, projective)).toBe(false);
    projective.headFromScene[15] = 1;
    projective.headFromScene[3] = .01;
    expect(matchesInspectionChange(scene, request, change, undefined, true, projective)).toBe(false);
  } finally { h.dispose(); }
});

it('accepts numerically valid repairs beyond the old placement range with the same physical evidence', () => {
  const request = drawn(12, [20, 0, 0]);
  const actual = drawn(8, [18, 0, 0]);
  expect(matchesInspectionChange(actual, request, {kind:'placement',patch:{scale:12}}, undefined, true,
    {...evidence, metersPerRadius:.01, centerMeters:[-.18,0,-2]})).toBe(true);
  const small = drawn(.01, [20,0,0]);
  expect(matchesInspectionChange(small, request, {kind:'placement',patch:{scale:12}}, undefined, true,
    {...evidence, metersPerRadius:.01, centerMeters:[-.2,0,-2]})).toBe(true);
});
