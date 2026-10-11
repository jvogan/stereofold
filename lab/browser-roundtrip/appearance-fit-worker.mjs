import { resetEntryGeometry } from './reset-entry-geometry.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';

// One extraction, one solve. No Mol* objects or WebXR handles cross this boundary.
export function solveAppearanceFit(options) {
  const { geometry, ...fit } = options;
  const renderedGeometry = resetEntryGeometry({ ...geometry, cameraScale: fit.cameraScale, renderFromRoom: fit.renderFromRoom });
  if (!renderedGeometry && geometry.objects.length) throw Error('Cannot change the appearance until its new geometry is measurable in both eyes. Try again in a moment.');
  try { return resetViewPlacement({ ...fit, renderedGeometry }); }
  catch (error) {
    // An intentional room pose belongs to the wearer or lesson. Try the
    // toolbar's complete, visible candidate glass without moving that pose.
    // Geometry is extracted once, including every vertex and both eyes.
    if (error.code !== 'MENU_OVERLAP' || !fit.allowOffscreen) throw error;
    for (const candidate of fit.menuCandidates ?? []) {
      try {
        const seat = resetViewPlacement({ ...fit, points: candidate.points,
          renderedGeometry: candidate.views ? { ...renderedGeometry, views: candidate.views } : renderedGeometry });
        return { ...seat, menuRelocation: candidate.id };
      } catch (candidateError) {
        if (candidateError.code !== 'MENU_OVERLAP') throw candidateError;
      }
    }
    throw error;
  }
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  self.onmessage = ({ data }) => {
    try { self.postMessage({ fitted: solveAppearanceFit(data) }); }
    catch (error) { self.postMessage({ error: error.message }); }
  };
}
