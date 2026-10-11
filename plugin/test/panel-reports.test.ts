import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_PANEL_ID,
  PANEL_REPORT_LIMIT,
  compareAnswers,
  createPanelReportStore,
  type PanelReport,
} from '../src/panel-reports.js';

type Report = PanelReport & { note?: string };

/** 2026-09-02T10:00:00Z plus `seconds`, as the viewer would write it. */
function at(seconds: number): string {
  return new Date(Date.parse('2026-09-02T10:00:00.000Z') + seconds * 1_000).toISOString();
}

function report(input: {
  panelId?: string;
  at: number;
  sequence?: number;
  build?: string;
  fitAt?: number;
  trigger?: string;
  loading?: boolean;
}): Report {
  return {
    ...(input.panelId === undefined ? {} : { panelId: input.panelId }),
    at: at(input.at),
    sequence: input.sequence ?? 1,
    viewerBuild: input.build ?? 'build-a',
    fit: {
      loadInFlight: input.loading === true,
      events: input.fitAt === undefined
        ? []
        : [{ at: at(input.fitAt), trigger: input.trigger ?? 'load' }],
    },
  };
}

/** A store whose presence window is anchored at 10:00:`seconds`. */
function storeAt(seconds: number) {
  const now = Date.parse(at(seconds));
  return createPanelReportStore<Report>({ now: () => now });
}

