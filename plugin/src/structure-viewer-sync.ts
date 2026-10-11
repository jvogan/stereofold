/**
 * Revision ordered controller for the supported Structure Viewer snapshot
 * bridge. The native plugin exposes revisioned reads and explicit exports, but
 * no push subscription or shared session capability. A host supplies those
 * two operations here; this controller only sequences them and hands an
 * identity checked export to the existing `inspect_scene` adapter.
 */

import { createHash } from 'node:crypto';
import { readStructureViewerSceneFiles } from './inspection-scene-file.js';

const SHA256 = /^[a-f0-9]{64}$/;

export type StructureViewerSyncSnapshot = {
  viewerSessionId: string;
  sceneRevision: number;
  sourceSha256: string;
};

export type StructureViewerSyncExport = StructureViewerSyncSnapshot & {
  sceneJson: unknown;
  coordinateText: string;
  coordinateSha256: string;
};

export type StructureViewerSyncReceipt = {
  status: 'applied' | 'unchanged' | 'stale' | 'superseded' | 'rejected' | 'failed';
  sceneRevision: number;
  sourceSha256: string;
  detail?: string;
};

export interface StructureViewerSyncAdapter {
  /** Read `structure.get_state` for the one explicitly selected viewer. */
  readSnapshot(): Promise<StructureViewerSyncSnapshot>;
  /** Export scene-json and selection-mmcif from the same expected revision. */
  exportSnapshot(snapshot: StructureViewerSyncSnapshot): Promise<StructureViewerSyncExport>;
}

export type LocalStructureViewerExportPaths = {
  scenePath: string;
  coordinatePath: string;
  provenancePath: string;
  viewerSessionId: string;
};

/**
 * Adapter for the supported local export pair. The controller's polling loop
 * becomes a bounded file watcher: a changed sidecar/revision is re-read as one
 * atomic three-file snapshot, then handed to the existing scene importer.
 */
export function createLocalStructureViewerExportAdapter(paths: LocalStructureViewerExportPaths): StructureViewerSyncAdapter {
  return {
    async readSnapshot() {
      const bundle = await readStructureViewerSceneFiles(paths);
      return {
        viewerSessionId: paths.viewerSessionId,
        sceneRevision: bundle.coordinate.expectedSceneRevision,
        sourceSha256: bundle.coordinate.sha256,
      };
    },
    async exportSnapshot(expected) {
      const bundle = await readStructureViewerSceneFiles(paths);
      const actual = {
        viewerSessionId: paths.viewerSessionId,
        sceneRevision: bundle.coordinate.expectedSceneRevision,
        sourceSha256: bundle.coordinate.sha256,
      } satisfies StructureViewerSyncSnapshot;
      if (actual.viewerSessionId !== expected.viewerSessionId || actual.sceneRevision !== expected.sceneRevision || actual.sourceSha256 !== expected.sourceSha256)
        throw new Error('The local Structure Viewer export pair changed between revision reads.');
      return { ...actual, sceneJson: bundle.sceneJson, coordinateText: bundle.coordinate.text, coordinateSha256: bundle.coordinate.sha256 };
    },
  };
}

export interface StructureViewerSyncController {
  /** Read and apply a revision; overlapping calls coalesce into one follow-up. */
  refresh(): Promise<StructureViewerSyncReceipt>;
  /** Start explicit low-frequency polling; no polling occurs before this call. */
  start(): void;
  /** Stop polling and prevent a queued refresh from applying. */
  stop(): void;
  /** Begin a new explicit viewer/source pairing. */
  reset(): void;
  readonly running: boolean;
  readonly lastAppliedRevision: number | undefined;
}

function validSnapshot(value: StructureViewerSyncSnapshot): void {
  if (!value || typeof value.viewerSessionId !== 'string' || value.viewerSessionId.length === 0)
    throw new Error('Structure Viewer sync requires one explicit viewer session.');
  if (!Number.isSafeInteger(value.sceneRevision) || value.sceneRevision < 0)
    throw new Error('Structure Viewer sync requires a nonnegative scene revision.');
  if (!SHA256.test(value.sourceSha256)) throw new Error('Structure Viewer sync requires a lowercase SHA-256 source identity.');
}

function validExport(value: StructureViewerSyncExport, expected: StructureViewerSyncSnapshot): void {
  validSnapshot(value);
  if (value.viewerSessionId !== expected.viewerSessionId || value.sceneRevision !== expected.sceneRevision)
    throw new Error('The Structure Viewer export changed revision while it was being read.');
  if (value.sourceSha256 !== expected.sourceSha256 || value.coordinateSha256 !== expected.sourceSha256)
    throw new Error('The Structure Viewer export does not identify the selected source bytes.');
  if (typeof value.coordinateText !== 'string' || value.coordinateText.length === 0)
    throw new Error('The Structure Viewer coordinate export is empty.');
  const digest = createHash('sha256').update(value.coordinateText, 'utf8').digest('hex');
  if (digest !== value.coordinateSha256) throw new Error('The Structure Viewer coordinate export hash does not match its bytes.');
}

