import { sameControllerPlacement } from './xr-controller-acceptance.js';

type SavedEntry = {
  serverEpoch: string;
  sourceToken: string;
  stateRevision: number;
  inspectionRevision: number;
  scene: { inspection: { placement: unknown } };
};
type EntryState = Omit<SavedEntry, 'scene'> & {
  panels: { panelId: string; surface: string; current: boolean; availability: string;
    xrStartup?: { presenting?: boolean; stale?: boolean; sessionVisibility?: string } | null }[];
};

/** Entry seating renders before its debounced save. Accept a saved baseline only
 * when a ready wearer acknowledges that revision and live placement stays equal
 * across both host reads. This never changes the scene or derives a baseline
 * from the lesson player's own restore target. */
export async function waitForSavedXrEntry<T extends SavedEntry>({ readLivePlacement, readSaved, readState, panelId,
  timeoutMs = 120_000, now = Date.now, pause = () => new Promise<void>(resolve => setTimeout(resolve, 100)) }: {
  readLivePlacement: () => Promise<unknown>;
  readSaved: () => Promise<T>;
  readState: () => Promise<EntryState>;
  panelId: string;
  timeoutMs?: number;
  now?: () => number;
  pause?: () => Promise<void>;
}): Promise<{ saved: T; livePlacement: unknown }> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const before = await readLivePlacement();
    const saved = await readSaved();
    const state = await readState();
    const after = await readLivePlacement();
    const sameBinding = (['serverEpoch', 'sourceToken', 'stateRevision', 'inspectionRevision'] as const)
      .every(key => saved[key] === state[key]);
    const ready = state.panels.some(panel => panel.panelId === panelId && panel.surface === 'companion'
      && panel.current && panel.availability === 'ready' && panel.xrStartup?.presenting === true
      && panel.xrStartup.stale === false && panel.xrStartup.sessionVisibility === 'visible');
    if (sameBinding && ready && sameControllerPlacement(before, after)
      && sameControllerPlacement(saved.scene.inspection.placement, after)) return { saved, livePlacement: after };
    await pause();
  }
  throw Error('Timed out waiting for saved immersive entry placement to match the live ready companion.');
}
