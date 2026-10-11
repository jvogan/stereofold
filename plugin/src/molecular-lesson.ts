// @ts-ignore Shared numerical placement guardrails used by the renderer.
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../../lab/browser-roundtrip/placement-limits.mjs';
import { z } from 'zod';
import { lessonFigureSchema } from './lesson-figure.js';
// @ts-ignore Shared bounded visibility identifiers used by the renderer.
import { MAX_HIDDEN_CHAINS, MAX_VISIBILITY_IDENTIFIER } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

/**
 * A portable, source-backed lesson plan for the installed Molecular Structure
 * Viewer. This module is deliberately a planner: it does not open a viewer,
 * mutate a live scene, or pretend to know a session revision.
 */

export const MOLECULAR_LESSON_VERSION = 1 as const;
export const MOLECULAR_LESSON_LIMITS = {
  /**
   * Each chapter becomes one headset tour step carrying its caption, sources and
   * immersive intent inline. Twenty-four captions at the 2,000-character limit
   * come to 48 KB, far under the 8 MiB inline hydration bound.
   */
  maxChapters: 24,
  /** Changes per chapter. A 60 s chapter at 16 changes already averages under 4 s each. */
  maxChapterSteps: 16,
  /**
   * Every tour step repeats the lesson's source list. At 24 chapters and 16 refs
   * of about 120 bytes each, the repeated list is about 46 KB.
   */
  maxSourceRefs: 16,
  /**
   * One entry per compiled scene change. Each caption is bounded by
   * maxCaptionCharacters, so 128 steps hold at most 256 KB of caption text.
   */
  maxTotalSteps: 128,
  /**
   * A wearer-session length, not a measured device bound. The per-step cap, the
   * chapter cap and the step cap still bound the work a lesson can ask for.
   */
  maxLessonDurationSeconds: 600,
  /**
   * A single cinematic step stays capped at 20 s, but a taught chapter is
   * longer than any one step: a narrated scene needs 30-50 s to name a part,
   * let the wearer find it and look at it. Capping the chapter at the step
   * limit is what made a six-chapter lesson compile to 51 seconds.
   */
  maxChapterDurationSeconds: 60,
  maxMovieDurationSeconds: 20,
  minTotalDurationSeconds: 0.5,
  maxCaptionCharacters: 2_000,
} as const;

const idSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/iu);
const titleSchema = z.string().trim().min(1).max(120);
const captionSchema = z.string().trim().min(1).max(MOLECULAR_LESSON_LIMITS.maxCaptionCharacters);
const durationSchema = z.number().finite().min(0.1).max(20);
/** A chapter is a taught scene, not one cinematic step. See maxChapterDurationSeconds. */
const chapterDurationSchema = z.number().finite().min(0.1).max(MOLECULAR_LESSON_LIMITS.maxChapterDurationSeconds);
const vector3Schema = z.array(z.number().finite()).length(3);
const easingSchema = z.enum(['linear', 'ease_in', 'ease_out', 'ease_in_out']);
const objectIdSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/iu);
const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/iu);

/** Authored chain visibility uses the same operations as inspection commands. */
const lessonVisibilitySchema = z.object({
  op: z.enum(['hide', 'show', 'only', 'reset']),
  chains: z.array(z.union([
    z.string().trim().min(1).max(MAX_VISIBILITY_IDENTIFIER + 6),
    z.object({
      labelChain: z.string().trim().min(1).max(MAX_VISIBILITY_IDENTIFIER),
      copyId: z.string().trim().min(1).max(MAX_VISIBILITY_IDENTIFIER),
    }).strict(),
  ])).max(MAX_HIDDEN_CHAINS).optional(),
  classes: z.array(z.enum(['water', 'ligand', 'ion', 'polymer'])).max(4).optional(),
}).strict().superRefine((value, context) => {
  const named = Boolean(value.chains?.length || value.classes?.length);
  if (value.op === 'reset' && named)
    context.addIssue({ code: 'custom', message: 'A reset brings everything back and names nothing.' });
  if (value.op !== 'reset' && !named)
    context.addIssue({ code: 'custom', message: `Name a chain or a component class to ${value.op === 'only' ? 'show only' : value.op}.` });
});
export type LessonVisibility = z.output<typeof lessonVisibilitySchema>;

const selectionExprSchema = z.record(z.string(), z.unknown()).superRefine((expression, context) => {
  const allowed = new Set(['all', 'atom_ids', 'object', 'model', 'entity', 'chain', 'residue_range', 'residue', 'atom', 'component', 'property', 'allOf', 'anyOf', 'not', 'within', 'bondedTo', 'expandEntity', 'current', 'named']);
  if (typeof expression.kind !== 'string' || !allowed.has(expression.kind)) {
    context.addIssue({ code: 'custom', message: 'Target must carry an exact public SelectionExpr v1 kind.', path: ['kind'] });
  }
});

