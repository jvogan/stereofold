import { StructureElement, StructureSelection } from 'molstar/lib/mol-model/structure.js';
import { Script } from 'molstar/lib/mol-script/script.js';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder.js';

/** Used only at source/chapter/appearance boundaries, never during playback. */
export function selectAnimationTrack(data, track) {
  const p = MS.struct.atomProperty.macromolecular;
  const tests = [MS.core.set.has([MS.set(...track.chains), p.auth_asym_id()])];
  if (track.selector) {
    const selected = (track.selector.residues ?? []).map(r => MS.core.rel.inRange([p.auth_seq_id(), r.from, r.to]));
    if (track.selector.componentIds?.length) selected.push(MS.core.set.has([MS.set(...track.selector.componentIds), p.label_comp_id()]));
    tests.push(MS.core.logic.or(selected));
  }
  const expression = MS.struct.generator.atomGroups({'atom-test': MS.core.logic.and(tests)});
  return StructureSelection.toLociWithSourceUnits(Script.getStructureSelection(expression, data));
}

export function resolveAnimationOwnership(data, definition) {
  const owners = new Map();
  for (const track of definition.tracks) {
    for (const chain of track.chains) {
      if (StructureElement.Loci.isEmpty(selectAnimationTrack(data, {chains:[chain]})))
        throw Error(`Animation author chain "${chain}" is absent from the loaded source.`);
    }
    const loci = selectAnimationTrack(data, track);
    if (StructureElement.Loci.isEmpty(loci)) throw Error(`Animation track "${track.id}" selects no atoms in the loaded source.`);
    for (const [id, other] of owners) {
      if (!StructureElement.Loci.isEmpty(StructureElement.Loci.intersect(loci, other)))
        throw Error(`Overlapping atom ownership between animation tracks "${id}" and "${track.id}".`);
    }
    owners.set(track.id, loci);
  }
  return owners;
}

export function animationLociOwner(loci, owners) {
  for (const [id, selected] of owners) {
    if (StructureElement.Loci.isSubset(selected, loci)) return id;
  }
}
