/** Passive test observer: retain the latest published draw beyond telemetry eviction.
 * Self-contained so Playwright can serialize this into the page. */
export function observeToolbarRows(scope: any = globalThis): any[] {
  const hook = scope.__stereofoldDiagnostics;
  if (!hook || typeof hook.record !== 'function') return [];
  let observer = scope.__stereofoldToolbarRowsObserver;
  if (observer?.hook !== hook) {
    let draw = -1, sequence = 0;
    let seen = new WeakSet<object>();
    const chunks = new Map<number, any>();
    const clear = () => { draw = -1; chunks.clear(); };
    const capture = (entry: any) => {
      if (!entry || typeof entry !== 'object' || seen.has(entry)) return;
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0) { clear(); return; }
      if (entry.seq <= sequence) { clear(); sequence = 0; seen = new WeakSet(); }
      sequence = entry.seq; seen.add(entry);
      const detail = entry.detail;
      if (entry.kind === 'session-start' || entry.kind === 'session-end'
        || entry.kind === 'toolbar' && detail?.phase === 'redraw-dispose') { clear(); return; }
      if (entry.kind !== 'toolbar' || detail?.phase !== 'rows') return;
      // A from:0 publication also starts a fresh draw when a recreated toolbar
      // restarts its local counter at exactly the previous draw number.
      if (detail.draw !== draw || detail.from === 0) { clear(); draw = detail.draw; }
      const columns = ['labels', 'actions', 'targetable', 'x', 'y', 'z'];
      if (!Number.isSafeInteger(detail.draw) || detail.draw < 0
        || !Number.isSafeInteger(detail.from) || detail.from < 0
        || !Number.isSafeInteger(detail.total) || detail.total <= 0 || detail.total > 4096
        || !Array.isArray(detail.labels) || !detail.labels.length
        || detail.from + detail.labels.length > detail.total
        || columns.some(key => !Array.isArray(detail[key]) || detail[key].length !== detail.labels.length)
        || ['x', 'y', 'z'].some(key => !detail[key].every(Number.isFinite))
        || chunks.size >= 128 && !chunks.has(detail.from)) { clear(); return; }
      chunks.set(detail.from, detail);
    };
    const reconcile = () => {
      try {
        const retained = hook.entries?.() ?? [];
        if (!retained.length && sequence) { clear(); sequence = 0; seen = new WeakSet(); }
        // Missing frequent samples within a retained window are normal: the
        // production buffer may immediately evict them. A wholly unseen later
        // window, however, could have lost a rare session boundary too.
        if (retained.length && retained[0].seq > sequence + 1
          && !retained.some((entry: object) => seen.has(entry))) clear();
        // Session diagnostics use the module recorder directly, bypassing the
        // hook. Read those actual entries too, before accepting a later draw.
        for (const entry of retained) capture(entry);
      } catch { clear(); }
    };
    reconcile();
    const record = hook.record;
    hook.record = function (...args: any[]) {
      reconcile();
      const entry = record.apply(this, args);
      try { capture(entry); } catch { clear(); }
      return entry; // Preserve the recorder's exact result, receiver and errors.
    };
    observer = { hook, rows: () => { reconcile(); return [...chunks.values()]; } };
    scope.__stereofoldToolbarRowsObserver = observer;
  }
  return observer.rows();
}
