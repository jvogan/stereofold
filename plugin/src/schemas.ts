import { z } from 'zod';
import { MAX_STRUCTURE_SOURCE_BYTES } from './inspection-limits.js';
import { SOURCE_DESCRIPTION, structureSourceSchema } from './structure-sources.js';
import { LOOK_COLOR_CHOICES, LOOK_STYLE_CHOICES } from './look.js';

export const stereoModeSchema = z.enum(['off', 'parallel', 'cross', 'anaglyph']);
export const motionModeSchema = z.enum(['none', 'rock', 'spin', 'parallax']);

/**
 * Colour theme and representation preset, named for the Mol* thing they
 * select. `plddt-confidence` is a request, not a promise: the viewer resolves
 * it to `uncertainty` (the B-factor theme) on a structure that carries no
 * pLDDT. See `./look.ts`.
 */
export const lookColorSchema = z.enum(LOOK_COLOR_CHOICES);
export const lookStyleSchema = z.enum(LOOK_STYLE_CHOICES);

/**
 * Anaglyph compositor variant.
 *
 * `balanced` is the default: each filter receives only Rec.709 luma, scaled so
 * both eyes emit the same luma on a zero-disparity field. `dubois` is the
 * least-squares colour projector, which keeps more hue and gives the two eyes
 * measurably unequal brightness.
 */
export const anaglyphVariantSchema = z.enum(['balanced', 'dubois']);

const pdbIdSchema = z.string().regex(/^[0-9A-Za-z]{4}$/, 'PDB ID must have four letters or digits.').transform((value) => value.toUpperCase());
const structureTextSchema = z.string().min(20).max(MAX_STRUCTURE_SOURCE_BYTES);

/**
 * A server-issued capability for one Stereofold state bucket.
 *
 * It is deliberately not derived from a transport, host, user, or
 * conversation identifier: MCP does not promise any of those to a tool
 * handler. Callers receive one from `stereo_structure.open` and must pass it
 * back on every later state, control, or app call. UUIDs make accidental
 * cross-session reads impractical while keeping the wire format portable
 * across model and app calls.
 */
export const sessionIdSchema = z.string().uuid('sessionId must be a server-issued UUID.');

/**
 * The built-in depth fixture, offered as a named source so an observer running
 * the human-evaluation protocol can load exactly the structure the pixel gate
 * measures without pasting coordinates. It is bundled with the plugin, so
 * selecting it makes no network request.
 */
export const fixtureSchema = z.enum(['three-depth-markers']);

/** Shared optional appearance settings for a source-opening request. */
const openLookShape = {
  color: lookColorSchema.optional(),
  style: lookStyleSchema.optional(),
};

/** The actual alternative forms accepted by the flat legacy `open` wire API. */
const openInputBranches = z.union([
  z.object({ sessionId: sessionIdSchema.optional(), source: structureSourceSchema, ...openLookShape }).strict(),
  z.object({ sessionId: sessionIdSchema.optional(), pdbId: pdbIdSchema, ...openLookShape }).strict(),
  z.object({ sessionId: sessionIdSchema.optional(), structureText: structureTextSchema, format: z.enum(['pdb', 'mmcif']).optional(), ...openLookShape }).strict(),
  z.object({ sessionId: sessionIdSchema.optional(), fixture: fixtureSchema, ...openLookShape }).strict(),
  // Re-open the cached session after a model-side data/control call. It is
  // deliberately source-free, so it cannot overwrite a cached structure.
  z.object({ sessionId: sessionIdSchema }).strict(),
]);

/**
 * The SDK version bundled with this plugin only serializes a top-level Zod
 * object for `tools/list`; it advertises a root union as `{}` even though it
 * validates that union at call time. Keep the established flat wire form as a
 * strict object, validate it against the real alternatives, and put those
 * alternatives in Zod's JSON-Schema metadata. `z.toJSONSchema()` preserves
 * arbitrary metadata keywords, so hosts see the same `anyOf` that runtime
 * validation enforces.
 */
