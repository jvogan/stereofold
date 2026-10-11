import { z } from 'zod';
import { AUTHORED_EXPERIENCE_SCRIPTS } from './experience-scripts.js';
import { BINDER_EXPERIENCE } from './binder-experience.js';

/**
 * A source-switching lesson is deliberately distinct from a `Tour`: each
 * step names the exact public coordinate source and Mol* assembly it needs.
 * The renderer owns camera application and must keep an active XR head pose.
 */
const PDB = /^[0-9a-z]{4}$/iu;

export const molecularExperienceStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2_000),
  stageId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  /** Optional entity focus, resolved against this step's verified stage catalog. */
  selectionEntityIds: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
  appearance: z.object({
    representation: z.enum(['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill']),
    color: z.enum(['chain-id', 'element-symbol', 'residue-name', 'sequence-id', 'uniform']),
    uniformColor: z.string().regex(/^#[0-9a-f]{6}$/iu).optional(),
    opacity: z.number().min(0).max(1).optional(),
    clipping: z.number().min(0).max(80).optional(),
    fog: z.number().min(0).max(100).optional(),
  }).strict(),
}).strict();

export const molecularExperienceStageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  title: z.string().min(1).max(120),
  source: z.object({
    kind: z.literal('public-pdb'),
    pdbId: z.string().regex(PDB).transform(value => value.toUpperCase()),
    modelNumber: z.number().int().positive().optional(),
    coordinateUrl: z.string().url(),
    citationUrl: z.string().url(),
    /** PDB bytes are digested on first use and must remain stable in this server. */
    revisionPolicy: z.literal('runtime-verified'),
  }).strict(),
  assembly: z.object({
    assemblyId: z.string().min(1).max(128),
    /** Empty for a whole author-assigned assembly; otherwise exact PDB operator IDs. */
    activeOperatorIds: z.array(z.string().min(1).max(64)).max(64),
    /** Empty means all entities in the verified assembly remain visible. */
    visibleEntityIds: z.array(z.string().min(1).max(64)).max(32),
    selectedEntityIds: z.array(z.string().min(1).max(64)).max(32),
    minimumEntityInstances: z.record(z.string().min(1).max(64), z.number().int().min(1).max(10_000)),
    /**
     * What an author DECLARES about their own demo's
     * content, checked against the extracted catalog by
     * `validateExperienceAssembly` below. The `.max()` ceilings that used to
     * sit on these three (30,000 positions, 200,000 sites, 10,000 Angstrom)
     * are gone: nobody could name what they protected, they matched the
     * invented per-inspection budgets rather than any measurement, and an
     * author describing a larger deposit is describing a deposit, not asking a
     * viewer for room. `.min(1)` and `.finite()` remain because a declaration
     * of zero, a negative, or an infinity is a malformed stage rather than a
     * large one.
     */
    maximumResiduePositions: z.number().int().min(1),
    maximumAtomSites: z.number().int().min(1),
    maximumSpanAngstrom: z.number().positive().finite(),
  }).strict(),
  provenance: z.object({
    statement: z.string().min(1).max(2_000),
    /** Never say EB1 when this experimentally deposited stage is EB3. */
    labels: z.array(z.string().min(1).max(80)).min(1).max(16),
  }).strict(),
}).strict();

export const molecularExperienceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2_000),
  stages: z.array(molecularExperienceStageSchema).min(1).max(32),
  steps: z.array(molecularExperienceStepSchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  const stages = new Set(value.stages.map(stage => stage.id));
  for (const [index, stage] of value.stages.entries()) {
    const visible = new Set(stage.assembly.visibleEntityIds);
    if (visible.size && stage.assembly.selectedEntityIds.some(entity => !visible.has(entity))) {
      context.addIssue({ code: 'custom', message: 'Selected entities must be visible.', path: ['stages', index, 'assembly', 'selectedEntityIds'] });
    }
  }
  const stepIds = new Set<string>();
  for (const [index, step] of value.steps.entries()) {
    if (!stages.has(step.stageId)) context.addIssue({ code: 'custom', message: 'Step refers to an unknown stage.', path: ['steps', index, 'stageId'] });
    const stage=value.stages.find(candidate=>candidate.id===step.stageId);
    if (step.selectionEntityIds && stage?.assembly.visibleEntityIds.length && step.selectionEntityIds.some(entity=>!stage.assembly.visibleEntityIds.includes(entity))) {
      context.addIssue({ code: 'custom', message: 'Step selection must be visible in its stage.', path: ['steps', index, 'selectionEntityIds'] });
    }
    if (stepIds.has(step.id)) context.addIssue({ code: 'custom', message: 'Step IDs must be unique.', path: ['steps', index, 'id'] });
    stepIds.add(step.id);
  }
});

