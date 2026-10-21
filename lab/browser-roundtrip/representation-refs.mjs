/**
 * Which Mol* cell is THE molecule's representation, and which refs are still
 * alive to paint on.
 *
 * Both rules exist because of one failure in the headset. The wall
 * lesson's chapter 4 builds a ligand overlay — a `StructureComponent` under the
 * same structure, drawn as `spacefill` — and chapter 5 then died with
 * `Could not find node '<ref>'` before it drew anything at all.
 *
 * The chain: the viewer's main representation is added to the STRUCTURE cell
 * (there is no visibility restriction on this stage), so Mol* files it under
 * `structure.genericRepresentations` and it never appears in
 * `structure.components[].representations`. The scan that re-binds the live
 * representation walks components only, so before the overlay existed it found
 * nothing and harmlessly left the viewer's own ref alone. The overlay gave it
 * something to find — a component whose representation type is `spacefill`,
 * which is a real inspection representation — so chapter 5 re-bound the
 * viewer's `representation` to the OVERLAY, rebuilt the overlay instead of the
 * molecule, then deleted the overlay as part of the same appearance, and
 * painted the chapter's colour key onto a ref that no longer existed.
 *
 * So: Stereofold's own auxiliary components are never candidates for "the
 * molecule", and no paint is ever addressed to a ref the state no longer has.
 */

/**
 * Tags on the components and representations this viewer adds BESIDE the
 * molecule: the ligand overlay and the residue labels. They are Stereofold's
 * own furniture, never the structure's representation, however they are drawn.
 */
export const STEREOFOLD_AUXILIARY_TAGS = Object.freeze([
  'stereofold-ligand-overlay',
  'stereofold-scoped-style',
  'stereofold-lesson-figure',
  'stereofold-molecular-animation',
  'stereofold-inspection-labels',
  'stereofold-inspection-selected-labels',
]);

/** Every tag on a Mol* state cell, defensively — a cell may carry none. */
function cellTags(cell) {
  const tags = cell?.transform?.tags;
  if (typeof tags === 'string') return [tags];
  return Array.isArray(tags) ? tags : [];
}

/**
 * Whether this cell is one of Stereofold's own additions rather than the
 * molecule. Mol* also stamps `structure-component-<key>` on a component it
 * creates by key, so the auxiliary key is matched as a substring of that too.
 */
export function isStereofoldAuxiliaryCell(cell) {
  for (const tag of cellTags(cell)) {
    for (const auxiliary of STEREOFOLD_AUXILIARY_TAGS) {
      if (tag === auxiliary || tag === `structure-component-${auxiliary}`) return true;
    }
  }
  return false;
}

/**
 * The hierarchy entry for the molecule's own representation, or undefined.
 *
 * `isInspectionRepresentation` is the caller's set of representation names —
 * the viewer's `INSPECTION_REPRESENTATIONS` — so this module states no opinion
 * about what a molecule may be drawn as. Empty and malformed hierarchies
 * return undefined, which every caller already treats as "keep the ref you
 * have".
 */
export function findLiveStructureRepresentation(structures, isInspectionRepresentation, primaryRef) {
  for (const root of structures ?? []) {
    if (primaryRef && root?.cell?.transform?.ref !== primaryRef) continue;
    for (const component of root?.components ?? []) {
      if (isStereofoldAuxiliaryCell(component?.cell)) continue;
      for (const candidate of component?.representations ?? []) {
        if (isStereofoldAuxiliaryCell(candidate?.cell)) continue;
        const params = candidate?.cell?.params?.values;
        const repr = candidate?.cell?.obj?.data?.repr;
        if (candidate?.cell?.status !== 'ok' || !repr?.state?.visible || !repr.renderObjects?.length) continue;
        if (isInspectionRepresentation(params?.type?.name)) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * The emphasis targets whose representation is still in the state tree.
 *
 * `plugin.build().to(ref)` THROWS on a ref the tree has lost — that is the
 * literal `Could not find node` — so a stale target has to be dropped before
 * the builder is asked for it, not caught afterwards. Dropping it costs that
 * representation its colour; throwing cost the wearer the whole chapter.
 *
 * @param {Array<{repr?:{ref?:string}}>} targets
 * @param {(ref:string) => boolean} hasCell
 * @returns {{targets:Array, missing:string[]}} `missing` names the suffixes
 *   that were dropped, so a headset with no console still records the loss.
 */
export function liveEmphasisTargets(targets, hasCell) {
  const live = [], missing = [];
  for (const target of targets ?? []) {
    const ref = target?.repr?.ref;
    if (!ref) { missing.push(target?.suffix === '' ? 'structure' : String(target?.suffix ?? '')); continue; }
    if (!hasCell(ref)) { missing.push(target?.suffix === '' ? 'structure' : String(target?.suffix ?? '')); continue; }
    live.push(target);
  }
  return { targets: live, missing };
}