export const openInputSchema = z.object({
  source: structureSourceSchema.describe(SOURCE_DESCRIPTION).optional(),
  sessionId: sessionIdSchema.optional(),
  pdbId: pdbIdSchema.optional(),
  structureText: structureTextSchema.optional(),
  fixture: fixtureSchema.optional(),
  format: z.enum(['pdb', 'mmcif']).optional(),
  ...openLookShape,
}).strict().superRefine((value, ctx) => {
  if (openInputBranches.safeParse(value).success) return;
  ctx.addIssue({
    code: 'custom',
    message: 'Provide exactly one source (source, pdbId, structureText, or fixture), or only a server-issued sessionId to render a cached session.',
  });
}).meta({
  anyOf: [
    { type: 'object', properties: { sessionId: {}, source: {}, color: {}, style: {} }, required: ['source'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, pdbId: {}, color: {}, style: {} }, required: ['pdbId'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, structureText: {}, format: {}, color: {}, style: {} }, required: ['structureText'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, fixture: {}, color: {}, style: {} }, required: ['fixture'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {} }, required: ['sessionId'], additionalProperties: false },
  ],
});

/** Parse the advertised flat schema then recover its exact runtime branch. */
export function parseOpenInput(value: unknown): z.output<typeof openInputBranches> {
  return openInputBranches.parse(openInputSchema.parse(value));
}

/** The actual alternative forms accepted by the legacy flat `control` API. */
const controlInputBranches = z.union([
  z.object({ sessionId: sessionIdSchema, action: z.literal('load_pdb'), pdbId: pdbIdSchema }).strict(),
  z.object({ sessionId: sessionIdSchema, action: z.literal('reset_camera') }).strict(),
  // The toolbar's Fit button, reachable by the model as well. It reframes
  // the structure in the eye window the panel is actually rendering into,
  // without resetting the pose the way reset_camera does.
  z.object({ sessionId: sessionIdSchema, action: z.literal('fit') }).strict(),
  // Retained for existing tool callers; new callers should use the richer
  // stereo_structure.set_motion schema below.
  z.object({ sessionId: sessionIdSchema, action: z.literal('set_motion'), motion: z.enum(['rock', 'spin', 'paused']) }).strict(),
  z.object({ sessionId: sessionIdSchema, action: z.literal('pause_motion') }).strict(),
  // Colour and style are independent, so either may be sent alone; sending
  // neither is rejected rather than silently doing nothing. These two
  // branches encode that requirement in JSON Schema too (rather than a
  // non-serializable `.refine()`): a colour branch may also carry style; the
  // style-only branch covers the other valid form.
  z.object({ sessionId: sessionIdSchema, action: z.literal('set_look'), color: lookColorSchema, style: lookStyleSchema.optional() }).strict(),
  z.object({ sessionId: sessionIdSchema, action: z.literal('set_look'), style: lookStyleSchema }).strict(),
]);

/**
 * Exact advertised form for the existing `control` name. See
 * `openInputSchema` for why the branches live in `.meta({ anyOf })` rather
 * than at the Zod root with this SDK version.
 */
export const controlInputSchema = z.object({
  sessionId: sessionIdSchema,
  action: z.enum(['load_pdb', 'reset_camera', 'fit', 'set_motion', 'pause_motion', 'set_look']),
  pdbId: pdbIdSchema.optional(),
  motion: z.enum(['rock', 'spin', 'paused']).optional(),
  color: lookColorSchema.optional(),
  style: lookStyleSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (controlInputBranches.safeParse(value).success) return;
  ctx.addIssue({
    code: 'custom',
    message: 'The selected control action requires its exact action-specific fields.',
  });
}).meta({
  anyOf: [
    { type: 'object', properties: { sessionId: {}, action: { const: 'load_pdb' }, pdbId: {} }, required: ['sessionId', 'action', 'pdbId'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, action: { const: 'reset_camera' } }, required: ['sessionId', 'action'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, action: { const: 'fit' } }, required: ['sessionId', 'action'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, action: { const: 'set_motion' }, motion: {} }, required: ['sessionId', 'action', 'motion'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, action: { const: 'pause_motion' } }, required: ['sessionId', 'action'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, action: { const: 'set_look' }, color: {}, style: {} }, required: ['sessionId', 'action', 'color'], additionalProperties: false },
    { type: 'object', properties: { sessionId: {}, action: { const: 'set_look' }, style: {} }, required: ['sessionId', 'action', 'style'], additionalProperties: false },
  ],
});