const layerRepresentationSchema = z.enum(['cartoon', 'backbone', 'putty', 'surface', 'gaussian_surface', 'ball_and_stick', 'sticks', 'lines', 'points', 'spheres', 'ellipsoid', 'carbohydrate', 'gaussian_volume', 'label', 'orientation', 'plane', 'polyhedron', 'interactions']);
const layerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  representation: layerRepresentationSchema,
  colorOverrides: z.array(z.object({ target: z.record(z.string(), z.unknown()), color: z.record(z.string(), z.unknown()) }).strict()).max(16).optional(),
  target: z.record(z.string(), z.unknown()),
  color: z.record(z.string(), z.unknown()).optional(),
  labelMode: z.enum(['atom', 'residue', 'chain']).optional(),
  labels: z.boolean().optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  representationOptions: z.record(z.string(), z.unknown()).optional(),
  visible: z.boolean().optional(),
}).strict().superRefine((layer, context) => {
  const targetResult = selectionExprSchema.safeParse(layer.target);
  if (!targetResult.success) context.addIssue({ code: 'custom', message: 'Layer target must be an exact public SelectionExpr v1 object.', path: ['target'] });
});

/** Source references are supplied by the caller; the compiler never invents URLs. */
const sourceRefSchema = z.object({
  kind: z.enum(['local', 'public', 'publication']),
  ref: z.string().trim().min(1).max(2_048),
}).strict();

/**
 * This is the public render-target vocabulary from structure-viewer 0.1.80.
 * `expression` is intentionally opaque here: callers must pass the exact
 * SelectionExpr v1 object obtained from the viewer, rather than this module
 * guessing selection-expression internals.
 */
const renderTargetSchema = z.record(z.string(), z.unknown()).superRefine((target, context) => {
  const kind = target.kind;
  const allowed = new Set([
    'all', 'expression', 'current_selection', 'current_focus', 'chain', 'ligand',
    'residue', 'residue_range', 'residues', 'ligand_contacts',
  ]);
  if (typeof kind !== 'string' || !allowed.has(kind)) {
    context.addIssue({ code: 'custom', message: 'Target kind is not in the standard-viewer render-target vocabulary.', path: ['kind'] });
  }
  if (kind === 'expression' && (target.expression == null || typeof target.expression !== 'object')) {
    context.addIssue({ code: 'custom', message: 'Expression targets must carry the exact public SelectionExpr object.', path: ['expression'] });
  }
});

const cameraSchema = z.object({
  clippingRadius: z.number().finite().positive().max(1e9).optional(),
  farClip: z.number().finite().positive().optional(),
  fovDegrees: z.number().finite().min(10).max(120).optional(),
  focus: renderTargetSchema.optional(),
  mode: z.enum(['perspective', 'orthographic']).optional(),
  nearClip: z.number().finite().nonnegative().optional(),
  orientation: z.enum(['current', 'front', 'back', 'left', 'right', 'top', 'bottom']).optional(),
  position: vector3Schema.optional(),
  target: vector3Schema.optional(),
  up: vector3Schema.optional(),
  zoom: z.number().finite().min(0.1).max(10).optional(),
}).strict().refine(({ farClip, nearClip }) => farClip == null || nearClip == null || farClip > nearClip, 'farClip must be greater than nearClip.');

const scenePatchSchema = z.object({
  antialiasing: z.enum(['off', 'fast', 'quality']).optional(),
  annotations: z.array(z.unknown()).max(32).optional(),
  background: hexColorSchema.optional(),
  camera: cameraSchema.optional(),
  clearExisting: z.boolean().optional(),
  density: z.array(z.unknown()).max(32).optional(),
  layers: z.array(layerSchema).max(64).optional(),
  lighting: z.enum(['flat', 'soft', 'studio']).optional(),
  measurements: z.array(z.unknown()).max(32).optional(),
  scientificAnnotations: z.record(z.string(), z.unknown()).optional(),
  viewSettings: z.record(z.string(), z.unknown()).optional(),
  representationOptions: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((scene) => Object.keys(scene).length > 0, 'Scene changes must contain at least one supported scene field.');

const transformSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('components'),
    pivot: z.union([z.literal('object_center'), vector3Schema]).optional(),
    rotation: z.object({ axis: vector3Schema.refine((value) => Math.hypot(...value) > 1e-8, 'Rotation axis must be non-zero.'), degrees: z.number().finite().min(-3_600).max(3_600) }).strict().optional(),
    scale: z.union([z.number().finite().min(0.01).max(100), z.array(z.number().finite().min(0.01).max(100)).length(3)]).optional(),
    translation: vector3Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('matrix'),
    values: z.array(z.number().finite()).length(16),
  }).strict().superRefine(({ values }, context) => {
    if (Math.abs(values[3] ?? 0) > 1e-8 || Math.abs(values[7] ?? 0) > 1e-8 || Math.abs(values[11] ?? 0) > 1e-8 || Math.abs((values[15] ?? 0) - 1) > 1e-8) {
      context.addIssue({ code: 'custom', message: 'Transform matrices must be affine with final row [0, 0, 0, 1].', path: ['values'] });
    }
  }),
]);

