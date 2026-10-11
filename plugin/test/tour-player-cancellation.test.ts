import { expect, it, vi } from 'vitest';
import { mountTourPlayer, type Tour } from '../src/tour-player.js';
// @ts-ignore Production player DOM boundary; no browser or GPU work.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const tour: Tour = { id: 'cancellation', title: 'Cancellation', summary: '', steps: [
  { id: 'one', title: 'One', appearance: { background: '#112233' },
    figure: { layers: [{ id: 'chain', target: { chain: 'A' }, representation: 'cartoon', color: '#ff8800', opacity: 1, context: false }], labels: [], distances: [] },
    visibility: { op: 'only', chains: ['A'] } },
  { id: 'two', title: 'Two', appearance: { background: '#223344' } },
] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const h = tourEndHarness({ xr: true });
  let source = 'same';
  const snapshot = h.workspace.snapshot;
  h.workspace.snapshot = () => ({ ...snapshot(), sourceSha256: source });
  h.workspace.rows = () => [{ key: 'A:1', entityType: 'polymer', identity: { labelChain: 'A', authorChain: 'A', copyId: '1', modelNumber: 1 } }];
  const inspection = h.workspace.viewer.inspection;
  inspection.setLessonFigure = vi.fn(async () => {});
  inspection.setVisibility = vi.fn(async () => {});
  inspection.emphasize = vi.fn(inspection.emphasize);
  const player = mountTourPlayer({ ...h, tours: [tour] });
  return { ...h, player, inspection, changeSource: () => { source = 'new'; } };
}

const cancellations = ['pause', 'source', 'peer-done'] as const;
function cancel(h: ReturnType<typeof harness>, route: typeof cancellations[number]) {
  if (route === 'pause') h.player.pause();
  else if (route === 'source') h.changeSource();
  else h.player.restorePlayback({ sourceSha256: 'same' });
}

for (const route of cancellations) it(`${route} during first-visit emphasis prevents the abandoned figure and visibility`, async () => {
  const h = harness(), entered = deferred(), release = deferred();
  try {
    await h.player.select(tour.id);
    h.inspection.emphasize.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const pending = h.player.start(false, 0);
    const rejected = expect(pending).rejects.toThrow('interrupted');
    await entered.promise;
    cancel(h, route);
    release.resolve(); await rejected;
    expect(h.inspection.setLessonFigure).not.toHaveBeenCalled();
    expect(h.inspection.setVisibility).not.toHaveBeenCalled();
    if (route === 'peer-done') expect(h.player.getState()).toMatchObject({ step: -1, active: false });
  } finally { release.resolve(); h.player.pause(); h.cleanup(); }
});

for (const boundary of ['restore', 'figure', 'emphasis'] as const) {
  for (const route of cancellations) it(`${route} during cached ${boundary} prevents later chapter writes`, async () => {
    const h = harness(), entered = deferred(), release = deferred();
    try {
      await h.player.select(tour.id); await h.player.start(false, 0); await h.player.next();
      h.inspection.setLessonFigure.mockClear(); h.inspection.emphasize.mockClear(); h.inspection.setVisibility.mockClear();
      const property = boundary === 'restore' ? 'restore' : boundary === 'figure' ? 'setLessonFigure' : 'emphasize';
      const original = h.inspection[property];
      h.inspection[property] = vi.fn(async (...args: any[]) => { await original(...args); entered.resolve(); await release.promise; });
      const pending = h.player.back();
      const rejected = expect(pending).rejects.toThrow('interrupted');
      await entered.promise;
      cancel(h, route);
      release.resolve(); await rejected;
      if (boundary === 'restore') expect(h.inspection.setLessonFigure).not.toHaveBeenCalled();
      if (boundary !== 'emphasis') expect(h.inspection.emphasize).not.toHaveBeenCalled();
      expect(h.inspection.setVisibility).not.toHaveBeenCalled();
      if (route === 'peer-done') expect(h.player.getState()).toMatchObject({ step: -1, active: false });
    } finally { release.resolve(); h.player.pause(); h.cleanup(); }
  });
}

for (const boundary of ['restore', 'figure'] as const) {
  for (const route of cancellations) it(`${route} during starting-view ${boundary} prevents later lesson cleanup`, async () => {
    const h = harness(), entered = deferred(), release = deferred();
    try {
      await h.player.select(tour.id); await h.player.start(false, 0);
      h.inspection.setLessonFigure.mockClear();
      h.inspection.clearLessonEmphasis = vi.fn(h.inspection.clearLessonEmphasis);
      const property = boundary === 'restore' ? 'restore' : 'setLessonFigure';
      const original = h.inspection[property];
      h.inspection[property] = vi.fn(async (...args: any[]) => { await original(...args); entered.resolve(); await release.promise; });
      const pending = h.player.restoreStart();
      const rejected = expect(pending).rejects.toThrow('interrupted');
      await entered.promise; cancel(h, route); release.resolve(); await rejected;
      if (boundary === 'restore') expect(h.inspection.setLessonFigure).not.toHaveBeenCalled();
      expect(h.inspection.clearLessonEmphasis).not.toHaveBeenCalled();
      if (route === 'peer-done') expect(h.player.getState()).toMatchObject({ step: -1, active: false });
    } finally { release.resolve(); h.player.pause(); h.cleanup(); }
  });
}

for (const route of ['source', 'catalog', 'pause'] as const) it(`${route} during Done's menu restoration prevents a stale completion announcement`, async () => {
  const h = harness(), entered = deferred(), release = deferred();
  try {
    await h.player.select(tour.id); await h.player.start(false, 0);
    h.inspection.restoreTourSeat = vi.fn(async () => { entered.resolve(); await release.promise; });
    const pending = h.player.finish();
    const rejected = expect(pending).rejects.toThrow('interrupted');
    await entered.promise;
    if (route === 'source') h.changeSource();
    else if (route === 'catalog') await h.player.replaceTours([]);
    else h.player.pause();
    release.resolve(); await rejected;
    expect(h.spoken).toEqual([]);
    expect(h.statuses).not.toContain('Tour complete. Explore freely.');
    expect(h.records.all().some((record: any) => record.detail.action === 'end')).toBe(false);
  } finally { release.resolve(); h.player.pause(); h.cleanup(); }
});
