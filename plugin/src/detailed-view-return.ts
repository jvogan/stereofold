import { z } from 'zod';
import { detailedViewImportFromSnapshot, type DetailedViewImport } from './detailed-view-import.js';
import type { InspectionScene } from './inspection-contract.js';

/**
 * The return leg of the full Mol* viewer, without a file.
 *
 * Bringing detailed work back used to be a five-step
 * errand — Download State in the viewer, find the file, read its path out to an
 * agent, call `import_detailed_view`, then call it a second time for the
 * camera — and the selection and any components built over there were simply
 * lost. The detailed page already holds the same page key the companion holds,
 * so it can hand its own state straight back over the loopback listener it was
 * served from. `import_detailed_view` stays exactly as it was for the file
 * route; this is the same projection with two additions.
 *
 * Addition one: the page sends the snapshot itself, pruned. A Mol* state tree
 * for a structure built from raw data carries the whole mmCIF inside a
 * transform parameter, which is both megabytes the listener would refuse and
 * coordinates the Mac already has. Long strings are dropped before the POST.
 *
 * Addition two: the page resolves what is selected — and what the user gathered
 * into components — into residue descriptors. The server maps those onto its
 * own canonical catalog identities, so the selection survives the trip that a
 * `.molj` cannot describe outside a loaded structure.
 */

/** One residue as the loaded structure in the browser describes it. */
export const returnedResidueSchema = z.object({
  assemblyId: z.string().min(1).max(128),
  operatorIds: z.array(z.string().min(1).max(64)).max(64),
  labelChain: z.string().min(1).max(128),
  componentId: z.string().min(1).max(128),
  insertionCode: z.string().max(8),
  labelSequenceId: z.number().int().min(1).max(1_000_000).nullable(),
  authorResidue: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
}).strict();
export type ReturnedResidue = z.output<typeof returnedResidueSchema>;

/** The whole return payload the detailed page posts. */
export const detailedViewReturnSchema = z.object({
  snapshot: z.record(z.string(), z.unknown()),
  residues: z.array(returnedResidueSchema).max(20_000).optional(),
  /** Component labels the page folded into `residues`, for the plain-words report. */
  componentLabels: z.array(z.string().min(1).max(128)).max(64).optional(),
  /** True when the page hit its own residue cap and sent a prefix. */
  truncated: z.boolean().optional(),
  /** How many long strings the page dropped before sending, so the server can say so. */
  prunedStrings: z.number().int().nonnegative().max(100_000).optional(),
}).strict();
export type DetailedViewReturnPayload = z.output<typeof detailedViewReturnSchema>;

type CatalogRow = { key: string; identity: { modelNumber: number; copyId: string; labelChain: string; labelSequenceId: number | null;
  authorResidue: number | null; insertionCode: string | null; componentId: string } };

function lookup(copy: [string, string[]], labelChain: string, componentId: string, insertionCode: string,
  tag: ['label' | 'auth', number]): string {
  return JSON.stringify([JSON.stringify(copy), labelChain, componentId, insertionCode, tag]);
}

/**
 * Every canonical key the browser's residue descriptors name.
 *
 * The index is built exactly as the outbound page builds its own: on the copy,
 * the label chain, the component, the insertion code and one sequence position,
 * preferring the label position and falling back to the author number for
 * everything that has no label position. That symmetry is the point — the two
 * directions cannot disagree about what a residue is.
 */