const commonMotion = {
  durationSeconds: durationSchema,
  easing: easingSchema.default('ease_in_out'),
};

/** Exact bounded subset of the installed viewer's movie timeline vocabulary. */
const lessonChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...commonMotion,
    axis: z.enum(['vertical', 'horizontal', 'screen']).default('vertical'),
    degrees: z.number().finite().min(-3_600).max(3_600),
    kind: z.literal('rotate'),
  }).strict(),
  z.object({
    ...commonMotion,
    angleDegrees: z.number().finite().min(0).max(180).default(10),
    axis: vector3Schema.refine((value) => Math.hypot(...value) > 1e-8, 'Rock axis must be non-zero.').default([0, -1, 0]),
    cycles: z.number().int().min(1).max(10).default(1),
    kind: z.literal('rock'),
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('camera_spin'),
    axis: vector3Schema.refine((value) => Math.hypot(...value) > 1e-8, 'Camera-spin axis must be non-zero.').default([0, -1, 0]),
    turns: z.number().int().min(1).max(10).default(1),
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('spin'),
    objectIds: z.array(objectIdSchema).min(1).max(64).optional(),
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('zoom'),
    magnification: z.number().finite().min(0.1).max(10),
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('focus'),
    target: renderTargetSchema,
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('scene'),
    scene: scenePatchSchema,
    transition: z.enum(['cut', 'smooth']).default('smooth'),
  }).strict(),
  z.object({
    ...commonMotion,
    camera: z.record(z.string(), z.unknown()),
    kind: z.literal('camera'),
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('visibility'),
    objectId: objectIdSchema,
    visible: z.boolean(),
  }).strict(),
  z.object({
    ...commonMotion,
    kind: z.literal('transform'),
    mode: z.enum(['absolute', 'relative']).default('relative'),
    objectId: objectIdSchema,
    transform: transformSchema,
  }).strict(),
  z.object({
    durationSeconds: durationSchema,
    kind: z.literal('hold'),
  }).strict(),
]);

export const chapterMotionObjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('orbit'),
    degrees: z.number().finite().min(-360).max(360),
    seconds: z.number().finite().positive().max(60),
    axis: z.enum(['x', 'y', 'z']).default('y').optional(),
  }).strict(),
  z.object({
    kind: z.literal('dolly'),
    metres: z.number().finite().min(-10).max(10),
    seconds: z.number().finite().positive().max(60),
  }).strict(),
  z.object({
    kind: z.literal('turntable'),
    degrees: z.number().finite().min(-3600).max(3600).optional(),
    seconds: z.number().finite().positive().max(60).optional(),
  }).strict(),
  z.object({
    kind: z.literal('hold'),
    seconds: z.number().finite().positive().max(60).optional(),
  }).strict(),
]);

export const chapterMotionSchema = z.union([
  z.enum(['spin', 'hold']),
  chapterMotionObjectSchema,
]);

export type ChapterMotionObject = z.infer<typeof chapterMotionObjectSchema>;
export type ChapterMotion = z.infer<typeof chapterMotionSchema>;