export function createStructureViewerSyncController(options: {
  adapter: StructureViewerSyncAdapter;
  /**
   * Prepare the export, then check context.isCurrent() immediately before each
   * scene commit, with no await between the check and mutation. It becomes false
   * after reset() or stop(); skip the commit when false. The controller cannot
   * undo scene changes made inside apply. Existing one-argument appliers remain
   * compatible but must adopt this check to guard their downstream commits.
   */
  apply(exported: StructureViewerSyncExport, context: { isCurrent(): boolean }): Promise<{ accepted: boolean; detail?: string }>;
  pollIntervalMs?: number;
}): StructureViewerSyncController {
  const intervalMs = options.pollIntervalMs ?? 2_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error('Structure Viewer polling interval is too short.');
  let running = false;
  let handle: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<StructureViewerSyncReceipt> | undefined;
  let queued: { startedAt: number; promise: Promise<StructureViewerSyncReceipt> } | undefined;
  let lastApplied: StructureViewerSyncSnapshot | undefined;
  let lifecycle = 0;

  const runRefresh = (startedAt: number): Promise<StructureViewerSyncReceipt> => {
    const pending = (async (): Promise<StructureViewerSyncReceipt> => {
      let snapshot: StructureViewerSyncSnapshot;
      try { snapshot = await options.adapter.readSnapshot(); validSnapshot(snapshot); }
      catch (error) {
        return { status: 'failed', sceneRevision: lastApplied?.sceneRevision ?? -1, sourceSha256: lastApplied?.sourceSha256 ?? '', detail: error instanceof Error ? error.message : String(error) };
      }
      if (lastApplied && (snapshot.viewerSessionId !== lastApplied.viewerSessionId || snapshot.sourceSha256 !== lastApplied.sourceSha256))
        return { status: 'rejected', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256, detail: 'A new viewer or source requires an explicit sync reset.' };
      if (lastApplied && snapshot.viewerSessionId === lastApplied.viewerSessionId && snapshot.sourceSha256 === lastApplied.sourceSha256
        && snapshot.sceneRevision <= lastApplied.sceneRevision)
        return { status: snapshot.sceneRevision === lastApplied.sceneRevision ? 'unchanged' : 'stale', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256 };
      let exported: StructureViewerSyncExport;
      try {
        exported = await options.adapter.exportSnapshot(snapshot);
        validExport(exported, snapshot);
      } catch (error) {
        return { status: 'rejected', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256, detail: error instanceof Error ? error.message : String(error) };
      }
      if (startedAt !== lifecycle)
        return { status: 'stale', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256, detail: 'Sync stopped before this viewer export was applied.' };
      const applyingAt = lifecycle;
      const isCurrent = () => applyingAt === lifecycle;
      const superseded = (): StructureViewerSyncReceipt => ({
        status: 'superseded', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256,
        detail: 'Sync was reset or stopped while this viewer export was being applied.',
      });
      try {
        const outcome = await options.apply(exported, { isCurrent });
        if (!isCurrent()) return superseded();
        if (!outcome.accepted) return { status: 'rejected', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256, detail: outcome.detail };
        lastApplied = snapshot;
        return { status: 'applied', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256, detail: outcome.detail };
      } catch (error) {
        if (!isCurrent()) return superseded();
        return { status: 'failed', sceneRevision: snapshot.sceneRevision, sourceSha256: snapshot.sourceSha256, detail: error instanceof Error ? error.message : String(error) };
      }
    })().finally(() => {
      if (inFlight === pending) inFlight = undefined;
    });
    inFlight = pending;
    return pending;
  };

  const refresh = (source: 'explicit' | 'poll'): Promise<StructureViewerSyncReceipt> => {
    if (!inFlight) return runRefresh(lifecycle);
    if (!queued) {
      const request = {
        startedAt: lifecycle,
        promise: inFlight.then((): Promise<StructureViewerSyncReceipt> => {
          queued = undefined;
          return runRefresh(request.startedAt);
        }),
      };
      queued = request;
      inFlight = request.promise;
    } else if (source === 'explicit') {
      // Only an explicit new request can renew a queue invalidated by reset/stop.
      queued.startedAt = lifecycle;
    }
    return queued.promise;
  };

  return {
    refresh: () => refresh('explicit'),
    start(): void {
      if (running) return;
      running = true;
      handle = setInterval(() => { void refresh('poll'); }, intervalMs);
    },
    stop(): void {
      running = false;
      lifecycle += 1;
      if (handle !== undefined) { clearInterval(handle); handle = undefined; }
    },
    reset(): void { lifecycle += 1; lastApplied = undefined; },
    get running() { return running; },
    get lastAppliedRevision() { return lastApplied?.sceneRevision; },
  };
}