export function returnedSelectionKeys(catalog: { rows: CatalogRow[] }, modelNumber: number, residues: ReturnedResidue[]) {
  const index = new Map<string, string>();
  for (const row of catalog.rows) {
    const identity = row.identity;
    if (identity.modelNumber !== modelNumber) continue;
    let copyId: unknown;
    try { copyId = JSON.parse(identity.copyId); } catch { continue; }
    if (!Array.isArray(copyId) || copyId[0] !== 'copy' || typeof copyId[1] !== 'string' || !Array.isArray(copyId[3])) continue;
    const copy: [string, string[]] = [copyId[1], copyId[3].map(String)];
    const insertionCode = identity.insertionCode ?? '';
    if (typeof identity.labelSequenceId === 'number') {
      index.set(lookup(copy, identity.labelChain, identity.componentId, insertionCode, ['label', identity.labelSequenceId]), row.key);
    }
    if (typeof identity.authorResidue === 'number') {
      index.set(lookup(copy, identity.labelChain, identity.componentId, insertionCode, ['auth', identity.authorResidue]), row.key);
    }
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  let unmatched = 0;
  for (const residue of residues) {
    const tag: ['label' | 'auth', number] | undefined = residue.labelSequenceId !== null
      ? ['label', residue.labelSequenceId]
      : residue.authorResidue !== null ? ['auth', residue.authorResidue] : undefined;
    const key = tag && index.get(lookup([residue.assemblyId, residue.operatorIds], residue.labelChain,
      residue.componentId, residue.insertionCode, tag));
    if (!key) { unmatched++; continue; }
    if (seen.has(key)) continue;
    seen.add(key); keys.push(key);
  }
  return { keys, unmatched };
}

/**
 * The panel-renderable projection of one returned detailed view.
 *
 * Appearance and camera come from the same projection the file route uses, so
 * the two return legs can never drift apart. The selection is added here and
 * nowhere else, because only this route carries the residue descriptors that
 * make one possible.
 */
export function detailedViewReturn(payload: DetailedViewReturnPayload, base: InspectionScene,
  catalog: { rows: CatalogRow[] }): DetailedViewImport {
  const projected = detailedViewImportFromSnapshot(payload.snapshot as Record<string, any>, base);
  const dropped = projected.dropped.filter(note => !note.startsWith('the selection,'));
  const applied = [...projected.applied];
  if (payload.residues) {
    const { keys, unmatched } = returnedSelectionKeys(catalog, projected.scene.modelNumber, payload.residues);
    if (JSON.stringify(keys) !== JSON.stringify(projected.scene.selectionKeys)) {
      projected.scene.selectionKeys = keys;
      applied.push('selection');
    }
    if (unmatched) dropped.push(`${unmatched} selected residue${unmatched === 1 ? '' : 's'} the panel's catalog for this model does not list`);
    if (payload.truncated) dropped.push('residues past the first 20,000 selected, which is more than one panel selection holds');
    if (payload.componentLabels?.length) {
      dropped.push(`the component grouping (${payload.componentLabels.slice(0, 6).join(', ')}${payload.componentLabels.length > 6 ? ', …' : ''}), whose residues came back as one selection`);
    }
  }
  if (payload.prunedStrings) dropped.push('measurements, volumes and any other large state the panel has no field for');
  return { scene: projected.scene, dropped, applied };
}

/**
 * Plain words for what stayed behind in Mol*, for a person rather than a log.
 * Every sentence names something the user can still see over there.
 */
export function stayedInMolstar(dropped: string[]): string[] {
  return dropped.map(note => note.replace(/^the /, 'The ').replace(/^(\d)/, '$1'))
    .map(note => note.endsWith('.') ? note : `${note}.`);
}

/**
 * The browser half, as source, because the detailed page is a generated
 * document rather than a module graph. It is a self-contained expression that
 * evaluates to the helper object; `detailed-view-return.test.ts` evaluates this
 * same string and drives it with fake Mol* objects, so the page's half of the
 * contract is tested rather than assumed.
 */
export const DETAILED_VIEW_RETURN_SOURCE = String.raw`(() => {
  // A transform parameter holding a whole mmCIF is the only large string in a
  // state tree, and the Mac already has those coordinates.
  var MAX_STRING = 4096, MAX_RESIDUES = 20000;
  function prune(value, counter, depth) {
    if (depth > 24) return null;
    if (typeof value === 'string') { if (value.length <= MAX_STRING) return value; counter.pruned++; return ''; }
    if (Array.isArray(value)) return value.map(function (item) { return prune(item, counter, depth + 1); });
    if (value && typeof value === 'object') {
      var copy = {};
      for (var key of Object.keys(value)) copy[key] = prune(value[key], counter, depth + 1);
      return copy;
    }
    return value === undefined ? null : value;
  }
  function pruneSnapshot(snapshot) {
    var counter = {pruned: 0};
    return {snapshot: prune(snapshot, counter, 0), prunedStrings: counter.pruned};
  }
  function unitCopy(unit) {
    var assembly = unit.conformation.operator.assembly;
    return assembly ? [String(assembly.id), Array.from(assembly.operList).map(String)] : ['asymmetric_unit', []];
  }
  function describe(unit, local) {
    var element = unit.elements[local], hierarchy = unit.model.atomicHierarchy;
    var residue = hierarchy.residueAtomSegments.index[element], chain = hierarchy.chainAtomSegments.index[element];
    var copy = unitCopy(unit), labelSequence = hierarchy.residues.label_seq_id.value(residue);
    var authorResidue = hierarchy.residues.auth_seq_id.value(residue);
    return {
      assemblyId: copy[0], operatorIds: copy[1],
      labelChain: hierarchy.chains.label_asym_id.value(chain),
      componentId: hierarchy.atoms.label_comp_id.value(element),
      insertionCode: hierarchy.residues.pdbx_PDB_ins_code.value(residue) || '',
      // Mol* writes 0 for everything with no polymer sequence position, which
      // is exactly where the panel's catalog carries null and identifies the
      // residue by its author number instead.
      labelSequenceId: Number.isInteger(labelSequence) && labelSequence > 0 ? labelSequence : null,
      authorResidue: Number.isInteger(authorResidue) ? authorResidue : null,
    };
  }
  // A group is either a Mol* element-loci entry, whose indices are positions
  // inside the unit, or a whole unit of a component, which is every position.
  function gather(elements, into, seen, cap) {
    var limit = typeof cap === 'number' && cap > 0 && cap < MAX_RESIDUES ? cap : MAX_RESIDUES;
    for (var group of elements || []) {
      var unit = group.unit, indices = group.indices;
      var whole = indices === 'all';
      // Mol* OrderedSet is either a sorted array or an Interval packed into
      // a Float64's two Int32 words (start inclusive, end exclusive).
      var interval = typeof indices === 'number' ? new Int32Array(new Float64Array([indices]).buffer) : null;
      var length = whole ? unit.elements.length : interval ? interval[1] - interval[0] : indices.length;
      for (var index = 0; index < length; index += 1) {
        if (into.length >= limit) return true;
        var described = describe(unit, whole ? index : interval ? interval[0] + index : indices[index]);
        var signature = JSON.stringify(described);
        if (seen.has(signature)) continue;
        seen.add(signature); into.push(described);
      }
    }
    return false;
  }
  /**
   * Whether this page drew the component, rather than the person looking at it.
   *
   * Folding components into the selection is how a user
   * says "these residues" — gathering them into one is the gesture Mol* gives
   * them for it. But the page now builds components of its own for the wearer's
   * benefit: one per part of the lesson's colour key, the faded complement
   * underneath them, and the label layer over the arriving selection. None of
   * those is anybody saying anything; they are a picture of state the panel
   * already has. A visit where the wearer touched nothing was coming home with
   * the named parts and their context selected.
   *
   * Every one of them carries the provenance tag below, and the key each is
   * created under puts 'structure-component-stereofold-…' in the same list, so
   * this holds for a page built before the tag existed too. A component the
   * user made carries neither. Residues they deliberately picked arrive on the
   * selection above whatever component they happen to sit in, so excluding
   * these costs a deliberate selection nothing.
   */
  function generated(cell) {
    var tags = cell && cell.transform && cell.transform.tags;
    return (Array.isArray(tags) ? tags.join(' ') : String(tags || '')).indexOf('stereofold-') >= 0;
  }
  // Mol* loci are per atom; the panel's identities are per residue, so the
  // signature above collapses every atom of one residue onto one descriptor.
  function collect(plugin, loaded) {
    var residues = [], seen = new Set(), componentLabels = [], truncated = false;
    try {
      var selection = plugin.managers.structure.selection.getLoci(loaded);
      if (selection && selection.kind === 'element-loci') truncated = gather(selection.elements, residues, seen) || truncated;
    } catch (error) { /* No selection is not a failed return. */ }
    try {
      var structures = plugin.managers.structure.hierarchy.current.structures || [];
      for (var structure of structures) {
        for (var component of structure.components || []) {
          var data = component.cell && component.cell.obj && component.cell.obj.data;
          if (!data || !data.units || !data.elementCount) continue;
          // Folding "all" into a selection would select the whole structure,
          // and nothing this page drew for the wearer is the user's work.
          if (data.elementCount >= loaded.elementCount) continue;
          if (generated(component.cell)) continue;
          var label = (component.cell.obj && component.cell.obj.label) || 'Component';
          componentLabels.push(String(label).slice(0, 128));
          var elements = data.units.map(function (unit) { return {unit: unit, indices: 'all'}; });
          truncated = gather(elements, residues, seen) || truncated;
        }
      }
    } catch (error) { /* A hierarchy this page cannot read still returns appearance and camera. */ }
    return {residues: residues, componentLabels: componentLabels, truncated: truncated};
  }
  /**
   * The Return press, as a bounded loop that reports what is
   * left rather than a loop whose exit is read as success.
   *
   * A panel renders one leg at a time, so the press posts the same payload
   * until the host stops naming more work. Two different things used to end
   * that loop: the work finishing, and the bound running out over a panel that
   * was still saving a representation. The page called both of them "applied"
   * and clicked Back, so a wearer on a Mac with the desktop panel attached had
   * their selection and camera left behind in Mol* and was told otherwise.
   *
   * So this returns the outstanding legs instead of deciding anything. The
   * caller navigates only when nothing is left to apply.
   *
   * What "nothing is left" now means. The host keeps EVERY
   * leg in 'remaining' until that leg's own complete_inspection receipt lands,
   * so an empty 'remaining' is a rendered frame rather than an accepted
   * enqueue, and this loop waits for each one like any other. That is one extra
   * turn per leg — no new channel and no second press, but the bound has to
   * have room for it: three legs is seven turns when the panel keeps up and
   * about ten when it needs a second beat on each, so the default is 18 rather
   * than 12. The turns are cheap; the thing that must not happen is the loop
   * ending while a leg is still queued and the page reading that as done.
   */
  async function applyReturn(options) {
    var post = options.post, payload = options.payload;
    var say = options.say || function () {}, onApplied = options.onApplied || function () {};
    var wait = options.wait || function (ms) { return new Promise(function (next) { setTimeout(next, ms); }); };
    var limit = options.limit || 18;
    var applied = [], stayed = [], remaining = ['start'], guard = 0, failure;
    while (remaining.length && guard < limit) {
      guard += 1;
      var detail;
      try { detail = await post(payload); }
      catch (error) {
        // A panel that is still rendering the previous leg refuses the next
        // one. That is a wait, not a failure, until the bound runs out — and
        // then it is the reason the return could not finish.
        failure = error;
        if (guard >= limit) break;
        say('Applying your changes — the panel is still rendering.');
        await wait(1500);
        continue;
      }
      failure = undefined;
      for (var change of detail.applied || []) if (applied.indexOf(change) < 0) applied.push(change);
      stayed = detail.stayed || [];
      remaining = detail.remaining || [];
      onApplied(applied);
      if (remaining.length) {
        // The leg in flight is counted once. It is named in 'remaining' until
        // the panel renders it, so the total is what has landed plus what has
        // not — adding one for the enqueue would count the last leg twice.
        say('Applying ' + (applied.length + 1) + ' of ' + (applied.length + remaining.length) + ' — ' + remaining.join(', ') + ' to come.');
        await wait(1200);
      }
    }
    return {applied: applied, stayed: stayed, remaining: remaining, attempts: guard, error: failure};
  }
  /**
   * Only what the person has picked, right now.
   *
   * 'collect' above is the Return press: it folds the components the wearer
   * gathered into the selection, because on the way home those are all "these
   * residues". A live report is a narrower question. The wearer clicks a
   * residue and asks what it is, so this is the selection alone, described by
   * the same 'describe' the return leg uses, so the Mac maps both with one
   * mapper and the two can never disagree about what a residue is.
   */
  function collectSelection(plugin, loaded, max) {
    var residues = [], seen = new Set(), truncated = false;
    var selection = plugin.managers.structure.selection.getLoci(loaded);
    if (selection && selection.kind === 'element-loci') truncated = gather(selection.elements, residues, seen, max);
    return {residues: residues, truncated: truncated};
  }
  return {pruneSnapshot: pruneSnapshot, collect: collect, describe: describe, applyReturn: applyReturn,
    collectSelection: collectSelection};
})()`;