const chapterSchema = z.object({
  id: idSchema,
  title: titleSchema,
  caption: captionSchema,
  durationSeconds: chapterDurationSchema,
  changes: z.array(lessonChangeSchema).min(1).max(MOLECULAR_LESSON_LIMITS.maxChapterSteps),
  immersive: z.object({
    appearance: z.object({
      background: hexColorSchema.optional(),
      // `isosurface` is the one representation here that is not
      // drawn from atoms. It is a marching-cubes mesh over a density map, so it
      // belongs to a manifest whose `coordinates` are a volume and to no other
      // — the superRefine on the manifest below enforces exactly that. It is
      // deliberately NOT added to `layerRepresentationSchema`, which is the
      // desktop structure-viewer's atomic vocabulary and has no volume in it.
      representation: z.enum(['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill', 'isosurface']).optional(),
      color: z.enum(['chain-id', 'element-symbol', 'residue-name', 'sequence-id', 'uniform']).optional(),
      uniformColor: hexColorSchema.optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
      labels: z.boolean().optional(),
      // One billboarded name plate per colour-key part, drawn at the part's
      // centroid in the part's colour through the same text billboard as every
      // other in-scene label. Opt-in per chapter so existing lessons — which
      // never set it — draw exactly what they drew before; the viewer strips it
      // before the saved-scene appearance sees it, so it never lands in a saved
      // scene either.
      componentLabels: z.boolean().optional(),
      clipping: z.number().finite().min(0).max(80).optional(),
      fog: z.number().finite().min(0).max(100).optional(),
    }).strict().superRefine((appearance, context) => {
      if (appearance.color === 'uniform' && appearance.uniformColor == null) {
        context.addIssue({ code: 'custom', message: 'Uniform immersive color requires uniformColor.', path: ['uniformColor'] });
      }
    }).optional(),
    placement: z.object({
      translation: vector3Schema.refine((value) => value.every((component) => Math.abs(component) <= PLACEMENT_MAX_TRANSLATION), 'Immersive translation exceeds the numerical placement range.').optional(),
      rotation: vector3Schema.refine((value) => value.every((component) => component >= -360 && component <= 360), 'Immersive rotation components must be between -360 and 360.').optional(),
      scale: z.number().finite().min(PLACEMENT_MIN_SCALE).max(PLACEMENT_MAX_SCALE).optional(),
    }).strict().optional(),
    view: z.enum(['fit', 'reset-orientation']).optional(),
    // Cinematic motion per chapter.
    // Supports continuous 'spin' / 'hold', or an authored move:
    // orbit a few degrees, slow dolly toward the lit part, gentle turntable, or hold.
    motion: chapterMotionSchema.optional(),
    narration: z.string().trim().min(1).max(200).optional(),
    // Changes the visible subset without loading another source or framing it.
    visibility: lessonVisibilitySchema.optional(),
    // The one in-scene label a chapter can put on the molecule.
    //
    // `TourStep.selection` and the viewer's residue labels both already existed;
    // no lesson could reach either, so a chapter could emphasise the PAM and
    // still leave a wearer with no way to read what the yellow was. Selecting a
    // handful of residues with `appearance.labels` on draws Mol*'s own residue
    // labels at those residues, anchored to the atoms and carried by the same
    // transform as the structure, so they survive the presentation spin and a
    // grab. That is why this is the label route and not a new 3D text shape:
    // the shape would need its own per-frame transform, and this needs none.
    //
    // Keep the range small. The viewer draws at most 32 labels and stops, so a
    // whole chain selected here is a truncated, unreadable mess rather than a
    // label; a three-residue PAM is three words on the molecule.
    selection: z.union([z.literal('clear'), z.object({
      chain: z.string().trim().min(1).max(8).optional(),
      residues: z.object({
        from: z.number().int().min(-9_999).max(99_999),
        to: z.number().int().min(-9_999).max(99_999),
      }).strict().refine(({ from, to }) => to >= from, 'A residue range must not run backwards.').optional(),
    }).strict().refine((value) => value.chain != null || value.residues != null,
      'An immersive selection must name a chain, a residue range, or both.')]).optional(),
    // The field that lets a chapter point at something.
    //
    // Appearance is whole-structure by construction, so before this a chapter
    // could only restate a representation and a colour and leave the wearer to
    // find the named part themselves. `parts` is the lesson's colour key,
    // written identically into every chapter so the wearer learns one mapping,
    // and `focus` names the single part that stays opaque while the rest fades
    // to `contextOpacity` instead of vanishing — emphasis that keeps the part's
    // position in the complex readable. A chapter with no `focus` shows the
    // whole key at full strength, which is what a recap wants.
    //
    // Chains and residue numbers here are AUTHOR identifiers, the ones a paper
    // and a Mol* label both use. Author numbering is not always the canonical
    // numbering for a protein; a lesson that differs must say so in `note`.
    emphasis: z.object({
      parts: z.array(z.object({
        id: idSchema,
        label: z.string().trim().min(1).max(60),
        aliases: z.array(z.string().trim().min(1).max(60)).max(16).optional(),
        color: hexColorSchema,
        chain: z.string().trim().min(1).max(8).optional(),
        residues: z.object({
          from: z.number().int().min(-9_999).max(99_999),
          to: z.number().int().min(-9_999).max(99_999),
        }).strict().refine(({ from, to }) => to >= from, 'A residue range must not run backwards.').optional(),
        note: z.string().trim().max(300).optional(),
      }).strict().refine((part) => part.chain != null || part.residues != null,
        'An emphasis part must name a chain, a residue range, or both.'))
        // 12 held every chain and domain of this complex and
        // nothing else. A marker part — the amber band the PAM's three
        // nucleotides sit inside, so three yellow bases are findable at wearer
        // resolution — is a thirteenth, and a second lesson would want its own.
        .min(1).max(16),
      // One part, or the several that make up one idea: RuvC is a single active
      // site assembled from three separate stretches of the chain, and a
      // chapter about it has to light all three.
      //
      // Bounded by the key itself rather than by eight. The
      // microtubule wall tier is six copies of one dimer, so "the whole wall"
      // is twelve parts, and capping the focus at eight forced that chapter to
      // either light a subset or author no focus at all — and no focus means
      // "paint the whole key and fade nothing", which is what put three fully
      // lit strands under a caption about one of them. A focus
      // can never name more parts than the key carries, so that is the bound.
      focus: z.union([idSchema, z.array(idSchema).min(1).max(16)]).optional(),
      contextOpacity: z.number().finite().min(0).max(1).default(0.12),
      framing: z.enum(['fill', 'context']).optional(),
      // On a whole-structure wall chapter, shade one lightness step per protofilament so the three strands stay countable while alpha stays blue and beta stays amber.
      strandShades: z.boolean().optional(),
    }).strict().superRefine((emphasis, context) => {
      const ids = emphasis.parts.map((part) => part.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', message: 'Emphasis part ids must be unique.', path: ['parts'] });
      }
      const focus = emphasis.focus == null ? [] : (Array.isArray(emphasis.focus) ? emphasis.focus : [emphasis.focus]);
      for (const wanted of focus) {
        if (!ids.includes(wanted)) {
          context.addIssue({ code: 'custom', message: `Emphasis focus "${wanted}" is not one of the colour-key parts.`, path: ['focus'] });
        }
      }
      // Framing with no focus frames the whole complex, and is
      // how an opening or a recap chapter gets a deterministic size and place
      // instead of whatever the wearer's entry seat happened to leave behind.
    }).optional(),
    figure: lessonFigureSchema.optional(),
  }).strict().refine((immersive) => immersive.appearance != null || immersive.placement != null || immersive.view != null
    || immersive.motion != null || immersive.narration != null || immersive.visibility != null || immersive.emphasis != null || immersive.figure != null, 'Immersive chapter controls cannot be empty.').optional(),
}).strict();

