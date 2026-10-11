import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createStructureViewerSyncController, type StructureViewerSyncAdapter, type StructureViewerSyncSnapshot } from '../src/structure-viewer-sync.js';

const coordinate = 'data_demo';
const coordinateSha = createHash('sha256').update(coordinate).digest('hex');
const sha = coordinateSha;
const snapshot = (revision: number, session = 'viewer-1', sourceSha256 = sha): StructureViewerSyncSnapshot => ({ viewerSessionId: session, sceneRevision: revision, sourceSha256 });

function adapter(current: StructureViewerSyncSnapshot): StructureViewerSyncAdapter {
  return {
    async readSnapshot() { return current; },
    async exportSnapshot(s) { return { ...s, sceneJson: { revision: s.sceneRevision }, coordinateText: coordinate, coordinateSha256: coordinateSha }; },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Structure Viewer snapshot sync controller', () => {
  it('is explicit, applies one revision, and deduplicates the same revision', async () => {
    const current = snapshot(4), applied: number[] = [];
    const controller = createStructureViewerSyncController({ adapter: adapter(current), apply: async value => { applied.push(value.sceneRevision); return { accepted: true }; } });
    expect(controller.running).toBe(false);
    expect(await controller.refresh()).toMatchObject({ status: 'applied', sceneRevision: 4 });
    expect(await controller.refresh()).toMatchObject({ status: 'unchanged', sceneRevision: 4 });
    expect(applied).toEqual([4]);
  });

  it('rejects a changed export identity before the importer is called', async () => {
    const current = snapshot(2); let applied = 0;
    const badAdapter: StructureViewerSyncAdapter = { async readSnapshot() { return current; }, async exportSnapshot(s) { return { ...s, sceneJson: {}, coordinateText: coordinate, coordinateSha256: 'b'.repeat(64) }; } };
    const controller = createStructureViewerSyncController({ adapter: badAdapter, apply: async () => { applied += 1; return { accepted: true }; } });
    expect(await controller.refresh()).toMatchObject({ status: 'rejected', sceneRevision: 2 });
    expect(applied).toBe(0);
  });

  it('serializes concurrent refreshes and retains source/revision order', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const current = snapshot(1); let reads = 0; const applied: number[] = [];
    const serial: StructureViewerSyncAdapter = { async readSnapshot() { reads += 1; await gate; return current; }, async exportSnapshot(s) { return { ...s, sceneJson: {}, coordinateText: coordinate, coordinateSha256: coordinateSha }; } };
    const controller = createStructureViewerSyncController({ adapter: serial, apply: async value => { applied.push(value.sceneRevision); return { accepted: true }; } });
    const first = controller.refresh(); const second = controller.refresh(); release();
    expect(await first).toMatchObject({ status: 'applied', sceneRevision: 1 });
    expect(await second).toMatchObject({ status: 'unchanged', sceneRevision: 1 });
    expect(reads).toBe(2); expect(applied).toEqual([1]);
  });

  it.each([1, 3])('coalesces %i overlapping refresh requests into one newer revision apply', async overlaps => {
    let current = snapshot(3), reads = 0;
    const entered = deferred(), release = deferred();
    const applied: number[] = [];
    const controller = createStructureViewerSyncController({
      adapter: { ...adapter(current), async readSnapshot() { reads += 1; return current; } },
      async apply(value) {
        applied.push(value.sceneRevision);
        if (value.sceneRevision === 3) {
          entered.resolve();
          await release.promise;
        }
        return { accepted: true };
      },
    });
    const first = controller.refresh();
    await entered.promise;
    current = snapshot(4);
    const followUps = Array.from({ length: overlaps }, () => controller.refresh());
    expect(reads).toBe(1);
    expect(applied).toEqual([3]);
    release.resolve();
    expect(await first).toMatchObject({ status: 'applied', sceneRevision: 3 });
    for (const receipt of await Promise.all(followUps))
      expect(receipt).toMatchObject({ status: 'applied', sceneRevision: 4 });
    expect(reads).toBe(2);
    expect(applied).toEqual([3, 4]);
    expect(controller.lastAppliedRevision).toBe(4);
  });

  it.each([
    ['reset', 'queued'], ['stop', 'queued'], ['reset', 'apply'], ['stop', 'apply'],
  ] as const)('guards a follow-up refresh after %s while %s', async (invalidate, phase) => {
    let current = snapshot(3);
    const firstEntered = deferred(), releaseFirst = deferred();
    const followUpEntered = deferred(), releaseFollowUp = deferred();
    const applied: number[] = [], committed: number[] = [];
    const controller = createStructureViewerSyncController({
      adapter: { ...adapter(current), async readSnapshot() { return current; } },
      async apply(value, { isCurrent } = { isCurrent: () => true }) {
        applied.push(value.sceneRevision);
        if (value.sceneRevision === 3) {
          firstEntered.resolve();
          await releaseFirst.promise;
        } else {
          followUpEntered.resolve();
          await releaseFollowUp.promise;
        }
        if (!isCurrent()) return { accepted: false };
        committed.push(value.sceneRevision);
        return { accepted: true };
      },
    });
    const first = controller.refresh();
    await firstEntered.promise;
    current = snapshot(4);
    const followUp = controller.refresh();
    if (phase === 'queued') {
      controller[invalidate]();
      // Release both gates so a broken guard fails assertions rather than hangs.
      releaseFollowUp.resolve();
      releaseFirst.resolve();
    } else {
      releaseFirst.resolve();
      await Promise.race([followUpEntered.promise, followUp]);
      controller[invalidate]();
      releaseFollowUp.resolve();
    }
    expect(await first).toMatchObject({ status: phase === 'queued' ? 'superseded' : 'applied', sceneRevision: 3 });
    expect(await followUp).toMatchObject({ status: phase === 'queued' ? 'stale' : 'superseded', sceneRevision: 4 });
    expect(applied).toEqual(phase === 'queued' ? [3] : [3, 4]);
    expect(committed).toEqual(phase === 'queued' ? [] : [3]);
    expect(controller.lastAppliedRevision).toBe(invalidate === 'stop' && phase === 'apply' ? 3 : undefined);
  });

  it.each(['reset', 'stop'] as const)('allows an explicit refresh to renew a queued request after %s', async invalidate => {
    let current = snapshot(3);
    const entered = deferred(), release = deferred();
    const applied: number[] = [];
    const controller = createStructureViewerSyncController({
      adapter: { ...adapter(current), async readSnapshot() { return current; } },
      async apply(value) {
        applied.push(value.sceneRevision);
        if (value.sceneRevision === 3) {
          entered.resolve();
          await release.promise;
        }
        return { accepted: true };
      },
    });
    const first = controller.refresh();
    await entered.promise;
    const queued = controller.refresh();
    controller[invalidate]();
    current = snapshot(4);
    const renewed = controller.refresh();
    release.resolve();
    expect(await first).toMatchObject({ status: 'superseded', sceneRevision: 3 });
    expect(await queued).toMatchObject({ status: 'applied', sceneRevision: 4 });
    expect(await renewed).toMatchObject({ status: 'applied', sceneRevision: 4 });
    expect(applied).toEqual([3, 4]);
    expect(controller.lastAppliedRevision).toBe(4);
  });

  it.each(['reset', 'stop'] as const)('does not let polling renew an invalidated queued request after %s', async invalidate => {
    vi.useFakeTimers();
    let current = snapshot(3), reads = 0;
    const entered = deferred(), release = deferred();
    const applied: number[] = [];
    const controller = createStructureViewerSyncController({
      adapter: { ...adapter(current), async readSnapshot() { reads += 1; return current; } },
      pollIntervalMs: 250,
      async apply(value) {
        applied.push(value.sceneRevision);
        if (value.sceneRevision === 3) {
          entered.resolve();
          await release.promise;
        }
        return { accepted: true };
      },
    });
    try {
      controller.start();
      const first = controller.refresh();
      await entered.promise;
      const queued = controller.refresh();
      controller[invalidate]();
      current = snapshot(4);
      if (invalidate === 'stop') controller.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(reads).toBe(1);
      release.resolve();
      expect(await first).toMatchObject({ status: 'superseded', sceneRevision: 3 });
      expect(await queued).toMatchObject({ status: 'stale', sceneRevision: 4 });
      expect(reads).toBe(2);
      expect(applied).toEqual([3]);
      expect(controller.lastAppliedRevision).toBeUndefined();

      await vi.advanceTimersByTimeAsync(250);
      expect(reads).toBe(3);
      expect(applied).toEqual([3, 4]);
      expect(controller.lastAppliedRevision).toBe(4);
    } finally {
      controller.stop();
      release.resolve();
      vi.useRealTimers();
    }
  });

  it('requires reset for a new source and invalidates an export stopped in flight', async () => {
    let current = snapshot(1), exportText = coordinate, exportHash = coordinateSha, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const applied: number[] = [];
    const source: StructureViewerSyncAdapter = {
      async readSnapshot() { return current; },
      async exportSnapshot(s) { if (s.sceneRevision > 1) await gate; return { ...s, sceneJson: {}, coordinateText: exportText, coordinateSha256: exportHash }; },
    };
    const controller = createStructureViewerSyncController({ adapter: source, apply: async value => { applied.push(value.sceneRevision); return { accepted: true }; } });
    expect(await controller.refresh()).toMatchObject({ status: 'applied', sceneRevision: 1 });
    current = snapshot(2);
    const pending = controller.refresh(); controller.stop(); release();
    expect(await pending).toMatchObject({ status: 'stale', sceneRevision: 2 });
    expect(applied).toEqual([1]);
    exportText = 'data_new'; exportHash = createHash('sha256').update(exportText).digest('hex');
    current = snapshot(2, 'viewer-2', exportHash);
    expect(await controller.refresh()).toMatchObject({ status: 'rejected' });
    controller.reset();
    expect(await controller.refresh()).toMatchObject({ status: 'applied', sceneRevision: 2 });
  });

  it.each([
    ['reset', 'apply'], ['reset', 'export'], ['stop', 'apply'], ['stop', 'export'],
  ] as const)('allows source B after %s during source A %s', async (invalidate, phase) => {
    const sourceA = snapshot(7, 'viewer-A');
    const textB = 'data_source_B';
    const hashB = createHash('sha256').update(textB).digest('hex');
    const sourceB = snapshot(1, 'viewer-B', hashB);
    let current = sourceA;
    const entered = deferred(), release = deferred();
    const applied: number[] = [];
    const controller = createStructureViewerSyncController({
      adapter: {
        async readSnapshot() { return current; },
        async exportSnapshot(s) {
          if (s.viewerSessionId === sourceA.viewerSessionId && phase === 'export') {
            entered.resolve();
            await release.promise;
          }
          const text = s.viewerSessionId === sourceA.viewerSessionId ? coordinate : textB;
          return { ...s, sceneJson: {}, coordinateText: text, coordinateSha256: s.sourceSha256 };
        },
      },
      async apply(value) {
        applied.push(value.sceneRevision);
        if (value.viewerSessionId === sourceA.viewerSessionId && phase === 'apply') {
          entered.resolve();
          await release.promise;
        }
        return { accepted: true };
      },
    });
    const pending = controller.refresh();
    await entered.promise;
    controller[invalidate]();
    current = sourceB;
    release.resolve();
    const receipt = await pending;
    expect(receipt).toMatchObject({ status: phase === 'apply' ? 'superseded' : 'stale', sceneRevision: 7 });
    if (phase === 'apply') expect(receipt.detail).toContain(invalidate);
    expect(controller.lastAppliedRevision).toBeUndefined();
    expect(applied).toEqual(phase === 'apply' ? [7] : []);
    expect(await controller.refresh()).toMatchObject({ status: 'applied', sceneRevision: 1, sourceSha256: hashB });
    expect(controller.lastAppliedRevision).toBe(1);
    expect(applied).toEqual(phase === 'apply' ? [7, 1] : [1]);
  });

  it.each([
    ['reset', 'reject'], ['reset', 'throw'], ['stop', 'reject'], ['stop', 'throw'],
  ] as const)('lets the applier skip a scene commit after %s and %s during apply', async (invalidate, outcome) => {
    const entered = deferred(), release = deferred();
    const observed: boolean[] = [], committed: number[] = [];
    const controller = createStructureViewerSyncController({
      adapter: adapter(snapshot(7)),
      async apply(value, { isCurrent } = { isCurrent: () => true }) {
        observed.push(isCurrent());
        entered.resolve();
        await release.promise;
        observed.push(isCurrent());
        if (!isCurrent()) {
          if (outcome === 'throw') throw new Error('Scene commit cancelled after lifecycle invalidation.');
          return { accepted: false };
        }
        committed.push(value.sceneRevision);
        return { accepted: true };
      },
    });
    const pending = controller.refresh();
    await entered.promise;
    controller[invalidate]();
    release.resolve();
    expect(await pending).toMatchObject({ status: 'superseded', sceneRevision: 7 });
    expect(observed).toEqual([true, false]);
    expect(committed).toEqual([]);
    expect(controller.lastAppliedRevision).toBeUndefined();
  });

  it('keeps isCurrent true throughout an uninterrupted delayed apply', async () => {
    const entered = deferred(), release = deferred();
    const observed: boolean[] = [], committed: number[] = [];
    let applyContext: { isCurrent(): boolean } | undefined;
    const controller = createStructureViewerSyncController({
      adapter: adapter(snapshot(7)),
      async apply(value, context) {
        applyContext = context;
        entered.resolve();
        if (!context) return { accepted: false };
        observed.push(context.isCurrent());
        await release.promise;
        observed.push(context.isCurrent());
        if (!context.isCurrent()) return { accepted: false };
        committed.push(value.sceneRevision);
        return { accepted: true };
      },
    });
    const pending = controller.refresh();
    await entered.promise;
    expect(applyContext).toBeDefined();
    expect(applyContext?.isCurrent).toBeTypeOf('function');
    expect(controller.lastAppliedRevision).toBeUndefined();
    release.resolve();
    expect(await pending).toMatchObject({ status: 'applied', sceneRevision: 7 });
    expect(observed).toEqual([true, true]);
    expect(committed).toEqual([7]);
    expect(controller.lastAppliedRevision).toBe(7);
  });
});