export type MolecularExperience = z.output<typeof molecularExperienceSchema>;
export type MolecularExperienceStage = z.output<typeof molecularExperienceStageSchema>;
export type MolecularExperienceStep = z.output<typeof molecularExperienceStepSchema>;

const source = (pdbId: string, citationUrl: string) => ({
  kind: 'public-pdb' as const, pdbId, coordinateUrl: `https://files.rcsb.org/download/${pdbId}.cif`, citationUrl, revisionPolicy: 'runtime-verified' as const,
});
const appearance = (representation: MolecularExperienceStep['appearance']['representation'], color: MolecularExperienceStep['appearance']['color']) =>
  ({ representation, color, opacity: 1, clipping: 0, fog: 0 });

/**
 * The 5SYF author assembly lists operators 1–26. Operators 1 and 14 have
 * the same helical angle and are separated along its axis, so the stage is a
 * two-dimer protofilament slice of that deposited assembly. All other stages
 * show either a deposited asymmetric unit or the complete author assembly.
 */
export const TUBULIN_EB3_EXPERIENCE = molecularExperienceSchema.parse({
  id: 'tubulin-eb3-lattice',
  title: 'Tubulin to an EB3-bound microtubule lattice',
  summary: 'A source-verified structural sequence from one alpha/beta-tubulin dimer through a deposited microtubule assembly to human EB3 decoration. EB3 is not labelled as EB1.',
  stages: [
    {
      id: 'tubulin-dimer', title: 'One deposited alpha/beta-tubulin dimer',
      source: source('5SYF', 'https://doi.org/10.1016/j.jmb.2017.01.001'),
      assembly: { assemblyId: 'asymmetric_unit', activeOperatorIds: [], visibleEntityIds: ['1', '2'], selectedEntityIds: ['1', '2'], minimumEntityInstances: { '1': 1, '2': 1 }, maximumResiduePositions:20_000, maximumAtomSites: 20_000, maximumSpanAngstrom: 200 },
      provenance: { labels: ['alpha/beta-tubulin', 'Taxol-stabilized'], statement: '5SYF is a 3.5 Å cryo-EM Taxol-stabilized microtubule coordinate entry; this stage uses its deposited asymmetric unit as one alpha/beta-tubulin repeat.' },
    },
    {
      id: 'protofilament-slice', title: 'A two-dimer protofilament slice',
      source: source('5SYF', 'https://doi.org/10.1016/j.jmb.2017.01.001'),
      assembly: { assemblyId: '1', activeOperatorIds: ['1', '14'], visibleEntityIds: ['1', '2'], selectedEntityIds: ['1', '2'], minimumEntityInstances: { '1': 2, '2': 2 }, maximumResiduePositions:30_000, maximumAtomSites: 200_000, maximumSpanAngstrom: 300 },
      provenance: { labels: ['alpha/beta-tubulin', 'protofilament slice', 'Taxol-stabilized'], statement: 'The two visible dimers are selected only from PDB 5SYF author assembly 1 operators 1 and 14; they are not procedurally invented coordinates.' },
    },
    {
      id: 'microtubule-lattice', title: 'The 5SYF author microtubule assembly',
      source: source('5SYF', 'https://doi.org/10.1016/j.jmb.2017.01.001'),
      assembly: { assemblyId: '1', activeOperatorIds: [], visibleEntityIds: ['1', '2'], selectedEntityIds: [], minimumEntityInstances: { '1': 26, '2': 26 }, maximumResiduePositions:30_000, maximumAtomSites: 200_000, maximumSpanAngstrom: 600 },
      provenance: { labels: ['alpha/beta-tubulin', 'Taxol-stabilized lattice'], statement: 'This is PDB 5SYF author assembly 1 using all deposited helical assembly operators, shown as a complete deposited assembly rather than generated repeats.' },
    },
    {
      id: 'eb3-decorated-lattice', title: 'Human EB3 on a growing-end-like lattice',
      source: source('3JAK', 'https://doi.org/10.1016/j.cell.2015.07.012'),
      assembly: { assemblyId: '1', activeOperatorIds: [], visibleEntityIds: ['1', '2', '3'], selectedEntityIds: ['3'], minimumEntityInstances: { '1': 6, '2': 6, '3': 2 }, maximumResiduePositions:20_000, maximumAtomSites: 100_000, maximumSpanAngstrom: 600 },
      provenance: { labels: ['alpha/beta-tubulin', 'EB3', 'GTPgammaS'], statement: '3JAK is a 3.3 Å cryo-EM GTPgammaS-microtubule structure co-polymerized with human EB3. It is an EB3-bound lattice intermediate, not a literal EB1 cap at a fully resolved plus-end.' },
    },
  ],
  steps: [
    ['dimer-overview', 'Meet one repeat', 'An alpha/beta-tubulin dimer is the repeating building block of a microtubule. Here it is shown before neighboring repeats turn that building block into a filament.', 'tubulin-dimer', 'cartoon', 'chain-id'],
    ['dimer-alpha-beta', 'Alpha and beta are different chains', 'Color separates alpha- and beta-tubulin so you can follow how the two related proteins pair within one repeat.', 'tubulin-dimer', 'cartoon', 'chain-id'],
    ['dimer-atoms', 'Inspect the deposited atoms', 'Atom detail reveals the molecular texture of the experimentally modeled tubulin dimer, including the pockets and surfaces that face its neighbors.', 'tubulin-dimer', 'ball-and-stick', 'element-symbol'],
    ['dimer-surface', 'The dimer surface', 'The dimer surface shows the broad faces that will meet longitudinally along a protofilament and laterally across the tube wall.', 'tubulin-dimer', 'molecular-surface', 'chain-id'],
    ['dimer-transition', 'A repeat can join a lattice', 'Next, two deposited repeats reveal the head-to-tail relationship that makes a protofilament feel like a molecular railway track.', 'tubulin-dimer', 'cartoon', 'chain-id'],
    ['protofilament-intro', 'Two deposited repeats', 'Two deposited dimers now sit one after the other: the longitudinal contact that repeats down a protofilament.', 'protofilament-slice', 'cartoon', 'chain-id'],
    ['protofilament-axis', 'Along one protofilament', 'Follow the line through the two repeats. Repeating this longitudinal relationship is how tubulin builds the length of a microtubule.', 'protofilament-slice', 'cartoon', 'sequence-id'],
    ['protofilament-contact', 'Neighboring repeat context', 'At close range, the contact surface between neighboring dimers becomes visible as a shaped molecular fit rather than a featureless line.', 'protofilament-slice', 'ball-and-stick', 'element-symbol'],
    ['protofilament-surface', 'Protofilament envelope', 'Surface view turns the two dimer slice into a short ridge, a glimpse of the protofilament contour that runs along a microtubule.', 'protofilament-slice', 'molecular-surface', 'chain-id'],
    ['protofilament-transition', 'Complete the declared assembly', 'Now widen the view to the full deposited segment: neighboring protofilaments meet side by side to make a hollow tube.', 'protofilament-slice', 'cartoon', 'chain-id'],
    ['lattice-overview', 'The deposited lattice assembly', 'The deposited 5SYF segment reveals a finite hollow microtubule lattice. It is a structural segment, not an endlessly growing filament.', 'microtubule-lattice', 'cartoon', 'chain-id'],
    ['lattice-scale', 'A larger molecular object', 'At room scale, the lattice becomes an overhead molecular landmark: longitudinal protofilaments run along its length while lateral contacts close the tube wall.', 'microtubule-lattice', 'cartoon', 'sequence-id'],
    ['lattice-surface', 'A cylindrical lattice surface', 'A surface makes the cylindrical wall legible. The opening through the middle is the hallmark of the microtubule’s hollow architecture.', 'microtubule-lattice', 'molecular-surface', 'chain-id'],
    ['lattice-composition', 'Tubulin-only assembly stage', 'This lattice stage contains tubulin under the Taxol-stabilized experimental condition. EB proteins appear only in the next, independently deposited structure.', 'microtubule-lattice', 'cartoon', 'residue-name'],
    ['lattice-transition', 'Use a different experiment for EB3', 'To meet an end-binding protein, switch to a separate EB3-bound lattice experiment rather than pretending to add a protein to this structure.', 'microtubule-lattice', 'cartoon', 'chain-id'],
    ['eb3-overview', 'EB3-bound lattice', 'This is human EB3 bound to a GTPgammaS microtubule lattice. EB proteins recognize particular lattice states; this deposited structure is EB3, not EB1.', 'eb3-decorated-lattice', 'cartoon', 'chain-id'],
    ['eb3-selection', 'Focus the EB3 entity', 'EB3 is highlighted against the tubulin wall so its position can be read as a lattice-recognition pattern rather than as another tubulin repeat.', 'eb3-decorated-lattice', 'cartoon', 'chain-id'],
    ['eb3-atoms', 'EB3 and lattice detail', 'Atom detail shows the modeled EB3–tubulin neighborhood in 3JAK, where lattice geometry and nucleotide analogue condition provide the structural context.', 'eb3-decorated-lattice', 'ball-and-stick', 'element-symbol'],
    ['eb3-state', 'A growing-end-like lattice state', 'GTPgammaS helps capture a lattice state relevant to end tracking. This is a structural snapshot of an EB3-bound state, not a live simulation of a growing plus end.', 'eb3-decorated-lattice', 'molecular-surface', 'chain-id'],
    ['eb3-summary', 'What this sequence established', 'From dimer to protofilament to hollow lattice to EB3 decoration, each view is tied to deposited experimental coordinates. Dynamic growth and an EB1-specific cap remain questions for additional evidence.', 'eb3-decorated-lattice', 'cartoon', 'chain-id'],
  ].map(([id, title, body, stageId, representation, color]) => ({ id, title, body, stageId,
    selectionEntityIds: stageId==='eb3-decorated-lattice' ? ['3'] : stageId==='microtubule-lattice' ? (id==='lattice-composition'?['1','2']:['1']) : ['1','2'],
    appearance: appearance(representation as any, color as any) })),
});

