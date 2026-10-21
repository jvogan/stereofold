import { measurementLinesSchema } from './inspection-measure.js';
import { molecularLessonSchema, lessonStartSchema } from './molecular-lesson.js';
// @ts-ignore Shared numerical placement guardrails used by the renderer.
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../../lab/browser-roundtrip/placement-limits.mjs';
// @ts-ignore Shared pure page/host placement envelope.
import { placementFitWithinEnvelope } from '../../lab/browser-roundtrip/placement-fit-envelope.mjs';
import { assertInspectionBudget, MAX_INSPECTION_SCENE_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import { z } from 'zod';
import { INSPECTION_FAILURE_CODES, MAX_INSPECTION_FAILURE_REASON_CHARS } from './inspection-failure-receipt.js';
import { molecularAnimationSchema } from './molecular-animation.js';
import { lessonFigureSchema } from './lesson-figure.js';
// @ts-ignore Shared pure whole-figure style policy used by the live renderer.
import { withFigureRepresentation } from '../../lab/browser-roundtrip/lesson-figure-appearance.mjs';
import { structureSourceSchema, structureSelectionShape, SOURCE_DESCRIPTION } from './structure-sources.js';
import { sessionIdSchema } from './schemas.js';
import { inspectionResidueQuerySchema } from './inspection-residues.js';
// The source-render wait ceiling is the panel save budget's cap.
import { PANEL_SAVE_WAIT } from '../scripts/panel-wait.js';
import { heartbeatDiagnosticsBatchSchema } from './headset-diagnostics.js';
// These validators are the same implementations used by the stock viewer.
// @ts-ignore Shared JavaScript science module.
import { cameraSnapshot } from '../../lab/browser-roundtrip/camera-snapshot.mjs';
// @ts-ignore Shared selection ownership identity used by the renderer.
import { selectionSignature } from '../../lab/browser-roundtrip/selection-paint.mjs';
// @ts-ignore Shared JavaScript inspection module.
import { normalizeAppearance, normalizePlacement } from '../../lab/browser-roundtrip/inspection-state.mjs';
// One definition of what "hidden" means, so the host that
// decides what a request comes back as and the page that takes the rows off the
// screen cannot describe the same picture two different ways.
// @ts-ignore Shared JavaScript inspection module.
import { MAX_HIDDEN_CHAINS, MAX_SCENE_HIDDEN_CHAINS, MAX_VISIBILITY_IDENTIFIER, VISIBILITY_COMPONENT_CLASSES, VISIBILITY_OPS, absentClassNote, absentVisibilityClasses, availableChains, chainIdentityKey, componentClassesPresent, describeVisibility, emptyVisibility, normalizeVisibility, resolveVisibility, sameVisibility, visibilityHidesEverything, visibilityIsEmpty } from '../../lab/browser-roundtrip/inspection-visibility.mjs';
export { MAX_HIDDEN_CHAINS, MAX_SCENE_HIDDEN_CHAINS, VISIBILITY_COMPONENT_CLASSES, VISIBILITY_OPS, absentClassNote,
  absentVisibilityClasses, availableChains, chainIdentityKey, componentClassesPresent,
  describeVisibility, emptyVisibility, normalizeVisibility, resolveVisibility,
  sameVisibility, visibilityHidesEverything, visibilityIsEmpty };
// @ts-ignore Shared JavaScript density module. One derivation of
// a map's scene identity, so the page that saves a density scene and the host
// that admits it cannot disagree about what a map's model and assembly are.
import { volumeSceneIdentity } from '../../lab/browser-roundtrip/volume-source.mjs';

// @ts-ignore Shared renderer/host scoped-style normalization.
import { normalizeStyles, applyScopedStyle } from '../../lab/browser-roundtrip/inspection-styles.mjs';
export { normalizeStyles, applyScopedStyle };

export const INSPECTION_RESOURCE_URI = 'ui://stereo-structure/inspector';
export const PRIVATE_INSPECTION_META_KEY = 'stereo_structure/inspection';
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const experienceRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const inspectInputSchema = z.object({
  sessionId:sessionIdSchema.optional(),
  pdbId:z.string().regex(/^[0-9A-Za-z]{4}$/).optional(),
  structureText:z.string().min(20).max(MAX_STRUCTURE_SOURCE_BYTES).optional(),
  source:structureSourceSchema.describe(SOURCE_DESCRIPTION).optional(),
  ...structureSelectionShape,
}).strict().superRefine((v,ctx)=>{
  const count=[v.pdbId,v.structureText,v.source].filter(v=>v!==undefined).length;
  if(v.sessionId ? count!==0 || v.modelNumber!==undefined || v.assemblyId!==undefined : count!==1)
    ctx.addIssue({code:'custom',message:'Supply exactly one pdbId, structureText, or source; or only a previously returned sessionId.'});
}).meta({anyOf:[
  ...['pdbId','structureText','source'].map(key=>({type:'object',properties:{[key]:{},modelNumber:{},assemblyId:{}},required:[key],additionalProperties:false})),
  {type:'object',properties:{sessionId:{}},required:['sessionId'],additionalProperties:false},
]});
// OpenAI-hosted agents (Codex) drop any tool whose JSON schema carries tuple-form `items` or `minItems`, so
// fixed-length vectors and "at least n" arrays are described as plain arrays and their lengths are checked here.
const exactly = (n:number) => (value:unknown[], ctx:z.RefinementCtx) => { if(value.length!==n) ctx.addIssue({code:'custom',message:`Expected exactly ${n} values.`}); };
const atLeast = (n:number) => (value:unknown[], ctx:z.RefinementCtx) => { if(value.length<n) ctx.addIssue({code:'custom',message:`Expected at least ${n} entries.`}); };
const vector = z.array(z.number().finite()).superRefine(exactly(3)).transform(v => v as [number, number, number]);
// Both cases spelled out: a JSON Schema pattern carries no flags, so /i would advertise lowercase only.
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/**
 * The lesson colour key, as saved state.
 *
 * Named-part emphasis began as a rendering layer with no name in the saved
 * scene: a lesson chapter painted the guide RNA orange and faded everything
 * else, and every other reader of that scene — the desktop panel, a re-entry to
 * VR, the Mol* handoff, the agent asked what the wearer is looking at — saw a
 * plain structure. This is the missing description, and it is deliberately the
 * lesson's own words (part ids, labels, colours, the chain or residue range
 * each part covers) rather than the thousands of resolved row keys those words
 * expand to in one loaded structure.
 */
export const emphasisPartSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(80), color: hex,
  chain: z.string().min(1).max(8).optional(),
  residues: z.object({from: z.number().int(), to: z.number().int()}).strict().optional(),
}).strict().refine(part => part.chain !== undefined || part.residues !== undefined,
  'An emphasis part must name a chain, a residue range, or both.');
/** The most parts one scene's colour key may hold. */
export const EMPHASIS_PART_LIMIT = 32;
const emphasisFields = {
  parts: z.array(emphasisPartSchema).max(EMPHASIS_PART_LIMIT),
  /** The parts held at full strength. Empty is the whole key at full strength. */
  focus: z.array(z.string().min(1).max(80)).max(32),
  /** Parts drawn in their key colour beside the focus; not framed, not explained. */
  alsoLit: z.array(z.string().min(1).max(80)).max(32).optional(),
  /** How faint everything else goes; 0 would hide the complex the part sits in. */
  contextOpacity: z.number().finite().min(0).max(1),
  /**
   * A whole-structure wall chapter steps one lightness per
   * protofilament so three identical strands stay countable. The saved key
   * keeps the authored base colours and carries the flag, because the step is
   * applied at paint time; without it here, a page that saved a shaded chapter
   * had every save and every command receipt refused by this strict object and
   * answered `unsaved` until the wearer left.
   */
  strandShades: z.boolean().optional(),
};
const focusesOwnKey = (value: {parts: {id: string}[]; focus: string[]; alsoLit?: string[]}) =>
  [...value.focus, ...(value.alsoLit ?? [])].every(id => value.parts.some(part => part.id === id));
const FOCUS_MESSAGE = 'An emphasis may only focus or light parts its own colour key names.';
export const emphasisSchema = z.object(emphasisFields).strict().refine(focusesOwnKey, FOCUS_MESSAGE);
export type InspectionEmphasis = z.output<typeof emphasisSchema>;
/**
 * WHO the saved key belongs to, saved with it.
 *
 * The page decides whether a colour key is the lesson's to repaint from who
 * asked for it, and that answer used to live only in a page-lifetime variable.
 * A reload threw it away: the restore that replays a saved scene runs in the
 * hydrate's `built` phase, before the `placed` phase installs the lesson
 * baseline, so nothing on the page could tell a key the lesson itself had
 * painted from one the wearer had asked for by name — and the telomerase
 * lesson came back from every reload with no name plates at all.
 *
 * So the provenance rides in the scene. It is the SAVED key's only, never a
 * command's: `emphasisSchema` above is what `update_inspection` accepts and it
 * is unchanged, so no agent can claim a lesson's ownership of the molecule.
 * Absent means 'command', which is what every scene saved before this says and
 * what a key nobody claimed should mean.
 */
export const emphasisOriginSchema = z.enum(['lesson', 'resting', 'command']);
export const sceneEmphasisSchema = z.object({...emphasisFields, origin: emphasisOriginSchema.optional()})
  .strict().refine(focusesOwnKey, FOCUS_MESSAGE);
/**
 * The four ways a STRUCTURE is drawn.
 *
 * These are representations of atoms, and they are the only ones an agent may
 * ask for: `update_inspection`'s appearance patch is built from this list and
 * nothing else, so no command can name the map representation below.
 */
const STRUCTURE_REPRESENTATIONS = ['cartoon','ball-and-stick','molecular-surface','spacefill'] as const;
/**
 * The one way a DENSITY MAP is drawn, which is `VOLUME_REPRESENTATION` in
 * `volume-source.mjs` and is pinned equal to it by a test.
 *
 * It is not a representation of a structure: a map has no atoms, chains or
 * residues, so nothing in the four above can be built over it, and the page has
 * accepted it in `normalizeAppearance` since the density tier existed. Only the
 * SAVED SCENE admits it, and only on the map's own branch of
 * `assertSceneSource` — which is where the scene has already proved, by digest,
 * that it belongs to this session's map.
 */
export const DENSITY_REPRESENTATION = 'isosurface';
const appearanceFields = { color:z.enum(['chain-id','element-symbol','residue-name','sequence-id','uniform']), uniformColor:hex,
  background:hex, highlightColor:hex, opacity:z.number().finite(), labels:z.boolean(), clipping:z.number().finite(), fog:z.number().finite() };
/** What a panel may SAVE: a structure look, or the map look on a map's scene. */
const sceneAppearanceSchema = z.object({ representation:z.enum([...STRUCTURE_REPRESENTATIONS,DENSITY_REPRESENTATION]), ...appearanceFields }).strict();
/**
 * The words a WEARER uses for those four looks.
 *
 * The menu row a wearer reads is labelled `Surface`, the spoken vocabulary
 * primes "surface", "sticks" and "spacefill", and the contract accepted only
 * `molecular-surface`. On the Quest 2 a wearer asked for the
 * surface and the request was refused with an `invalid_union` zod issue list —
 * schema text reaching a wearer through the model
 * The rule is that a
 * refusal names its limit in plain language, and a zod path does not.
 *
 * So the four canonical values keep their meaning and gain the words that
 * already mean them. The KEY is the word with every run of spaces, hyphens and
 * underscores collapsed to one space, so "ball and stick", "ball-and-stick"
 * and "BALL_AND_STICK" are one entry. Nothing here widens what is SAVED:
 * `sceneAppearanceSchema` above still admits the canonical four and the map's
 * own value, and this transform only ever yields one of the four.
 */
export const REPRESENTATION_WORDS: Readonly<Record<string,typeof STRUCTURE_REPRESENTATIONS[number]>> = Object.freeze({
  'cartoon':'cartoon', 'cartoons':'cartoon', 'ribbon':'cartoon', 'ribbons':'cartoon', 'secondary structure':'cartoon',
  'ball and stick':'ball-and-stick', 'balls and sticks':'ball-and-stick', 'ball stick':'ball-and-stick',
  'stick':'ball-and-stick', 'sticks':'ball-and-stick', 'licorice':'ball-and-stick',
  'surface':'molecular-surface', 'surfaces':'molecular-surface', 'molecular surface':'molecular-surface',
  'solvent accessible surface':'molecular-surface', 'gaussian surface':'molecular-surface',
  'spacefill':'spacefill', 'space filling':'spacefill', 'space fill':'spacefill',
  'sphere':'spacefill', 'spheres':'spacefill', 'atoms':'spacefill', 'cpk':'spacefill',
});
/** The wearer's word with hyphens, underscores and runs of space collapsed to one space. */
export function representationWordKey(value:string):string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s_-]+/gu,' ').trim();
}
/** The canonical representation a wearer's word names, or nothing. */
export function readRepresentationWord(value:unknown):typeof STRUCTURE_REPRESENTATIONS[number]|undefined {
  return typeof value==='string' ? REPRESENTATION_WORDS[representationWordKey(value)] : undefined;
}
const REPRESENTATION_MESSAGE = 'A structure is drawn as a cartoon, as ball and stick, as a molecular surface or as '
  + 'spacefill. The words a wearer says for those are accepted too: ribbon, sticks, surface, spheres. Anything else '
  + 'is refused with this sentence, and a density map has only its isosurface.';
/**
 * `z.unknown()` rather than an enum, for the reason `chainReferentSchema`
 * below states: an enum inside the change union reports its failure as one
 * nested issue list per member and the MCP layer prints it. One refinement is
 * one sentence, and the sentence rides into the tool's JSON schema as the
 * field's description, so the model is told the same thing before it calls.
 */
const representationReferentSchema = z.unknown()
  .superRefine((value,ctx)=>{
    if(readRepresentationWord(value)===undefined) ctx.addIssue({code:'custom',message:REPRESENTATION_MESSAGE});
  })
  .transform(value=>readRepresentationWord(value)!)
  .describe(REPRESENTATION_MESSAGE);
/** What an agent may ASK FOR. Unchanged from before the density tier existed. */
export const commandAppearanceSchema = z.object({ representation:representationReferentSchema, ...appearanceFields }).strict();
export const scopedAppearanceSchema = commandAppearanceSchema.pick({representation:true,color:true,uniformColor:true,opacity:true})
  .extend({opacity:z.number().finite().min(0).max(1)}).partial().refine(value=>Object.keys(value).length>0,'Supply a scoped appearance field.');
export const sceneStylesSchema = z.array(z.object({
  selectionKeys:z.array(z.string().min(1).max(4096)).min(1).max(20000),
  representation:commandAppearanceSchema.shape.representation.optional(),
  color:appearanceFields.color.optional(), uniformColor:hex.optional(), opacity:z.number().finite().min(0).max(1).optional(),
}).strict()).max(8).superRefine((value,ctx)=>{
  try { normalizeStyles(value); } catch(error) { ctx.addIssue({code:'custom',message:(error as Error).message}); }
});
export type InspectionStyles = z.output<typeof sceneStylesSchema>;
const scopedPatchSchema = z.union([scopedAppearanceSchema,z.object({clear:z.literal(true)}).strict()]);
/**
 * WHAT THE WEARER HAS TAKEN OFF THE SCREEN, AS SAVED STATE.
 *
 * A chain is named by the pair `get_inspection_state` prints on every residue
 * row — label chain and copy id — and never by a bare letter. An assembly holds
 * the same label chain more than once, so "hide B" is a guess between copies,
 * and the wearer watching the wrong half of a dimer vanish has no word for what
 * went wrong. The classes are the four nouns a wearer actually says.
 *
 * The list order and the deduplication are fixed by `normalizeVisibility`, and
 * checked here, because a receipt is an exact comparison of saved scenes: two
 * spellings of the same hidden set would be read as a render that did not match
 * the request, and the wearer would be told the change they can see did not
 * happen.
 */
