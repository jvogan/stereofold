/** Public illustrative workflow, never an Anthropic campaign output or result. */
const source = (pdbId: string) => ({
  kind: 'public-pdb', pdbId, coordinateUrl: `https://files.rcsb.org/download/${pdbId}.cif`,
  citationUrl: `https://www.rcsb.org/structure/${pdbId}`, revisionPolicy: 'runtime-verified',
});
const appearance = (representation: string, color: string) => ({ representation, color, opacity: 1, clipping: 0, fog: 0 });

const stages = [
  { id: 'peptide-interface', title: 'Public MDM2–p53 peptide interface', source: source('1YCR'),
    assembly: { assemblyId: 'asymmetric_unit', activeOperatorIds: [], visibleEntityIds: ['1', '2'], selectedEntityIds: ['1', '2'], minimumEntityInstances: {}, maximumResiduePositions: 20_000, maximumAtomSites: 200_000, maximumSpanAngstrom: 2_000 },
    provenance: { labels: ['public illustration', 'MDM2', 'p53 peptide'], statement: '1YCR is a public peptide–protein interface illustration, not a proprietary or Anthropic campaign result.' } },
  { id: 'folded-target', title: 'Public GFP folded-target illustration', source: source('1EMA'),
    assembly: { assemblyId: 'asymmetric_unit', activeOperatorIds: [], visibleEntityIds: ['1'], selectedEntityIds: ['1'], minimumEntityInstances: {}, maximumResiduePositions: 20_000, maximumAtomSites: 200_000, maximumSpanAngstrom: 2_000 },
    provenance: { labels: ['public illustration', 'GFP'], statement: '1EMA is a public fluorescent-protein structure used here as an unbound folded-target illustration; no binder is modeled.' } },
  { id: 'protein-module', title: 'Public TOG–tubulin module illustration', source: source('4FFB'),
    assembly: { assemblyId: 'asymmetric_unit', activeOperatorIds: [], visibleEntityIds: ['1', '2', '3', '4', '5'], selectedEntityIds: ['1', '2', '3'], minimumEntityInstances: {}, maximumResiduePositions: 20_000, maximumAtomSites: 200_000, maximumSpanAngstrom: 2_000 },
    provenance: { labels: ['public illustration', 'TOG1', 'tubulin'], statement: '4FFB is a public TOG1–tubulin binding-module illustration, not a generated binder result.' } },
  { id: 'compact-control', title: 'Public crambin compact-fold control', source: source('1CRN'),
    assembly: { assemblyId: 'asymmetric_unit', activeOperatorIds: [], visibleEntityIds: ['1'], selectedEntityIds: ['1'], minimumEntityInstances: {}, maximumResiduePositions: 20_000, maximumAtomSites: 200_000, maximumSpanAngstrom: 2_000 },
    provenance: { labels: ['public illustration', 'crambin'], statement: '1CRN is a compact public fold used as a simple structural-control illustration.' } },
] as const;

const scenes = [
  ['Start with a target', 'This MDM2–p53 complex is a public interface illustration. A real project begins by naming its target biology and success assay before proposing a binder.', ['1', '2']],
  ['Known interface', '1YCR supplies a peptide in the MDM2 groove, so protein and partner can be inspected together as a documented interface example.', ['1', '2']],
  ['Target surface', 'MDM2 is entity 1. Its groove offers a concrete surface for writing an interface hypothesis rather than treating every exposed atom as equivalent.', ['1']],
  ['Partner shape', 'The p53 peptide is entity 2. Its compact bound shape illustrates one possible partner format; it is not a template for every target.', ['2']],
  ['Question boundary', 'The visible peptide–protein contact asks what surface should be engaged. It does not answer expression, specificity, affinity, or cellular function.', ['1', '2']],
  ['A folded target', '1EMA shows an unbound GFP fold, a useful contrast to the peptide interface. No binder is present in this public GFP structure.', ['1']],
  ['Target envelope', 'GFP’s beta-barrel makes a compact folded surface to inspect when deciding whether a target has an accessible structural region.', ['1']],
  ['Keep evidence separate', 'This coordinate record describes one deposited GFP arrangement. A design brief should keep its construct and provenance alongside any proposed candidate.', ['1']],
  ['Generate hypotheses', 'Methods such as RFdiffusion can generate structural hypotheses around a specified target region. A generated hypothesis remains a candidate, not binding evidence.', ['1']],
  ['Sequence candidates', 'ProteinMPNN can propose sequences for a chosen scaffold hypothesis. Sequence design and structural generation need their own retained inputs and version labels.', ['1']],
  ['A module example', '4FFB shows a TOG1 domain with an alpha/beta-tubulin dimer. It is a public protein-module interaction illustration, not a designed binder.', ['1', '2', '3']],
  ['Tubulin partners', 'The alpha- and beta-tubulin entities provide a two-part target surface in 4FFB, illustrating why a project must state which partner or interface is in scope.', ['1', '2']],
  ['TOG recognition', 'TOG1 is entity 3 in this source. Its contact with tubulin shows that biological recognition can depend on a module’s geometry and not only a short sequence motif.', ['3']],
  ['Model checks', 'Complex-prediction tools such as Boltz or OpenFold3 can help assess a proposed interface. Their confidence scores describe a model, rather than measured binding affinity.', ['1', '2', '3']],
  ['Diverse shortlist', 'Keep candidates with distinct sequences and predicted geometries. Diversity avoids presenting many near-duplicates as independent support for one interface idea.', ['1', '2', '3']],
  ['Compact control', '1CRN is a small public crambin fold used as a control illustration. Its compactness does not make it a binder or a proxy for a larger target.', ['1']],
  ['Assay separates claims', 'Expression, stability, binding, and specificity require separate experimental measurements. A rendered compact fold cannot substitute for those controls.', ['1']],
  ['Rank transparently', 'A shortlist needs its comparison pool, ranking rule, and negative controls recorded so that an apparent winner can be independently reviewed.', ['1']],
  ['Audit the workflow', 'Keep target records, prompts, tool versions, candidate identifiers, model outputs, and assay results linked. That makes a design decision inspectable later.', ['1']],
  ['What this illustrates', 'These four public sources illustrate target definition, proposal diversity, model checking, and validation planning. They report no Anthropic campaign output or result.', ['1']],
] as const;

const stageForIndex = (index: number) => index < 5 ? 'peptide-interface' : index < 10 ? 'folded-target' : index < 15 ? 'protein-module' : 'compact-control';
export const BINDER_EXPERIENCE = {
  id: 'public-binder-workflow', title: 'Public binder-design workflow',
  summary: 'Four public structural illustrations for target definition, proposal diversity, computational checks and experimental validation. This is not an Anthropic campaign output.',
  stages,
  steps: scenes.map(([title, body, selectionEntityIds], index) => ({
    id: `public-binder-workflow-${String(index + 1).padStart(2, '0')}`,
    title, body, stageId: stageForIndex(index), selectionEntityIds,
    appearance: appearance(index % 5 === 0 ? 'molecular-surface' : index % 5 === 1 ? 'ball-and-stick' : 'cartoon',
      ['chain-id', 'sequence-id', 'element-symbol', 'residue-name'][index % 4]!),
  })),
};