/** Curated starter identities for the existing ten 20-scene generic tours. */
export const TOUR_SOURCE_DIVERSITY = [
  ['fold-detective', '1CRN'], ['chemical-colors', '1EMA'], ['surface-safari', '1YCR'], ['structure-evidence', '4AKE'], ['claude-binder-map', '1AKE'],
  ['generator-gallery', '2LZM'], ['sequence-story', '1UBQ'], ['prediction-courtroom', '1BNA'], ['ranking-diversity', '4HHB'], ['controls-handoff', '1MBO'],
] as const;

const singleSourceExperience = (id:string,title:string,pdbId:string,summary:string,statement:string,components:string,
  visibleEntityIds:string[],selectedEntityIds:string[],biology:string):MolecularExperience => molecularExperienceSchema.parse({
  id,title,summary,
  stages:[{id:'deposited-source',title,source:source(pdbId,`https://www.rcsb.org/structure/${pdbId}`),
    assembly:{assemblyId:'asymmetric_unit',activeOperatorIds:[],visibleEntityIds,selectedEntityIds,minimumEntityInstances:{},maximumResiduePositions:20_000,maximumAtomSites:200_000,maximumSpanAngstrom:2_000},
    provenance:{labels:[pdbId,'deposited coordinates'],statement}}],
  steps:(AUTHORED_EXPERIENCE_SCRIPTS[id] ?? (()=>{ throw Error(`Missing authored experience script for ${id}.`); })()).map(([title,body,selectionEntityIds],index)=>({
    id:`${id}-${String(index+1).padStart(2,'0')}`,title,body,stageId:'deposited-source',selectionEntityIds:[...selectionEntityIds],
    appearance:appearance(index%5===0?'molecular-surface':index%5===1?'ball-and-stick':'cartoon',['chain-id','sequence-id','element-symbol','residue-name'][index%4]! as any)})),
});

