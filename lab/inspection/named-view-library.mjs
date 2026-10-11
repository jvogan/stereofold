/**
 * Host-driven Saved views row models and renderer for the desktop panel.
 *
 * The host library (`namedViews:{scope:'live-session',maximum,entries}` from
 * inspection state, tool answers and hydration) is the only authority. This
 * module turns it into panel rows: capacity text, per-entry source labels for
 * entries saved on another structure/model/assembly (whose restore stays
 * disabled), and delete affordances carrying the entry's viewRevision. The
 * tab-local `savedViews` store is never consulted here; the workspace keeps it
 * only for the no-host lab preview fallback.
 *
 * Pure except `renderHostViews`, which builds DOM with `document` so the lab
 * test can drive it with a micro-DOM stub. Only these element operations are
 * used: createElement, textContent, className, disabled, title, dataset,
 * setAttribute, append, replaceChildren, addEventListener.
 */
export const NAMED_VIEW_LIBRARY_CAPACITY = 16;

const REPRESENTATION_NAMES = { cartoon:'Cartoon', 'ball-and-stick':'Ball and stick',
  'molecular-surface':'Molecular surface', spacefill:'Spacefill' };

export function hostViewSourceLabel(entry) {
  return `Model ${entry.modelNumber} · assembly ${entry.assemblyId}`;
}

function hostViewDetail(entry) {
  const intent = entry.viewIntent;
  if (!intent || typeof intent !== 'object') return undefined;
  const representation = REPRESENTATION_NAMES[intent.representation] ?? intent.representation;
  const count = intent.selectionCount;
  if (typeof representation !== 'string' || !representation) return undefined;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? `${representation} · ${count} residue${count === 1 ? '' : 's'}`
    : representation;
}

function wellFormedEntry(entry) {
  return Boolean(entry) && typeof entry.id === 'string' && entry.id.length > 0
    && typeof entry.name === 'string' && entry.name.length > 0
    && Number.isSafeInteger(entry.viewRevision) && entry.viewRevision > 0
    && typeof entry.sourceSha256 === 'string' && entry.sourceSha256.length > 0
    && typeof entry.modelNumber === 'number' && typeof entry.assemblyId === 'string'
    && entry.assemblyId.length > 0;
}

function isForeign(entry, currentSource) {
  if (!currentSource || typeof currentSource.sourceSha256 !== 'string') return true;
  return entry.sourceSha256 !== currentSource.sourceSha256
    || entry.modelNumber !== currentSource.modelNumber
    || entry.assemblyId !== currentSource.assemblyId;
}

/**
 * Summarize one host library for the panel. Never throws on host payloads:
 * a missing library reports unavailable, malformed entries are counted as
 * ignored rather than rendered.
 */
export function summarizeHostViews(library, currentSource) {
  const maximum = library && Number.isSafeInteger(library.maximum) && library.maximum > 0
    ? library.maximum : NAMED_VIEW_LIBRARY_CAPACITY;
  const raw = library && Array.isArray(library.entries) ? library.entries : undefined;
  if (!raw) return { available:false, maximum, used:0, capacityText:`0 of ${maximum} saved`, rows:[], ignored:0 };
  const rows = [];
  let ignored = 0;
  for (const entry of raw) {
    if (!wellFormedEntry(entry)) { ignored++; continue; }
    const foreign = isForeign(entry, currentSource);
    rows.push({ id:entry.id, name:entry.name, viewRevision:entry.viewRevision, foreign,
      sourceLabel: foreign ? hostViewSourceLabel(entry) : undefined,
      detail: hostViewDetail(entry), canRestore: !foreign });
  }
  return { available:true, maximum, used:rows.length, capacityText:`${rows.length} of ${maximum} saved`, rows, ignored };
}

/**
 * Render summary rows into the Saved views list. Restore and delete route to
 * the host callbacks with the entry identity the host command path needs
 * (delete carries viewRevision); foreign entries render their source label
 * with restore disabled, never a silent cross-source restore.
 */
export function renderHostViews(list, summary, hooks) {
  list.replaceChildren();
  if (!summary.rows.length) {
    const empty = document.createElement('p');
    empty.className = 'help';
    empty.textContent = 'No shared views yet. Name this view and save it to this live session.';
    list.append(empty);
    return;
  }
  for (const row of summary.rows) {
    const item = document.createElement('div');
    item.className = 'saved-view-row';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'saved-view';
    restore.textContent = row.name;
    restore.disabled = !row.canRestore;
    if (row.detail) restore.title = row.detail;
    if (row.foreign) {
      restore.title = `Saved on ${row.sourceLabel}. Open that structure to restore this view.`;
      restore.dataset.foreign = 'true';
    }
    restore.addEventListener('click', () => hooks.onRestore({ id:row.id, name:row.name }));
    item.append(restore);
    if (row.detail) {
      const detail = document.createElement('span');
      detail.className = 'saved-view-detail';
      detail.textContent = row.detail;
      item.append(detail);
    }
    if (row.foreign) {
      const source = document.createElement('span');
      source.className = 'saved-view-source';
      source.textContent = row.sourceLabel;
      item.append(source);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-view-delete';
    remove.setAttribute('aria-label', `Delete ${row.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => hooks.onDelete({ id:row.id, name:row.name, viewRevision:row.viewRevision }));
    item.append(remove);
    list.append(item);
  }
}
