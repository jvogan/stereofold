// Matches the host scene-history capacity (MAX_SCENE_HISTORY).
export const INSPECTION_HISTORY_CAPACITY = 32;
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from './placement-limits.mjs';
const clone = value => structuredClone(value);
const fail = (code, message) => Object.assign(new Error(message), { code });

export const DEFAULT_INSPECTION = Object.freeze({
  appearance: Object.freeze({
    representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
    opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0,
  }),
  placement: Object.freeze({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }),
});

// `isosurface` is the density tier's representation. It is the
// only entry here that is not a representation OF A STRUCTURE, and a lesson
// chapter on the `filament` tier carries it through `configure` on every step,
// so an appearance that refused it would fail every chapter of that tier and
// blow `applyTourStep`'s deadline rather than merely look wrong.
const representations = new Set(['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill', 'isosurface']);
const colors = new Set(['chain-id', 'element-symbol', 'residue-name', 'sequence-id', 'uniform']);
const appearanceKeys = new Set(Object.keys(DEFAULT_INSPECTION.appearance));
const placementKeys = new Set(Object.keys(DEFAULT_INSPECTION.placement));
const isHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const finiteVector = (value, label) => {
  if (!Array.isArray(value) || value.length !== 3 || !Array.from(value).every(Number.isFinite)) {
    throw fail('invalid_inspection', `${label} must contain three finite numbers.`);
  }
  return [...value];
};
const exactPatch = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.has(key))) {
    throw fail('invalid_inspection', `${label} contains an unsupported field.`);
  }
  return clone(value);
};

export function normalizeAppearance(patch, base = DEFAULT_INSPECTION.appearance) {
  const next = { ...base, ...exactPatch(patch, appearanceKeys, 'Appearance') };
  if (!representations.has(next.representation) || !colors.has(next.color)
      || !isHex(next.uniformColor) || !isHex(next.background) || !isHex(next.highlightColor)
      || typeof next.labels !== 'boolean' || !Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1
      || !Number.isFinite(next.clipping) || next.clipping < 0 || next.clipping > 80
      || !Number.isFinite(next.fog) || next.fog < 0 || next.fog > 100) {
    throw fail('invalid_inspection', 'Appearance has an unsupported value.');
  }
  return next;
}

/**
 * Appearance is deliberately a small, flat value. Keep its equality here so
 * callers can avoid asking Mol* to rebuild an identical representation: even
 * an update which changes no parameter re-runs its representation path on a
 * Quest. This compares the complete normalized value, never an incomplete
 * command patch, so omitted fields still inherit exactly as they would in
 * `normalizeAppearance`.
 */
export function sameAppearance(left, right) {
  if (!left || !right) return false;
  return [...appearanceKeys].every(key => left[key] === right[key]);
}

export function normalizePlacement(patch, base = DEFAULT_INSPECTION.placement) {
  const next = { ...base, ...exactPatch(patch, placementKeys, 'Placement') };
  next.translation = finiteVector(next.translation, 'Placement translation');
  if (next.translation.some(value => Math.abs(value) > PLACEMENT_MAX_TRANSLATION)) {
    throw fail('invalid_inspection', `Placement translation must be within ±${PLACEMENT_MAX_TRANSLATION} molecular radii on each axis.`);
  }
  next.rotation = finiteVector(next.rotation, 'Placement rotation').map(value => {
    const normalized = ((value % 360) + 540) % 360 - 180;
    if (!Number.isFinite(normalized)) throw fail('invalid_inspection', 'Placement rotation must normalize to finite degrees.');
    return normalized;
  });
  if (!Number.isFinite(next.scale) || next.scale < PLACEMENT_MIN_SCALE || next.scale > PLACEMENT_MAX_SCALE) {
    throw fail('invalid_inspection', `Placement scale must be between ${PLACEMENT_MIN_SCALE} and ${PLACEMENT_MAX_SCALE}.`);
  }
  return next;
}