/** Parse the advertised flat schema then recover its exact runtime branch. */
export function parseControlInput(value: unknown): z.output<typeof controlInputBranches> {
  return controlInputBranches.parse(controlInputSchema.parse(value));
}

export const getStateInputSchema = z.object({ sessionId: sessionIdSchema }).strict();

/**
 * `stereo_structure.get_structure` takes the opaque session capability from
 * the render result. It exists so a freshly mounted panel can ask the server
 * what that session last opened. Its `['app']` visibility governs invocation,
 * not result confidentiality, so coordinates returned by this tool live only
 * in component-private result metadata rather than structured content.
 */
export const getStructureInputSchema = z.object({ sessionId: sessionIdSchema }).strict();

const renderTokenSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** App-only lease claim for a reset/fit advertised by a render result. */
export const claimActionInputSchema = z.object({
  sessionId: sessionIdSchema,
  actionId: z.string().uuid('actionId must be a server-issued UUID.'),
  renderToken: renderTokenSchema,
}).strict();

/** App-only acknowledgement after the leased action completed while still current. */
export const completeActionInputSchema = z.object({
  sessionId: sessionIdSchema,
  actionId: z.string().uuid('actionId must be a server-issued UUID.'),
  renderToken: renderTokenSchema,
}).strict();

/**
 * `stereo_structure.sync_view` is the panel telling the server what the person
 * is actually looking at, so the next panel can come up the same way.
 *
 * It is app-scoped and names no UI resource, so it is a pure state write that
 * can safely fire while a slider is being dragged. Every field is optional
 * and the server merges what it receives; the viewer sends the whole view
 * state on every send, debounced.
 */
export const syncViewInputSchema = z.object({
  sessionId: sessionIdSchema,
  /** Last server stateRevision this panel accepted; prevents stale full-state writes. */
  baseStateRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  mode: stereoModeSchema.optional(),
  depthBudgetArcmin: z.number().finite().min(0).max(60).optional(),
  swapEyes: z.boolean().optional(),
  variant: anaglyphVariantSchema.optional(),
  color: lookColorSchema.optional(),
  style: lookStyleSchema.optional(),
  motion: z.object({
    mode: motionModeSchema,
    amplitudeDeg: z.number().finite().min(0).max(30).optional(),
    periodS: z.number().finite().min(0.1).max(600).optional(),
    axis: z.enum(['y', 'x']).optional(),
  }).strict().optional(),
}).strict();

/* ------------------------------------------------------- fit diagnostics */

/**
 * Diagnostics are returned by the model-visible state tool after an app-only
 * report. Keep every string in that object deliberately non-payload-like:
 * timestamps have their real wire format, known state values are enums, and
 * identifiers are short single-line tokens. This blocks accidental raw
 * coordinate text from being copied through a diagnostic field. It is not a
 * confidentiality boundary against deliberately encoded data from a
 * compromised panel; model-readable diagnostics are an intentional channel.
 */
const isoDateTimeSchema = z.string().datetime({ offset: true });
const diagnosticTokenSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Diagnostics identifiers must be short single-line tokens.');
const diagnosticPdbIdSchema = z.string().regex(/^[0-9A-Za-z]{4}$/, 'Diagnostic PDB ID must have four letters or digits.');

// Keep the exact enum validation and JSON Schema metadata while leaving the
// public diagnostics TypeScript interface source-compatible with older panel
// builds, which declares these fields as `string`.
const diagnosticStereoModeSchema: z.ZodType<string> = stereoModeSchema;
const diagnosticVariantSchema: z.ZodType<string> = anaglyphVariantSchema;
const diagnosticColorSchema: z.ZodType<string> = lookColorSchema;
const diagnosticStyleSchema: z.ZodType<string> = lookStyleSchema;
const diagnosticMotionModeSchema: z.ZodType<string> = motionModeSchema;
const diagnosticVisibilitySchema: z.ZodType<string> = z.enum(['visible', 'hidden']);