const manifestSchema = z.object({
  version: z.literal(MOLECULAR_LESSON_VERSION),
  id: idSchema,
  title: titleSchema,
  mode: z.enum(['explore', 'guided']),
  provenance: z.object({
    sourceRefs: z.array(sourceRefSchema).min(1).max(MOLECULAR_LESSON_LIMITS.maxSourceRefs),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/iu).optional(),
    note: z.string().trim().max(2_000).optional(),
  }).strict(),
  chapters: z.array(chapterSchema).min(1).max(MOLECULAR_LESSON_LIMITS.maxChapters),
  /**
   * How the lesson presents itself in immersion.
   *
   * `captionCard` governs the headset's caption card — the chapter title,
   * the `Scene n / m` counter and the narration lines drawn on the plate
   * above the menu for each chapter. `hidden` is for a lesson the owner
   * wants shown as a plain labelled structure with no tour chrome:
   * narration still plays and the Talk button still works, because voice is
   * a control, not chrome. Optional and defaulting to `shown`, so a lesson
   * that does not set it compiles to exactly the timeline and caption
   * annotations it compiled to before.
   */
  presentation: z.object({
    captionCard: z.enum(['hidden', 'shown']).default('shown'),
    end: z.enum(['rest', 'hold']).optional(),
  }).strict().optional(),
  /**
   * What this lesson is drawn from, when it is not atoms.
   *
   * Every other lesson's subject is a coordinate file, and the only thing the
   * manifest has to say about it is its digest, which `provenance.sourceSha256`
   * already carries. A density map needs two more facts before anything can be
   * drawn: the isosurface level, and the mean-downsample factor that level is
   * quoted on. Neither is derivable from the bytes — a contour is a choice, and
   * downsampling moves it — so they are authored here, beside the digest of the
   * PREPARED map they describe.
   *
   * `contour` is the absolute level on the prepared map. Do not copy a
   * deposited map's recommended contour into it: mean-downsampling lowers the
   * peaks and the RMS together, so the same number is a much higher sigma on
   * the prepared map and meshes a perforated shell instead of the object. The
   * deposited level and its sigma belong in `provenance.note` and the demo
   * index, where they are a record rather than an instruction.
   */
  coordinates: z.object({
    kind: z.literal('volume'),
    ref: z.string().trim().min(1).max(2_048),
    sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    contour: z.number().finite().positive(),
    downsample: z.number().int().min(1).max(16),
  }).strict().optional(),
}).strict().superRefine((manifest, context) => {
  // An `isosurface` chapter has nothing to draw unless the manifest says which
  // map and at what level. Catching it here rather than in the headset is the
  // point: the alternative is a wearer in immersion looking at an empty room.
  if (manifest.coordinates?.kind === 'volume') return;
  manifest.chapters.forEach((chapter, index) => {
    if (chapter.immersive?.appearance?.representation !== 'isosurface') return;
    context.addIssue({ code: 'custom', path: ['chapters', index, 'immersive', 'appearance', 'representation'],
      message: 'An isosurface chapter needs manifest coordinates of kind "volume".' });
  });
});

