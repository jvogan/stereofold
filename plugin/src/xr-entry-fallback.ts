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
 * How long one press waits for a scene that is still changing.
 *
 * The viewer refuses entry while a load, a replacement or a chapter turn is in
 * flight, before it asks the browser for anything. The press can wait that
 * out, but a browser honours `requestSession` only while the press's transient
 * activation lasts: five seconds in Chromium, which Quest Browser is built on.
 * The wait is counted from that refusal, which comes in the same task as the
 * press, and stops a second short of the window, so a frame held back by a
 * long load step still asks inside it. Where the browser says whether the
 * activation still holds, that is read again before asking.
 */
export const XR_READY_WAIT_MS = 4000;

/** What a press that outlasted the wait tells the wearer. Nothing is broken. */
export const XR_SCENE_CHANGING_COPY = 'The scene is still changing. Press again.';

/** The viewer's own readiness, and what the wait reads from the page. */
export type SceneReadiness = {
  ready: () => boolean;
  /** Whether the press still counts; undefined where the browser does not say. */
  activationActive?: () => boolean | undefined;
  /** Asks for one frame; may return a way to cancel the ask. */
  nextFrame?: (callback: () => void) => (() => void) | void;
  now?: () => number;
};

/** Whether the viewer refused only because its scene was changing (`immersive-session.mjs`). */
function sceneNotReady(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { notReady?: unknown }).notReady === true;
}

// One request per mode, as before, except that a refusal marked not ready is
// waited out, once a frame, until the scene is ready or the wait is over.
// A ready scene is asked at once: nothing is read or awaited before `enter`.
// A hidden page gets no frames, so a timer set for what is left of the wait
// also ends each step; whichever comes first cancels the other.
function waitingForScene(enter: (mode: string) => Promise<unknown>, scene: SceneReadiness) {
  const nextFrame = scene.nextFrame ?? ((callback: () => void) => {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const frame = globalThis.requestAnimationFrame(() => callback());
      return () => globalThis.cancelAnimationFrame?.(frame);
    }
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  });
  const now = scene.now ?? (() => globalThis.performance.now());
  const activationActive = scene.activationActive
    ?? (() => (globalThis.navigator as { userActivation?: { isActive?: boolean } } | undefined)?.userActivation?.isActive);
  let deadline: number | undefined;
  return async (mode: string): Promise<unknown> => {
    for (;;) {
      try {
        return await enter(mode);
      } catch (error) {
        if (!sceneNotReady(error)) throw error;
        deadline ??= now() + XR_READY_WAIT_MS;
        do {
          const end = deadline;
          await new Promise<void>(resolve => {
            let cancelFrame: (() => void) | void = undefined;
            const timer = setTimeout(() => { cancelFrame?.(); resolve(); }, Math.max(0, end - now()));
            cancelFrame = nextFrame(() => { clearTimeout(timer); resolve(); });
          });
          if (now() >= deadline || activationActive() === false) throw error;
        } while (!scene.ready());
      }
    }
  };
}

/**
 * @param enter the viewer's session request, one mode per call
 * @param mode the mode the button asked for
 * @param onFallback told once, before the second request, so the page can say
 *   what it is doing rather than sitting on "Entering headset view…"
 * @param scene when given, a refusal made because the scene is changing is
 *   waited out within this press instead of ending it
 */
export async function enterImmersiveWithFallback(
  enter: (mode: string) => Promise<unknown>,
  mode: string,
  onFallback: (error: Error) => void = () => {},
  scene?: SceneReadiness,
): Promise<unknown> {
  const request = scene ? waitingForScene(enter, scene) : enter;
  try {
    return await request(mode);
  } catch (error) {
    // A scene still changing is not a refusal of passthrough.
    if (mode !== 'immersive-ar' || sceneNotReady(error)) throw error;
    try { onFallback(error as Error); } catch { /* A note that fails must not cost the retry. */ }
    return await request(XR_AR_FALLBACK_MODE);
  }
}