describe('createPanelReportStore', () => {
  /**
   * The failure the rule was rewritten for. A fresh Codex panel spends up to
   * 7.5 s inside its `get_structure` fallback with an empty fit ring, and the
   * old rule ("newest last fit event") made an empty ring lose to any hidden
   * card that had ever fitted. The reader would take fill 0.86 off a card six
   * messages up while the panel actually on screen was still blank.
   */
  it('answers with a fresh panel still inside its fallback, not a hidden card that fitted', () => {
    const store = storeAt(30);
    store.accept(report({ panelId: 'hidden', at: 22, sequence: 400, fitAt: 20 }));
    store.accept(report({ panelId: 'fresh', at: 28, sequence: 3 }));
    expect(store.newest()?.panelId).toBe('fresh');
    expect(store.panels().map((panel) => [panel.panelId, panel.answering])).toEqual([
      ['fresh', true],
      ['hidden', undefined],
    ]);
  });

  it('answers with the panel that spoke last, even when an older one fitted later', () => {
    const store = storeAt(30);
    // Both are live. `fitted-later` has the newer fit event and the older
    // report; `spoke-last` is the one still being driven.
    store.accept(report({ panelId: 'fitted-later', at: 20, sequence: 9, fitAt: 20 }));
    store.accept(report({ panelId: 'spoke-last', at: 25, sequence: 2, fitAt: 10 }));
    expect(store.newest()?.panelId).toBe('spoke-last');
  });

  it('prefers a settled panel over one with a load in flight, whatever the clock', () => {
    const store = storeAt(30);
    store.accept(report({ panelId: 'settled', at: 20, fitAt: 19 }));
    store.accept(report({ panelId: 'loading', at: 28, sequence: 5, fitAt: 27, loading: true }));
    // A report taken mid-load describes a camera the load is about to move.
    expect(store.newest()?.panelId).toBe('settled');
    // Once that load ends, the newer clock puts it back in front.
    store.accept(report({ panelId: 'loading', at: 29, sequence: 6, fitAt: 27 }));
    expect(store.newest()?.panelId).toBe('loading');
  });

  it('never answers with a panel outside the window while one is inside it', () => {
    const store = storeAt(60);
    // Outside the 30 s window, and it fitted a moment before going quiet.
    store.accept(report({ panelId: 'gone', at: 20, sequence: 900, fitAt: 20 }));
    store.accept(report({ panelId: 'live', at: 55, sequence: 2 }));
    expect(store.newest()?.panelId).toBe('live');
  });

  it('still answers when every panel is stale, and marks none of them answering', () => {
    const store = storeAt(600);
    store.accept(report({ panelId: 'a', at: 10, fitAt: 9 }));
    store.accept(report({ panelId: 'b', at: 20, fitAt: 5 }));
    // An old reading is a reading. The reader sees it is old because the
    // answering panel is absent from `diagnosticsPanels` entirely.
    expect(store.newest()?.panelId).toBe('b');
    expect(store.panels()).toEqual([]);
  });

  it('rejects a report that goes backwards for its own panel', () => {
    const store = storeAt(10);
    expect(store.accept(report({ panelId: 'a', at: 2, sequence: 7, fitAt: 2 }))).toBe(true);
    expect(store.accept(report({ panelId: 'a', at: 1, sequence: 6, fitAt: 1 }))).toBe(false);
    expect(store.newest()?.sequence).toBe(7);
    // The same sequence again is not backwards, and a higher one is welcome.
    expect(store.accept(report({ panelId: 'a', at: 3, sequence: 8, fitAt: 3 }))).toBe(true);
    expect(store.newest()?.sequence).toBe(8);
    // Sequences are per panel, so a second panel starting from one is fine.
    expect(store.accept(report({ panelId: 'b', at: 4, sequence: 1 }))).toBe(true);
  });

  it('keeps eight panels and evicts the one that has been quiet longest', () => {
    const store = storeAt(20);
    for (let index = 0; index < PANEL_REPORT_LIMIT; index += 1) {
      store.accept(report({ panelId: `p${index}`, at: index }));
    }
    expect(store.all()).toHaveLength(PANEL_REPORT_LIMIT);
    // p0 speaks again, so p1 is now the stalest.
    store.accept(report({ panelId: 'p0', at: 9, sequence: 2 }));
    store.accept(report({ panelId: 'p8', at: 10 }));
    const ids = store.all().map((entry) => entry.panelId);
    expect(ids).toHaveLength(PANEL_REPORT_LIMIT);
    expect(ids).toContain('p0');
    expect(ids).toContain('p8');
    expect(ids).not.toContain('p1');
  });

  it('lists only panels that reported inside the window, the answering one first', () => {
    const store = storeAt(30);
    store.accept(report({ panelId: 'old', at: -60, fitAt: -60 }));
    store.accept(report({ panelId: 'recent', at: 20, sequence: 3, build: 'build-b', fitAt: 19, trigger: 'button' }));
    store.accept(report({ panelId: 'newer', at: 25, sequence: 4, fitAt: 24, trigger: 'mode' }));
    expect(store.panels()).toEqual([
      { panelId: 'newer', at: at(25), sequence: 4, viewerBuild: 'build-a', lastTrigger: 'mode', answering: true },
      { panelId: 'recent', at: at(20), sequence: 3, viewerBuild: 'build-b', lastTrigger: 'button' },
    ]);
    // The panel outside the window is still stored: presence and storage are
    // different questions, and it becomes the answer again if it speaks.
    expect(store.all()).toHaveLength(3);
  });

  it('omits lastTrigger for a panel that has never fitted', () => {
    const store = storeAt(5);
    store.accept(report({ panelId: 'fresh', at: 4 }));
    expect(store.panels()).toEqual([
      { panelId: 'fresh', at: at(4), sequence: 1, viewerBuild: 'build-a', answering: true },
    ]);
  });

  /**
   * The old comparator returned 1 when `a` and `b` compared equal, including
   * when they were the same report, so a list that held the answering entry
   * twice could move it off index 0.
   */
  it('sorts a list containing the same report twice without moving the answering entry', () => {
    const answering = report({ panelId: 'live', at: 25, sequence: 4, fitAt: 24 });
    const other = report({ panelId: 'hidden', at: 20, sequence: 3, fitAt: 19 });
    const sorted = [answering, answering, other].sort(compareAnswers);
    expect(sorted[0]).toBe(answering);
    expect(sorted[1]).toBe(answering);
    expect(sorted[2]).toBe(other);
    expect(compareAnswers(answering, answering)).toBe(0);
    const store = storeAt(30);
    store.accept(other);
    store.accept(answering);
    expect(store.panels()[0]).toEqual(expect.objectContaining({ panelId: 'live', answering: true }));
  });

  it('gives a viewer too old to identify itself one shared slot', () => {
    const store = storeAt(3);
    store.accept(report({ at: 1, sequence: 1 }));
    store.accept(report({ at: 2, sequence: 2 }));
    expect(store.all()).toHaveLength(1);
    expect(store.panels()[0]?.panelId).toBe(ANONYMOUS_PANEL_ID);
  });
});