export type MolecularLessonManifest = z.infer<typeof manifestSchema>;
export type MolecularLessonChapter = MolecularLessonManifest['chapters'][number];
export type MolecularLessonChange = MolecularLessonChapter['changes'][number];
export type MolecularLessonSourceRef = MolecularLessonManifest['provenance']['sourceRefs'][number];
export type MolecularLessonImmersive = MolecularLessonChapter['immersive'];
export type MovieTimelineStep = MolecularLessonChange;

type ApplyScenePatch = {
  readonly annotations?: readonly unknown[];
  readonly replaceAnnotations?: boolean;
  readonly background?: string;
  readonly camera?: Record<string, unknown>;
  readonly lighting?: 'flat' | 'soft' | 'studio';
  readonly layers?: readonly Record<string, unknown>[];
  readonly replaceLayers?: boolean;
  readonly objectUpdates?: readonly { id: string; matrix?: number[]; visible?: boolean }[];
};

export interface GuidedApplyScenePlan {
  readonly chapterId: string;
  readonly changeIndex: number;
  readonly changeKind: MolecularLessonChange['kind'];
  readonly caption: string;
  readonly durationSeconds: number;
  /** Patch fields match the public structure.apply_scene contract. */
  readonly applyScene: ApplyScenePatch & {
    readonly annotations: readonly unknown[];
    readonly replaceAnnotations: false;
  };
}

export interface RenderMoviePlan {
  readonly timeline: readonly MovieTimelineStep[];
  readonly totalDurationSeconds: number;
}

export interface ScreenCaptionAnnotation {
  readonly anchor: 'bottom_left';
  readonly background: '#071015';
  readonly bold: true;
  readonly color: '#FFFFFF';
  readonly font: 'sans';
  readonly fontSize: 24;
  readonly id: string;
  readonly italic: false;
  readonly maxWidth: 960;
  readonly opacity: 1;
  readonly padding: 8;
  readonly position: { readonly x: 0.04; readonly y: 0.86 };
  readonly shadow: true;
  readonly text: string;
  readonly kind: 'screen';
  readonly visible: true;
}

type RenderCaptionAnnotation = Omit<ScreenCaptionAnnotation, 'visible'>;

export interface CompiledMolecularLesson {
  readonly manifest: MolecularLessonManifest;
  readonly timeline: readonly MovieTimelineStep[];
  readonly chapters: readonly {
    readonly id: string;
    readonly title: string;
    readonly caption: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
  }[];
  readonly guidedApplyScenePlans: readonly GuidedApplyScenePlan[];
  /** Present only when the complete lesson fits the installed render_movie limit. */
  readonly renderMoviePlan?: RenderMoviePlan;
  readonly totalDurationSeconds: number;
}

export function parseMolecularLesson(input: unknown): MolecularLessonManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`Invalid molecular lesson${path}: ${issue.message}`);
  }
  return result.data;
}

function isDeliberateChange(change: MolecularLessonChange): boolean {
  return change.kind !== 'hold';
}

function captionAnnotation(chapter: MolecularLessonChapter): ScreenCaptionAnnotation {
  return {
    anchor: 'bottom_left',
    background: '#071015',
    bold: true,
    color: '#FFFFFF',
    font: 'sans',
    fontSize: 24,
    id: 'lesson-caption',
    italic: false,
    maxWidth: 960,
    opacity: 1,
    padding: 8,
    position: { x: 0.04, y: 0.86 },
    shadow: true,
    text: chapter.caption,
    kind: 'screen',
    visible: true,
  };
}

function movieCaptionScene(chapter: MolecularLessonChapter): MolecularLessonChange {
  const { visible: _visible, ...renderCaption } = captionAnnotation(chapter);
  return {
    kind: 'scene',
    durationSeconds: 0.1,
    easing: 'linear',
    transition: 'cut',
    scene: { annotations: [renderCaption as RenderCaptionAnnotation] },
  };
}

/** Whether the lesson asked to be shown without tour chrome. */
export function captionCardHidden(manifest: MolecularLessonManifest): boolean {
  return manifest.presentation?.captionCard === 'hidden';
}

function embedMovieCaption(chapter: MolecularLessonChapter, hideCaptionCard: boolean): MolecularLessonChange[] {
  // A lesson that hides its caption card keeps its authored steps untouched —
  // no caption scene step, no 0.1 second carve out of the first change, and no
  // `lesson-caption` annotation anywhere in the movie timeline.
  if (hideCaptionCard) return chapter.changes;
  const first = chapter.changes[0];
  if (first?.kind === 'scene') {
    const existing = Array.isArray(first.scene.annotations) ? first.scene.annotations : [];
    const captionStep = movieCaptionScene(chapter);
    const caption = captionStep.kind === 'scene' ? captionStep.scene.annotations?.[0] : undefined;
    return [{ ...first, scene: { ...first.scene, annotations: caption == null ? existing : [...existing, caption] } }, ...chapter.changes.slice(1)] as MolecularLessonChange[];
  }
  if (first == null || first.durationSeconds <= 0.1) {
    throw new Error(`Movie caption for chapter "${chapter.id}" needs a first change longer than 0.1 seconds.`);
  }
  return [movieCaptionScene(chapter), { ...first, durationSeconds: Number((first.durationSeconds - 0.1).toFixed(6)) }, ...chapter.changes.slice(1)] as MolecularLessonChange[];
}