const hiddenChainSchema = z.object({
  labelChain:z.string().min(1).max(MAX_VISIBILITY_IDENTIFIER),
  copyId:z.string().min(1).max(MAX_VISIBILITY_IDENTIFIER),
}).strict();
export const visibilityComponentClassSchema = z.enum(VISIBILITY_COMPONENT_CLASSES as unknown as [string,...string[]]);
export const sceneVisibilitySchema = z.object({
  hiddenChains:z.array(hiddenChainSchema).max(MAX_SCENE_HIDDEN_CHAINS),
  hiddenClasses:z.array(visibilityComponentClassSchema).max(VISIBILITY_COMPONENT_CLASSES.length),
  showOnlySelection:z.boolean(),
}).strict().superRefine((value,ctx)=>{
  let canonical:unknown;
  try { canonical=normalizeVisibility(value); }
  catch(error) { ctx.addIssue({code:'custom',message:(error as Error).message}); return; }
  if(JSON.stringify(canonical)!==JSON.stringify(value))
    ctx.addIssue({code:'custom',message:'A hidden set is written once, deduplicated, chains sorted by label chain then copy id and classes in water, ligand, ion, polymer order.'});
});
export type InspectionVisibility = z.output<typeof sceneVisibilitySchema>;
const placementVector = vector.refine(values=>values.every(value=>Math.abs(value)<=PLACEMENT_MAX_TRANSLATION), 'Placement translation exceeds the numerical range.');
const companionPlacementSchema = z.object({translation:placementVector,rotation:vector,scale:z.number().finite().min(PLACEMENT_MIN_SCALE).max(PLACEMENT_MAX_SCALE)}).strict();
const companionAppearanceSchema = commandAppearanceSchema.pick({representation:true,color:true,uniformColor:true,opacity:true})
  .extend({opacity:z.number().finite().min(0).max(1)});
export const companionStructureSchema = z.object({source:structureSourceSchema,
  sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),modelNumber:z.number().int().positive(),assemblyId:z.string().min(1).max(128),
  placement:companionPlacementSchema,appearance:companionAppearanceSchema}).strict();
export type CompanionStructure = z.output<typeof companionStructureSchema>;
const companionEditSchema = z.object({placement:companionPlacementSchema.partial().optional(),
  appearance:companionAppearanceSchema.partial().optional(),remove:z.literal(true).optional()}).strict()
  .refine(p=>p.remove ? !p.placement && !p.appearance : Boolean(p.placement || p.appearance),'Remove or edit the companion.');
const companionChange = z.object({kind:z.literal('companion-structure'),patch:z.union([companionStructureSchema,companionEditSchema])}).strict();
const companionRequestChange = z.object({kind:z.literal('companion-structure'),patch:companionEditSchema}).strict();
const sceneCoreSchema = z.object({
  sourceSha256:z.string().regex(/^[0-9a-f]{64}$/), modelNumber:z.number().int().positive(), assemblyId:z.string().min(1).max(128),
  selectionKeys:z.array(z.string().min(1).max(4096)).max(20000),
  camera:z.object({ mode:z.enum(['perspective','orthographic']), fov:z.number().finite(), position:vector, target:vector, up:vector,
    radius:z.number().finite(), radiusMax:z.number().finite(), fog:z.number().finite(), clipFar:z.boolean(), minNear:z.number().finite(), minFar:z.number().finite() }).strict(),
  inspection:z.object({
    appearance:sceneAppearanceSchema,
    placement:z.object({ translation:placementVector, rotation:vector, scale:z.number().finite().min(PLACEMENT_MIN_SCALE).max(PLACEMENT_MAX_SCALE) }).strict(),
    // Optional: a panel built before lesson emphasis existed saves none, and a
    // structure wearing no colour key saves an empty one. The saved key may
    // also name its `origin`, which is the only field a scene's emphasis has
    // that a command's may not; read `sceneEmphasisSchema`.
    emphasis:sceneEmphasisSchema.optional(),
    // Optional, and ABSENT means nothing is hidden. A panel
    // built before this field saves none, and a panel that has it omits
    // the field entirely while the whole structure is showing — so the bytes of
    // an ordinary scene are the bytes they always were, and every receipt
    // comparison and saved view written before this still matches exactly.
    visibility:sceneVisibilitySchema.optional(),
    styles:sceneStylesSchema.optional(),
    companionStructure:companionStructureSchema.optional(),
    lessonFigure:lessonFigureSchema.optional(),
    // Static chapter ownership survives removal of its playback clock.
    lessonFigureAnimation:molecularAnimationSchema.optional(),
    measurementLines:measurementLinesSchema.optional(),
    // Sorted-key signature: provenance travels with the saved selection.
    lessonSelection:z.string().max(MAX_INSPECTION_SCENE_BYTES).optional(),
  }).strict(),
}).strict();
/** Coarse sample from the panel that owns the chapter clock, never extrapolated by the host. */
export const animationStateSchema = z.object({
  id:z.string().min(1).max(128), chapterId:z.string().min(1).max(128),
  state:z.enum(['playing','paused']), timeSeconds:z.number().finite().nonnegative(),
  durationSeconds:z.number().finite().positive(), loop:z.boolean(), speed:z.number().finite().positive(),
  representationCounts:z.object({molecular:z.number().int().nonnegative(), moving:z.number().int().nonnegative(),
    added:z.number().int().nonnegative(), annotations:z.number().int().nonnegative(), tethers:z.number().int().nonnegative()}).strict().optional(),
}).strict().refine(value=>value.timeSeconds<=value.durationSeconds,'Animation time exceeds its duration.');
export type AnimationState = z.output<typeof animationStateSchema>;
/** One source-bound baseline; nesting another playback snapshot is forbidden. */
export const lessonPlaybackSchema = z.object({
  tourId:z.string().min(1).max(128), chapterId:z.string().min(1).max(128),
  stopped:z.boolean(), narration:z.boolean().optional(),
  // A start or restart opened this chapter: a peer keeps its wearer's placement.
  entry:z.literal('start').optional(),
  // Fraction already baked into the saved camera; transient ticks stay unsaved.
  motionProgress:z.number().finite().min(0).max(1).optional(), motionPlaying:z.boolean().optional(), cameraFrame:z.enum(['desktop','xr']).optional(), startingScene:sceneCoreSchema,
}).strict();
export type LessonPlayback = z.output<typeof lessonPlaybackSchema>;
export const sceneSchema = sceneCoreSchema.extend({inspection:sceneCoreSchema.shape.inspection.extend({
  lessonPlayback:lessonPlaybackSchema.optional(),
  animation: z.object({definition:molecularAnimationSchema, playback:animationStateSchema}).strict()
    .refine(value => value.definition.durationSeconds === value.playback.durationSeconds, 'Animation duration must match its definition.').optional(),
}).strict()}).strict();
export type InspectionScene = z.output<typeof sceneSchema>;
const namedViewUnitVector=z.array(z.number().finite()).superRefine(exactly(3)).transform(v=>v as [number,number,number]);
export const namedViewIntentSchema=z.object({version:z.literal(1),sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),
  modelNumber:z.number().int().positive(),assemblyId:z.string().min(1).max(128),
  targetOffsetRadii:z.array(z.number().finite().min(-1000).max(1000)).superRefine(exactly(3)).transform(v=>v as [number,number,number]),
  direction:namedViewUnitVector,up:namedViewUnitVector,
  distanceInRadii:z.number().finite().positive().max(100000),verticalSpanRadii:z.number().finite().positive().max(100000),
}).strict().superRefine((value,ctx)=>{
  const norm=(v:readonly number[])=>Math.hypot(...v),dot=value.direction.reduce((sum,n,index)=>sum+n*value.up[index],0);
  if(Math.abs(norm(value.direction)-1)>1e-5)ctx.addIssue({code:'custom',message:'direction must be normalized.'});
  if(Math.abs(norm(value.up)-1)>1e-5)ctx.addIssue({code:'custom',message:'up must be normalized.'});
  if(Math.abs(dot)>1e-5)ctx.addIssue({code:'custom',message:'direction and up must be orthogonal.'});
});
export type NamedViewIntent=z.output<typeof namedViewIntentSchema>;
/**
 * What a saved scene must match when the session draws a map.
 *
 * A density session opens beside real coordinates — the catalog, the residue
 * rows and every agent query run on them are the seed structure's, and stay
 * the seed structure's. What the wearer SEES is the map, so the scene the page
 * saves names the map's own identity, and checking it against the catalog's
 * coordinates would refuse every scene a density panel can produce. The
 * identity itself comes from `volumeSceneIdentity`, the page's own derivation,
 * so the two ends cannot drift apart.
 *
 * The selection is held empty rather than checked against the catalog. A map
 * has no residue rows to name: the page's `selectedKeys` answers `[]` for a
 * density scene and fails an explicitly named key, and admitting one here would
 * let a saved scene claim a selection the panel cannot draw.
 *
 * A DENSITY SESSION HAS TWO RENDERERS, AND THEY DRAW DIFFERENT
 * BYTES. The map is 8.4 MB of binary and cannot ride inside the JSON hydration
 * a desktop panel is handed, so only a companion fetches `/density` and only a
 * companion draws the grid; the Mac's own panel draws the seed coordinates the
 * session opened beside. That means the scene a desktop panel saves legitimately carries the
 * CATALOG's digest, model and assembly. Admitting only the map's identity
 * refused every save the Mac's panel could make: the desktop blocked, `attach()`
 * was skipped, and a filament run timed out after 120 s waiting for
 * a panel that was never going to register.
 *
 * So a density session admits either of its two real sources and nothing else.
 * Which branch a scene takes is decided by its own digest, which is the one
 * field neither renderer can choose freely — the map's digest is checked over
 * the map bytes three times before a parse, and the catalog's is verified
 * against the coordinates the panel was handed. An atomic session still admits
 * exactly one identity, by the same lines it always did.
 */
function assertSceneSource(scene: InspectionScene, catalog: any, density?: {sha256:string}): void {
  const map = density
    ? volumeSceneIdentity(density) as {sourceSha256:string|null;modelNumber:number|null;assemblyId:string|null}
    : undefined;
  if (map && scene.sourceSha256 === map.sourceSha256) {
    if (scene.inspection.lessonFigure) throw Error('A density map cannot restore atomic lesson figures.');
    if (scene.modelNumber !== map.modelNumber || scene.assemblyId !== map.assemblyId)
      throw Error('The inspection must match this exact density map.');
    if (scene.selectionKeys.length) throw Error('A density map has no residues to select.');
    if (scene.inspection.styles?.length) throw Error('A density map has no residues to style.');
    // The mirror of the line above. An isosurface at one
    // contour is a single mesh with no chains and no components in it, so a
    // scene claiming to have hidden one is describing a picture no panel draws.
    if (scene.inspection.visibility) throw Error('A density map has no chains or components to hide.');
    // The map's look is the map's own, and only here. The
    // grid has no atoms to build the other four over, so a scene claiming one
    // of them for the map would be describing a picture no panel can draw.
    if (scene.inspection.appearance.representation !== DENSITY_REPRESENTATION)
      throw Error('A density map is drawn as an isosurface and nothing else.');
    return;
  }
  // The mirror of the rule above: coordinates are never drawn as an isosurface.
  // Every non-map scene on every session, density or atomic, is held to the
  // four structure representations the schema admitted before the density tier
  // existed, so widening the saved scene for the map widened nothing else.
  if (scene.inspection.appearance.representation === DENSITY_REPRESENTATION)
    throw Error('Only a density map is drawn as an isosurface.');
  if (scene.sourceSha256 !== catalog.source.sha256 || !catalog.modelNumbers.includes(scene.modelNumber) || scene.assemblyId !== catalog.assemblyId)
    throw Error(map
      ? 'The inspection must match this session’s density map, or the exact coordinates, model and assembly it opened beside.'
      : 'The inspection must match this exact structure, model and assembly.');
  const valid = new Set(catalog.rows.filter((r:any) => r.identity.modelNumber === scene.modelNumber).map((r:any) => r.key));
  if (new Set(scene.selectionKeys).size !== scene.selectionKeys.length || scene.selectionKeys.some(key => !valid.has(key)))
    throw Error('Selection keys must be unique canonical identities from this model.');
  for (const style of scene.inspection.styles ?? [])
    if (style.selectionKeys.some(key=>!valid.has(key)))
      throw Error('Style keys must be canonical identities from this model.');
  // A hidden chain is a canonical identity from this model, on
  // exactly the terms a selection key is. Admitting a chain letter the catalog
  // does not have would let a saved scene claim a picture the panel cannot draw
  // and could never reproduce on restore.
  const chains = new Set(availableChains(catalog.rows, scene.modelNumber).map((chain:any) => chainIdentityKey(chain)));
  for (const chain of scene.inspection.visibility?.hiddenChains ?? [])
    if (!chains.has(chainIdentityKey(chain)))
      throw Error('A hidden chain must be a canonical label chain and copy id from this model.');
}
export function validateScene(value: unknown, catalog: any, density?: {sha256:string}): InspectionScene {
  const scene = sceneSchema.parse(value);
  assertInspectionBudget(scene,MAX_INSPECTION_SCENE_BYTES,'Inspection snapshot');
  cameraSnapshot(scene.camera); normalizeAppearance(scene.inspection.appearance); normalizePlacement(scene.inspection.placement);
  if(scene.inspection.lessonSelection !== undefined && scene.inspection.lessonSelection !== selectionSignature(scene.selectionKeys))
    throw Error('Lesson selection ownership must match the saved selection keys.');
  // "nothing is hidden" has exactly one spelling, which is the
  // absent field. A scene carrying an explicitly empty hidden set describes the
  // same picture with different bytes, and the receipt comparison would read
  // that as a render that did not match the request.
  if (scene.inspection.visibility && visibilityIsEmpty(scene.inspection.visibility))
    throw Error('A scene with nothing hidden leaves inspection.visibility out rather than saving an empty one.');
  if (scene.inspection.styles?.length) scene.inspection.styles=normalizeStyles(scene.inspection.styles);
  else delete scene.inspection.styles;
  assertSceneSource(scene, catalog, density);
  if(scene.inspection.lessonPlayback) {
    const start=scene.inspection.lessonPlayback.startingScene;
    if(start.sourceSha256!==scene.sourceSha256 || start.modelNumber!==scene.modelNumber || start.assemblyId!==scene.assemblyId)
      throw Error('The lesson starting view must match the saved scene source, model and assembly.');
    scene.inspection.lessonPlayback.startingScene=validateScene(start,catalog,density);
  }
  if(scene.inspection.measurementLines) {
    const atoms=new Map(catalog.rows.filter((row:any)=>row.identity.modelNumber===scene.modelNumber)
      .flatMap((row:any)=>row.atomSites.map((atom:any)=>[atom.key,atom])));
    const ids=new Set();
    for(const line of scene.inspection.measurementLines) {
      if(ids.has(line.id)) throw Error('Measurement ids must be unique.');
      ids.add(line.id);
      for(const endpoint of [line.a,line.b]) {
        const atom:any=atoms.get(endpoint.key);
        if(!atom || endpoint.authorChain!==atom.identity.authorChain
          || (endpoint.authorResidue!==undefined && endpoint.authorResidue!==atom.identity.authorResidue)
          || (endpoint.componentId!==undefined && endpoint.componentId!==atom.identity.componentId)
          || inspectionJson(endpoint.position)!==inspectionJson(atom.assemblyCoordinatesAngstrom))
          throw Error('Measurement endpoints must match the current model and assembly atoms.');
      }
    }
  }
  return scene;
}
export const inspectionBindingSchema = z.object({ sessionId:sessionIdSchema, serverEpoch:z.string().uuid(),
  baseStateRevision:revisionSchema, baseInspectionRevision:revisionSchema, sourceToken:z.string().uuid() }).strict();