/**
 * `stereo_structure.report_diagnostics` is the only channel out of a live
 * webview.
 *
 * Nobody can attach a debugger to Codex's panel, and two fixes have now been
 * shipped against screenshots that turned out to be consistent with several
 * different wrong numbers. This schema is the wire form of
 * `./fit-diagnostics.ts`: the viewer assembles the object from its live
 * objects, sends it here, and `stereo_structure.get_state` returns it verbatim
 * so a conversation can read the numbers out of a real host.
 *
 * Every object is `strict()`, so a viewer that sends a field this server does
 * not know about is rejected rather than silently truncated. The whole object
 * is optional on `get_state`, so a build with no viewer attached, or an older
 * viewer that never reports, still returns a valid state.
 *
 * The numbers are plain `z.number()` rather than `.finite()` on purpose: JSON
 * cannot carry a non-finite number at all, so one would arrive as `null` and
 * be rejected here anyway. The viewer clamps at the reader instead
 * (`finiteOr`), which loses one field rather than the whole report.
 */
const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
}).strict();

const sizeSchema = z.object({
  width: z.number(),
  height: z.number(),
}).strict();

const fitGeometrySchema = z.object({
  eyeWidthPx: z.number(),
  eyeHeightPx: z.number(),
  radius: z.number(),
}).strict();

const fitTriggerSchema = z.enum(['load', 'mode', 'refit', 'hostcontext', 'displaymode', 'button', 'fallback', 'reset']);

const diagnosticsHostSchema = z.object({
  displayMode: diagnosticTokenSchema,
  containerDimensions: z.object({
    width: z.number().optional(),
    height: z.number().optional(),
    maxWidth: z.number().optional(),
    maxHeight: z.number().optional(),
  }).strict().optional(),
  hostViewportWidthPx: z.number().optional(),
  hostViewportHeightPx: z.number().optional(),
  hostContextAt: isoDateTimeSchema.optional(),
  hostContextCount: z.number(),
  innerWidthPx: z.number(),
  innerHeightPx: z.number(),
  devicePixelRatio: z.number(),
  visualViewportScale: z.number().optional(),
  visibilityState: diagnosticVisibilitySchema,
}).strict();

const diagnosticsGeometrySchema = z.object({
  stageRectCssPx: rectSchema,
  letterboxRectCssPx: rectSchema,
  eyeViewportCssPx: sizeSchema,
  eyeCapApplied: z.boolean(),
  halfCapPx: z.number().nullable(),
  canvasCssPx: sizeSchema,
  canvasBackingPx: sizeSchema,
  cameraViewport: rectSchema,
  stereoEyeViewports: z.object({
    left: rectSchema,
    right: rectSchema,
    parent: rectSchema,
    ageMs: z.number(),
  }).strict().optional(),
}).strict();

const diagnosticsCameraSchema = z.object({
  distanceToTargetAng: z.number(),
  radiusAng: z.number(),
  fovRad: z.number(),
  visibleSphereRadiusAng: z.number(),
  boundingSphereVisibleRadiusAng: z.number(),
  inTransition: z.boolean(),
  projectedSphereDiameterPx: z.number().optional(),
  fill: z.number().optional(),
  // Nullable because "the stereo draw pass has not run recently" is a reading,
  // and optional because an older viewer build never computed one.
  fillFromDrawPass: z.number().nullable().optional(),
}).strict();

const diagnosticsFitSchema = z.object({
  fittedGeometry: fitGeometrySchema.optional(),
  fitSuspended: z.boolean(),
  fixturePinned: z.boolean(),
  loadInFlight: z.boolean(),
  lastDecision: z.object({
    at: isoDateTimeSchema,
    decision: z.enum(['refit', 'keep', 'wait']),
    current: fitGeometrySchema,
    fitted: fitGeometrySchema.optional(),
    suspended: z.boolean(),
    pinned: z.boolean(),
    inTransition: z.boolean(),
  }).strict().optional(),
  events: z.array(z.object({
    at: isoDateTimeSchema,
    trigger: fitTriggerSchema,
    eyeWidthPx: z.number(),
    eyeHeightPx: z.number(),
    radius: z.number(),
    distance: z.number(),
    fill: z.number().optional(),
  }).strict()).max(64),
}).strict();