export function createInspectionState() {
  let current = { ...clone(DEFAULT_INSPECTION), payload: null };
  let undo = [], redo = [], lastAction = null;
  let saved = [];
  /**
   * The edits of ONE request, held open so they leave ONE thing
   * to undo.
   *
   * "Make this RNA orange, fade the rest and enlarge it" is one request. Each
   * edit used to push its own undo entry, so taking it back took three presses
   * and the two in the middle left the wearer looking at pictures nobody had
   * asked for. While a group is open the first edit records the state the
   * request started from and the rest record nothing, so one press restores
   * all of it at once.
   */
  let group = null;
  const snapshot = () => clone({ appearance: clone(current.appearance), placement: clone(current.placement), ...(current.companionStructure ? {companionStructure:clone(current.companionStructure)} : {}), history: { undoCount: undo.length, redoCount: redo.length, lastAction },
    savedViews: saved.map(({ id, name }) => ({ id, name })) });
  const stateOnly = value => ({ appearance: clone(value.appearance), placement: clone(value.placement), ...(value.companionStructure ? {companionStructure:clone(value.companionStructure)} : {}), payload: clone(value.payload) });
  const record = (action, before = current) => {
    if (group) {
      if (group.recorded) { lastAction = group.action; return; }
      group.recorded = true;
    }
    undo.push(stateOnly(before));
    if (undo.length > INSPECTION_HISTORY_CAPACITY) undo.shift();
    redo = [];
    lastAction = group ? group.action : action;
  };
  return Object.freeze({
    snapshot,
    // The XR depth adapter reads this scalar each frame; no scene clone is needed.
    clipping() { return current.appearance.clipping; },
    // Frame-time transform readers need only these seven numbers. Keep the
    // returned arrays detached, without cloning appearance/history metadata.
    placement() { return { translation: [...current.placement.translation], rotation: [...current.placement.rotation], scale: current.placement.scale }; },
    checkpoint() { return clone({ current, undo, redo, lastAction, saved }); },
    restoreCheckpoint(value) {
      if (!value || typeof value !== 'object') throw fail('invalid_inspection', 'Invalid inspection checkpoint.');
      ({ current, undo, redo, lastAction, saved } = clone(value)); return snapshot();
    },
    /** Collapse a rendered correction into its original undo entry. Keep the
     * current appearance/payload aligned with the frame the renderer drew. */
    rebaseHistory(checkpoint) {
      undo = clone(checkpoint.undo);
      record(lastAction, checkpoint.current);
      return snapshot();
    },
    /**
     * Open one request's group. Every edit until `endGroup`
     * leaves a single undo entry holding the state the request started from.
     */
    beginGroup(action = 'compound') {
      if (group) throw fail('invalid_inspection', 'An inspection group is already open.');
      group = { action, recorded: false }; return snapshot();
    },
    /** Close it. Safe to call when none is open, so a `finally` can always run. */
    endGroup() { group = null; return snapshot(); },
    groupOpen() { return group !== null; },
    setPayload(value) { current.payload = clone(value); },
    payload() { return clone(current.payload); },
    recordPayload(value, action) { record(action); current.payload = clone(value); return snapshot(); },
    setCompanion(value) { record('companion-structure'); if(value) current.companionStructure=clone(value); else delete current.companionStructure; return snapshot(); },
    configure(patch, action = 'configure') { const next = normalizeAppearance(patch, current.appearance); record(action); current.appearance = next; return snapshot(); },
    place(patch, action = 'place') { const next = normalizePlacement(patch, current.placement); record(action); current.placement = next; return snapshot(); },
    replace(value, action = 'restore') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.appearance || !value.placement) {
        throw fail('invalid_inspection', 'A complete inspection state is required.');
      }
      if (Object.keys(value.appearance).length !== appearanceKeys.size || Object.keys(value.appearance).some(key => !appearanceKeys.has(key))
          || Object.keys(value.placement).length !== placementKeys.size || Object.keys(value.placement).some(key => !placementKeys.has(key))) {
        throw fail('invalid_inspection', 'A complete inspection appearance and placement are required.');
      }
      const next = { appearance: normalizeAppearance(value.appearance), placement: normalizePlacement(value.placement), ...(value.companionStructure ? {companionStructure:clone(value.companionStructure)} : {}) };
      record(action); current = next; return snapshot();
    },
    undo() { if (!undo.length) return snapshot(); redo.push(stateOnly(current)); current = undo.pop(); lastAction = 'undo'; return snapshot(); },
    redo() { if (!redo.length) return snapshot(); undo.push(stateOnly(current)); current = redo.pop(); lastAction = 'redo'; return snapshot(); },
    save(name, payload = undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw fail('invalid_saved_view', 'A saved view needs a name of at most 80 characters.');
      const view = { id: crypto.randomUUID(), name: name.trim(), state: stateOnly(current), payload: clone(payload) };
      // Same capacity as the host library (MAX_INSPECTION_VIEWS), so a preview
      // without a host keeps as many views as a live session.
      saved = [...saved.filter(item => item.name !== view.name), view].slice(-16);
      lastAction = 'save-view'; return { ...snapshot(), savedView: { id: view.id, name: view.name } };
    },
    saved(id) { const found = saved.find(view => view.id === id); if (!found) throw fail('missing_saved_view', 'The requested saved view does not exist.'); return clone(found); },
    restoreSaved(id) { const found = this.saved(id); return this.replace(found.state, 'restore-view'); },
    reset(appearance = {}) {
      current = { appearance: normalizeAppearance(appearance), placement: clone(DEFAULT_INSPECTION.placement), payload: null };
      undo = []; redo = []; lastAction = null; saved = []; group = null; return snapshot();
    },
  });
}