const guidedSceneKeys = new Set(['annotations', 'background', 'camera', 'layers', 'lighting']);

function validateGuidedAnnotations(value: unknown[] | undefined): void {
  if (value == null) return;
  for (const annotation of value) {
    if (annotation == null || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw new Error('Guided scene annotations must be standard structure.apply_scene annotation objects.');
    }
    const record = annotation as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.text !== 'string' || typeof record.visible !== 'boolean') {
      throw new Error('Guided scene annotations require apply_scene fields id, text, and visible.');
    }
    if (record.kind === 'selection' && !selectionExprSchema.safeParse(record.target).success) {
      throw new Error('Guided selection annotations require an exact public SelectionExpr v1 target.');
    }
  }
}

function guidedApplyScenePatch(change: MolecularLessonChange): ApplyScenePatch {
  if (change.kind === 'scene') {
    const unsupported = Object.keys(change.scene).filter((key) => !guidedSceneKeys.has(key));
    if (unsupported.length > 0) {
      throw new Error(`Guided lesson change "scene" contains unsupported apply_scene fields: ${unsupported.join(', ')}.`);
    }
    validateGuidedAnnotations(change.scene.annotations);
    return { ...change.scene, replaceLayers: change.scene.layers == null ? undefined : false } as unknown as ApplyScenePatch;
  }
  if (change.kind === 'focus') return { camera: { focus: change.target } };
  if (change.kind === 'zoom') return { camera: { zoom: change.magnification } };
  if (change.kind === 'camera') return { camera: change.camera };
  if (change.kind === 'visibility') return { objectUpdates: [{ id: change.objectId, visible: change.visible }] };
  if (change.kind === 'transform') {
    if (change.transform.kind !== 'matrix') {
      throw new Error('Guided lesson transform changes require an affine matrix; component transforms are movie-only.');
    }
    return { objectUpdates: [{ id: change.objectId, matrix: [...change.transform.values] }] };
  }
  if (change.kind === 'hold') return {};
  throw new Error(`Guided lesson change "${change.kind}" is cinematic-only and cannot be applied through structure.apply_scene.`);
}

/**
 * Validate and compile a portable lesson into the viewer's exact ordered
 * movie steps plus optional guided-mode apply_scene caption patches.
 */
export function compileMolecularLesson(input: unknown, options: { target?: 'lesson' | 'movie' } = {}): CompiledMolecularLesson {
  const manifest = parseMolecularLesson(input);
  const seenChapterIds = new Set<string>();
  const timeline: MolecularLessonChange[] = [];
  const chapters: CompiledMolecularLesson['chapters'][number][] = [];
  let elapsed = 0;

  for (const chapter of manifest.chapters) {
    if (seenChapterIds.has(chapter.id)) throw new Error(`Invalid molecular lesson: duplicate chapter id "${chapter.id}".`);
    seenChapterIds.add(chapter.id);

    const actualDuration = chapter.changes.reduce((sum, change) => sum + change.durationSeconds, 0);
    if (Math.abs(actualDuration - chapter.durationSeconds) > 1e-6) {
      throw new Error(`Invalid molecular lesson at chapters.${chapter.id}: durationSeconds must equal the sum of change durations.`);
    }
    // A headset chapter can change its authored subset or appearance while the
    // desktop timeline holds. Narration and a motion hold alone do not qualify.
    const immersiveSceneChange = chapter.immersive && (chapter.immersive.visibility != null
      || chapter.immersive.appearance != null || chapter.immersive.placement != null
      || chapter.immersive.view != null || chapter.immersive.emphasis != null || chapter.immersive.figure != null);
    if (!chapter.changes.some(isDeliberateChange) && !immersiveSceneChange) {
      throw new Error(`Invalid molecular lesson at chapters.${chapter.id}: include at least one deliberate scene change.`);
    }
    const startSeconds = elapsed;
    const movieChanges = embedMovieCaption(chapter, captionCardHidden(manifest));
    if (timeline.length + movieChanges.length > MOLECULAR_LESSON_LIMITS.maxTotalSteps) {
      throw new Error(`Invalid molecular lesson: timeline exceeds ${MOLECULAR_LESSON_LIMITS.maxTotalSteps} steps.`);
    }
    timeline.push(...movieChanges);
    elapsed += chapter.durationSeconds;
    chapters.push({ id: chapter.id, title: chapter.title, caption: chapter.caption, startSeconds, endSeconds: elapsed });
  }

  if (elapsed < MOLECULAR_LESSON_LIMITS.minTotalDurationSeconds || elapsed > MOLECULAR_LESSON_LIMITS.maxLessonDurationSeconds) {
    throw new Error(`Invalid molecular lesson: total duration must be between ${MOLECULAR_LESSON_LIMITS.minTotalDurationSeconds} and ${MOLECULAR_LESSON_LIMITS.maxLessonDurationSeconds} seconds.`);
  }
  if (options.target === 'movie' && elapsed > MOLECULAR_LESSON_LIMITS.maxMovieDurationSeconds) {
    throw new Error(`Invalid render_movie plan: total duration exceeds ${MOLECULAR_LESSON_LIMITS.maxMovieDurationSeconds} seconds.`);
  }

  const guidedApplyScenePlans = manifest.mode === 'guided'
    ? manifest.chapters.flatMap((chapter) => chapter.changes.map((change, changeIndex) => ({
      chapterId: chapter.id,
      changeIndex,
      changeKind: change.kind,
      caption: chapter.caption,
      durationSeconds: change.durationSeconds,
      applyScene: (() => {
        const patch = guidedApplyScenePatch(change);
        const existingAnnotations = Array.isArray(patch.annotations) ? patch.annotations : [];
        return {
          ...patch,
          annotations: captionCardHidden(manifest) ? existingAnnotations : [...existingAnnotations, captionAnnotation(chapter)],
          replaceAnnotations: false as const,
        };
      })(),
    })))
    : [];

  const renderMoviePlan = elapsed <= MOLECULAR_LESSON_LIMITS.maxMovieDurationSeconds
    ? { timeline, totalDurationSeconds: elapsed }
    : undefined;

  return { manifest, timeline, chapters, guidedApplyScenePlans, renderMoviePlan, totalDurationSeconds: elapsed };
}