/** Ten runnable definitions; all are source-backed and list only real installed experiences. */
export const MOLECULAR_EXPERIENCES:readonly MolecularExperience[] = [
  TUBULIN_EB3_EXPERIENCE,
  molecularExperienceSchema.parse(BINDER_EXPERIENCE),
  singleSourceExperience('cas9-ternary-complex','SpCas9 guide-RNA–DNA ternary complex','9KJ6','Inspect the deposited engineered SpCas9 ternary complex with its guide and target strands.','9KJ6 deposits SpCas9 with one single-guide RNA and target/non-target DNA strands.','Entity 1 is Cas9; entity 2 is guide RNA; entities 3 and 4 are target and non-target DNA strands.',['1','2','3','4'],['1','2'],'Cas9 uses a guide RNA to organize recognition of a complementary DNA target and its paired non-target strand.'),
  singleSourceExperience('telomerase-rnp-lobe','Human telomerase H/ACA RNP lobe','9QB3','Explore the deposited telomerase RNP lobe without calling it a whole holoenzyme.','9QB3 is the deposited H/ACA RNP lobe and is not a complete TERT-containing telomerase holoenzyme.','Entities 1–4 are H/ACA RNP protein subunits, entity 5 is TCAB1, and entity 6 is hTR.',['1','2','3','4','5','6'],['5','6'],'This H/ACA RNP lobe shows hTR together with its associated protein machinery and TCAB1 in one deposited telomerase-associated context.'),
  singleSourceExperience('telomerase-holoenzyme','Human telomerase holoenzyme assembly','9SI0','Inspect the deposited telomerase assembly with its declared components.','9SI0 deposits TERT, hTR, telomeric DNA and accessory components in this coordinate entry.','Entity 5 is hTR, entity 6 is TERT, entity 3 is DNA, and entities 1, 2 and 4 are accessory protein components.',['1','2','3','4','5','6','7'],['5','6'],'Telomerase brings its TERT catalytic subunit and hTR template RNA together with accessory components and a telomeric DNA substrate.'),
  singleSourceExperience('gfp-chromophore','Green fluorescent protein','1EMA','Inspect the deposited GFP coordinate record and its modeled chromophore context.','1EMA is a deposited green fluorescent protein coordinate entry; structure display alone does not measure fluorescence.','Entity 1 is the GFP polymer; entity 2 is deposited water.',['1'],['1'],'GFP folds into a protective beta-barrel around its internally formed chromophore, linking structure to its fluorescent behavior.'),
  singleSourceExperience('mdm2-p53-interface','MDM2–p53 complex','1YCR','Explore the deposited MDM2–p53 complex before conducting any separately requested contact analysis.','1YCR deposits an MDM2–p53 complex; a visual interface is not an affinity measurement.','Entity 1 is MDM2 and entity 2 is the deposited p53 peptide.',['1','2'],['1','2'],'The short p53 peptide occupies an MDM2-binding groove in this deposited complex, a structural starting point for studying recognition.'),
  singleSourceExperience('adenylate-kinase','Adenylate kinase conformation','4AKE','Inspect the deposited 4AKE conformation as one source before any explicit multi-object comparison.','4AKE is one deposited adenylate-kinase coordinate entry; a distinct conformation comparison requires an independently loaded, aligned source.','Entity 1 is adenylate kinase and entity 2 is deposited water.',['1'],['1'],'Adenylate kinase rearranges domains during nucleotide exchange; this deposited structure is one view of that enzyme scaffold.'),
  singleSourceExperience('tubulin-polymerase-complex','TOG–alpha/beta-tubulin complex','4FFB','Inspect a deposited TOG–tubulin complex without treating its curved tubulin conformation as a microtubule lattice.','4FFB deposits a TOG:alpha/beta-tubulin complex and is distinct from a microtubule lattice assembly.','Entities 1 and 2 are alpha- and beta-tubulin, entity 3 is the STU2 TOG1 domain, and entities 4 and 5 are deposited magnesium and GTP.',['1','2','3','4','5'],['1','2','3'],'The TOG1 domain of STU2 binds an alpha/beta-tubulin heterodimer in a curved tubulin context distinct from a microtubule lattice.'),
  singleSourceExperience('hemoglobin-quaternary-structure','Hemoglobin tetramer','4HHB','Inspect a public hemoglobin tetramer with explicit source and assembly context.','4HHB is a deposited hemoglobin coordinate entry; colors and viewpoints do not determine oxygen-binding state.','Entities 1 and 2 are hemoglobin alpha and beta subunits; entity 3 is deposited heme.',['1','2','3','4'],['1','2','3'],'Hemoglobin assembles alpha and beta subunits around heme groups, forming the familiar oxygen-carrying tetrameric scaffold.'),
];