/**
 * The binding a model-facing edit may leave out. The host fills each field
 * with the value current when the call arrives, so a dictated edit is one call
 * rather than a state read and six copied fields. A caller that sends them
 * keeps the stale-revision check exactly as before.
 */
export const IMPLICIT_BINDING_FIELDS = ['serverEpoch','sourceToken','baseStateRevision','baseInspectionRevision','panelId','commandId'] as const;
/** Rides on each field the host fills, so a model reading the schema knows it may leave it out. */
export const IMPLICIT_BINDING_NOTE = 'Optional: left out, the host uses the current value.';
/** Rides on `sessionId` where a voice request's utteranceId can stand in for it. */
export const UTTERANCE_SESSION_NOTE = 'Optional with utteranceId: the host uses that voice request\'s session.';
export function withImplicitBinding<T extends z.ZodObject<any,any>>(schema:T, utteranceSession=false) {
  const shape=schema.shape as Record<string,z.ZodType>;
  // Only a field the strict schema requires is filled; an optional one stays the caller's.
  return schema.extend({...Object.fromEntries(IMPLICIT_BINDING_FIELDS
    .filter(key=>key in shape && !shape[key]!.safeParse(undefined).success)
    .map(key=>[key,shape[key]!.optional().describe(IMPLICIT_BINDING_NOTE)])),
    // A recorded utterance already names its session, so a voice edit may carry only its ID.
    ...(utteranceSession && 'utteranceId' in shape && 'sessionId' in shape ? {sessionId:shape.sessionId!.optional().describe(UTTERANCE_SESSION_NOTE)} : {})} as any);
}
/** The longest an edit's own call waits for its receipt: a claimed render's deadline. */
export const COMMAND_WAIT_CEILING_MS = 120_000;
export const commandWaitSchema = z.number().int().min(0).max(COMMAND_WAIT_CEILING_MS).optional()
  .describe('Wait up to this many ms for the panel to render the change and return its receipt in this call. 10000 covers a normal edit.');
export const tourCommandClaimSchema = inspectionBindingSchema.omit({sessionId:true}).extend({
  panelId:z.string().uuid(),commandId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),claimToken:z.string().uuid(),
}).strict();
const journeySaveClaimSchema = z.object({panelId:z.string().uuid(),rollbackToken:z.string().uuid()}).strict();
export type JourneySaveClaim = z.output<typeof journeySaveClaimSchema>;
export const syncInspectionSchema = inspectionBindingSchema.extend({scene:sceneSchema,panelId:z.string().uuid().optional(),tourCommand:tourCommandClaimSchema.optional(),
  journeySave:journeySaveClaimSchema.optional()}).strict();
/**
 * How the host itself puts the companion page on the headset once a private
 * Wi-Fi listener is running.
 *
 * "auto" uses a verified authorized Quest when available, then Meta Web
 * Launch for Meta or generic manual pairing for an unknown headset. Apple
 * uses the Safari handoff. "web" explicitly asks for Meta Web Launch.
 * "adb" uses authorized USB or Wi-Fi debugging.
 * "none" leaves the printed address alone.
 *
 * Neither route is reachable from the headset: the tools that carry this field
 * are model-side only and are absent from the companion dispatch table, so a
 * paired browser cannot ask this Mac to launch anything.
 */
export const companionHeadsetSchema = z.enum(['auto','meta','apple']).default('auto');
export const companionLaunchModeSchema = z.enum(['auto','web','adb']);
export const companionLaunchSchema = z.enum(['none','auto','web','adb']).default('none');
export type CompanionLaunchMode = z.output<typeof companionLaunchModeSchema>;
export type CompanionHeadset = z.output<typeof companionHeadsetSchema>;
/**
 * Experience navigation may replace coordinates and assembly. A control_tour
 * claim follows that explicit transition through its experience acknowledgement;
 * ordinary scene receipts remain bound to their original source.
 */
export const inspectExperienceSchema = z.object({experienceId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu)}).strict();
/** The headset classes `input-capabilities.mjs` can report. */
export const headsetDeviceClassSchema = z.enum(['quest2','quest3','quest-pro','vision-pro','hand-only','unknown']);
export const navigateExperienceSchema = inspectionBindingSchema.extend({
  tourCommand:tourCommandClaimSchema.optional(),
  panelId:z.string().uuid(),
  /**
   * The paired headset's class, as `grow_structure` takes it. It decides which
   * historical geometry advisory for a chapter; omitted, the paired LAN peer's
   * class is used. Only `quest2` currently has advisory thresholds.
   */
  device:headsetDeviceClassSchema.optional(),
  baseExperienceRevision:experienceRevisionSchema,
  loadedSourceOnly:z.boolean().optional(),
  finish:z.boolean().optional(),
  rollbackToken:z.string().uuid().optional(),
  experienceId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  stepIndex:z.number().int().nonnegative().max(255),
}).strict();
/**
 * The longest a `replace_inspection_source` caller may ask the host to wait.
 *
 * Exactly `PANEL_SAVE_WAIT.capMs`: past that the host would not wait either,
 * because past three minutes the honest answer is that something is wrong
 * rather than that the structure is large.
 */
export const SOURCE_RENDER_WAIT_CEILING_MS = PANEL_SAVE_WAIT.capMs;
const replaceInspectionSourceFields = inspectionBindingSchema.extend({
  panelId:z.string().uuid(),
  utteranceId:z.string().uuid().optional(),
  mode:z.enum(['replace','compare']).default('replace'),
  align:z.enum(['side-by-side','superpose']).optional(),
  commandId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  /**
   * The ceiling is the host's own longest render budget,
   * not a round number.
   *
   * It used to be 30 s. The host budgets `panelWaitMs(atomSites,
   * PANEL_SAVE_WAIT)` for a panel to load and save one source — 130 s for the
   * 4,779 sites of 4HHB — so a caller asking to be told when the wearer can
   * see the new structure could not ask for long enough, and "go back to
   * hemoglobin" timed out at 25 s while the headset rendered it
   * correctly. `SOURCE_RENDER_WAIT_CEILING_MS` is that budget's own cap, so
   * the largest number a caller may send is exactly the largest number the
   * host would ever wait. The host still clamps what it was sent down to the
   * budget for the source actually being loaded, and states that budget back.
   */
  waitForRenderMs:z.number().int().min(0).max(SOURCE_RENDER_WAIT_CEILING_MS).optional(),
  pdbId:z.string().regex(/^[A-Za-z0-9]{4}$/u).optional(),
  demo:z.string().min(1).max(128).optional().describe('Bundled demo name from demos/index.json. Loads verified coordinates and starts its lesson in this session.'),
  stage:z.string().min(1).max(128).optional().describe('Optional indexed stage, for example motion or monomer; only with demo.'),
  source:structureSourceSchema.describe(SOURCE_DESCRIPTION).optional(),
  ...structureSelectionShape,
}).strict();
const oneSource = (v:{pdbId?:unknown;source?:unknown;demo?:unknown;stage?:unknown;mode?:string;modelNumber?:number;assemblyId?:string;align?:string}) =>
  [v.pdbId,v.source,v.demo].filter(value=>value!==undefined).length===1
  && (v.stage===undefined || v.demo!==undefined)
  && (v.demo===undefined || (v.mode!=='compare' && v.modelNumber===undefined && v.assemblyId===undefined && v.align===undefined));
export const replaceInspectionSourceSchema = replaceInspectionSourceFields.refine(oneSource,'Supply exactly one pdbId, source or demo. stage requires demo; demo uses its indexed model/assembly and cannot compare.');
export const replaceInspectionSourceRequestSchema = withImplicitBinding(replaceInspectionSourceFields).refine(oneSource,'Supply exactly one pdbId, source or demo. stage requires demo; demo uses its indexed model/assembly and cannot compare.');
/**
 * One step up or down a staged demo, inside the session the wearer is already in.
 *
 * `stage` is `next`, `back`, `first`, `last`, or the exact id of a tier.
 * `device` is the paired headset's class; it is what decides whether a tier is
 * refused. Only `quest2` has a measured ceiling, so only `quest2` is refused;
 * a class this Mac has not identified is not held to a ceiling it was never
 * measured against.
 */
export const growStructureSchema = inspectionBindingSchema.extend({
  panelId:z.string().uuid(),
  stage:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  device:headsetDeviceClassSchema.optional(),
}).strict();
export type GrowStructureDevice = NonNullable<z.input<typeof growStructureSchema>['device']>;
/**
 * The arguments the headset page posts for one grow. The companion `/tool`
 * route accepts only this shape: the panel's own id, the current binding, the
 * requested stage, and the paired headset class that sets the tier ceiling.
 *
 * A 409 "panel unavailable / rendering another command" is
 * not a refusal of this body. The page re-reads these binding fields and
 * posts the same shape again.
 */
export function growStructureRequest(
  binding:{sessionId:string;serverEpoch:string;sourceToken:string;baseStateRevision:number;baseInspectionRevision:number},
  panelId:string, stage:string, device?:GrowStructureDevice,
) {
  return growStructureSchema.parse({...binding,panelId,stage,...(device?{device}:{})});
}
export const tourStateSchema = z.object({selectedId:z.string().max(128).optional(),step:z.number().int().min(-1).max(1000),
  total:z.number().int().min(0).max(1000),active:z.boolean(),autoplay:z.boolean(),narration:z.boolean().optional(),navigating:z.boolean()}).strict();
export const acknowledgeExperienceStepSchema = inspectionBindingSchema.extend({
  tourState:tourStateSchema.optional(),
  tourCommand:tourCommandClaimSchema.optional(),
  panelId:z.string().uuid(),
  completionToken:z.string().uuid().optional(),
  reconcileEnded:z.literal(true).optional(),
  experienceId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  experienceRevision:experienceRevisionSchema,
  stepIndex:z.number().int().nonnegative().max(255),
}).strict();
/**
 * One headset grip event. The only field a request carries is which edge it
 * is; nothing here names a command, a device, or any audio.
 */
/**
 * WHAT THE PERSON MEANT BY "THIS", captured when they started
 * asking rather than when the answer came back.
 *
 * A spoken request takes seconds to transcribe and seconds more for a model to
 * answer. In that window the wearer moves on: they select something else, the
 * lesson steps to a new chapter, they point at another part. A tool that reads
 * the live selection at that point acts on whatever is under the pointer now,
 * which is how "fade this one" ended up fading the wrong chain.
 *
 * So the referent is taken at the start of the request and travels with it.
 * `sourceToken` is on it because a referent captured on another structure
 * describes nothing in this one, and is refused rather than resolved.
 */
export const requestReferentSchema = z.object({
  sourceToken:z.string().uuid(),
  capturedAt:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  modelNumber:z.number().int().positive().optional(),
  assemblyId:z.string().min(1).max(128).optional(),
  selectionKeys:z.array(z.string().min(1).max(4096)).max(20000),
  /**
   * A TOUR'S SELECTION MUST NOT RIDE INSIDE A TOOL RESULT.
   *
   * A tour chapter can select hundreds of residues, and a referent carrying
   * every canonical key made one `listen_voice` result 102,986 characters —
   * past what a model client will hand to a model at all, so the words the
   * wearer spoke never arrived. The captured keys therefore stay on this Mac,
   * held under `selectionDigest`, and only a sample of them travels.
   *
   * `truncated` says the inline `selectionKeys` are that sample and
   * `selectionCount` how many were captured. Echo the referent back exactly as
   * it was given: the captured keys are put back here before anything is
   * validated, targeted or applied, so what the request acts on is the whole
   * capture and never the sample.
   */
  selectionCount:z.number().int().min(0).max(20000).optional(),
  selectionDigest:z.string().regex(/^[0-9a-f]{32}$/u).optional(),
  truncated:z.literal(true).optional(),
  /** The lesson part the wearer was pointing at or had lit. */
  partId:z.string().min(1).max(80).optional(),
  /** The one residue under the pointer, when the page reported one. */
  residueKey:z.string().min(1).max(4096).optional(),
}).strict();
export type RequestReferent = z.output<typeof requestReferentSchema>;
/** What the headset page may report about where the wearer is pointing. */
export const requestPointingSchema = z.object({
  partId:z.string().min(1).max(80).optional(),
  residueKey:z.string().min(1).max(4096).optional(),
}).strict().refine(value=>value.partId!==undefined || value.residueKey!==undefined,
  'Name the part or the residue the wearer is pointing at.');
export type RequestPointing = z.output<typeof requestPointingSchema>;
/** The words a caller may use for the captured referent instead of a name. */
export const REFERENT_PRONOUNS = Object.freeze(['this','that','this part','that part','it','this one','that one']);
export const pushToTalkSchema = z.object({ sessionId:sessionIdSchema, state:z.enum(['down','up']),
  // What the wearer was pointing at as the grip went down. The
  // down edge IS the start of the request, so this is the only honest moment
  // to read it. Optional: a page that reports nothing still captures the
  // selection, and a page built before this sends the same two fields it did.
  pointing:requestPointingSchema.optional() }).strict();
export type PushToTalkInput = z.output<typeof pushToTalkSchema>;
export const tourActionSchema = z.object({
  action:z.enum(['start','next','back','play','pause','menu','rejoin','restore-start','done']),
  // Membership is checked against this session's bundled and custom lessons.
  tourId:z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i).optional(),
  // Omitted preserves timed playback; false holds the first rendered chapter.
  autoplay:z.boolean().optional(),
  narration:z.boolean().optional(),
}).strict().refine(v=>v.action==='start' ? Boolean(v.tourId) : v.tourId===undefined,
  'start requires tourId; other actions use the target panel’s current tour.')
  .refine(v=>v.action==='start'||v.autoplay===undefined,'autoplay is only valid with start.')
  .refine(v=>v.action==='start'||v.narration===undefined,'narration is only valid with start.');
const nonempty = (value:object) => Object.keys(value).length > 0;
// `commandAppearanceSchema`, not the scene's own appearance.
// The saved scene admits the map representation; a command must not be able to
// ask a panel drawing atoms for an isosurface it cannot build, and a panel
// drawing a map already refuses every representation change in the viewer
// ("This scene is a density map; its isosurface is the only representation it
// has", viewer.mjs). This list is what it was before the density tier existed.
const appearanceChange = z.object({kind:z.literal('appearance'), patch:commandAppearanceSchema.partial().refine(nonempty,'Supply at least one appearance field.')}).strict();
/**
 * A region named the way `get_inspection_state` pages one: a chain, a
 * component, a class or a residue range. The host resolves it to canonical keys
 * against the saved model, so coloring a chain is one call rather than a page
 * of keys the agent reads, copies and sends back.
 */
export const regionQuerySchema = inspectionResidueQuerySchema
  .omit({offset:true,limit:true,selectedOnly:true}).refine(nonempty,'Name a chain, a component, a class or a residue range.');
const appearanceRequestChange = z.object({kind:z.literal('appearance'),scope:z.literal('selection').optional(),
  residues:regionQuerySchema.optional(),
  patch:z.union([commandAppearanceSchema.partial().refine(nonempty,'Supply an appearance field.'),z.object({clear:z.literal(true)}).strict()]),
}).strict().superRefine((value,ctx)=>{
  if(value.residues!==undefined && value.scope==='selection')
    ctx.addIssue({code:'custom',message:'Name residues or use scope:"selection", not both.'});
  else if(value.scope==='selection' || value.residues!==undefined) {
    const checked=scopedPatchSchema.safeParse(value.patch);
    if(!checked.success) ctx.addIssue({code:'custom',message:`${value.residues?'A region':'Selection'} appearance supports representation, color, uniformColor, opacity, or clear:true.`});
  } else if('clear' in value.patch) ctx.addIssue({code:'custom',message:'clear:true requires scope:"selection" or residues.'});
});
/** Resolved styles travel whole, so restore and undo need no selection memory. */
const stylesChange = z.object({kind:z.literal('styles'),patch:z.object({styles:sceneStylesSchema,
  selectionKeys:sceneSchema.shape.selectionKeys.optional(),style:scopedPatchSchema.optional()}).strict()}).strict();