/** A bounded three-chapter starter for a user's own opened molecule. */
export function createGenericMolecularLesson(options: { sourceRef: string; title?: string } | string, legacyTitle = 'Explore an opened molecule'): MolecularLessonManifest {
  const sourceRef = typeof options === 'string' ? options : options.sourceRef;
  const title = typeof options === 'string' ? legacyTitle : options.title ?? legacyTitle;
  const kind: MolecularLessonSourceRef['kind'] = /^https?:\/\//iu.test(sourceRef) ? 'public' : 'local';
  return parseMolecularLesson({
    version: MOLECULAR_LESSON_VERSION,
    id: 'generic-own-molecule',
    title,
    mode: 'guided',
    provenance: { sourceRefs: [{ kind, ref: sourceRef }], note: 'Generic lesson; biological interpretation belongs to the supplied source and user.' },
    chapters: [
      {
        id: 'orient',
        title: 'Orient',
        caption: 'Start with the complete molecule in view.',
        durationSeconds: 3,
        changes: [{ kind: 'scene', durationSeconds: 3, easing: 'ease_in_out', transition: 'smooth', scene: { camera: { orientation: 'front', zoom: 1.1 }, lighting: 'studio', layers: [{ id: 'lesson-layer', name: 'Complete molecule', representation: 'ball_and_stick', target: { kind: 'all' }, color: { kind: 'element' }, labels: false, opacity: 1, visible: true }] } }],
        immersive: { appearance: { representation: 'ball-and-stick', color: 'element-symbol', labels: false }, view: 'fit' },
      },
      {
        id: 'inspect',
        title: 'Inspect',
        caption: 'Use the whole-object view as a starting point for exploration.',
        durationSeconds: 4,
        changes: [{ kind: 'focus', target: { kind: 'all' }, durationSeconds: 2, easing: 'ease_in_out' }, { kind: 'scene', durationSeconds: 2, easing: 'ease_in_out', transition: 'smooth', scene: { layers: [{ id: 'lesson-layer', name: 'Complete molecule', representation: 'ball_and_stick', target: { kind: 'all' }, color: { kind: 'element' }, labels: false, opacity: 1, visible: true }] } }],
        immersive: { appearance: { representation: 'ball-and-stick', color: 'element-symbol', labels: false }, view: 'reset-orientation' },
      },
      {
        id: 'pause',
        title: 'Explore',
        caption: 'Pause here and continue with the viewer controls.',
        durationSeconds: 3,
        changes: [{ kind: 'scene', durationSeconds: 3, easing: 'ease_in_out', transition: 'smooth', scene: { layers: [{ id: 'lesson-layer', name: 'Complete molecule surface', representation: 'surface', target: { kind: 'all' }, color: { kind: 'element' }, labels: false, opacity: 1, visible: true }] } }],
        immersive: { appearance: { representation: 'molecular-surface', color: 'element-symbol', opacity: 1, labels: false }, view: 'fit' },
      },
    ],
  });
}
