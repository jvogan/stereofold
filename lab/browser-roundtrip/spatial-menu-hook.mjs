/**
 * The page seam used by an unattended headset acceptance run.
 *
 * Rows stay owned by the spatial toolbar. The hook reads them at call time and
 * hands the selected row's original action back to the toolbar's action chain,
 * so a remote press records, redraws and re-seats exactly like a trigger press.
 */

export function menuHookRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    id: String(row?.id ?? ''), label: String(row?.label ?? ''), active: row?.state !== true,
  }));
}

/**
 * The sequence browser's own reading, as much of it as a press can move.
 *
 * `{open, index}` was the whole of it, and `index` is a field no build has ever
 * published. An earlier run gave the browser a Find pad and taught `headset-drive.ts` to
 * read `sequence.find` and `sequence.page`, but this reducer dropped both, so
 * on the Quest 2 every one of ten `sequence-find-*` presses
 * worked on the display and timed out UNVERIFIED after 12.5 s
 * The row ids cannot stand in: a pad
 * press changes a row's LABEL and the ids are identical before and after.
 *
 * Everything here is a field a row press changes and nothing here changes on
 * its own between presses. The caption is deliberately absent — it carries the
 * page number in prose and would make every reading differ from every other.
 */
function sequenceReading(sequence, number) {
  const find = sequence.find;
  return {
    open: sequence.open === true,
    index: number(sequence.index),
    // The page the browser is on, and the chain tab it is showing. A Next, a
    // Previous, a Go to and a chain tab each move one of these.
    page: number(sequence.page),
    pageCount: number(sequence.pageCount),
    chain: typeof sequence.chain === 'string' ? sequence.chain : null,
    chains: number(sequence.chains),
    // The Find pad's own reading, published whether or not the pad is open, so
    // a `Value +` that moved one digit is an outcome and not a press that
    // changed nothing the page publishes.
    find: find && typeof find === 'object' ? {
      editing: find.editing === true,
      numbering: typeof find.numbering === 'string' ? find.numbering : null,
      negative: find.negative === true,
      digits: typeof find.digits === 'string' ? find.digits : null,
      digit: number(find.digit),
      value: number(find.value),
      label: typeof find.label === 'string' ? find.label : null,
    } : null,
  };
}

/**
 * The scene state a press is supposed to change, reduced to
 * what an unattended run checks and nothing else.
 *
 * The toolbar's own state object carries a caption, a reply and a subject name.
 * None of that belongs in a driver log, and a snapshot that changes every frame
 * cannot be compared across a press. This keeps the fields whose change IS the
 * outcome of a row — appearance, placement, mode, quality, motion, passthrough,
 * tour position, connection — and drops the rest.
 */
export function menuHookState(state) {
  if (!state || typeof state !== 'object') return null;
  const { appearance, placement, tour, motion, voice, sequence, readout } = state;
  const number = value => (Number.isFinite(value) ? value : null);
  const triple = value => (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [...value] : null);
  return {
    appearance: appearance ? { representation: appearance.representation ?? null, color: appearance.color ?? null,
      opacity: number(appearance.opacity), labels: appearance.labels === true, clipping: number(appearance.clipping) } : null,
    // The exact admitted menu cycle, detached so a diagnostic reader cannot edit it.
    representations: Array.isArray(state.representations) ? [...state.representations] : null,
    placement: placement ? { translation: triple(placement.translation), rotation: triple(placement.rotation),
      scale: number(placement.scale) } : null,
    renderQuality: typeof state.renderQuality === 'string' ? state.renderQuality : null,
    passthrough: typeof state.passthrough === 'boolean' ? state.passthrough : null,
    motion: motion ? { paused: motion.paused === true, reason: motion.reason ?? null } : null,
    voice: voice ? { state: voice.state ?? null, kind: voice.kind ?? null } : null,
    sequence: sequence ? sequenceReading(sequence, number) : null,
    // Which page of the source description the plate is showing, and
    // how many there are. The counter lives in the toolbar closure, so a
    // `description-page` press changed the row LABEL and nothing this reducer
    // published: on the Quest 2 six presses turned the page on
    // the display and every one reported UNVERIFIED
    // A scene whose description
    // fits one page draws no row and publishes an index of 0.
    readout: readout ? { descriptionPageIndex: number(readout.descriptionPageIndex),
      descriptionPageCount: number(readout.descriptionPageCount) } : null,
    tour: tour ? { selectedId: tour.selectedId ?? null, active: tour.active === true, autoplay: tour.autoplay === true,
      step: number(tour.step), menuOpen: tour.menuOpen === true, navigating: tour.navigating === true,
      bodyPageIndex: number(tour.bodyPageIndex), bodyPageCount: number(tour.bodyPageCount) } : null,
    connection: state.connection ? { line: state.connection.line ?? null } : null,
  };
}

export function installSpatialMenuHook({ readRows, runAction, readState, readStartup }) {
  if (typeof readRows !== 'function' || typeof runAction !== 'function') {
    throw new TypeError('A spatial menu hook needs row and action functions.');
  }
  const current = () => {
    const source = readRows();
    return { source: Array.isArray(source) ? source : [], publicRows: menuHookRows(source) };
  };
  const hook = Object.freeze({
    rows() { return current().publicRows; },
    // Read the current session even before its menu exists. A false value is
    // authoritative for this tab; a missing hook leaves older builds usable.
    xrStartup() {
      try {
        const startup = readStartup?.();
        if (typeof startup?.presenting !== 'boolean') return null;
        return { presenting: startup.presenting, sessionVisibility: startup.sessionVisibility ?? null,
          phase: startup.phase ?? null };
      } catch { return null; }
    },
    // Read-only. Asking never presses, never redraws and
    // never re-seats; a run may poll it between presses as often as it likes.
    state() {
      if (typeof readState !== 'function') return null;
      try { return menuHookState(readState()); } catch { return null; }
    },
    press(id) {
      const wanted = String(id ?? '');
      const { source, publicRows } = current();
      const index = publicRows.findIndex(row => row.id === wanted);
      if (index < 0) {
        throw Error(`Unknown menu row ${JSON.stringify(wanted)}. Known ids: ${publicRows.map(row => row.id).join(', ') || '(none)'}.`);
      }
      // A recessed status plate has no hit target. Mirror that physical press:
      // report that it did not fire and leave the action chain untouched.
      if (!publicRows[index].active) return false;
      runAction(source[index].action);
      return true;
    },
  });
  globalThis.__stereofoldMenu = hook;
  return () => {
    if (globalThis.__stereofoldMenu === hook) delete globalThis.__stereofoldMenu;
  };
}