const placementFields = sceneSchema.shape.inspection.shape.placement.partial();
/** A placement inside a compound: numbers only, because a Reset is a render of its own. */
const placementOpChange = z.object({kind:z.literal('placement'), patch:placementFields.refine(nonempty,'Supply at least one placement field.')}).strict();
/**
 * `{recenter:true}` is the headset's own Reset, asked for by an
 * agent.
 *
 * A wearer who says "I can't see it" or "it's behind me" needs the structure
 * back where entering VR put it, and that seat is solved from their head pose
 * and the room's floor, which only the page has. So the request carries no
 * numbers: the panel runs the Reset the menu row and a held B or Y run, and
 * the placement it saves is the answer rather than the request.
 */
const placementChange = z.object({kind:z.literal('placement'), patch:placementFields.extend({recenter:z.literal(true).optional()})
  .refine(nonempty,'Supply at least one placement field.')
  .refine(value=>value.recenter===undefined || Object.keys(value).length===1,'recenter:true is the whole placement; send no numbers with it.')}).strict();
/** Whether a change asks for the headset's Reset rather than for numbers. */
export function isRecenterChange(change:{kind:string;patch?:unknown}):boolean {
  return change.kind==='placement' && (change.patch as {recenter?:unknown}|undefined)?.recenter===true;
}
const selectionChange =z.object({kind:z.literal('selection'), patch:z.object({selectionKeys:sceneSchema.shape.selectionKeys}).strict()}).strict();
/** What a caller may send: keys it already holds, or a region the host resolves to them. */
const selectionRequestChange = z.object({kind:z.literal('selection'), patch:z.object({
  selectionKeys:sceneSchema.shape.selectionKeys.optional(), residues:regionQuerySchema.optional()}).strict()
  .refine(value=>(value.selectionKeys===undefined)!==(value.residues===undefined),'Supply selectionKeys or residues.')}).strict();
const lessonChange = z.object({kind:z.literal('lesson'), patch:z.object({lesson:molecularLessonSchema, start:lessonStartSchema.optional(), frame:z.union([z.boolean(),z.literal('auto')]).optional()}).strict()}).strict();
const tourChange = z.object({kind:z.literal('tour'), patch:tourActionSchema}).strict();
/**
 * Bring an already-identified region into view, at a named framing.
 *
 * This is not camera control and does not become it. The wearer's head pose
 * stays theirs; what a panel moves is the same saved placement a grab bakes,
 * so the region ends up in front of the wearer at the asked-for angular size.
 * A desktop panel has no wearer and uses Mol*'s own focus on the loci.
 *
 * The caller names the region, never the pose: `framing` is an angle the
 * renderer solves for from geometry it already has, and no coordinate,
 * distance or camera value crosses this schema in either direction.
 */
export const focusFramingSchema = z.enum(['fill','context']);
const focusChange = z.object({kind:z.literal('focus'), patch:z.object({
  selectionKeys:sceneSchema.shape.selectionKeys.min(1), framing:focusFramingSchema}).strict()}).strict();
/**
 * The only command that moves a panel's viewpoint, and the return leg of the
 * full Mol* viewer: a complete stock camera snapshot replayed through the same
 * restore the desktop's Load saved view uses. Appearance, placement and
 * selection are untouched, so it cannot carry a scene change.
 */
const cameraChange = z.object({kind:z.literal('camera'), patch:z.object({camera:sceneSchema.shape.camera}).strict()}).strict();
const animationRequestChange = z.object({kind:z.literal('animation'),patch:z.object({
  state:z.enum(['play','pause']).optional(), speed:z.number().finite().min(0.1).max(4).optional(),
  seekSeconds:z.number().finite().nonnegative().optional(), loop:z.boolean().optional(), restart:z.literal(true).optional(),
}).strict().refine(patch=>Object.keys(patch).length>0,'Choose an animation control.')}).strict();
// The host binds the command to the installed chapter before handing it to the panel.
const animationChange = animationRequestChange.extend({target:z.object({
  id:z.string().min(1).max(128),chapterId:z.string().min(1).max(128),
}).strict().optional()});
/**
 * Presentation motion: the slow turntable spin a wearer asks for with "spin
 * it" and stops with "stop". `spin` saves nothing; `stop` bakes the angle the
 * panel was showing into the saved placement, exactly as the wearer's own
 * pause does, so the placement a stop reports is the renderer's answer.
 *
 * Those two phrases now also resolve in the headset's own fixed
 * grammar, so the wearer gets the turn at transcription latency without a round
 * trip to the Mac. This command is the agent's route to the same two states —
 * for a tour chapter, or for a wearer who asked the agent rather than the page —
 * and both routes speak the same two words, "Spinning." and "Stopped.".
 */
export const motionStateSchema = z.enum(['spin','stop']);
const motionChange = z.object({kind:z.literal('motion'), patch:z.object({state:motionStateSchema}).strict()}).strict();
/**
 * How much the renderer is allowed to spend per frame, exposed as a menu
 * setting so the wearer can force better quality from inside the headset.
 *
 * The level is a budget, not a look: it names representation detail,
 * framebuffer scale and immersive postprocessing together, and the panel
 * resolves the three from its own device class and current representation.
 * `balanced` is the default; frame rate depends on the scene and device.
 * `best` spends more on geometry and passes at the wearer's choice; `fast` is
 * the cheapest tier. Nothing that is saved changes, so a level cannot smuggle
 * a scene edit.
 */
export const renderQualityLevelSchema = z.enum(['fast','balanced','best']);
const renderQualityChange = z.object({kind:z.literal('render-quality'), patch:z.object({level:renderQualityLevelSchema}).strict()}).strict();
/**
 * Light one or more named parts of the loaded lesson, or clear the emphasis.
 *
 * The patch carries the whole colour key, not just the focused ids, because the
 * key is what the wearer has learned: lighting the guide RNA inside the same
 * grey-protein, orange-RNA mapping it has had all lesson is a different picture
 * from repainting the structure around it. The server expands the part names a
 * caller says into this key from the loaded lesson, so no caller has to know a
 * chain letter or a residue range to ask for a part by name.
 */
const emphasisChange = z.object({kind:z.literal('emphasis'), patch:emphasisSchema}).strict();
/**
 * Hide part of the structure, as one saved, undoable state.
 *
 * This is the RESOLVED change, the one the panel runs: the whole hidden set
 * after the edit, not the edit. A caller writes `visibilityRequestChange` below
 * — hide, show, only, reset — and the host folds it into this against the
 * chains the model actually has, exactly as it expands a lesson part name into
 * the whole colour key for `emphasis`. The panel therefore never has to know
 * what was hidden a moment ago to draw what is hidden now, an undo is one more
 * of these carrying the earlier set, and a named view restores by replay.
 */
const visibilityChange = z.object({kind:z.literal('visibility'), patch:sceneVisibilitySchema}).strict();
/**
 * The visibility op AS A CALLER WRITES IT.
 *
 * `hide` and `show` move named things in and out of the hidden set. `only`
 * hides everything the request did not name, which is how "show only the
 * ligand" is one command rather than a list of every chain to hide. `reset`
 * brings the whole structure back.
 *
 * A chain is named by the label chain and copy id `get_inspection_state` prints
 * on its residue rows, or by the label chain letter alone where this model has
 * only one chain by that letter. The pair exists because a letter is ambiguous
 * across the copies of an assembly; where it is not ambiguous, the host
 * resolves it, and where it is absent or ambiguous it refuses in a sentence
 * naming the chains there are, rather than sending a panel a request with no
 * picture in it. See `chainReferentSchema` below.
 */
/**
 * How a CALLER may name a chain, as opposed to how one is saved.
 *
 * A bare `"A"` used to fail zod before any of this file's own rules ran, and
 * the MCP layer answered with the raw issue list — `expected object,
 * invalid_type, path change.patch.chains.0` — which is schema text reaching a
 * wearer through the model. The
 * rule is that a refusal names its limit in plain language, and a zod
 * path does not.
 *
 * So the referent is checked here only for being a shape this build can read,
 * with one sentence when it is not, and `resolveVisibility` turns it into the
 * canonical `{labelChain, copyId}` pair against the chains the model actually
 * has. That resolution is the only place a letter becomes an identity, and it
 * refuses an absent or ambiguous letter by naming the chains there are. What a
 * receipt carries is unchanged: `sceneVisibilitySchema` above still admits the
 * pair and nothing else, so no widening here can reach a saved scene.
 */
const CHAIN_REFERENT_MESSAGE = 'Name a chain by its label chain letter, such as "A" or "chain A", or by the '
  + '{labelChain, copyId} pair get_inspection_state prints on its residue rows. A letter this model does not '
  + 'have, or one that several copies of the assembly answer to, is refused with the chains it does have.';
/**
 * `z.unknown()` rather than a union of the readable shapes, because a union
 * reports a failure as one nested issue list per member and the MCP layer
 * prints it — which is the dump this whole comment is about. One refinement is
 * one sentence, and the sentence rides into the tool's JSON schema as the
 * field's description, so the model is told the same thing before it calls.
 */
export const chainReferentSchema = z.unknown()
  .superRefine((value,ctx)=>{
    const readable = typeof value === 'string'
      ? value.trim().length > 0 && value.length <= MAX_VISIBILITY_IDENTIFIER + 6
      : Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if(!readable) ctx.addIssue({code:'custom',message:CHAIN_REFERENT_MESSAGE});
  }).describe(CHAIN_REFERENT_MESSAGE);
export const visibilityRequestPatchSchema = z.object({
  op:z.enum(VISIBILITY_OPS as unknown as [string,...string[]]),
  chains:z.array(chainReferentSchema).max(MAX_HIDDEN_CHAINS).optional(),
  classes:z.array(visibilityComponentClassSchema).max(VISIBILITY_COMPONENT_CLASSES.length).optional(),
  /** Only with op="only" (show just the selection) or op="show" (stop doing that). */
  selection:z.boolean().optional(),
}).strict().superRefine((value,ctx)=>{
  const named=Boolean(value.chains?.length || value.classes?.length);
  if(value.op==='reset' && (named || value.selection!==undefined))
    ctx.addIssue({code:'custom',message:'A reset brings everything back and names nothing.'});
  if(value.op==='hide' && value.selection!==undefined)
    ctx.addIssue({code:'custom',message:'Use op="only" with selection=true to show only the selection.'});
  if((value.op==='hide'||value.op==='show') && !named && value.selection!==true)
    ctx.addIssue({code:'custom',message:`Name a chain or a component class to ${value.op}.`});
  if(value.op==='only' && !named && value.selection!==true)
    ctx.addIssue({code:'custom',message:'Name a chain, a component class, or the selection to show only.'});
  if(value.op==='only' && named && value.selection===true)
    ctx.addIssue({code:'custom',message:'Showing only the selection names nothing else.'});
});
const visibilityRequestChange = z.object({kind:z.literal('visibility'), patch:visibilityRequestPatchSchema}).strict();
export type VisibilityRequestPatch = z.output<typeof visibilityRequestPatchSchema>;
/**
 * Several edits asked for in one breath, applied as one thing.
 *
 * "Make this RNA orange, fade the rest and enlarge it" is one request. Sent as
 * three commands it is three renders the wearer watches step through pictures
 * nobody asked for, three confirmations over each other, and three separate
 * things to take back. As one change it is one render, one line and one undo.
 *
 * The ops are the same single-edit patches this union already carries, so
 * every rule that governs one of them governs it inside a compound too, and
 * `expectedInspection` folds them in the order they are written. Each field may
 * appear once: a request that sets the opacity twice has not said what it
 * wants. Only saved scene-field edits are admitted — a tour, a motion, a
 * render budget, a framing and a camera are not scene fields, and a compound
 * that mixed them could not be checked or reversed as one picture.
 */
const measurementChange=z.object({kind:z.literal('measurement'),patch:z.object({lines:measurementLinesSchema}).strict()}).strict();
const compoundOpSchema = z.discriminatedUnion('kind', [appearanceChange, stylesChange, placementOpChange, selectionChange, emphasisChange, visibilityChange, companionChange, measurementChange]);
export type InspectionCompoundOp = z.output<typeof compoundOpSchema>;
const oncePerKind = (ops:readonly {kind:string;scope?:string}[]) => new Set(ops.map(op=>op.kind==='appearance' && op.scope==='selection'?'styles':op.kind)).size===ops.length;
const COMPOUND_MESSAGE = 'A compound change carries each kind of edit at most once.';
export const COMPOUND_MIN_OPS = 2;
/**
 * Seven scene fields: scene appearance, selection styles, placement, selection, emphasis, visibility and the companion structure.
 *
 * The bound is one op per kind, not a budget: a request that moved every field
 * the scene has is still one thing the person asked for and must stay one
 * render, one line and one undo. It grew from four when hiding became a saved
 * field, and `undoChangeFor` depends on it — an undo of a five-field manual
 * edit is a five-op compound.
 */
export const COMPOUND_MAX_OPS = 7;
const compoundChange = z.object({kind:z.literal('compound'), patch:z.object({
  // History can restore measured endpoints together with the seven caller-editable
  // fields. Raw endpoints remain unavailable in the public request schema.
  ops:z.array(compoundOpSchema).max(COMPOUND_MAX_OPS + 1).superRefine(atLeast(COMPOUND_MIN_OPS)).refine(oncePerKind,COMPOUND_MESSAGE),
}).strict()}).strict();
/**
 * The emphasis op AS A CALLER WRITES IT: part names, the way `emphasize` takes
 * them. The colour key itself is the lesson's and the server expands it, so a
 * caller composing a compound never has to retype a chain letter or a residue
 * range it can already name.
 */
const emphasisOpRequestSchema = z.object({kind:z.literal('emphasis'),
  parts:z.array(z.string().min(1).max(80)).max(8),
  context:z.number().finite().min(0).max(1).optional()}).strict();
/**
 * Region styles are the one kind a request may repeat: "chain A orange and
 * chain B blue" names two regions, and the host folds every region style into
 * the single styles edit the panel renders, so the picture is still one render
 * and one undo.
 */
const oncePerRequestKind = (ops:readonly {kind:string;scope?:string;residues?:unknown}[]) =>
  oncePerKind(ops.filter(op=>!(op.kind==='appearance' && op.residues!==undefined)));
export const compoundRequestChangeSchema = z.object({kind:z.literal('compound'), patch:z.object({
  ops:z.array(z.discriminatedUnion('kind', [appearanceRequestChange, placementOpChange, selectionRequestChange, emphasisOpRequestSchema, visibilityRequestChange, companionRequestChange]))
    .max(COMPOUND_MAX_OPS).superRefine(atLeast(COMPOUND_MIN_OPS)).refine(oncePerRequestKind,COMPOUND_MESSAGE),
}).strict()}).strict();
export type CompoundRequestChange = z.output<typeof compoundRequestChangeSchema>;
export const inspectionChangeSchema = z.discriminatedUnion('kind', [appearanceChange, stylesChange, placementChange, selectionChange, tourChange, lessonChange, cameraChange, focusChange, motionChange, animationChange, measurementChange, renderQualityChange, emphasisChange, visibilityChange, companionChange, compoundChange]);
export type InspectionChange = z.output<typeof inspectionChangeSchema>;
export const commandIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
/** Additive receipt metadata. A visual edit never changes coordinate bytes. */
export const operationContractSchema = z.discriminatedUnion('kind', [
  z.object({version:z.literal(1),kind:z.literal('visual-edit'),coordinatesChanged:z.literal(false),
    tool:z.string(),effects:z.array(z.string())}).strict(),
  z.object({version:z.literal(1),kind:z.literal('coordinate-artifact'),coordinatesChanged:z.boolean(),sourceChanged:z.literal(true),
    tool:z.string(),artifact:z.enum(['coordinates','density']),chemicallyValidated:z.literal(false),
    provenance:z.object({sourceAddress:z.string(),derivation:z.record(z.string(),z.unknown()),
      sha256:z.string().regex(/^[0-9a-f]{64}$/),fetchedAt:z.number().finite().nonnegative().nullable(),
      verifiedAt:z.number().finite().nonnegative(),requestedBy:z.string()}).strict()}).strict().refine(value=>value.coordinatesChanged===(value.artifact==='coordinates'),
      'Only coordinate artifacts change coordinate bytes.'),
]);
export type OperationContract = z.output<typeof operationContractSchema>;
export const inspectionStateSchema = z.object({sessionId:sessionIdSchema,commandId:commandIdSchema.optional(),residues:inspectionResidueQuerySchema.optional(),
  includeViewDetails:z.boolean().optional().describe('Return the complete saved view, including canonical style keys, selection signature and animation definitions. Omit for compact routine polling.'),
  includeLesson:z.boolean().optional().describe('Include the installed editable inline manifest for install_lesson, bounded to 256 KiB; omitted for routine polling.'),
  includeExperienceCatalog:z.boolean().optional().describe('Include full experience chapters and device budgets. Omit for routine state and receipt polling; tours always includes available IDs.')}).strict();
