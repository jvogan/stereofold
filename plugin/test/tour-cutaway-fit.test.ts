import { expect, it } from 'vitest';
import { applyTourStep } from '../src/tour-player.js';
// @ts-ignore Render geometry fitter shared with the headset.
import { resetViewPlacement } from '../../lab/browser-roundtrip/reset-view-placement.mjs';
// @ts-ignore Synthetic stereo projections exercise the real clip-plane solve.
import { identity, syntheticViews } from '../../lab/browser-roundtrip/fixtures/component-label-diagnostics.mjs';

it('removes a prior cutaway before fitting the overview into both eyes', async () => {
  let clipping = 25, placed: any;
  const views = () => syntheticViews().map((v: any) => {
    if (clipping) { const n = 5, f = 50; v.projectionMatrix[10] = -(f+n)/(f-n); v.projectionMatrix[14] = -2*f*n/(f-n); }
    return v;
  });
  const workspace: any = { snapshot: () => ({ ready: true, xrPresenting: true, inspection: { appearance: { clipping } } }), rows: () => [],
    viewer: { inspection: { configure: async (patch: any) => { clipping = patch.clipping ?? clipping; },
      place: async (patch: any) => { placed = resetViewPlacement({ seat: { translation: [0,0,-3], rotation: [0,0,0], ...patch },
        fit: true, recoverVisible: true, headInRoom: identity(), renderFromRoom: identity(), cameraScale: 1,
        center: [0,0,0], radius: 1, points: [], renderedGeometry: { subject: [{ center: [0,0,-3], radius: .5 }], views: views(), renderFromRoom: identity() } }); },
      setMotion: async () => {}, emphasize: async () => {} } } };
  await applyTourStep(workspace, { id: 'wide', title: 'Wide', placement: { scale: 1 }, appearance: { clipping: 0 } }, () => true, false);
  expect(placed.translation[2]).toBeLessThan(0);
  expect(placed.scale).toBeGreaterThanOrEqual(.01);
  expect(clipping).toBe(0);
});