/**
 * Every four-character entry code this build ships a way of reaching.
 *
 * The recognizer needs to be told these exist. "load 1CRN" came back
 * as "Load one CERN" on both device sessions because the code had never been
 * offered to it as a phrase, and
 * the normaliser needs the same list to decide that a word it heard spells a
 * code somebody could actually open. Sorted so the hint list is stable.
 */
export const CATALOG_ENTRY_CODES: readonly string[] = Object.freeze([...new Set([
  ...MOLECULAR_EXPERIENCES.flatMap(experience => experience.stages.map(stage => stage.source.pdbId)),
  ...TOUR_SOURCE_DIVERSITY.map(([, pdbId]) => pdbId),
].filter(code => /^[1-9][A-Za-z0-9]{3}$/u.test(code)).map(code => code.toUpperCase()))].sort());

/**
 * What a person calls each entry, beside the four characters that name it to the archive.
 *
 * Synthetic speech "Show me crambin" reached the host as `Show me
 * Crandon`, unchanged and with no rule recorded, so the model was handed a word
 * that names nothing. The codes above
 * told the recogniser that 1CRN exists; nothing told it, or the normaliser,
 * what the thing is called.
 *
 * Every name here belongs to an entry this build ships a way of reaching, and
 * the table is filtered by `CATALOG_ENTRY_CODES` below, so a name cannot outlive
 * the entry it names. The first spelling is the one written into a transcript;
 * the rest are spellings of the same word that a wearer or a recogniser may use.
 * Names of entries, not descriptions of them: the experience titles already
 * carry the sentence-length version.
 */