/**
 * What `update_inspection` accepts, which is deliberately narrower than what a
 * panel can execute. No tool hands the model a camera snapshot — coordinates
 * and camera stay private — so a camera command has exactly one honest caller,
 * `import_detailed_view`, which builds the pose from the user's saved `.molj`
 * on the server and enqueues it there.
 */
export const updateInspectionSchema = inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),actionPostedAt:z.number().finite().nonnegative().optional(),
  // The tool description stops at what a host keeps (Claude Code keeps 2,048
  // characters); each kind's own rules ride on its member, which hosts keep whole.
  change:z.discriminatedUnion('kind', [
    appearanceRequestChange.describe('Style the whole scene, a named region (residues) or the current selection (scope:"selection"). A region or selection patch takes representation (cartoon, ball-and-stick, molecular-surface, spacefill, or sticks, surface, spheres), color, uniformColor, opacity 0-1 or clear:true. Without residues or scope:"selection", the patch styles the whole scene and also takes background, highlightColor, labels, clipping and fog. labels:true labels the selected residues, up to 32, with residue names and ligand codes. Select and label in one compound with no read first: ops [{kind:"selection",patch:{residues:{authorResidueRange:[248,248]}}},{kind:"appearance",patch:{labels:true}}], or residues {componentId:"MOV"} for a ligand. One selection names one region, so residues in separate places need selectionKeys from get_inspection_state residue reads, sent together. The selection highlight can replace a color set on selected atoms, so call them highlighted, name no color for them and leave a region unselected when its color should show; clearing the selection also removes their labels. A costly scene may report a geometryBudget advisory that it may run slowly; the selected representation and quality are preserved.'),
    placementChange.describe('Move the whole molecule: translation [x,y,z] in molecular radii, rotation in degrees [x,y,z], positive scale. Numerical limits are ±1000000 per translation axis and scale 0.000001–1000000. Moving only some residues is not a placement. {recenter:true}, alone, runs the headset\'s own Reset: the structure goes back to its entry size in front of the wearer and the menu is re-seated beside them. The receipt reports if the menu could not move. Use it when the wearer says they cannot see the structure or it is behind them. It needs a headset page in VR and is refused on the Mac panel.'),
    selectionRequestChange.describe('Replace the selection with a named region (residues) or canonical selectionKeys; selectionKeys:[] clears it. Rows without coordinates can be selected but show no 3D highlight.'),
    tourChange,
    animationRequestChange.describe('Pause or resume the animation in the current lesson chapter. Use state play or pause, speed 0.1–4, an absolute seekSeconds within the clip, loop true or false, or restart true to return to zero. Restart keeps the play/pause state; add state play to play it again. This does not advance or pause the tour.'),
    motionChange.describe('spin starts the slow turntable the wearer hears as "Spinning."; stop ends it and saves the angle shown.'),
    renderQualityChange.describe('How much the panel draws per frame; nothing saved changes. balanced is the default. A headset already in VR gets more detail at once and the resolution only at its next entry: the receipt then carries scaleAppliesOnNextEntry:true, so say "Sharper after re-entry."'),
    visibilityRequestChange.describe('Take parts off the screen. Name a chain by its label letter when this model has one chain with it, else by the {labelChain, copyId} pair; a class the structure lacks is refused by name, or listed in visibility.absent beside what it did hide. op "only" with selection:true shows just the selection, and op "show" with selection:true undoes that. Report the result in the words visibility.now gives.'),
    companionRequestChange.describe('Edit the comparison structure that replace_inspection_source mode="compare" added: patch={placement?, appearance?}, or {remove:true}.'),
    compoundRequestChangeSchema.describe('Two to seven edits applied in order as one render, one saved scene and one undo. Ops are appearance (region styles may repeat), placement, selection, visibility, companion-structure, and {kind:"emphasis",parts:["guide RNA"],context:0.12}, which names lesson parts as emphasize does.'),
    z.object({kind:z.literal('utterance'),patch:z.object({action:z.enum(['begin','correct','cancel'])}).strict()}).strict()
      .describe('For voice requests: to correct or cancel an earlier one, send this with the newer utteranceId before the replacement edit. For a text request, action "begin" (or no utteranceId) allocates one; echo lifecycle.utterance.utteranceId on the edit. Cancelling never undoes rendered work.')]),
  // What the person meant when they started asking. Optional, so
  // every caller that sent this tool a change before still sends the same one.
  referent:requestReferentSchema.optional(),
  /** Explicit whole-scene intent; never inferred from a selected pronoun. */
  referentScope:z.literal('scene').optional()
    .describe('"scene" applies a referent-bearing appearance to the whole scene rather than the captured residues.'),
  waitForRenderMs:commandWaitSchema});
/**
 * What `focus_selection` accepts. The region is named the way
 * `get_inspection_state` already names one, so a caller who can ask which
 * residues a chain has can ask for that chain to be brought into view in the
 * same words, in one call.
 */
export const focusResidueQuerySchema = regionQuerySchema;
const focusSelectionFields = inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),actionPostedAt:z.number().finite().nonnegative().optional(),
  framing:focusFramingSchema.default('context'),
  selectionKeys:sceneSchema.shape.selectionKeys.superRefine(atLeast(1)).optional(),
  residues:focusResidueQuerySchema.optional(),
  // Naming no region means "what they were looking at". With a
  // referent that is the selection when the request began; without one it is
  // still the live selection, exactly as before.
  referent:requestReferentSchema.optional(),
  waitForRenderMs:commandWaitSchema,
}).strict();
const oneFocusRegion = (v:{selectionKeys?:unknown;residues?:unknown}) => !(v.selectionKeys && v.residues);
const FOCUS_REGION_MESSAGE = 'Supply selectionKeys or residues, or neither to use what is already selected.';
export const focusSelectionSchema = focusSelectionFields.refine(oneFocusRegion,FOCUS_REGION_MESSAGE);
export const focusSelectionRequestSchema = withImplicitBinding(focusSelectionFields,true).refine(oneFocusRegion,FOCUS_REGION_MESSAGE);
/**
 * What `emphasize` accepts: part names, and how faint everything else goes.
 *
 * A caller names parts the way the lesson names them — "guide RNA", "PAM" — and
 * never a chain letter or a residue range, because the colour key is the shared
 * vocabulary between the wearer, the lesson and the agent. The server expands
 * those names into the key itself. An empty list clears the emphasis, which is
 * how the structure goes back to plain without restoring a whole saved scene.
 */
export const emphasizeSchema = inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),actionPostedAt:z.number().finite().nonnegative().optional(),
  parts:z.array(z.string().min(1).max(80)).max(8),
  context:z.number().finite().min(0).max(1).optional(),
  // A part named "this" or "that" is the part the referent
  // captured when the request began, not the one lit by the time it arrives.
  referent:requestReferentSchema.optional(),
  waitForRenderMs:commandWaitSchema,
}).strict();
const spatialPosition = z.number().finite().min(-100).max(100);
const spatialDirection = z.number().finite().min(-1).max(1);
/**
 * A deliberately transient, object-relative XR sample. This names neither a
 * room origin nor a world-space camera and accepts no client timestamp.
 */
export const spatialContextSchema = z.object({
  mode:z.enum(['immersive-vr','immersive-ar']),
  headPosition:z.array(spatialPosition).superRefine(exactly(3)).transform(v=>v as [number,number,number]),
  viewDirection:z.array(spatialDirection).superRefine(exactly(3)).transform(v=>v as [number,number,number]),
  distance:z.number().finite().min(0).max(100),
}).strict().superRefine((value,ctx)=>{
  const direction=Math.hypot(...value.viewDirection);
  if(direction<.5 || direction>1.5) ctx.addIssue({code:'custom',message:'viewDirection must be approximately normalized.'});
  const distance=Math.hypot(...value.headPosition);
  if(Math.abs(distance-value.distance)>Math.max(.05,value.distance*.02))
    ctx.addIssue({code:'custom',message:'distance must match the object-relative head position.'});
});
export type SpatialContext = z.output<typeof spatialContextSchema>;
export const xrStartupSchema = z.object({
  // Optional, capability-negotiated renderer health. Null clears a prior failure.
  rendererContext:z.object({status:z.enum(['context_lost','recovering','error']),detail:z.string().min(1).max(512),error:z.string().max(1024).optional()}).strict().nullable().optional(),
  phase:z.enum(['idle','requesting-headset','locating-headset','connecting-display','starting-presentation','preparing-menu','active']),
  pending:z.boolean(),reloadRequired:z.boolean(),
  mode:z.enum(['immersive-ar','immersive-vr']).nullable(),gestureActive:z.boolean().nullable(),
  frameCount:z.number().int().min(0).max(1_000_000_000).optional(),viewCount:z.number().int().min(0).max(8).optional(),
  blendMode:z.enum(['opaque','alpha-blend','additive']).nullable().optional(),presenting:z.boolean().optional(),
  errorName:z.enum(['NotAllowedError','NotSupportedError','InvalidStateError','SecurityError','AbortError','OperationError','TypeError','Error']).nullable().optional(),
  build:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  entryClicks:z.number().int().min(0).max(65535).optional(),pointerDowns:z.number().int().min(0).max(65535).optional(),
  pagePointerDowns:z.number().int().min(0).max(65535).optional(),pagePointerUps:z.number().int().min(0).max(65535).optional(),
  pageClicks:z.number().int().min(0).max(65535).optional(),pointerCancels:z.number().int().min(0).max(65535).optional(),
  lastInputTarget:z.enum(['none','enter-ar','enter-vr','canvas','options','other']).optional(),
  trustedClick:z.boolean().nullable().optional(),visible:z.boolean().optional(),focused:z.boolean().optional(),
  // The session's own visibility, which is not the document's.
  // `visible` above is the flat page; this is what the headset is showing.
  // `visible-blurred` and `hidden` both mean the wearer is not there, and the
  // panel answers `busy` for either, so an agent reading this knows why.
  sessionVisibility:z.enum(['visible','visible-blurred','hidden']).nullable().optional(),
  // A blend-mode switch the browser would not grant without a page
  // gesture leaves the mode here, so the agent can see that the wearer is on the
  // 2D page waiting to press one button rather than lost.
  pendingEntry:z.object({mode:z.enum(['immersive-ar','immersive-vr']),
    reason:z.enum(['activation','busy','unsupported','timeout','failed'])}).strict().nullable().optional(),
  // What the granted session reports, copied on grant and on
  // `frameratechange`. The page sends an empty list and null when the browser
  // has no frame-rate API, so both shapes must pass this strict object.
  supportedFrameRates:z.array(z.number().min(1).max(1000)).max(32).optional(),
  reportedFrameRate:z.number().min(0).max(1000).nullable().optional(),
}).strict();
export type XrStartup = z.output<typeof xrStartupSchema>;
/** Why a panel reports busy; ready and unsaved panels have no busy cause. */
export const availabilityCauseSchema = z.enum(['hidden-session','blurred','busy','context-lost','context-recovering','renderer-error']).nullable();
export type AvailabilityCause = z.output<typeof availabilityCauseSchema>;

/** Diagnose the last XR report without changing readiness or command admission. */
export function classifyPanelAvailability(startup: {presenting?:boolean;sessionVisibility?:string|null;rendererContext?:{status?:string}|null}|null|undefined): NonNullable<AvailabilityCause> {
  // Session visibility also drives headset recovery; retain its precedence
  // while rendererContext separately carries an overlapping graphics failure.
  if(startup?.presenting===true) {
    if(startup.sessionVisibility==='hidden') return 'hidden-session';
    if(startup.sessionVisibility==='visible-blurred') return 'blurred';
  }
  if(startup?.rendererContext?.status==='context_lost')return 'context-lost';
  if(startup?.rendererContext?.status==='recovering')return 'context-recovering';
  if(startup?.rendererContext?.status==='error')return 'renderer-error';
  return 'busy';
}

/**
 * The chapter an AUTHORED LESSON is showing.
 *
 * A journey is not the tour player. It renders each chapter through
 * `navigate_experience` and `acknowledge_experience_step`, and its heartbeat
 * `tourState` stays `active:false` throughout, so the chapter number the tour
 * player would have carried in `step` was never on the beat at all. Without it
 * the host cannot tell a chapter the lesson drew for itself from a hand on the
 * scene, and a wearer's "Stop, go back to my view" spoken one chapter ago is
 * refused. This is the same fact `tourState.step` carries for the player: which
 * lesson, and which chapter of it, this panel is showing right now.
 */
export const experienceChapterSchema = z.object({
  experienceId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/iu),
  stepIndex:z.number().int().nonnegative().max(255),
}).strict();
export const pollInspectionSchema = inspectionBindingSchema.extend({panelId:z.string().uuid(),availability:z.enum(['ready','busy','unsaved']),
  sourceFailureToken:z.string().uuid().optional(),
  pageBuild:z.string().length(64).optional(),
  spatialContext:spatialContextSchema.nullable().optional(),
  xrStartup:xrStartupSchema.optional(),
  animation:animationStateSchema.nullable().optional(),
  tourState:tourStateSchema.optional(),
  experience:experienceChapterSchema.optional(),
  // The headset's own log rides this heartbeat. Only entries the desktop has
  // not acknowledged are sent, so a dropped beat re-sends instead of losing
  // them. Nothing here names a scene, a token or any coordinate.
  // The LENIENT batch, and the entries are salvaged one at a
  // time on the way into the store. A malformed log line must cost one line,
  // never the beat that carries the panel's availability to the agent.
  diagnostics:heartbeatDiagnosticsBatchSchema.optional(),
});
export const geometryBudgetReceiptSchema = z.object({
  representation:z.enum(STRUCTURE_REPRESENTATIONS), deviceClass:z.string().min(1).max(32),
  atoms:z.number().int().nonnegative(), budget:z.number().positive().finite(),
  requestedLevel:z.enum(['lowest','lower','low','medium','high','higher','highest']),
  level:z.enum(['lowest','lower','low','medium','high','higher','highest']),
  estimatedVertices:z.number().int().nonnegative(), message:z.string().min(1).max(120),
}).strict();
export type GeometryBudgetReceipt = z.infer<typeof geometryBudgetReceiptSchema>;

// The page reports the rigid tracked basis and scene-to-metre conversion.
// Host repairs are checked against the fitter's metre limits, never radii × scale.
// The shared check tolerates rigid matrix arithmetic noise (including w);
// the page solver, not this attested envelope, proves stereo clearance.
export const placementFitSchema = z.object({
  metersPerRadius: z.number().finite().positive(),
  centerMeters: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  headFromScene: z.array(z.number().finite()).length(16),
}).strict();
export type PlacementFitEvidence = z.infer<typeof placementFitSchema>;
export const recenterCompletionSchema = z.object({structureReset:z.literal(true),menuReseated:z.boolean(),
  placement:sceneSchema.shape.inspection.shape.placement}).strict();
export type RecenterCompletion = z.infer<typeof recenterCompletionSchema>;

