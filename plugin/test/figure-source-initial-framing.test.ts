import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function setLessonFigure('), end = source.indexOf('\n  }', start) + 4;
const setter = source.slice(start, end);

for (const xr of [false, true]) for (const saved of [false, true])
it(`frames a composite's initial visible subject once, preserving subsequent figures and wearer input (XR=${xr}, saved=${saved})`, async () => {
  const frames: any[] = [], figures: any[] = [];
  let held = false;
  const target = { center: [1, 2, 3], radius: 12 };
  const context = vm.createContext({
    initialFigureFrame: { target, fitted: { desktop: saved, xr: saved } },
    canvas: { xr: { isPresenting: { value: xr } } },
    assertReady() {}, now: () => 0, recordCost() {}, state: { sourceSha256: 'private' }, snapshot: () => ({}),
    inspectionMutation: (action: () => Promise<unknown>) => action(),
    molecularAnimation: { poseSample: () => undefined },
    lessonFigure: { install: async (value: any) => { figures.push(value); }, snapshot: () => ({}) },
    applyInspectionTransform() {}, wearerPlacement: { holdsPlacement: () => held },
    focusSelection: async (options: any) => { frames.push(options); }, select: async () => {},
  });
  vm.runInContext(setter, context);
  const figure = { layers: [], labels: [], distances: [] };
  await context.setLessonFigure(figure, { frame: true });
  expect(frames).toHaveLength(saved ? 0 : 1);
  if (!saved) expect(frames[0].motionFrame.target).toEqual(target);
  // Normal next/Back/reinstall calls do not refit, even with no user hold.
  await context.setLessonFigure(figure, { frame: true });
  held = true;
  await context.setLessonFigure(figure, { frame: true });
  held = false;
  await context.setLessonFigure(figure, { frame: true });
  expect(frames).toHaveLength(saved ? 0 : 1);
  expect(figures).toHaveLength(4);
});