const ENTRY_COMMON_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '1AKE': ['adenylate kinase'],
  '1BNA': ['DNA dodecamer', 'DNA'],
  '1CRN': ['crambin'],
  '1EMA': ['green fluorescent protein', 'GFP'],
  '1MBO': ['myoglobin'],
  '1UBQ': ['ubiquitin'],
  '1YCR': ['MDM2', 'p53'],
  '2LZM': ['lysozyme'],
  '3JAK': ['EB3', 'microtubule'],
  '4AKE': ['adenylate kinase'],
  '4FFB': ['tubulin'],
  '4HHB': ['hemoglobin', 'haemoglobin'],
  '5SYF': ['microtubule', 'tubulin'],
  '9KJ6': ['Cas9', 'CRISPR'],
  '9QB3': ['telomerase'],
  '9SI0': ['telomerase'],
});

/** The common names of the entries this build ships, in the order the codes are listed. */
export const CATALOG_ENTRY_NAMES: readonly { entryCode: string; spellings: readonly string[] }[] =
  Object.freeze(CATALOG_ENTRY_CODES.flatMap(entryCode => ENTRY_COMMON_NAMES[entryCode]
    ? [Object.freeze({ entryCode, spellings: Object.freeze([...ENTRY_COMMON_NAMES[entryCode]!]) })] : []));