function validPlacementFit(requested: InspectionScene['inspection']['placement'],
  actual: InspectionScene['inspection']['placement'], evidence?: PlacementFitEvidence): boolean {
  if (!evidence || !placementFitSchema.safeParse(evidence).success) return false;
  // An attestation from this page, not independently sourced geometry. This
  // detects inconsistent honest repairs; a lying page can forge its evidence.
  return placementFitWithinEnvelope(requested, actual, evidence);
}

export const completeInspectionSchema = inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,claimToken:z.string().uuid(),
  animation:animationStateSchema.nullable().optional(),
  tourState:tourStateSchema.optional(),
  tourCommand:tourCommandClaimSchema.optional(),
  phase:z.enum(['admit','settled','defer-local-save']).optional(),
  // Shared history preserves the acting panel's viewpoint. Bind that view
  // before drawing, never by accepting a different pose in the final receipt.
  historyScene:sceneSchema.optional(),
  allowReplacement:z.literal(true).optional(),
  recoveryFailed:z.literal(true).optional(),
  scene:sceneSchema.optional(),failure:z.enum(INSPECTION_FAILURE_CODES).optional(),
  namedViewIntent:namedViewIntentSchema.optional(),
  // Geometry admission refusals retain their distinct code. Other legacy
  // `render_failed` replies name the class, not the cause. The panel's own sentence
  // travels beside it so a refusal a caller could act on ("start a tour before
  // playing") is not reported as a rendering fault. `capture_refused` is the
  // transient named-view capture refusal (stale head tracking or a held grip):
  // the panel drew nothing, and the reason text tells the caller to hold
  // still, release the grip and save again.
  failureReason:z.string().min(1).max(MAX_INSPECTION_FAILURE_REASON_CHARS).optional(),
  // A render-quality change whose framebuffer half is still
  // waiting for the wearer's next immersive entry. An XRWebGLLayer's scale is
  // fixed when the layer is built, so `best` inside a running session raises
  // the representation detail now and the resolution only on re-entry. The
  // rendered scene cannot show that, and an agent that cannot see it tells the
  // wearer the picture is already sharper. Nothing saved depends on it.
  scaleAppliesOnNextEntry:z.boolean().optional(),
  // The headset renderer may move or shrink a host placement around held
  // glass. The scene carries the actual coordinates; this flag says the
  // difference was an intentional clearance fit on that claimed panel.
  placementAdjusted:z.literal(true).optional(),
  placementFit:placementFitSchema.optional(),
  // The wearer moved, turned or resized the structure while a lesson that
  // keeps the placement (`frame:false`) drew, and made no other local edit.
  // The scene carries where the wearer put it; the panel checked the rest.
  wearerPlacement:z.literal(true).optional(),
  recenterCompletion:recenterCompletionSchema.optional(),
  geometryBudget:geometryBudgetReceiptSchema.optional(),
}).refine(v => v.phase ? !v.scene && !v.failure : Boolean(v.scene) !== Boolean(v.failure),'Supply a rendered scene or a failure, or a lifecycle phase without either.')
  .refine(v => !v.historyScene || v.phase==='admit','A history viewpoint needs command admission.')
  .refine(v => !v.failureReason || Boolean(v.failure),'A failure reason needs a failure.')
  .refine(v => !v.tourCommand || Boolean(v.failure) || v.phase==='settled','A transferred tour claim can report only failure or settled cancellation here.')
  .refine(v => !v.allowReplacement || Boolean(v.scene),'A replacement needs the older rendered scene.')
  .refine(v => !v.recoveryFailed || v.phase==='settled','Recovery failure needs a settled claim.')
  .refine(v => !v.namedViewIntent || Boolean(v.scene),'A named-view intent needs a captured scene.')
  .refine(v => !v.geometryBudget || Boolean(v.scene),'Applied geometry needs a rendered scene.')
  .refine(v => !v.placementAdjusted || Boolean(v.scene),'A placement adjustment needs a rendered scene.')
  .refine(v => !v.wearerPlacement || Boolean(v.scene),'A wearer placement needs a rendered scene.')
  .refine(v => !v.recenterCompletion || Boolean(v.scene),'A Reset completion needs a rendered scene.')
  .refine(v => !v.scaleAppliesOnNextEntry || Boolean(v.scene),'A pending framebuffer scale needs a rendered scene.');

export function expectedInspection(scene:InspectionScene, change:InspectionChange):InspectionScene {
  // A compound is its ops folded in the order they are written,
  // each through the same rule it has on its own, so one edit reads the scene
  // the one before it left. Nothing here is compound-specific but the loop.
  if(change.kind==='compound')
    return change.patch.ops.reduce<InspectionScene>((carried,op)=>expectedInspection(carried,op),scene);
  const next=structuredClone(scene);
  if(change.kind==='appearance') {
    next.inspection.appearance=normalizeAppearance(change.patch,scene.inspection.appearance);
    if(next.inspection.lessonFigure && Object.hasOwn(change.patch,'representation'))
      next.inspection.lessonFigure=withFigureRepresentation(next.inspection.lessonFigure,change.patch.representation);
  }
  else if(change.kind==='measurement') {
    if(change.patch.lines.length) next.inspection.measurementLines=structuredClone(change.patch.lines);
    else delete next.inspection.measurementLines;
  }
  else if(change.kind==='styles') {
    if(change.patch.styles.length) next.inspection.styles=normalizeStyles(change.patch.styles);
    else delete next.inspection.styles;
  }
  // A Reset's seat is the panel's to solve, so nothing is expected of it here;
  // `matchesInspectionChange` takes the placement it saves as the answer.
  else if(change.kind==='placement') { if(!isRecenterChange(change)) next.inspection.placement=normalizePlacement(change.patch,scene.inspection.placement); }
  else if(change.kind==='selection' || change.kind==='focus') {
    next.selectionKeys=[...change.patch.selectionKeys]; if(next.inspection) delete next.inspection.lessonSelection;
  }
  else if(change.kind==='camera') next.camera={...next.camera,...cameraPose(change.patch.camera)};
  else if(change.kind==='emphasis') next.inspection.emphasis=structuredClone(change.patch);
  // A companion patch either supplies a verified source, edits its own look
  // and pose, or removes it. The primary identity and selection never move.
  else if(change.kind==='companion-structure') {
    if('source' in change.patch) next.inspection.companionStructure=structuredClone(change.patch);
    else if(change.patch.remove) delete next.inspection.companionStructure;
    else {
      const prior=next.inspection.companionStructure;
      if(!prior) throw Error('Add a comparison source before editing it.');
      next.inspection.companionStructure=companionStructureSchema.parse({...prior,
        placement:{...prior.placement,...change.patch.placement},appearance:{...prior.appearance,...change.patch.appearance}});
    }
  }
  // The hidden set is already resolved; absence means nothing is hidden.
  else if(change.kind==='visibility') {
    if(visibilityIsEmpty(change.patch)) delete (next.inspection as {visibility?:unknown}).visibility;
    else next.inspection.visibility=normalizeVisibility(change.patch);
  }
  return next;
}

/**
 * Whether two emphases are the same picture.
 *
 * The panel answers with what it painted, which is the request canonicalised:
 * a focus id the key does not name is dropped and a context opacity is clamped.
 * So the comparison is over what a caller actually asked for — which parts the
 * key holds, which of them are lit, and how faint the rest went — and not over
 * the exact JSON the request happened to be written in.
 */
function sameEmphasis(a:InspectionEmphasis|undefined, b:InspectionEmphasis|undefined):boolean {
  if(!a || !b) return a===b;
  if(a.contextOpacity!==b.contextOpacity) return false;
  const ids=(value:InspectionEmphasis)=>JSON.stringify(value.parts.map(part=>part.id).sort());
  const focus=(value:InspectionEmphasis)=>JSON.stringify([...value.focus].sort());
  return ids(a)===ids(b) && focus(a)===focus(b);
}

/**
 * What the host needs to tell a lit region from a faded one.
 *
 * Only the identity fields a colour key can name. The catalog the attachment
 * already holds satisfies this; nothing else is read, and no coordinate is.
 */
export type EmphasisCatalog = {rows:readonly {key:string; identity:{
  modelNumber:number; labelChain:string; authorChain:string|null; authorResidue:number|null}}[]};
/**
 * Whether one colour-key part claims a row.
 *
 * The chain is matched against BOTH identifiers the row carries, and the
 * residue range against author numbering, because that is how the panel
 * resolves a part (`spokenSelectionKeys` in viewer.mjs): a lesson writes the
 * author chain a paper prints, and a row may only know its label chain. A host
 * that matched this differently would disagree with the picture it is judging.
 */
function partHoldsRow(part:InspectionEmphasis['parts'][number], identity:EmphasisCatalog['rows'][number]['identity']):boolean {
  if(part.chain!==undefined && identity.authorChain!==part.chain && identity.labelChain!==part.chain) return false;
  if(part.residues && (identity.authorResidue===null
    || identity.authorResidue<part.residues.from || identity.authorResidue>part.residues.to)) return false;
  return true;
}
/** Canonical focused targets, using the same part membership as receipts. */
export function emphasisSelectionKeys(emphasis:InspectionEmphasis, catalog:EmphasisCatalog, modelNumber:number):string[] {
  const focused=emphasis.parts.filter(part=>emphasis.focus.includes(part.id));
  return catalog.rows.filter(row=>row.identity.modelNumber===modelNumber
    && focused.some(part=>partHoldsRow(part,row.identity))).map(row=>row.key);
}
/**
 * Whether every row of a region is held at full strength by the saved emphasis.
 *
 * A focus command's whole claim is that the wearer can now see the region it
 * named. A lesson chapter fades everything its own focus does not claim, so a
 * region outside that focus comes back drawn at context opacity — the ghost the
 * wearer says they cannot see. This is the host's own reading of the returned
 * scene, not the panel's word for it: an emphasis focusing nothing fades
 * nothing, and otherwise every named row must sit inside a focused part.
 */
export function emphasisHoldsKeys(emphasis:InspectionEmphasis|undefined, keys:readonly string[],
  catalog:EmphasisCatalog, modelNumber:number):boolean {
  if(!emphasis || emphasis.focus.length===0) return true;
  const focused=emphasis.parts.filter(part=>emphasis.focus.includes(part.id));
  const identities=new Map(catalog.rows.filter(row=>row.identity.modelNumber===modelNumber)
    .map(row=>[row.key,row.identity] as const));
  for(const key of keys) {
    const identity=identities.get(key);
    if(!identity || !focused.some(part=>partHoldsRow(part,identity))) return false;
  }
  return true;
}
/**
 * The one scene change a focus command is allowed to make
 * besides the framing itself.
 *
 * A panel lifts the lesson's fade off the region it is bringing into view
 * (`liftFocusOutOfFade` in viewer.mjs), because framing something the chapter
 * has faded to eighteen per cent shows the wearer a ghost of the one thing
 * they asked to see. That lift edits the saved emphasis, and the receipt
 * compared the returned emphasis for exact equality with the one the scene
 * carried when the command was enqueued — so with the CRISPR
 * lesson parked on "RECAP: REC", the agent's "show me the guide RNA" came back
 * `unconfirmed` and the wearer was told about a change the host had just
 * declared invisible. The picture was right; the rule had no word for it.
 *
 * The key itself is still the lesson's: same parts, same colours, same context
 * opacity. What may move is which of them is held at full strength, and only
 * towards a scene that actually lights the framed region. Without a catalog
 * nothing here can be read off the scene, so the old exact comparison stands.
 */
function liftsRegionIntoView(after:InspectionEmphasis|undefined, before:InspectionEmphasis|undefined,
  keys:readonly string[], modelNumber:number, catalog?:EmphasisCatalog):boolean {
  const held=()=>!catalog || emphasisHoldsKeys(after,keys,catalog,modelNumber);
  if(JSON.stringify(after??null)===JSON.stringify(before??null)) return held();
  // A key the panel dropped, invented, recoloured or re-faded is not a lift.
  if(!after || !before || !catalog) return false;
  if(after.contextOpacity!==before.contextOpacity) return false;
  if(JSON.stringify(after.parts)!==JSON.stringify(before.parts)) return false;
  return held();
}

/**
 * A camera command carries a whole stock Mol* snapshot because that is what
 * the full viewer saves, but only the pose is a caller's to set. Scene radius,
 * fog, depth clipping and near/far bounds are computed by the renderer from
 * committed geometry and the panel's own depth controls, so they stay where
 * the panel has them and a returning snapshot cannot smuggle a depth change
 * past `matchesInspectionChange`.
 */
export function cameraPose(camera:InspectionScene['camera']) {
  const {mode,fov,position,target,up}=cameraSnapshot(camera);
  return {mode,fov,position,target,up} as Pick<InspectionScene['camera'],'mode'|'fov'|'position'|'target'|'up'>;
}

/** JSON object order is transport syntax, not a scientific scene field. */
export const inspectionJson = (value:unknown):string => JSON.stringify(value, (_key, item) =>
  item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);