const diagnosticsStateSchema = z.object({
  mode: diagnosticStereoModeSchema,
  depthBudgetArcmin: z.number(),
  swapEyes: z.boolean(),
  variant: diagnosticVariantSchema,
  color: diagnosticColorSchema,
  style: diagnosticStyleSchema,
  motionMode: diagnosticMotionModeSchema,
  motionRunning: z.boolean(),
  motionBaselineDistanceAng: z.number().optional(),
  structureLoaded: z.boolean(),
  pdbId: diagnosticPdbIdSchema.optional(),
  messageCounts: z.object({
    open: z.number(),
    state: z.number(),
    mode: z.number(),
  }).strict(),
  structureSource: z.enum(['none', 'open', 'fallback', 'local']),
  // The fresh-panel get_structure retry. Optional: an older viewer build
  // had no retry to report. See plugin/src/fallback-retry.ts.
  fallback: z.object({
    tries: z.number(),
    lastError: z.enum(['threw', 'no-result', 'incomplete', 'malformed']).optional(),
    done: z.boolean(),
    at: isoDateTimeSchema.optional(),
  }).strict().optional(),
}).strict();

const diagnosticsUserSchema = z.object({
  wheelEventsSinceFit: z.number(),
  wheelEventsTotal: z.number(),
}).strict();

export const diagnosticsSchema = z.object({
  at: isoDateTimeSchema,
  viewerBuild: diagnosticTokenSchema,
  // Random per mounted viewer; the key the server keeps reports under.
  // Optional so a report from an older viewer build still validates.
  panelId: diagnosticTokenSchema.optional(),
  sequence: z.number(),
  trigger: z.enum(['load', 'mode', 'refit', 'hostcontext', 'displaymode', 'button', 'fallback', 'reset', 'mount', 'loadstart', 'loadend', 'decision', 'heartbeat']),
  host: diagnosticsHostSchema,
  geometry: diagnosticsGeometrySchema,
  camera: diagnosticsCameraSchema,
  fit: diagnosticsFitSchema,
  state: diagnosticsStateSchema,
  user: diagnosticsUserSchema,
}).strict();

export const reportDiagnosticsInputSchema = z.object({
  sessionId: sessionIdSchema,
  diagnostics: diagnosticsSchema,
}).strict();

export type DiagnosticsPayload = z.output<typeof diagnosticsSchema>;

export const setModeInputSchema = z.object({
  sessionId: sessionIdSchema,
  mode: stereoModeSchema,
  depthBudgetArcmin: z.number().finite().min(0).max(60).optional(),
  swapEyes: z.boolean().optional(),
  variant: anaglyphVariantSchema.optional(),
}).strict();

/**
 * Motion is intentionally expressed in display-facing units: degrees and
 * seconds, never Mol* world units. Omitted tuning values use @stereo/motion's
 * rock/spin defaults in the viewer. Prefer this tool over the legacy control
 * action, which cannot represent parallax or tuning.
 */
export const setMotionInputSchema = z.object({
  sessionId: sessionIdSchema,
  mode: motionModeSchema,
  amplitudeDeg: z.number().finite().min(0).max(30).optional(),
  periodS: z.number().finite().min(0.1).max(600).optional(),
  axis: z.enum(['y', 'x']).optional(),
}).strict();

export type AnaglyphVariant = z.output<typeof anaglyphVariantSchema>;
export type OpenInput = z.output<typeof openInputBranches>;
export type ControlInput = z.output<typeof controlInputBranches>;
export type SetModeInput = z.output<typeof setModeInputSchema>;
export type SetMotionInput = z.output<typeof setMotionInputSchema>;
export type SyncViewInput = z.output<typeof syncViewInputSchema>;
export type ReportDiagnosticsInput = z.output<typeof reportDiagnosticsInputSchema>;