export function experienceById(id: string): MolecularExperience | undefined {
  return MOLECULAR_EXPERIENCES.find(experience => experience.id === id);
}

export function stageForStep(experience: MolecularExperience, stepIndex: number): MolecularExperienceStage {
  const step = experience.steps[stepIndex];
  if (!Number.isInteger(stepIndex) || !step) throw Error('Experience step is out of range.');
  const stage = experience.stages.find(candidate => candidate.id === step.stageId);
  if (!stage) throw Error('Experience step has no declared stage.');
  return stage;
}

export function validateExperienceAssembly(stage: MolecularExperienceStage, catalog: any) {
  if (catalog?.assemblyId !== stage.assembly.assemblyId) throw Error(`Experience requires assembly ${stage.assembly.assemblyId}.`);
  const rows = Array.isArray(catalog?.rows) ? catalog.rows : [];
  const copies = Array.isArray(catalog?.copies) ? catalog.copies : [];
  const byEntity = new Map<string, Set<string>>();
  let atomSites = 0;
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const visibleEntities = new Set(stage.assembly.visibleEntityIds);
  const activeOperators = new Set(stage.assembly.activeOperatorIds);
  const rowIsVisible = (row: any) => {
    if (!visibleEntities.has(String(row?.identity?.entityId ?? ''))) return false;
    if (!activeOperators.size) return true;
    const operators = Array.isArray(row?.identity?.operatorIds) ? row.identity.operatorIds.map(String) : [];
    return operators.some((operator: string) => activeOperators.has(operator));
  };
  for (const row of rows) {
    if (!rowIsVisible(row)) continue;
    const entity = String(row?.identity?.entityId ?? '');
    const copyId = String(row?.identity?.copyId ?? '');
    const labelChain = String(row?.identity?.labelChain ?? '');
    // An identity assembly may contain several chains for one entity (3JAK
    // has two EB3 chains), so chain+copy is the bounded entity-instance key.
    if (entity && copyId && labelChain) (byEntity.get(entity) ?? byEntity.set(entity, new Set()).get(entity)!).add(`${copyId}:${labelChain}`);
    for (const atom of Array.isArray(row?.atomSites) ? row.atomSites : []) {
      atomSites++;
      const coordinate = atom?.assemblyCoordinatesAngstrom;
      if (Array.isArray(coordinate) && coordinate.length === 3 && coordinate.every(Number.isFinite)) {
        for (let axis = 0; axis < 3; axis++) {
          minimum[axis] = Math.min(minimum[axis]!, coordinate[axis]!);
          maximum[axis] = Math.max(maximum[axis]!, coordinate[axis]!);
        }
      }
    }
  }
  for (const [entity, minimum] of Object.entries(stage.assembly.minimumEntityInstances)) {
    if ((byEntity.get(entity)?.size ?? 0) < minimum) throw Error(`Experience source is missing required entity ${entity} copies.`);
  }
  if (atomSites > stage.assembly.maximumAtomSites) throw Error('Experience assembly exceeds its declared atom-site budget.');
  if (!minimum.every(Number.isFinite) || !maximum.every(Number.isFinite)) throw Error('Experience assembly has no finite atom coordinates.');
  const span = Math.max(maximum[0]! - minimum[0]!, maximum[1]! - minimum[1]!, maximum[2]! - minimum[2]!);
  if (!Number.isFinite(span) || span > stage.assembly.maximumSpanAngstrom) throw Error('Experience assembly exceeds its declared geometry bound.');
  if (stage.assembly.activeOperatorIds.length) {
    const found = new Set(copies.flatMap((copy: any) => Array.isArray(copy?.operatorIds) ? copy.operatorIds.map(String) : []));
    for (const operator of stage.assembly.activeOperatorIds) if (!found.has(operator)) throw Error(`Experience assembly is missing operator ${operator}.`);
  }
  return { atomSites, spanAngstrom: span, entityInstances: Object.fromEntries([...byEntity].map(([entity, values]) => [entity, values.size])) };
}