export function matchesInspectionChange(scene:InspectionScene, expected:InspectionScene, change:InspectionChange,
  catalog?:EmphasisCatalog, placementAdjusted=false, placementFit?:PlacementFitEvidence, wearerPlacement=false):boolean {
  // Ordinary edits do not own the molecular clock or renderer diagnostics.
  // mutate() refreshes body representations and publishes a newer sample even
  // when only emphasis changed. Compare the edit against that live sample,
  // retaining the definition, chapter/id and playback controls as invariants.
  // Playback commands and lesson/tour installation have their own gates below.
  if (!['animation', 'lesson', 'tour'].includes(change.kind)
    && scene.inspection.animation && expected.inspection.animation) {
    expected = structuredClone(expected);
    const actual = scene.inspection.animation.playback;
    const prior = expected.inspection.animation!.playback;
    if (prior.state === 'playing') {
      prior.timeSeconds = actual.timeSeconds;
      // A non-looping chapter may finish naturally while the edit draws.
      if (!prior.loop && actual.timeSeconds === prior.durationSeconds && actual.state === 'paused')
        prior.state = 'paused';
    }
    if (actual.representationCounts) prior.representationCounts = structuredClone(actual.representationCounts);
    else delete prior.representationCounts;
  }
  // These controls do not own the lesson key. A resumed page may re-derive it;
  // validate and save that actual key without making it part of this receipt.
  // Source identity, requested placement and animation draw evidence stay checked.
  if (change.kind === 'animation' || change.kind === 'placement') {
    expected = structuredClone(expected);
    if (scene.inspection.emphasis) expected.inspection.emphasis = structuredClone(scene.inspection.emphasis);
    else delete expected.inspection.emphasis;
  }
  if (change.kind === 'animation' || change.kind === 'measurement') {
    // Playback is checked against the requested controls by the receipt gate.
    // Ordinary measurement edits use the same clock rule as other visual edits.
    const comparable = structuredClone(scene);
    if(change.kind==='measurement') comparable.camera.radiusMax=expected.camera.radiusMax;
    if (scene.inspection.animation && expected.inspection.animation) {
      if (inspectionJson(scene.inspection.animation.definition) !== inspectionJson(expected.inspection.animation.definition)) return false;
      if(change.kind==='animation') comparable.inspection.animation = structuredClone(expected.inspection.animation);
    }
    return inspectionJson(comparable) === inspectionJson(expected);
  }
  if(placementAdjusted) {
    const geometryChange=(kind:string)=>['placement','appearance','styles','companion-structure'].includes(kind);
    const hasGeometry=geometryChange(change.kind) || change.kind==='compound'
      && change.patch.ops.some(op=>geometryChange(op.kind));
    const requested=expected.inspection.placement, actual=scene.inspection.placement;
    if(!hasGeometry || inspectionJson(actual.rotation)!==inspectionJson(requested.rotation)
      || actual.scale<PLACEMENT_MIN_SCALE || actual.scale>requested.scale
      || actual.translation.some(value=>!Number.isFinite(value) || Math.abs(value)>PLACEMENT_MAX_TRANSLATION)
      || !validPlacementFit(requested, actual, placementFit)) return false;
    expected=structuredClone(expected);
    expected.inspection.placement=structuredClone(scene.inspection.placement);
  }
  /**
   * A compound is judged as one picture, under the union of the
   * relaxations its own ops carry. Each of those relaxations names something
   * only the renderer knows — the camera bound Mol* computes from committed
   * geometry, the order a panel stores selection keys in, the canonical form a
   * colour key comes back in — and a compound has no new ones of its own.
   */
  if(change.kind==='compound') {
    const kinds=new Set(change.patch.ops.map(op=>op.kind));
    const comparable=structuredClone(scene);
    comparable.camera.radiusMax=expected.camera.radiusMax;
    if(change.patch.ops.some(op=>op.kind==='appearance'
      && (Object.hasOwn(op.patch,'clipping') || Object.hasOwn(op.patch,'fog')))) {
      for(const key of ['radius','fog','clipFar'] as const) (comparable.camera as any)[key]=expected.camera[key];
    }
    if(kinds.has('selection')) {
      const selected=new Set(comparable.selectionKeys);
      if(selected.size!==expected.selectionKeys.length || expected.selectionKeys.some(key=>!selected.has(key))) return false;
      comparable.selectionKeys=[...expected.selectionKeys];
    }
    if(kinds.has('emphasis')) {
      if(!sameEmphasis(comparable.inspection.emphasis,expected.inspection.emphasis)) return false;
      comparable.inspection.emphasis=structuredClone(expected.inspection.emphasis);
    }
    // Ops can introduce visibility before emphasis while the receipt schema
    // writes emphasis first. Compare every field and array in full, ignoring
    // only object property insertion order.
    return inspectionJson(comparable)===inspectionJson(expected);
  }
  // A named tour is a renderer-owned sequence of multiple appearance,
  // selection and placement operations. validateScene still validates the
  // complete result and canonical identities before the claim is committed.
  // A tour may not replace the source, model or assembly. A lesson that
  // keeps the placement keeps the admitted one, unless the wearer moved the
  // structure while it drew: that placement is theirs, as it is for a tour.
  if(change.kind==='lesson') {
    if(scene.sourceSha256!==expected.sourceSha256 || scene.modelNumber!==expected.modelNumber || scene.assemblyId!==expected.assemblyId
      || inspectionJson(scene.selectionKeys)!==inspectionJson(expected.selectionKeys)
      || (!change.patch.frame && !wearerPlacement && (inspectionJson(scene.inspection.placement)!==inspectionJson(expected.inspection.placement)
      || inspectionJson({...scene.camera,radiusMax:expected.camera.radiusMax})!==inspectionJson(expected.camera)))) return false;
    const playback=scene.inspection.lessonPlayback;
    const previousChapter=expected.inspection.lessonPlayback?.chapterId;
    if((change.patch.start || change.patch.frame || previousChapter) && !playback) return false;
    const target=change.patch.start?.chapterId ?? (change.patch.lesson.chapters.some(chapter=>chapter.id===previousChapter)
      ? previousChapter : change.patch.lesson.chapters[0].id);
    if(playback && playback.chapterId!==target) return false;
    if(playback) {
      const chapter=change.patch.lesson.chapters.find(chapter=>chapter.id===playback.chapterId);
      if(playback.tourId!==`lesson-${change.patch.lesson.id}` || !chapter) return false;
      if(change.patch.start?.chapterId && playback.chapterId!==change.patch.start.chapterId) return false;
      if(inspectionJson(scene.inspection.lessonFigure)!==inspectionJson(chapter.immersive?.figure)) return false;
      if(inspectionJson(scene.inspection.animation?.definition)!==inspectionJson(chapter.animation)) return false;
    }
    return true;
  }
  if(change.kind==='tour') return scene.sourceSha256===expected.sourceSha256
    && scene.modelNumber===expected.modelNumber && scene.assemblyId===expected.assemblyId;
  // A focus is renderer-owned framing over a caller-owned region. The exact
  // selection is still checked, and so is the source identity, but the
  // placement and camera the panel solves for are the answer rather than the
  // request: the wearer's pose and the target's geometry decide them, and
  // neither is known here.
  if(change.kind==='focus') {
    if(scene.sourceSha256!==expected.sourceSha256 || scene.modelNumber!==expected.modelNumber
      || scene.assemblyId!==expected.assemblyId) return false;
    const framed=structuredClone(scene);
    framed.camera=structuredClone(expected.camera);
    framed.inspection.placement=structuredClone(expected.inspection.placement);
    const shown=new Set(framed.selectionKeys);
    if(shown.size!==expected.selectionKeys.length || expected.selectionKeys.some(key=>!shown.has(key))) return false;
    framed.selectionKeys=[...expected.selectionKeys];
    // The lesson's fade is the panel's to lift off the region it frames, and
    // the region it frames must not be left inside one. Read the comment on
    // `liftsRegionIntoView`; the hardware failure it names is this line.
    if(!liftsRegionIntoView(framed.inspection.emphasis,expected.inspection.emphasis,
      expected.selectionKeys,expected.modelNumber,catalog)) return false;
    framed.inspection.emphasis=structuredClone(expected.inspection.emphasis);
    return inspectionJson(framed)===inspectionJson(expected);
  }
  // A stop bakes the displayed spin angle into the placement, which only the
  // renderer knows; a spin start saves nothing. Everything else must hold.
  if(change.kind==='motion') {
    const settled=structuredClone(scene);
    settled.inspection.placement=structuredClone(expected.inspection.placement);
    settled.camera.radiusMax=expected.camera.radiusMax;
    return inspectionJson(settled)===inspectionJson(expected);
  }
  // The headset's Reset seats the structure from the wearer's
  // head and the room's floor, neither known here, so the placement it saves is
  // the answer, as a stop's angle is. The camera bound follows the new size.
  // Reset also stops the current chapter and molecular clock. Their source,
  // chapter, baseline and animation definition must hold; the stopped cursor
  // and the progress baked while stopping are renderer-owned results.
  if(isRecenterChange(change)) {
    const seated=structuredClone(scene);
    seated.inspection.placement=structuredClone(expected.inspection.placement);
    seated.camera.radiusMax=expected.camera.radiusMax;
    const playback=seated.inspection.lessonPlayback, prior=expected.inspection.lessonPlayback;
    if(playback && prior) {
      if(!playback.stopped || playback.motionPlaying===true) return false;
      const identity=({stopped:_stopped,motionProgress:_progress,motionPlaying:_playing,...rest}:LessonPlayback)=>rest;
      if(inspectionJson(identity(playback))!==inspectionJson(identity(prior))) return false;
      seated.inspection.lessonPlayback=structuredClone(prior);
    }
    if(seated.inspection.animation && expected.inspection.animation) {
      if(seated.inspection.animation.playback.state!=='paused') return false;
      seated.inspection.animation.playback.state=expected.inspection.animation.playback.state;
    }
    // A cutaway can hide every room seat. Native Reset removes that depth
    // clip before solving its seat, with the same camera-bound effects as an
    // explicit clipping edit; other appearance and camera fields still hold.
    if(expected.inspection.appearance.clipping>0 && seated.inspection.appearance.clipping===0) {
      seated.inspection.appearance.clipping=expected.inspection.appearance.clipping;
      for(const key of ['radius','fog','clipFar'] as const) (seated.camera as any)[key]=expected.camera[key];
    }
    return inspectionJson(seated)===inspectionJson(expected);
  }
  // Emphasis is layers over the representation, so nothing else in the scene
  // may move: same selection, same placement, same viewpoint. Only the camera
  // bound Mol* computes from committed geometry is the renderer's, as it is for
  // an appearance change, and the emphasis itself is compared as a picture
  // rather than as exact JSON.
  if(change.kind==='emphasis') {
    if(!sameEmphasis(scene.inspection.emphasis,expected.inspection.emphasis)) return false;
    const painted=structuredClone(scene);
    painted.camera.radiusMax=expected.camera.radiusMax;
    painted.inspection.emphasis=structuredClone(expected.inspection.emphasis);
    return inspectionJson(painted)===inspectionJson(expected);
  }
  // Hiding is layers over the representation, exactly as
  // emphasis is, so nothing else in the scene may move — same appearance, same
  // placement, same selection, same viewpoint. The one renderer-owned value is
  // the camera bound Mol* computes from committed geometry, which moves when
  // the label plates of a hidden chain come down, and which is the renderer's
  // to report for an appearance change too.
  if(change.kind==='visibility') {
    if(!sameVisibility(scene.inspection.visibility,expected.inspection.visibility)) return false;
    const filtered=structuredClone(scene);
    filtered.camera.radiusMax=expected.camera.radiusMax;
    if(expected.inspection.visibility) filtered.inspection.visibility=structuredClone(expected.inspection.visibility);
    else delete (filtered.inspection as {visibility?:unknown}).visibility;
    return inspectionJson(filtered)===inspectionJson(expected);
  }
  // A render budget is not a scene value: appearance, placement, selection and
  // viewpoint all have to come back unchanged. Rebuilding the representation at
  // a new detail tier can move the camera bound Mol* computes from committed
  // geometry, and that bound stays the renderer's to report, as it is for an
  // appearance change.
  if(change.kind==='render-quality') {
    const rebuilt=structuredClone(scene);
    rebuilt.camera.radiusMax=expected.camera.radiusMax;
    return inspectionJson(rebuilt)===inspectionJson(expected);
  }
  const comparable=structuredClone(scene);
  // Placement is authored state, serialized as JS numbers before Mol* uploads
  // Float32 transforms. It needs no GPU rounding allowance: zero tolerance on
  // scale, rotation and translation, including omitted fields. Local menu
  // clearance is saved through sync_inspection, never inferred from a receipt.
  // Mol* computes this camera bound from committed structure and label
  // geometry. Keep that calculation in the renderer; neither command can
  // change the camera pose.
  if(change.kind==='camera' || change.kind==='appearance' || change.kind==='styles' || change.kind==='companion-structure') {
    comparable.camera.radiusMax=expected.camera.radiusMax;
    if(Object.hasOwn(change.patch,'clipping') || Object.hasOwn(change.patch,'fog')) {
      for(const key of ['radius','fog','clipFar'] as const) (comparable.camera as any)[key]=expected.camera[key];
    }
  } else if(change.kind==='selection') {
    comparable.camera.radiusMax=expected.camera.radiusMax;
    const selected=new Set(comparable.selectionKeys);
    if(selected.size!==expected.selectionKeys.length || expected.selectionKeys.some(key=>!selected.has(key))) return false;
    // Selection is a set. The renderer stores valid keys in catalog order,
    // while the command preserves caller order for its exact retry signature.
    comparable.selectionKeys=[...expected.selectionKeys];
  }
  return inspectionJson(comparable)===inspectionJson(expected);
}

// ---------------------------------------------------------------- readiness
/**
 * What has to be true before the headset goes on, in the order a person sets
 * it up.
 *
 * `setup-doctor` already answers "can this Mac host a session at all" — Node,
 * OpenSSL, a built runtime, a LAN address, a free port. None of that says
 * whether the scene is saved, whether anything paired, whether an agent is
 * listening, or whether the microphone and the spoken reply will work. Without
 * this, every one of those is discovered by putting the headset on and
 * finding that nothing happened, which is the most expensive place to learn it.
 *
 * So this is deliberately a different list from the doctor's: it reads a
 * *running* host rather than a checkout, and every entry carries one sentence
 * naming the next thing to do. A capability nobody can check from here is
 * `not-checked` rather than `ok`, because a green line that was never measured
 * is worse than no line at all.
 */
export const READINESS_CAPABILITIES = ['structure', 'share', 'agent', 'transcription', 'replies', 'headset'] as const;
export type ReadinessCapability = (typeof READINESS_CAPABILITIES)[number];
/**
 * The small, server-owned snapshot the inspector gives the model through
 * `ui/update-model-context`. It is deliberately a projection: selected
 * residue labels are capped at eight, the lesson/chapter are the current
 * authored names, emphasis contains only the lit part, and readiness carries
 * only its headline and blockers. Raw coordinates, canonical selection keys,
 * scene JSON and readiness diagnostics stay in the server tools.
 */
/**
 * Residue labels a model reads for one selection. Each label is at most 96
 * characters, so 32 labels stay a few kilobytes of context; `count` still
 * reports the full selection and `truncated` marks the rest.
 */
export const INSPECTION_MODEL_CONTEXT_RESIDUE_LIMIT = 32;
export const inspectionModelContextSchema = z.object({
  selection:z.object({count:z.number().int().nonnegative().max(20_000),residues:z.array(z.string().min(1).max(96)).max(INSPECTION_MODEL_CONTEXT_RESIDUE_LIMIT),truncated:z.boolean()}).strict(),
  lesson:z.object({id:z.string().min(1).max(128),title:z.string().min(1).max(160)}).strict().nullable(),
  // `index` is one-based so a model can say "chapter 2 of 6" naturally.
  chapter:z.object({id:z.string().min(1).max(128),title:z.string().min(1).max(160),index:z.number().int().positive().max(1000),total:z.number().int().positive().max(1000)}).strict().nullable(),
  emphasis:z.object({lit:z.array(z.string().min(1).max(96)).max(8)}).strict().nullable(),
  readiness:z.object({ready:z.boolean(),blocking:z.array(z.enum(READINESS_CAPABILITIES)).max(READINESS_CAPABILITIES.length),
    // These prerequisites describe headset microphone use, not the host's independent voice session.
    scope:z.literal('headset-microphone-session').optional()}).strict(),
}).strict();
export type InspectionModelContext = z.output<typeof inspectionModelContextSchema>;
export type InspectionReadinessSummary = InspectionModelContext['readiness'];
/** `not-checked` never claims success; unobserved transcription blocks voice readiness. */
export type ReadinessState = 'ok' | 'missing' | 'not-checked';
export type ReadinessItem = {
  capability: ReadinessCapability;
  /** What the wearer would call it, not what the code calls it. */
  label: string;
  state: ReadinessState;
  /** What was actually observed. Never a URL, token, pairing code or device key. */
  detail: string;
  /** Exactly one sentence. For an `ok` item it is what keeps it ok. */
  nextAction: string;
};
export type Readiness = {
  voiceDelivery?: ReadinessFacts['voiceDelivery'];
  ready: boolean;
  blocking: ReadinessCapability[];
  items: ReadinessItem[];
  checkedAt: string;
};
export const readinessSchema = z.object({
  sessionId: sessionIdSchema,
  /**
   * Render one short clip through the configured reply voice before answering.
   * Off by default because the OAuth route is a network round trip; on when a
   * caller is about to depend on the wearer hearing something.
   */
  speechCheck: z.boolean().optional(),
}).strict();

/** The measured facts, gathered by the host; assembling them is pure. */
export type ReadinessFacts = {
  voiceDelivery?: { mode: 'channel' | 'polling' | 'none'; channelActive: boolean; acknowledgement: 'unavailable'; assistant: string | null };
  hasScene: boolean;
  panels: ReadonlyArray<{ surface?: string; availability?: string; current?: boolean }>;
  share?: { expiresAt: string; pairedDevices: number; headsetsPaired: number; target?: CompanionHeadset; headset?: 'vision-pro'; connected?: boolean };
  shareExpiredAt?: string;
  agentAttached: boolean;
  /** Milliseconds since `listen_voice`/`poll_voice_transcripts` last ran, or undefined for never. */
  listenAgeMs?: number;
  /** Age of an admitted action/reply for a claimed utterance, never generic traffic. */
  actionAgeMs?: number;
  listenWindowMs: number;
  transcription: { enabled: boolean; ready: boolean; route?: string; detail: string; missing: string[]; captureObserved?: boolean };
  replies: { enabled: boolean; ready: boolean; detail: string; dryRun?: 'passed' | 'failed' | 'skipped' };
  headset: { checked: boolean; ok?: boolean; serial?: string; reason?: string };
  checkedAt: string;
};

