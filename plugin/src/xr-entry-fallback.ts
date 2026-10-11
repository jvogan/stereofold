/**
 * The one retry the Enter VR button owes a Quest that changed its mind.
 *
 * `navigator.xr.isSessionSupported('immersive-ar')` answering true is not a
 * promise that the AR request will be granted: a Quest browser holding an
 * unanswered mixed-reality permission rejects `requestSession('immersive-ar')`
 * while still reporting support. The wearer then sees an error on the 2D page
 * and has to press Enter again, which is the manual re-entry the passthrough
 * remap existed to remove.
 *
 * The retry has to happen here, inside the click handler's own promise chain,
 * because `requestSession` requires a transient user activation and the button
 * press is the only one there is.
 */
export const XR_AR_FALLBACK_MODE = 'immersive-vr';

/**
 * @param enter the viewer's session request, one mode per call
 * @param mode the mode the button asked for
 * @param onFallback told once, before the second request, so the page can say
 *   what it is doing rather than sitting on "Entering headset view…"
 */
export async function enterImmersiveWithFallback(
  enter: (mode: string) => Promise<unknown>,
  mode: string,
  onFallback: (error: Error) => void = () => {},
): Promise<unknown> {
  try {
    return await enter(mode);
  } catch (error) {
    if (mode !== 'immersive-ar') throw error;
    try { onFallback(error as Error); } catch { /* A note that fails must not cost the retry. */ }
    return await enter(XR_AR_FALLBACK_MODE);
  }
}