/** Prefer the connected page's XR report; Safari's pairing User-Agent can look like a Mac. */
export function pairedSessionHeadset(_target: CompanionHeadset,
  clients: ReadonlyArray<{ deviceClass: string; lastUsedAt: string }>, reportedClass?: string): 'vision-pro' | undefined {
  if (!clients.length) return undefined;
  if (reportedClass && reportedClass !== 'unknown') return reportedClass === 'vision-pro' ? 'vision-pro' : undefined;
  const latest = [...clients].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
  if (latest?.deviceClass === 'vision-pro') return 'vision-pro';
  return undefined;
}

/** A Quest adb browser reading cannot describe an Apple LAN session. */
export function visionProStatus(share: ReadinessFacts['share']): string | undefined {
  // A launch target is intent, not evidence about the peer that paired later.
  if (share?.pairedDevices && share.headset === 'vision-pro')
    return share.connected
      ? 'Apple Vision Pro page is connected over Wi-Fi; USB device state is Quest-only.'
      : 'Apple Vision Pro is paired over Wi-Fi; waiting for its page to reconnect; USB device state is Quest-only.';
  if (share?.pairedDevices === 0 && share.target === 'apple')
    return 'Waiting for the Apple Vision Pro page; USB device state is Quest-only.';
  return undefined;
}

function readinessStructure(facts: ReadinessFacts): ReadinessItem {
  const where = (panel: { surface?: string; availability?: string }) => `${panel.surface ?? 'panel'} ${panel.availability ?? 'unknown'}`;
  // A reopened browser can leave its previous panel answering heartbeats until
  // the surface grace expires. The command registry returns panels in attach
  // order, so the last current panel for each named surface is the one a person
  // most recently opened. Readiness is a surface summary, not a tab inventory:
  // say "companion ready" once and do not let an older ready companion hide a
  // newer companion that is still busy or unsaved.
  const newestBySurface = new Map<string, ReadinessFacts['panels'][number]>();
  facts.panels.forEach((panel, index) => {
    if (panel.current) newestBySurface.set(panel.surface ?? `panel-${index}`, panel);
  });
  const mounted = [...newestBySurface.values()];
  const ready = mounted.filter(panel => panel.availability === 'ready');
  if (mounted.length === 0) {
    return { capability: 'structure', label: 'structure', state: 'missing', detail: 'no panel is mounted on this source',
      nextAction: 'Open the inspection panel — call inspect, or reload the companion page — and wait for it to report ready.' };
  }
  if (ready.length === 0) {
    return { capability: 'structure', label: 'structure', state: 'missing',
      detail: `mounted but not ready: ${mounted.map(where).join(', ')}`,
      nextAction: 'Wait for the panel to finish rendering; a panel stuck on unsaved needs the companion page reloaded once.' };
  }
  if (!facts.hasScene) {
    return { capability: 'structure', label: 'structure', state: 'missing', detail: 'a panel is ready but no scene has been saved yet',
      nextAction: 'Let the panel save its first scene: read get_inspection_state until hasScene is true before sending any command.' };
  }
  return { capability: 'structure', label: 'structure', state: 'ok', detail: `saved scene; ${ready.map(where).join(', ')}`,
    nextAction: 'Nothing to do; send commands to the ready panel you intend, never to whichever one answers first.' };
}

function readinessShare(facts: ReadinessFacts): ReadinessItem {
  if (!facts.share) {
    return { capability: 'share', label: 'share', state: 'missing',
      detail: facts.shareExpiredAt ? `the private Wi-Fi share expired at ${facts.shareExpiredAt}` : 'no private Wi-Fi share is open',
      nextAction: 'Run open_companion with connection="lan" and launch="web", then press Open once in the browser it raises.' };
  }
  if (facts.share.pairedDevices === 0) {
    return { capability: 'share', label: 'share', state: 'missing', detail: `share open until ${facts.share.expiresAt}; nothing has paired`,
      nextAction: 'Put the page on the headset with manage_companion action="launch" launch="web" and enter the pairing code once.' };
  }
  return { capability: 'share', label: 'share', state: 'ok',
    detail: `${facts.share.pairedDevices} paired client${facts.share.pairedDevices === 1 ? '' : 's'}`
      + `${facts.share.headsetsPaired ? ` (${facts.share.headsetsPaired} headset)` : ''}, open until ${facts.share.expiresAt}`,
    nextAction: `Nothing to do before ${facts.share.expiresAt}; after that run open_companion again and a remembered headset re-pairs with no code.` };
}

function readinessAgent(facts: ReadinessFacts): ReadinessItem {
  if (facts.voiceDelivery?.channelActive) return {
    capability: 'agent', label: 'agent', state: facts.actionAgeMs !== undefined && facts.actionAgeMs <= facts.listenWindowMs ? 'ok' : 'not-checked',
    detail: `${facts.voiceDelivery.assistant ?? 'Claude'} is listening (channel); delivery is best effort, without acknowledgement`,
    nextAction: 'Keep Claude Code open with the channel enabled; verify a scene action or spoken reply. Use listen_voice to recover a dropped push.',
  };
  const seconds = facts.listenAgeMs === undefined ? undefined : Math.round(facts.listenAgeMs / 1000);
  if (facts.listenAgeMs === undefined || facts.listenAgeMs > facts.listenWindowMs) {
    return { capability: 'agent', label: 'agent', state: 'missing',
      detail: seconds === undefined ? 'nothing has listened to the wearer on this host yet' : `the last listen was ${seconds} s ago`,
      nextAction: 'Connect a conversation consumer that keeps calling listen_voice and acts on returned utterance IDs; polling alone does not prove it can answer.' };
  }
  if (facts.actionAgeMs === undefined || facts.actionAgeMs > facts.listenWindowMs || !facts.agentAttached) {
    return { capability: 'agent', label: 'agent', state: 'missing',
      detail: facts.actionAgeMs === undefined ? 'listener polled, but no conversation request has been processed'
        : `conversation consumer unavailable; last processed request ${Math.round(facts.actionAgeMs / 1000)} s ago`,
      nextAction: 'Connect a conversation consumer that listens and acts on utterance IDs; a transcript printer alone cannot answer. Manual controls remain available.' };
  }
  return { capability: 'agent', label: 'agent', state: 'ok',
    detail: `listened ${seconds} s ago; processed a request ${Math.round(facts.actionAgeMs / 1000)} s ago`,
    nextAction: 'Keep the conversation consumer running; manual controls remain available if it stalls.' };
}

function readinessTranscription(facts: ReadinessFacts): ReadinessItem {
  const transcription = facts.transcription;
  const enable = 'Restart the host with --ptt, or set STEREOFOLD_PTT_TRANSCRIBE=1 in the MCP server environment and restart the host (remove --no-ptt if present).';
  const prerequisites = `recognizer prerequisites missing: ${transcription.missing.join(', ') || 'a local recognizer'}`;
  const configureWhisper = 'For Whisper, install whisper.cpp and ffmpeg, then set STEREOFOLD_WHISPER_BIN and STEREOFOLD_FFMPEG_BIN to executables and STEREOFOLD_WHISPER_MODEL to a readable model file.';
  const configureApple = 'On macOS, build the Apple recognizer with `sh native/applespeech/build.sh` from the plugin directory, install ffmpeg for headset recordings, and set STEREOFOLD_PTT_TRANSCRIBER=apple and STEREOFOLD_APPLESPEECH_BIN to the built executable.';
  const repair = transcription.route === 'apple' ? `${configureApple} Alternatively, ${configureWhisper}` : `${configureWhisper} Alternatively, ${configureApple}`;
  if (!facts.transcription.enabled) {
    return { capability: 'transcription', label: 'transcription', state: 'missing',
      detail: `headset voice is off on this host: ${transcription.detail}${transcription.ready ? '; recognizer configured' : `; ${prerequisites}`}`,
      nextAction: transcription.ready ? enable : `${repair} Then enable capture: ${enable}` };
  }
  if (!facts.transcription.ready) {
    return { capability: 'transcription', label: 'transcription', state: 'missing',
      detail: `voice is on but nothing can transcribe: ${prerequisites}; ${transcription.detail}`,
      nextAction: `${repair} Restart the host after configuring the recognizer.` };
  }
  return { capability: 'transcription', label: 'transcription', state: facts.transcription.captureObserved ? 'ok' : 'not-checked',
    detail: facts.transcription.captureObserved
      ? `${facts.transcription.detail.replace('; consent not yet observed', '')}; microphone capture transcribed in this session`
      : `${facts.transcription.detail}; capture/permission not yet observed in this session`,
    nextAction: facts.transcription.captureObserved
      ? 'Nothing to do; microphone capture has been transcribed in this session.'
      : facts.transcription.route === 'apple'
      ? 'Make a short microphone recording and confirm its transcript before the headset goes on. If macOS asks, answer the Speech Recognition dialog in the app that started this host; the first transcription may raise it.'
      // Push-to-talk is on A and X, not the grip
      // (lab/browser-roundtrip/xr-buttons.mjs:104-105).
      : 'Make a short microphone recording (hold A or X on the headset), allow microphone access if asked, and confirm its transcript in this session.' };
}

function readinessReplies(facts: ReadinessFacts): ReadinessItem {
  if (!facts.replies.enabled) {
    return { capability: 'replies', label: 'replies', state: 'missing', detail: 'spoken replies are turned off',
      nextAction: 'Unset STEREOFOLD_REPLY_AUDIO, or set it to 1, so the wearer hears an answer instead of only reading one.' };
  }
  if (!facts.replies.ready || facts.replies.dryRun === 'failed') {
    return { capability: 'replies', label: 'replies', state: 'missing',
      detail: facts.replies.dryRun === 'failed' ? `the voice route is configured but a one-word synthesis failed: ${facts.replies.detail}` : facts.replies.detail,
      nextAction: 'Repair the configured reply voice route and rerun get_readiness with speechCheck=true. For oauth, check agent-voice and its existing OAuth login; for system, check say and ffmpeg. Keep the selected provider.' };
  }
  return { capability: 'replies', label: 'replies', state: 'ok',
    detail: `${facts.replies.detail}${facts.replies.dryRun === 'passed' ? '; a one-word synthesis produced audio' : ''}`,
    nextAction: facts.replies.dryRun === 'passed' ? 'Audio generation passed. Confirm playback on the connected headset before reporting that the wearer heard it.'
      : 'Nothing to do, though only a speechCheck run proves this Mac can actually render a clip.' };
}

function readinessHeadset(facts: ReadinessFacts): ReadinessItem {
  if (facts.share?.pairedDevices && facts.share.headset === 'vision-pro') {
    return facts.share.connected
      ? { capability: 'headset', label: 'headset', state: 'ok',
          detail: 'Apple Vision Pro page is connected over Wi-Fi; USB device state is Quest-only',
          nextAction: 'Nothing to do; the LAN share carries this headset session.' }
      : { capability: 'headset', label: 'headset', state: 'not-checked',
          detail: 'Apple Vision Pro is paired over Wi-Fi; waiting for its page to reconnect; USB device state is Quest-only',
          nextAction: 'Open the paired page on Apple Vision Pro.' };
  }
  if (facts.share?.pairedDevices === 0 && facts.share.target === 'apple') {
    return { capability: 'headset', label: 'headset', state: 'not-checked',
      detail: 'Waiting for the Apple Vision Pro page; USB device state is Quest-only',
      nextAction: 'Open the share in Vision Pro Safari and pair the page.' };
  }
  if (facts.share?.pairedDevices && facts.share.connected) {
    const debugging = facts.headset.ok ? `adb sees ${facts.headset.serial}`
      : facts.headset.reason ?? 'optional debugging has not been checked';
    return { capability: 'headset', label: 'headset', state: 'ok',
      detail: `Headset page is connected over Wi-Fi; ${debugging}`,
      nextAction: 'The paired page establishes this connection. Check its live immersive state before claiming VR rendering; debugging is optional.' };
  }
  if (!facts.headset.checked) {
    return { capability: 'headset', label: 'headset', state: 'not-checked',
      detail: facts.headset.reason ?? 'Optional headset debugging has not been checked.',
      nextAction: 'Use the paired page to check the headset connection. adb over USB or authorized Wi-Fi adds device captures and browser recovery; it is optional.' };
  }
  if (!facts.headset.ok) {
    return { capability: 'headset', label: 'headset', state: 'not-checked',
      detail: `Optional headset debugging unavailable: ${facts.headset.reason ?? 'no ready adb transport'}. This does not establish headset connectivity.`,
      nextAction: 'Check the paired page for connection status. For optional diagnostics, reconnect the known authorized Wi-Fi endpoint or selected USB transport; do not infer headset power from this check.' };
  }
  return { capability: 'headset', label: 'headset', state: 'ok', detail: `adb sees ${facts.headset.serial}`,
    nextAction: 'Captures and browser recovery are available over this debugging transport. Its presence alone does not prove the page is paired or in VR.' };
}

export function assembleReadiness(facts: ReadinessFacts): Readiness {
  const items = [readinessStructure(facts), readinessShare(facts), readinessAgent(facts),
    readinessTranscription(facts), readinessReplies(facts), readinessHeadset(facts)];
  const blocking = items.filter(item => item.state === 'missing' || ((item.capability === 'transcription'
    || (item.capability === 'agent' && facts.voiceDelivery?.channelActive)) && item.state === 'not-checked')).map(item => item.capability);
  return { ready: blocking.length === 0, blocking, items, checkedAt: facts.checkedAt,
    ...(facts.voiceDelivery ? {voiceDelivery: facts.voiceDelivery} : {}) };
}

/**
 * The one block. `setup-doctor`, `headset-drive` and the agent CLI all print
 * this exact text, so an operator comparing two hosts is comparing two
 * readings rather than two formats.
 */
export function formatReadiness(readiness: Readiness): string {
  const width = Math.max(...READINESS_CAPABILITIES.map(name => name.length));
  const mark = (state: ReadinessState) => state === 'ok' ? 'OK' : state === 'missing' ? '!!' : '--';
  const headline = readiness.ready ? 'READY' : `ATTENTION — ${readiness.blocking.join(', ')}`;
  const lines = [`Stereofold headset readiness: ${headline}`];
  for (const item of readiness.items) {
    lines.push(`${mark(item.state)} ${item.label.padEnd(width)}  ${item.detail}`);
    if (item.state !== 'ok') lines.push(`${' '.repeat(width + 3)}  -> ${item.nextAction}`);
  }
  return lines.join('\n');
}

/** What a refusal quotes: the blocking items, each with its one sentence. */
export function readinessBlockingSentences(readiness: Readiness, capabilities: readonly ReadinessCapability[]): string[] {
  return readiness.items.filter(item => readiness.blocking.includes(item.capability) && capabilities.includes(item.capability))
    .map(item => `${item.label}: ${item.detail}. ${item.nextAction}`);
}

/**
 * Joining the one scene on this Mac, and who is listening.
 *
 * Both schemas are additive. Every tool that existed before these schemas keeps its
 * exact input, so a person running one host alone never meets either of them.
 */
export const assistantLabelSchema = z.string().trim().min(1).max(40);
export const continueSessionSchema = z.object({
  /** The name a person would say for this assistant, such as Claude or Codex. */
  assistant: assistantLabelSchema.optional(),
}).strict();
export type ContinueSessionInput = z.output<typeof continueSessionSchema>;
export const switchAssistantSchema = z.object({
  sessionId: sessionIdSchema,
  /** Who listens next. Omit it to read who is listening now. */
  to: assistantLabelSchema.optional(),
}).strict();
export type SwitchAssistantInput = z.output<typeof switchAssistantSchema>;
/** The shared-scene facts a continuation result carries beside the usual state. */
export type SceneContinuation = {
  role: 'owner' | 'attached' | 'none';
  sceneId?: string;
  sessionId?: string;
  tookOver?: boolean;
  reason?: string;
};
