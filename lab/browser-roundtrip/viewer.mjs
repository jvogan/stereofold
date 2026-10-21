import { capFigureAnnotations } from './figure-label-placement.mjs';
import { createMeasurementLines } from './measurement-lines.mjs';
import { annotationFieldBounds, sizeImmersiveAnnotation } from './immersive-annotations.mjs';
import { createMolecularAnimation, transformSphere } from './molecular-animation.mjs';
import { geometryBudgetChanged } from './geometry-advisory.mjs';
import { createSelectionBoundsCache } from './selection-bounds.mjs';
import { xrBallAndStickParams, colorOnlyAppearanceChange } from './inspection-appearance.mjs';
import { connectionFrame, connectionStatus, requestConnectionRecovery, subscribeConnectionStatus, TALK_LINK_LOST } from './connection-liveness.mjs';
import { focusResidues } from './focus-residues.mjs';
import { normalizeStyles } from './inspection-styles.mjs';
import { companionTransform, foldCompanion } from './companion-structure.mjs';
import { updatePlacementBounds } from './placement-bounds.mjs';
import { createDrawnSubsetCache, createVisibleStageBoundsCache } from './visible-stage-bounds.mjs';
import { PLACEMENT_MAX_TRANSLATION, XR_ROOM_MAX_METRES, clampPlacementScale, clampPlacementTranslation } from './placement-limits.mjs';
import { requireSceneGeometryBudget, requireGeometryBudget, structureGeometryCounts, geometryBudgetReceipt, geometryBudgetConfirmation } from './representation-budget.mjs';
import { compoundOps } from './compound-change.mjs';
import { prepareRepresentationUploads, runTransitionTask, representationLayerRef } from './scene-transition.mjs';
import { beginSceneTransition } from './xr-render-budget.mjs';
import { captureXrNamedViewIntent, captureDesktopNamedViewIntent, desktopCameraForNamedView, validateNamedViewIntent } from './named-view-intent.mjs';
import { createSequenceNavigation } from './sequence-navigation.mjs';
import { composeOverpaintLayers, selectionOverpaintLayer, selectionPaintPlan, selectionSignature } from './selection-paint.mjs';
import { residueRunPlate, residueLabelText } from './residue-label-plates.mjs';
import { capPlateInEyes, plateObstaclesInEyes, releasePlateInEyes } from './plate-eye-cap.mjs';
import { cameraSnapshot } from './camera-snapshot.mjs';
import { createLabelMeasurementGate, drawnPlateDepthSpheres, labelObjectRenderable, measureComponentLabels, renderedMeshVertexCount, renderedSubjectPoints, renderedSubjectSpheres } from './component-label-measurement.mjs';
import { measureEntryStandoff } from './entry-standoff.mjs';
import { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context.js';
import { PluginConfig } from 'molstar/lib/mol-plugin/config.js';
import { PLUGIN_VERSION } from 'molstar/lib/mol-plugin/version.js';
import { ModelSymmetry } from 'molstar/lib/mol-model-formats/structure/property/symmetry.js';
import { createStructureRepresentationParams, createStructureColorThemeParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js'; // The spoken hide.
import { Task } from 'molstar/lib/mol-task/task.js';
import { Mat4, Vec2, Vec3, Vec4 } from 'molstar/lib/mol-math/linear-algebra.js';
// `canvas.identify` takes either a screen point or a ray, and a
// pinch only ever has a ray (`canvas3d.js:642`).
import { Ray3D } from 'molstar/lib/mol-math/geometry/primitives/ray3d.js';
import { Euler } from 'molstar/lib/mol-math/linear-algebra/3d/euler.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { StructureSelection } from 'molstar/lib/mol-model/structure/query.js';
import { EveryLoci } from 'molstar/lib/mol-model/loci.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { MarkerAction } from 'molstar/lib/mol-util/marker-action.js';
import { Binding } from 'molstar/lib/mol-util/binding.js'; // Thumbstick strafe.
import { createSelectionAdapter, createSelectionAdapterAsync, snapshotSelectionCatalog } from './selection.mjs';
import { createInspectionState, normalizeAppearance, normalizePlacement, sameAppearance } from './inspection-state.mjs';
import { createImmersiveSession } from './immersive-session.mjs';
import { installSpatialMenuHook } from './spatial-menu-hook.mjs';
import { installSpatialAimHook } from './spatial-aim-hook.mjs';
import { relativeHeadContext } from './inspection-spatial-context.mjs';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { MolScriptBuilder } from 'molstar/lib/mol-script/language/builder.js';
import { experienceVisibilityExpression, normalizeExperienceVisibility } from './experience-visibility.mjs';
// One definition of what "hidden" means, shared with the host
// that admits the saved scene, so the two ends cannot describe the same picture
// two different ways and fail each other's receipt comparison.
import { availableChains, describeVisibility, emptyVisibility, hiddenRowKeys, normalizeVisibility,
  resolveVisibility, sameVisibility, visibilityIsEmpty } from './inspection-visibility.mjs';
import { roomPlacement } from './room-placement.mjs';
import { motionFocusPlacement } from './motion-framing.mjs';
import { chapterFieldDistance, createMenuObstructionScorer, fitChapterField, framingEnvelopeObject, menuGlassInView, visibleChapterSpheres } from './chapter-field.mjs';
import { glassPlatesOverlapInViews } from './glass-overlap.mjs';
import { focusPlacement, focusTravel, obliqueGrowthTurn, turnSweptPoints, GROWTH_WALL_AZIMUTH_DEGREES } from './focus-placement.mjs';
// The density tier's whole-map lens ceiling, stricter than the
// atomic whole-structure one. Read `plate-standoff.mjs` for the numbers.
import { occludedPlateShare, pointRange, SUBJECT_LENS_CEILING, VOLUME_WHOLE_LENS_CEILING } from './plate-standoff.mjs';
import { measurePlateSeat } from './plate-seat.mjs';
import { createRoomAnchor, headViewBasis, placementFromRoom, roomAnchorEnabled } from './room-anchor.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';
import { resetEntryGeometry, resetEntryLateralBreakdown } from './reset-entry-geometry.mjs';
import { fitAppearanceInWorker } from './appearance-fit.mjs';
import { journeySeatDetail } from './journey-seat-record.mjs';
import { createRoomSeatMemory, initialRoomCameraScale } from './room-seat-memory.mjs';
import { placementNoteFor } from './placement-report.mjs';
import { representationTriangles, sessionDeviceClass, structureAtomSites, xrRepresentationQuality, xrRepresentationMaterial } from './xr-render-budget.mjs';
// The surface a Quest 2 cannot finish drawing, stated once.
// The same rule now covers all-atom spheres, and
// `ligandOverlayForBudget` says what a demoted all-atom chapter keeps.
import { representationForBudget, ligandOverlayForBudget } from './xr-render-budget.mjs';
// Which cell is the molecule's own representation, and which
// refs are still alive to paint on. Read that module's header for the wall
// chapter 5 failure both rules come from.
import { findLiveStructureRepresentation, liveEmphasisTargets } from './representation-refs.mjs';
// The density tier. `volume-source.mjs` holds the fixture shape,
// the digest check over the map bytes and the isosurface parameters; read its
// header for why a density map cannot travel the mmCIF path.
import { checkedVolumeFixture, isVolumeFixture, volumeIsosurfaceParams, volumeSceneIdentity,
  VOLUME_REPRESENTATION, VOLUME_UNIFORM_COLOR } from './volume-source.mjs';
// The radial two-colour key that replaced the uniform grey, and
// the measured tube axis it is painted around. Read that module's header for
// the cutoff, the budget, and why the chain-coloured alternative lost.
import { VOLUME_RADIAL_COLOR_THEME, measureIsoExtent, registerVolumeRadialColorTheme,
  volumeColorFallbackReason, volumeColorSelection, volumeIsoExtentOf,
  volumeThemePaint } from './volume-color.mjs';
// The frame waiter's two questions about a record, for a scene
// that may be atoms or may be a density map. Read its header for the swap that
// fails on a density scene.
import { checkDrawnRecord, drawnRecordIsVisible } from './drawn-record.mjs';
import { createVolumeRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/volume-representation-params.js';
import { Grid } from 'molstar/lib/mol-model/volume.js';
import { getFontAtlas } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
// The pastel chain palette, the immersive light rig, and
// the occlusion/outline pass list a mid-session quality change has to apply.
import { xrColorParams, xrPostprocessingProps, xrRendererLighting, renderBudgetOverrides } from './xr-render-budget.mjs';
import { planLessonEmphasis, normalizeEmphasisState, resolveEmphasisPartId, emphasisFocusForKeys, NO_EMPHASIS,
  DEFAULT_CONTEXT_OPACITY, LESSON_MIN_TARGET_FRACTION, LESSON_ELEVATION_DEGREES, LESSON_MAX_ENCLOSURE,
  contextOpacityForBlendMode, WHOLE_STRUCTURE_ROW_SHARE, mergeEmphasisColourLayers,
  createLessonKeyMemory } from './lesson-emphasis.mjs';
// How big a label has to be drawn to stay legible at the seat,
// and why nothing in the frame is allowed to mirror it. Read `label-facing.mjs`.
import { componentLabelOffsetZ, labelSizeFactor, labelCharacterDegrees, labelDistanceMeters,
  labelCharacterUnits, componentLabelHardwareGain, componentLabelMinimumSizeScale,
  LABEL_CHARACTER_DEGREES, COMPONENT_LABEL_BASE_OFFSET_Z, MOLSTAR_TEXT_EM_PER_SIZE,
  DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z } from './label-facing.mjs';
// Where each plate is allowed to sit so ten of them can be read
// at once, and which one of them never moves. Read `label-layout.mjs`.
import { plateLayoutKey, reusablePlateLayout, layoutComponentPlates, menuGlassObstacles, projectedSphereRect, screenRectFromPoints, wrapPlateText,
  PLATE_FIELD } from './label-layout.mjs';
// One serialized owner of the name plates, so a session edge
// landing inside a rebuild cannot leave two runs deleting each other's cells.
import { COMPONENT_LABEL_FONT_QUALITY, componentLabelPaint, componentPlateName, createComponentLabelSession,
  planComponentLabels, stageComponentLabelLayers, componentLabelProjectionGain, componentLabelStillUnits } from './component-labels.mjs';
// The loaded lesson's visual baseline and who owns the painted
// key, in one place rather than three callers deciding separately.
import { createLessonResting, platesWanted } from './lesson-resting.mjs';
import { createDesktopAnnotationSizing } from './desktop-annotations.mjs';
import { createLessonFigure, figureTargetMatchesRow } from './lesson-figure.mjs';
import { selectAnimationTrack } from './animation-selection.mjs';
import { evaluateTrackVisibility } from '../../packages/motion/src/keyframes.mjs';
import { withFigureRepresentation } from './lesson-figure-appearance.mjs';
// The three-level render-quality lever the menu, the voice
// grammar and the agent all reach through `viewer.inspection`.
import { activeRenderQuality, framebufferScaleFor, isStandaloneHmdAgent, lastLayerScale, raiseQuality,
  renderQualityPreset, setActiveRenderQuality, storeRenderQuality } from './xr-render-budget.mjs';
// The growth sentence on the caption plate, and its four
// seconds of XR frames. Pure and Mol*-free; the scheduler below is the only
// part that knows what a frame is.
import { createGrowthOverlay, GROWTH_CAPTION_EVENT, GROWTH_CAPTION_MS,
  growthOverlayFromNotice } from './growth-caption.mjs';
import { createXrControllerInput } from './xr-controller-input.mjs';
import { createXrInputReleaseGate, createXrPlacementLifecycle } from './xr-input-release.mjs';
import { canRestoreLessonPlaybackMetadata } from './lesson-playback-restore.mjs';
import { wearerAxesFrom } from './wearer-axes.mjs'; // Head-relative stick travel.
import { xrSnapshotFrame, releaseHeadsetView } from './xr-snapshot.mjs';
import { preserveSourceTransitionAnchor } from './source-transition-anchor.mjs';
import { applyMatrix4 } from './room-lock.mjs';
// A turn belongs on the centre of what is drawn, not the whole
// assembly's. Read that module's header before touching the bake below.
import { pivotPreservingTranslation } from './presentation-pivot.mjs';
// Trigger picking, grip grab/scale, and the one caption line.
import { createXrManipulation, isPickButton, moleculeGrabDistance, oneHandScaleFactor, pulseController, recordManipulation, residueCaption,
  showHeadsetCaption, workbenchFailureCaption, GRAB_PULSE, GRAB_REJECTED, PICK_PULSE, POINTER_GRIP,
  POINTER_TRIGGER, WORKBENCH_OPENED_CAPTION, XR_TRIGGER_BUTTON } from './xr-manipulate.mjs';
// Who owns where the structure is standing. Read that module's
// header before changing a framing or a restore.
import { createPlacementHold } from './wearer-placement.mjs';
import { createAgentPlacementHistory } from './agent-placement-history.mjs';
// The lesson's own chapter turn — pure camera arithmetic and
// one admission gate. The viewer owns the privileged half around it.
import { createLessonMotionHold, lessonCameraMove, lessonMotionApplies, normalizeLessonMotion } from './lesson-motion.mjs';
// The stock XR thumbstick, retuned so it is not the only way to move.
// And the trigger/grip modifier layer both sticks now read.
import { createStickModifiers, firePassthroughToggle, xrLocomotionAttribs, xrManagerAttribs,
  STICK_MODE } from './xr-locomotion.mjs';
import { createXrGrabFeedback } from './xr-grab-feedback.mjs';
import { createTriggerStickIntent } from './trigger-stick-intent.mjs';
import { createGesturePivot } from './gesture-pivot.mjs';
// Face buttons, both structure-moving thumbsticks, the reply memory.
import { createXrButtons, createXrThumbstick, rememberSpokenReply,
  STICK_DEGREES_PER_SECOND, STICK_METRES_PER_SECOND } from './xr-buttons.mjs';
// Apple's look-and-pinch, bridged to the pick and the grab the
// Quest trigger and grip already drive. Read that module's header for the
// ownership rule and the tap-or-drag reading.
import { attachNaturalInput, naturalRayFor, naturalGripFor, transformNaturalPointer } from './natural-input.mjs';
// Talking is not manipulation, and the headset turns faster.
import { pointerManipulates, presentationDegreesPerSecond } from './presentation-motion.mjs';
// The head-seated caption, the one status a wearer always sees.
import { createTalkCaption, setTalkOutcomeSink, setTalkProgressSink, showTalkOutcome } from './talk-caption.mjs';
// The live push-to-talk binding, driven by holding A or X.
import { pushToTalkBinding } from './push-to-talk-grip.mjs';
// The far plane and fog an immersive session is drawn with.
import { immersiveDepthPatch, XR_FAR_METERS } from './xr-depth-band.mjs';
// Which of the two blend modes the wearer is asking for, and the
// words for the one press that finishes a switch the browser would not grant.
import { entryFallbackCopy, passthroughPlan, restorePassthroughOnEntry, readPassthroughPreference, storePassthroughPreference } from './xr-session-request.mjs';
// The page's narration slot, the only channel that still reaches a
// wearer who has been put back on the 2D page by a blend-mode switch.
import { voiceCommandSpeaker } from './voice-command-speaker.mjs';
import { createStructureSubjectReader } from './structure-subject.mjs';
import { RENDER_QUALITY_LEVELS, MOLECULAR_REPRESENTATIONS, nextMolecularRepresentation } from './spatial-toolbar-content.mjs';
// The announced, bounded pause between the press and Quest Browser.
import { noteQuestExitBanner } from './quest-exit-banner.mjs';
import { announceWorkbenchTransfer, beginWorkbenchHandoff,
  WORKBENCH_TRANSFER_CAPTION } from './workbench-handoff.mjs';

const REPRESENTATIONS = new Set(['cartoon', 'ball-and-stick']);
const INSPECTION_REPRESENTATIONS = new Set(['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill']);
// The appearance vocabulary INCLUDING the density tier's own.
// `INSPECTION_REPRESENTATIONS` stays atomic because two other readers scan the
// STRUCTURE hierarchy with it (`findCurrentStructureRepresentation` and the
// workbench sync), and an isosurface is not in that hierarchy at all.
const APPEARANCE_REPRESENTATIONS = new Set([...INSPECTION_REPRESENTATIONS, VOLUME_REPRESENTATION]);
const INSPECTION_COLORS = new Set(['chain-id', 'element-symbol', 'residue-name', 'sequence-id', 'uniform']);
const FRAME_TIMEOUT_MS = 30_000;
/**
 * The same wait, bounded for a wearer instead of a watcher.
 *
 * Every `waitForFrame` starts after a synchronous `canvas.commit(true)`, so
 * what it waits for is one render, not a build. A presenting Quest 2 runs that
 * render loop on the XR session's own frame clock at 72 fps, which makes
 * fifteen seconds about a thousand frames — far past any honest draw and far
 * short of the thirty a desktop panel can afford. One source swap makes four of
 * these calls and its rollback makes two more, so the desktop bound stacks to
 * three minutes of silence before anything is reported; this is what keeps a
 * stuck frame from being indistinguishable from a dead headset.
 */
const XR_FRAME_TIMEOUT_MS = 15_000;
/**
 * The caption while the session ends and Quest Browser loads Mol*.
 * It now names the transfer rather than the opening, and it is
 * spoken as well as drawn; `workbench-handoff.mjs` owns both halves.
 */
const HEADSET_WORKBENCH_CAPTION = WORKBENCH_TRANSFER_CAPTION;
/** One named state cell per hidden group, so "show it" can delete it. */
const VISIBILITY_LAYER_REF = Object.freeze({ water: 'stereofold-hidden-water', ligand: 'stereofold-hidden-ligand' });
/**
 * The saved hidden set's own layer, separate from the two
 * spoken ones above.
 *
 * `VISIBILITY_LAYER_REF` is the wearer's "hide the water" — page state, two
 * hard-coded nouns, and gone on reload. This ref carries `inspection.visibility`
 * from the saved scene, which survives a reload, travels to a second panel and
 * comes back with a named view. They are deliberately different cells: the two
 * can be on at once and neither may delete the other's layer.
 */
const SCENE_VISIBILITY_LAYER_REF = 'stereofold-scene-visibility';
/** The faded-context layer a lesson chapter emphasises through. */
const EMPHASIS_LAYER_REF = 'stereofold-lesson-emphasis';
/**
 * How much larger a residue label draws inside the headset.
 *
 * Mol* sizes label text in world units, so one factor serves every framing: a
 * label on a residue of a complex framed at sixty degrees stays the same share
 * of the wearer's view whatever the structure's scale. Eight against the
 * desktop's 1.5 takes the PAM's label from a measured two per cent of lens
 * width to roughly a sixth of it — a billboard the wearer
 * reads without leaning in, which is what "name the PAM" needs.
 */
const DESKTOP_LABEL_SIZE_FACTOR = 1.5;
// The hardware calibration of the angular model used
// to be a constant here, `XR_LABEL_HARDWARE_GAIN = 1.3`. It was the compromise
// between run 13 (gain 2.7: ideal in the `site` chapter at placement scale 2.4,
// ten plates piled up in the wide one) and run 14 (gain 1.3: read wide, small
// and buried up close), and it satisfied neither. Those two readings were never
// in conflict — they are two points on a curve, and `componentLabelHardwareGain`
// in `label-facing.mjs` is that curve. The stacking that made 2.7 unusable wide
// is a layout problem now, not a size one, which is what lets the wide view
// take a bigger gain at all.
/**
 * The state-tree ref prefix for the per-part name plates a
 * chapter asks for with `componentLabels`. Root-level cells, siblings of the
 * structure — never candidates for the molecule's own representation.
 */
const COMPONENT_LABEL_REF = 'stereofold-component-labels';
/**
 * At most one name plate per colour-key part. The lesson
 * schema caps the key at sixteen parts, so this is that bound restated where
 * the plates are drawn rather than a second rule to drift.
 */
const COMPONENT_LABEL_LIMIT = 16;
/** The exact atlas settings used by StructureSelectionsLabel3D's defaults. */
const COMPONENT_LABEL_TEXT_PROPS = Object.freeze({
  fontFamily: 'sans-serif', fontQuality: 3, fontStyle: 'normal',
  fontVariant: 'normal', fontWeight: 'normal',
});
function componentLabelTextWidth(text) {
  const atlas = getFontAtlas(COMPONENT_LABEL_TEXT_PROPS);
  const outline = atlas.buffer / atlas.lineHeight;
  return Array.from(String(text ?? '')).reduce((width, character) => width + atlas.get(character).nw - 2 * outline, 0)
    / MOLSTAR_TEXT_EM_PER_SIZE;
}
const LOAD_CHECKPOINTS = new Set(['after_parse', 'after_representation', 'after_candidate_draw', 'after_room_anchor']);
const detached = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

function representationName(value) {
  if (!REPRESENTATIONS.has(value)) throw failure('unsupported_representation', 'Choose cartoon or ball-and-stick.');
  return value;
}

function inspectionRepresentationName(value) {
  if (!APPEARANCE_REPRESENTATIONS.has(value)) throw failure('unsupported_representation', 'Choose a supported inspection representation.');
  return value;
}

function colorNumber(value) { return Number.parseInt(value.slice(1), 16); }

// This complete camera snapshot is a lab extension, separate from the existing
// transfer protocol's view schema. It contains no headset tracking state.

async function checkedFixture(fixture, options) {
  // A density source is bytes, not text, and it is checked
  // against its own digest before anything parses it. `detached` below is a
  // structured clone, which would copy an 8.4 MB map for no reason, so the
  // volume branch comes first and keeps the bytes it was handed.
  if (isVolumeFixture(fixture)) {
    const checked = await checkedVolumeFixture(fixture, options, failure);
    checked.settings.visible = normalizeExperienceVisibility(checked.settings.visible ?? fixture.visible);
    if (checked.settings.camera !== undefined) checked.settings.camera = cameraSnapshot(checked.settings.camera);
    return checked;
  }
  // Capture the large catalog once, before the digest yields to caller edits.
  // Selection binds against this private, immutable snapshot below.
  const source = detached({ ...fixture, catalog: undefined });
  source.catalog = fixture?.catalog;
  const settings = detached(options);
  if (!source || typeof source.id !== 'string' || typeof source.cif !== 'string'
      || !/^[a-f0-9]{64}$/.test(source.sha256) || !source.catalog
      || source.catalog.source?.sha256 !== source.sha256) {
    throw failure('invalid_fixture', 'The fixture needs CIF bytes, a SHA-256 hash and its matching catalog.');
  }
  source.catalog = snapshotSelectionCatalog(source.catalog);
  const bytes = new TextEncoder().encode(source.cif);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== source.sha256 || bytes.byteLength !== source.catalog.source.byteLength) {
    throw failure('source_mismatch', 'The loaded CIF bytes do not match the catalog source.');
  }
  if (!Number.isSafeInteger(settings.modelNumber) || settings.modelNumber < 1
      || !source.catalog.modelNumbers.includes(settings.modelNumber)
      || typeof settings.assemblyId !== 'string' || !settings.assemblyId
      || source.catalog.assemblyId !== settings.assemblyId) {
    throw failure('unsupported_structure', 'The requested model and assembly must be present in the supplied catalog.');
  }
  representationName(settings.representation);
  settings.visible = normalizeExperienceVisibility(settings.visible ?? source.visible);
  if (settings.camera !== undefined) settings.camera = cameraSnapshot(settings.camera);
  if (settings.preserveRoomPlacement !== undefined && typeof settings.preserveRoomPlacement !== 'boolean') {
    throw failure('invalid_fixture', 'preserveRoomPlacement must be a boolean.');
  }
  if (settings.seatForEntry !== undefined && typeof settings.seatForEntry !== 'boolean') {
    throw failure('invalid_fixture', 'seatForEntry must be a boolean.');
  }
  return { source, settings };
}

/** Between chapters the framing travels smoothly over 0.8-1.2 s (1.0 s default). */
export const LESSON_FRAMING_TRAVEL_MS = 1_000;
/** The fastest a framing turns a presentation turn back, in degrees per second. */
export const FRAMING_UNWIND_DEGREES_PER_SECOND = 120;
// Making room for its glass leaves a lesson chapter at least this share of
// the angular size it was framed at, and a motion chapter at least this wide.
export const GLASS_MIN_SIZE_SHARE = .75;
export const MOTION_MIN_DEGREES = 35;

// `runSpatialAction` lets the embedding workspace admit an in-headset toolbar
// edit through the same serialized queue as its desktop controls and remote
// saves. Without one, spatial edits apply directly, as they did before.
export async function createViewer({ canvas: element, container, onSelection = () => {}, onMutation = () => {}, onInteraction = () => {}, onLocalEdit = () => {}, onMotionChange = () => {}, enableTestHooks = false, enableInspection = false, enableXr = false, runSpatialAction = (_action, apply) => apply(), onOpenWorkbench = undefined, onGrowStructure = undefined, getSceneHistory = undefined, onSceneHistoryAction = undefined }) {
  let appliedGeometryBudget;
  const cachedVisibleStageBounds = createVisibleStageBoundsCache();
  // The rows on screen now, and their Mol* loci once an animation needs it.
  const cachedDrawnSubset = createDrawnSubsetCache();
  let drawnSubsetLoci;
  let initialFigureFrame, sourceCoordinateFrame;
  if (!(element instanceof HTMLCanvasElement) || !(container instanceof HTMLDivElement)
      || typeof onSelection !== 'function' || typeof onMutation !== 'function' || typeof onInteraction !== 'function' || typeof onLocalEdit !== 'function' || typeof onMotionChange !== 'function' || typeof enableTestHooks !== 'boolean'
      || typeof enableInspection !== 'boolean' || typeof enableXr !== 'boolean') {
    throw new TypeError('createViewer requires a canvas, its div container and callback functions.');
  }
  // Same stock PluginContext boundary as the renderer lab. Inspection-only
  // presentation rotation uses the stock representation transform; it does
  // not add a renderer fork, camera motion, or immersive entry controls.
  let plugin = new PluginUIContext({
    actions: [], behaviors: [], animations: [],
    config: [
      [PluginConfig.General.AllowMajorPerformanceCaveat, true],
      [PluginConfig.General.PowerPreference, 'default'],
      [PluginConfig.VolumeStreaming.Enabled, false],
      [PluginConfig.Viewport.ShowXR, 'never'],
    ],
    canvas3d: {
      renderer: { backgroundColor: Color(0x111b23), ...(enableXr ? {
        // A key/fill/rim rig with a cool ambient, in place
        // of the flat key-plus-back-light this had. The rig and the reasoning
        // live in `XR_RENDERER_LIGHTING`; it is stated there rather than here
        // because the budget module is where every other look decision is
        // justified and measured, and `?xrRenderBudget=light:off` selects the
        // old rig for an A/B. Colours are hex numbers there so that module
        // stays free of Mol* imports, so wrap them here.
        ...(rig => ({
          ambientColor: Color(rig.ambientColor),
          ambientIntensity: rig.ambientIntensity,
          light: rig.light.map(one => ({ ...one, color: Color(one.color) })),
        }))(xrRendererLighting(globalThis)),
      } : {}) },
      camera: {
        manualReset: true,
        stereo: { name: 'off', params: {} },
        helper: { axes: { name: 'off', params: {} } },
      },
      cameraFog: { name: 'off', params: {} },
      // Physical room-scale presentation; Mol* uses this radius on first XR
      // entry, then retains the wearer's deliberate scale on later entries.
      xr: { sceneRadiusInMeters: 0.9 },
      cameraResetDurationMs: 0,
      multiSample: { mode: 'off' },
      postprocessing: { enabled: false },
      trackball: { staticMoving: true, animate: { name: 'off', params: {} } },
    },
  });
  try {
    await plugin.init();
    if (!await plugin.initViewerAsync(element, container)) throw new Error('Mol* could not initialize WebGL.');
    await plugin.canvas3dInitialized;
  } catch (error) {
    plugin.dispose();
    throw error;
  }
  let canvas = plugin.canvas3d;
  if (!canvas) { plugin.dispose(); throw new Error('Mol* did not create Canvas3D.'); }
  const state = {
    instanceId: crypto.randomUUID(), generation: 0, loadCount: 0, revision: 0,
    drawCount: 0, lastDrawTimestampMs: null, status: 'empty', error: null,
    sourceSha256: null, selectionKeys: [], lastPick: null,
    replacementPhase: 'idle', lastLoadFailure: null, testPausedAt: null,
    contextLossCount: 0, contextRestorationCount: 0, contextDisposed: false,
    mutationCounts: { load: 0, representation: 0, selection: 0, focus: 0, camera: 0, inspection: 0, pick: 0 },
  };
  // `visibleStage` is the adopted record's experience-visibility
  // filter, kept because the pivot is the centre of what that filter draws.
  let structure, representation, selection, visibleStage, disposedSnapshot, busy = false;
  let spatialRepresentationInputs = [], spatialRepresentationOptions = [];
  let companionRecoveryActive = false, companionRecoveryPendingXr = false;
  let retainedRepresentationCount = 0;
  let appearanceWork;
  let sequenceRefreshVersion = -1;
  const sequenceNavigation = createSequenceNavigation(() => ({
    binding: `${state.sourceSha256}:${state.generation}`,
    rows: selection?.rows, visible: visibleStage, selectionKeys: state.selectionKeys,
    modelNumber: selection?.rows[0]?.identity.modelNumber, assemblyId: selection?.rows[0]?.identity.assemblyId, available: !volume && Boolean(selection?.rows.length),
  }));
  // The loaded density map, when the loaded tier is one. Exactly
  // one of `structure` and `volume` is ever set; a tier is atoms or it is
  // density, and nothing in this file draws both at once.
  let volume;
  // The MEASURED triangle count of the loaded isosurface, taken
  // off the built geometry rather than read from the lesson. Zero for an atomic
  // tier, whose size is its atom sites. The size the headset reports for a
  // density tier, and the one the render budget is solved on.
  let volumeTriangles = 0;
  // The MEASURED extent of the loaded isosurface, in Cartesian
  // Angstroms: `{ center, radius, corners, axisPoint, axisDirection }`. Null
  // for an atomic tier. The grid cell's own sphere (585 A for the `filament`
  // tier) frames the empty box the filament was deposited in; this frames the
  // 307 A of density inside it, and the corners seat the measured
  // screen-space fit `focusPlacement` solves when a caller hands them over as
  // `extrema`. The axis paints the radial two-colour key. Measured once at
  // build, carried on the record like `volumeTriangles`.
  let volumeIsoExtent = null;
  // What the loaded isosurface is ACTUALLY painted with, read
  // back out of Mol*'s colour data after the representation exists — not the
  // params it was asked for. `{ themed, colorType, vertices, wall, crown, other,
  // uniform }`, or null for an atomic tier. This is the field that names a map
  // left cream by an unregistered theme: `themed:false`,
  // `colorType:'uniform'`, `uniform:'#cccccc'`. Carried on the record, and on
  // the snapshot, so the swap trace can put it on the `grow` phases where it
  // outlives the 200-entry ring's rollover.
  let volumePaint = null;
  const inspectionState = enableInspection ? createInspectionState() : undefined;
  const xrRecoveryFrames = new WeakMap();
  // The lesson colour key and focus the structure is
  // currently wearing, which the saved scene carries so a re-entry, a desktop
  // panel and the agent all see the same molecule the wearer does.
  let emphasisState = { ...NO_EMPHASIS, parts: [], focus: [] };
  // Which chains and component classes are off the screen,
  // which the saved scene carries for the same reason the emphasis does — a
  // reload, a second panel and the agent must all see the molecule the wearer
  // is actually looking at, not the one before they hid half of it.
  let visibilityState = emptyVisibility();
  let stylesState = [];
  let styleLayers = [];
  const measurementLines = createMeasurementLines({canvas:plugin.canvas3d,
    getTransform:()=>presentationTransform(), getAnimation:()=>molecularAnimation.poseSample(),
    getGlass:()=>({plates:immersiveSession?.glassPlates?.() ?? [],
      roomToScene:immersiveSession?.presentation?.()?.roomMatrix?.()})});
  const lessonFigure = createLessonFigure({ plugin, getStructure: () => structure, getTransform: () => presentationTransform(),
    getCoordinateFrame: () => sourceCoordinateFrame,
    getGeometryOptions: () => ({ deviceClass: sessionDeviceClass(currentXrSession(), globalThis.navigator),
      quality: xrRepresentationQuality({ presenting: Boolean(canvas.xr.isPresenting.value),
        representation: inspectionSnapshot().appearance.representation }), standalone: isStandaloneHmdAgent(globalThis.navigator) }),
    getGeometryEntries: () => sceneGeometryEntries(styleLayerDefinitions(stylesState)),
    plateGate: (figure, plan) => figurePlateGate(figure, plan), animationOwns: repr => molecularAnimation.owns(repr),
    getAnimation: () => molecularAnimation.poseSample()?.definition });
  const molecularAnimation = createMolecularAnimation({ plugin, canvas, cachePresentation: true,
    // A teardown returns the plates to the figure's static decision.
    onRelease: () => lessonFigure.applyVisibility(),
    getStaticMask: () => staticMaskLoci(),
    onError: error => {
      recordCost('xr-frame-error', { phase:'molecular-animation', error:error?.message ?? String(error) });
      for (const settle of [...frameWaiters]) settle(error);
    },
    getStructure: () => structure, getRepresentations: () => scientificRepresentations(false, true),
    getTransform: () => presentationTransform(),
    getAnnotations: () => {
      const wanted = new Set([...componentLabelRepresentations(), ...lessonFigure.annotations()]);
      const entries = [];
      for (const cell of plugin.state.data.cells.values()) {
        const repr = cell.obj?.data?.repr, data = cell.obj?.data?.sourceData;
        if (!wanted.has(repr)) continue;
        const locis = [...(data?.infos ?? []).map(info => info.loci), ...(data?.pairs ?? []).flatMap(pair => pair.loci)];
        if (locis.length) entries.push({repr, loci:locis.reduce((a,b) => StructureElement.Loci.union(a,b)), gate:lessonFigure.plateGate?.(repr)});
      }
      return [...entries, ...lessonFigure.motionAnnotations().map(entry => ({...entry, gate:lessonFigure.plateGate?.(entry.repr)}))];
    },
    // Immersion uses the existing deduplicated pre-render hook below.
    schedule: callback => requestAnimationFrame(callback),
    cancel: id => cancelAnimationFrame(id),
    isImmersive: () => canvas.xr.isPresenting.value,
    canTick: () => (state.status === 'ready' || state.status === 'mutating') && !canvas.webgl.isContextLost,
    record: (kind, detail) => recordCost(kind, detail),
  });
  let lessonPlayback;
  // The chapter the tour is painting, until the paint ends. Motion drawn for
  // any other chapter meanwhile is outgoing, not this chapter's field.
  let paintingChapter, paintingTurn;
  // The chapter whose framing stands the wearer inside the structure, so its
  // spin is held still (`focusSelection`).
  let turnHeldFor = null;
  // The animated chapter that has had its one menu-clearance move.
  let menuClearanceMovedFor = null;
  let companionRecord;
  const comparisonSources = new Map();
  // The seat stand-off in metres, which is the distance every
  // in-scene label is sized to subtend its target angle at. Null until a seat
  // has been solved; `labelDistanceMeters` supplies the comfortable middle of
  // Meta's 1-3 m band until then.
  let latestSeatStandoffMeters = null;
  // How far a lesson chapter may stand while it keeps its size, set by its
  // framing: no glass sets it back past this.
  let chapterSizeBound = null;
  let latestPlateSeat = null;
  let pendingRoomLabels = false;
  let pendingRoomLabelBasis = null;
  let pendingRoomSeat = false, settlingRoomAnchor = null, roomEntry = null;
  let adoptionGeneration = 0;
  // The per-part name plates a chapter asks for with
  // `componentLabels`, as ONE serialized owner rather than a bare ref list.
  //
  // Two rebuilds that overlap address the same deterministic cells and delete
  // each other's plates, which is what a session edge landing inside a rebuild
  // used to cause. Every caller below asks this for a rebuild and never learns
  // whether one was already running. Read `component-labels.mjs`.
  let updateMenuLabelPlates, repaintComponentLabelPlates;
  const componentLabels = createComponentLabelSession({
    isPresenting: () => Boolean(canvas.xr.isPresenting.value),
    wantsLabels: () => componentLabelsWanted(),
    buildPlates: context => buildComponentLabelPlates(context),
    updatePlates: (refs, reason, guard) => updateMenuLabelPlates?.(refs, reason, guard) ?? false,
    deletePlates: refs => deleteComponentLabelCells(refs),
  });
  // The loaded lesson's visual baseline — the first chapter's
  // key and its optional plates — plus the plate flag the live appearance sets
  // and the rule about whose key the molecule is wearing. The hydrate, the
  // takeover and the restore all decide through this one object, because when
  // they decided separately they disagreed. Read `lesson-resting.mjs`.
  const lessonResting = createLessonResting({
    emphasize: request => emphasize(request),
    snapshot: () => snapshot(),
    rebuildLabels: () => rebuildComponentLabels(),
    getEmphasis: () => emphasisState,
    getOrigin: () => emphasisOrigin,
  });
  // The colour key the wearer has been taught, which is not the
  // same thing as the layers on the molecule. A takeover, stop or restored
  // starting view releases the active chapter back to the resting key (plain
  // on viewers with no loaded lesson), without deleting the lesson's nouns.
  // Read `lesson-emphasis.mjs`.
  const lessonKey = createLessonKeyMemory();
  // Who asked for the key the structure is wearing. A lesson
  // chapter's key belongs to the lesson, so a takeover that stops the lesson
  // takes it off; a key an agent or the wearer asked for by name outlives the
  // lesson, because nobody stopped anything when they asked for it. The saved
  // scene records it as well (`sceneEmphasisSchema`): a restore has
  // to know whether a key was a lesson's resting paint, which a plain session
  // returns to chain colours, or one somebody asked for by name, which stays.
  // The change patch still has no word for it, so no agent can claim lesson
  // ownership through `update_inspection`.
  let emphasisOrigin = 'command';
  // Which lesson chapter last framed, as its own colour key. A
  // repaint of the same key is the same chapter, so it never frames twice.
  let lastLessonChapterKey;
  // Resolve the wearer's stored render quality before
  // anything builds geometry, so a wearer who chose `best`, left the session
  // and came back does not see one chapter of `balanced` first. Defaults to
  // `balanced`, which is exactly what the budget did before the lever existed.
  activeRenderQuality(globalThis);
  // The radial colour theme the density tier is painted with.
  // Registered once, before any volume builds; a registry that refuses it
  // leaves the tier on its uniform grey rather than on no representation, and
  // says so on the build record. `recordCost` is hoisted, so this may run here.
  // `registerVolumeRadialColorTheme` now answers with what the
  // registry HOLDS. It used to answer with `registry.get(name)` being truthy,
  // and Mol*'s `get` never misses — it returns `ColorTheme.EmptyProvider` for
  // an unknown name — so the theme was never added, the representation asked
  // for a nameless theme, and the map drew `ColorTheme.Empty`'s uniform
  // 0xCCCCCC — the cream map.
  let volumeThemeRegistered = registerVolumeRadialColorTheme(plugin);
  if (!volumeThemeRegistered) {
    recordCost('volume-theme-fallback', { theme: VOLUME_RADIAL_COLOR_THEME, reason: 'theme_not_registered' });
  }
  let inspectionLabel;
  // Residue-label components a failed build or removal could not delete.
  // `removeInspectionLabels` retries them before anything else. Name plates
  // left the same way belong to the label session instead.
  const strandedLabelRefs = new Set();
  // The representation type Mol* is actually carrying, so a
  // rebuild can say whether it was a recreate (a full geometry build) or an
  // in-place update. Advisory: it feeds the cost record and nothing else.
  let builtRepresentation;
  /**
   * The ligands, drawn at the representation the chapter
   * asked for after the budget demoted the rest of the structure away from it.
   *
   * `{ component, representation, type }`, or undefined when nothing is
   * demoted — which is every chapter that is not an all-atom ask on a heavy
   * Quest 2 scene, and every session off a headset.
   */
  let ligandOverlay;
  let orientationReference;
  const reducedMotionQuery = enableInspection && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  let motionFrame, motionFrameScheduler, motionLastFrame, motionAngle = 0, motionUserPaused = false, lastMotionNotification;
  // The presentation turn frozen into the placement since the structure last
  // stood in a pose of its own: the degrees, and the rotation they left.
  let frozenTurn;
  let motionMutationPaused = false, motionToolPaused = false, motionXrExplicit = false, motionContextPaused = false,
    motionDocumentPaused = document.hidden;
  let presentationFreeze, pendingPresentationPick;
  /**
   * The chapter's turn is a transient, like a held grip's.
   *
   * While it holds a camera, `completeInspectionCapture` reports that camera
   * rather than the turning one, so the panel's saved scene does not drift and
   * the panel keeps answering `ready` to an agent command mid-chapter. The
   * tour player bakes it once when the chapter's motion ends.
   */
  const lessonMotionHold = createLessonMotionHold();
  // 4 deg/s is the Mac panel's drift, 12 deg/s the headset's
  // turn. `presentationDegreesPerSecond` picks by session, not by caller, so
  // `setInspectionMotion` keeps taking exactly `{ paused }`.
  const motionDegreesPerSecond = () => presentationDegreesPerSecond(canvas.xr.isPresenting.value === true);
  const readStructureSubject = createStructureSubjectReader();
  // The menu may refresh during an in-flight command. It reads only the last
  // rendered subject, never the mutable appearance/visibility being requested.
  let renderedStructureSubject, renderedStructureSubjectSignature;
  const spatialSubject = () => renderedStructureSubject;
  function refreshStructureSubject(rendered) {
    if (!rendered?.ready) return;
    const subject = readStructureSubject(sourceRecord, structure?.obj?.data?.model, {
      ready: true, modelNumber: rendered.modelNumber, assemblyId: rendered.assemblyId,
      selectionKeys: rendered.selectionKeys,
      // Legacy menu group rows still paint their own transparency cells.
      // Include those committed layers as well as agent-owned scene visibility.
      visibility: { ...visibilityState, hiddenClasses: [...new Set([
        ...visibilityState.hiddenClasses,
        ...Object.entries(VISIBILITY_LAYER_REF).filter(([, ref]) => plugin.state.data.cells.get(representationLayerRef(representation, ref))?.obj).map(([group]) => group),
      ])] },
      appearance: { representation: rendered.representation, color: rendered.color },
      figure: Boolean(lessonFigure.snapshot()),
      // Density has no molecular emphasis layers, even when its lesson names parts.
      emphasis: volume ? undefined : { ...emphasisState, contextOpacity: paintedContextOpacity(emphasisState.contextOpacity) },
      styles: styleLayers.map(layer => {
        const params = layer.representation?.cell?.params?.values;
        return { representation: params?.type?.name, color: params?.colorTheme?.name };
      }),
    });
    const signature = JSON.stringify(subject);
    if (signature === renderedStructureSubjectSignature) return;
    renderedStructureSubject = subject;
    renderedStructureSubjectSignature = signature;
    // Caption geometry is advisory; a failed plate update cannot undo a
    // molecular render or produce an early command acknowledgment.
    try { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); } catch { /* Session teardown. */ }
  }
  function rejectPlacementViews(message) {
    for (const check of [...placementViewWaiters]) check(Error(message));
  }
  /**
   * Read a committed placement back as a sentence.
   *
   * Called only where a placement RECEIPT exists — after the mutation resolved
   * and the transform was applied — so the plate can never say the structure
   * moved before it did. A pose that cannot be read leaves `placementNote`
   * null and the plate says nothing, which is the same silence as before
   * for exactly the cases where a direction would be a guess.
   */
  function notePlacement(placement, reason) {
    try {
      const sphere = loadedSphere();
      if (!sphere || !latestRoomPlacementPose) { placementNote = null; return placementNote; }
      placementNote = placementNoteFor({
        translation: placement?.translation, scale: placement?.scale, reason,
        center: Array.from(sphere.center), radius: sphere.radius, cameraScale: canvas.camera.scale,
        renderFromRoom: latestRoomPlacementPose.renderFromRoom, headInRoom: latestRoomPlacementPose.headInRoom,
        menuPoints: immersiveSession?.platePoints?.() ?? [], startRoomPoint: entryRoomPoint,
      }) ?? null;
    } catch { placementNote = null; }
    try { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); } catch { /* Session teardown. */ }
    return placementNote;
  }
  let sourceRecord, dataRoot, activeWork, activeLoad, frameCover, disposePromise, detachSpatialMenuHook, detachSpatialAimHook;
  let recoveryRecord, recoveryPromise, pendingContextLoss, lossExtension, xrPreview, immersiveSession, xrPresentationRepresentationCount = 0;
  // The player is mounted after the workspace/viewer. Keep only its narrow
  // action/state surface here so immersive presentation never owns tour data.
  let spatialTour, detachSpatialTour, voiceInteraction, detachVoiceInteraction;
  // Growth feedback retains its timed state; the talk card draws the reply.
  let growthOverlay;
  // Why the next plate layout is being solved, when a menu motion
  // is what asked for it. Written by `onMenuPlaced` and taken by
  // `componentLabelLayout`, which is the only place it can reach the ring.
  let menuResolveReason = null;
  const labelMeasurementGate = createLabelMeasurementGate();
  let componentLabelMeasurement = null;
  // A scene/emphasis may repaint the same key many times. Keep the authored
  // part signature separate from focus/opacity: those are paint, not plate
  // geometry, and rebuilding Mol* text for them is the Quest frame-rate cliff.
  let componentLabelBuildSignature = null;
  const componentLabelBounds = createSelectionBoundsCache(loci => StructureElement.Loci.getBoundingSphere(loci));
  let componentLabelLayoutCache = null;
  let latestHeadContext = null, latestHeadSample = 0, latestRoomPlacementPose = null;
  let retainedPoseHidden = false, retainedEntryCheckPending = false;
  function retainedFitObjects() {
    return scientificRepresentations(true).flatMap(repr => repr.renderObjects)
      .filter(object => object.type !== 'text')
      .map(object => object.state?.visible === false
        ? { ...object, state: { ...object.state, visible: true } } : object);
  }
  function showRetainedPose(revealFittedCells = false) {
    if (!retainedPoseHidden) return;
    if (revealFittedCells) for (const cell of [representation, ligandOverlay?.representation,
      companionRecord?.representation, ...styleLayers.map(layer => layer.representation)]) {
      if (cell?.obj?.data?.repr?.state?.visible === false)
        plugin.state.data.updateCellState(cell.ref, { isHidden: false });
    }
    for (const repr of scientificRepresentations(true)) canvas.add(repr);
    retainedPoseHidden = false;
    canvas.commit(false);
  }
  let retainedEntryCheck;
  function hideRetainedPose() {
    // A recovery can add a companion or scoped layer after an earlier hide.
    // Remove the complete current scene each time before admitting a new fit.
    for (const repr of scientificRepresentations(true)) canvas.remove(repr);
    retainedPoseHidden = true;
    canvas.commit(false);
  }
  function checkRetainedEntryPose() {
    if (retainedEntryCheck) return retainedEntryCheck;
    retainedEntryCheckPending = true;
    hideRetainedPose();
    if (!immersiveSession?.platePoints?.()?.length) return;
    const current = inspectionSnapshot().placement;
    const checking = Promise.resolve().then(() => {
      if (state.status === 'disposed' || !canvas.xr.isPresenting.value) throw Error('The placement check was cancelled.');
      // This entry owner publishes the recovery instruction once below.
      return clearHeldPlatePlacement(current, { keepWearer: true, kind: 'retained-pose', announce: false });
    })
      .then(() => { showRetainedPose(); })
      .catch(error => {
        if (!retainedPoseHidden || !canvas.xr.isPresenting.value || state.status === 'disposed' || error?.code === 'FIT_CANCELLED') return;
        try { talkCaption?.set({ outcome: error.message + ' Press Reset or Fit to show the structure.', holdMs: 6000 }); }
        catch { /* The menu stays reachable if caption drawing fails. */ }
        try { recordManipulation('outcome', { status: 'refused', action: 'entry-seat', reason: error.message }); }
        catch { /* Diagnostics cannot block entry. */ }
      }).finally(() => {
        if (retainedEntryCheck === checking) { retainedEntryCheck = undefined; retainedEntryCheckPending = false; }
      });
    retainedEntryCheck = checking;
    return checking;
  }
  async function supersedePlacementFit() {
    const checks = [...placementViewWaiters].filter(check => check.fitKind === 'appearance');
    if (!checks.length) return;
    const pending = typeof inspectionMutationSettlement !== 'undefined' ? inspectionMutationSettlement : activeWork?.done;
    for (const check of checks) check(Error('The fit was cancelled by a newer change. Kept the previous appearance.'));
    await retainedEntryCheck;
    await pending;
  }
  const placementViewWaiters = new Set();
  let latestRetainedProof;
  function awaitPlacementViews() {
    if (!canvas.xr.isPresenting.value || (latestRoomPlacementPose?.labelViews?.length === 2 || (latestRoomPlacementPose?.labelViews?.length === 1 && latestRoomPlacementPose?.labelViews[0]?.eye === 'none'))) return Promise.resolve();
    const session = canvas.webgl.xr?.session;
    const deadline = performance.now() + 2000;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true; placementViewWaiters.delete(check);
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const check = error => {
        if (error) { finish(error); return; }
        if (canvas.webgl.xr?.session !== session || !canvas.xr.isPresenting.value)
          finish(Error('The headset session ended before placement could be measured.'));
        else if ((latestRoomPlacementPose?.labelViews?.length === 2 || (latestRoomPlacementPose?.labelViews?.length === 1 && latestRoomPlacementPose?.labelViews[0]?.eye === 'none'))
          || (typeof immersiveSession !== 'undefined' && !immersiveSession?.platePoints?.()?.length)) finish();
        else if (performance.now() >= deadline)
          finish(Error('Cannot place the structure until both eye views are measurable. Try again in a moment.'));
      };
      const timer = setTimeout(() => check(Error('Cannot place the structure until both eye views are measurable. Try again in a moment.')), 2000);
      placementViewWaiters.add(check);
      check();
    });
  }
  /** A chapter's synchronous layout may outlive its last drawn head sample. */
  function awaitFreshFocusTracking(owner, timeoutMs = 2000) {
    const session = currentXrSession(), source = sourceRecord, generation = state.generation, subject = visibleStage;
    const began = performance.now(), deadline = began + timeoutMs, sampledAt = latestHeadSample;
    const reading = () => ({ sampleAgeMs: Number.isFinite(latestHeadSample) ? Math.max(0, Math.round(performance.now() - latestHeadSample)) : null,
      roomPose: Boolean(latestRoomPlacementPose), drawCount: state.drawCount,
      presenting: Boolean(canvas.xr.isPresenting.value), visibility: session?.visibilityState ?? null });
    const note = (outcome, error) => {
      try { recordCost('focus-tracking', { outcome, waitedMs: Math.round(performance.now() - began), timeoutMs, ...reading(),
        ...(error ? { reason: error.code ?? 'tracking_unavailable' } : {}) }); } catch { /* Diagnostic only. */ }
    };
    note('waiting');
    return new Promise((resolve, reject) => {
      let finished = false, timer;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); placementViewWaiters.delete(check); frameWaiters.delete(finish);
        try { session?.removeEventListener?.('end', ended); } catch { /* The session may already be torn down. */ }
        if (owner.trackingChanged === check) delete owner.trackingChanged;
        note(error ? 'refused' : 'fresh', error);
        error ? reject(error) : resolve();
      };
      const ended = () => finish(failure('stale_transition', 'The headset session ended before chapter framing.'));
      const check = error => {
        if (finished) return;
        try {
          if (error) throw error;
          assertContext();
          if (currentXrSession() !== session || !canvas.xr.isPresenting.value)
            throw failure('stale_transition', 'The headset session changed before chapter framing.');
          if (state.generation !== generation || sourceRecord !== source || visibleStage !== subject || focusPivotRequest !== owner)
            throw failure('stale_transition', 'The molecular scene or framing request changed while waiting for headset tracking.');
          if (interactionActive()) throw failure('interaction_active', 'Release the molecular drag before framing the chapter.');
          // Check the wall-clock deadline before accepting even a fresh sample:
          // a long task can defer both this observer and the timeout callback.
          if (performance.now() >= deadline)
            throw failure('tracking_timeout', 'Wait for headset tracking before framing the chapter.');
          if (latestRoomPlacementPose && latestHeadSample > sampledAt && performance.now() - latestHeadSample < 1500) finish();
        } catch (error) { finish(error); }
      };
      placementViewWaiters.add(check); frameWaiters.add(finish); owner.trackingChanged = check;
      try {
        session?.addEventListener?.('end', ended, { once: true });
        timer = setTimeout(() => check(failure('tracking_timeout', 'Wait for headset tracking before framing the chapter.')), timeoutMs);
        check();
        if (!finished) canvas.requestDraw();
      } catch (error) { finish(error); }
    });
  }
  /**
   * The sentence the caption plate says about where the
   * structure is standing, and the room point this session's entry seat used.
   *
   * The note describes the placement after rendering. The completed row breaks
   * a Fit/Reset tie (`placement-report.mjs`). It is cleared when the
   * session restarts, when a different structure is loaded, and when a later
   * placement replaces it. It is NOT put on a timer: Quest Browser stops
   * servicing window timers for the length of an immersive session (see
   * `outcome-line.mjs`), and a wearer who has just sent the structure over
   * their own head may look away and back before they read the plate.
   */
  let placementNote = null, entryRoomPoint = null;
  // The announced pause before the tab leaves for Mol*. Held so a
  // second press, or a disposal, can call the first one off.
  let workbenchHandoff;
  let roomAnchor = null; // Session-scoped floor tracking.
  // A placement the wearer chose outlives the XR session it was
  // chosen in. Lifting the headset to read Mol* on the Mac ends the session,
  // and the next entry used to spend its one automatic floor settle overriding
  // that choice two or three seconds after the structure reappeared.
  let wearerPlacedInRoom = false;
  const roomSeatMemory = createRoomSeatMemory((() => { try { return globalThis.sessionStorage; } catch { return undefined; } })());
  let roomCameraInitialized = false;
  const spatialInputOwners = new Set();
  let spatialReleaseUntil = 0;
  // A grab is transient, exactly like the presentation spin.
  // `grabRotation` is a scene-space rotation and `grabScale` a uniform factor,
  // both about the positioned centroid; one placement mutation bakes them when
  // the grip is released. Neither reaches the room-locked menu.
  // `grabOffset` is the transient travel in scene units, so a held
  // grip moves the structure through the room as well as turning it.
  let grabRotation, grabScale = 1, grabOffset, xrManipulation, restoreTrackball;
  const gesturePivot = createGesturePivot();
  let focusPivotRequest;
  let xrTransformBatchDepth = 0, xrTransformPending = false;
  // A flat preview owns a temporary camera, never the saved room reference.
  let desktopPreviewCamera, desktopPreviewMaxDistance;
  /**
   * A tier has just landed and its first framing owes the
   * wearer a turn.
   *
   * Set by the source swap that preserved the room placement — which is what a
   * "grow it" is, and the only thing that is — and spent by the next framing
   * inside the headset. A wearer who grabs the structure in between has posed
   * it themselves, and that outranks the lesson, so the grip clears it.
   */
  let pendingGrowthTurn = false;
  // The wearer's own placement, and what it suspends. A grab, a
  // spoken move and a menu nudge all take it; Reset view, Fit and a spoken
  // "recenter" give it back. See wearer-placement.mjs.
  const wearerPlacement = createPlacementHold();
  const agentPlacementHistory = createAgentPlacementHistory({ hold: wearerPlacement, context: () => {
    const scene = liveScene();
    return { session: canvas.xr?.isPresenting?.value ? canvas.webgl.xr.session : undefined,
      source: JSON.stringify([scene?.sourceSha256, scene?.modelNumber, scene?.assemblyId]) };
  } });
  // Face buttons and the two structure-moving thumbsticks.
  let xrButtons, xrThumbstick, xrPushStick;
  // The trigger/grip modifier layer, and the head-seated caption.
  let stickModifiers, triggerStickIntent, talkCaption, detachConnectionMenu;
  let entryGeometryAdvisory;
  // Apple's look-and-pinch, and the reference space its poses are
  // read in. The space is sampled from the session's own frame hook rather
  // than requested again, so a pinch ray and the menu's ray are in one space.
  let naturalInput, latestXrSpace, xrControllerInput, xrInputHeadInRoom, xrAimUnavailable = false;
  const plateEyeInverse = Mat4(), plateEye = Vec3();
  /** The wearer's head in scene coordinates, for plates that face it. */
  function plateEyeInSource(headInRoom) {
    const scale = canvas.camera.scale;
    if (!headInRoom || !(scale > 0)) return undefined;
    // While presenting, the camera view is the room-from-render transform,
    // and render coordinates are scene coordinates times the camera scale.
    Mat4.invert(plateEyeInverse, canvas.camera.view);
    Vec3.set(plateEye, headInRoom[12], headInRoom[13], headInRoom[14]);
    Vec3.transformMat4(plateEye, plateEye, plateEyeInverse);
    return Vec3.scale(plateEye, plateEye, 1 / scale);
  }
  let xrInputBlind = false, xrDeferredGrab, xrDeferredBake, xrInputLifecycle, xrPlacementFollowup;
  const xrInputRelease = createXrInputReleaseGate();
  // Whether the wearer's room is showing. Mol* sets its own copy
  // of this at session start — true for an `alpha-blend` session and false for
  // an opaque one (`canvas3d.js:417`) — and keeps it in a closure this page
  // cannot read, so this mirror is seeded the same way on entry.
  let passthroughOn = false;
  // Preserve explicit Room choices across XR entries and browser reloads.
  let preferredPassthrough = readPassthroughPreference();
  let lastTriggerHand, lastTriggerAt = 0, lastNoSessionAt = 0;
  const nextTest = { failAt: null, pauseAt: null };
  const frameWaiters = new Set();
  const candidateRecords = new Set();

  // Stock InputObserver starts its private dragging state on mousedown and
  // emits drag only after movement. Observe the same native start/end events
  // as well as its public interaction stream to cover a held, unmoved pointer.
  let mouseHeld = false, touchHeld = false, inputInteraction = false, xrInputHeld = false, manualXrInputHeld = false;
  const spatialOwnedHands = new Set();
  let chapterInteractionDepth = 0, hostLoadDepth = 0;
  async function runChapter(action) {
    chapterInteractionDepth++;
    try { return await action(); } finally { chapterInteractionDepth--; }
  }
  const interactionActive = () => !hostLoadDepth && (mouseHeld || touchHeld || inputInteraction || xrInputHeld);
  const signalManualInteraction = kind => {
    // This callback is deliberately separate from committed scene mutation:
    // Mol* trackball camera drags can change the saved camera without emitting
    // onMutation. XR head pose never reaches this path; tracked controllers do.
    if (inspectionState) takeWearerPlacement(kind);
    try { onInteraction({ kind }); } catch (error) { console.error(error); }
  };
  const mouseDown = event => {
    if (hostLoadDepth) return;
    mouseHeld = event.buttons !== 0 || event.button === 0;
    if (mouseHeld) {
      signalManualInteraction('pointer');
      void pausePresentationForInput('pointer-pause', { allowInteraction: true }).catch(error => console.error(error));
    }
    else syncPresentationMotion();
  };
  const mouseUp = () => { mouseHeld = false; inputInteraction = false; syncPresentationMotion(); };
  const touchChange = event => {
    if (hostLoadDepth) return;
    const canvasTouch = Array.from(event.touches).some(touch => touch.target === element);
    touchHeld = canvasTouch;
    if (canvasTouch) {
      signalManualInteraction('touch');
      void pausePresentationForInput('pointer-pause', { allowInteraction: true }).catch(error => console.error(error));
    }
    if (!touchHeld) inputInteraction = false;
    syncPresentationMotion();
  };
  const endInteraction = () => { mouseHeld = touchHeld = inputInteraction = false; syncPresentationMotion(); };
  const wheelInput = () => {
    signalManualInteraction('wheel');
    void pausePresentationForInput('wheel-pause', { allowInteraction: true }).catch(error => console.error(error));
  };
  const keyInput = () => { void pausePresentationForInput('key-pause', { allowInteraction: true }).catch(error => console.error(error)); };
  // The immersive depth band. `xr-depth-band.mjs` carries the
  // reasoning and the arithmetic; this side owns only the camera writes.
  let depthRestore, lastDepthMinFar = 0;
  function applyImmersiveDepth() {
    const camera = canvas.camera, scale = camera?.scale;
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (!depthRestore) depthRestore = { minFar: camera.state.minFar, fog: camera.state.fog };
    const patch = immersiveDepthPatch({ cameraScale: scale, currentFog: camera.state.fog, lastMinFar: lastDepthMinFar });
    if (!patch) return;
    lastDepthMinFar = patch.minFar;
    camera.setState(patch, 0);
    // `camera.far` is recomputed by `update()`, which otherwise runs on the
    // next frame; the log would then carry the planes this call replaced.
    try { camera.update(); } catch { /* A torn-down camera has nothing to log. */ }
    recordImmersiveDepth({ minFar: patch.minFar, scale, camera });
  }
  function releaseImmersiveDepth() {
    lastDepthMinFar = 0;
    if (!depthRestore) return;
    const restore = depthRestore;
    depthRestore = undefined;
    // The wearer can change fog from inside the session, so the saved
    // inspection wins over the value this session started with.
    let fog = restore.fog;
    try { const saved = inspectionState ? inspectionSnapshot().appearance.fog : undefined; if (Number.isFinite(saved)) fog = saved; }
    catch { /* No readable inspection; the entry value stands. */ }
    try { canvas.camera.setState({ minFar: restore.minFar, fog }, 0); }
    catch { /* The session already tore the camera down. */ }
  }
  /** The far plane, the fog switch and the scale that produced them, on the headset log. */
  function recordImmersiveDepth({ minFar, scale, camera }) {
    let record;
    try { record = globalThis.__stereofoldDiagnostics?.record; } catch { return; }
    if (typeof record !== 'function') return;
    try {
      // `updateClip` scales every input before it computes the planes, so
      // `camera.far` and `camera.near` are already metres.
      record('render-budget', { depthFarMeters: Number(camera.far.toFixed(2)),
        depthNearMeters: Number(camera.near.toFixed(3)), minFarMeters: XR_FAR_METERS,
        minFarSceneUnits: Number(minFar.toFixed(2)), cameraScale: Number(scale.toFixed(5)), fog: 'off' });
    } catch { /* A diagnostics failure never touches immersion. */ }
  }
  element.addEventListener('mousedown', mouseDown, true);
  element.addEventListener('touchstart', touchChange, { capture: true, passive: true });
  // Capture releases the guard before stock Mol* emits a mouse-up residue click.
  window.addEventListener('mouseup', mouseUp, true);
  window.addEventListener('touchend', touchChange, { capture: true, passive: true });
  window.addEventListener('touchcancel', touchChange, { capture: true, passive: true });
  window.addEventListener('blur', endInteraction, true);
  element.addEventListener('wheel', wheelInput, { capture: true, passive: true });
  element.addEventListener('keydown', keyInput, true);
  const interactionSubscriptions = [
    canvas.input.drag.subscribe(event => {
      if (hostLoadDepth) return;
      // Tracked controller buttons have their own release/tracking gate. Stock
      // Mol* also emits desktop-shaped drag/gesture events for those buttons.
      if (canvas.xr.isPresenting.value && (event.button & XR_TRIGGER_BUTTON)) return;
      inputInteraction = event.buttons !== 0; syncPresentationMotion();
    }),
    canvas.input.pinch.subscribe(() => { if (hostLoadDepth) return; inputInteraction = true; syncPresentationMotion(); }),
    canvas.input.gesture.subscribe(event => {
      if (hostLoadDepth) return;
      // Mol* 5.11 emits two-controller Trigger/Squeeze gestures without isEnd,
      // including when the last button releases. They cannot own this desktop
      // latch: xrInputHeld already owns the same native controllers.
      if (canvas.xr.isPresenting.value && (event.button & XR_TRIGGER_BUTTON)) return;
      inputInteraction = !event.isEnd; syncPresentationMotion();
    }),
    canvas.input.interactionEnd.subscribe(() => { inputInteraction = false; syncPresentationMotion(); }),
    // A held controller owns inspection even before it has moved. CSS pointer
    // admission on the desktop canvas cannot suspend tracked XR input.
    canvas.input.trackedPointers.subscribe(pointers => {
      // Native snapshots below preserve pose quality and pose-less buttons.
      if (!xrControllerInput) processXrPointers(pointers);
    }),
    canvas.xr.isPresenting.subscribe(presenting => {
      molecularAnimation.reanchor();
      if (!presenting) entryGeometryAdvisory = undefined;
      if (presenting) restoreImmersiveCamera();
      beginRoomEntry(presenting);
      if (presenting) globalThis.__stereofoldDiagnostics?.beginSession?.({ session: canvas.webgl.xr?.session, plugin });
      // A room-sized far plane and no fog while the wearer can
      // push the structure across the room; the saved appearance is untouched.
      if (presenting) applyImmersiveDepth(); else releaseImmersiveDepth();
      if (presenting) beginXrManipulation(); else endXrManipulation();
      // telomerge: name plates built while the page was flat (the lesson's
      // resting state) carry the desktop size factor, which is invisible in
      // the headset; rebuild them at the XR angular size when a session begins
      // and back at the desktop size when it ends.
      //
      // This subscriber is the ONE owner of the plates across a session edge:
      // `onPresented` and `onLeavingPresentation` below rebuild the structure
      // at the immersive quality and deliberately leave the plates to this.
      // Gated on whether plates are WANTED or already live, never on the ref
      // count — the list is empty for the whole of an in-flight rebuild, so
      // gating on it declined the very edges this exists to catch. The session
      // re-reads the presenting flag after its own awaits, so an edge that
      // lands inside this rebuild is picked up rather than lost.
      if (componentLabelsWanted() || componentLabels.active()) {
        void rebuildComponentLabels(presenting ? 'enter-presentation' : 'leave-presentation', undefined, { force: true })
          .catch(error => console.error(error));
      }
      if (presenting) {
        // Entering immersion freezes the object once if idle; head pose never
        // participates in presentation motion or saved inspection state.
        if (!motionXrExplicit) {
          void freezePresentationPose('immersive-pause').then(frozen => {
            if (!frozen) stopPresentationMotion({ resetPose: !busy });
            syncPresentationMotion();
          }).catch(error => console.error(error));
        }
      }
      if (!presenting) {
        releaseHeadsetView(canvas.webgl.gl); // A capture never outlives its session.
        xrInputHeld = false; manualXrInputHeld = false; motionXrExplicit = false; spatialInputOwners.clear(); spatialOwnedHands.clear(); spatialReleaseUntil = 0;
        // A frame scheduled on the ended session never fires. Release it here,
        // or startPresentationMotion() reads desktop rotation as already
        // running and the structure stays frozen after leaving immersion.
        if (motionFrame !== undefined && motionFrameScheduler) stopPresentationMotion({ resetPose: false });
      }
      // Stock XR forces full-scene depth. A deliberate cutaway opts out;
      // clearing it restores stock full-scene behavior for head movement.
      if (inspectionState) canvas.camera.forceFull = presenting && inspectionSnapshot().appearance.clipping === 0;
      syncPresentationMotion();
    }),
  ];
  const reducedMotionChange = () => {
    if (reducedMotionQuery?.matches) {
      void freezePresentationPose('reduced-motion-pause').then(frozen => {
        if (!frozen) stopPresentationMotion({ resetPose: !busy });
        syncPresentationMotion();
      }).catch(error => console.error(error));
    }
    syncPresentationMotion();
  };
  reducedMotionQuery?.addEventListener?.('change', reducedMotionChange);
  const visibilityChange = () => { molecularAnimation.suspend(document.hidden); motionDocumentPaused = document.hidden; syncPresentationMotion(); };
  document.addEventListener('visibilitychange', visibilityChange);

  function assertContext({ recovering = false } = {}) {
    if (state.status === 'disposed') throw failure('viewer_disposed', 'The viewer has been disposed.');
    if (canvas.webgl.isContextLost) throw failure('context_lost', 'The molecular WebGL context was lost.');
    if (!recovering && ['context_lost', 'recovering'].includes(state.status)) {
      throw failure('context_recovering', 'The molecular context has not completed its recovery draw.');
    }
    if (state.status === 'error') throw failure('viewer_failed', state.error ?? 'The viewer failed.');
  }

  function assertReady() {
    assertContext();
    if (busy || appearanceWork) throw failure('viewer_busy', 'A molecular change is still rendering.');
    if (state.status !== 'ready') throw failure('viewer_not_ready', 'Load a molecular scene first.');
  }

  if (enableXr) {
    immersiveSession = createImmersiveSession({
      plugin,
      canvas,
      Mat4,
      // The near plane stays in front of the talk caption and every drawn
      // name plate too.
      glassPoints: () => talkCaption?.platePoints?.() ?? [],
      glassSpheres: () => componentLabelDepthSpheres(),
      isReady: () => {
        try { assertReady(); return true; }
        catch { return false; }
      },
      deliberateClipping: () => Boolean(inspectionState && inspectionState.clipping() > 0),
      consumesTriggerClick: () => {
        const hand = xrManipulation?.pickAmbiguous?.() ? undefined : lastTriggerHand;
        return Boolean(xrManipulation?.consumesPick?.(hand) || stickModifiers?.engagedWithin?.(undefined, hand));
      },
      // Presentation helpers are outside the molecular scene. Keep the
      // acknowledgement count aligned with Canvas3D's primary representations.
      onPresentationRepresentationChange: count => { xrPresentationRepresentationCount = count; },
      canResumeDesktop: () => state.status !== 'context_lost' && state.status !== 'recovering' && !canvas.webgl.isContextLost,
      getVoiceInteraction: () => voiceInteraction,
      // The head observer reads this around each XR callback, so a
      // headset capture is taken only after the callback that drew the eye.
      getDrawCount: () => state.drawCount,
      // The loaded lesson's colour key, for the spoken
      // grammar only. It is read once per finished utterance rather than put
      // inside `getSpatialState`, which the menu redraws from every frame.
      // The key the wearer learned, not the layers on the
      // molecule right now. The two are the same during a chapter and differ
      // the moment anything clears the paint, and the grammar needs the names.
      getLessonParts: () => lessonKey.parts(emphasisState).map(part => ({ id: part.id, label: part.label })),
      onOpenWorkbench,
      getSpatialState: () => ({ connection: connectionStatus(), ...inspectionSnapshot(), subject: spatialSubject(), motion: inspectionMotionSnapshot(),
        representations: spatialRepresentations(),
        geometryBudget: appliedGeometryBudget,
        // A controller/voice placement owns the existing menu relation too.
        placementMoves: wearerPlacement.state().moves,
        ...spatialSharedHistory(),
        sequence: sequenceNavigation.snapshot(),
        // Where the last placement receipt put the
        // structure, in the wearer's own words. Absent until a placement has
        // rendered, so the plate is unchanged on a scene nobody has moved.
        ...(placementNote ? { placementNote } : {}),
        // The menu row names the state it is in rather than the
        // feature, so a wearer who has lost track of which session they are in
        // can read it off the panel instead of pressing the row to find out.
        passthrough: passthroughOn,
        // An opaque session stays alive when this browser has no
        // immersive AR. The menu reads the same cached capability as the
        // session switch, so it cannot offer a Room on press that will fail.
        passthroughSupported: immersiveSession?.passthroughSupported?.(),
        // The level the quality row reads and cycles.
        ...spatialRenderQuality(),
        densityMap: Boolean(volume),
        // Retain growth state for controls; replies draw on the talk card.
        ...(spatialTour?.getState ? { tour: growthOverlay
          ? { ...(spatialTour.getPresentationState?.() ?? spatialTour.getState()), growth: growthOverlay }
          : spatialTour.getPresentationState?.() ?? spatialTour.getState() } : {}),
        // `kind` separates a tour line the wearer never asked
        // for from an answer to something they did, so the voice row can stop
        // calling a lesson `Answering…`. An older interaction without
        // `playbackKind` simply reports no kind and reads as a reply.
        ...(voiceInteraction?.state ? { voice: { state: voiceInteraction.state(),
          ...(voiceInteraction.playbackKind?.() ? { kind: voiceInteraction.playbackKind() } : {}) } } : {}) }),
      // The tour controller itself, not a snapshot of it. A
      // session that stops being visible pauses autoplay through the same
      // `pause`/`togglePlay` the menu's own Play row uses.
      getSpatialTour: () => spatialTour,
      getMolecularBounds: () => molecularBounds(),
      getEntryGeometry: ({ keyOnly = false } = {}) => {
        // A still illustrated chapter seats the menu beside its plates too.
        const bounds = chapterFieldBounds(undefined, { still: true });
        const transform = presentationTransform();
        // Plain chapters need a new proof after source geometry, opacity or
        // placement changes too. Moving chapters keep their stable envelope;
        // no per-tick transform versions enter their content signature.
        const footprint = bounds ?? scientificRepresentations(true).flatMap(repr => repr.renderObjects ?? []).map(object => {
          const values = object.values ?? {};
          return [object.id, object.type, object.state?.visible, object.state?.alphaFactor,
            values.uAlpha?.ref.value, values.tTransparency?.ref.version, values.aPosition?.ref.version,
            values.tPositionGroup?.ref.version, values.tSize?.ref.version, values.uSize?.ref.value, values.uSizeFactor?.ref.value,
            values.aTransform?.ref.version, values.boundingSphere?.ref.value];
        });
        return {
          // A redraw-signature read needs the same exact proof key, but never
          // consumes the envelope's expanded vertices. Measurements still get
          // eager geometry from this call's current bounds and transform.
          objects: keyOnly ? [] : bounds ? [framingEnvelopeObject(bounds, transform)]
            : [representation?.obj?.data?.repr, ligandOverlay?.representation?.obj?.data?.repr]
              .flatMap(repr => repr?.renderObjects ?? []),
          clearanceKey: JSON.stringify([footprint, Array.from(transform), canvas.camera.scale]),
          cameraScale: canvas.camera.scale, views: latestRoomPlacementPose?.labelViews ?? [],
          renderFromRoom: latestRoomPlacementPose?.renderFromRoom,
        };
      },
      beforeMenuDraw: clearChapterMenu,
      // The structure the wearer arrives to was tessellated for the desktop
      // panel: Mol* sizes cartoon subdivisions from the site count and leaves
      // ribbon tubes double-sided, and the headset pays that vertex and fill
      // count once per eye per frame. `applyInspectionAppearance` is the only
      // path that rebuilds it, and it reads the immersive quality itself now
      // that the session is presenting. Labels are left alone: they are their
      // own geometry and rebuilding them buys nothing here.
      // `componentLabels: false` because the `isPresenting` subscriber above
      // already owns the plates across this same edge. Both paths rebuilding
      // them was the second half of the vanishing-plate defect: two runs over
      // the same deterministic cells, the older one's deletes taking the newer
      // one's plates with them. The subscriber fires on the same transition, so
      // nothing is lost by declining here — and `canRebuildForXr` is false
      // while the viewer is busy, which used to drop the rebuild entirely.
      // The menu column is drawn, so the plate layout can
      // finally be solved against it. The `isPresenting` subscriber above ran
      // its rebuild while the toolbar was still being built, and a toolbar
      // with no panel reports no points, so that pass laid the plates out with
      // no obstacle at all. This is the one re-solve that gives the solver the
      // rectangle; `rebuild` coalesces, so it costs one pass however many
      // edges land together.
      // And every later pass, for the same reason. The column
      // does not stay where that first pass found it — Move re-seats it on the
      // pose the wearer has now, Menu folds and opens it, a reset view does
      // both — and a plate solved against where it used to be either sits under
      // it or is held out of a space it has left. The session hands over one
      // settled motion at a time and names it; `reason` rides the next
      // `component-label-layout` record so a hardware log says which press
      // moved the plates.
      onMenuPlaced: ({ reason } = {}) => {
        labelMeasurementGate.invalidate();
        if (componentLabelsWanted() || componentLabels.active()) {
          menuResolveReason = typeof reason === 'string' && reason ? reason : null;
          void componentLabels.relayout(reason).catch(error => console.error(error));
        }
      },
      onPresented: async () => { await prepareEntryGeometryAdvisory(); },
      onLeavingPresentation: async () => { releaseFigurePlates(); fitDesktopPreview(); try { if (canRebuildForXr({ presenting: false })) await applyInspectionAppearance({ labels: false, componentLabels: false }); } finally { fitDesktopPreview(); } },
      onConsumeSpatialSelect: ({ inputSource, phase }) => {
        const hand = inputSource?.handedness;
        if (phase === 'start') {
          onLocalEdit();
          spatialInputOwners.add(inputSource);
          if (hand) spatialOwnedHands.add(hand);
        } else {
          spatialInputOwners.delete(inputSource);
          if (hand) spatialOwnedHands.delete(hand);
          spatialReleaseUntil = performance.now() + 250;
        }
      },
      onSpatialActionIntent: (_action, { origin = 'wearer' } = {}) => {
        if (origin === 'wearer') onLocalEdit();
        for (const check of [...placementViewWaiters]) if (check.fitKind === 'appearance')
          check(Error('The fit was cancelled by a newer menu action. Kept the previous appearance.'));
      },
      onSpatialAction: async action => {
        // Shared history first flushes this panel, then lets polling render the
        // restored scene. Holding the workspace queue here would block that
        // render. Standalone viewers keep their local undo/redo below.
        if ((action.kind === 'undo' || action.kind === 'redo') && typeof onSceneHistoryAction === 'function')
          return onSceneHistoryAction(action.kind);
        if (action.kind === 'sequence') return runSpatialAction(action, async () => {
          // Validate the source and displayed page again inside the same queue
          // that owns manual edits and shared scene application.
          //
          // A pointed row carries the binding and version of the page
          // it was drawn on, and that pair is what refuses a press aimed at a
          // page that has since changed. A spoken or agent action was never
          // drawn, so it has no such pair; it is stamped with the browser's
          // CURRENT reading here, which is the page the wearer is looking at
          // while they speak. Nothing else is filled in, so a stale pointed row
          // is still refused exactly as before.
          const live = sequenceNavigation.snapshot();
          const stamped = action.binding === undefined && action.version === undefined
            ? { ...action, binding: live.binding, version: live.version } : action;
          const result = sequenceNavigation.act(stamped);
          if (result.selection) await select(result.selection);
          if (result.focus) await focus(result.focus);
          showHeadsetCaption(result.caption);
          return result;
        });
        if (action.kind === 'reconnect') return requestConnectionRecovery();
        if (action.kind === 'voice-toggle') {
          if (connectionStatus().line) { showHeadsetCaption(TALK_LINK_LOST);return; }
          if (!voiceInteraction?.toggle) throw Error('Voice controls are not ready.');
          return voiceInteraction.toggle();
        }
        // "recenter" and "say that again" reach the same code the
        // Y button and the reply memory already use, including the guard that
        // refuses to seat a structure a hand is still holding. A spoken command
        // and a press cannot drift apart if there is only one of each.
        if (action.kind === 'recenter-structure' || action.kind === 'repeat-reply') return runFaceAction(action.kind);
        // "move the menu" dispatched this and
        // `runSpatialAction` had no case for it, so the wearer was told
        // "Unsupported spatial control" for a command the grammar knows.
        if (action.kind === 'recenter-menu') {
          if (!immersiveSession?.toolbarAction) throw Error('The menu is not ready.');
          return immersiveSession.toolbarAction({ kind: 'recenter-menu', reason: 'menu' });
        }
        // Passthrough has to be reachable by one press, the way it was before
        // this build. This is that way, from a menu row and from
        // "passthrough on" / "show my room".
        if (action.kind === 'passthrough') return setPassthrough(typeof action.on === 'boolean' ? action.on : !passthroughOn);
        // Done shares the player's automatic ending and its single spoken line.
        if (action.kind === 'tour-done') {
          if (!spatialTour?.finish) throw Error('Tours are not ready.');
          return spatialTour.finish('done');
        }
        if (action.kind === 'collapse') {
          spatialTour?.closeMenu?.();
          return;
        }
        if (action.kind === 'tour-menu') {
          if (!spatialTour?.openMenu) throw Error('Tours are not ready.');
          return spatialTour.openMenu();
        }
        if (action.kind === 'tour-choice') {
          if (!spatialTour?.cycleTour) throw Error('Tours are not ready.');
          if (!spatialTour.getState?.().menuOpen) throw Error('The tour chooser is closed. Press Tours to choose a journey.');
          return spatialTour.cycleTour();
        }
        if (action.kind === 'tour-play') {
          if (!spatialTour?.togglePlay) throw Error('Tours are not ready.');
          // Toolbar clicks intentionally toggle. Spoken commands carry an
          // explicit target so retries are idempotent and "pause" cannot
          // start a stopped tour.
          const tourState = spatialTour.getState?.();
          if (action.chooser && !tourState?.menuOpen) throw Error('The tour chooser is closed. Press Tours to choose a journey.');
          if (typeof action.playing === 'boolean' && tourState
            && Boolean(tourState.autoplay) === action.playing) return tourState;
          await spatialTour.togglePlay();
          const result = spatialTour.getState?.();
          recordManipulation('xr-button', { action: 'tour-play', outcome: result?.autoplay ? 'playing' : 'paused',
            step: result?.step, total: result?.total, navigating: result?.navigating });
          talkCaption?.set({ outcome: result?.autoplay ? `Playing. ${result.progress}.` : 'Autoplay paused.' });
          return result;
        }
        // A spoken "next" or "back" with no lesson running starts
        // the lesson, so the answer has to be the one a start is answered with.
        // The player owns that decision; this reports which one it took.
        if (action.kind === 'tour-back' || action.kind === 'tour-next') {
          const step = action.kind === 'tour-next' ? spatialTour?.next : spatialTour?.back;
          if (!step) throw Error('Tours are not ready.');
          const before = spatialTour.getState?.();
          await step.call(spatialTour);
          return { started: Boolean(before) && !before.active };
        }
        if (action.kind === 'tour-page') {
          if (!spatialTour?.nextReadoutPage) throw Error('Tours are not ready.');
          return spatialTour.nextReadoutPage();
        }
        // "grow it", said by the wearer, inside the session.
        //
        // It is NOT admitted through `runSpatialAction`. The host swap that
        // answers it runs the panel's own save and hydrate, and both of those
        // take the workspace queue this action would already be holding, so
        // growing from inside the queue deadlocks the rebuild it asked for.
        // `open-workbench` above sits outside the queue for the same reason.
        //
        // The host answers a refused tier through the same return as a landing
        // — "Too big for this headset. Staying here." is what a Quest 2 hears
        // above the wall — so nothing here treats a refusal as a failure. The
        // sentence is handed back for the runner to speak and recorded in the
        // headset log, where it can be read back afterwards.
        //
        // A 409 busy panel is not a refusal. The page retries
        // it; this branch says "One moment." once while that wait is running
        // and hands `retrying` back so the runner records retrying then applied.
        if (action.kind === 'grow-structure') {
          if (typeof onGrowStructure !== 'function') throw Error('This viewer cannot grow a staged lesson.');
          if (typeof action.stage !== 'string' || !action.stage) throw Error('Invalid growth request.');
          let retrying = false;
          const answer = await onGrowStructure(action.stage, {
            onNotYet() {
              if (retrying) return;
              retrying = true;
              try { showHeadsetCaption('One moment.'); } catch { /* Caption is accessory to the wait. */ }
              try { void voiceCommandSpeaker()?.('One moment.'); } catch { /* Speech is accessory to the wait. */ }
            },
          });
          const spoken = typeof answer === 'string' ? answer.trim() : '';
          recordManipulation('grow', { stage: action.stage, ...(spoken ? { spoken } : {}), ...(retrying ? { retrying: true } : {}) });
          // The talk card carries confirmations and refusals; the runner speaks them.
          armGrowthCaption(spoken);
          return { ...(spoken ? { spoken } : {}), ...(retrying ? { retrying: true } : {}) };
        }
        if (action.kind === 'open-workbench') {
          if (typeof onOpenWorkbench !== 'function') throw Error('Mol* workbench is unavailable here.');
          // The host serves the full Mol* viewer to this same origin, so in the
          // headset the wearer gets the real Mol* UI in Quest Browser. Opening
          // it on a Mac monitor the wearer cannot see is now only the fallback
          // for a host that does not serve the page.
          if (canvas.xr.isPresenting.value && action.target === 'mac') {
            // "open it on the Mac", the one phrase that means a
            // monitor rather than the headset. The session is left running,
            // because the wearer asked for a second screen, not for an exit.
            // The runner speaks the successful confirmation. A refusal owns
            // its short caption and speech here, with the full host reason
            // returned for the runner's diagnostics.
            const outcome = await openDetailedViewOnHost({ preferHere: false });
            recordManipulation('workbench', { opened: outcome.opened, here: false, target: 'mac',
              ...(outcome.error ? { error: outcome.error } : {}) });
            if (!outcome.opened) {
              showHeadsetCaption(outcome.caption);
              speakOutcome(outcome.caption);
              return { announced: true, outcome: 'refused', reason: outcome.error ?? outcome.caption };
            }
            return { announced: false, openedOnMac: true };
          }
          if (canvas.xr.isPresenting.value) {
            const outcome = await openDetailedViewOnHost();
            // The address carries this companion's page key in its fragment.
            // Record whether it opened here, never the address itself.
            recordManipulation('workbench', { opened: outcome.opened, here: outcome.here === true,
              ...(outcome.error ? { error: outcome.error } : {}) });
            if (typeof outcome.headsetUrl === 'string') {
              const address = outcome.headsetUrl;
              // Announce only after the host accepts; coordinate-free tiers
              // refuse without first promising a transfer. Start the hold now.
              const announced = announceWorkbenchTransfer({
                showCaption: showHeadsetCaption,
                speak: text => voiceCommandSpeaker()?.(text),
              });
              // Quest Browser shows no 2D page over a running immersive
              // session: it draws the page as a flat panel under the system
              // banner "The immersive web experience is still running in the
              // background". Hold what is left of the announcement, end the
              // session, confirm from the renderer that it is really gone, and
              // only then send this same tab to the viewer. Teardown is
              // scheduled outside the toolbar action chain for the reason the
              // desktop branch below gives.
              workbenchHandoff?.cancel();
              workbenchHandoff = beginWorkbenchHandoff({
                announcedAt: announced.at,
                caption: outcome.caption,
                showCaption: showHeadsetCaption,
                endSession: () => immersiveSession?.end(),
                // The renderer's own presentation flag
                // is the second reading. A teardown that resolved while the
                // headset is still presenting is the exact case that puts the
                // background-session banner in front of the wearer.
                confirmEnded: () => canvas.xr.isPresenting.value !== true,
                // The wearer keeps the scene, so the only thing owed is the
                // sentence. It is spoken as well as drawn, because the caption
                // plate is the layer a half-finished teardown can lose.
                onStayed: (stayed, why) => {
                  try { outcome.onStayed?.(); } catch { /* The undo is bookkeeping, not the answer. */ }
                  speakOutcome(stayed);
                  recordManipulation('workbench', { opened: true, here: true, left: false,
                    ...(why ? { error: why } : {}) });
                },
                // Quest Browser keeps its background-session banner
                // over the top of this tab after the handoff, and the Mol* page
                // cannot see it. Leave the note this tab is the only one able to
                // write, so the page lays its top row out below the banner
                // instead of underneath it. A tab with no storage still navigates.
                navigate: () => {
                  noteQuestExitBanner((() => { try { return sessionStorage; } catch { return undefined; } })());
                  location.assign(address);
                },
              });
              // The transfer has already been announced and the
              // wearer is being held in the scene until it lands. A spoken
              // command's own confirmation must not talk over that hold.
              return { announced: true, here: true };
            }
            // A refusal or Mac fallback owns the only caption and spoken line.
            showHeadsetCaption(outcome.caption);
            speakOutcome(outcome.caption);
            return { announced: true, here: false,
              ...(!outcome.opened ? { outcome: 'refused', reason: outcome.error ?? outcome.caption } : {}) };
          }
          // The workbench is a desktop side drawer over the same PluginUIContext.
          // Schedule teardown outside the toolbar action chain: toolbar.dispose()
          // waits for this action chain, so awaiting end() here would deadlock.
          // Let this toolbar action settle before ending XR. The teardown
          // disposes the toolbar and joins its action chain; a microtask here
          // could otherwise start that teardown while this action is still in
          // the chain and deadlock disposal.
          setTimeout(() => { void Promise.resolve().then(() => onOpenWorkbench()).catch(() => {}); }, 0);
          return;
        }
        // Spatial edits share the workspace admission queue with scenes
        // arriving from the host, so a toolbar press cannot interleave with
        // an incoming save. Readiness is checked once the queue admits it.
        if (typeof supersedePlacementFit === 'function') await supersedePlacementFit();
        return runSpatialAction(action, async () => {
          if (action.kind === 'toggle-motion') {
            // Controller input may have begun an owned presentation freeze. Wait
            // for that rendered receipt before admitting the explicit target.
            if (presentationFreeze) await presentationFreeze;
            assertReady();
            if (typeof action.paused !== 'boolean') throw Error('Invalid spatial motion control.');
            return setInspectionMotion({ paused: action.paused });
          }
          // The render budget, reached identically from the
          // menu row, a spoken "best quality" and the agent's render-quality
          // command. The level is always explicit, so repeating any of the
          // three cannot cycle past what was asked for. It rebuilds the
          // representation, which is why it is admitted through this queue
          // rather than run beside it like passthrough.
          if (action.kind === 'render-quality') {
            assertReady();
            if (!RENDER_QUALITY_LEVELS.includes(action.level)) throw Error('Invalid render quality level.');
            if (typeof inspection?.setRenderQuality !== 'function') throw Error('Render quality is not adjustable here.');
            const previousGeometryBudget = appliedGeometryBudget;
            const result = await inspection.setRenderQuality(action.level);
            // The headset log is where the level the wearer actually ran at can
            // be read back. `applied` is the renderer's answer —
            // quality tier, framebuffer scale, occlusion — not the request.
            recordManipulation('render-quality', { level: result?.level ?? action.level, ...(result?.applied ? { applied: result.applied } : {}) });
            if (result?.applied?.geometryBudget && geometryBudgetChanged(previousGeometryBudget, result.applied.geometryBudget)) {
              const message = geometryBudgetConfirmation(result.applied);
              showHeadsetCaption(message);
              speakOutcome(message);
              return { ...result, announced: true };
            }
            return result;
          }
          assertReady();
          const current = inspectionSnapshot(), clamp = (n, low, high) => Math.min(high, Math.max(low, n));
          if (action.kind === 'undo') return undoInspection();
          if (action.kind === 'redo') return redoInspection();
          if (action.kind === 'appearance-cycle') {
            const next = nextMolecularRepresentation(current.appearance.representation, spatialRepresentations());
            if (!next || next === current.appearance.representation) return snapshot();
            const previousGeometryBudget = appliedGeometryBudget;
            const result = await configureInspection({ representation: next }, { preservePlacement: true, sceneRepresentation: true });
            if (result?.applied?.geometryBudget && geometryBudgetChanged(previousGeometryBudget, result.applied.geometryBudget)) {
              showHeadsetCaption(result.applied.geometryBudget.message);
              speakOutcome(result.applied.geometryBudget.message);
              return { ...result, announced: true };
            }
            return result;
          }
          if (action.kind === 'room-placement') return placeRoomTarget(action.target);
          // `fitInspection` resets the desktop
          // camera, and a presenting headset never looks through that camera:
          // in VR the structure's place in the room is `placement.translation`.
          // Fitting in VR therefore spoke a confirmation over a structure that
          // had not moved. In VR "fit" means the seat the wearer got on entry.
          if (action.kind === 'fit') return canvas.xr.isPresenting.value ? seatStructureForEntry() : fitInspection();
          // The spoken route to the same framing the agent's
          // focus_selection command uses, over whatever is already selected.
          // A spoken chain letter or residue range names the keys;
          // with neither, this is still the framing of whatever is selected.
          if (action.kind === 'focus-selection') return focusSelection({ framing: action.framing, selectionKeys: spokenSelectionKeys(action) });
          // "show me the guide RNA" again, without the
          // wearer having to wait for the chapter that first said it. The
          // lesson's colour key is whatever the last emphasis painted, so the
          // named part is lit inside the key the wearer already learned rather
          // than against a repaint of the whole structure.
          // And after the lesson has stopped, which is when the
          // wearer actually asks. The key is repainted from the memory, so the
          // part comes back lit inside the colours it was taught in rather
          // than resolving against an empty key and throwing.
          if (action.kind === 'emphasize-part') {
            const key = lessonKey.parts(emphasisState);
            const id = resolveEmphasisPartId(key, action.part);
            const ids = Array.isArray(action.parts) ? action.parts.map(name => resolveEmphasisPartId(key, name)) : [id];
            if (!ids.length || ids.some(value => !value)) throw Error('This lesson does not name that part.');
            return emphasize({ parts: key, focus: ids,
              contextOpacity: lessonKey.contextOpacity(emphasisState), framing: action.framing });
          }
          if (action.kind === 'turn') {
            const degrees = Number(action.degrees);
            if (!Number.isFinite(degrees) || degrees === 0 || Math.abs(degrees) > 360) throw Error('Invalid spatial turn.');
            // The same delta a left-stick push writes, about the same axis, and
            // committed by the same bake. `grabTransform` composes it between
            // the centroid translations, so it turns about its own centre.
            applyGrabDelta({ rotation: Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, wearerAxes().up) });
            await bakeGrab({ gesture: 'voice-turn', degrees });
            return snapshot();
          }
          if (action.kind === 'move') {
            const axes = wearerAxes(), metres = Number(action.metres);
            const along = { up: axes.up, down: axes.up, left: axes.right, right: axes.right, closer: axes.forward, away: axes.forward }[action.direction];
            if (!along || !Number.isFinite(metres) || metres <= 0 || metres > 2) throw Error('Invalid spatial move.');
            applyStickAxis(along, (['down', 'left', 'closer'].includes(action.direction) ? -1 : 1) * metres);
            await bakeGrab({ gesture: 'voice-move', direction: action.direction, metres });
            return snapshot();
          }
          if (action.kind === 'visibility') return setGroupVisible(action.group, action.visible);
          if (action.kind === 'reset') return resetOrientation();
          if (action.kind === 'scale' && [-1, 1].includes(action.direction)) {
            // "make it small" is not "make it 15 per cent
            // smaller". One press of the menu row is one step, and a spoken
            // size word carries how many steps it means, so "make it small" is
            // a visible change rather than one that has to be repeated five
            // times. Bounded here as well as in the grammar.
            const steps = Number.isFinite(action.steps) ? Math.min(8, Math.max(1, Math.round(action.steps))) : 1;
            const next = clampPlacementScale(current.placement.scale * (action.direction > 0 ? 1.15 ** steps : 1.15 ** -steps),
              canvas.xr.isPresenting.value ? roomEntry?.seat?.scale : undefined, current.placement.scale);
            // The wearer chose this pivot, just as with grip-and-stick scale.
            // Keep its room position; when glass overlaps, move the checked
            // menu seat instead of letting automatic framing move the molecule.
            const translation = pivotPreservingTranslation(pivotBounds(), current.placement,
              { rotation: current.placement.rotation, scale: next });
            const applied = await placeInspection({ scale: next, translation }, 'place', { wearer: true });
            takeWearerPlacement('voice-scale', { scale: Math.round((next / current.placement.scale) * 1000) / 1000 });
            return applied;
          }
          if (action.kind === 'nudge') {
            const axis = ['x', 'y', 'z'].indexOf(action.axis);
            if (axis < 0 || ![-1, 1].includes(action.direction)) throw Error('Invalid spatial control.');
            const field = action.mode === 'move' ? 'translation' : 'rotation';
            const values = [...current.placement[field]];
            values[axis] = field === 'translation' ? clampPlacementTranslation(values[axis] + action.direction * .2)
              : ((values[axis] + action.direction * 15 + 540) % 360) - 180;
            const applied = await placeInspection({ [field]: values }, 'place', { wearer: true });
            takeWearerPlacement('menu'); // A menu nudge is the wearer placing it too.
            return applied;
          }
          if (action.kind === 'appearance') {
            if (MOLECULAR_REPRESENTATIONS.includes(action.preset)) {
              const previousGeometryBudget = appliedGeometryBudget;
              const result = await configureInspection({ representation: action.preset }, { preservePlacement: true, sceneRepresentation: true });
              if (result?.applied?.geometryBudget && geometryBudgetChanged(previousGeometryBudget, result.applied.geometryBudget)) {
                showHeadsetCaption(result.applied.geometryBudget.message);
                speakOutcome(result.applied.geometryBudget.message);
                return { ...result, announced: true };
              }
              return result;
            }
            if (['chain-id', 'element-symbol'].includes(action.preset)) return configureInspection({ color: action.preset });
            if (['opacity-down', 'opacity-up'].includes(action.preset)) return configureInspection({ opacity: clamp(current.appearance.opacity + (action.preset === 'opacity-up' ? .15 : -.15), .1, 1) });
          }
          throw Error('Unsupported spatial control.');
        });
      },
      onInputVisibility: handleXrInputVisibility,
      onInputFrame: ({ frame, space, time }) => {
        // The space every pinch pose is read in, and the one frame
        // a pinch gets to promote to a grab or spend its pick. Ahead of the
        // head reading below because a dropped head pose must not cost the
        // wearer the gesture they are holding.
        latestXrSpace = space;
        // This pose is borrowed only while input runs. Drawn views, labels and
        // capture evidence keep their separate post-render snapshot below.
        try { xrInputHeadInRoom = frame.getViewerPose(space)?.transform?.matrix; }
        catch { xrInputHeadInRoom = undefined; }
        const plateEye = plateEyeInSource(xrInputHeadInRoom);
        try {
          try { naturalInput?.frame(frame); } catch (error) {
            try { recordManipulation('natural-input', { event: 'failed', error: error?.message }); } catch {}
            recordCost('xr-frame-error', { phase: 'natural-input', error: error?.message ?? String(error) });
          }
          const controllerPointers = xrControllerInput?.read(frame, space, canvas.webgl.xr?.session);
          if (controllerPointers) processXrPointers(controllerPointers);
        } finally {
          xrInputHeadInRoom = undefined;
          flushXrDeferredGrab();
          molecularAnimation.tick(time);
          for (const repr of lessonFigure.annotations()) sizeImmersiveAnnotation(repr, canvas, plateEye);
          for (const repr of molecularAnimation.tetherRepresentations()) sizeImmersiveAnnotation(repr, canvas);
          // Motion sizing restores authored uniforms. Repair them for THIS
          // frame after input/placement, before either eye draws. Match Mol*'s
          // render reference space, not the previous drawn-pose snapshot.
          try {
            const { position, quaternion } = Mat4.getDecomposition(canvas.camera.view);
            const roomFromRender = new XRRigidTransform(
              { x: position[0], y: position[1], z: position[2] },
              { x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] });
            const pose = frame.getViewerPose(space.getOffsetReferenceSpace(roomFromRender));
            capDrawnPlates(pose?.views);
          } catch (error) {
            recordCost('xr-frame-error', { phase: 'plate-eye-cap', error: error?.message ?? String(error) });
          }
        }
      },
      onHeadFrame: ({ frame, space, mode, drawn }) => {
        connectionFrame();
        flushXrDeferredGrab();
        latestXrSpace = space;
        try {
          const { position, quaternion } = Mat4.getDecomposition(canvas.camera.view);
          const roomFromRender = new XRRigidTransform(
            { x: position[0], y: position[1], z: position[2] },
            { x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] });
          const offset = space.getOffsetReferenceSpace(roomFromRender);
          const pose = frame.getViewerPose(offset), sphere = loadedSphere();
          const roomPose = frame.getViewerPose(space);
          try { recordEntryStandoff(pose, roomFromRender.inverse.matrix); } catch (error) {
            recordCost('xr-frame-error', { phase: 'entry-standoff', error: error?.message ?? String(error) });
          }
          try { measureDrawnComponentLabels(pose); } catch (error) {
            recordCost('xr-frame-error', { phase: 'component-label-measurement', error: error?.message ?? String(error) });
          }
          // Each eye's viewport is read here, while this frame is active. Label
          // sizing runs later, from an async command, and WebKit's getViewport
          // throws InvalidStateError for a view whose frame has ended (Chromium
          // tolerates it). On Vision Pro that turned every residue-label
          // request into "The object is in an invalid state."
          const labelViews = pose?.views ?? [], baseLayer = canvas.webgl?.xr?.session?.renderState?.baseLayer;
          const labelViewports = labelViews.map(view => {
            try { const viewport = baseLayer?.getViewport(view); return viewport ? { width: viewport.width, height: viewport.height } : null; }
            catch { return null; }
          });
          latestRoomPlacementPose = roomPose ? { headInRoom: Array.from(roomPose.transform.matrix),
            renderFromRoom: Array.from(roomFromRender.inverse.matrix), labelViews, labelViewports } : null;
          if (roomEntry && roomPose && !busy && state.status === 'ready') roomEntry.cameraScale = canvas.camera.scale;
          sampleHeadFrame({ pose, roomPose, mode, sphere });
          // The floor arrives seconds after the session
          // starts, so the settle is a frame observation, not an entry step.
          const roomReady = roomAnchor?.observe({ frame, space, session: canvas.webgl.xr?.session,
            headY: latestRoomPlacementPose?.headInRoom[13] });
          // The automatic `above` seat needs a tracked head, not a floor.
          // Do not let the first entry draw the desktop seat while waiting
          // five seconds for a floorless session to spend its settle.
          if (latestRoomPlacementPose && (pendingRoomSeat || roomReady)) settleInRoom(frame, space);
          // A preserved wearer placement needs no new seat, but its plates
          // still need the first tracked basis of this session.
          // Entry may still own a hidden appearance candidate. Keep this
          // intent pending until its final draw, then measure the settled
          // geometry instead of rejecting the provisional hidden selector.
          if (latestRoomPlacementPose && typeof retainedEntryCheckPending !== 'undefined' && retainedEntryCheckPending
            && !busy && !appearanceWork
            && typeof clearHeldPlatePlacement === 'function'
            && immersiveSession?.platePoints?.()?.length) {
            checkRetainedEntryPose();
          }
          if (latestRoomPlacementPose && roomEntry && !roomEntry.seat && !pendingRoomSeat && !(typeof retainedEntryCheckPending !== 'undefined' && retainedEntryCheckPending)
            && !(typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden) && !busy) {
            roomEntry.seat = structuredClone(inspectionSnapshot().placement);
            const sphere = loadedSphere();
            entryRoomPoint = applyMatrix4(sphere.center.map((value, axis) =>
              (value + roomEntry.seat.translation[axis] * sphere.radius) * canvas.camera.scale),
              Mat4.invert(Mat4(), latestRoomPlacementPose.renderFromRoom));
          }
          if (latestRoomPlacementPose && pendingRoomLabels && !pendingRoomLabelBasis) {
            const seatBasis = componentLabelViewBasis();
            pendingRoomLabelBasis = seatBasis;
            // Keep a session-edge pass awaiting deletes empty. Only the queued
            // pass carrying this first tracked basis may consume the intent.
            // Forced: the parts may match the last session's signature, and
            // this pass must still solve from the captured head basis.
            void Promise.resolve().then(() => {
              if (pendingRoomLabelBasis === seatBasis) return rebuildComponentLabels(undefined, seatBasis, { force: true });
            }).finally(() => {
              // A removal or disabled labels can drain without a build.
              if (pendingRoomLabelBasis === seatBasis) {
                pendingRoomLabels = false;
                pendingRoomLabelBasis = null;
              }
            }).catch(error => console.error(error));
          }
          // This observer runs after every XR callback, and only the
          // one that drew (`drawn`) leaves the eye in the presentation buffer.
          if (typeof entryGeometryAdvisory !== 'undefined' && entryGeometryAdvisory) flushEntryGeometryAdvisory(drawn);
          xrSnapshotFrame({ frame, space, session: canvas.webgl.xr?.session, gl: canvas.webgl.gl, drawn });
        } catch (error) {
          latestHeadContext = null; latestRoomPlacementPose = null;
          recordCost('xr-frame-error', { phase: 'head-frame', error: error?.message ?? String(error) });
        }
      },
    });
    // The unattended driver reads and presses the same live
    // rows the wearer sees. `toolbarAction` is the toolbar's own serialized
    // press path, including its diagnostic record, redraw and plate re-solve.
    detachSpatialMenuHook = installSpatialMenuHook({
      readRows: () => immersiveSession?.toolbarRows?.() ?? [],
      readStartup: () => immersiveSession?.startup?.() ?? null,
      runAction: action => immersiveSession?.toolbarAction?.(action),
      // What the menu itself draws from, so an unattended
      // run can tell a press that dispatched from one that changed the scene.
      //
      // The description paging rides alongside it. That counter is
      // toolbar-local — nothing outside the plate has an opinion about which
      // page of a sentence the wearer is on — so it is joined here rather than
      // pushed into the scene state, and a build whose menu is not running
      // publishes no readout at all.
      readState: () => {
        const state = immersiveSession?.spatialState?.() ?? null;
        if (!state || typeof state !== 'object') return state;
        const readout = immersiveSession?.toolbarReadout?.() ?? null;
        return readout ? { ...state, readout } : state;
      },
    });
    // The same rows, reached by a SIMULATED CONTROLLER POSE
    // through the toolbar's real ray hit test — no hand, no wearer.
    detachSpatialAimHook = installSpatialAimHook({
      readRows: () => immersiveSession?.toolbarRows?.() ?? [],
      aim: target => immersiveSession?.toolbarAim?.(target)
        ?? { method: 'synthetic-ray', fired: false, reason: 'no immersive menu is running' },
    });
  }

  function liveScene(record) {
    // A density scene reads its identity off the map, and never
    // reaches for a structure to do it. `volume` is tested first for the same
    // reason `checkDrawnRecord` tests it first: on this tier `structure` is
    // absent, and a scene built from an absent structure is the all-null
    // identity that the capture and the restore both refuse.
    // A candidate owns its identity even when a field is absent. Falling back
    // to the retained map here labels a new atomic candidate as assembly "map"
    // and refuses every density-to-structure swap before it can be committed.
    const loadedVolume = record ? record.volume : volume;
    const data = loadedVolume ? undefined : (record ? record.structure : structure)?.obj?.data;
    const params = (record?.representation ?? representation)?.cell?.params?.values;
    const modelNumbers = data ? [...new Set(data.models.map(model => model.modelNum))] : [];
    const assemblyIds = data ? [...new Set(data.units.map(unit => unit.conformation.operator.assembly?.id ?? 'asymmetric_unit'))] : [];
    const identity = loadedVolume
      ? volumeSceneIdentity(record?.source ?? sourceRecord)
      : { sourceSha256: record?.source?.sha256 ?? state.sourceSha256,
        modelNumber: modelNumbers.length === 1 ? modelNumbers[0] : null,
        assemblyId: assemblyIds.length === 1 ? assemblyIds[0] : null };
    return {
      ...identity,
      representation: params?.type?.name ?? null,
      color: params?.colorTheme?.name ?? null,
      selectionKeys: [...(record?.selectionKeys ?? state.selectionKeys)],
      camera: detached(canvas.camera.getSnapshot()),
    };
  }

  /**
   * The hierarchy entry for the molecule's own representation.
   *
   * The scan now skips Stereofold's own auxiliary components.
   * The ligand overlay is a `StructureComponent` drawn as `spacefill`, which is
   * a perfectly good inspection representation — so from chapter 4 of the wall
   * lesson onwards this scan answered "the molecule's representation" with the
   * overlay, and the next chapter rebuilt the overlay, deleted it, and then
   * painted onto its dead ref. `representation-refs.mjs` holds the rule and the
   * whole chain.
   */
  function findCurrentStructureRepresentation() {
    return findLiveStructureRepresentation(plugin.managers.structure.hierarchy.selection.structures,
      name => INSPECTION_REPRESENTATIONS.has(name), structure?.ref);
  }

  function asViewerRepresentation(ref) {
    if (!ref || typeof ref.update === 'function') return ref;
    // Hierarchy entries are StateObjectCells (obj/cell status, transform.ref),
    // while builder results are StateObjectSelectors (ref/update).  Keep the
    // inspection adapter on the latter contract when a stock workbench or a
    // newly staged source hands over the former.
    const cell = ref.cell ?? ref;
    const refId = ref.ref ?? cell?.transform?.ref;
    if (typeof refId !== 'string') return ref;
    const wrapped = {
      ...ref,
      ref: refId,
      cell,
      checkValid() {
        if (cell?.status === 'ok') return true;
        throw Error(cell?.errorText || 'The live Mol* representation is unavailable.');
      },
      update(params) { return plugin.state.data.build().to(refId).update(params); },
    };
    // StateObjectCell.obj is replaced when a representation update commits;
    // retain a live view instead of the pre-update render object.
    Object.defineProperty(wrapped, 'obj', { enumerable: true, get: () => ref.obj ?? cell?.obj });
    return wrapped;
  }

  function currentMolstarSelectionKeys() {
    const manager = plugin.managers.structure.selection;
    if (!manager?.getLoci || !structure?.obj?.data || !selection?.fromLoci) return undefined;
    try {
      // Mol* keeps its selection as element Loci on the same structure root.
      // Convert through the identity adapter so copies, author residue numbers,
      // and source coordinates retain the canonical Stereofold keys.
      return selection.fromLoci(manager.getLoci(structure.obj.data));
    } catch {
      // A stock query can transiently outlive a replaced component. Keep the
      // last canonical selection until a subsequent stable sync can resolve it.
      return undefined;
    }
  }

  /**
   * Rebind the inspection record after a stock Mol* preset replaces its
   * representation subtree. The stock controls operate on the same plugin
   * state, but the inspection adapter also keeps a typed representation ref so
   * later Stereofold actions can update and persist that live object.
   */
  async function synchronizeRepresentationFromPlugin({ selectionChanged = false } = {}) {
    assertReady();
    const next = findCurrentStructureRepresentation();
    // A selection query does not replace the representation. Mol* can briefly
    // omit the hierarchy entry while its query task settles, so retain the
    // already validated live ref for that event-only sync.
    if (!next && (!selectionChanged || !representation?.obj)) {
      throw failure('workbench_sync_unavailable', 'Mol* changed the live representation, but Stereofold could not identify it.');
    }
    const live = asViewerRepresentation(next ?? representation);
    const changedRef = representation?.ref !== live.ref || representation?.obj !== live.obj;
    const molstarSelectionKeys = currentMolstarSelectionKeys();
    // Sequence clicks use Stereofold's marker path. Only an observed stock
    // selection event authorizes replacing the canonical choice.
    const changedSelection = selectionChanged && Array.isArray(molstarSelectionKeys)
      && (molstarSelectionKeys.length !== state.selectionKeys.length
        || molstarSelectionKeys.some((key, index) => key !== state.selectionKeys[index]));
    const params = live.cell.params.values;
    const patch = {
      ...(INSPECTION_REPRESENTATIONS.has(params.type?.name) ? { representation: params.type.name } : {}),
      ...(INSPECTION_COLORS.has(params.colorTheme?.name) ? { color: params.colorTheme.name } : {}),
    };
    const currentAppearance = inspectionState?.snapshot().appearance;
    const changedAppearance = Boolean(inspectionState && Object.keys(patch).some(key => patch[key] !== currentAppearance[key]));
    // A replaced ref or selection-only event is not a global style request.
    // Adopt an authored figure override only when the observed atomic type
    // actually changes; preserve its source-backed layers and annotations.
    const previousFigure = lessonFigure.definition?.();
    const nextFigure = currentAppearance && previousFigure && patch.representation
      && patch.representation !== currentAppearance.representation
      ? withFigureRepresentation(previousFigure, patch.representation) : previousFigure;
    const figureChanged = JSON.stringify(nextFigure) !== JSON.stringify(previousFigure);
    if (!changedRef && !changedAppearance && !changedSelection && !figureChanged) return snapshot();
    const reconcile = inspectionState ? inspectionMutation : (operation, options) => mutate('inspection', operation, options);
    return reconcile(async () => {
      // Stock Mol* has already changed this cell. Admit its reconciliation
      // normally, then retain the live ref so a failed budget/draw can repaint
      // the saved appearance on that same source instead of a retired cell.
      representation = live;
      if (inspectionLabel && !plugin.state.data.cells.has(inspectionLabel.representation.ref)) inspectionLabel = undefined;
      if (ligandOverlay && !plugin.state.data.cells.has(ligandOverlay.representation.ref)) ligandOverlay = undefined;
      if (figureChanged) sceneGeometry(styleLayerDefinitions(stylesState, { ...currentAppearance, ...patch }),
        companionRecord, patch.representation, nextFigure);
      inspectionState?.beginGroup('molstar-workbench');
      try {
        syncInspectionPayload();
        if (changedSelection || figureChanged) inspectionState?.recordPayload(inspectionPayload(), 'molstar-workbench');
        if (changedAppearance) inspectionState.configure(patch, 'molstar-workbench');
        if (changedSelection) { state.selectionKeys = [...molstarSelectionKeys]; lessonSelection = undefined; }
        if (figureChanged) await lessonFigure.install(nextFigure);
        markSelection(state.selectionKeys);
        await paintSelectionOverlay();
        applyInspectionTransform();
        syncInspectionPayload();
      } finally { inspectionState?.endGroup(); }
    }, { operationKind: 'molstar-workbench', changedLayers: [
      ...(changedAppearance ? ['appearance'] : []), ...(changedSelection ? ['selection'] : []), ...(figureChanged ? ['figure'] : []),
    ] });
  }

  function geometryFor(representationName, data = structure?.obj?.data, figure) {
    const presenting = Boolean(canvas.xr.isPresenting.value);
    if ((companionRecord || stylesState.length || lessonFigure.geometryEntries?.(figure).length) && data === structure?.obj?.data) {
      return comparisonGeometry(companionRecord, representationName, figure)[0];
    }
    return requireGeometryBudget({ representation: representationName, ...structureGeometryCounts(data, representationName),
      presenting, deviceClass: sessionDeviceClass(currentXrSession(), globalThis.navigator),
      quality: xrRepresentationQuality({ presenting, representation: representationName }),
      standalone: isStandaloneHmdAgent(globalThis.navigator) });
  }

  function comparisonGeometry(record, primaryRepresentation = inspectionSnapshot().appearance.representation, figure) {
    const plans = styleLayerDefinitions(stylesState, { ...inspectionSnapshot().appearance, representation: primaryRepresentation });
    return sceneGeometry(plans, record, primaryRepresentation, figure);
  }
  function sceneGeometryEntries(plans, record = companionRecord, primaryRepresentation = inspectionSnapshot().appearance.representation) {
    return [
      { representation: primaryRepresentation, ...structureGeometryCounts(structure.obj.data, primaryRepresentation) },
      ...(record ? [{ representation: record.companionState.appearance.representation, ...structureGeometryCounts(record.structure.obj.data, record.companionState.appearance.representation) }] : []),
      ...plans.map(plan => ({ representation: plan.look.representation, ...structureGeometryCounts(plan.data, plan.look.representation) })),
    ];
  }
  function sceneGeometry(plans, record = companionRecord, primaryRepresentation = inspectionSnapshot().appearance.representation, figure) {
    const presenting = Boolean(canvas.xr.isPresenting.value);
    return requireSceneGeometryBudget([...sceneGeometryEntries(plans, record, primaryRepresentation),
      ...(lessonFigure.geometryEntries?.(figure) ?? [])], { presenting, deviceClass: sessionDeviceClass(currentXrSession(), globalThis.navigator),
      quality: xrRepresentationQuality({ presenting, representation: primaryRepresentation }), standalone: isStandaloneHmdAgent(globalThis.navigator) });
  }

  async function paintCompanion() {
    if (!companionRecord) return;
    const appearance = companionRecord.companionState.appearance;
    const geometry = comparisonGeometry(companionRecord)[1];
    // The headset's own tier, as the base and style layers get it. A budget
    // that reduces detail overrides it with `custom`; one that leaves detail
    // alone returns no typeParams, and without this the companion was rebuilt
    // at Mol*'s `auto` on a Quest 3 or Quest Pro.
    const xrQuality = xrRepresentationQuality({ presenting: canvas.xr.isPresenting.value,
      representation: appearance.representation });
    const params = createStructureRepresentationParams(plugin, companionRecord.structure.obj.data, {
      type:appearance.representation,color:appearance.color,
      typeParams:{alpha:appearance.opacity,...(xrQuality ? { quality: xrQuality } : {}),...geometry.typeParams,
        ...xrBallAndStickParams({ representation: appearance.representation, presenting: canvas.xr.isPresenting.value,
          atoms: companionRecord.structure.obj.data.elementCount, level: geometry.level })},
      colorParams:appearance.color==='uniform'?{value:Color(colorNumber(appearance.uniformColor))}
        :xrColorParams({ color: appearance.color }),
    });
    await companionRecord.representation.update(params).commit({revertOnError:true});
  }
  async function restoreCompanion(value, { deferReveal = true } = {}) {
    if (JSON.stringify(companionRecord?.companionState) === JSON.stringify(value)) return;
    const prior = companionRecord;
    const priorCandidates = new Set(candidateRecords);
    let candidate;
    try {
      if (value) {
        const fixture = comparisonSources.get(`${value.sourceSha256}:${value.assemblyId}`);
        if (!fixture) throw Error('The verified comparison coordinates have not arrived.');
        const {source,settings} = await checkedFixture(fixture,{modelNumber:value.modelNumber,assemblyId:value.assemblyId,
          representation:value.appearance.representation,selectionKeys:[],companionState:value});
        candidate = await buildCandidate(source,settings);
        candidate.companionState = detached(value);
        comparisonGeometry(candidate); // Admission before either visible representation changes.
      }
      companionRecord = candidate;
      await paintCompanion();
      if (prior?.representation?.obj) canvas.remove(prior.representation.obj.data.repr);
      applyInspectionTransform();
      if (candidate) {
        candidateRecords.delete(candidate);
        // Normal changes reveal once, with the final base and scoped layers
        // in applyInspectionAppearance. Recovery has no later appearance pass.
        if (!canvas.xr?.isPresenting?.value || !deferReveal) {
          if (canvas.xr?.isPresenting?.value) {
            await awaitPlacementViews();
            await clearHeldPlatePlacement(inspectionSnapshot().placement, {
              hidden: [candidate.representation.obj.data.repr], keepWearer: true, offThread: true });
          }
          plugin.state.data.updateCellState(candidate.representation.ref,{isHidden:false});
        }
      }
    } catch (error) {
      companionRecord = prior;
      const failedCandidates=new Set([...candidateRecords].filter(staged=>!priorCandidates.has(staged)));
      if(candidate) failedCandidates.add(candidate);
      for (const staged of failedCandidates) await deleteRecord(staged);
      if (prior?.representation?.obj) canvas.add(prior.representation.obj.data.repr);
      throw error;
    }
    // Retain the old root until this transaction's render has settled.
    if (prior) retiredComparisons.add(prior);
  }
  const retiredComparisons = new Set();
  async function setCompanion(patch) {
    assertReady();
    const value = foldCompanion(inspectionSnapshot().companionStructure,patch);
    const prior = inspectionSnapshot().companionStructure;
    let entered = false;
    try {
      const result = await inspectionMutation(async () => {
        entered = true;
        await restoreCompanion(value);
        inspectionState.setCompanion(value);
        await applyInspectionAppearance();
        applyInspectionTransform();
      }, { ownsRecovery: true });
      for (const retired of retiredComparisons) await deleteRecord(retired);
      retiredComparisons.clear();
      return result;
    } catch (error) {
      // A refusal before the change began has nothing to restore. A lost or
      // disposed context owns its own recovery, and a busy viewer belongs to
      // another command.
      if (!entered || busy || canvas.webgl.isContextLost || ['disposed', 'context_lost', 'recovering'].includes(state.status)) throw error;
      // Keep admissions closed until the prior scene has drawn, and report
      // ready only after its frame. A failed redraw keeps the error.
      const failed = error instanceof Error ? error.message : String(error);
      state.status = 'mutating'; busy = true;
      try {
        await restoreCompanion(prior);
        await applyInspectionAppearance(); applyInspectionTransform(); canvas.commit(true); await waitForFrame();
        assertContext(); state.status = 'ready'; state.error = null;
      } catch (recoveryError) {
        if (!['disposed', 'context_lost', 'recovering'].includes(state.status)) {
          state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
          state.error = `${failed}; restoring the previous scene failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
        }
      } finally { busy = false; }
      // The comparisons this edit replaced stay until the restored scene has
      // drawn. A failed delete leaves them for the next change to retry.
      if (state.status === 'ready') {
        try { for (const retired of retiredComparisons) await deleteRecord(retired); retiredComparisons.clear(); }
        catch (dropError) { console.error(dropError); }
      }
      throw error;
    }
  }
  function snapshot() {
    if (disposedSnapshot) return detached(disposedSnapshot);
    const data = structure?.obj?.data;
    const contextLost = canvas.webgl.gl.isContextLost();
    // The packaged runtime exposes a bounds-free settings path. Independent
    // stock-Mol* builds retain their public API fallback.
    const canvasSettings = canvas.getSnapshotSettings?.(Boolean(inspectionState)) ?? (() => {
      const props = canvas.props;
      return { trackballAnimation: props.trackball.animate.name, staticMoving: props.trackball.staticMoving,
        desktopStereo: props.camera.stereo.name,
        clipping: !inspectionState || canvas.camera.forceFull ? 0 : props.cameraClipping.radius };
    })();
    return detached({
      ...state, ...liveScene(), companionStructure:companionRecord?{structureRef:companionRecord.structure.ref,sourceSha256:companionRecord.source.sha256,placement:companionRecord.companionState.placement}:null, applied: { geometryBudget: appliedGeometryBudget }, molstarVersion: PLUGIN_VERSION,
      ready: state.status === 'ready' && !busy && !appearanceWork && !contextLost,
      interactionActive: interactionActive(),
      candidatePresent: [...candidateRecords].some(record => plugin.state.data.cells.has(record.rootRef)),
      candidateCount: [...candidateRecords].filter(record => plugin.state.data.cells.has(record.rootRef)).length,
      frameCoverVisible: Boolean(frameCover),
      frameCoverBytes: frameCover ? frameCover.element.width * frameCover.element.height * 4 : 0,
      stateCellCount: plugin.state.data.cells.size,
      pendingFrameWaits: frameWaiters.size,
      atomCount: data?.elementCount ?? 0,
      residueCount: data?.atomicResidueCount ?? 0,
      // The size of a density scene, in the unit it is measured
      // in. `atomCount` is 0 for one, and reporting only that made an 8.4 MB map
      // look like an empty viewer to everything downstream — the swap trace, the
      // driver's wait and the render budget alike.
      triangleCount: volumeTriangles,
      // The colour the density tier is wearing, measured off
      // Mol*'s colour data. Null for an atomic tier. `inspector.ts` copies it
      // onto the `grow` swap-trace context so a session can be read for colour
      // after the diagnostics ring has rolled over.
      volumeTheme: volumePaint,
      sequenceRowCount: selection?.rows.length ?? 0,
      // A stage component can share the full structure's hash/model/assembly.
      // Done may reuse only a full-source representation for the saved scene.
      sourceSubset: Boolean(visibleStage),
      representationCount: canvas.reprCount.value,
      renderObjectCount: canvas.getRenderObjects().length,
      lessonFigure: lessonFigure.snapshot(),
      animation: molecularAnimation.snapshot(),
      animationActivity: molecularAnimation.activity(),
      ...markerCounts(),
      selectionLociElementCount: selection ? StructureElement.Loci.size(selection.toLoci(state.selectionKeys)) : 0,
      contextLost,
      xrPresenting: canvas.xr.isPresenting.value,
      // Public diagnostic only; this is Mol*'s XR unit conversion, never a headset pose.
      xrCameraScale: canvas.camera.scale,
      trackballAnimation: canvasSettings.trackballAnimation,
      staticMoving: canvasSettings.staticMoving,
      desktopStereo: canvasSettings.desktopStereo,
      ...(inspectionState ? { inspection: inspectionState.snapshot() } : {}),
      ...(inspectionState ? { inspectionRender: { clipping: canvasSettings.clipping,
        fog: canvas.camera.state.fog, labels: Boolean(inspectionLabel?.representation) } } : {}),
      ...(inspectionState ? { inspectionMotion: inspectionMotionSnapshot() } : {}),
    });
  }

  function inspectionSnapshot() {
    if (!inspectionState) throw failure('inspection_disabled', 'Create this viewer with enableInspection: true.');
    return { ...inspectionState.snapshot(), ...savedStyles() };
  }

  function spatialSharedHistory() {
    const history = getSceneHistory?.({ ready: state.status === 'ready' && !busy && !appearanceWork, interactionActive: interactionActive() });
    return history ? { history } : {};
  }

  function spatialRepresentations() {
    if (volume) return [];
    const data = structure?.obj?.data;
    const session = currentXrSession();
    // Input sources can reveal or change the device class without replacing
    // the XR session. Its effective geometry budget must invalidate choices.
    const inputs = [data, session, sessionDeviceClass(session, globalThis.navigator), canvas.xr.isPresenting.value,
      activeRenderQuality(), companionRecord, stylesState, lessonFigure.geometryIdentity?.()];
    if (inputs.some((value, index) => value !== spatialRepresentationInputs[index])) {
      // The geometry policy advises about cost without refusing a style.
      // Merely listing controls must not infer an unused bond graph or resolve
      // every prospective figure. The chosen action still budgets its entire
      // base/figure/comparison scene before changing the representation.
      const choices = data ? MOLECULAR_REPRESENTATIONS.filter(name =>
        plugin.representation.structure.registry.get(name).isApplicable(data)) : [];
      spatialRepresentationInputs = inputs;
      spatialRepresentationOptions = choices;
    }
    return spatialRepresentationOptions;
  }

  function motionReason() {
    if (!inspectionState) return 'disabled';
    if (reducedMotionQuery?.matches) return 'reduced-motion';
    if (motionContextPaused || ['context_lost', 'recovering', 'disposed'].includes(state.status)) return 'context';
    if (motionMutationPaused) return 'mutation';
    if (motionToolPaused) return 'tool';
    if (motionUserPaused) return 'user';
    if (motionDocumentPaused) return 'document-hidden';
    if (interactionActive()) return 'interaction';
    if (canvas.xr.isPresenting.value && !motionXrExplicit) return 'immersive';
    if (state.status !== 'ready' || !representation?.obj) return 'not-ready';
    return null;
  }

  function inspectionMotionSnapshot() {
    const reason = motionReason();
    return { paused: Boolean(reason), reason: reason ?? 'playing', rateDegreesPerSecond: motionDegreesPerSecond() };
  }

  function stopPresentationMotion({ resetPose = true } = {}) {
    if (motionFrame !== undefined) {
      try {
        if (motionFrameScheduler?.cancelAnimationFrame) motionFrameScheduler.cancelAnimationFrame(motionFrame);
        else cancelAnimationFrame(motionFrame);
      } catch { /* A native session may already have ended. */ }
    }
    motionFrame = motionFrameScheduler = motionLastFrame = undefined;
    // Running presentation rotation is transient. An explicit pause while it
    // is visible is baked through the serialized mutation path below; tool
    // work resets its transient angle to the saved placement.
    if (resetPose && motionAngle) {
      motionAngle = 0;
      if (!busy && state.status !== 'disposed' && representation?.obj && !canvas?.webgl?.isContextLost) { applyInspectionTransform(); canvas.commit(true); }
    }
  }

  function rotationFromPlacement(placement) {
    const radians = placement.rotation.map(value => value * Math.PI / 180);
    const x = Mat4.fromRotation(Mat4(), radians[0], Vec3.create(1, 0, 0));
    const y = Mat4.fromRotation(Mat4(), radians[1], Vec3.create(0, 1, 0));
    const z = Mat4.fromRotation(Mat4(), radians[2], Vec3.create(0, 0, 1));
    return Mat4.mul(Mat4(), z, Mat4.mul(Mat4(), y, x));
  }

  function rotationDegreesZYX(matrix) {
    const euler = Euler.fromMat4(Euler(), matrix, 'ZYX');
    return Array.from(euler, value => value * 180 / Math.PI);
  }

  async function freezePresentationPose(action = 'presentation-pause', { allowInteraction = false } = {}) {
    if (!inspectionState || !motionAngle || state.status !== 'ready' || canvas.webgl.isContextLost) return false;
    if (presentationFreeze) return presentationFreeze;
    if (busy) return false;
    const sourceSha256 = state.sourceSha256;
    const generation = state.generation;
    const angle = motionAngle;
    const placement = inspectionSnapshot().placement;
    const checkpoint = inspectionState.checkpoint();
    const spin = Mat4.fromRotation(Mat4(), angle * Math.PI / 180, Vec3.create(0, 1, 0));
    const rotation = rotationDegreesZYX(Mat4.mul(Mat4(), spin, rotationFromPlacement(placement)));
    // The spin turns about the same pivot the wearer's hands
    // use, so freezing its angle carries the same travel correction the grab
    // bake does. Identical to `placement.translation` when nothing is hidden.
    const bounds = pivotBounds();
    const translation = pivotPreservingTranslation(bounds, placement, { rotation, scale: placement.scale });
    // Stop the transient frame loop before serializing its displayed pose. The
    // mutation below owns the state change and publishes only after didDraw.
    stopPresentationMotion({ resetPose: false });
    const freezing = mutate('inspection', () => {
      if (state.sourceSha256 !== sourceSha256 || state.generation !== generation || motionAngle !== angle) {
        throw failure('stale_presentation_freeze', 'The displayed presentation pose is no longer current.');
      }
      inspectionState.setPayload(inspectionPayload());
      inspectionState.place({ rotation, translation }, action);
      motionAngle = 0;
      applyInspectionTransform();
    }, { allowInteraction, presentationFreeze: true });
    presentationFreeze = freezing;
    try {
      await freezing;
      if (typeof noteFrozenTurn === 'function') noteFrozenTurn(angle, placement.rotation, rotation);
      return true;
    } catch (error) {
      // A lost context or failed draw must not leave an unpublished baked
      // placement in the local snapshot recovered by the retained scene.
      inspectionState.restoreCheckpoint(checkpoint);
      motionAngle = 0;
      throw error;
    } finally {
      if (presentationFreeze === freezing) presentationFreeze = undefined;
      flushPendingPresentationPick();
      syncPresentationMotion();
    }
  }

  /** Add a frozen turn to the one owed, if nothing else has turned the structure since. */
  function noteFrozenTurn(degrees, before, after) {
    frozenTurn = { degrees: degrees + frozenTurnDegrees({ rotation: before }), rotation: Array.from(after) };
  }

  /**
   * The presentation turn a framing turns back, in degrees about the vertical.
   *
   * A spin chapter keeps turning once it is shown, and the next scene freezes
   * the angle it reached into the placement. A framing solved in that pose put
   * CRISPR's nuclease close-up at whatever yaw the spin had reached, and at
   * most of them pushed it out to three and a half metres. So a framing is
   * solved in the pose the structure stood in before the turn, and travels
   * back to it. Nothing is owed once anything else has turned the structure.
   */
  function frozenTurnDegrees(placement) {
    if (!frozenTurn || placement?.rotation?.length !== 3) return 0;
    // Compared as turns, not as angle triples: a saved placement may write the
    // same turn as [-180, -32, -180] or as [180, -32, 180].
    const live = rotationFromPlacement(placement), left = rotationFromPlacement(frozenTurn);
    return live.every((value, i) => Math.abs(value - left[i]) < 1e-6) ? frozenTurn.degrees : 0;
  }

  /**
   * Stop the presentation turn for a framing travel, and hand the angle it is
   * showing to the travel instead of freezing it into the placement.
   *
   * The turn and a grip both pivot about `pivotCenter()` once the gesture
   * pivot is invalidated, which every framing does first, so the same angle
   * as `grabRotation` draws the same pose and nothing jumps.
   */
  function takeTurnForFraming() {
    if (!inspectionState || !motionAngle || presentationFreeze) return 0;
    const angle = motionAngle;
    stopPresentationMotion({ resetPose: false });
    motionAngle = 0;
    grabRotation = Mat4.fromRotation(Mat4(), angle * Math.PI / 180, Vec3.create(0, 1, 0));
    applyInspectionTransform();
    return angle;
  }

  async function pausePresentationForInput(action = 'presentation-pause', { allowInteraction = false } = {}) {
    if (!inspectionState) return false;
    motionUserPaused = true;
    const frozen = await freezePresentationPose(action, { allowInteraction });
    if (!frozen) stopPresentationMotion({ resetPose: !busy });
    syncPresentationMotion();
    return frozen;
  }

  /**
   * The held grip's transient turn and size, or `undefined`.
   *
   * Both are about the origin, so composing them between the centroid
   * translations below turns and resizes the structure about its own centre,
   * which is what a two-handed grab is expected to do.
   */
  function grabTransform() {
    if (!grabRotation && grabScale === 1) return undefined;
    const rotation = grabRotation ?? Mat4.identity();
    if (grabScale === 1) return rotation;
    return Mat4.mul(Mat4(), rotation, Mat4.fromScaling(Mat4(), Vec3.create(grabScale, grabScale, grabScale)));
  }

  /**
   * The model-space point every turn pivots about.
   *
   * `placementTransform` measures a saved placement's travel from the whole
   * assembly's bounding-sphere centre, and that stays its origin: it does not
   * move when a stage hides part of the assembly, so a stored view survives a
   * source swap. A turn is the other case. An experience stage draws a
   * filtered subset, and turning that subset about a centre it does not
   * contain swings the only visible thing around a hidden point — an offset,
   * invisible centre of mass.
   *
   * `catalogVisibleBounds` is the same model-space subset centre
   * `transitionBounds` hands `source-transition-anchor.mjs`, in assembly
   * Angstroms, so the two agree about where the drawn thing is. With no stage
   * filter it is undefined and this is the assembly centre, unchanged.
   */
  function pivotCenter() {
    const center = loadedSphere()?.center ?? Vec3.create(0, 0, 0);
    if (!visibleStage || !sourceRecord?.catalog) return center;
    try { return catalogVisibleBounds(sourceRecord.catalog, visibleStage)?.center ?? center; }
    catch { return center; }
  }

  /** The pivot and the assembly centre, for the bake arithmetic. */
  function pivotBounds() {
    const radius = loadedSphere()?.radius;
    return { baseCenter: Array.from(loadedSphere()?.center ?? Vec3.create(0, 0, 0)),
      visibleCenter: Array.from(pivotCenter()),
      radius: Number.isFinite(radius) && radius > 0 ? radius : 1 };
  }

  function gesturePivotContext() {
    return { source: sourceRecord, subject: visibleStage, placement: inspectionState.placement(), fallbackCenter: pivotCenter() };
  }
  function beginGesturePivot() {
    const previous = focusPivotRequest; focusPivotRequest = undefined; previous?.trackingChanged?.();
    gesturePivot.begin(gesturePivotContext());
  }
  function invalidateGesturePivot() {
    const previous = focusPivotRequest; focusPivotRequest = undefined; previous?.trackingChanged?.();
    gesturePivot.invalidate();
  }
  function gesturePivotCenter() { return gesturePivot.read(gesturePivotContext()); }
  function grabPivotBounds() { return { ...pivotBounds(), visibleCenter: gesturePivotCenter() }; }

  function presentationTransform() {
    if (!inspectionState) throw failure('inspection_disabled', 'Create this viewer with enableInspection: true.');
    const base = placementTransform(inspectionState.placement());
    const grabbed = grabTransform();
    if (!motionAngle && !grabbed && !grabOffset) return base;
    let posed = base;
    // Presentation spin keeps the source/stage pivot. A manual gesture may
    // instead own the explicitly framed subject; selection alone never moves it.
    if (motionAngle) {
      const center = Vec3.transformMat4(Vec3(), pivotCenter(), base);
      const spin = Mat4.fromRotation(Mat4(), motionAngle * Math.PI / 180, Vec3.create(0, 1, 0));
      posed = Mat4.mul3(Mat4(), Mat4.fromTranslation(Mat4(), center), spin,
        Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), center)), base));
    }
    if (grabbed) {
      const center = Vec3.transformMat4(Vec3(), gesturePivotCenter(), posed);
      posed = Mat4.mul3(Mat4(), Mat4.fromTranslation(Mat4(), center), grabbed,
        Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), center)), posed));
    }
    // The travel is applied outermost, in world units, so the turn
    // stays about the structure's own centre and only the centre moves. That
    // is the same place `placementTransform` puts the saved offset, which is
    // why the bake below is one addition rather than a re-derivation.
    if (!grabOffset) return posed;
    return Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), grabOffset), posed);
  }

  /**
   * Whether a grip may move the structure this frame.
   *
   * `ready` was the whole of it, and that refused a grip with status
   * `mutating`. A mutation is not a
   * structure load: `load` and `replaceStructure` set `loading` while the
   * atoms change, and `mutating` is a panel save, a tour scene, a camera move
   * or a pick — an edit to a structure that is already drawn and already has a
   * placement to change. A grab through one of those is a grab the viewer can
   * honour: the gesture only accumulates a transient transform, and `bakeGrab`
   * already joins whatever work is in flight before it writes a placement.
   *
   * So the grip yields to a load and to a lost context, and to nothing else.
   */
  const GRABBABLE_STATUS = new Set(['ready', 'mutating']);
  function canManipulateNow() {
    return (!appearanceWork || (typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0))
      && Boolean(inspectionState) && GRABBABLE_STATUS.has(state.status) && !canvas.webgl.isContextLost;
  }

  /**
   * Apply one frame of grip movement and redraw.
   *
   * These deltas arrive from the session's once-per-frame input hook before
   * the renderer draws either eye. `setState` writes the
   * value cells and `canvas.update` refreshes the attributes and world bounds,
   * both synchronously, so the turn the wearer made reaches the same frame.
   * `commit` is deliberately not called here: it would re-enter the draw these
   * pointers were published inside.
   */
  function applyGrabDelta({ rotation, translation, scale }) {
    if (!canManipulateNow()) {
      recordManipulation('xr-grab', { event: 'rejected', reason: GRAB_REJECTED.notReady, status: state.status });
      return;
    }
    cancelXrPlacementFollowup();
    beginGesturePivot();
    let appliedTranslation;
    if (rotation) {
      const delta = Mat4.fromArray(Mat4(), rotation, 0);
      grabRotation = grabRotation ? Mat4.mul(Mat4(), delta, grabRotation) : delta;
      // The wearer has posed the grown tier with their own
      // hands, so the lesson's oblique turn is no longer owed.
      pendingGrowthTurn = false;
    }
    if (translation) {
      // The pointer ray Mol* publishes lives in the camera-scaled world
      // (`xr-manager.js:140` transforms the metre pose by the inverse view,
      // and `camera.js:341` builds that view from a scaled position), so one
      // headset metre is `camera.scale` of these units. Dividing by it makes
      // the structure travel exactly as far as the hand did.
      const scaled = canvas.camera.scale || 1;
      const radius = loadedSphere()?.radius ?? 1;
      const saved = inspectionState.placement().translation;
      const next = grabOffset ?? Vec3.create(0, 0, 0);
      const previous = Array.from(next);
      for (let axis = 0; axis < 3; axis += 1) {
        // Keep the transient inside the same numerical envelope as its saved
        // pose. Ordinary room movement has no ten-radius boundary.
        const upper = (PLACEMENT_MAX_TRANSLATION - saved[axis]) * radius;
        const lower = (-PLACEMENT_MAX_TRANSLATION - saved[axis]) * radius;
        next[axis] = Math.min(upper, Math.max(lower, next[axis] + translation[axis] / scaled));
      }
      appliedTranslation = next.map((value, axis) => (value - previous[axis]) * scaled);
      grabOffset = next;
    }
    if (Number.isFinite(scale) && scale > 0) {
      // Bound the transient against the same limits the saved placement has,
      // so what the wearer sees while grabbing is what the release records.
      const saved = inspectionState.placement().scale, current = saved * grabScale;
      grabScale = clampPlacementScale(current * scale, roomEntry?.seat?.scale ?? saved, current) / saved;
    }
    if (xrTransformBatchDepth) xrTransformPending = true;
    else applyInspectionTransform();
    return appliedTranslation;
  }

  // Preserve each ray/stick delta and clamp in its existing order, but upload
  // only their final composed transform. No eye or pick renders between them.
  function batchXrTransforms(callback) {
    xrTransformBatchDepth++;
    try { return callback(); }
    finally {
      xrTransformBatchDepth--;
      if (!xrTransformBatchDepth && xrTransformPending) {
        xrTransformPending = false;
        applyInspectionTransform();
      }
    }
  }

  function placementIntentCheckpoint() {
    return agentPlacementHistory.checkpoint(inspectionSnapshot().placement);
  }
  function settlePlacementIntent(before, { agent = false, history = false } = {}) {
    if (history) agentPlacementHistory.replay(before, inspectionSnapshot().placement);
    else if (agent) agentPlacementHistory.accept(before, inspectionSnapshot().placement,
      () => takeWearerPlacement('agent-placement'));
  }

  /**
   * The wearer has placed the structure, with the delta that
   * did it on the record ring.
   *
   * The ring is what is read back afterwards, and "the lesson moved it
   * back" and "the wearer moved it and the lesson left it alone" are
   * indistinguishable in a capture. `held` is the per-chapter suspension,
   * `moves` counts the takeovers this session, and the summary carries the
   * degrees, the scale factor and the metres the gesture actually travelled.
   */
  function takeWearerPlacement(reason, summary) {
    const state = wearerPlacement.takeover(reason);
    recordManipulation('wearer-placement', { event: 'takeover', reason: state.reason, chapter: state.chapter,
      moves: state.moves, held: state.held,
      ...(Number.isFinite(summary?.degrees) ? { degrees: summary.degrees } : {}),
      ...(Number.isFinite(summary?.scale) ? { scale: summary.scale } : {}),
      ...(Number.isFinite(summary?.moved) ? { moved: summary.moved } : {}) });
    return state;
  }
  /**
   * One tracked head frame. Tracking is fresh whenever the room pose
   * resolves; a lost pose is never stamped, so spatialContext() cannot present
   * tracking loss as a current sample. The molecule-relative reading stops at
   * 100 radii, which is a far molecule, not lost tracking, so Reset can still
   * bring it back.
   */
  function sampleHeadFrame({ pose, roomPose, mode, sphere }) {
    latestHeadContext = pose && sphere && inspectionState ? relativeHeadContext({ mode, headMatrix: pose.transform.matrix,
      cameraScale: canvas.camera.scale, moleculeTransform: presentationTransform(), center: sphere.center, radius: sphere.radius }) : null;
    if (roomPose) latestHeadSample = performance.now();
    // Notify only after the drawn XR callback has published its real pose and
    // sample time. A renderer callback without tracking cannot satisfy focus.
    if (typeof placementViewWaiters !== 'undefined')
      for (const check of placementViewWaiters) check();
  }

  /** The wearer asked for the authored seat back. */
  function releaseWearerPlacement(reason) {
    if (!wearerPlacement.holdsPlacement()) return;
    const state = wearerPlacement.release(reason);
    recordManipulation('wearer-placement', { event: 'released', reason: state.reason, chapter: state.chapter });
  }

  /** Called once by the player, never by appearance or animation repainting. */
  function beginChapterFraming() {
    cancelXrPlacementFollowup();
    invalidateGesturePivot();
    releaseWearerPlacement('authored-chapter');
  }

  function cancelXrPlacementFollowup() {
    const previous = xrPlacementFollowup;
    // This advisory job owns no caption; cancelling it must not erase an
    // explicit action's progress or the lesson's current reading.
    xrPlacementFollowup = undefined;
    previous?.controller.abort();
    previous?.wake?.();
  }

  // The saved pose has already drawn. Clearance and labels may finish later,
  // but own only this source, session and exact pose, never the next gesture.
  function startXrPlacementFollowup(summary, inputLifecycle, committedMs) {
    const began = now();
    cancelXrPlacementFollowup();
    const controller = new AbortController();
    const token = { controller, source: sourceRecord, generation: state.generation,
      session: canvas.webgl.xr?.session, placement: JSON.stringify(inspectionState.placement()) };
    const isCurrent = () => xrPlacementFollowup === token && !controller.signal.aborted
      && !inputLifecycle?.ended && state.status !== 'disposed' && state.generation === token.generation
      && sourceRecord === token.source && canvas.webgl.xr?.session === token.session
      && JSON.stringify(inspectionState.placement()) === token.placement
      && !grabRotation && grabScale === 1 && !grabOffset;
    xrPlacementFollowup = token;
    const cancel = () => { controller.abort(); token.wake?.(); };
    inputLifecycle?.signal.addEventListener('abort', cancel, { once: true });
    token.done = (async () => {
      // Queue the expensive geometry sampling after the release promise's
      // finally has opened input. Cancellation also settles an unstarted job.
      if (inputLifecycle) await new Promise(resolve => {
        const timer = setTimeout(resolve, 0);
        token.wake = () => { clearTimeout(timer); resolve(); };
      });
      token.wake = undefined;
      if (!isCurrent()) return;
      if (canvas.xr.isPresenting.value && summary?.gesture !== 'focus'
          && latestRoomPlacementPose && typeof clearHeldPlatePlacement === 'function') {
        try {
          await clearHeldPlatePlacement(inspectionState.placement(), {
            // The hand's pose has already rendered and stays visible. This is
            // advisory clearance, not an action asking to hide/recover it.
            allowOffscreen: true, keepWearer: true, kind: 'retained-pose', announce: false,
            signal: controller.signal, isCurrent });
        } catch (error) {
          if (isCurrent()) { token.failed = true; recordManipulation('xr-grab', { event: 'menu-clearance-deferred', error: error?.message }); }
        }
      }
      if (isCurrent() && componentLabels.active()) await componentLabels.relayout('placement', { isCurrent });
    })().catch(error => {
      if (isCurrent()) { token.failed = true; recordManipulation('xr-grab', { event: 'labels-deferred', error: error?.message }); }
    }).finally(() => {
      inputLifecycle?.signal.removeEventListener('abort', cancel);
      recordManipulation('xr-grab-followup', { gesture: summary?.gesture ?? summary?.phase, committedMs,
        followupMs: Math.max(0, now() - began), outcome: isCurrent() ? (token.failed ? 'failed' : 'completed') : 'cancelled' });
      if (xrPlacementFollowup === token) xrPlacementFollowup = undefined;
    });
    return token.done;
  }

  /**
   * Record the grabbed pose as one placement, the way the
   * presentation spin bakes its angle. The transient is cleared inside the
   * mutation so the drawn transform never doubles the turn for a frame.
   */
  async function bakeGrab(summary, { inputLifecycle, focusPivot } = {}) {
    const began = now();
    const sourceAtStart = sourceRecord, generationAtStart = state.generation, sessionAtStart = canvas.webgl.xr?.session;
    const manual = summary?.gesture !== 'focus';
    const owner = manual ? gesturePivot.ownership() : undefined;
    // An old focus continuation can arrive while a newer focus is animating.
    // It never owned the transient currently in these slots.
    if (focusPivot && focusPivotRequest !== focusPivot.owner) return false;
    const framingAtStart = focusPivotRequest;
    const captured = { rotation: grabRotation, scale: grabScale, offset: grabOffset && Array.from(grabOffset) };
    const discardOwnTransient = () => {
      const newer = gesturePivot.ownership();
      if (focusPivotRequest && focusPivotRequest !== framingAtStart) return false;
      if ((newer === undefined || newer === owner) && grabRotation === captured.rotation && grabScale === captured.scale
        && JSON.stringify(grabOffset) === JSON.stringify(captured.offset)) {
        grabRotation = undefined; grabScale = 1; grabOffset = undefined;
        gesturePivot.release(owner);
        if (state.status === 'ready' && !canvas.webgl.isContextLost) applyInspectionTransform();
      }
      return false;
    };
    if (!inspectionState || (!grabRotation && grabScale === 1 && !grabOffset)) {
      grabRotation = undefined; grabScale = 1; grabOffset = undefined; return false;
    }
    // A save or a toolbar edit can still be drawing when the grip comes up.
    // Join it rather than dropping the pose the wearer just set.
    try {
      for (let attempt = 0; attempt < 3 && busy; attempt += 1) await activeWork?.done;
      inputLifecycle?.check();
    } catch (error) {
      // Ending while a prior save is drawing leaves this release uncommitted.
      // Discard only its captured slots; a new session/focus may already own them.
      discardOwnTransient();
      throw error;
    }
    if (focusPivot && (focusPivotRequest !== focusPivot.owner || sourceRecord !== focusPivot.source || visibleStage !== focusPivot.subject
      || (focusPivot.placement && JSON.stringify(inspectionState.placement()) !== focusPivot.placement))) return discardOwnTransient();
    if (sourceRecord !== sourceAtStart || state.generation !== generationAtStart || canvas.webgl.xr?.session !== sessionAtStart
      || (manual && owner !== undefined && !gesturePivot.isCurrent(owner, gesturePivotContext()))) return discardOwnTransient();
    if (state.status !== 'ready' || busy || canvas.webgl.isContextLost) {
      grabRotation = undefined; grabScale = 1; grabOffset = undefined;
      if (state.status === 'ready') applyInspectionTransform();
      recordManipulation('xr-grab', { event: 'dropped', reason: state.status });
      return false;
    }
    const current = inspectionState.placement();
    const turned = grabRotation ? Mat4.mul(Mat4(), grabRotation, rotationFromPlacement(current)) : rotationFromPlacement(current);
    const patch = { rotation: rotationDegreesZYX(turned),
      scale: clampPlacementScale(current.scale * grabScale) };
    // The saved offset is in molecular radii and is added in the
    // same world step the transient uses, so baking the travel is one division.
    // And when a stage draws a subset, the turn pivoted on the
    // subset's centre while the saved travel is still measured from the
    // assembly's, so the pivot offset the wearer was looking at has to be
    // traded for the one the new rotation and scale give. With no stage filter
    // both are zero and this is the plain addition it has always been.
    const bounds = summary?.gesture === 'focus' ? pivotBounds() : grabPivotBounds();
    if (grabOffset || bounds.visibleCenter.some((value, axis) => value !== bounds.baseCenter[axis])) {
      patch.translation = pivotPreservingTranslation(bounds, current, patch, grabOffset);
    }
    try { normalizePlacement(patch, current); }
    catch (error) { grabRotation = undefined; grabScale = 1; grabOffset = undefined; applyInspectionTransform(); throw error; }
    // A face button can still be held for push-to-talk while this runs, and a
    // held button is live interaction, so this mutation admits it the way the
    // presentation freeze does rather than refusing the placement.
    const checkpoint = inspectionState.checkpoint();
    return mutate('inspection', () => {
      syncInspectionPayload();
      inspectionState.place(patch, 'grab');
      if (manual) gesturePivot.commit({ token: owner, source: sourceRecord, subject: visibleStage,
        previousPlacement: current, placement: inspectionState.placement() });
      else if (focusPivot) gesturePivot.rememberFocus({ ...focusPivot, placement: inspectionState.placement() });
      grabRotation = undefined; grabScale = 1; grabOffset = undefined;
      applyInspectionTransform();
    }, { allowInteraction: true, inputLifecycle }).catch(error => {
      if (error?.code === 'xr_input_ended' || error?.code === 'appearance_cancelled') { discardOwnTransient(); syncInspectionPayload(); return false; }
      if (sourceRecord === sourceAtStart && state.generation === generationAtStart) {
        invalidateGesturePivot(); inspectionState.restoreCheckpoint(checkpoint);
      }
      throw error;
    }).then(async result => {
      if (result === false || inputLifecycle?.ended) return false;
      syncInspectionPayload();
      recordManipulation('xr-grab', { event: 'placed', ...summary, scale: patch.scale, translation: patch.translation });
      // The wearer just said where this goes. A framing move
      // bakes through the same path (`gesture: 'focus'`) and is not a takeover;
      // everything else here is a hand, a stick or a spoken nudge.
      if (summary?.gesture !== 'focus') takeWearerPlacement(summary?.gesture ?? summary?.phase ?? 'grab', summary);
      // mutate has cleared the transient, recorded history and observed the
      // saved frame. Follow-up geometry work must not keep input gated.
      const followup = startXrPlacementFollowup(summary, inputLifecycle, Math.max(0, now() - began));
      // Explicit focus/voice callers keep their established completion contract.
      if (!inputLifecycle) await followup;
      return true;
    });
  }

  /**
   * Open the full Mol* viewer where the wearer is looking.
   *
   * The page never opens a browser itself: it asks the host, which owns the
   * `open_detailed_view` route. A host that serves the viewer to this origin
   * answers with a same-origin address, and the caller ends the session and
   * navigates there. A host that cannot answers whether its own Mac browser
   * opened, and the caption repeats that instead of leaving the wearer waiting
   * for a window that will not appear.
   */
  async function openDetailedViewOnHost({ preferHere = true } = {}) {
    try {
      // `preferHere` false is the wearer asking for the Mac by
      // name. The host skips its same-origin probe and opens there.
      const result = await onOpenWorkbench({ immersive: true, ...(preferHere ? {} : { target: 'mac' }) });
      // The caption is shortened for the plate; the reason travels whole, so
      // the diagnostics record keeps the sentence the host actually gave.
      if (result?.opened === false) {
        const reason = result.reason ?? result.message;
        return { opened: false, here: false, caption: workbenchFailureCaption(reason), ...(reason ? { error: reason } : {}) };
      }
      if (typeof result?.headsetUrl === 'string' && result.headsetUrl.startsWith('/'))
        // `onStayed` is the host's own undo for a handoff that never left: it
        // marked this page as leaving for Mol* before the teardown was tried.
        return { opened: true, here: true, headsetUrl: result.headsetUrl, caption: HEADSET_WORKBENCH_CAPTION,
          ...(typeof result.onStayed === 'function' ? { onStayed: result.onStayed } : {}) };
      return { opened: true, here: false, caption: WORKBENCH_OPENED_CAPTION };
    } catch (error) {
      return { opened: false, here: false, caption: workbenchFailureCaption(error?.message), error: error?.message };
    }
  }

  /** The live input source for one hand, for haptics the pointers do not carry. */
  function xrInputSourceFor(handedness) {
    try {
      for (const source of canvas.webgl.xr?.session?.inputSources ?? []) {
        if (source.handedness === handedness) return source;
      }
    } catch { /* The session can end between two frames. */ }
    return undefined;
  }

  /**
   * Start the grip gesture for one immersive session.
   *
   * `isClaimed` is the menu's own claim, so a press that lands on a toolbar
   * plate never also becomes a grab. Nothing else claims a grip any more:
   * push-to-talk no longer uses the left grip, so either grip alone grabs
   * and the second grip joining is the scale.
   */
  /**
   * The room's up and the wearer's own right and forward, as unit
   * vectors in the space the pointer rays and `applyGrabDelta` use.
   *
   * `camera.view` is what Mol* maps the XR reference space through:
   * `xr-manager.js:27-36` builds every pointer ray in the room and then
   * transforms it by `inverse(camera.view)`. So the inverse of the view is
   * room-to-render, its second column is the room's own up axis in render
   * space, and it does not tilt when the wearer looks down at the desk. Its
   * first column is the room's X axis, which is a fixed compass direction and
   * not the wearer's right at all — pushing the stick right used to move the
   * structure the same way whichever way the wearer had turned.
   *
   * The head used to come from `camera.headRotation`, which
   * `head-rotation-lock.mjs` now holds at zero for the whole session so the
   * menu is not mirrored. The reader's "before the first XR frame that matrix
   * is all zeros" guard (`camera.js:213`) then matched on every frame and the
   * sticks silently fell back to room axes. `latestRoomPlacementPose.headInRoom`
   * is the same room-space head matrix, sampled in `onHeadFrame` straight from
   * `frame.getViewerPose(space)` and untouched by the lock. The arithmetic is
   * in `wearer-axes.mjs` so a lab test can hold it.
   */
  function wearerAxes() {
    const { right, up, forward } = wearerAxesFrom({
      roomToRender: Mat4.invert(Mat4(), canvas.camera.view),
      headInRoom: xrInputHeadInRoom ?? latestRoomPlacementPose?.headInRoom,
    });
    return { right: Vec3.create(...right), up: Vec3.create(...up), forward: Vec3.create(...forward) };
  }

  /** One frame of stick travel along one of the wearer's axes. */
  function applyStickAxis(axis, metres) {
    if (!Number.isFinite(metres) || metres === 0) return;
    return applyGrabDelta({ translation: [axis[0] * metres, axis[1] * metres, axis[2] * metres] });
  }

  /**
   * The right stick, moving the structure sideways and up and down.
   *
   * "Up" is the room's up, so pushing the stick forward lifts the structure
   * whatever the wearer is looking at. This is the coarse way to move the
   * structure through the room; the grab is the fine control.
   */
  function applyStickTravel({ x, y, seconds }) {
    if (!Number.isFinite(seconds)) return;
    const axes = wearerAxes(), metres = STICK_METRES_PER_SECOND * seconds;
    applyStickAxis(axes.right, x * metres);
    applyStickAxis(axes.up, y * metres);
  }

  /**
   * The left stick, pushing the structure away and yawing it.
   *
   * Forward pushes it away along the wearer's own level forward direction, and
   * sideways turns it about the room's vertical axis through its own centre.
   * The yaw is negated because a right-handed turn about up is counterclockwise
   * seen from above, and a stick pushed right should swing the structure's near
   * face to the right.
   */
  function applyStickPush({ x, y, seconds }, hand) {
    if (!Number.isFinite(seconds)) return;
    const axes = wearerAxes();
    const metres = y * STICK_METRES_PER_SECOND * seconds;
    const applied = applyStickAxis(axes.forward, metres);
    if (applied) xrManipulation?.offsetRayAnchor?.(hand, applied);
    const degrees = -x * STICK_DEGREES_PER_SECOND * seconds;
    if (degrees === 0) return;
    // `grabTransform` composes this about the origin between the two centroid
    // translations, so it turns the structure about its own centre.
    applyGrabDelta({ rotation: Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, axes.up) });
  }

  /**
   * One hand's stick, under whatever modifier that hand holds.
   *
   * Both hands run this: either controller alone does every motion, so the
   * headset can be driven one-handed. The way to give one hand every motion is
   * to let a finger that is not the thumb say which motion the thumb is making.
   * `xr-locomotion.mjs` owns that decision, this owns the metres.
   */
  function applyStickForHand(hand, deflection) {
    if (xrInputBlind || xrDeferredBake) return;
    const mode = stickModifiers?.mode(hand) ?? STICK_MODE.slide;
    if (mode === STICK_MODE.inert) return;
    if (mode === STICK_MODE.depthYaw) { applyStickPush(triggerStickIntent?.filter(hand, deflection) ?? deflection, hand); return; }
    if (mode === STICK_MODE.scale) {
      const factor = oneHandScaleFactor(deflection.y, deflection.seconds);
      if (factor !== 1) applyGrabDelta({ scale: factor });
      return;
    }
    applyStickTravel(deflection);
  }

  /**
   * Put the structure back on the seat the wearer got on entry.
   *
   * This cannot go through `placeRoomTarget`. That path ends in a mutation
   * that refuses to run while a controller button is held, and a face button
   * is held for as long as the thumb is on it, so B would fail every time it
   * was pressed. The grab's own bake solved the same problem the same way, by
   * admitting live interaction, and the placement itself is identical.
   */
  async function seatStructureForEntry({ resetMenu = false, bounded = false, chapter = false } = {}) {
    const assertPlacementIdle = () => {
      // Fit and Reset replace the saved pose. An unbaked hand/stick delta must
      // never be applied over that new seat, including a released pending save.
      if (xrManipulation && xrManipulation.phase() !== 'idle'
        || xrThumbstick?.moving() || xrPushStick?.moving() || xrDeferredGrab || xrDeferredBake
        || grabRotation || grabScale !== 1 || grabOffset) {
        const error = Error('Let go of it first.');
        if (resetMenu) {
          recordManipulation('xr-button', { action: 'recenter-structure', outcome: 'held', phase: xrManipulation?.phase() ?? 'stick' });
          showHeadsetCaption('Let go to recentre');
          talkCaption?.set({ outcome: 'Let go first' });
          error.resetReported = true;
        }
        throw error;
      }
    };
    assertPlacementIdle();
    if (typeof supersedePlacementFit === 'function') await supersedePlacementFit();
    assertReady();
    if (!canvas.xr.isPresenting.value || performance.now() - latestHeadSample >= 1500 || !latestRoomPlacementPose) {
      throw Error('Enter VR and wait for tracking before recentring the structure.');
    }
    // Reset/Fit is recovery from a lost view. A cutaway's old near plane can
    // lie beyond every seat the room allows; remove it before measuring.
    if (inspectionSnapshot().appearance?.clipping > 0 && typeof configureInspection === 'function') {
      await configureInspection({ clipping: 0 }, { preservePlacement: true });
      if (typeof awaitPlacementViews === 'function') await awaitPlacementViews();
    }
    const sphere = loadedSphere();
    let seat;
    try { seat = roomAnchorPlacement({ mode: 'auto', floorY: roomAnchor?.floorY() ?? null, sphere, resetMenu, bounded }); }
    catch (error) {
      if (resetMenu) {
        const text = error?.message ?? String(error);
        talkCaption?.set({ outcome: text, holdMs: 6000, complete: true });
        recordManipulation('outcome', { status: 'refused', action: 'reset', reason: text });
        error.resetReported = true;
      }
      throw error;
    }
    const menuRecovery = typeof applySeatMenuRecovery === 'function' ? await applySeatMenuRecovery(seat) : undefined;
    const wasHidden = typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden;
    const checkpoint = inspectionState.checkpoint();
    try {
      if (!wasHidden) await setInspectionMotion({ paused: true });
      assertPlacementIdle();
      await mutate('inspection', () => {
        syncInspectionPayload();
        inspectionState.place({ translation: seat.translation, scale: seat.scale,
          ...(resetMenu ? { rotation: seat.rotation } : {}) }, 'entry-seat');
        applyInspectionTransform();
        if (typeof showRetainedPose === 'function') showRetainedPose(true);
      }, { allowInteraction: true });
    } catch (error) {
      inspectionState.restoreCheckpoint(checkpoint);
      await menuRecovery?.rollback?.();
      throw error;
    }
    // Reset is an explicit stop, even when its mutation retained a wearer
    // placement or came from an agent. Bake the chapter's separate timer too.
    if (resetMenu && typeof spatialTour !== 'undefined') {
      const player = spatialTour?.current?.() ?? spatialTour;
      player?.stop?.('View reset.', { restoreResting: false, preserveScene: true });
    }
    if (wasHidden) await setInspectionMotion({ paused: true });
    syncInspectionPayload();
    notePlacement(inspectionSnapshot().placement, resetMenu ? 'reset' : 'fit');
    recordManipulation(chapter ? 'chapter-entry-seat' : 'xr-button', { action: 'recenter-structure', mode: seat.mode,
      metersAcross: Math.round(seat.metersAcross * 100) / 100, scale: seat.scale });
    // Reset view is the wearer handing the seat back. The lesson
    // may frame again from here, and an authored placement may land again.
    // A chapter's seat is the lesson's, like a swap's: no wearer gave it.
    if (!chapter) releaseWearerPlacement('reset-view');
    void roomAnchor?.applied({ roomPoint: seat.roomPoint, wearerRequested: !chapter })?.catch?.(() => {});
    return seat;
  }

  /**
   * A different structure takes the seat entering VR would give it.
   *
   * The transition anchor keeps the outgoing structure's room centre and
   * diameter. That suits a lesson tier growing in place, but an agent's swap to
   * another structure inherited whatever the wearer had zoomed to: after a
   * focus on 4HHB's hemes, 1CRN arrived at about twice the size its entry
   * seat gives it, across the menu. The anchor still chooses the scene scale;
   * the seat comes from `roomAnchorPlacement`, the rule `settleInRoom` applies
   * on entry, so the size and the menu clearance are a fresh load's. The seat
   * is solved before the first frame is drawn. When the tracked pose is
   * missing, or the anchor's scene-scale change has made it stale,
   * `settleInRoom` seats the structure on the next tracked frame, with its own
   * refusal handling.
   */
  function seatSwappedSource(anchor, { deferAnchor = false } = {}) {
    const record = detail => {
      try { globalThis.__stereofoldDiagnostics?.record?.('source-anchor', detail); } catch { /* Advisory. */ }
    };
    const tracked = latestRoomPlacementPose && performance.now() - latestHeadSample < 1500;
    let reason = !tracked ? 'no fresh tracked pose'
      : anchor.usedCameraScale || anchor.cameraOffset ? 'scene scale changed' : null;
    if (!reason) {
      try {
        // The seat measures the drawn geometry from its current transform.
        applyInspectionTransform();
        const seat = roomAnchorPlacement({ mode: 'auto', floorY: roomAnchor?.floorY() ?? null, sphere: loadedSphere() });
        inspectionState.place({ translation: seat.translation, scale: seat.scale }, 'entry-seat');
        // As after Fit, the room anchor measures drift from this seat.
        if (!deferAnchor) void roomAnchor?.applied({ roomPoint: seat.roomPoint })?.catch?.(() => {});
        record({ anchor: 'entry-seat', anchoredScale: anchor.placement.scale, scale: seat.scale,
          metersAcross: Math.round(seat.metersAcross * 100) / 100 });
        return seat;
      } catch (error) {
        // `settleInRoom` retries a refused seat and tells the wearer.
        reason = error?.message ?? String(error);
      }
    }
    pendingRoomSeat = true;
    record({ anchor: 'entry-seat-next-frame', reason });
    return undefined;
  }

  /**
   * Show or hide the wearer's own room behind the structure.
   *
   * Only an `alpha-blend` session has a room to show. Mol* decides that at
   * entry: an `immersive-ar` session gets the transparent clear and an
   * `immersive-vr` session gets an opaque one, and no prop set from this page
   * survives the frame, because `canvas3d.js:503` writes Mol*'s own flag over
   * `transparentBackground` on every XR frame. `firePassthroughToggle` is the
   * only route to that flag, and `xrManagerAttribs` keeps the binding it needs
   * alive on a key code no controller sends.
   *
   * Inside that `alpha-blend` session both directions are the same
   * clear. The compositor shows the camera through the frame's alpha, so an
   * opaque clear hides the room as completely as an opaque session would, and
   * the wearer stays in immersion for it. That matters because leaving is the
   * expensive half: Quest Browser grants no transient activation inside a
   * session, so a wearer dropped to the 2D page needs a real trigger press to
   * get back, which makes getting into plain VR too hard. Nothing about hiding
   * the room ends a session any more.
   *
   * The one ask that still crosses sessions is the reverse: a plain
   * `immersive-vr` session has no camera feed, so a wearer in one who asks for
   * their room needs `immersive-ar`. `switchMode` ends and re-requests in one
   * step and says whether the re-entry landed; when it cannot,
   * `announceEntryFallback` names the single press that will.
   *
   * @param {boolean} on whether the room should be visible
   */
  async function setPassthrough(on) {
    if (!canvas.xr.isPresenting.value) throw Error('Enter VR before switching passthrough.');
    let blend = immersiveSession?.environmentBlendMode?.() ?? null;
    let plan = passthroughPlan({ blendMode: blend, passthroughOn, on });
    let switched;
    if (plan.action === 'switch') {
      const result = await switchImmersiveMode(plan.mode, Boolean(on));
      if (!result?.switched) {
        // The headset may need another physical press to finish AR entry.
        // That entry must honor this Room-on ask, not restore an older off.
        if (result?.pending) {
          preferredPassthrough = Boolean(on);
          storePassthroughPreference(preferredPassthrough);
        }
        return result;
      }
      switched = result;
      blend = immersiveSession?.environmentBlendMode?.() ?? null;
      plan = passthroughPlan({ blendMode: blend, passthroughOn, on });
      // An accepted AR session can still have an opaque/additive blend.
      // Do not recursively request the same session when it has no room feed.
      if (plan.action === 'switch') {
        recordManipulation('passthrough', { mode: blend, requested: on, outcome: 'unsupported', reason: 'blend-mode' });
        return { ...result, passthrough: false, mode: blend, unsupported: true };
      }
    }
    if (plan.action === 'unchanged') {
      preferredPassthrough = Boolean(on);
      storePassthroughPreference(preferredPassthrough);
      recordManipulation('passthrough', { mode: blend, requested: on, outcome: 'unchanged' });
      return { ...switched, passthrough: Boolean(on), mode: blend };
    }
    // The session is already the one with a camera behind it, so both
    // directions are the clear Mol* owns. Flipping it is free; a session is not.
    if (!firePassthroughToggle(canvas.input)) {
      recordManipulation('passthrough', { mode: blend, requested: on, outcome: 'no-input' });
      throw Error('Passthrough is unavailable in this session.');
    }
    passthroughOn = Boolean(on);
    preferredPassthrough = passthroughOn;
    storePassthroughPreference(preferredPassthrough);
    canvas.requestDraw?.(true);
    // The whole view just changed and the wearer is still in it, so say which
    // way it went. A menu press has only the row re-label otherwise, and the
    // wearer who asked for the room to go dark needs to read that it was the
    // ask that did it rather than a tracking loss.
    try { talkCaption?.set({ outcome: on ? 'Room shown.' : 'Room hidden.' }); }
    catch { /* Best effort; the clear already flipped. */ }
    recordManipulation('passthrough', { mode: blend, requested: on, outcome: 'applied' });
    void immersiveSession?.refreshToolbar?.()?.catch?.(() => {});
    return { ...switched, passthrough: Boolean(on), mode: blend };
  }

  /**
   * Cross from one blend mode to the other, or say what to press.
   *
   * The caption goes up before the teardown, because the wearer is about to
   * watch immersion drop away and the one thing that keeps that from reading as
   * a crash is knowing it was asked for. Nothing here throws for a refused
   * re-entry: a wearer who has just landed on the 2D page needs an instruction,
   * not an exception, and the instruction is spoken as well as captioned
   * because on the page there is no headset caption left to read.
   *
   * @param {'immersive-ar'|'immersive-vr'} mode the session to go to
   * @param {boolean} wantRoom whether that mode is the one with the room in it
   */
  async function switchImmersiveMode(mode, wantRoom) {
    if (!immersiveSession?.switchMode) throw Error('Headset entry is not ready.');
    const stayInVr = result => {
      const line = 'This headset cannot show your room. Staying in VR.';
      try { showHeadsetCaption(line); } catch { /* The live session is still the useful result. */ }
      try { talkCaption?.set({ outcome: line }); } catch { /* Same best-effort caption path. */ }
      try { void voiceCommandSpeaker()?.(line)?.catch?.(() => {}); } catch { /* Speech is optional. */ }
      recordManipulation('passthrough', { requested: wantRoom, outcome: 'unsupported', target: mode,
        reason: result?.reason ?? 'unsupported', retained: result?.retained === true });
      void immersiveSession.refreshToolbar?.()?.catch?.(() => {});
      return { passthrough: false, mode: result?.blendMode ?? immersiveSession.environmentBlendMode?.() ?? null,
        switched: false, retained: true, unsupported: true };
    };
    // Check before the notice because an unsupported press does not switch.
    // `switchMode` repeats this guard at the session boundary for every caller.
    if (mode === 'immersive-ar') await immersiveSession.capabilities?.();
    if (mode === 'immersive-ar' && immersiveSession.passthroughSupported?.() !== true) {
      const result = await immersiveSession.switchMode(mode);
      return stayInVr(result);
    }
    const notice = wantRoom ? 'Showing your room…' : 'Hiding your room…';
    showHeadsetCaption(notice);
    talkCaption?.set({ notice });
    recordManipulation('passthrough', { requested: wantRoom, outcome: 'switching', target: mode });
    const result = await immersiveSession.switchMode(mode);
    if (result?.retained) return stayInVr(result);
    if (result?.entered) {
      // The new session seeds its own mirror from its own blend mode in
      // `beginXrManipulation`, so nothing here has to guess at it.
      recordManipulation('passthrough', { requested: wantRoom, outcome: 'switched', mode: result.blendMode ?? null,
        activation: result.activation ?? null });
      return { passthrough: wantRoom, mode: result.blendMode ?? null, switched: true };
    }
    announceEntryFallback(mode);
    recordManipulation('passthrough', { requested: wantRoom, outcome: 'needs-press', target: mode,
      reason: result?.reason ?? 'failed', activation: result?.activation ?? null });
    return { passthrough: wantRoom, mode: null, switched: false, pending: mode };
  }

  /**
   * Tell the wearer, out loud, which press finishes the switch.
   *
   * Speech is the only channel that still reaches a wearer who has left
   * immersion: the headset caption draws in a presentation layer that no longer
   * exists, and the page is a flat panel they are holding a controller at. The
   * page draws the button itself off `startup().pendingEntry`; this is the half
   * that says it is there. Both are best-effort — a page with no narration slot
   * still gets the button, which is the part that actually does the work.
   */
  function announceEntryFallback(mode) {
    const copy = entryFallbackCopy(mode);
    try { showHeadsetCaption(copy.caption); } catch { /* The presentation layer left with the session. */ }
    try { talkCaption?.set({ outcome: copy.caption }); } catch { /* Same layer, same reason. */ }
    try { void voiceCommandSpeaker()?.(copy.caption)?.catch?.(() => {}); }
    catch { /* A page that registered no speaker still shows the button. */ }
  }

  /**
   * One refusal the wearer can see and hear.
   *
   * A control that declines has to say so. A refused stick click or grip that
   * says nothing is how a working control map reads as a dead controller. The
   * caption is the line in front of the wearer's eyes and expires by itself;
   * the spoken half is two words, because a wearer standing still for a
   * sentence is the other failure.
   *
   * Both halves are best-effort: a page with no presentation layer still runs
   * the control, and a page with no narration slot still shows the caption.
   */
  function speakOutcome(caption, spoken = caption) {
    try { talkCaption?.set({ outcome: caption }); } catch { /* The layer left with the session. */ }
    try { void voiceCommandSpeaker()?.(spoken)?.catch?.(() => {}); }
    catch { /* A page that registered no speaker still shows the caption. */ }
  }

  /**
   * What a face button does.
   *
   * The menu goes through the surface that already owns it, so pressing B is
   * the same action as pressing the Menu row. Nothing here reimplements it.
   *
   * `push-to-talk` arrives twice, `down` when the thumb has been on A or X for
   * `TALK_MIN_HOLD_MS` and `up` when it comes off, and both go to the binding
   * the immersive session registered. A page with no immersive session has no
   * binding, and the press is a named failure rather than silence.
   */
  async function runFaceAction(action, binding, phase) {
    if (action === 'push-to-talk') {
      const talk = pushToTalkBinding();
      // The caption goes up before the microphone is asked for,
      // because a wearer who holds A and sees nothing concludes A is dead. That
      // is exactly what happened in a device test. It never carries
      // the wearer's own words. One wearer, after the headset read their
      // sentence back to them: "why'd you just repeat what I said? That's kind
      // of annoying."
      if (phase === 'up' && !talk?.listening()) {
        talkCaption?.set({ talking: false, sending: false, outcome: 'Voice unavailable. Use the menu controls instead.' });
        return;
      }
      if (phase === 'up') talkCaption?.set({ talking: false, sending: true });
      else talkCaption?.set({ talking: true, sending: false, outcome: '' });
      if (!talk) { talkCaption?.set({ talking: false, sending: false, outcome: 'Voice is not ready' }); throw Error('Voice is not ready.'); }
      return phase === 'up' ? talk.stop() : talk.start();
    }
    // An upper face button held past `HOLD_HINT_MS` captions the
    // reset it is about to do, so a wearer who meant to tap the menu can let go
    // before it fires. `abort` is that release; `hold` is the 500 ms commit.
    if (action === 'recenter-structure' && phase === 'hint') { talkCaption?.set({ notice: 'Hold to reset…' }); return; }
    if (action === 'recenter-structure' && phase === 'abort') { talkCaption?.set({ notice: '' }); return; }
    // The band between a tap and a reset. A thumb that came off
    // at 400 ms used to hide the menu, which is the opposite of what a wearer
    // reaching for a reset wants. Now it does nothing but say what to do next,
    // as an outcome so the line expires on its own. The notice goes with it, or
    // "Hold to reset…" would sit over the answer.
    if (action === 'recenter-structure' && phase === 'short-hold') {
      talkCaption?.set({ notice: '', outcome: 'Hold longer to reset.' });
      return;
    }
    // The stick click this refused. A Touch stick clicks
    // off-axis under a push, so a click made on a stick the thumb is steering
    // is dropped rather than resetting a view the wearer was sliding. A drop
    // that leaves only a log line reads as "the button does nothing", which is
    // the complaint this whole control map exists to answer. So the refusal
    // answers itself, in the two-word style the spoken replies use, and the
    // caption names the fix rather than the fault.
    if (phase === 'refused') {
      speakOutcome('Centre the stick, click again.', 'Centre stick.');
      return;
    }
    if (action === 'menu') {
      const collapsed = immersiveSession?.isMenuCollapsed?.() ?? true;
      // The toolbar owns folding AND re-seating for its rows and face buttons.
      await immersiveSession?.toolbarAction?.({ kind: 'collapse', value: !collapsed });
      // Either way the menu comes back beside the wearer, on the head pose
      // they have now. The compact menu is still a visible panel, so folding
      // the grid down while its seat stayed on a pose the wearer had walked
      // away from left them exactly where they were: behind the menu, with no
      // way to tell where they are.
      // This press is the wearer asking for the menu, and the answer to that
      // is always the menu in front of them.
      return;
    }
    if (action === 'recenter-structure') {
      try {
        // The menu and molecule share a successful Reset. Re-seating the
        // glass before admission made a refused Reset look like a menu-only
        // reset. Keep its seat until the molecular placement has committed.
        talkCaption?.set({ notice: '' });
        // The upper face buttons and the stick click sit next to the grip on the
        // same hand, so a wearer holding the structure can reach them by accident.
        // The seat writes a placement, and the grab transient sitting on top of
        // it would then be added to the new seat when the grip came up: the
        // structure would land on the seat and immediately jump off it by the
        // grab's accumulated delta. Let go first. The record says why, because
        // a button that does nothing is the complaint this map exists to fix.
        // This refusal has to reach the caller, not just the menu.
        // Returning normally told the voice runner the seat had happened, and it
        // spoke "Putting it back in front of you." over a structure still in the
        // wearer's hand. That is the same defect again by another route: the one
        // thing a confirmation must never do is confirm nothing.
        if (xrManipulation && xrManipulation.phase() !== 'idle') {
          recordManipulation('xr-button', { action: 'recenter-structure', outcome: 'held', phase: xrManipulation.phase() });
          showHeadsetCaption('Let go to recentre');
          talkCaption?.set({ outcome: 'Let go first' });
          throw Error('Let go of it first.');
        }
        const seat = await seatStructureForEntry({ resetMenu: true });
        // The owner, after the 23:00Z pass: "resetting the view
        // should also reset the menu on the side so I can see that one again
        // too". A reset is the wearer saying they are lost, and a menu still
        // seated on a pose they walked away from keeps them lost. Re-seat it on
        // the pose they have now, shown, so the reset leaves nothing to find.
        // A menu that cannot re-seat must not turn a finished reset into a
        // failure, so its outcome is recorded and swallowed.
        // Await the redraw itself. toolbarAction queues work and returns
        // nothing; that used to let receipt capture race menu clearance, which
        // can still be mutating the molecular placement after Reset returns.
        // A direct update also works inside the toolbar's own Reset action
        // without waiting on that same action chain.
        let menuReseated = seat.menuRecovery !== true;
        try {
          if (seat.menuRelocation === undefined)
            await immersiveSession?.refreshToolbar?.({ resetMenu: true, recenter: true, origin: 'wearer' });
        } catch (error) {
          menuReseated = false;
          recordManipulation('xr-button', { action: 'recenter-structure', menu: 'not re-seated', reason: String(error?.message ?? error) });
        }
        talkCaption?.set({ outcome: seat.menuRecovery ? 'View reset. Controls hidden; B/Y brings them back.'
          : menuReseated ? 'View reset.' : 'View reset. The menu did not move.' });
        return { ...seat, structureReset: true, menuReseated };
      } catch (error) {
        const text = error?.message ?? String(error);
        if (!error?.resetReported) {
          showHeadsetCaption(text);
          talkCaption?.set({ notice: '', outcome: text, holdMs: 6000, complete: true });
          recordManipulation('outcome', { status: 'refused', action: 'reset', reason: text });
        }
        throw error;
      }
    }
    if (action === 'repeat-reply') {
      if (typeof voiceInteraction?.repeatLastReply !== 'function') throw Error('Nothing has been said yet.');
      return voiceInteraction.repeatLastReply();
    }
    if (action === 'tour-play') {
      if (!spatialTour?.togglePlay) throw Error('Tours are not ready.');
      return spatialTour.togglePlay();
    }
    throw Error(`Unknown controller action ${action}.`);
  }

  function xrRenderPose(pose) {
    const renderFromRoom = Mat4.invert(Mat4(), canvas.camera.view);
    const matrix = Mat4.mul(Mat4(), renderFromRoom, Mat4.fromArray(Mat4(), pose.matrix, 0));
    const { position, quaternion } = Mat4.getDecomposition(matrix);
    return { ...pose, origin: Array.from(position), direction: [-matrix[8], -matrix[9], -matrix[10]],
      orientation: Array.from(quaternion) };
  }

  function gripTargetDepthAxis() {
    const pose = latestRoomPlacementPose;
    const headInRoom = xrInputHeadInRoom ?? pose?.headInRoom;
    if ((!xrInputHeadInRoom && (!Number.isFinite(latestHeadSample) || performance.now() - latestHeadSample >= 1500))
      || headInRoom?.length !== 16 || !headInRoom.slice(12, 15).every(Number.isFinite)) return undefined;
    const sphere = visibleStage && sourceRecord?.catalog
      ? catalogVisibleBounds(sourceRecord.catalog, visibleStage) ?? loadedSphere() : loadedSphere();
    if (!sphere) return undefined;
    const center = Vec3.transformMat4(Vec3(), sphere.center, presentationTransform());
    Vec3.scale(center, center, canvas.camera.scale || 1);
    // Match xrRenderPose: room/head positions already have metre units, while
    // the molecular coordinates need the camera scale before comparing them.
    const head = Vec3.transformMat4(Vec3(), Vec3.create(...headInRoom.slice(12, 15)),
      Mat4.invert(Mat4(), canvas.camera.view));
    return Array.from(Vec3.sub(Vec3(), center, head));
  }

  /** Observe native presentation edges without exposing the canvas. */
  function onPresentationChange(listener) {
    if (typeof listener !== 'function') throw TypeError('A presentation listener is required.');
    if (state.status === 'disposed') return () => {};
    let previous = canvas.xr.isPresenting.value;
    const subscription = canvas.xr.isPresenting.subscribe(presenting => {
      if (state.status === 'disposed' || presenting === previous) return;
      previous = presenting;
      try { listener(presenting); } catch (error) { console.error(error); }
    });
    interactionSubscriptions.push(subscription);
    return () => {
      subscription.unsubscribe();
      const index = interactionSubscriptions.indexOf(subscription);
      if (index >= 0) interactionSubscriptions.splice(index, 1);
    };
  }

  function beginXrManipulation() {
    if (!enableXr) {
      recordManipulation('xr-grab', { event: 'rejected', reason: GRAB_REJECTED.xrDisabled });
      return;
    }
    xrInputLifecycle = createXrPlacementLifecycle();
    xrInputLifecycle.setBlind(xrInputBlind);
    // Entry starts a new room frame. Wait for its pose before drawing any reply.
    latestRoomPlacementPose = null;
    tuneXrLocomotion(true);
    // Mol* resets its clear on every entry. Reapply the wearer's Room off
    // choice before the first immersive draw instead of silently showing it.
    const blendMode = immersiveSession?.environmentBlendMode?.() ?? null;
    const roomEntry = restorePassthroughOnEntry({ blendMode, preferred: preferredPassthrough,
      toggle: () => firePassthroughToggle(canvas.input) });
    passthroughOn = roomEntry.on;
    recordManipulation('passthrough', { mode: blendMode, outcome: roomEntry.failed ? 'entry-restore-failed' : 'entry',
      on: passthroughOn, restored: roomEntry.restored });
    // The caption that answers "what did that button just do?".
    // It is seated from the room pose the head observer already samples, so it
    // costs no extra frame callback, and it fails soft: a page whose
    // presentation layer is not up yet gets no caption, not a broken session.
    try {
      const presentation = immersiveSession?.presentation?.();
      talkCaption = presentation ? createTalkCaption({ plugin, presentation, record: recordManipulation,
        getTourState: () => spatialTour?.getPresentationState?.() ?? spatialTour?.getState?.(),
        menuPoints: () => immersiveSession?.menuPoints?.() ?? [],
        menuPlates: () => immersiveSession?.glassPlates?.() ?? [],
        clearance: replyCardClearance,
        captionColumn: () => immersiveSession?.captionColumn?.() ?? null,
        viewsAvailable: () => (latestRoomPlacementPose?.labelViews?.length === 2 || (latestRoomPlacementPose?.labelViews?.length === 1 && latestRoomPlacementPose?.labelViews[0]?.eye === 'none')),
        head: () => {
          const matrix = latestRoomPlacementPose?.headInRoom;
          return matrix ? { matrix, position: { x: matrix[12], y: matrix[13], z: matrix[14] } } : undefined;
        } }) : undefined;
      setTalkOutcomeSink(talkCaption ? (text, holdMs, complete, onSeat) => talkCaption?.set({ outcome: text, holdMs, complete, onSeat }) : undefined);
      setTalkProgressSink(talkCaption ? state => talkCaption?.set(state) : undefined);
      // The Talk row is the wearer's only reading of the link.
      //
      // Nothing repainted the menu on a connection edge except the connection
      // subscriber's `showHeadsetCaption('')`, and that writes nothing unless
      // push-to-talk has registered its caption sink. A session whose
      // microphone never attached therefore read `Talk` through a dead Mac.
      // The menu is redrawn from the same state the caption reads, on the edge
      // itself, and the redraw is advisory: a failed one costs the row, not the
      // session.
      detachConnectionMenu?.();
      detachConnectionMenu = subscribeConnectionStatus(() => {
        try { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); } catch { /* Session teardown. */ }
      });
    } catch (error) { recordManipulation('talk-caption', { outcome: 'failed', error: error?.message }); }
    xrControllerInput = createXrControllerInput({
      transformPose: xrRenderPose,
      record: recordManipulation,
    });
    triggerStickIntent = createTriggerStickIntent({
      isBlocked: hand => spatialOwnedHands.has(hand) || xrManipulation?.requiresRelease?.(hand)
        || (!xrManipulation?.triggerOwns?.(hand) && immersiveSession?.isRayOnMenu?.(hand) === true),
      gripHeld: hand => xrManipulation?.gripHeld?.(hand) === true,
    });
    const grabFeedback = createXrGrabFeedback({
      readState: () => ({ status: appearanceWork && !chapterInteractionDepth && GRABBABLE_STATUS.has(state.status) ? 'updating' : state.status, error: state.error, contextLost: canvas.webgl.isContextLost }),
      speak: speakOutcome, record: recordManipulation,
    });
    xrManipulation = createXrManipulation({
      triggerStickOwnsMotion: hand => triggerStickIntent?.suppressRayMotion(hand) === true,
      isClaimed: hand => spatialOwnedHands.has(hand),
      isRayOnMenu: hand => immersiveSession?.isRayOnMenu?.(hand) === true,
      gripDepthAxis: gripTargetDepthAxis,
      triggerTargetDistance: pointer => {
        // Target the drawn molecule's envelope once per press. This broad
        // affordance also lets the wearer grab a ribbon through its gaps.
        const sphere = visibleStage && sourceRecord?.catalog
          ? catalogVisibleBounds(sourceRecord.catalog, visibleStage) ?? loadedSphere() : loadedSphere();
        if (!sphere) return undefined;
        const center = Vec3.transformMat4(Vec3(), sphere.center, presentationTransform());
        const scale = canvas.camera.scale || 1;
        Vec3.scale(center, center, scale);
        return moleculeGrabDistance(pointer.ray, { center: Array.from(center),
          radius: sphere.radius * inspectionSnapshot().placement.scale * grabScale * scale });
      },
      canManipulate: () => canManipulateNow(),
      // Explain a terminal renderer fault once; loading can still admit the
      // held grab automatically when its frame becomes ready.
      onGrabRefused: grabFeedback.refuse,
      // A grab owns placement immediately. Authored camera motion yields to
      // the hand; molecular playback and chapters continue.
      onGrabStart: () => { grabFeedback.admitted(); cancelXrPlacementFollowup(); beginGesturePivot(); talkCaption?.set({ holding: true }); signalManualInteraction('xr-grab'); void pausePresentationForInput('grab-pause', { allowInteraction: true }).catch(error => console.error(error)); }, // The menu remains available while the caption confirms the grab.
      onDelta: applyGrabDelta,
      onGrabEnd: summary => { talkCaption?.set({ holding: false });
        xrDeferredGrab = summary; flushXrDeferredGrab(); }, // And comes back on release.
    });
    xrButtons = createXrButtons({
      run: (action, binding, phase) => {
        // Record wearer intent before Reset/menu work can yield. The shared
        // runFaceAction also serves remote recentering, which is not a local edit.
        onLocalEdit();
        return runFaceAction(action, binding, phase);
      },
      pulse: pulseController,
      record: recordManipulation,
      sourceFor: hand => xrInputSourceFor(hand),
    });
    // Which hand's ray is on the menu, so a trigger pressed
    // there stays a select and never becomes the stick modifier.
    stickModifiers = createStickModifiers({
      // The toolbar's own per-frame ray test, not select ownership: ownership is
      // set on select-start, so on the frame the trigger goes down it is still
      // empty and every press aimed at a row also latched the depth modifier.
      isRayOnMenu: hand => immersiveSession?.isRayOnMenu?.(hand) === true || spatialOwnedHands.has(hand),
      gripHeld: hand => xrManipulation?.gripHeld?.(hand) === true,
      scaleActive: () => xrManipulation?.phase?.() === 'scale',
      triggerOwned: hand => xrManipulation?.triggerOwns?.(hand) === true,
      triggerDragging: hand => xrManipulation?.triggerPhase?.(hand) === 'drag',
      requiresRelease: hand => xrManipulation?.requiresRelease?.(hand) === true,
      onEngage: hand => { try { pulseController(xrInputSourceFor(hand), GRAB_PULSE); } catch { /* Haptics never cost a modifier. */ } },
      record: recordManipulation,
    });
    // Only a menu press stands a stick down now. A thumb resting on the stick
    // during that hand's own grab used to add travel the wearer did not ask
    // for, which is why the grab claimed the stick; the grip is now the
    // one-hand scale modifier, so the grab has to leave the stick alone
    // and `applyStickForHand` sends a gripped hand's stick to the scale instead.
    const stickClaimed = hand => spatialOwnedHands.has(hand);
    // The stick and the other hand's grab write the same transient, and
    // `bakeGrab` clears it. Baking while a grip is still held would drop the
    // frames that arrive during the mutation's await and jump the structure
    // back. A grab bakes the whole transient when it ends, so the stick's
    // travel is already in what that bake commits: leave it there.
    const bakeStick = () => {
      if (xrManipulation?.phase() !== 'idle') return;
      xrDeferredGrab = { phase: 'stick', degrees: 0, scale: 1 }; flushXrDeferredGrab();
    };
    xrThumbstick = createXrThumbstick({
      onMove: deflection => applyStickForHand('right', deflection),
      onEnd: bakeStick, record: recordManipulation, hand: 'right', isClaimed: stickClaimed,
    });
    xrPushStick = createXrThumbstick({
      onMove: deflection => applyStickForHand('left', deflection),
      onEnd: bakeStick, record: recordManipulation, hand: 'left', isClaimed: stickClaimed,
    });
    // The Vision Pro bridge. Nothing below is reached on a Quest,
    // where no source reports a transient pointer, so the controller and hand
    // paths above are untouched. `natural-input.mjs` carries the rules.
    try {
      naturalInput = attachNaturalInput({
        session: canvas.webgl.xr?.session,
        rayFor: (frame, source) => naturalRayFor(frame, source, latestXrSpace),
        gripFor: (frame, source) => naturalGripFor(frame, source, latestXrSpace),
        onMenu: ray => immersiveSession?.isRayOnPanel?.(ray) === true,
        isClaimed: hand => spatialOwnedHands.has(hand),
        pick: ({ ray, frame, grabbing }) => {
          if (pickAlongRay(ray) || state.status !== 'ready' || busy || immersiveSession?.menuWithinView?.(frame)) return;
          // A tap made while the other hand, a controller or a tracked hand is
          // moving the structure is part of that move, never a summon.
          if (grabbing || spatialOwnedHands.size > 0) return;
          // Vision Pro has no Menu button. Empty space remains a summon target
          // after the room-locked menu has left the wearer's view.
          void immersiveSession?.toolbarAction?.({ kind: 'recenter-menu', reason: 'pinch' });
        },
        // The same gesture machine the grips drive. `updateXrManipulation`
        // merges the pinch pointers itself, so this only asks for a frame.
        onDrive: () => { if (!xrControllerInput) updateXrManipulation([]); },
        record: recordManipulation,
      });
    } catch (error) { recordManipulation('natural-input', { event: 'failed', error: error?.message }); }
  }

  /**
   * The residue under a pinch.
   *
   * A controller reaches `dispatchPresentationPick` through Mol*'s own pointer
   * stream, which never carries a transient source. A pinch has a ray instead,
   * and `canvas.identify` accepts one: the ray is moved out of room metres into
   * scene space by the same inverse view transform Mol* applies to a controller
   * ray (`xr-manager.js:27`), so both aims are read against the same pick pass.
   * Everything after the loci is the trigger's own path, including the caption,
   * the haptic that a pinch silently declines, and the saved selection.
   */
  function pickAlongRay(ray) {
    if (!ray || state.status !== 'ready' || busy) return false;
    try {
      const scene = Ray3D.create(Vec3.create(...ray.origin), Vec3.create(...ray.direction));
      Ray3D.transform(scene, scene, Mat4.invert(Mat4(), canvas.camera.view));
      const picked = canvas.identify(scene);
      if (!picked) { recordManipulation('natural-input', { event: 'pick', hit: false }); return false; }
      const loci = canvas.getLoci(picked.id).loci;
      dispatchPresentationPick({ button: XR_TRIGGER_BUTTON, current: { loci },
        position: picked.position ? Array.from(picked.position) : undefined });
      return true;
    } catch (error) {
      recordManipulation('natural-input', { event: 'pick', hit: false, error: error?.message });
      return false;
    }
  }

  function endXrManipulation() {
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    const releasedPlacement = Boolean(xrDeferredBake || xrDeferredGrab);
    xrInputLifecycle?.end(); xrInputLifecycle = undefined; xrDeferredBake = undefined;
    const heldPlacement = xrManipulation?.reset() || xrThumbstick?.moving() || xrPushStick?.moving();
    if (heldPlacement || releasedPlacement) {
      grabRotation = undefined; grabScale = 1; grabOffset = undefined;
      if (state.status === 'ready' && !canvas.webgl.isContextLost) applyInspectionTransform();
    }
    xrInputBlind = false; xrDeferredGrab = undefined; xrInputRelease.reset();
    xrManipulation = undefined;
    xrTransformPending = false; xrInputHeadInRoom = undefined;
    xrControllerInput?.reset(); xrControllerInput = undefined; xrAimUnavailable = false;
    xrButtons?.reset(); xrButtons = undefined;
    xrThumbstick?.reset(); xrThumbstick = undefined;
    xrPushStick?.reset(); xrPushStick = undefined;
    stickModifiers?.reset(); stickModifiers = undefined;
    triggerStickIntent?.reset(); triggerStickIntent = undefined;
    // A pinch never outlives its session, and one still held when
    // immersion stops is dropped rather than baked, exactly as a held grip is.
    naturalInput?.dispose(); naturalInput = undefined; latestXrSpace = undefined;
    // The caption is the session's, not the page's. A line left
    // standing after a session ends is drawn against a camera that has gone.
    const caption = talkCaption; talkCaption = undefined;
    setTalkOutcomeSink(undefined);
    setTalkProgressSink(undefined);
    try { detachConnectionMenu?.(); } catch { /* The subscriber list can be gone. */ }
    detachConnectionMenu = undefined;
    void caption?.dispose?.();
    tuneXrLocomotion(false);
    lastTriggerHand = undefined; lastTriggerAt = 0;
  }

  /**
   * Keep the stock thumbstick, and make it worth using.
   *
   * `xr-locomotion.mjs` carries the reasoning. The stick stays because it is
   * the only coarse approach to a structure out of arm's reach; the grab is
   * the fine control. Bindings are attribs and speed is a prop, so both are
   * set here and both are put back when the session ends.
   */
  function tuneXrLocomotion(presenting) {
    if (!enableXr) return;
    try {
      if (presenting && !restoreTrackball) {
        restoreTrackball = { trackball: canvas.attribs?.trackball?.bindings, xr: canvas.attribs?.xr?.bindings };
      }
      if (!presenting) {
        // Both binding sets go back exactly as they were found, so a desktop
        // session after an immersive one behaves as it always did.
        if (restoreTrackball?.trackball) canvas.setAttribs({ trackball: { bindings: restoreTrackball.trackball } });
        if (restoreTrackball?.xr) canvas.setAttribs({ xr: { bindings: restoreTrackball.xr } });
        restoreTrackball = undefined;
        return;
      }
      const bindings = xrLocomotionAttribs(canvas.attribs?.trackball?.bindings, Binding.Empty);
      if (bindings) canvas.setAttribs({ trackball: { bindings } });
      const manager = xrManagerAttribs(canvas.attribs?.xr?.bindings, Binding.Empty);
      if (manager) canvas.setAttribs({ xr: { bindings: manager } });
    } catch (error) { console.error(error); }
  }

  /** Retire the outgoing gesture without ending XR or baking it onto new bytes. */
  async function prepareHostLoad() {
    hostLoadDepth++;
    let released = false;
    const animationRevision = molecularAnimation.revision();
    const release = () => {
      if (released) return;
      released = true; hostLoadDepth--;
      // An admission failure may leave the outgoing clock installed. Keep it
      // paused and usable rather than leaving a permanent renderer halt.
      if (!hostLoadDepth && molecularAnimation.revision() === animationRevision) {
        try { molecularAnimation.control({ state: 'pause' }); } catch { /* A faulted clock is replaced by the next load. */ }
        molecularAnimation.resume();
      }
    };
    try {
      cancelXrPlacementFollowup(); invalidateGesturePivot();
      const pendingBake = xrDeferredBake;
      xrInputLifecycle?.end();
      xrInputLifecycle = createXrPlacementLifecycle();
      xrInputLifecycle.setBlind(xrInputBlind);
      xrDeferredBake = xrDeferredGrab = undefined;
      xrInputRelease.suspend(canvas.webgl.xr?.session?.inputSources);
      xrManipulation?.reset(); naturalInput?.reset();
      xrButtons?.reset(); xrThumbstick?.reset(); xrPushStick?.reset();
      stickModifiers?.reset(); triggerStickIntent?.reset();
      canvas.input?.interactionEnd?.next?.();
      mouseHeld = touchHeld = inputInteraction = xrInputHeld = manualXrInputHeld = false;
      grabRotation = grabOffset = undefined; grabScale = 1;
      xrTransformPending = false;
      talkCaption?.set({ holding: false });
      // Halt without changing the saved checkpoint. The incoming scene installs
      // its own clock; failure recovery can still restore the old scientific view.
      molecularAnimation.halt();
      motionToolPaused = true; syncPresentationMotion();
      if (state.status === 'ready' && !canvas.webgl.isContextLost) applyInspectionTransform();
      await pendingBake?.catch(error => { if (error?.code !== 'xr_input_ended') throw error; });
      await molecularAnimation.settled();
      // Menu clearance and a chapter's final draw may own a bounded renderer
      // transaction outside the workspace queue. Join it before refreshing UI.
      while (activeWork) await activeWork.done;
      return release;
    } catch (error) { release(); throw error; }
  }

  function handleXrInputVisibility(blind, sources = canvas.webgl.xr?.session?.inputSources) {
    xrInputBlind = blind;
    xrInputLifecycle?.setBlind(blind);
    if (!blind) return;
    xrInputRelease.suspend(sources);
    xrManipulation?.suspend();
    naturalInput?.reset();
    // A blind session may supply no frames. Preserve the visible transient
    // now and save it on the first visible frame, rather than timing out a
    // render transaction behind the system dialog.
    if (!xrDeferredGrab && (grabRotation || grabScale !== 1 || grabOffset)) xrDeferredGrab = { gesture: 'stick' };
    xrButtons?.reset(); xrThumbstick?.reset(); xrPushStick?.reset(); stickModifiers?.reset();
    triggerStickIntent?.reset();
    xrInputHeld = false; manualXrInputHeld = false;
  }

  function flushXrDeferredGrab() {
    if (xrInputBlind || xrDeferredBake || !xrDeferredGrab) return;
    const summary = xrDeferredGrab; xrDeferredGrab = undefined;
    const work = bakeGrab(summary, { inputLifecycle: xrInputLifecycle }).catch(error => {
      if (error?.code !== 'xr_input_ended') recordManipulation('xr-grab', { event: 'failed', error: error?.message });
    })
      .finally(() => { if (xrDeferredBake === work) xrDeferredBake = undefined; });
    xrDeferredBake = work;
  }

  function processXrPointers(pointers) {
    if (hostLoadDepth) { xrInputRelease.suspend(canvas.webgl.xr?.session?.inputSources); return; }
    if (xrInputBlind) return;
    pointers = xrInputRelease.filter(pointers, canvas.webgl.xr?.session?.inputSources);
    if (xrDeferredBake) {
      xrThumbstick?.resetTimer(); xrPushStick?.resetTimer();
      xrButtons?.update(pointers, { releaseOnly: true }); return;
    }
    const unavailable = pointers.some(pointer => pointer.tracking === 'unavailable' && (pointer.buttons & (POINTER_TRIGGER | POINTER_GRIP)));
    if (unavailable && !xrAimUnavailable) talkCaption?.set({ outcome: 'Aim unavailable. Stick moves; grip + stick resizes.' });
    xrAimUnavailable = unavailable;
    // A talk hold (A/X) or a menu tap (B/Y) is not a hand on
    // the structure. Counting it here stopped the spin AND reset its angle,
    // so saying anything while the structure turned snapped it back.
    xrInputHeld = pointers.some(pointerManipulates);
    // A pressed button freezes the slow presentation spin, so the structure
    // holds still while the wearer works. It does NOT cancel a running tour.
    // Every stick nudge, face button and trigger hover used to reach
    // `signalManualInteraction` formerly stopped the lesson and reset its
    // chapter. Molecular playback and chapter advancement remain independent.
    // Explicit Stop/Pause remains separate from placement manipulation.
    // `pointerManipulates` excludes the talk and menu buttons
    // for the same reason. Reset view still stops the spin: it holds B or Y,
    // but it pauses explicitly through `seatStructureForEntry`.
    const manualHands = pointers.filter(pointer => pointerManipulates(pointer) && !spatialOwnedHands.has(pointer.handedness));
    const manualHeld = manualHands.length > 0;
    if (manualHeld && !manualXrInputHeld) {
      const hands = new Set(manualHands.map(pointer => pointer.handedness));
      queueMicrotask(() => {
        // Let the toolbar's same-turn selectstart claim its hand before
        // classifying the controller as molecular manipulation.
        if ([...hands].some(hand => spatialOwnedHands.has(hand)) || performance.now() < spatialReleaseUntil) return;
        signalManualInteraction('xr-controller');
        void pausePresentationForInput('controller-pause', { allowInteraction: true }).catch(error => console.error(error));
      });
    }
    manualXrInputHeld = manualHeld;
    updateXrManipulation(pointers); // Grip grab and two-grip scale.
    // The two-grip scale changes camera.scale, and minFar is
    // in scene units. Recompute after the gesture has been applied.
    if (canvas.xr.isPresenting.value) applyImmersiveDepth();
    syncPresentationMotion();
  }

  function updateXrManipulation(pointers) {
    const processed = batchXrTransforms(() => updateXrManipulationNow(pointers));
    // Caption clearance reads representation bounds. It must see the final
    // flushed ray/stick pose, rather than an intermediate deferred transform.
    if (processed) {
      talkCaption?.set({ modifier: Boolean(stickModifiers?.engaged()) });
      talkCaption?.frame();
    }
  }

  function updateXrManipulationNow(pointers) {
    if (xrDeferredBake) { xrThumbstick?.resetTimer(); xrPushStick?.resetTimer(); }
    if (xrInputBlind || xrDeferredBake) return;
    if (!xrManipulation) {
      // Only worth saying when a grip is actually held, and once a second: an
      // untracked frame outside a session is not a rejection to read about,
      // and a held grip at 72 Hz would bury the log this line exists to write.
      const held = (pointers ?? []).some(pointer => ((pointer?.buttons | 0) & POINTER_GRIP) !== 0);
      if (held && performance.now() - lastNoSessionAt > 1000) {
        lastNoSessionAt = performance.now();
        recordManipulation('xr-grab', { event: 'rejected', reason: GRAB_REJECTED.noSession });
      }
      return;
    }
    for (const pointer of pointers ?? []) {
      // The Mol* click carries no handedness, so remember which hand pulled a
      // trigger and buzz that one when a residue comes back.
      if (pointer?.handedness && ((pointer.buttons | 0) & POINTER_TRIGGER) !== 0) {
        lastTriggerHand = pointer.handedness; lastTriggerAt = performance.now();
      }
    }
    // A held pinch publishes a pointer in the controller's own
    // shape, and it goes last on purpose. If hand tracking is granted, Apple
    // reports a persistent hand on the same side as the pinch and Mol* passes
    // it through with no buttons; taking the pinch after it is what keeps the
    // grab. Empty on a Quest, where nothing reports a transient pointer.
    // Only the gesture machine reads them: a pinch has no gamepad, so the face
    // buttons, the sticks and the trigger modifier below have nothing to read.
    const natural = naturalInput?.pointers?.() ?? [];
    const manipulated = natural.length ? [...(pointers ?? []), ...natural.map(pointer => transformNaturalPointer(pointer, xrRenderPose))] : (pointers ?? []);
    const sourced = manipulated.map(pointer => ({ ...pointer, source: pointer.source ?? xrInputSourceFor(pointer?.handedness) }));
    triggerStickIntent?.update(sourced);
    xrManipulation.update(sourced);
    // Release can start a save synchronously in the gesture callback.
    if (xrInputBlind) return;
    if (xrDeferredBake) {
      xrThumbstick?.resetTimer(); xrPushStick?.resetTimer();
      xrButtons?.update(pointers ?? [], { releaseOnly: true }); return;
    }
    xrButtons?.update(pointers ?? []);
    // The modifier layer reads the same frame the sticks do, and
    // before them, so a trigger pressed this frame is already latched when the
    // stick asks what it means.
    stickModifiers?.update(pointers ?? []);
    xrThumbstick?.update(pointers ?? []);
    xrPushStick?.update(pointers ?? []);
    return true;
  }

  function schedulePresentationFrame(callback) {
    const session = canvas.xr.isPresenting.value ? canvas.webgl.xr.session : undefined;
    if (session?.requestAnimationFrame && session?.cancelAnimationFrame) {
      motionFrameScheduler = session;
      motionFrame = session.requestAnimationFrame(callback);
    } else {
      motionFrameScheduler = undefined;
      motionFrame = requestAnimationFrame(callback);
    }
  }

  /**
   * The only frame clock a transient view animation may use.
   *
   * Quest Browser stops servicing the window's `requestAnimationFrame` for the
   * whole length of an immersive session, so an animation scheduled on it never
   * ticks again and every await behind it hangs. `schedulePresentationFrame`
   * above already knows this for the presentation turn; this is the same rule
   * for a one-shot travel, without that function's motion-loop bookkeeping.
   */
  function scheduleViewFrame(callback) {
    const session = canvas.xr.isPresenting.value ? canvas.webgl.xr.session : undefined;
    return session?.requestAnimationFrame
      ? session.requestAnimationFrame(callback) : requestAnimationFrame(callback);
  }

  /**
   * Expire growth feedback state on the presenting session clock.
   *
   * The expiry is counted on the presenting session's own frame clock, the
   * same scheduler as `scheduleViewFrame`: Quest Browser stops servicing the
   * window's `requestAnimationFrame` for the whole of an immersive session,
   * so a wait scheduled on it never ticks and growth feedback stays armed. Each frame re-checks the same window the readout
   * reads, and only the overlay that is still current is cleared — a second
   * grow inside the window starts its own four seconds rather than being cut
   * short by the first one's timer.
   */
  function scheduleGrowthCaptionExpiry(owned) {
    if (!owned) return;
    const target = owned.atMs + GROWTH_CAPTION_MS;
    const tick = timestamp => {
      if (growthOverlay !== owned) return;
      const now = typeof timestamp === 'number' ? timestamp : performance.now();
      if (now < target) { scheduleViewFrame(tick); return; }
      if (growthOverlay === owned) growthOverlay = undefined;
      try { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); } catch { /* The toolbar redraw is advisory. */ }
    };
    scheduleViewFrame(tick);
  }

  /**
   * Growth replies use the talk card, leaving the chapter caption intact.
   *
   * Used by the wearer's own grow-structure action AND by a host-initiated
   * refusal that arrived on the companion poll as `stereofold-growth-caption`.
   * Time is the same clock `scheduleGrowthCaptionExpiry` reads: performance
   * timestamps compared against XR frame timestamps through
   * `scheduleViewFrame`, never `window.requestAnimationFrame`.
   *
   * Keep the refusal overlay for growth state and expiry. It no longer
   * replaces chapter text, titles or progress on the structure caption.
   */
  function armGrowthCaption(spoken, { refused = false } = {}) {
    const overlay = createGrowthOverlay(spoken, performance.now(), { refused });
    if (!overlay) return;
    growthOverlay = overlay;
    showTalkOutcome(overlay.spoken);
    try { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); } catch { /* The toolbar redraw is advisory. */ }
    scheduleGrowthCaptionExpiry(growthOverlay);
  }

  function onHostGrowthCaption(event) {
    const overlay = growthOverlayFromNotice(event?.detail, performance.now());
    if (!overlay) return;
    growthOverlay = overlay;
    showTalkOutcome(overlay.spoken);
    try { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); } catch { /* The toolbar redraw is advisory. */ }
    scheduleGrowthCaptionExpiry(growthOverlay);
  }
  try { globalThis.addEventListener?.(GROWTH_CAPTION_EVENT, onHostGrowthCaption); }
  catch { /* A page with no event target still grows from the wearer-asked path. */ }

  function startPresentationMotion() {
    if (motionReason() || motionFrame !== undefined) return;
    const frame = timestamp => {
      motionFrame = motionFrameScheduler = undefined;
      if (motionReason()) return;
      const elapsed = Math.min(100, Math.max(0, timestamp - (motionLastFrame ?? timestamp)));
      motionLastFrame = timestamp;
      motionAngle = (motionAngle + elapsed * motionDegreesPerSecond() / 1000) % 360;
      applyInspectionTransform();
      canvas.commit(true);
      schedulePresentationFrame(frame);
    };
    schedulePresentationFrame(frame);
  }

  function syncPresentationMotion() {
    // A freeze has retained the displayed transform until its owned mutation
    // has drawn. Input subscriptions may report while it is in flight.
    if (presentationFreeze) return;
    const reason = motionReason();
    // A controller trigger reaches this synchronous gate before its queued
    // pause, including a toolbar-owned Pause press. Hold the displayed angle
    // until that action bakes it; clearing it here snaps back and leaves the
    // pause with no pose to publish. Other mutation/context/tool stops still
    // reset to the saved placement through their existing reasons.
    if (reason) stopPresentationMotion({ resetPose: reason !== 'document-hidden' && reason !== 'interaction' }); else startPresentationMotion();
    const next = inspectionMotionSnapshot();
    const signature = JSON.stringify(next);
    if (signature !== lastMotionNotification) {
      lastMotionNotification = signature;
      emit(onMotionChange, detached(next));
    }
  }

  /**
   * The level this page is running at.
   *
   * Read through the budget module rather than held here, so the menu row, the
   * agent's receipt and the geometry Mol* builds cannot disagree: they all read
   * the same variable.
   */
  function renderQualityLevel() { return activeRenderQuality(globalThis); }

  /** The live XR session, or `undefined` off a headset. Never throws. */
  function currentXrSession() {
    try { return canvas.webgl?.xr?.session; } catch { return undefined; }
  }

  /**
   * What a level actually got the wearer, read back rather than restated.
   *
   * `quality` is the tier Mol* BUILDS, not the tier it was asked for. A Quest
   * lowers every explicit tier by one (`mol-repr/util.js:127-131`) and the
   * budget asks one higher to cancel that, so the asked tier is the one number
   * that would mislead whoever reads this line in the headset log.
   *
   * `scaleAppliesOnNextEntry` is the one part of a level that cannot land now.
   * `XRWebGLLayer.framebufferScaleFactor` is fixed when the layer is
   * constructed, inside Mol*'s `webgl.xr.set` (`mol-gl/webgl/context.js:315`),
   * and Mol* exposes no way to rebuild the layer mid-session. Asking for `best`
   * while presenting therefore sharpens the geometry immediately and buys the
   * pixels back only when the wearer next enters.
   */
  function renderQualityApplied(level, rebuilt) {
    let representationName;
    try { representationName = inspectionState ? inspectionSnapshot().appearance.representation : undefined; }
    catch { representationName = undefined; }
    const presenting = Boolean(canvas.xr.isPresenting.value);
    const session = currentXrSession();
    const device = sessionDeviceClass(session, globalThis.navigator);
    const sites = structureAtomSites(plugin);
    const preset = renderQualityPreset(level, { deviceClass: device, representation: representationName, atomSites: sites });
    const asked = xrRepresentationQuality({ session, presenting, representation: representationName });
    const built = asked !== null && isStandaloneHmdAgent(globalThis.navigator) ? raiseQuality(asked, -1) : asked;
    const scale = Number.isFinite(preset.framebufferScale) ? preset.framebufferScale : framebufferScaleFor(device, sites);
    const layer = lastLayerScale();
    return {
      quality: appliedGeometryBudget?.level ?? built,
      ...(appliedGeometryBudget ? { geometryBudget: appliedGeometryBudget } : {}),
      gloss: Boolean(xrRepresentationMaterial({ presenting, representation: representationName })),
      scale,
      scaleAppliesOnNextEntry: presenting && Number.isFinite(layer) && layer !== scale,
      rebuilt,
      // `postfx` is the one that can move the frame rate,
      // so a judder report needs to say whether the passes were running; the
      // Mac reads both off the `render-quality` event.
      postfx: Boolean(canvas.props.postprocessing.enabled
        && (!presenting || !canvas.props.xr.disablePostprocessing)),
      palette: Boolean(xrColorParams({ presenting, representation: representationName, color: 'chain-id' })),
    };
  }

  /** The level and what it got, on the headset log the Mac reads. */
  function recordRenderQuality(level, applied) {
    let record;
    try { record = globalThis.__stereofoldDiagnostics?.record; } catch { return; }
    if (typeof record !== 'function') return;
    try { record('render-quality', { level, applied }); }
    catch { /* A diagnostics failure never touches what the wearer sees. */ }
  }

  /** Capture only the render-quality settings this operation may change. */
  function renderQualityCheckpoint() {
    const props = canvas.props;
    return { level: renderQualityLevel(), ...renderQualityContext(),
      props: { postprocessing: detached(props.postprocessing), illumination: detached(props.illumination),
        multiSample: detached(props.multiSample),
        xr: { disablePostprocessing: props.xr.disablePostprocessing } } };
  }

  function renderQualityContext() {
    return { presenting: Boolean(canvas.xr.isPresenting.value), session: currentXrSession() };
  }

  function assertRenderQualityContext(expected) {
    if (expected.presenting !== Boolean(canvas.xr.isPresenting.value) || expected.session !== currentXrSession())
      throw failure('stale_transition', 'The XR session changed during the quality change. Try again after entry or exit finishes.');
  }

  function applyRenderQualityPostprocessing() {
    if (!canvas.xr.isPresenting.value) return;
    // Explicit address overrides still win over the requested preset.
    const tuned = renderBudgetOverrides(globalThis, {
      deviceClass: sessionDeviceClass(currentXrSession(), globalThis.navigator), atomSites: structureAtomSites(plugin),
    });
    canvas.setProps(xrPostprocessingProps(tuned.enabled && tuned.postprocessing === true));
  }

  /** Restore CPU quality before geometry builds or a pending GL recovery starts. */
  function restoreRenderQualityCheckpoint(checkpoint) {
    setActiveRenderQuality(checkpoint.level);
    if (state.status === 'disposed') return;
    if (currentXrSession() === checkpoint.session && Boolean(canvas.xr.isPresenting.value) === checkpoint.presenting)
      canvas.setProps(detached(checkpoint.props));
    // Entry may have derived its passes from the provisional tier. Restore
    // the retained tier in that new session; exit owns desktop defaults.
    else applyRenderQualityPostprocessing();
  }

  /**
   * Apply an explicit quality as one owned rebuild and frame transaction.
   * Empty idle viewers retain a preference for their next load. An in-flight
   * build refuses a new setting instead of mixing quality tiers in its layers.
   * Storage changes only after the requested geometry and passes have drawn.
   */
  async function setRenderQuality(level) {
    if (!RENDER_QUALITY_LEVELS.includes(level)) {
      throw failure('invalid_render_quality', 'Render quality must be fast, balanced or best.');
    }
    assertContext();
    if (busy || appearanceWork) throw failure('viewer_busy', 'A molecular change is still rendering. Try the quality change when it finishes.');
    if (interactionActive()) throw failure('interaction_active', 'Release the molecular drag before changing render quality.');
    const previous = retainCurrent();
    if (!previous) {
      setActiveRenderQuality(level);
      storeRenderQuality(level, globalThis);
      const applied = renderQualityApplied(level, false);
      recordRenderQuality(level, applied);
      return { level, applied };
    }
    assertReady();
    const checkpoint = renderQualityCheckpoint();
    previous.renderQualityCheckpoint = checkpoint;
    const rebuild = canRebuildForXr({ presenting: Boolean(canvas.xr.isPresenting.value) });
    const work = beginWork(previous);
    busy = true;
    let rebuilding = false;
    try {
      setActiveRenderQuality(level);
      applyRenderQualityPostprocessing();
      const check = () => { assertContext(); assertRenderQualityContext(checkpoint); };
      if (rebuild) {
        rebuilding = true;
        await applyInspectionAppearance({ labels: false, preservePlacement: true, check });
      }
      check();
      canvas.commit(!canvas.xr.isPresenting.value);
      await waitForFrame();
      check();
      refreshStructureSubject(snapshot());
      check();
      const applied = renderQualityApplied(level, rebuild);
      storeRenderQuality(level, globalThis);
      recordRenderQuality(level, applied);
      return { level, applied };
    } catch (error) {
      let restorationError;
      try { restoreRenderQualityCheckpoint(checkpoint); }
      catch (failedRestore) { restorationError = failedRestore; }
      const lost = canvas.webgl.isContextLost || ['context_lost', 'recovering'].includes(state.status);
      if (!lost && state.status !== 'disposed' && !restorationError) {
        // One session edge can interrupt rollback too. Retry once in its new
        // mode; repeated edges remain a truthful bounded restoration failure.
        for (let attempt = 0; attempt < 2; attempt++) {
          const context = renderQualityContext();
          const check = () => { assertContext(); assertRenderQualityContext(context); };
          try {
            restoreRenderQualityCheckpoint(checkpoint);
            // The candidate may have already retired its old selector.
            if (rebuilding) await applyInspectionAppearance({ labels: false, preservePlacement: true, check });
            check();
            canvas.commit(!canvas.xr.isPresenting.value);
            await waitForFrame();
            check();
            refreshStructureSubject(snapshot());
            check();
            break;
          } catch (failedRestore) {
            if (failedRestore.code === 'stale_transition' && attempt === 0
                && (context.presenting !== Boolean(canvas.xr.isPresenting.value) || context.session !== currentXrSession())) continue;
            restorationError = failedRestore;
            break;
          }
        }
      }
      const pending = canvas.webgl.isContextLost || ['context_lost', 'recovering'].includes(state.status);
      let scaleAppliesOnNextEntry = false;
      try { scaleAppliesOnNextEntry = renderQualityApplied(checkpoint.level, false).scaleAppliesOnNextEntry; } catch { /* Keep the original refusal. */ }
      const restoration = { status: pending ? 'pending' : restorationError ? 'failed' : state.status === 'disposed' ? 'disposed'
        : scaleAppliesOnNextEntry ? 'restored_next_entry' : 'restored',
        level: checkpoint.level, ...(restorationError ? { message: String(restorationError.message ?? restorationError) } : {}) };
      if (scaleAppliesOnNextEntry) {
        restoration.scaleAppliesOnNextEntry = true;
        restoration.layerScale = lastLayerScale();
        const resolution = 'The previous quality\'s framebuffer resolution applies on the next XR entry.';
        restoration.message = restoration.message ? `${restoration.message} ${resolution}` : resolution;
      }
      // Preserve the original exception/code for the command's typed refusal.
      // Its recovery detail and viewer error never claim a rollback that failed.
      try { error.renderQualityRestoration = restoration; } catch { /* Non-object errors still reach diagnostics. */ }
      // The toolbar and normal typed tool refusal read message, not custom
      // Error fields. Keep its original code/identity and include incomplete recovery.
      if (restoration.message) try {
        const detail = restorationError
          ? pending ? 'Previous quality restoration is pending context recovery: ' : 'Previous quality restoration failed: '
          : '';
        error.message = `${error.message ?? String(error)} ${detail}${restoration.message}`;
      } catch { /* Diagnostics also carry it. */ }
      if (restoration.message && canvas.xr.isPresenting.value) {
        try { showHeadsetCaption(error.message ?? String(error)); }
        catch { /* The typed refusal still carries the complete recovery detail. */ }
      }
      recordCost('render-quality-rollback', { requestedLevel: level, ...restoration });
      if (restorationError && !pending && state.status !== 'disposed') {
        state.status = 'error';
        state.error = error.message ?? String(error);
      }
      throw error;
    } finally {
      if (activeWork === work) busy = false;
      work.finish();
    }
  }

  /**
   * The render budget as the spatial toolbar reads it.
   *
   * The lever itself belongs to the viewer's own inspection surface
   * (`setRenderQuality` / `renderQuality`), so this reads it
   * back rather than keeping a second copy that could drift from it. A build
   * whose viewer has no lever reports nothing, and the quality row does not
   * appear at all: an unwired setting is worse than no setting.
   */
  function spatialRenderQuality() {
    try {
      const level = typeof inspection?.renderQuality === 'function' ? inspection.renderQuality() : undefined;
      return typeof level === 'string' ? { renderQuality: level } : {};
    } catch { return {}; }
  }

  async function setInspectionMotion(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.paused !== 'boolean') {
      throw failure('invalid_motion', 'Motion requires exactly a paused boolean.');
    }
    if (!value.paused && reducedMotionQuery?.matches) throw failure('reduced_motion', 'Presentation motion follows the system reduced-motion preference.');
    if (value.paused) {
      await pausePresentationForInput('presentation-pause');
      return detached(inspectionMotionSnapshot());
    }
    motionUserPaused = false;
    motionToolPaused = false;
    if (!value.paused && canvas.xr.isPresenting.value) motionXrExplicit = true;
    syncPresentationMotion();
    return detached(inspectionMotionSnapshot());
  }

  function inspectionPayload() {
    const figure = typeof lessonFigure === 'undefined' ? undefined : lessonFigure.definition?.();
    return { selectionKeys: [...state.selectionKeys], camera: cameraSnapshot(desktopPreviewCamera ?? canvas.camera.getSnapshot()), ...savedStyles(), ...savedVisibility(),
      ...(typeof lessonSelection !== 'undefined' ? { lessonSelection } : {}),
      ...(figure ? { lessonFigure: figure } : {}),
      ...(typeof measurementLines !== 'undefined' && measurementLines.count() ? {measurementLines:measurementLines.definition()} : {}) };
  }

  function syncInspectionPayload() { inspectionState?.setPayload(inspectionPayload()); }

  async function recoverStaleAppearanceFit() {
    const generation = state.generation, source = sourceRecord;
    hideRetainedPose();
    // The old appearance is back, but its clearance proof was invalidated by
    // a moving plate. Check the restored geometry at the exact retained pose:
    // recovery may not silently resize or translate the wearer's structure.
    try {
      await awaitPlacementViews();
      await clearHeldPlatePlacement(inspectionSnapshot().placement, {
        hidden: scientificRepresentations(true), keepWearer: true, keepClearSeat: true,
        kind: 'appearance-recovery',
      });
    } catch (error) {
      // The restored geometry is retained and hidden safely. A refused clearance
      // is not a broken renderer: Reset/Fit require ready and must remain usable.
      if (state.generation === generation && sourceRecord === source && !canvas.webgl.isContextLost
        && ['mutating', 'error'].includes(state.status)
        && representation?.cell?.status === 'ok' && plugin.state.data.cells.get(representation.ref) === representation.cell) {
        error.recoverablePlacement = true;
        state.status = 'ready'; state.error = null;
      }
      throw error;
    }
    assertContext();
    showRetainedPose(true);
    canvas.commit(!canvas.xr.isPresenting.value);
    await waitForFrame();
  }

  let inspectionMutationSettlement;
  async function inspectionMutation(operation, options) {
    const checkpoint = inspectionState.checkpoint();
    // Only a failure inside this call's own mutation may be recovered below.
    // A refusal at admission leaves another command's state alone.
    const admitted = state.status === 'ready' && !busy;
    let entered = false, finishSettlement;
    if (admitted) inspectionMutationSettlement = new Promise(resolve => { finishSettlement = resolve; });
    try {
      await mutate('inspection', () => { entered = true; return operation(); }, options);
      for (const retired of retiredComparisons) await deleteRecord(retired);
      retiredComparisons.clear();
      // Camera resets settle during the frame. Retain the actual camera for
      // redo after focus, fitting and clipping have finished drawing.
      syncInspectionPayload();
      return snapshot();
    }
    catch (error) {
      inspectionState.restoreCheckpoint(checkpoint);
      // State the checkpoint does not hold goes back before any redraw. A
      // restore that lost to animation work still landing is retried once that
      // work has stopped. A second failure must not skip the redraw below, or
      // the viewer stays in `error` and every later command waits behind it.
      for (const retry of [false, true]) {
        try {
          if (retry && typeof molecularAnimation !== 'undefined') await molecularAnimation.settled?.();
          await options?.rollback?.();
          const payload = inspectionState.payload();
          if (payload) { stylesState = normalizeStyles(payload.styles); visibilityState = normalizeVisibility(payload.visibility); }
          if (entered && typeof lessonFigure !== 'undefined'
            && JSON.stringify(lessonFigure.definition?.()) !== JSON.stringify(payload?.lessonFigure))
            await lessonFigure.install(payload?.lessonFigure);
          if (entered && typeof measurementLines !== 'undefined') await measurementLines.install(payload?.measurementLines);
          break;
        } catch (restoreError) {
          recordCost('mutation-restore', { outcome: retry ? 'failed' : 'retrying', error: restoreError?.message ?? String(restoreError) });
          if (retry) console.error(restoreError);
        }
      }
      const retainedAbort = options?.recoverRetained?.() === true;
      if (retainedAbort && !canvas.webgl.isContextLost && !['disposed', 'context_lost', 'recovering'].includes(state.status)
        && representation?.cell?.status === 'ok' && plugin.state.data.cells.get(representation.ref) === representation.cell) {
        // Only an explicitly aborted, staged appearance may take this route.
        // Keep admissions closed until the restored checkpoint draws again.
        state.status = 'mutating'; busy = true;
        try {
          restoreInspectionPayload();
          await applyInspectionAppearance(); applyInspectionTransform();
          canvas.commit(!canvas.xr.isPresenting.value); await waitForFrame();
          assertContext(); state.status = 'ready'; state.error = null;
        } catch (recoveryError) {
          if (!recoveryError.recoverablePlacement && !['disposed', 'context_lost', 'recovering'].includes(state.status)) {
            state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
            state.error = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          }
          throw recoveryError;
        } finally { busy = false; }
      } else if (entered && options?.ownsRecovery !== true && (companionRecord || checkpoint.current.companionStructure)
        && !canvas.webgl.isContextLost && state.status !== 'disposed') {
        // Only a change that entered its operation redraws; a refusal changed
        // nothing. A caller that owns its recovery redraws its own scene.
        state.status = 'mutating'; busy = true; companionRecoveryActive = true;
        try {
          restoreInspectionPayload();
          const refusedFit = Boolean(error.fitRefusal);
          const menuActive = Boolean(canvas.xr.isPresenting.value && immersiveSession?.platePoints?.()?.length);
          if (refusedFit && menuActive) hideRetainedPose();
          await restoreCompanion(inspectionSnapshot().companionStructure);
          let appearancePresenting = Boolean(canvas.xr.isPresenting.value);
          await applyInspectionAppearance(refusedFit ? { recoverWithoutFit: true } : undefined);
          applyInspectionTransform();
          if (refusedFit && menuActive) hideRetainedPose();
          if (refusedFit && !menuActive) showRetainedPose(true);
          canvas.commit(true);
          if (!refusedFit || !retainedPoseHidden) await waitForFrame();
          for (const retired of retiredComparisons) await deleteRecord(retired);
          retiredComparisons.clear();
          // Either presentation edge during a frame needs its own quality
          // before recovery releases the representation.
          let rebuiltForPresentation = false;
          let recoveredEntryAdvisory;
          while (appearancePresenting !== Boolean(canvas.xr.isPresenting.value)
            || (companionRecoveryPendingXr && canvas.xr.isPresenting.value)) {
            companionRecoveryPendingXr = false;
            appearancePresenting = Boolean(canvas.xr.isPresenting.value);
            const entryNotice = typeof entryGeometryAdvisory !== 'undefined' ? entryGeometryAdvisory : undefined;
            if (refusedFit && appearancePresenting && immersiveSession?.platePoints?.()?.length) hideRetainedPose();
            await applyInspectionAppearance({ labels: false, componentLabels: false,
              recoverWithoutFit: refusedFit });
            if (refusedFit && canvas.xr.isPresenting.value && immersiveSession?.platePoints?.()?.length) hideRetainedPose();
            if (refusedFit && !canvas.xr.isPresenting.value) showRetainedPose(true);
            canvas.commit(true);
            if (!refusedFit || !retainedPoseHidden) await waitForFrame();
            recoveredEntryAdvisory = appearancePresenting && entryNotice?.session === canvas.webgl.xr?.session
              ? entryNotice : undefined;
            rebuiltForPresentation = true;
          }
          if (error.code === 'FIT_STALE' && retainedPoseHidden) await recoverStaleAppearanceFit();
          assertContext();
          state.status = 'ready'; state.error = null;
          busy = false;
          if (recoveredEntryAdvisory && recoveredEntryAdvisory === entryGeometryAdvisory
            && recoveredEntryAdvisory.session === canvas.webgl.xr?.session && canvas.xr.isPresenting.value)
            recoveredEntryAdvisory.prepared = true;
          if (rebuiltForPresentation) refreshStructureSubject(snapshot());
        } catch (recoveryError) {
          if (!recoveryError.recoverablePlacement && !['disposed', 'context_lost', 'recovering'].includes(state.status)) {
            state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
            state.error = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          }
          throw recoveryError;
        } finally {
          companionRecoveryActive = false; companionRecoveryPendingXr = false; busy = false;
        }
      } else if (admitted && entered && error.fitRefusal && state.status === 'error' && !canvas.webgl.isContextLost
        && representation?.cell?.status === 'ok' && plugin.state.data.cells.get(representation.ref) === representation.cell) {
        // A fit refusal leaves a usable scene, but a second worker fit cannot
        // restore it when the worker itself is unavailable. Keep it out of the
        // menu until a wearer-initiated synchronous Fit or Reset seats it.
        if (error.code === 'FIT_STALE') {
          state.status = 'mutating'; busy = true;
          try {
            restoreInspectionPayload();
            await applyInspectionAppearance({ recoverWithoutFit: true }); applyInspectionTransform();
            await recoverStaleAppearanceFit();
          } catch (recoveryError) {
            if (!recoveryError.recoverablePlacement && !['disposed', 'context_lost', 'recovering'].includes(state.status)) {
              state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
              state.error = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            }
            throw recoveryError;
          } finally { busy = false; }
        } else if (canvas.xr.isPresenting.value && immersiveSession?.platePoints?.()?.length) hideRetainedPose();
        else showRetainedPose(true);
        state.status = 'ready'; state.error = null;
      } else if (admitted && options?.ownsRecovery !== true && state.status === 'error' && !canvas.webgl.isContextLost
        && representation?.cell?.status === 'ok' && plugin.state.data.cells.get(representation.ref) === representation.cell) {
        // An ordinary failure used to stay in `error`, so the panel reported
        // busy and the host held every later command until a reload. Draw the
        // restored checkpoint, then admit commands again. The caller still
        // receives the original failure. A failed redraw keeps the error.
        const failed = state.error;
        state.status = 'mutating'; busy = true;
        try {
          await redrawRestoredScene();
          state.status = 'ready'; state.error = null;
        } catch (recoveryError) {
          if (!recoveryError.recoverablePlacement && !['disposed', 'context_lost', 'recovering'].includes(state.status)) {
            state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
            state.error = `${failed}; restoring the previous scene failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
          }
        } finally { busy = false; }
      }
      throw error;
    } finally { finishSettlement?.(); }
  }

  /**
   * Draw the restored checkpoint after a failed change.
   *
   * Animation work still landing, or an animation that faulted while its
   * figure was replaced, can fail the first redraw. Retry once that work has
   * stopped, reinstalling the saved figure, measurements and a faulted
   * animation. A redraw counts only when every checkpoint component is back:
   * a frame drawn without the figure is not the saved scene. Throws the first
   * failure when neither attempt brings the whole scene back.
   */
  async function redrawRestoredScene() {
    let firstError;
    // A scene without its figure or motion is never drawn in place of the
    // saved one: the page would save it as the wearer's work. When both
    // attempts fail the viewer stays in `error`, and the page reloads the
    // saved scene from the host.
    for (const attempt of ['restored', 'settled']) {
      try {
        if (attempt !== 'restored' && typeof molecularAnimation !== 'undefined') {
          await molecularAnimation.settled?.();
          if (molecularAnimation.faulted?.()) await molecularAnimation.restore(molecularAnimation.checkpoint(), true);
          molecularAnimation.resume?.();
        }
        const unrestored = attempt === 'restored' ? [] : unrestoredComponents();
        if (unrestored.includes('molecular figure')) await lessonFigure.install(inspectionState.payload()?.lessonFigure);
        if (unrestored.includes('measurements')) await measurementLines.install(inspectionState.payload()?.measurementLines);
        restoreInspectionPayload();
        await applyInspectionAppearance({ depth: true }); applyInspectionTransform();
        canvas.commit(!canvas.xr.isPresenting.value); await waitForFrame();
        assertContext();
        const missing = unrestoredComponents();
        if (missing.length) throw Error(`The restored scene was drawn without its ${missing.join(' and ')}.`);
        if (attempt !== 'restored') recordCost('scene-recovery', { attempt, error: firstError?.message ?? String(firstError) });
        return attempt;
      } catch (error) {
        firstError ??= error;
        if (attempt === 'settled' || error?.recoverablePlacement || canvas.webgl.isContextLost
          || ['disposed', 'context_lost', 'recovering'].includes(state.status)) throw error?.recoverablePlacement ? error : firstError;
      }
    }
  }

  /** The checkpoint components the viewer does not show. */
  function unrestoredComponents() {
    const payload = inspectionState.payload(), missing = [];
    if (typeof lessonFigure !== 'undefined'
      && JSON.stringify(lessonFigure.definition?.()) !== JSON.stringify(payload?.lessonFigure)) missing.push('molecular figure');
    if (typeof measurementLines !== 'undefined' && JSON.stringify(measurementLines.count()
      ? measurementLines.definition() : undefined) !== JSON.stringify(payload?.measurementLines)) missing.push('measurements');
    if (typeof molecularAnimation !== 'undefined' && molecularAnimation.faulted?.()) missing.push('molecular animation');
    return missing;
  }

  function restoreInspectionPayload() {
    const payload = inspectionState.payload();
    if (!payload) return;
    stylesState = normalizeStyles(payload.styles);
    visibilityState = normalizeVisibility(payload.visibility);
    const keys = selectedKeys(payload.selectionKeys);
    const camera = cameraSnapshot(payload.camera);
    lessonSelection = payload.lessonSelection;
    markSelection(keys);
    canvas.camera.setState(camera, 0);
  }

  function markerCounts() {
    let markerCount = 0, selectedMarkerCount = 0, highlightedMarkerCount = 0;
    for (const { values } of canvas.getRenderObjects()) {
      if (!values.tMarker || !values.markerStatus) continue;
      // Match stock Visual.mark's logical extent and uniform-marker shortcut;
      // texture allocation padding does not count. Different visuals can have
      // markers for the same residue, so these are not atom or residue counts.
      const count = values.instanceGranularity.ref.value
        ? values.instanceCount.ref.value
        : values.uGroupCount.ref.value * values.instanceCount.ref.value;
      const status = values.markerStatus.ref.value;
      const array = values.tMarker.ref.value.array;
      markerCount += count;
      if (status >= 0) {
        if (status & 2) selectedMarkerCount += count;
        if (status & 1) highlightedMarkerCount += count;
      } else {
        for (let index = 0; index < count; index += 1) {
          if (array[index] & 2) selectedMarkerCount += 1;
          if (array[index] & 1) highlightedMarkerCount += 1;
        }
      }
    }
    return { markerCount, selectedMarkerCount, highlightedMarkerCount };
  }

  /**
   * The record for whatever is loaded right now, or null when nothing is.
   *
   * A density tier is loaded too. This used to answer null for
   * one, because it tested `structure` alone — so `markSelection`, `mutate`'s
   * retained previous and the bare `waitForFrame()` after a placed chapter all
   * behaved as if the viewer were empty while a map was on the wearer's face. A
   * scene is atoms or it is density, and `volume` is carried here so a rollback
   * and a restore can rebuild the one that is actually loaded.
   */
  function retainCurrent() {
    if ((!structure && !volume) || !representation || !sourceRecord) return null;
    return { rootRef: dataRoot, source: sourceRecord, structure, volume, representation, selection, companionRecord,
      geometryBudget: appliedGeometryBudget, visibility: normalizeVisibility(visibilityState), styles: normalizeStyles(stylesState), styleLayers: [...styleLayers], visible: visibleStage, triangles: volumeTriangles, isoExtent: volumeIsoExtent, paint: volumePaint,
      selectionKeys: [...state.selectionKeys], inspection: liveScene(), lastPick: detached(state.lastPick),
      ...(typeof initialFigureFrame !== 'undefined' && initialFigureFrame ? { initialFigureFrame: detached(initialFigureFrame) } : {}),
      ...(typeof sourceCoordinateFrame !== 'undefined' && sourceCoordinateFrame ? { coordinateFrame: sourceCoordinateFrame } : {}),
      ...(typeof lessonSelection !== 'undefined' ? { lessonSelection } : {}),
      ...(typeof measurementLines !== 'undefined' && measurementLines.count() ? {measurements:measurementLines.definition()} : {}),
      lesson: { figure: lessonFigure.definition(), playback: detached(lessonPlayback), chapterKey: lastLessonChapterKey,
        emphasis: detached(emphasisState), origin: emphasisOrigin,
        key: lessonKey.checkpoint(), resting: lessonResting.checkpoint() } };
  }

  function restoreRetainedDesktopPreview(preview) {
    // A failed source change may have released the flat preview's automatic
    // zoom limit. Restore its camera ownership before any rollback draw, but
    // never carry it into a different room session or overwrite newer controls.
    if (canvas.xr.isPresenting.value || currentXrSession() !== preview.session
      || (typeof roomEntry !== 'undefined' && roomEntry !== preview.entry)) return;
    // A failed shared restore may already have fitted its own temporary camera.
    // Release only that still-owned limit before reinstating the retained fit;
    // an independently changed controls limit remains untouched.
    releaseDesktopPreviewLimit();
    desktopPreviewCamera = detached(preview.camera);
    const trackball = canvas.props?.trackball;
    if (preview.limit && trackball?.autoAdjustMinMaxDistance?.name === 'on'
      && (trackball.maxDistance === preview.maxDistance || trackball.maxDistance === preview.limit.original)) {
      desktopPreviewMaxDistance = detached(preview.limit);
      canvas.setProps({ trackball: { maxDistance: preview.maxDistance } });
    }
  }

  /** Restore source-owned lesson metadata without painting or touching XR state. */
  function restoreRetainedLessonState(lesson) {
    lessonPlayback = detached(lesson.playback); lastLessonChapterKey = lesson.chapterKey;
    emphasisState = detached(lesson.emphasis); emphasisOrigin = lesson.origin;
    lessonKey.restoreCheckpoint(lesson.key); lessonResting.restoreCheckpoint(lesson.resting);
  }

  function adopt(record) {
    if (typeof molecularAnimation !== 'undefined') void molecularAnimation.forget().catch(error => console.error(error));
    adoptionGeneration += 1;
    if (record) candidateRecords.delete(record);
    // The names survive a repaint of the same molecule — a
    // context loss and its recovery adopt the structure the wearer is already
    // being taught — but not a different one. A new source is a new lesson, and
    // answering "show me the PAM" on a molecule that has no PAM would be worse
    // than not knowing the word.
    const previousSource = state.sourceSha256;
    const previousIdentity = liveScene();
    companionRecord = record?.companionRecord;
    dataRoot = record?.rootRef;
    sourceRecord = record?.source;
    structure = record?.structure;
    appliedGeometryBudget = record?.geometryBudget;
    volume = record?.volume;
    volumeTriangles = Number.isFinite(record?.triangles) && record.triangles > 0 ? record.triangles : 0;
    // The measured density extent travels with the record, and
    // dies with it — an atomic adoption clears it back to null.
    volumeIsoExtent = record?.isoExtent ?? null;
    // The paint read-back travels and dies with the record too.
    volumePaint = record?.paint ?? null;
    representation = record?.representation;
    selection = record?.selection;
    visibleStage = record?.visible;
    initialFigureFrame = record?.initialFigureFrame;
    sourceCoordinateFrame = record?.coordinateFrame;
    state.sourceSha256 = record?.source.sha256 ?? null;
    state.selectionKeys = [...(record?.selectionKeys ?? [])];
    lessonSelection = record?.lessonSelection;
    state.lastPick = detached(record?.lastPick ?? null);
    // The emphasis layers hang off the representation
    // this call is replacing, so adopting a record is also forgetting them. A
    // saved scene must never claim a colour key the structure is not wearing.
    emphasisState = { ...NO_EMPHASIS, parts: [], focus: [] };
    // Restore hidden keys only from this retained record. A fresh source has
    // no visibility payload, so chains from the outgoing source cannot leak.
    visibilityState = normalizeVisibility(record?.visibility);
    stylesState = normalizeStyles(record?.styles);
    styleLayers = (record?.styleLayers ?? []).filter(layer => plugin.state.data.cells.has(layer.component.ref));
    // The name plates hang off the OLD structure's loci, at
    // the state-tree root where no subtree delete will take them. The adoption
    // is synchronous, so the delete runs unawaited; the refs are dropped first
    // so a concurrent rebuild cannot address cells that are going away.
    pendingRoomLabels = false;
    pendingRoomLabelBasis = null;
    lessonResting.setLabelsEnabled(false);
    {
      const staleComponentLabels = componentLabels.adopt();
      if (staleComponentLabels.length) void deleteComponentLabelCells(staleComponentLabels).catch(() => {});
    }
    // A new source is a new lesson, so the previous chapter's
    // framing key must not survive the swap either. `lessonKey.forget` drops the
    // taught names; without this the tourgrab "a chapter frames once, keyed by
    // its colour key" treats the grown tier's opening chapter as a repaint when
    // its key collides with the previous tier's, and any emphasis raced with
    // the swap wears the old source's chains — on the protofilament that lit
    // the lower dimer and ghosted the new one at 76aa6ff.
    const adoptedIdentity = liveScene();
    if (state.sourceSha256 !== previousSource || adoptedIdentity.modelNumber !== previousIdentity.modelNumber
      || adoptedIdentity.assemblyId !== previousIdentity.assemblyId) {
      lessonKey.forget(); lastLessonChapterKey = undefined; lessonResting.forget();
      lessonPlayback = undefined;
      void lessonFigure.forget().catch(error => console.error(error));
      if (typeof measurementLines !== 'undefined') void measurementLines.install([]).catch(error => console.error(error));
      // The sentence is about the structure that was
      // placed. A different one arriving retires it rather than letting the
      // plate describe where the previous molecule went.
      placementNote = null; entryRoomPoint = null;
      if (roomEntry) delete roomEntry.seat;
    }
    emphasisOrigin = 'command';
  }

  function beginWork(previous) {
    let finish;
    const work = { previous, contextLossCount: state.contextLossCount, done: new Promise(resolve => { finish = resolve; }),
      finish() {
        // WebGL reports loss synchronously, before dispatching contextlost.
        // Keep this operation's checkpoint if it settles in that interval;
        // the event must not retain the half-applied camera or geometry.
        if (activeWork === work) {
          if (state.status !== 'disposed' && canvas.webgl.isContextLost && state.contextLossCount === work.contextLossCount)
            pendingContextLoss = { previous, epoch: work.contextLossCount };
          activeWork = undefined;
        }
        finish();
      } };
    activeWork = work;
    return work;
  }

  function coverCurrentFrame() {
    if (frameCover || (!structure && !volume)) return;
    // There is no flat frame to retain inside immersion.
    //
    // The cover exists so a desktop panel does not flash an empty canvas while
    // a replacement builds. A wearer never sees this canvas at all — their eyes
    // are on the XR layer — and the snapshot below is a `drawImage` of the live
    // WebGL canvas, which is exactly the mid-XR canvas capture that does not
    // work on Quest Browser: the drawing buffer belongs
    // to the XRWebGLLayer, so the readback costs a flush and a stall on the
    // main thread and returns a frame nobody is looking at. Skipped while
    // presenting; `removeFrameCover` is already a no-op with nothing to remove.
    if (canvas.xr.isPresenting.value) return;
    const cover = document.createElement('canvas');
    cover.width = element.width;
    cover.height = element.height;
    const context = cover.getContext('2d');
    if (!context) throw failure('frame_cover_failed', 'The current frame could not be retained during replacement.');
    context.drawImage(element, 0, 0);
    cover.dataset.stereofoldFrameCover = '';
    cover.setAttribute('aria-hidden', 'true');
    cover.tabIndex = -1;
    cover.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:auto;background:#111b23';
    const previousPosition = container.style.position;
    const changedPosition = getComputedStyle(container).position === 'static';
    if (changedPosition) container.style.position = 'relative';
    const previousFocus = document.activeElement;
    container.append(cover);
    cover.focus({ preventScroll: true });
    frameCover = { element: cover, previousPosition, changedPosition, previousFocus };
  }

  function removeFrameCover() {
    if (!frameCover) return;
    const { element: cover, previousPosition, changedPosition, previousFocus } = frameCover;
    frameCover = undefined;
    const restoreFocus = document.activeElement === cover && previousFocus?.isConnected;
    cover.remove();
    cover.width = cover.height = 0;
    if (changedPosition) container.style.position = previousPosition;
    if (restoreFocus) previousFocus.focus?.({ preventScroll: true });
  }

  function markRecord(record, keys) {
    // A density tier has no elements to mark. There is no
    // selection adapter behind it and `EveryLoci` on an isosurface would be a
    // marker pass over the whole mesh for a selection that cannot exist.
    if (!record?.selection) { if (record) record.selectionKeys = []; return; }
    const repr = record.representation.obj.data.repr;
    const loci = record.selection.toLoci(keys);
    canvas.mark({ repr, loci: EveryLoci }, MarkerAction.Deselect);
    canvas.mark({ repr, loci }, MarkerAction.Select);
    record.selectionKeys = [...keys];
  }

  async function deleteRecord(record) {
    if (record?.companionRecord) await deleteRecord(record.companionRecord);
    if (!record?.rootRef) return;
    if (!plugin.state.data.cells.has(record.rootRef)) { candidateRecords.delete(record); return; }
    await plugin.state.data.build().delete(record.rootRef).commit({ revertOnError: true });
    if (plugin.state.data.cells.has(record.rootRef)) throw failure('candidate_cleanup_failed', 'A replaced scene subtree was not removed.');
    candidateRecords.delete(record);
  }

  function assertLoad(operation) {
    if (state.status === 'disposed') throw failure('viewer_disposed', 'The viewer has been disposed.');
    if (operation.cancelled) throw operation.cancelled;
    assertContext();
    if (activeLoad !== operation || state.generation !== operation.generation) {
      throw failure('stale_load', 'The scene replacement no longer owns this viewer generation.');
    }
  }

  async function checkpoint(operation, point) {
    assertLoad(operation);
    state.replacementPhase = point;
    if (operation.pauseAt === point) {
      operation.pauseAt = null;
      state.testPausedAt = point;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          operation.releasePause = undefined;
          state.testPausedAt = null;
          reject(failure('test_pause_timeout', 'The explicit load test checkpoint was not released within 30 seconds.'));
        }, FRAME_TIMEOUT_MS);
        operation.releasePause = () => {
          clearTimeout(timer);
          operation.releasePause = undefined;
          state.testPausedAt = null;
          resolve();
        };
      });
    }
    assertLoad(operation);
    if (operation.failAt === point) {
      throw failure('injected_load_failure', `Explicit test failure at ${point}.`);
    }
  }

  function capture() {
    assertReady();
    // Validate whichever cell is loaded. A density scene has no
    // `structure`, and reaching for one here threw a TypeError before the
    // `rich_scene_not_transportable` refusal two lines below could be read.
    checkDrawnRecord({ structure, volume, representation }, failure);
    const scene = liveScene();
    // Inspection mode owns background, marker colors and placement even when
    // its molecule happens to use an otherwise legacy-compatible representation.
    // The old envelope must never silently discard those scene fields.
    if (inspectionState) throw failure('rich_scene_not_transportable', 'Use inspection.capture() for a rich local inspection; the transport scene cannot represent it.');
    if (scene.modelNumber === null || scene.assemblyId === null || scene.color !== 'chain-id') {
      throw failure('unsupported_scene', 'The live scene no longer matches the lab capture contract.');
    }
    representationName(scene.representation);
    scene.camera = cameraSnapshot(scene.camera);
    return detached(scene);
  }

  // Only the desktop panel uses CSS-pixel annotation sizing. The companion
  // page keeps its existing flat/XR label sizes and depth-bearing strokes.
  // Reserve the desktop's floating tool row and two-line caption/legend; these
  // CSS-pixel insets avoid frame-by-frame DOM layout reads and camera changes.
  const sizeDesktopAnnotations = createDesktopAnnotationSizing({ enabled: !enableXr, topInset: 48, bottomInset: 48 });
  let desktopComponentAnnotations = [], desktopComponentRefs = [], annotationStateChanged = true;
  const annotationRefsScratch = [];
  const annotationStateSubscription = plugin.state.data.events.changed.subscribe(() => { annotationStateChanged = true; });
  const refreshDesktopAnnotations = renderCamera => {
    if (typeof measurementLines !== 'undefined') measurementLines.tick(renderCamera);
    if (enableXr) return;
    // Plate ownership is published after the state-tree build event. Check
    // both, with borrowed scratch, so new plates appear on their first draw.
    componentLabels.refs(annotationRefsScratch);
    let refsChanged = desktopComponentRefs.length !== annotationRefsScratch.length;
    for (let i = 0; !refsChanged && i < annotationRefsScratch.length; i++)
      refsChanged = desktopComponentRefs[i] !== annotationRefsScratch[i];
    if (annotationStateChanged || refsChanged) {
      desktopComponentRefs = annotationRefsScratch.slice();
      desktopComponentAnnotations = componentLabelRepresentations(desktopComponentRefs);
      annotationStateChanged = false;
    }
    if (sizeDesktopAnnotations(canvas, lessonFigure.annotations(), desktopComponentAnnotations,
      molecularAnimation.tetherRepresentations())) canvas.requestDraw();
  };
  // After the current pose and camera update, before culling and drawing.
  const annotationRenderSubscription = (canvas.beforeRender ?? canvas.camera.changed).subscribe(refreshDesktopAnnotations);
  canvas.notifyDidDraw = true;
  let initialDrawEmission = true;
  const drawSubscription = canvas.didDraw.subscribe(timestamp => {
    if (initialDrawEmission) { initialDrawEmission = false; return; }
    // Unpatched lab canvases retain their legacy refresh path.
    if (!canvas.beforeRender) refreshDesktopAnnotations();
    state.drawCount += 1;
    state.lastDrawTimestampMs = timestamp;
  });

  // Preparation waits only pace uploads; they never issue a rendered receipt.
  function yieldUploadFrame(deadline = Infinity, check = assertContext) {
    check();
    return new Promise((resolve, reject) => {
      let subscription, continuation;
      const previous = state.drawCount;
      const settle = error => {
        clearTimeout(timer); clearTimeout(continuation);
        subscription?.unsubscribe(); frameWaiters.delete(settle);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => settle(failure('render_timeout', 'The replacement upload did not produce a frame within the render deadline.')),
        Math.max(0, Math.min(canvas.xr.isPresenting.value ? XR_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS, deadline - now())));
      frameWaiters.add(settle);
      subscription = canvas.didDraw.subscribe(() => {
        if (state.drawCount <= previous || canvas.commitQueueSize.value !== 0) return;
        subscription?.unsubscribe();
        // Leave the XR callback AND its microtask checkpoint before preparing
        // the next chunk. No synchronous rebuild runs inside requestAnimationFrame.
        continuation = setTimeout(() => settle(), 0);
      });
      canvas.requestDraw();
    });
  }

  async function commitRepresentationUpdate(builder, check = assertContext) {
    if (!canvas.xr.isPresenting.value) return builder.commit({ revertOnError: true });
    const guard = transitionGuard(check);
    await new Promise(resolve => setTimeout(resolve, 0));
    return runTransitionTask(plugin.state.data.updateTree(builder, { revertOnError: true }), guard);
  }

  function transitionGuard(check) {
    const session = currentXrSession(), generation = state.generation;
    return () => {
      check();
      if (!canvas.xr.isPresenting.value || currentXrSession() !== session || state.generation !== generation) {
        throw failure('stale_transition', 'The XR session or molecular source changed during replacement.');
      }
    };
  }

  async function prepareUploads(next, check = assertContext) {
    if (!canvas.xr.isPresenting.value) return;
    const deadline = now() + XR_FRAME_TIMEOUT_MS, guard = transitionGuard(check);
    return prepareRepresentationUploads({ canvas, representation: next, yieldFrame: () => yieldUploadFrame(deadline, check), check: () => {
      guard();
      if (now() >= deadline) throw failure('render_timeout', 'The replacement geometry upload exceeded the render deadline.');
    } });
  }

  async function buildTransitionCell(builder, check) {
    const selector = builder.selector;
    await commitRepresentationUpdate(builder, check);
    return selector;
  }

  function waitForFrame(record = retainCurrent(), { recovering = false, inputLifecycle, onDraw } = {}) {
    assertContext({ recovering });
    inputLifecycle?.check();
    immersiveSession?.syncBounds();
    const previous = state.drawCount;
    return new Promise((resolve, reject) => {
      let subscription, timer, unsubscribeLifecycle, settled = false;
      const settle = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeLifecycle?.();
        subscription?.unsubscribe();
        frameWaiters.delete(settle);
        if (error) reject(error); else resolve(result);
      };
      const presentingWait = Boolean(canvas.xr.isPresenting.value);
      const timeoutMs = presentingWait ? XR_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS;
      const expire = () => {
        try {
          const repr = record?.representation?.obj?.data?.repr;
          const objects = new Set(canvas.getRenderObjects());
          const detail = {
            expectedRepresentations: scientificRepresentationCount() + xrPresentationRepresentationCount,
            reprCount: canvas.reprCount.value, commitQueueSize: canvas.commitQueueSize.value,
            visible: Boolean(repr?.state?.visible), renderObjectCount: repr?.renderObjects?.length ?? 0,
            allObjectsPresent: Boolean(repr?.renderObjects?.every(object => objects.has(object))),
            drawCounts: (repr?.renderObjects ?? []).map(object => object.values?.drawCount?.ref?.value ?? 0),
          };
          console.error('[stereofold] render timeout', detail);
          // The headset has no console anyone can read, and this is the one
          // reading that says whether a stalled swap was waiting on a draw or
          // on a representation count the spatial toolbar was still changing.
          globalThis.__stereofoldDiagnostics?.record?.('render-timeout',
            { ...detail, presenting: presentingWait, waitedMs: timeoutMs, phase: state.replacementPhase });
        } catch (diagnosticError) { console.error('[stereofold] render timeout diagnostics failed', diagnosticError); }
        settle(failure('render_timeout',
          `The molecular change did not produce a frame within ${Math.round(timeoutMs / 1000)} seconds.`));
      };
      let remaining = timeoutMs, timerStarted;
      const updateDeadline = () => {
        if (settled) return;
        if (timer !== undefined) {
          clearTimeout(timer); timer = undefined;
          remaining = Math.max(0, remaining - (now() - timerStarted));
        }
        try { inputLifecycle?.check(); } catch (error) { settle(error); return; }
        if (!inputLifecycle?.blind) { timerStarted = now(); timer = setTimeout(expire, remaining); }
      };
      settle.representationRef = record?.representation?.ref;
      frameWaiters.add(settle);
      unsubscribeLifecycle = inputLifecycle?.subscribe(updateDeadline);
      updateDeadline();
      subscription = canvas.didDraw.subscribe(() => {
        if (state.drawCount <= previous) return;
        try {
          inputLifecycle?.check();
          if (inputLifecycle?.blind) return;
          assertContext({ recovering });
          // The swap that a density scene used to fail on.
          // `record` here is the candidate `showCandidate` is
          // revealing, and a density candidate has a `volume` where an atomic
          // one has a `structure`; `checkDrawnRecord` validates the cell that is
          // actually there. Everything below is geometry-agnostic already — an
          // isosurface is a representation with render objects like any other.
          checkDrawnRecord(record, failure);
          const animationRegistry = typeof molecularAnimation === 'undefined' ? undefined : molecularAnimation;
          const replacedBase = animationRegistry?.replaces(record?.representation?.obj?.data?.repr)
            || animationRegistry?.owns(record?.representation?.obj?.data?.repr);
          if (replacedBase && (canvas.commitQueueSize.value !== 0
            || canvas.reprCount.value !== scientificRepresentationCount() + xrPresentationRepresentationCount
            || !animationRegistry.drawn(new Set(canvas.getRenderObjects())))) return;
          if (!replacedBase && !drawnRecordIsVisible(record, {
            renderObjects: canvas.getRenderObjects(),
            reprCount: canvas.reprCount.value,
            expectedRepresentations: scientificRepresentationCount() + xrPresentationRepresentationCount,
            commitQueueSize: canvas.commitQueueSize.value,
          })) return;
          const objects = new Set(canvas.getRenderObjects());
          if (styleLayers.some(layer => {
            const repr = layer.representation?.obj?.data?.repr;
            if (animationRegistry?.replaces(repr) || animationRegistry?.owns(repr)) return !animationRegistry.drawn(objects);
            return !repr?.state?.visible || !repr.renderObjects?.every(object => objects.has(object))
              || !drawnRecordIsVisible(layer, { renderObjects: objects, reprCount: canvas.reprCount.value,
                expectedRepresentations: scientificRepresentationCount() + xrPresentationRepresentationCount, commitQueueSize: canvas.commitQueueSize.value });
          })) return;
          if (typeof measurementLines !== 'undefined' && !measurementLines.drawn(objects)) return;
          if (!lessonFigure.drawn(objects, repr => animationRegistry?.replaces(repr) || animationRegistry?.owns(repr))) return;
          if (companionRecord) {
            checkDrawnRecord(companionRecord,failure);
            const objects=new Set(canvas.getRenderObjects());
            if (!companionRecord.representation.obj.data.repr.renderObjects.every(object=>objects.has(object))) return;
            if (!drawnRecordIsVisible(companionRecord, { renderObjects: objects, reprCount: canvas.reprCount.value,
              expectedRepresentations: scientificRepresentationCount() + xrPresentationRepresentationCount, commitQueueSize: canvas.commitQueueSize.value })) return;
          }
          settle(undefined, onDraw?.());
        } catch (error) {
          try { globalThis.__stereofoldDiagnostics?.record?.('frame-record-failure', {
            message: String(error?.message ?? error).replace(/(?:https?|wss?):\/\/[^\s)]+/gu, '<runtime>'),
            stack: String(error?.stack ?? '').replace(/(?:https?|wss?):\/\/[^\s)]+/gu,
              url => `<runtime>${url.match(/:\d+:\d+$/u)?.[0] ?? ''}`),
            expectedStructureRef: record?.structure?.ref ?? record?.volume?.ref,
            expectedRepresentationRef: record?.representation?.ref,
            expectedRepresentationPresent: Boolean(record?.representation?.obj),
            currentRepresentationRef: representation?.ref,
            currentRepresentationPresent: Boolean(representation?.obj),
          }); } catch { /* Diagnostics never replace the original failure. */ }
          settle(error);
        }
      });
      canvas.requestDraw();
    });
  }

  function emit(callback, ...args) {
    // These observers receive snapshots only after the molecular frame gate.
    // Publish the same committed state before asking the plate to redraw.
    if (callback === onMutation || callback === onSelection) {
      try { refreshStructureSubject(args.at(-1)); } catch (error) { console.error(error); }
    }
    // Observer errors must not recategorize a frame that has already rendered.
    try { Promise.resolve(callback(...args)).catch(error => console.error(error)); }
    catch (error) { console.error(error); }
  }

  async function mutate(kind, operation, { allowInteraction = false, presentationFreeze: freezingPresentation = false, afterCommit, changedLayers = [kind], operationKind = kind, inputLifecycle, lessonCheckpoint, desktopPreviewCheckpoint, animationInstalled = false, mutationOrigin } = {}) {
    assertReady();
    inputLifecycle?.check();
    if (!allowInteraction && !(typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0) && interactionActive()) throw failure('interaction_active', 'Release the molecular drag before applying a change.');
    if (inspectionState && !freezingPresentation) { motionMutationPaused = true; if (mutationOrigin !== 'automatic-clearance' && mutationOrigin !== 'xr-entry') motionToolPaused = true; syncPresentationMotion(); }
    const began = now();
    let committedAt;
    const previous = retainCurrent();
    if (previous && desktopPreviewCheckpoint) previous.desktopPreview = desktopPreviewCheckpoint;
    // Some callers publish provisional lesson intent before admission so the
    // successful observer sees its new ownership. Recovery owns the intent
    // before that change, alongside the retained molecular geometry.
    if (previous?.lesson && lessonCheckpoint) {
      if (Object.hasOwn(lessonCheckpoint, 'emphasis')) previous.lesson.emphasis = detached(lessonCheckpoint.emphasis);
      if (Object.hasOwn(lessonCheckpoint, 'origin')) previous.lesson.origin = lessonCheckpoint.origin;
      if (Object.hasOwn(lessonCheckpoint, 'labels') && previous.lesson.resting) previous.lesson.resting.labels = lessonCheckpoint.labels;
    }
    const work = beginWork(previous);
    busy = true;
    state.status = 'mutating';
    try {
      await operation();
      if (!animationInstalled && typeof molecularAnimation !== 'undefined') await molecularAnimation.refresh();
      inputLifecycle?.check();
      // Recovery may also arrive through undo/restore/appearance. Prove the
      // retained pose before restoring its render objects to the frame gate.
      if (typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden) {
        await clearHeldPlatePlacement(inspectionSnapshot().placement, { keepWearer: true, kind: 'retained-pose', signal: inputLifecycle?.signal });
        inputLifecycle?.check();
        showRetainedPose();
      }
      assertContext();
      committedAt = now();
      canvas.commit(!canvas.xr.isPresenting.value);
      afterCommit?.();
      await waitForFrame(undefined, { inputLifecycle });
      inputLifecycle?.check();
      assertContext();
      recordRenderCost(operationKind, began, committedAt, changedLayers);
      state.revision += 1;
      state.mutationCounts[kind] += 1;
      state.status = 'ready';
      busy = false;
      if (canvas.xr.isPresenting.value && typeof talkCaption !== 'undefined') {
        try { talkCaption?.invalidate?.(); } catch (error) {
          recordCost('talk-caption-seat', { outcome: 'failed', error: error?.message ?? String(error) });
        }
      }
      const result = snapshot();
      emit(onMutation, mutationOrigin ? { ...result, mutationOrigin } : result);
      return result;
    } catch (error) {
      if (error?.code === 'xr_input_ended' || error?.code === 'appearance_cancelled') {
        busy = false;
        if (state.status === 'mutating') state.status = canvas.webgl.isContextLost ? 'context_lost' : 'ready';
        throw error;
      }
      recordRenderCost(operationKind, began, undefined, changedLayers, 'failed');
      busy = false;
      if (state.status !== 'disposed') {
        state.status = canvas.webgl.isContextLost || ['context_lost', 'recovering'].includes(state.status) ? 'context_lost' : 'error';
        state.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      work.finish();
      if (inspectionState && !freezingPresentation) { motionMutationPaused = false; syncPresentationMotion(); }
    }
  }

  function selectedKeys(keys, adapter = selection) {
    if (!Array.isArray(keys) || !Array.from(keys).every(key => typeof key === 'string')) {
      throw failure('invalid_selection', 'Selection keys must be an array of catalog residue keys.');
    }
    const copy = [...keys];
    // A density tier has no selection adapter, because it has no
    // residues. An empty ask is the honest answer to "what is selected" on one;
    // a named ask is a real mistake and says so rather than throwing a
    // TypeError out of the adapter that is not there.
    if (!adapter) {
      if (copy.length) throw failure('invalid_selection', 'This scene is a density map and has no residues to select.');
      return [];
    }
    adapter.toLoci(copy); // Validate source, model, assembly and missing rows.
    const wanted = new Set(copy);
    return adapter.rows.filter(row => wanted.has(row.key)).map(row => row.key);
  }

  function markSelection(keys) {
    // The SAVED selection is every key the wearer picked, and
    // hiding a chain does not unpick it — a show brings the highlight back
    // without the agent having to reselect anything. What the marker pass sees
    // is only the visible half, because a selection edge drawn over atoms that
    // are not on screen is the "hidden" chain still glowing in the headset.
    // A selection the lesson made is marked by its colour key alone, here as
    // in the overpaint, so the flat viewer's tint does not shift that colour.
    if (typeof lessonSelection !== 'undefined' && selectionSignature(keys) !== lessonSelection) lessonSelection = undefined;
    const hidden = hiddenSceneKeySet(keys);
    if (typeof lessonSelection !== 'undefined') {
      const marked = new Set(currentSelectionPlan(keys)?.keys ?? keys);
      for (const key of keys) if (!marked.has(key)) hidden.add(key);
    }
    const styled = new Set(stylesState.flatMap(style => style.selectionKeys));
    markRecord(retainCurrent(), keys.filter(key => !hidden.has(key) && !styled.has(key)));
    const shown = hidden.size ? keys.filter(key => !hidden.has(key)) : keys;
    for (const layer of styleLayers) {
      const repr = layer.representation?.obj?.data?.repr;
      if (!repr) continue;
      const loci = StructureElement.Loci.remap(selection.toLoci(shown), layer.component.obj.data);
      canvas.mark({ repr, loci: EveryLoci }, MarkerAction.Deselect);
      canvas.mark({ repr, loci }, MarkerAction.Select);
    }
    state.selectionKeys = [...keys];
  }

  function placementTransform(placement) {
    const radians = placement.rotation.map(value => value * Math.PI / 180);
    const x = Mat4.fromRotation(Mat4(), radians[0], Vec3.create(1, 0, 0));
    const y = Mat4.fromRotation(Mat4(), radians[1], Vec3.create(0, 1, 0));
    const z = Mat4.fromRotation(Mat4(), radians[2], Vec3.create(0, 0, 1));
    const scale = Mat4.fromScaling(Mat4(), Vec3.create(placement.scale, placement.scale, placement.scale));
    const rotation = Mat4.mul(Mat4(), z, Mat4.mul(Mat4(), y, x));
    const local = Mat4.mul(Mat4(), rotation, scale);
    // Translation is deliberately stored in molecular radii, so a view can be
    // reused across structures without exposing raw, source-dependent Angstroms.
    const radius = loadedSphere()?.radius ?? 1;
    const center = loadedSphere()?.center ?? Vec3.create(0, 0, 0);
    const offset = Vec3.create(...placement.translation.map(value => value * radius));
    const toCenter = Mat4.fromTranslation(Mat4(), Vec3.add(Vec3(), center, offset));
    const fromCenter = Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), center));
    return Mat4.mul3(Mat4(), toCenter, local, fromCenter);
  }

  async function placeRoomTarget(target) {
    assertReady();
    if (!canvas.xr.isPresenting.value || performance.now() - latestHeadSample >= 1500 || !latestRoomPlacementPose)
      throw Error('Enter VR and wait for tracking before placing the structure in your room.');
    const sphere = loadedSphere();
    // "Above us" is the wearer's own re-anchor. Once the
    // room's floor is known it sets the height, so a wearer who sits down and
    // presses again gets the same real height, not one measured from their head.
    const floorY = roomAnchor?.floorY() ?? null;
    // `entry` is the B button, and it is the same seat the wearer
    // gets on entering VR, so a structure lost behind them comes back large,
    // in front and above the eye line rather than to a different pose.
    const grounded = target === 'entry' ? roomAnchorPlacement({ mode: 'auto', floorY, sphere })
      : target === 'overhead' && Number.isFinite(floorY)
        ? roomAnchorPlacement({ mode: 'overhead', floorY, sphere }) : null;
    const placement = grounded ?? roomPlacement({ ...latestRoomPlacementPose, cameraScale: canvas.camera.scale, center: sphere.center, radius: sphere.radius, target });
    await setInspectionMotion({ paused: true });
    const applied = await placeInspection({ translation: placement.translation, scale: placement.scale }, 'place', { wearer: true });
    // The receipt is in hand: the transform is applied and the render returned.
    // Only now may the plate say where the structure is.
    notePlacement(inspectionSnapshot().placement);
    void roomAnchor?.applied({ roomPoint: grounded?.roomPoint, wearerRequested: true })?.catch?.(() => {});
    wearerPlacedInRoom = true; // Remembered past this XR session.
    // "Above us" and "In reach" are the wearer choosing a place.
    // `entry` is the seat itself, which is the wearer asking for the authored
    // one back rather than choosing over it.
    if (target === 'entry') releaseWearerPlacement('entry-seat');
    else takeWearerPlacement('menu');
    return applied;
  }

  /** The monumental placement for the room this session is in. */
  function roomAnchorPlacement({ mode, floorY, sphere, resetMenu = false, bounded = false }) {
    // Read unplaced part bounds once; candidates use the same rotation, names,
    // font measurement and projection as the label rebuild after placement.
    const named = new Map(emphasisState.parts.map(part => [part.id, part]));
    const parts = componentLabelsWanted() ? componentLabelPlateParts(currentEmphasisPlan())
      .slice(0, COMPONENT_LABEL_LIMIT).flatMap(part => {
        const label = named.get(part.id)?.label;
        if (!label || !part.keys.length) return [];
        const loci = selection.toLoci(part.keys);
        const bounds = componentLabelBounds(loci);
        return bounds ? [{ text: componentPlateName(label), bounds }] : [];
      }) : [];
    // The candidate is measured from the tracked head, which is
    // where the seat stands it. `canvas.camera` is the room origin in XR, and a
    // head off that origin made the cap shrink a centred seat to fit beside
    // its own offset (first entry: scale 0.68 for 1.90, plates at
    // the far left). `headViewBasis` carries the evidence.
    const view = componentLabelViewBasis();
    const rotation = inspectionSnapshot().placement.rotation;
    const measureSeat = candidate => {
      const transform = placementTransform({ ...candidate, rotation });
      const sizing = xrLabelSizing(LABEL_CHARACTER_DEGREES.comfortable,
        candidate.scale, candidate.standoffMeters);
      return measurePlateSeat({
        plates: parts.map(({ text, bounds }) => ({ text,
          anchor: Array.from(Vec3.transformMat4(Vec3(), bounds.center, transform)),
          radius: bounds.radius * candidate.scale })),
        subject: { anchor: Array.from(Vec3.transformMat4(Vec3(), sphere.center, transform)),
          radius: sphere.radius * candidate.scale },
        eye: view.eye, target: view.target, up: view.up,
        characterUnits: sizing.characterUnits, measureText: componentLabelTextWidth,
      });
    };
    if (resetMenu && !roomEntry?.seat) throw Error('Could not reset: the entry seat has not rendered yet. Wait for the structure to appear.');
    if (!(latestRoomPlacementPose?.labelViews?.length === 2 || (latestRoomPlacementPose?.labelViews?.length === 1 && latestRoomPlacementPose?.labelViews[0]?.eye === 'none')))
      throw Error('Both eye views are needed before placing the structure in the room.');
    const menuPoints = immersiveSession?.toolbarPlacementPoints?.({ ...latestRoomPlacementPose, resetMenu }) ?? [];
    const entry = resetMenu ? roomEntry.seat : placementFromRoom({ ...latestRoomPlacementPose, mode, floorY, measureSeat,
      cameraScale: canvas.camera.scale, center: sphere.center, radius: sphere.radius,
      siteCount: structureAtomSites(plugin), deviceClass: sessionDeviceClass(canvas.webgl.xr?.session, globalThis.navigator) });
    const entryPlacementCandidate = resetMenu ? entry : null;
    // roomEntry is session-scoped and its seat is deleted on source adoption.
    // Only the accepted entry target may bypass the preferred centre band;
    // the solver still proves zero motion, full eye visibility and menu clearance.
    const retainFreeFieldSeat = Boolean(canvas.xr.isPresenting.value && roomEntry?.seat && entryPlacementCandidate
      && typeof wearerPlacement !== 'undefined' && !wearerPlacement.holdsPlacement()
      && Number.isFinite(entryPlacementCandidate.scale) && entryPlacementCandidate.scale === roomEntry.seat.scale
      && ['rotation', 'translation'].every(key => entryPlacementCandidate[key]?.length === 3
        && entryPlacementCandidate[key].every((value, axis) => Number.isFinite(value) && value === roomEntry.seat[key]?.[axis])));
    const menuCandidates = immersiveSession?.toolbarRelocationCandidates?.(latestRoomPlacementPose) ?? [];
    let placement = resetViewPlacement({ seat: entry, centered: resetMenu, bounded, fit: true, recoverVisible: true, menuCandidates,
      retainFreeFieldSeat,
      geometry: (latestRoomPlacementPose.labelViews?.length === 2 || (latestRoomPlacementPose.labelViews?.length === 1 && latestRoomPlacementPose.labelViews[0]?.eye === 'none')) ? {
        objects: typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden ? retainedFitObjects()
          : scientificRepresentations(true).flatMap(repr => repr.renderObjects).filter(object => object.type !== 'text'),
        fromPlacement: presentationTransform(), toPlacement: placementTransform({ ...entry, rotation: entry.rotation ?? rotation }),
        views: latestRoomPlacementPose.labelViews,
      } : undefined,
      points: menuPoints,
      ...latestRoomPlacementPose, cameraScale: canvas.camera.scale, center: sphere.center, radius: sphere.radius });
    // A clear retained seat can be a plain saved pose: the solver intentionally
    // returns it without moving or fitting. Restore only missing measurements
    // from that accepted pose in today's room/camera units, not an old seat.
    if (placement.menuRelocation !== undefined)
      placement.menuCandidate = menuCandidates.find(candidate => candidate.id === placement.menuRelocation)
        ?? { id: 'hidden', hide: true, baseline: JSON.stringify(immersiveSession?.platePoints?.() ?? []) };
    const hasRoomPoint = placement.roomPoint?.length === 3 && placement.roomPoint.every(Number.isFinite);
    if (!hasRoomPoint || !(Number.isFinite(placement.metersAcross) && placement.metersAcross > 0)
      || !(Number.isFinite(placement.standoffMeters) && placement.standoffMeters > 0) || !placement.mode) {
      const actualRoomPoint = Array.from(Vec3.transformMat4(Vec3(), Vec3.create(...sphere.center.map((value, axis) =>
        (value + placement.translation[axis] * sphere.radius) * canvas.camera.scale)),
      Mat4.invert(Mat4(), latestRoomPlacementPose.renderFromRoom)));
      const head = latestRoomPlacementPose.headInRoom;
      const depth = actualRoomPoint.reduce((sum, value, axis) => sum
        + (value - head[12 + axis]) * -head[8 + axis], 0);
      placement = { ...placement,
        roomPoint: hasRoomPoint ? placement.roomPoint : actualRoomPoint,
        metersAcross: Number.isFinite(placement.metersAcross) && placement.metersAcross > 0
          ? placement.metersAcross : 2 * sphere.radius * canvas.camera.scale * placement.scale,
        standoffMeters: Number.isFinite(placement.standoffMeters) && placement.standoffMeters > 0
          ? placement.standoffMeters : depth,
        mode: placement.mode || mode };
    }
    // The stand-off this seat used is the distance a label has
    // to be legible at, and it is the only measured distance in the viewer. It
    // is remembered rather than passed, because the labels are rebuilt from
    // several places that never see a placement -- a selection change, an
    // appearance rebuild, a chapter's colour key -- and all of them want the
    // seat the wearer is actually sitting at.
    if (Number.isFinite(placement?.standoffMeters) && placement.standoffMeters > 0) {
      latestSeatStandoffMeters = placement.standoffMeters;
    }
    latestPlateSeat = placement.plateSeat ?? null;
    // Keep the cap frame through anchor creation, placement and label deletes.
    view.plateSeat = latestPlateSeat;
    return { ...placement, seatBasis: view };
  }

  async function applySeatMenuRecovery(seat) {
    if (!seat?.menuCandidate) return;
    const candidate = { ...seat.menuCandidate, recovery: seat.menuRecovery === true };
    if (!immersiveSession?.relocateToolbar) throw Error('The menu could not apply its checked recovery seat.');
    const receipt = await immersiveSession.relocateToolbar(candidate);
    if (seat.menuRecovery) {
      recordManipulation('outcome', { status: 'adjusted', action: 'fit', reason: 'Controls hidden to show the structure. B/Y brings them back.' });
    }
    return receipt;
  }

  /** Every automatic entry starts without the previous session's pose or cap. */
  function beginRoomEntry(presenting) {
    if (!presenting && typeof rejectPlacementViews === 'function') rejectPlacementViews('The headset session ended before placement could be measured.');
    if (!presenting && typeof showRetainedPose === 'function') showRetainedPose();
    if (typeof retainedEntryCheckPending !== 'undefined') retainedEntryCheckPending = presenting && wearerPlacedInRoom;
    if (presenting && typeof retainedEntryCheckPending !== 'undefined'
      && typeof scientificRepresentations === 'function' && canvas.remove) {
      for (const repr of scientificRepresentations(true)) canvas.remove(repr);
      retainedPoseHidden = true;
      canvas.commit(false);
    }
    if (!presenting && roomEntry?.seat && !busy && state.status === 'ready') {
      roomSeatMemory.remember({ scene: liveScene(), placement: inspectionSnapshot().placement,
        cameraScale: roomEntry.cameraScale, camera: cameraSnapshot(canvas.camera.getSnapshot()) });
    }
    roomAnchor?.release();
    roomAnchor = presenting && roomAnchorEnabled() ? createRoomAnchor({ wearerPlaced: wearerPlacedInRoom }) : null;
    latestRoomPlacementPose = null;
    latestHeadContext = null; latestHeadSample = 0;
    placementNote = null; entryRoomPoint = null;
    // Anchor tracking is optional; each XR entry still owns a capped seat.
    roomEntry = presenting ? {} : null;
    pendingRoomSeat = Boolean(roomEntry && !wearerPlacedInRoom);
    pendingRoomLabels = Boolean(roomEntry && wearerPlacedInRoom);
    pendingRoomLabelBasis = null;
    if (!wearerPlacedInRoom) { latestPlateSeat = null; latestSeatStandoffMeters = null; }
    menuResolveReason = null;
  }

  /** Seat once from the tracked head; the `above` mode also works without a floor.
   * Pin while `frame` is live, then publish the labels after placement commits.
   *
   * On a Quest 2 (tubulin-eb3-lattice with the full
   * menu open): this runs on every XR frame until the entry seat commits, and
   * a seat the solver refused was caught, logged, and solved again on the
   * next frame. The solve is the dear part of a frame, the whole structure's
   * geometry against both label views and the menu glass, so an entry that
   * could not fit held the page at 1.3 fps with 450 ms gaps, the menu re-laid
   * on every attempt, and the molecule left wherever the reload had restored
   * it, under that menu. A refusal is an outcome, not a retry: after the
   * stereo solver has exhausted depth, lateral, vertical and scale fits, the
   * restored placement stands. The entry is marked, the wearer is
   * told once, and nothing is solved again until Fit, Reset or the next XR
   * entry. Any other error keeps its old path: logged, tried again.
   */
  function settleInRoom(frame, space) {
    const anchor = roomAnchor, entry = roomEntry;
    const generation = adoptionGeneration;
    if (!entry || entry.seatRefusal || settlingRoomAnchor === entry || busy || state.status !== 'ready' || interactionActive()) return;
    try {
      const sphere = loadedSphere();
      if (!sphere || !inspectionState || !(latestRoomPlacementPose?.labelViews?.length === 2 || (latestRoomPlacementPose?.labelViews?.length === 1 && latestRoomPlacementPose?.labelViews[0]?.eye === 'none'))) return;
      const floorY = anchor?.floorY() ?? null;
      const refusal = error => typeof error?.message === 'string' && error.message.startsWith('Could not reset:');
      let placement;
      try { placement = roomAnchorPlacement({ mode: 'auto', floorY, sphere }); }
      catch (error) {
        if (!refusal(error)) throw error;
        const reason = error.message;
        entry.seatRefusal = reason;
        pendingRoomSeat = false;
        checkRetainedEntryPose();
        const text = retainedEntryCheckPending ? 'Checking your saved placement against the menu…'
          : `Kept your view: ${reason.replace(/^Could not reset: /u, '')}`;
        try { recordManipulation('outcome', { status: 'refused', action: 'entry-seat', reason }); } catch { /* best effort */ }
        try { globalThis.__stereofoldDiagnostics?.record?.('room-seat', { status: 'refused', reason }); } catch { /* best effort */ }
        try { talkCaption?.set({ outcome: text, holdMs: 6000, complete: true }); } catch { /* best effort */ }
        return;
      }
      const pinned = anchor?.applied({ frame, space, roomPoint: placement.roomPoint });
      settlingRoomAnchor = entry;
      return (async () => {
        const wasHidden = typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden;
        if (typeof applySeatMenuRecovery === 'function') await applySeatMenuRecovery(placement);
        if (!wasHidden) await setInspectionMotion({ paused: true });
        if (roomEntry !== entry) return;
        await placeInspection({ translation: placement.translation, scale: placement.scale }, 'entry-seat');
        if (wasHidden) await setInspectionMotion({ paused: true });
        await pinned;
        if (roomEntry !== entry) return;
        pendingRoomSeat = false;
        if (!entry.seat && generation === adoptionGeneration) {
          entry.seat = structuredClone(inspectionSnapshot().placement);
          entryRoomPoint = [...placement.roomPoint];
        }
        // A placement only transforms existing plates. Solve and size them
        // after the seat commits, including on the very first session.
        // Adoption can keep this entry while changing the source's scene units.
        // Sample a fresh basis if it did, and let an adoption build already
        // completed for the new source satisfy this request without rebuilding.
        const adopted = generation !== adoptionGeneration;
        await rebuildComponentLabels(undefined, adopted ? undefined : placement.seatBasis, { force: !adopted });
        // The entry mutation is published before this seat and its labels
        // finish. The toolbar's initial draw must also finish before a chapter
        // replaces it, or that startup draw can retire the new caption card.
        if (typeof immersiveSession !== 'undefined') {
          await immersiveSession?.whenReady?.();
          // Startup may have hidden the controls against the outgoing desktop
          // pose. Admit them again against the committed plain entry seat.
          if (!spatialTour?.getState?.()?.selectedId) await immersiveSession?.refreshToolbar?.({ recheckClearance: true });
        }
        if (roomEntry === entry && generation === adoptionGeneration && typeof spatialTour !== 'undefined')
          await (spatialTour?.current?.() ?? spatialTour)?.frameXrEntry?.();
      })().catch(error => console.error(error)).finally(() => {
        if (settlingRoomAnchor === entry) settlingRoomAnchor = null;
      });
    } catch (error) { console.error(error); }
  }

  function catalogVisibleBounds(catalog, visible) {
    return cachedVisibleStageBounds(catalog, visible);
  }

  function molecularBounds(includeCompanion = false, excludeAnnotations = false) {
    // Desktop Fit can omit label padding without changing the bounds contract
    // used by existing room-entry and placement callers.
    const helper = new BoundaryHelper('98'), spheres = [];
    for (const repr of scientificRepresentations(includeCompanion)) {
      for (const object of repr?.renderObjects ?? []) {
        if (excludeAnnotations && (object.type === 'text' || object.type === 'image'
          || object.values.alpha?.ref.value === 0 || object.state.alphaFactor === 0)) continue;
        const sphere = object.values.boundingSphere?.ref.value;
        if (object.state.visible && object.values.drawCount.ref.value && sphere?.radius > 0) spheres.push(sphere);
      }
    }
    helper.reset();
    for (const sphere of spheres) helper.includeSphere(sphere);
    helper.finishedIncludeStep();
    for (const sphere of spheres) helper.radiusSphere(sphere);
    return helper.getSphere();
  }

  /**
   * Every Mol* representation this viewer builds over the molecule itself.
   *
   * The ligand overlay joined the structure and the residue
   * labels here, so the three callers that had the pair written out inline —
   * the render wait's representation-count invariant, the molecular bounds and
   * the presentation transform — all count and carry it without knowing it
   * exists.
   */
  function scientificRepresentations(includeCompanion = false, templates = false) {
    const representations = [representation?.obj?.data?.repr, ligandOverlay?.representation?.obj?.data?.repr,
      ...(includeCompanion ? [companionRecord?.representation?.obj?.data?.repr] : []),
      ...styleLayers.map(layer => layer.representation?.obj?.data?.repr),
      ...lessonFigure.molecular(),
      inspectionLabel?.representation?.obj?.data?.repr,
      ...(inspectionLabel?.extraRepresentations ?? []).map(label => label.obj?.data?.repr)].filter(Boolean);
    if (templates || typeof molecularAnimation === 'undefined') return representations;
    return [...representations.filter(repr => !molecularAnimation.replaces(repr)), ...molecularAnimation.representations()];
  }

  /**
   * How many representations a finished draw must show.
   *
   * The structure always counts, whether or not it has committed yet, which is
   * why this is not `scientificRepresentations().length`.
   */
  function scientificRepresentationCount() {
    const live = ref => Boolean(ref) && plugin.state.data.cells.has(ref);
    // telomerge: each component name plate is a Mol* representation of its
    // own, so ten labels put `reprCount` at 11 against an expectation of 1 and
    // the frame wait timed out on the first telomerase hardware run while the
    // scene had in fact drawn. Count the plates that are live in the tree.
    return 1 + (typeof molecularAnimation === 'undefined' ? 0 : molecularAnimation.extraCount()) + retainedRepresentationCount + (inspectionState && live(inspectionLabel?.representation?.ref) ? 1 : 0)
      + (inspectionLabel?.extraRepresentations ?? []).filter(label => live(label.ref)).length
      + (live(ligandOverlay?.representation?.ref) ? 1 : 0)
      + styleLayers.filter(layer => live(layer.representation?.ref)).length
      + (companionRecord?.representation?.obj ? 1 : 0) + componentLabelRepresentations().length + lessonFigure.count() + (typeof measurementLines === 'undefined' ? 0 : measurementLines.representationCount());
  }

  /**
   * Take the ligand overlay off the molecule.
   *
   * Deleting the component deletes the representation hanging off it, exactly
   * as `removeInspectionLabels` does, so the emphasis layers built onto that
   * representation go with it and nothing is left addressing a dead ref.
   */
  /**
   * Forget an overlay or a label set the state tree has lost.
   *
   * Both records hold Mol* refs, and both outlive the cells behind them when
   * anything else deletes the subtree — a source replacement, a context-loss
   * recovery, a stock Mol* action in the workbench. `synchronizeRepresentation-
   * FromPlugin` already did exactly this check, but only the desktop workbench
   * ever calls it, so in a headset the records were never swept. Held here so
   * every paint and every rebuild starts from refs that exist.
   */
  function dropDeadOverlayRefs() {
    if (ligandOverlay && !plugin.state.data.cells.get(ligandOverlay.representation?.ref)) ligandOverlay = undefined;
    if (inspectionLabel && !plugin.state.data.cells.get(inspectionLabel.representation?.ref)) inspectionLabel = undefined;
  }

  async function removeLigandOverlay() {
    if (!ligandOverlay) return;
    const component = ligandOverlay.component;
    ligandOverlay = undefined;
    if (component?.ref && plugin.state.data.cells.has(component.ref)) {
      await plugin.state.data.build().delete(component.ref).commit({ revertOnError: true });
    }
  }

  async function removeInspectionLabels() {
    // Every recovery redraw passes through here, before any residue label is
    // built again. A second failed delete throws, so the recovery keeps its
    // error rather than reporting ready over an orphan label.
    for (const ref of [...strandedLabelRefs]) {
      if (plugin.state.data.cells.has(ref)) await plugin.state.data.build().delete(ref).commit({ revertOnError: true });
      strandedLabelRefs.delete(ref);
    }
    if (!inspectionLabel) return;
    const components = [inspectionLabel.component, ...(inspectionLabel.extraComponents ?? [])];
    inspectionLabel = undefined;
    // Retain every sibling for recovery if any deletion fails.
    for (const component of components) if (component?.ref) strandedLabelRefs.add(component.ref);
    for (const component of components) {
      if (component?.ref && plugin.state.data.cells.has(component.ref))
        await plugin.state.data.build().delete(component.ref).commit({ revertOnError: true });
      strandedLabelRefs.delete(component?.ref);
    }
  }

  function applyInspectionTransform(committedLabelRefs = componentLabels.refs()) {
    if (!inspectionState || !representation?.obj) return;
    const sampler = typeof immersiveSession === 'undefined' ? undefined : immersiveSession;
    const started = sampler?.beginTransform?.();
    try {
      const transform = presentationTransform();
      // The name plates ride the structure's own transform, so a
      // grabbed, spun or re-seated molecule keeps its names on its parts. They are
      // carried here rather than joined to `scientificRepresentations`, because
      // that list is also the render-wait invariant's count and the molecular
      // bounds, and a name plate is neither a representation the wearer is waiting
      // on nor a thing the camera should frame around.
      for (const repr of [...scientificRepresentations(), ...componentLabelRepresentations(committedLabelRefs), ...lessonFigure.annotations()]) {
        if (typeof molecularAnimation !== 'undefined' && molecularAnimation.owns(repr)) continue;
        repr.setState({ transform });
        updatePlacementBounds(repr);
        // setState changes Mol* value cells but does not emit repr.updated.
        // Refresh GPU attributes and world bounds used by picking, Fit and XR.
        canvas.update(repr, false);
      }
      if (typeof molecularAnimation !== 'undefined') molecularAnimation.apply({presentation:transform});
      if (companionRecord?.representation?.obj) {
        const repr = companionRecord.representation.obj.data.repr;
        repr.setState({transform:companionTransform(Mat4,Vec3,transform,loadedSphere(),
          companionRecord.structure.obj.data.boundary.sphere,companionRecord.companionState.placement)});
        updatePlacementBounds(repr);
        canvas.update(repr,false);
      }
    } finally { sampler?.endTransform?.(started); }
  }

  async function rebuildInspectionLabels() {
    if (!inspectionState) return;
    await removeInspectionLabels();
    const appearance = inspectionState.snapshot().appearance;
    if (!appearance.labels) return;
    // Nothing to label on a density map, and no adapter to ask.
    if (!selection) return;
    const selected = new Set(state.selectionKeys), rows = [];
    // A residue label is a billboard in front of the atoms it
    // names. Leaving one up over a hidden chain floats its identity in empty
    // space, which is the opposite of what the wearer asked for.
    const hidden = hiddenSceneKeySet();
    for (const row of selection.rows) {
      if (hidden.has(row.key)) continue;
      if (!selected.has(row.key) || row.coordinateState !== 'resolved' || !row.atomSites.length) continue;
      rows.push(row);
      if (rows.length === 32) break;
    }
    if (!rows.length) return;
    const loci = selection.toLoci(rows.map(row => row.key));
    const query = {
      label: `Selected residues (${rows.length}${state.selectionKeys.length > rows.length ? ` of ${state.selectionKeys.length}` : ''})`,
      referencesCurrent: true,
      getSelection: async () => StructureSelection.Singletons(loci.structure, StructureElement.Loci.toStructure(loci)),
    };
    const presenting = Boolean(canvas.xr.isPresenting.value);
    // A residue label obeys the same scale-aware gain as a name
    // plate. One size rule for every label the headset draws, or the two drift.
    const plateStyle = () => {
      const sizing = presenting
        ? xrLabelSizing(LABEL_CHARACTER_DEGREES.comfortable, inspectionSnapshot().placement.scale) : null;
      return { sizeFactor: sizing ? sizing.sizeFactor : DESKTOP_LABEL_SIZE_FACTOR, offsetZ: presenting ? 12 : 4,
        background: true, backgroundOpacity: 0.92, backgroundMargin: presenting ? 0.5 : 0.25,
        backgroundColor: Color(0x0c1418), borderWidth: 0.12, borderColor: Color(0x0c1418) };
    };
    // Labels on one stretch of one strand pile on one another at their own
    // residue centres, so they are one plate naming each of them; read
    // `residue-label-plates.mjs`. The plate is the same Mol* loci label the
    // name plates use, in this label's colours, size and push.
    const run = residueRunPlate(rows);
    if (run) {
      const ref = 'stereofold-inspection-selected-plate';
      const plate = await plugin.build().toRoot()
        .apply(StateTransforms.Model.MultiStructureSelectionFromBundle, {
          selections: [{ key: 'a', ref: structure.ref, bundle: StructureElement.Bundle.fromLoci(loci) }],
          isTransitive: true, label: query.label,
        }, { ref, dependsOn: [structure.ref] })
        .apply(StateTransforms.Representation.StructureSelectionsLabel3D, {
          ...plateStyle(), customText: run.text, textSize: 1, scaleByRadius: false,
          textColor: Color(colorNumber(appearance.highlightColor)),
          // A residue label's push clears one residue. This plate hangs at the
          // stretch's centre, inside the strand it names, so it takes the name
          // plates' stand-off to stay in front of that strand in the headset.
          ...(presenting ? { offsetZ: componentLabelOffsetZ(inspectionSnapshot().placement.scale) } : {}),
        }, { ref: `${ref}-text`, tags: ['stereofold-inspection-selected-labels'] })
        .commit({ revertOnError: true });
      inspectionLabel = { component: { ref }, representation: plate, plate: true };
      applyInspectionTransform();
      return;
    }
    if (presenting && rows.length > 1) {
      // Independent primitives let the per-eye plate solver separate arbitrary
      // residue names. One shared Mol* label primitive cannot move them apart.
      const update = plugin.build(), plates = [], components = [];
      const style = { ...plateStyle(), offsetZ: componentLabelOffsetZ(inspectionSnapshot().placement.scale) };
      for (const [index, row] of rows.entries()) {
        const ref = `stereofold-inspection-selected-plate-${index}`;
        const selected = selection.toLoci([row.key]);
        const component = update.toRoot().apply(StateTransforms.Model.MultiStructureSelectionFromBundle, {
          selections: [{ key: 'a', ref: structure.ref, bundle: StructureElement.Bundle.fromLoci(selected) }],
          isTransitive: true, label: residueLabelText(row.identity),
        }, { ref, dependsOn: [structure.ref] });
        plates.push(component.apply(StateTransforms.Representation.StructureSelectionsLabel3D, {
          ...style, customText: residueLabelText(row.identity), textSize: 1, scaleByRadius: false,
          textColor: Color(colorNumber(appearance.highlightColor)),
        }, { ref: `${ref}-text`, tags: ['stereofold-inspection-selected-labels'] }).selector);
        components.push({ ref });
      }
      await update.commit({ revertOnError: true });
      inspectionLabel = { component: components[0], representation: plates[0],
        extraComponents: components.slice(1), extraRepresentations: plates.slice(1), plate: true };
      applyInspectionTransform();
      return;
    }
    const component = await plugin.builders.structure.tryCreateComponentFromSelection(structure, query,
      'stereofold-inspection-selected-labels', { label: query.label, tags: ['stereofold-inspection-labels'] });
    if (!component) return;
    // A residue label is a billboard in the headset, and the
    // size that reads on a monitor at arm's length does not survive a Quest 2
    // lens. At the desktop factor the PAM's label measures a black box about two
    // per cent of the lens wide with yellow micro-text inside it — unreadable in
    // either eye, and naming the PAM is the whole objective
    // of chapter 3.
    //
    // That was fixed with a constant, and a constant is the wrong shape for the
    // problem. Mol* sizes text in world units, so the same factor reads
    // differently at every distance and at every scene-to-room scale, and the
    // wearer changes both by voice. `xrLabelSizing` inverts the arithmetic for a
    // wanted angular height at the seat, and the size theme is pinned to
    // `uniform` value 1 so that arithmetic is exact rather than a function of
    // whichever residue the label happens to sit on.
    let label;
    try {
      const style = plateStyle();
      label = await plugin.builders.structure.representation.addRepresentation(component, {
        type: 'label', color: 'uniform', colorParams: { value: Color(colorNumber(appearance.highlightColor)) },
        size: 'uniform', sizeParams: { value: 1 },
        typeParams: { level: 'residue', residueScale: 1, ...style },
      }, { initialState: { isHidden: false }, tag: 'stereofold-inspection-selected-labels' });
    } finally {
      // Only `inspectionLabel` is removed by the next rebuild, so a component
      // whose label never built would stay on the state tree. Delete it here;
      // a failed label still rejects with its own error, not the delete's.
      // A failed delete leaves the component for `removeInspectionLabels`.
      if (!label && plugin.state.data.cells.has(component.ref)) {
        try { await plugin.state.data.build().delete(component.ref).commit({ revertOnError: true }); }
        catch (dropError) { strandedLabelRefs.add(component.ref); console.error(dropError); }
      }
    }
    if (!label) return;
    inspectionLabel = { component, representation: label, plate: presenting && rows.length === 1 };
    applyInspectionTransform();
  }

  /**
   * How big a headset label has to be drawn, right now.
   *
   * Everything on the right-hand side of this is something the wearer can
   * change by voice or by grip, which is the whole point: the factor is
   * re-derived on every rebuild so the ANGULAR size the wearer reads stays put
   * while the structure's size, distance and orientation do not.
   *
   * @param {number} [characterDegrees] wanted character height in degrees
   * @returns {{sizeFactor:number, distanceMeters:number, cameraScale:number,
   *   character:number, cap:number}|null} null on a camera with no usable scale
   */
  function xrLabelSizing(characterDegrees = LABEL_CHARACTER_DEGREES.comfortable, placementScale = 1,
    measuredMeters = latestSeatStandoffMeters) {
    const cameraScale = canvas.camera?.scale;
    if (!Number.isFinite(cameraScale) || cameraScale <= 0) return null;
    const distanceMeters = labelDistanceMeters(measuredMeters);
    // telomerge: the angular model asked for 1.5 degrees per character on the
    // first telomerase run and the Quest 2 captures measured about 0.4 degrees
    // of cap height, a third of what was predicted, because the seat standoff
    // the model is given is not the distance the immersive placement actually
    // puts the structure at. Until that distance is threaded through, scale
    // the factor by the measured shortfall so a plate reads at the comfortable
    // size on the headset; the diagnostic records the gain alongside the model.
    //
    // And the shortfall is not one number. Mol*'s camera scale is
    // a session constant — the XR manager derives it once from the scene radius
    // — so a chapter that enlarges the structure spreads the parts apart while
    // leaving every plate exactly the size it was. That is why run 13 read
    // ideally at placement scale 2.4 and piled up at 1: the plates never
    // changed, the room between them did. The gain therefore tracks the
    // placement, and the diagnostic records which one this chapter drew at.
    const hardwareGain = componentLabelHardwareGain(placementScale,
      { measuredMeters });
    const sizeFactor = labelSizeFactor({ distanceMeters, cameraScale, sizeThemeValue: 1, characterDegrees })
      * hardwareGain;
    // The viewports were read during the frame that produced these views; see
    // `labelViewports` where latestRoomPlacementPose is set.
    const labelViews = latestRoomPlacementPose?.labelViews ?? [];
    const labelViewports = latestRoomPlacementPose?.labelViewports ?? [];
    const pixelsPerRadian = componentLabelProjectionGain(labelViews,
      view => labelViewports[labelViews.indexOf(view)] ?? null);
    return { sizeFactor, distanceMeters, cameraScale, hardwareGain, placementScale, pixelsPerRadian,
      characterUnits: labelCharacterUnits({ sizeFactor, sizeThemeValue: 1 }),
      minSizeScale: componentLabelMinimumSizeScale(hardwareGain),
      ...labelCharacterDegrees({ sizeFactor, cameraScale, distanceMeters, sizeThemeValue: 1 }) };
  }

  /** The name plates, as live Mol* representations. */
  function componentLabelRepresentations(refs = componentLabels.refs()) {
    return refs.flatMap(ref => [
      // The leader hangs off the plate's own cell, not off a
      // wrapped line, so it is listed once beside the line suffixes.
      ...[`${ref}-leader`].map(child => plugin.state.data.cells.get(child)?.obj?.data?.repr).filter(Boolean),
      ...['', '-0', '-1'].flatMap(suffix => {
        const base = `${ref}${suffix}`;
        return [`${base}-backing`, `${base}-text`, `${base}-key`]
          .map(child => plugin.state.data.cells.get(child)?.obj?.data?.repr).filter(Boolean);
      })]);
  }

  // The drawn name and figure plates, read from their live transforms every
  // frame so a grab or a relayout is followed at once. The array is reused.
  const plateDepthSpheres = [];
  function componentLabelDepthSpheres() {
    const objects = [];
    for (const ref of componentLabels?.active?.() ? componentLabels.refs() : []) {
      for (const suffix of ['', '-0', '-1']) {
        const repr = plugin.state.data.cells.get(`${ref}${suffix}-backing`)?.obj?.data?.repr;
        if (repr) objects.push(...repr.renderObjects);
      }
    }
    for (const repr of lessonFigure?.annotations?.() ?? []) objects.push(...(repr?.renderObjects ?? []));
    return drawnPlateDepthSpheres(objects, canvas.camera.scale, plateDepthSpheres);
  }

  // What each drawn plate was built at, so the cap below can give it back.
  const plateEyeMemory = new WeakMap();
  /** Leaving the headset restores all retained figure and residue plates. */
  function releaseFigurePlates() {
    for (const repr of lessonFigure.annotations()) for (const object of repr.renderObjects)
      releasePlateInEyes(object, plateEyeMemory, repr.state.visible);
    const residues = inspectionLabel?.representation?.obj?.data?.repr;
    for (const repr of [residues, ...(inspectionLabel?.extraRepresentations ?? []).map(label => label.obj?.data?.repr)].filter(Boolean))
      for (const object of repr.renderObjects ?? []) releasePlateInEyes(object, plateEyeMemory, repr.state.visible);
  }
  /**
   * Hold every drawn name plate, and the residue plate, at no more than two
   * degrees of character height in either eye, and take one the lens edge would
   * cut out of that view; read `plate-eye-cap.mjs`. Runs after motion sizing
   * and before either eye renders this frame. Uniform writes only.
   */
  function capDrawnPlates(views) {
    if (!views?.length) return;
    const objectsAt = ref => plugin.state.data.cells.get(ref)?.obj?.data?.repr?.renderObjects ?? [];
    const cameraScale = canvas.camera.scale;
    const roomMatrix = immersiveSession?.presentation?.()?.roomMatrix?.();
    const glass = (immersiveSession?.glassPlates?.() ?? []).map(points => points
      .map(point => roomMatrix ? applyMatrix4(point, roomMatrix)?.map(x => x * cameraScale) : undefined).filter(Boolean));
    const placed = plateObstaclesInEyes(glass, views);
    // A detached key remains outside the drawn molecular silhouette. Sample
    // committed vertices, not the sphere inflated by name-plate bounds.
    const subject = componentLabels?.active?.() ? plateObstaclesInEyes([
      (representation?.obj?.data?.repr?.renderObjects ?? [])
        .flatMap(object => renderedSubjectPoints(object, cameraScale, 256)),
    ], views, { silhouette: true }) : [];
    for (const ref of componentLabels?.active?.() ? componentLabels.refs() : []) {
      const objects = [];
      for (const suffix of ['', '-0', '-1'])
        for (const layer of ['-backing', '-text', '-key']) objects.push(...objectsAt(`${ref}${suffix}${layer}`));
      const legend = ['', '-0', '-1'].some(suffix => objectsAt(`${ref}${suffix}-key`)
          .some(object => object.values?.alpha?.ref.value > 0));
      capPlateInEyes({ objects, leaders: objectsAt(`${ref}-leader`), views, cameraScale, memory: plateEyeMemory, placed,
        legend, obstacles: legend ? subject : [] });
    }
    capFigureAnnotations({ figure: lessonFigure, views, cameraScale, memory: plateEyeMemory, placed });
    // Each selected residue (or combined run) has its own movable plate in XR.
    const residues = inspectionLabel?.plate ? inspectionLabel?.representation?.obj?.data?.repr?.renderObjects : undefined;
    const groups = [residues, ...(inspectionLabel?.extraRepresentations ?? []).map(label => label.obj?.data?.repr?.renderObjects)];
    for (const objects of groups) if (objects?.length)
      capPlateInEyes({ objects, views, cameraScale, memory: plateEyeMemory, placed, maxOffsetEm: 4 });
  }

  /** Take every name plate down, leaving the colours alone. */
  async function removeComponentLabels() {
    componentLabelLayoutCache = null;
    await componentLabels.remove();
    componentLabelBuildSignature = null;
  }

  /**
   * The geometry identity of the plate set. Emphasis changes visibility through
   * paint, not membership: hidden XR context retains its text tree for reuse.
   */
  function componentLabelPartsSignature(plan = currentEmphasisPlan()) {
    return JSON.stringify(componentLabelPlateParts(plan).slice(0, COMPONENT_LABEL_LIMIT)
      .map(part => [part.id, part.label, part.keys]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }

  /**
   * Rebuild the name plates, serialized behind any rebuild
   * already in flight. Every caller in this file goes through here. A force is
   * reserved for a committed menu/room-seat change, where the solver's
   * obstacle or camera basis really did change.
   */
  async function rebuildComponentLabels(reason, seatBasis, { force = false } = {}) {
    const wanted = componentLabelsWanted();
    const signature = wanted ? componentLabelPartsSignature() : null;
    if (!force && wanted && componentLabels.active() && signature === componentLabelBuildSignature) {
      if (reason === 'emphasis' || reason === 'emphasis+placement' || componentLabels.batching?.()) {
        await componentLabels.relayout(reason);
        return;
      }
      let repainted = false;
      try {
        if (typeof repaintComponentLabelPlates === 'function') {
          repainted = (await repaintComponentLabelPlates()) !== false;
        }
      } catch { /* A failed paint update falls back to a complete rebuild. */ }
      if (repainted || typeof repaintComponentLabelPlates !== 'function') return;
    }
    if (!force && !wanted && !componentLabels.active()) return;
    if (!wanted) componentLabelBuildSignature = null;
    await componentLabels.rebuild(reason, seatBasis);
    if (typeof molecularAnimation !== 'undefined') await molecularAnimation.refresh();
    componentLabelBuildSignature = componentLabelsWanted() ? componentLabelPartsSignature() : null;
  }

  /**
   * Whether the live look asks for per-part name plates at all.
   *
   * This, not the ref count, is what a session edge must ask. The ref list is
   * empty for the whole of an in-flight rebuild — it is cleared before the
   * deletes are awaited — so a wearer who entered and left inside one was told
   * there were no plates to resize and left with desktop-sized plates in the
   * headset.
   */
  function componentLabelsWanted() {
    if (!selection || !structure?.ref) return false;
    // A lesson that never authored plates still gets none. But
    // the flag is per-CHAPTER intent and a command paint can land between two
    // chapters with it off, so a lesson whose own baseline asks for plates
    // keeps the one plate that matters — the part being explained.
    const plan = currentEmphasisPlan();
    const installed = lessonResting.state();
    const explaining = Boolean(plan?.explained?.length) && installed?.componentLabels === true;
    // An installed lesson keeps its plates through an agent's
    // command emphasize too; key ownership and plate ownership are separate.
    if (!platesWanted(installed, lessonResting.labelsEnabled(), emphasisOrigin) && !explaining) return false;
    return Boolean(componentLabelPlateParts(plan).length);
  }

  /**
   * The parts that get a name plate, subject first.
   *
   * `plan.colours` is the paint list and drops any part with no colour of its
   * own; `plan.explained` is what the chapter — or an agent's `emphasize` — is
   * teaching, colour or no colour. The union, with the explained parts at the
   * front, is what the wearer needs: the answer to the question they asked,
   * and then the rest of the key. An `emphasize` naming parts by chain alone
   * used to resolve to an empty `colours` and take all ten plates down with it,
   * the focused part's own plate included.
   */
  function componentLabelPlateParts(plan) {
    if (!plan) return [];
    // Keep the whole key's geometry so focus changes only repaint or relayout.
    // componentLabelPaint makes dimmed XR context absent (alpha 0) and restores
    // full contrast when emphasized. Explained parts get layout priority.
    const explained = plan.explained ?? [];
    const key = componentLabelKeyPlan();
    const parts = [];
    const seen = new Set();
    // A name plate for a part that is entirely off the screen
    // labels nothing. A part still partly visible keeps its plate, because the
    // wearer can still see what it is pointing at.
    const hidden = hiddenSceneKeySet();
    for (const part of [...explained, ...(key?.colours ?? []), ...(plan.colours ?? [])]) {
      if (!part?.id || seen.has(part.id)) continue;
      if (hidden.size && Array.isArray(part.keys) && part.keys.length && part.keys.every(k => hidden.has(k))) continue;
      seen.add(part.id);
      parts.push({ ...part, focused: explained.some(entry => entry.id === part.id) });
    }
    return parts;
  }

  /**
   * The lesson's whole key with a plate opacity per part, one
   * for the focus, the key's context opacity for the rest, one everywhere
   * when nothing is focused. Read `component-labels.mjs`.
   */
  function componentLabelKeyPlan() {
    if (!selection) return undefined;
    return planComponentLabels({ ...emphasisState,
      contextOpacity: paintedContextOpacity(emphasisState.contextOpacity) }, spokenSelectionKeys);
  }

  /**
   * Delete name-plate cells by ref, skipping cells the state
   * tree has already lost. Split out so the synchronous source adoption below
   * can sweep plates it is orphaning without awaiting the build.
   */
  async function deleteComponentLabelCells(refs) {
    for (const ref of refs) {
      if (plugin.state.data.cells.get(ref)) await plugin.build().delete(ref).commit();
    }
  }

  /**
   * One name plate per part of the lesson's colour key.
   *
   * The owner asked for "the structure shows up with clear labels for the
   * components". A colour key already names every component — "Dyskerin",
   * "NOP10", "hTR RNA" — but the names lived on a 2D panel the wearer is not
   * looking at, so in the headset the key was a set of unexplained colours.
   * This draws each name at its own part's centroid, in that part's colour.
   *
   * Mol*'s loci label is the right primitive and the only one that needs no new
   * per-frame code: it is a text shape at a loci's bounding-sphere centre with
   * `customText`, drawn through the same `text.vert` billboard as every other
   * label, so the facing rule and the sizing rule below apply to it unchanged.
   * `scaleByRadius` is off deliberately — it would multiply the glyph size by
   * the part's own radius, which is exactly the "size depends on the subject"
   * behaviour the angular rule exists to remove.
   */
  async function buildComponentLabelPlates({ presenting, reason, seatBasis, strand, isCurrent }) {
    const checkOwner = () => { if (isCurrent?.() === false) throw Object.assign(Error('Label placement superseded.'), { code: 'FIT_CANCELLED' }); };
    checkOwner();
    componentLabelLayoutCache = null;
    if (presenting && pendingRoomSeat) {
      componentLabelBuildSignature = null;
      return [];
    }
    if (presenting && pendingRoomLabels) {
      if (!seatBasis || seatBasis !== pendingRoomLabelBasis) {
        // An empty pass must not leave a signature that lets the real entry
        // build be mistaken for a repeat.
        componentLabelBuildSignature = null;
        return [];
      }
      pendingRoomLabels = false;
      pendingRoomLabelBasis = null;
    }
    const plan = currentEmphasisPlan();
    const wanted = componentLabelPlateParts(plan);
    if (!wanted.length) {
      componentLabelBuildSignature = null;
      return [];
    }
    // Chapter emphasis chooses the XR plates; the retained names have full
    // contrast even when layout would otherwise fade them.
    const contextAlpha = new Map((componentLabelKeyPlan()?.colours ?? []).map(part => [part.id, part.opacity]));
    const named = new Map(emphasisState.parts.map(part => [part.id, part]));
    const placement = inspectionSnapshot().placement;
    const sizing = presenting ? xrLabelSizing(LABEL_CHARACTER_DEGREES.comfortable, placement.scale) : null;
    const highlight = inspectionSnapshot().appearance.highlightColor;
    const transform = presentationTransform();

    // Every centroid before any offset: the layout cannot know where one plate
    // may sit until it knows where all of them want to sit.
    const drawable = [];
    for (const part of wanted) {
      if (drawable.length >= COMPONENT_LABEL_LIMIT) break;
      const authored = named.get(part.id);
      if (!authored?.label || !part.keys.length) continue;
      const loci = selection.toLoci(part.keys);
      if (StructureElement.Loci.isEmpty(loci)) continue;
      const sphere = componentLabelBounds(loci);
      drawable.push({
        id: part.id,
        // The plate shows the short name; the authored one
        // stays on the part for the voice route and the state tree's own cell
        // label, so "show me dyskerin" and "GAR1" resolve exactly as before.
        text: componentPlateName(authored.label), label: authored.label,
        loci, focused: part.focused === true,
        // A part an agent named by chain carries no colour of
        // its own, and a plate has to be SOME colour. The highlight is the
        // viewer's own word for "this is the thing you asked about".
        color: authored.color ?? part.color ?? highlight,
        anchor: sphere ? Array.from(Vec3.transformMat4(Vec3(), sphere.center, transform)) : null,
        radius: (sphere?.radius ?? 0) * (Number.isFinite(placement.scale) ? placement.scale : 1),
      });
    }
    // The structure's own silhouette, in the same space and
    // units as the plate anchors, so the solver can keep the plates off it.
    const loaded = loadedSphere();
    const subject = loaded ? {
      anchor: Array.from(Vec3.transformMat4(Vec3(), loaded.center, transform)),
      radius: loaded.radius * (Number.isFinite(placement.scale) ? placement.scale : 1),
      points: (loaded.extrema ?? []).map(point => Array.from(Vec3.transformMat4(Vec3(), point, transform))),
    } : null;
    // The solver has to know the push every plate is drawn
    // with, or its offsets land 1.4 times too far out on the glass.
    const standoff = componentLabelOffsetZ(placement.scale,
      presenting ? COMPONENT_LABEL_BASE_OFFSET_Z : DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z);
    const layout = componentLabelLayout(drawable, sizing, plan, subject, reason, presenting ? seatBasis : undefined, standoff);

    const created = [], measuredPlates = [], placeAlphaById = new Map(), detachedById = new Map();
    try {
      for (const entry of drawable) {
        const place = layout.get(entry.id);
        if (!place) continue;
        placeAlphaById.set(entry.id, place.alpha);
        // A plate away from its part is a legend entry and carries its part's
        // colour as a key; read `COMPONENT_LABEL_KEY_SHARE`.
        detachedById.set(entry.id, place.detached === true);
        const ref = `${COMPONENT_LABEL_REF}-${created.length}`;
        const lines = place.lines?.length ? place.lines : [entry.text];
        const sizeFactor = (sizing ? sizing.sizeFactor : DESKTOP_LABEL_SIZE_FACTOR) * place.sizeScale;
        const characterUnits = (sizing ? sizing.characterUnits : labelCharacterUnits({ sizeFactor })) * place.sizeScale;
        const paint = componentLabelPaint({ presenting, placeAlpha: place.alpha,
          contextAlpha: contextAlpha.get(entry.id) ?? 1,
          color: colorNumber(entry.color), offsetZ: standoff, detached: place.detached === true });
        const builder = plugin.build().toRoot()
          .apply(StateTransforms.Model.MultiStructureSelectionFromBundle, {
            selections: [{ key: 'a', ref: structure.ref, bundle: StructureElement.Bundle.fromLoci(entry.loci) }],
            isTransitive: true, label: entry.label ?? entry.text,
          }, { ref, dependsOn: [structure.ref] });
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const lineRef = lines.length === 1 ? ref : `${ref}-${lineIndex}`;
          const lineOffset = (lineIndex - (lines.length - 1) / 2) * characterUnits;
          const common = {
            customText: lines[lineIndex], textSize: 1,
            scaleByRadius: false,
            sizeFactor,
            // A headset plate is drawn from the 10.8 MB atlas, not
            // the 43 MB one; read `COMPONENT_LABEL_FONT_QUALITY`.
            ...(presenting ? { fontQuality: COMPONENT_LABEL_FONT_QUALITY } : {}),
            // The fan, in the eye's own plane.
            //
            // `text.vert` adds `uOffsetX`/`uOffsetY` to the SAME corner offset it
            // expands the glyphs with, so this displaces the whole plate —
            // background quad included — inside the billboard rather than moving
            // the anchor it hangs from. The plate stays square to the wearer and
            // stays right in both eyes, which a world-space nudge would not.
            offsetX: place.offsetX, offsetY: place.offsetY + lineOffset,
          };
          // Pushed toward the eye so a name stays readable against the part it
          // names instead of being buried inside the surface it sits on. Both
          // branches scale with the placement: a desktop panel at scale 2.4 was
          // burying every plate inside the cartoon on a fixed four-Angstrom
          // push, exactly the defect the XR branch was given the scale to fix.
          // One primitive draws the glyphs and their white backing at one depth.
          // A detached plate's key goes under it, at the same offsets.
          for (const [layer, params] of Object.entries(paint)) {
            if (layer === 'key' && place.detached !== true) continue;
            builder.apply(StateTransforms.Representation.StructureSelectionsLabel3D, {
              ...common, ...params,
              textColor: Color(params.textColor),
              backgroundColor: Color(params.backgroundColor),
              borderColor: Color(params.borderColor),
            }, { ref: `${lineRef}-${layer}` });
          }
        }
        await builder.commit();
        checkOwner();
        created.push(ref);
        measuredPlates.push({ id: entry.id, ref, lines: lines.length });
      }
      if (created.length) applyInspectionTransform(created);
    } catch (error) {
      // The session receives no refs from a failed build, so no later pass
      // would delete these plates. The failing plate's own cells go too.
      const plates = [...created, `${COMPONENT_LABEL_REF}-${created.length}`];
      try { await deleteComponentLabelCells(plates); }
      catch (dropError) {
        // The session deletes whatever is still here before its next build.
        strand?.(plates.filter(ref => plugin.state.data.cells.has(ref)));
        console.error(dropError);
      }
      throw error;
    }
    // Emphasis changes can leave the wanted part set identical while changing
    // only colour or focus/context opacity. Repaint plates and leaders from
    // the current emphasis so a signature hit never leaves stale paint.
    // A layer is staged only when what the wearer would see
    // changes, and a pass that stages nothing commits nothing, transforms
    // nothing and re-measures nothing. Read `stageComponentLabelLayers`.
    const committedLayer = cell => plugin.state.data.cells.get(cell)?.transform?.params;
    repaintComponentLabelPlates = async () => {
      if (created.length !== measuredPlates.length
        || created.some(ref => !componentLabels.refs().includes(ref))) return false;
      const updates = plugin.build();
      const staged = stageComponentLabelLayers({ committed: committedLayer, updates });
      const contextAlpha = new Map((componentLabelKeyPlan()?.colours ?? []).map(part => [part.id, part.opacity]));
      const named = new Map(emphasisState.parts.map(part => [part.id, part]));
      const wanted = new Map(componentLabelPlateParts(currentEmphasisPlan()).map(part => [part.id, part]));
      const highlight = inspectionSnapshot().appearance.highlightColor;
      for (const entry of drawable) {
        const plate = measuredPlates.find(value => value.id === entry.id);
        if (!plate) return false;
        const paint = componentLabelPaint({ presenting, placeAlpha: placeAlphaById.get(entry.id) ?? 1,
          contextAlpha: contextAlpha.get(entry.id) ?? 1, detached: detachedById.get(entry.id) === true,
          color: colorNumber(named.get(entry.id)?.color ?? wanted.get(entry.id)?.color ?? highlight) });
        for (let line = 0; line < plate.lines; line += 1) {
          const base = plate.lines === 1 ? plate.ref : `${plate.ref}-${line}`;
          for (const layer of Object.keys(paint)) {
            const cell = `${base}-${layer}`;
            // Only a plate placed away from its part has a key to repaint.
            if (layer === 'key' && !plugin.state.data.cells.has(cell)) continue;
            if (!plugin.state.data.cells.has(cell)) return false;
            // Keep the live stand-off and geometry, including any menu relayout.
            const { offsetZ, ...appearance } = paint[layer];
            staged.stage(cell, appearance);
          }
        }
      }
      if (staged.changed()) {
        await updates.commit({ revertOnError: true });
        labelMeasurementGate.invalidate();
      }
      recordCost('plate-update', staged.detail('repaint'));
      return true;
    };
    // Menu motion only changes offsets, size and leaders. Update these live
    // representations instead of deleting ten root cells and recreating them.
    const labelSource = sourceRecord, labelGeneration = state.generation;
    updateMenuLabelPlates = async (refs, reason, { isCurrent } = {}) => {
      if (isCurrent?.() === false) return true;
      const reject = () => {
        componentLabelLayoutCache = null;
        recordCost('plate-update', { path: 'relayout', reason, degraded: true, retained: true, changed: 0, geometry: false });
        return false;
      };
      if (refs.length !== created.length || refs.some((ref, i) => ref !== created[i])) return reject();
      if (reason && !reason.includes('placement') && !reason.includes('emphasis')) menuResolveReason = reason;
      // Placement can change without rebuilding the label cells. Reproject
      // model-space loci with the same current transform the renderer uses;
      // transforming the old anchors again would apply the initial pose twice.
      const placement = inspectionSnapshot().placement;
      const transform = presentationTransform();
      const scale = Number.isFinite(placement.scale) ? placement.scale : 1;
      const sizing = presenting ? xrLabelSizing(LABEL_CHARACTER_DEGREES.comfortable, placement.scale) : null;
      const updates = plugin.build();
      const staged = stageComponentLabelLayers({ committed: committedLayer, updates });
      const plan = currentEmphasisPlan();
      const wanted = new Map(componentLabelPlateParts(plan).map(part => [part.id, part]));
      const contextAlpha = new Map((componentLabelKeyPlan()?.colours ?? []).map(part => [part.id, part.opacity]));
      const detachedNext = new Map();
      const placed = drawable.map(entry => {
        const sphere = componentLabelBounds(entry.loci);
        return { ...entry, focused: wanted.get(entry.id)?.focused === true,
          anchor: sphere ? Array.from(Vec3.transformMat4(Vec3(), sphere.center, transform)) : null,
          radius: (sphere?.radius ?? 0) * scale };
      });
      const loaded = loadedSphere();
      const subject = loaded ? {
        anchor: Array.from(Vec3.transformMat4(Vec3(), loaded.center, transform)),
        radius: loaded.radius * scale,
        points: (loaded.extrema ?? []).map(point => Array.from(Vec3.transformMat4(Vec3(), point, transform))),
      } : null;
      const standoff = componentLabelOffsetZ(placement.scale,
        presenting ? COMPONENT_LABEL_BASE_OFFSET_Z : DESKTOP_COMPONENT_LABEL_BASE_OFFSET_Z);
      const next = componentLabelLayout(placed, sizing, plan, subject, reason, undefined, standoff);
      if (next.failed) { reject(); return true; } // Keep every committed uniform and leader.
      if (next.unchanged) return true;
      for (let i = 0; i < drawable.length; i++) {
        const place = next.get(drawable[i].id), ref = refs[i];
        if (!place) return reject();
        // The shader divides the offsets by the PUSHED
        // depth, so half a projected pixel is that many offset units, not the
        // anchor depth's. A layout without a stand-off reports the same depth.
        const still = componentLabelStillUnits(place.drawDepth ?? place.depth, sizing?.pixelsPerRadian);
        const lines = place.lines?.length ? place.lines : [drawable[i].text];
        const sizeFactor = (sizing ? sizing.sizeFactor : DESKTOP_LABEL_SIZE_FACTOR) * place.sizeScale;
        const em = sizing ? sizing.characterUnits * place.sizeScale : labelCharacterUnits({ sizeFactor });
        const paint = componentLabelPaint({ presenting, placeAlpha: place.alpha,
          contextAlpha: contextAlpha.get(drawable[i].id) ?? 1, offsetZ: standoff, detached: place.detached === true,
          color: colorNumber(emphasisState.parts.find(part => part.id === drawable[i].id)?.color ?? drawable[i].color) });
        detachedNext.set(drawable[i].id, place.detached === true);
        for (let line = 0; line < lines.length; line++) {
          const base = lines.length === 1 ? ref : `${ref}-${line}`;
          const geometry = { sizeFactor, offsetX: place.offsetX, offsetY: place.offsetY + (line - (lines.length - 1) / 2) * em };
          // A plate that comes back to its part hides its key in the same
          // update; one that leaves it gains a key built from its own line.
          for (const layer of Object.keys(paint)) {
            const cell = `${base}-${layer}`;
            const { alpha, offsetZ, backgroundMargin, backgroundOpacity } = paint[layer];
            if (layer === 'key' && !plugin.state.data.cells.has(cell)) {
              if (alpha > 0) staged.add(ref, StateTransforms.Representation.StructureSelectionsLabel3D,
                { ...committedLayer(`${base}-backing`), ...geometry, ...paint.key }, cell);
              continue;
            }
            if (!plugin.state.data.cells.has(cell)) return reject();
            staged.stage(cell, { ...geometry, alpha, offsetZ,
              ...(backgroundMargin === undefined ? {} : { backgroundMargin, backgroundOpacity }) }, still);
          }
        }
      }
      if (staged.changed()) {
        if (isCurrent?.() === false) return true;
        await updates.commit({ revertOnError: true });
        for (const [id, detached] of detachedNext) detachedById.set(id, detached);
        // A Mol* commit already underway cannot be unwritten. It never writes
        // placement/history. Transform surviving labels with the live pose;
        // the new release schedules their next layout. Source swaps own refs.
        if (isCurrent?.() === false) {
          if (sourceRecord === labelSource && state.generation === labelGeneration
            && refs.every(ref => componentLabels.refs().includes(ref))) applyInspectionTransform(refs);
          return true;
        }
        applyInspectionTransform(refs);
        labelMeasurementGate.invalidate();
      }
      const detail = staged.detail('relayout', reason);
      recordCost('plate-update', detail);
      return true;
    };
    const detail = { created: created.length, asked: wanted.length,
      ...(plan?.explained?.length ? { explained: plan.explained.length } : {}),
      ...(sizing ? { sizeFactor: Math.round(sizing.sizeFactor * 100) / 100,
        characterDegrees: Math.round(sizing.character * 100) / 100,
        gain: Math.round(sizing.hardwareGain * 100) / 100,
        placementScale: sizing.placementScale,
        seatMeters: Math.round(sizing.distanceMeters * 100) / 100 } : {}) };
    recordCost('component-labels', detail);
    componentLabelMeasurement = { plates: measuredPlates, detail };
    componentLabelBuildSignature = componentLabelPartsSignature(plan);
    labelMeasurementGate.invalidate();
    // The session owns the ref list; returning it is how these plates become
    // the live set, and how the next pass knows what to take down.
    return created;
  }

  // Entry evidence is independent of labels and selected/paused tour state.
  // The existing entry token resets this once-only measurement on re-entry.
  function recordEntryStandoff(pose, renderFromRoom) {
    if (!roomEntry || roomEntry.standoffRecorded || pendingRoomSeat || pendingRoomLabels
      || settlingRoomAnchor || busy || state.status !== 'ready' || !canvas.xr.isPresenting.value) return;
    const objects = [representation?.obj?.data?.repr, ligandOverlay?.representation?.obj?.data?.repr]
      .flatMap(repr => repr?.renderObjects ?? []);
    const detail = measureEntryStandoff({ objects, cameraScale: canvas.camera.scale,
      views: pose?.views, menuPoints: immersiveSession?.drawnMenuPoints?.() ?? [], renderFromRoom });
    if (!detail) return;
    recordCost('plate-standoff', detail);
    roomEntry.standoffRecorded = true;
  }

  // Called by the presenting session's post-render onHeadFrame observer. A
  // build invalidates only after its commits; refs must also have been adopted
  // by the serialized owner, so a partial or superseded build is never evidence.
  function measureDrawnComponentLabels(pose) {
    const now = performance.now(), pending = componentLabelMeasurement;
    if (!pending || !labelMeasurementGate.due(now, canvas.xr.isPresenting.value, pose?.views)) return;
    const live = new Set(componentLabels.refs());
    if (pending.plates.some(plate => !live.has(plate.ref))) return;
    const objectsAt = ref => plugin.state.data.cells.get(ref)?.obj?.data?.repr?.renderObjects ?? [];
    const committed = pending.plates.map(plate => ({ id: plate.id,
      leaders: objectsAt(`${plate.ref}-leader`), lines: Array.from({ length: plate.lines }, (_, i) => {
        const base = plate.lines === 1 ? plate.ref : `${plate.ref}-${i}`;
        const backing = objectsAt(`${base}-backing`);
        // A detached plate's key is the outer edge of what is drawn.
        return backing.some(labelObjectRenderable)
          ? [...backing, ...objectsAt(`${base}-key`)] : objectsAt(`${base}-text`);
      }) }));
    // A state-tree commit can precede Mol*'s first drawable update by a frame.
    // Do not consume the evidence generation while drawCount/alpha/geometry is
    // still absent: that was the visible-label/zero-rect race in the headset.
    if (committed.some(plate => plate.lines.some(objects => !objects.some(labelObjectRenderable)))) {
      labelMeasurementGate.retry(now);
      return;
    }
    const plates = committed.map(plate => ({ id: plate.id, leaders: plate.leaders, objects: plate.lines.flat() }));
    // Bounds come from the visible scientific render objects after their
    // committed world transforms, never from the solver's subject input. The
    // vertex sample is the silhouette a plate can actually cover; the spheres
    // only stand in for a geometry whose vertices cannot be read.
    const scale = canvas.camera.scale;
    const drawnObjects = [representation?.obj?.data?.repr, ligandOverlay?.representation?.obj?.data?.repr]
      .flatMap(repr => repr?.renderObjects ?? []);
    const geometry = drawnObjects.map(object => ({ spheres: renderedSubjectSpheres(object, scale),
      points: renderedSubjectPoints(object, scale) }));
    const spheres = geometry.flatMap(object => object.spheres);
    const points = geometry.flatMap(object => object.points);
    const fallbackSpheres = geometry.flatMap(object => object.points.length ? [] : object.spheres);
    const subject = spheres.length || points.length ? { spheres, points, fallbackSpheres } : null;
    try {
      const measured = measureComponentLabels({ plates, views: pose.views, cameraScale: scale, subject });
      for (const detail of measured) recordCost('component-labels-drawn', detail);
      // The summary's visibility is conservative across the two eyes. Per-eye
      // counts and rectangles remain in the evidence records immediately above.
      recordCost('component-labels', { ...pending.detail, visible: Math.min(...measured.map(entry => entry.visible)) });
      labelMeasurementGate.measured(now);
      talkCaption?.invalidate?.();
    } catch (error) {
      recordCost('xr-frame-error', { phase: 'component-label-measurement', error: error?.message ?? String(error) });
      labelMeasurementGate.retry(now);
    }
  }

  /** Read committed geometry only when a reply needs a seat. No frame solve. */
  function replyCardClearance() {
    const pose = latestRoomPlacementPose;
    if (!pose?.labelViews?.length) return undefined;
    const objectsAt = ref => plugin.state.data.cells.get(ref)?.obj?.data?.repr?.renderObjects ?? [];
    const live = new Set(componentLabels.refs());
    const plates = (componentLabelMeasurement?.plates ?? []).filter(p => live.has(p.ref)).map(p => ({
      id: p.id, objects: Array.from({ length: p.lines }, (_, i) => {
        const base = p.lines === 1 ? p.ref : `${p.ref}-${i}`;
        const backing = objectsAt(`${base}-backing`);
        return backing.some(labelObjectRenderable)
          ? [...backing, ...objectsAt(`${base}-key`)] : objectsAt(`${base}-text`);
      }).flat(),
    }));
    const scale = canvas.camera.scale;
    const objects = scientificRepresentations(true).flatMap(repr => repr?.renderObjects ?? []);
    for (const repr of lessonFigure.annotations()) plates.push({ id: `figure-${plates.length}`, objects: repr.renderObjects ?? [] });
    // Full committed bounds conservatively protect the scientific subject,
    // including geometry without a readable vertex buffer.
    const subject = { spheres: objects.flatMap(object => renderedSubjectSpheres(object, scale)) };
    return { views: pose.labelViews, renderFromRoom: pose.renderFromRoom,
      measured: measureComponentLabels({ plates, views: pose.labelViews, cameraScale: scale, subject }) };
  }

  /** Snapshot one basis; later tracked frames cannot change this solve. */
  function componentLabelViewBasis() {
    const head = latestRoomPlacementPose
      ? headViewBasis({ ...latestRoomPlacementPose, cameraScale: canvas.camera.scale }) : undefined;
    if (head) return { ...head, basis: 'head', plateSeat: latestPlateSeat };
    const camera = canvas.camera.getSnapshot();
    if (!camera?.position || !camera?.target) return undefined;
    return { eye: Array.from(camera.position), target: Array.from(camera.target),
      up: camera.up ? Array.from(camera.up) : undefined, basis: 'camera', plateSeat: latestPlateSeat };
  }

  /**
   * Where each plate is allowed to sit, at the seat the wearer
   * is in right now.
   *
   * Solved once per rebuild rather than per frame. The offsets are static
   * uniforms, so re-solving them every frame would make the plates swim as the
   * wearer's head moved; a rebuild already runs on every chapter, placement,
   * session edge and source change, which is every time the arrangement can
   * actually go wrong.
   *
   * A desktop canvas falls through with no offsets at all: its plates are a
   * tenth the size and have never stacked.
   *
   * @returns {Map<string, {offsetX:number, offsetY:number, sizeScale:number, alpha:number}>}
   */
  function componentLabelLayout(drawable, sizing, plan, subject, reason, seatBasis, standoff = 0) {
    // Why this pass was asked for, if a menu motion asked for it.
    // Taken rather than read: a later rebuild from a chapter change or a
    // selection is not the menu moving and must not inherit the name.
    const menuReason = menuResolveReason;
    menuResolveReason = null;
    const reject = cause => {
      recordCost('component-label-layout', { predicted: true, degraded: true,
        unresolved: drawable.length, plates: drawable.length, reason, cause,
        ...(menuReason ? { menuReason } : {}), failed: true });
      const failed = new Map(); failed.failed = true;
      return failed;
    };
    const identity = new Map(drawable.map(entry => [entry.id,
      { offsetX: 0, offsetY: 0, sizeScale: 1, alpha: 1,
        lines: wrapPlateText(entry.text, { measureText: componentLabelTextWidth }) }]));
    if (!sizing) return identity;
    if (drawable.some(entry => !entry.anchor)) return reject('missing-anchor');
    let view;
    // A cap supplies its exact basis. Other rebuilds sample once here.
    try { view = seatBasis ?? componentLabelViewBasis(); } catch { return reject('missing-view'); }
    if (!view) return reject('missing-view');
    try {
      const toolbarRect = (() => {
        try {
          // Replies have a detached card. The old twelve-line reservation
          // covers free glass beside a compact menu (#330/#724/#952).
          // Button rows are stable across replies; retain the seated obstacle
          // when rows are unavailable during a grab or asynchronous redraw.
          const rows = immersiveSession?.menuRows?.() ?? [];
          const points = rows.length ? rows.flat() : immersiveSession?.menuPoints?.() ?? [];
          const matrix = immersiveSession?.presentation?.()?.roomMatrix?.();
          const scenePoints = matrix ? points.map(point => applyMatrix4(point, matrix)).filter(Boolean) : [];
          return screenRectFromPoints({ points: scenePoints, eye: view.eye, target: view.target, up: view.up });
        } catch { return null; }
      })();
      // The caption card is glass too. A plate under it hides the menu that
      // clears everything else, so the plates keep off both.
      const captionRect = (() => {
        try {
          const points = immersiveSession?.captionPoints?.() ?? [];
          const matrix = immersiveSession?.presentation?.()?.roomMatrix?.();
          const scenePoints = matrix ? points.map(point => applyMatrix4(point, matrix)).filter(Boolean) : [];
          return scenePoints.length ? screenRectFromPoints({ points: scenePoints, eye: view.eye, target: view.target, up: view.up }) : null;
        } catch { return null; }
      })();
      const options = {
        plates: drawable.map(({ id, text, anchor, radius, focused }) => ({ id, text, anchor, radius, focused })),
        eye: view.eye, target: view.target, up: view.up,
        characterUnits: sizing.characterUnits,
        minSizeScale: sizing.minSizeScale,
        contextAlpha: Math.max(0.3, 1 - (plan?.transparency ?? 0)),
        measureText: componentLabelTextWidth,
        obstacles: menuGlassObstacles([toolbarRect, captionRect]),
        subject: subject ?? null,
        standoff,
        // The band the wearer can actually read. Nothing is
        // allowed past it, whatever else it would have cleared.
        field: PLATE_FIELD,
        // Per-eye projection can close a head-centre gap at mixed depths.
        // Keep this extra air in the replayable inputs, in tangent units.
        clearance: .004,
      };
      const key = plateLayoutKey(options);
      if (/^(grow|follow)(,(grow|follow))*$/.test(reason ?? '')
        && componentLabelLayoutCache && reusablePlateLayout(key, componentLabelLayoutCache.key)) {
        const retained = new Map(componentLabelLayoutCache.placements);
        retained.unchanged = true;
        return retained;
      }
      // A reused layout leaves the reply's obstacle geometry unchanged.
      // Suspend only when this request will actually solve new placements.
      talkCaption?.suspend?.();
      const solved = layoutComponentPlates(options);
      // These are solver predictions in one camera basis. Only the per-eye
      // component-labels-drawn records observe committed render objects.
      // `menuReason` is present only on a pass a menu motion
      // asked for, and names every cause of that motion in order — `reseat`
      // after the Move row, `collapse,reseat` or `expand,reseat` after the Menu
      // row, which folds the grid and then re-seats it. Absent means this pass
      // was asked for by something else, which is every entry pass and every
      // chapter change.
      // Rounding mints negative zero freely; JSON drops the sign, an in-process
      // ring copy would not, so normalise it before the record is stored.
      const clean = value => (value === 0 ? 0 : value);
      const round = value => clean(Math.round(value * 1000) / 1000);
      const exact = value => (Number.isFinite(value) ? clean(Math.round(value * 1e6) / 1e6) : null);
      recordCost('component-label-layout', { predicted: true, basis: view.basis,
        plates: solved.placements.length,
        ...(reason ? { reason } : {}),
        ...(view.plateSeat ? { seatDegrees: round(view.plateSeat.viewDegrees),
          seatBand: [round(view.plateSeat.band.x), round(view.plateSeat.band.y)] } : {}),
        unresolved: solved.unresolved, degraded: solved.degraded === true, overlapArea: solved.overlapArea ?? 0,
        overlaps: solved.overlaps, focusOverlaps: solved.focusOverlaps, fanned: solved.fanned,
        shrunk: solved.shrunk, dimmed: solved.dimmed, detached: solved.detached,
        yielded: solved.yielded, led: solved.led, offGlass: solved.offGlass,
        menu: toolbarRect ? solved.menuOverlaps : null,
        subject: subject ? solved.subjectOverlaps : null,
        // How far the arrangement is spread around the
        // structure, and the mean leader a wearer has to follow. The heap of
        // seven plates under the fifth device run's structure reported a clean
        // `overlaps: 0`; these are the two numbers it would have failed.
        ...(solved.sides ? { sides: solved.sides } : {}),
        leaderEm: Math.round(solved.leaderEm * 100) / 100,
        ...(solved.subject ? { silhouette: [round(solved.subject.x), round(solved.subject.y),
          round(solved.subject.halfWidth), round(solved.subject.halfHeight)] } : {}),
        rects: solved.placements.map(entry => ({ id: entry.id,
          x: entry.rect ? round(entry.rect.x) : null, y: entry.rect ? round(entry.rect.y) : null,
          hw: entry.rect ? round(entry.rect.halfWidth) : null, hh: entry.rect ? round(entry.rect.halfHeight) : null })),
        // The solver's own inputs, so a device ring can replay
        // this exact call (fixtures/layout-replay.mjs) instead of guessing
        // anchors from output rectangles. Each anchor is the part centroid's
        // tangent x/y at its depth in this pass's basis, with its part radius,
        // plate half extents, line count and focus; an on-axis replay basis
        // reproduces the same projection. Six decimals keep the replay within
        // a millionth of a tangent unit; the acceptance-5 rings lacked all of
        // this, which is why their replays had to synthesise anchors.
        ...(solved.inputs ? {
          anchors: solved.inputs.anchors.map(entry => ({ id: entry.id,
            x: exact(entry.x), y: exact(entry.y), z: exact(entry.depth), r: exact(entry.radius),
            w: exact(entry.halfWidth), h: exact(entry.halfHeight), lines: entry.lines, focused: entry.focused })),
          obstacles: solved.inputs.obstacles.map(rect => ({ x: exact(rect.x), y: exact(rect.y),
            hw: exact(rect.halfWidth), hh: exact(rect.halfHeight) })),
          inputs: { characterUnits: exact(solved.inputs.characterUnits), minSizeScale: exact(solved.inputs.minSizeScale),
            contextAlpha: exact(solved.inputs.contextAlpha), standoff: exact(solved.inputs.standoff),
            clearance: exact(solved.inputs.clearance ?? 0),
            fieldHalfWidth: exact(solved.inputs.field?.halfWidth), fieldHalfHeight: exact(solved.inputs.field?.halfHeight),
            subjectX: exact(solved.inputs.subject?.x), subjectY: exact(solved.inputs.subject?.y),
            subjectHalfWidth: exact(solved.inputs.subject?.halfWidth), subjectHalfHeight: exact(solved.inputs.subject?.halfHeight) },
        } : {}),
        // The exact repack's node and slot counts and whether it completed,
        // when the greedy bands failed; absent when they did not.
        ...(solved.search ? { search: { nodes: solved.search.nodes, slots: solved.search.slots,
          complete: solved.search.complete === true, resolution: exact(solved.search.resolution) } } : {}),
        ...(menuReason ? { menuReason } : {}) });
      const placements = new Map(solved.placements.map(entry => [entry.id, entry]));
      componentLabelLayoutCache = { key, placements };
      return placements;
    } catch { return reject('solver-failed'); }
  }

  /**
   * The rows a demoted all-atom chapter keeps its atoms for.
   *
   * `visibilityGroupOf` already knows which rows are non-polymer and branched,
   * which is the same question "is this the cargo" asks, so the overlay is
   * defined by the viewer's own notion of a ligand rather than a second one.
   */
  function ligandRows() {
    if (!selection) return [];
    // A wearer or an agent who hid the ligands meant it. Drawing them again in
    // their own representation would answer "hide the ligands" with more
    // ligands than the chapter had before.
    if (plugin.state.data.cells.get(representationLayerRef(representation, VISIBILITY_LAYER_REF.ligand))) return [];
    return (selection.rows ?? []).filter(row => visibilityGroupOf(row) === 'ligand'
      && row.coordinateState === 'resolved' && row.atomSites?.length);
  }

  /** How many atom sites those rows carry, which is what the budget bounds. */
  function ligandAtomSites() {
    let total = 0;
    for (const row of ligandRows()) total += row.atomSites.length;
    return total;
  }

  /**
   * Draw the ligands at `type`, or take the overlay off when `type` is null.
   *
   * The overlay wears the chapter's OWN colour, not a colour of its own: the
   * emphasis layers are painted over both representations afterwards, so a
   * ligand the chapter names comes up in the key's colour and a ligand it does
   * not name stays the same ghost as the rest of the structure. That is the
   * whole reason it is worth drawing — a cartoon has no ligand in it at all,
   * and "every dimer carries the same cargo" is a chapter about the cargo.
   */
  async function rebuildLigandOverlay(type, appearance) {
    // A record whose cell is gone must not be reused as if the
    // overlay were still drawn, and must not be counted by the render wait.
    dropDeadOverlayRefs();
    if (ligandOverlay && ligandOverlay.type !== type) await removeLigandOverlay();
    if (!type) { await removeLigandOverlay(); return; }
    const rows = ligandRows();
    if (!rows.length) { await removeLigandOverlay(); return; }
    const loci = selection.toLoci(rows.map(row => row.key));
    const query = {
      label: `Ligands (${rows.length})`,
      referencesCurrent: true,
      getSelection: async () => StructureSelection.Singletons(loci.structure, StructureElement.Loci.toStructure(loci)),
    };
    if (ligandOverlay) {
      // Same representation, same structure: the rows cannot have changed
      // without a reload, which rebuilds this from scratch anyway.
      return;
    }
    const component = await plugin.builders.structure.tryCreateComponentFromSelection(structure, query,
      'stereofold-ligand-overlay', { label: query.label, tags: ['stereofold-ligand-overlay'] });
    if (!component) return;
    const xrQuality = xrRepresentationQuality({ presenting: canvas.xr.isPresenting.value, representation: type });
    const built = await plugin.builders.structure.representation.addRepresentation(component, {
      type, color: appearance.color,
      typeParams: { alpha: appearance.opacity, ...(xrQuality ? { quality: xrQuality } : {}) },
      ...(appearance.color === 'uniform'
        ? { colorParams: { value: Color(colorNumber(appearance.uniformColor)) } }
        : { colorParams: xrColorParams({ color: appearance.color }) }),
    }, { initialState: { isHidden: Boolean(canvas.xr.isPresenting.value) }, tag: 'stereofold-ligand-overlay' });
    if (!built) return;
    ligandOverlay = { component, representation: built, type };
    applyInspectionTransform();
  }

  function fitDesktopPreview() {
    if (!enableXr || canvas.xr.isPresenting.value || !inspectionState || !representation?.obj
      || canvas.webgl?.isContextLost || state.status === 'context_lost' || state.status === 'recovering') return;
    canvas.handleResize?.(false);
    // A lost/restoring drawing buffer can report a zero viewport during XR
    // teardown. Mol* getFocus divides by its aspect ratio; keep the owned
    // camera untouched until there is a real desktop viewport to fit.
    const { width, height } = canvas.camera.viewport;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    canvas.commit(true);
    // A comparison keeps its own placement, but both structures must fit the
    // flat preview. Other bounds callers retain the primary subject's frame.
    const sphere = molecularBounds(true);
    if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0 || !Array.from(sphere.center).every(Number.isFinite)) return;
    const radius = sphere.radius * 1.12;
    // Fit committed molecular bounds, excluding the menu and component plates.
    // The placement transform remains applied and is saved unchanged for XR.
    const focus = cameraSnapshot({ ...canvas.camera.getFocus(sphere.center, radius), radiusMax: radius });
    if (!desktopPreviewCamera) desktopPreviewCamera = cameraSnapshot(canvas.camera.getSnapshot());
    const trackball = canvas.props?.trackball;
    const distance = Vec3.distance(focus.position, focus.target);
    // Mol* refreshes automatic limits only during its camera-reset path. This
    // temporary preview sets the camera directly, so an old source-sized limit
    // would clamp the enlarged fit on the next controls tick.
    if (trackball?.autoAdjustMinMaxDistance?.name === 'on' && Number.isFinite(trackball.maxDistance)
      && distance > trackball.maxDistance) {
      if (desktopPreviewMaxDistance && trackball.maxDistance !== desktopPreviewMaxDistance.applied)
        desktopPreviewMaxDistance = undefined;
      desktopPreviewMaxDistance ??= { original: trackball.maxDistance, applied: distance };
      desktopPreviewMaxDistance.applied = distance;
      canvas.setProps({ trackball: { maxDistance: distance } });
    }
    canvas.camera.setState(focus, 0);
    canvas.requestDraw();
  }

  function releaseDesktopPreviewLimit() {
    // A source reset can have installed newer automatic limits. Release only
    // the exact limit this preview owns, never that newer source's policy.
    if (desktopPreviewMaxDistance && canvas.props?.trackball?.autoAdjustMinMaxDistance?.name === 'on'
      && canvas.props.trackball.maxDistance === desktopPreviewMaxDistance.applied)
      canvas.setProps({ trackball: { maxDistance: desktopPreviewMaxDistance.original } });
    desktopPreviewMaxDistance = undefined;
  }

  function restoreImmersiveCamera() {
    releaseDesktopPreviewLimit();
    const saved = inspectionState && roomSeatMemory.take({ scene: liveScene(), placement: inspectionSnapshot().placement });
    if (saved) {
      // Mol* has attached the session but has not drawn a tracked frame yet.
      // Restore its scene-unit conversion and base camera together; neither is
      // a tracked eye pose. Keep the authoritative saved placement unchanged.
      canvas.camera.scale = saved.cameraScale;
      canvas.camera.setState(saved.camera, 0);
      wearerPlacedInRoom = true;
    } else {
      if (!roomCameraInitialized && inspectionState) {
        const scale = initialRoomCameraScale({ radius: molecularBounds()?.radius,
          placementScale: inspectionSnapshot().placement.scale });
        if (scale) canvas.camera.scale = scale;
      }
      if (desktopPreviewCamera) canvas.camera.setState(desktopPreviewCamera, 0);
    }
    roomCameraInitialized = true;
    desktopPreviewCamera = undefined;
  }

  /**
   * Whether a representation rebuild at the immersive quality can run now.
   *
   * The immersive session calls this on the way in and on the way out, and
   * both edges can arrive with nothing loaded, with the structure already torn
   * down, or after the wearer left again. `presenting` is checked against
   * Canvas3D rather than assumed, because the quality the rebuild picks comes
   * from that same flag and a mismatch would bake the wrong geometry.
   */
  function canRebuildForXr({ presenting = true } = {}) {
    if (!inspectionState || busy) return false;
    if (!structure?.obj?.data || !representation) return false;
    return Boolean(canvas.xr.isPresenting.value) === presenting;
  }

  async function onXrPresented() {
    if (companionRecoveryActive) { companionRecoveryPendingXr = true; return false; }
    if (!canRebuildForXr()) return false;
    // This rebuild changes geometry quality, not the user's placement. A
    // second menu-fit here races entry seating and can refuse an already
    // visible lesson when the wearer turns away from its saved room position.
    await applyInspectionAppearance({ labels: false, componentLabels: false, preservePlacement: true });
    refreshStructureSubject(snapshot());
    return true;
  }

  async function prepareEntryGeometryAdvisory() {
    const notice = { session: canvas.webgl.xr?.session, prepared: false, preparing: false };
    entryGeometryAdvisory = notice;
    await rebuildEntryGeometryAdvisory(notice);
  }

  async function rebuildEntryGeometryAdvisory(notice) {
    if (entryGeometryAdvisory !== notice || notice.session !== canvas.webgl.xr?.session || !canvas.xr.isPresenting.value) return;
    notice.preparing = true;
    try {
      const rebuilt = await onXrPresented();
      if (entryGeometryAdvisory === notice && rebuilt) notice.prepared = true;
    } catch (error) {
      if (entryGeometryAdvisory === notice) entryGeometryAdvisory = undefined;
      throw error;
    } finally { notice.preparing = false; }
  }

  function flushEntryGeometryAdvisory(drawn) {
    const notice = entryGeometryAdvisory;
    if (!notice) return;
    if (!notice.session || notice.session !== canvas.webgl.xr?.session || !canvas.xr.isPresenting.value) {
      entryGeometryAdvisory = undefined;
      return;
    }
    // Desktop loading does not estimate immersive cost. Wait for the entry
    // rebuild and a tracked draw, so the existing caption has a usable seat.
    const views = latestRoomPlacementPose?.labelViews;
    if (!drawn || busy || state.status !== 'ready' || companionRecoveryActive) return;
    if (!notice.prepared) {
      // Entry can overlap a desktop-started operation. Its completion may
      // still carry desktop geometry, so retry the skipped XR rebuild once
      // idle, with one in-flight attempt and the original session owner.
      if (!notice.preparing && canRebuildForXr()) void rebuildEntryGeometryAdvisory(notice).catch(error =>
        recordCost('xr-frame-error', { phase: 'entry-geometry-advisory', error: error?.message ?? String(error) }));
      return;
    }
    if (pendingRoomSeat || retainedEntryCheckPending || retainedPoseHidden || !talkCaption
      || !latestRoomPlacementPose?.headInRoom || !(views?.length === 2 || (views?.length === 1 && views[0].eye === 'none'))) return;
    // Read the accepted current scene here: a source swap while entry was
    // waiting must neither replay the old warning nor retain it for later.
    const message = appliedGeometryBudget?.message;
    if (typeof message === 'string' && message && !showTalkOutcome(message, 6000)) return;
    entryGeometryAdvisory = undefined;
  }

  /**
   * The same chapter, applied to a density map.
   *
   * A chapter on this tier still has a background, an opacity, a clipping plane
   * and a fog band. Its colour is the one radial key re-stated every chapter
   * (wall teal, crown amber), not a per-chapter repaint — see `volume-color.mjs`
   * for the cutoff. What it does NOT have is a representation type to switch,
   * residue labels, a ligand overlay, a selection to mark or an emphasis key
   * to paint, and every one of those steps in the atomic path below reads
   * `structure.obj.data` and would throw on a volume.
   */
  async function applyVolumeAppearance({ depth = false } = {}) {
    const appearance = inspectionSnapshot().appearance;
    const camera = canvas.camera.getSnapshot();
    // A chapter change re-states the radial key and the gloss
    // rather than repainting grey. Same contour, so Mol* re-themes without
    // rebuilding the mesh; the chapters keep changing placement, clipping and
    // fog only, as the build comment promises.
    const xrMaterial = xrRepresentationMaterial({ presenting: canvas.xr.isPresenting.value,
      representation: VOLUME_REPRESENTATION });
    await representation.update(createVolumeRepresentationParams(plugin, volume.obj.data, {
      type: VOLUME_REPRESENTATION,
      typeParams: { ...volumeIsosurfaceParams({ contour: sourceRecord.contour, opacity: appearance.opacity }),
        ...(xrMaterial ? { material: xrMaterial } : {}) },
      // Same selection function as the build, so a chapter
      // change cannot quietly ask for a different theme than the build did.
      // The registration is re-checked here because a recovered WebGL context
      // rebuilds the plugin, and the rebuilt registry has never seen the theme.
      ...volumeColorSelection({ isoExtent: volumeIsoExtent,
        registered: (volumeThemeRegistered = registerVolumeRadialColorTheme(plugin)),
        fallbackColor: Color(colorNumber(VOLUME_UNIFORM_COLOR)) }),
    })).commit({ revertOnError: true });
    builtRepresentation = VOLUME_REPRESENTATION;
    appliedGeometryBudget = undefined;
    // Re-read the paint after the re-theme. A chapter that
    // silently lost the key is exactly the failure the run-7 capture showed,
    // and this is where it would show up second.
    volumePaint = volumeThemePaint(representation);
    if (!volumePaint.themed) {
      recordCost('volume-theme-fallback', { theme: VOLUME_RADIAL_COLOR_THEME,
        reason: volumeColorFallbackReason({ isoExtent: volumeIsoExtent, registered: volumeThemeRegistered })
          ?? 'theme_dropped_by_molstar',
        colorType: volumePaint.colorType, uniform: volumePaint.uniform, phase: 'appearance' });
    }
    if (canvas.xr.isPresenting.value) canvas.camera.forceFull = appearance.clipping === 0;
    canvas.camera.setState(typeof wearerPlacement !== 'undefined' && wearerPlacement.holdsPlacement()
      ? { ...camera, position: canvas.camera.state.position, target: canvas.camera.state.target, up: canvas.camera.state.up, radius: canvas.camera.state.radius }
      : camera, 0);
    canvas.setProps({ renderer: { backgroundColor: Color(colorNumber(appearance.background)),
      highlightColor: Color(0x58dcc9), selectColor: Color(colorNumber(appearance.highlightColor)) },
      marking: { highlightEdgeColor: Color(0x58dcc9), selectEdgeColor: Color(colorNumber(appearance.highlightColor)) } });
    applyInspectionTransform();
    if (depth) {
      canvas.commit(true);
      canvas.setProps({ cameraClipping: { radius: appearance.clipping, far: true },
        cameraFog: appearance.fog ? { name: 'on', params: { intensity: appearance.fog } } : { name: 'off', params: {} } });
      if (canvas.xr.isPresenting.value) { lastDepthMinFar = 0; applyImmersiveDepth(); }
    }
    recordCost('appearance-cost', { representation: VOLUME_REPRESENTATION, built: VOLUME_REPRESENTATION,
      recreated: false, atomSites: 0, rebuildMs: 0, restMs: 0, totalMs: 0,
      themed: volumePaint.themed, colorType: volumePaint.colorType });
  }

  async function applyInspectionColorTheme() {
    const began = now(), appearance = inspectionSnapshot().appearance;
    const targets = [{ repr: representation, data: structure.obj.data, look: appearance }];
    if (ligandOverlay) targets.push({ repr: ligandOverlay.representation, data: ligandOverlay.component.obj.data, look: appearance });
    const plans = stylesState.length ? styleLayerDefinitions() : [];
    if (plans.length !== styleLayers.length) throw Error('The scoped style layers changed before recolouring.');
    plans.forEach((plan, index) => targets.push({ repr: styleLayers[index].representation,
      data: styleLayers[index].component.obj.data, look: plan.look }));
    const update = plugin.state.data.build();
    for (const { repr, data, look } of targets) {
      const cell = plugin.state.data.cells.get(repr.ref);
      if (!cell?.obj || cell.status !== 'ok') throw Error('The molecular representation is unavailable for recolouring.');
      const type = cell.params.values.type.name;
      const colorTheme = createStructureColorThemeParams(plugin, data, type, look.color,
        look.color === 'uniform' ? { value: Color(colorNumber(look.uniformColor)) }
          : xrColorParams({ color: look.color, representation: type, presenting: canvas.xr.isPresenting.value }));
      // Retain all type/size props and overpaint/transparency children. Mol* updates only its colour buffers
      // when the visual allows it. The surrounding mutation still awaits draw.
      update.to(repr.ref).update({ ...cell.params.values, colorTheme });
    }
    await update.commit({ revertOnError: true });
    const elapsed = Math.round(now() - began);
    recordCost('appearance-cost', { representation: appearance.representation, built: builtRepresentation,
      recreated: false, themeOnly: true, targets: targets.length, atomSites: structureAtomSites(plugin),
      rebuildMs: elapsed, restMs: 0, totalMs: elapsed });
  }

  async function applyInspectionAppearance({ signal, labels = true, depth = false, componentLabels: plates = true,
    emphasis = true, recovering = false, check = recovering ? () => assertContext({ recovering: true }) : undefined,
    onRetainedRollback, recoverWithoutFit = false, explicitPlacement = false, preservePlacement = false } = {}) {
    // Session-edge rebuilds do not run through mutate. They must nevertheless
    // own admission and the release barrier while selectors can be replaced.
    if (appearanceWork) throw failure('viewer_busy', 'A molecular appearance is still rendering.');
    const work = !busy ? beginWork(retainCurrent()) : undefined;
    const owner = { work };
    appearanceWork = owner;
    if (work) busy = true;
    try {
    check?.();
    if (volume) {
      await applyVolumeAppearance({ depth });
      if (work && state.status === 'ready') {
        canvas.commit(!canvas.xr.isPresenting.value);
        await waitForFrame(undefined, { recovering });
      }
      return;
    }
    const appearance = inspectionSnapshot().appearance;
    inspectionRepresentationName(appearance.representation);
    if (!INSPECTION_COLORS.has(appearance.color)) throw failure('invalid_inspection', 'Unsupported inspection color.');
    const camera = canvas.camera.getSnapshot();
    // What this device can actually finish drawing.
    //
    // The saved appearance still says what the chapter asked for — that is what
    // the Mac renders and what the detail view shows. `built` is what this
    // headset draws, and on a Quest 2 past the heavy tier a surface is not on
    // that list. `representationForBudget` in xr-render-budget.mjs is the only
    // statement of the rule; everything below builds whatever it returns.
    const built = representationForBudget(appearance.representation, {
      presenting: Boolean(canvas.xr.isPresenting.value),
      deviceClass: sessionDeviceClass(currentXrSession(), globalThis.navigator),
      atomSites: structureAtomSites(plugin),
    });
    // Null off a headset. The representation name
    // matters: a surface takes its own tier, because Mol* turns a tier into a
    // grid resolution for a surface and into a subdivision count for the rest.
    const xrQuality = xrRepresentationQuality({ presenting: canvas.xr.isPresenting.value,
      representation: built });
    // A specular lobe is the only depth cue a surface gets in immersion, where
    // there is no occlusion pass, and it costs no extra fragment work.
    const xrMaterial = xrRepresentationMaterial({ presenting: canvas.xr.isPresenting.value,
      representation: built });
    // Chain identity uses the same palette on every representation and session edge.
    const xrColor = xrColorParams({ presenting: canvas.xr.isPresenting.value,
      representation: built, color: appearance.color });
    const geometry = geometryFor(built);
    const params = createStructureRepresentationParams(plugin, structure.obj.data, {
      type: built, color: appearance.color,
      typeParams: { alpha: appearance.opacity, ...(xrQuality ? { quality: xrQuality } : {}),
        ...(xrMaterial ? { material: xrMaterial } : {}), ...geometry.typeParams,
        // Spatial smoothing grids stay in the old instance frame after a room
        // placement. Group colors ride the mesh through fits, turns and grabs.
        ...(canvas.xr.isPresenting.value && ['molecular-surface', 'gaussian-surface'].includes(built)
          ? { smoothColors: { name: 'off', params: {} } } : {}),
        ...xrBallAndStickParams({ representation: built, presenting: canvas.xr.isPresenting.value,
          atoms: structure.obj.data.elementCount, level: geometry.level }) },
      colorParams: appearance.color === 'uniform'
        ? { value: Color(colorNumber(appearance.uniformColor)) }
        : (xrColor ?? undefined),
    });
    // The single most expensive thing a chapter does, timed.
    // A representation whose TYPE changes is recreated by Mol* rather than
    // updated, which is a full geometry build over every atom site in the tier.
    const rebuildBegan = now();
    const recreated = built !== builtRepresentation;
    const previousRepresentation = representation;
    const previousBuilt = builtRepresentation, previousGeometry = appliedGeometryBudget;
    const staging = Boolean(canvas.xr.isPresenting.value) && !recoverWithoutFit
      && JSON.stringify(representation.cell.params.values.type) !== JSON.stringify(params.type);
    const transition = staging ? beginSceneTransition({ session: currentXrSession(), operation: 'appearance' }) : undefined;
    let staged, countedPrevious = false;
    try {
      if (staging) {
        const builder = plugin.state.data.build();
        staged = builder.to(previousRepresentation.cell.transform.parent)
          .apply(StateTransforms.Representation.StructureRepresentation3D, params,
            { ref: `stereofold-transition-${crypto.randomUUID()}`, state: { isHidden: true } }).selector;
        // The legacy water/ligand masks are state-tree modifiers rather than
        // saved scene visibility. Copy them onto the hidden candidate, keeping
        // the retained representation's modifiers intact for drawing/rollback.
        for (const base of Object.values(VISIBILITY_LAYER_REF)) {
          const layer = plugin.state.data.cells.get(representationLayerRef(previousRepresentation, base));
          if (layer?.obj) builder.to(staged).apply(layer.transform.transformer, layer.params.values,
            { ref: representationLayerRef(staged, base) });
        }
        await commitRepresentationUpdate(builder, check);
        staged.checkValid();
        await prepareUploads(staged, check);
        check?.();
        representation = staged;
        // Entry withholds the posed bodies of an animation, while its hidden
        // source template can remain registered in Canvas3D. Count that actual
        // retained template until removal; a hidden flag is not scene membership.
        const attachedObjects = retainedPoseHidden ? new Set(canvas.getRenderObjects()) : undefined;
        countedPrevious = !retainedPoseHidden || previousRepresentation.obj.data.repr.renderObjects
          .some(object => attachedObjects.has(object));
        if (countedPrevious) retainedRepresentationCount++;
      } else await commitRepresentationUpdate(representation.update(params), check);
      check?.();
      builtRepresentation = built;
      appliedGeometryBudget = geometryBudgetReceipt(geometry);
      if (canvas.xr.isPresenting.value && companionRecord?.representation)
        plugin.state.data.updateCellState(companionRecord.representation.ref, { isHidden: true });
      await paintCompanion();
      const rebuilt = now();
      // The ligands keep the representation the chapter asked
      // for when the budget took it off the rest of the structure. Built before
      // the emphasis below, because the emphasis paints onto both.
      await rebuildLigandOverlay(ligandOverlayForBudget(appearance.representation, built,
        { ligandAtomSites: ligandAtomSites() }), appearance);
      // A representation rebuild drops the emphasis layers
      // hanging off it, which is why a tour chapter paints them after its
      // appearance. Every other route to a rebuild — the agent's appearance
      // command, a render-quality change, the menu's own representation rows —
      // had no such rule, and a lesson chapter turned plain grey the moment one
      // of them ran. The key the structure is wearing is repainted here instead,
      // so no caller has to know that a rebuild costs it.
      await rebuildStyleLayers();
      await lessonFigure.refresh();
      const keptEmphasis = currentEmphasisPlan();
      // The pass runs for a selection even with no lesson key, because
      // the selection's own layer is the last layer of this same overpaint.
      const keptSelection = currentSelectionPlan();
      if (emphasis && keptEmphasis) await paintEmphasisLayers(keptEmphasis, { transparency: false, recovering });
      else if (keptSelection?.keys.length) await paintEmphasisLayers({ colours: [], faded: [], lit: [], transparency: 0 }, { transparency: false, recovering });
      // For the same reason, and after it. A rebuild drops the
      // hidden set's layer with the emphasis layers, and a wearer who asked for a
      // chain to go does not expect it back because the colour theme changed.
      // Painted after the emphasis so full transparency wins over a context fade
      // on the same rows.
      await paintVisibilityLayers(undefined, { recovering });
      if (canvas.xr.isPresenting.value) canvas.camera.forceFull = appearance.clipping === 0;
      markSelection(state.selectionKeys);
      canvas.camera.setState(typeof wearerPlacement !== 'undefined' && wearerPlacement.holdsPlacement()
        ? { ...camera, position: canvas.camera.state.position, target: canvas.camera.state.target, up: canvas.camera.state.up, radius: canvas.camera.state.radius }
        : camera, 0);
      canvas.setProps({ renderer: { backgroundColor: Color(colorNumber(appearance.background)),
        highlightColor: Color(0x58dcc9), selectColor: Color(colorNumber(appearance.highlightColor)) },
        marking: { highlightEdgeColor: Color(0x58dcc9), selectEdgeColor: Color(colorNumber(appearance.highlightColor)) } });
      applyInspectionTransform();
      if (labels) await rebuildInspectionLabels();
      // The name plates follow the residue labels through every
      // rebuild, on the same billboarded path and at the same seat-derived size.
      // Rebuilt even when `labels` is off: the two flags are independent, and a
      // chapter can ask for named parts without residue labels.
      //
      // `componentLabels: false` is the session edge alone, where the
      // `isPresenting` subscriber owns the plates instead. Everything else — a
      // chapter, a quality change, the menu's representation rows — rebuilds them
      // here, because a caller must not have to know a rebuild costs them.
      if (plates) await rebuildComponentLabels();
      check?.();
      // Every new molecular layer starts hidden, even when the base type is
      // unchanged. One measurement admits the complete final silhouette.
      const hiddenCells = [staged, ...styleLayers.map(layer => layer.representation), ligandOverlay?.representation, companionRecord?.representation]
        .filter(cell => cell?.obj && cell.obj.data.repr.state.visible === false);
      if (!recoverWithoutFit && !preservePlacement && typeof immersiveSession !== 'undefined' && immersiveSession?.platePoints?.()?.length
        && !(typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0 && wearerPlacement.holdsPlacement())) {
        await awaitPlacementViews();
        const requested = inspectionSnapshot().placement;
        // Outside XR the check returns synchronously; keep one rejection path.
        const cleared = await Promise.resolve().then(() => clearHeldPlatePlacement(requested, { signal, hidden: hiddenCells.map(cell => cell.obj.data.repr), keepClearSeat: true,
          allowOffscreen: explicitPlacement,
          keepWearer: explicitPlacement || (typeof wearerPlacement !== 'undefined' && wearerPlacement?.holdsPlacement())
        })).catch(error => {
          if (typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0 && wearerPlacement.holdsPlacement()
            && ['FIT_STALE', 'FIT_CANCELLED'].includes(error.code)) return requested;
          throw error;
        });
        if (!(typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0 && wearerPlacement.holdsPlacement()) && (cleared.scale !== requested.scale || cleared.translation.some((value, axis) => value !== requested.translation[axis]))) {
          inspectionState.place(cleared, 'place');
          applyInspectionTransform();
          recordManipulation('outcome', { status: 'adjusted', action: 'configure',
            reason: 'Moved or resized the structure to clear the held menu and reply plate.' });
        }
      }
      // A quality-only rebuild deliberately skips fitting. Its accepted
      // retained geometry must still be visible before the draw receipt;
      // otherwise the wait counts figure layers that entry left hidden.
      if (!recoverWithoutFit && typeof showRetainedPose === 'function') showRetainedPose();
      check?.();
      if (!recoverWithoutFit) for (const cell of hiddenCells) {
        if (typeof molecularAnimation !== 'undefined' && molecularAnimation.snapshot() && cell !== companionRecord?.representation) continue;
        plugin.state.data.updateCellState(cell.ref, { isHidden: false });
      }
      if (typeof molecularAnimation !== 'undefined') await molecularAnimation.refresh();
      if (staged) {
        canvas.commit(false);
        await waitForFrame(undefined, { recovering });
        check?.();
        transition.firstFrame();
        // Retain the old cell for rollback until the replacement-only draw too.
        canvas.remove(previousRepresentation.obj.data.repr);
        if (countedPrevious) retainedRepresentationCount--;
        countedPrevious = false;
        canvas.commit(false);
        await waitForFrame(undefined, { recovering });
        check?.();
        transition.oldRemoved();
        // Deleting its cell also deletes its old overpaint/transparency children.
        await plugin.state.data.build().delete(previousRepresentation.ref).commit({ revertOnError: true });
      }
      if (depth) {
        // Mol* converts the percentage into a radius using committed geometry.
        // Commit the new representation, labels and placement first; otherwise
        // a combined surface/cutaway change uses the previous scene's radius.
        canvas.commit(!canvas.xr.isPresenting.value);
        canvas.setProps({ cameraClipping: { radius: appearance.clipping, far: true },
          cameraFog: appearance.fog ? { name: 'on', params: { intensity: appearance.fog } } : { name: 'off', params: {} } });
        // The saved fog fades a structure the wearer pushed away
        // into the background colour, so immersion keeps its own depth band.
        // `appearance.fog` is untouched and comes back when the session ends.
        if (canvas.xr.isPresenting.value) { lastDepthMinFar = 0; applyImmersiveDepth(); }
      }
      recordCost('appearance-cost', { representation: appearance.representation, built, recreated,
        atomSites: structureAtomSites(plugin), rebuildMs: Math.round(rebuilt - rebuildBegan),
        restMs: Math.round(now() - rebuilt), totalMs: Math.round(now() - rebuildBegan) });
      if (work && state.status === 'ready') {
        canvas.commit(!canvas.xr.isPresenting.value);
        await waitForFrame(undefined, { recovering });
      }
      transition?.finish();
    } catch (error) {
      try { globalThis.__stereofoldDiagnostics?.record?.('appearance-failure', {
        message: String(error?.message ?? error).replace(/(?:https?|wss?):\/\/[^\s)]+/gu, '<runtime>'),
        stack: String(error?.stack ?? '').replace(/(?:https?|wss?):\/\/[^\s)]+/gu,
          url => `<runtime>${url.match(/:\d+:\d+$/u)?.[0] ?? ''}`),
        stagedRef: staged?.ref, stagedPresent: Boolean(staged?.obj),
        previousRef: previousRepresentation?.ref, previousPresent: Boolean(previousRepresentation?.obj),
        currentRef: representation?.ref, currentPresent: Boolean(representation?.obj),
      }); } catch { /* Diagnostics never replace the original failure. */ }
      transition?.finish('failed', error);
      if (staged && representation === staged && plugin.state.data.cells.has(previousRepresentation.ref)) {
        representation = previousRepresentation;
        if (countedPrevious) retainedRepresentationCount--;
        builtRepresentation = previousBuilt; appliedGeometryBudget = previousGeometry;
        canvas.add(previousRepresentation.obj.data.repr);
      }
      if (staged && representation !== staged && plugin.state.data.cells.has(staged.ref)) {
        // No waiter may validate a selector after rollback deletes its cell.
        // Preserve cancellation as the outcome instead of manufacturing a
        // missing-selector fault in the next didDraw notification.
        for (const settle of frameWaiters) if (settle.representationRef === staged.ref)
          settle(failure('appearance_cancelled', 'The staged molecular appearance was rolled back.'));
        await plugin.state.data.build().delete(staged.ref).commit({ revertOnError: true });
        canvas.commit(!canvas.xr.isPresenting.value);
      }
      if (staged && representation === previousRepresentation && plugin.state.data.cells.has(previousRepresentation.ref)) onRetainedRollback?.();
      throw error;
    }
    } finally {
      if (appearanceWork === owner) appearanceWork = undefined;
      if (work) { busy = false; work.finish(); }
    }
  }

  /**
   * The density tier's build, on the SAME path as the atomic one.
   *
   * Called from `buildCandidate` below rather than from a second entry point,
   * so a grow into this tier is the same XR-frame swap every other tier takes:
   * the candidate is built hidden, `showCandidate` reveals it and waits for one
   * frame, and `transitionRoomAnchor` holds the room placement across it.
   *
   * Nothing here threads through the atomic chain, and it cannot: a volume has
   * no trajectory, no model number, no assembly, no selection adapter, no
   * element count and no representation registry entry. Every one of those
   * steps would throw on it, which is why this returns early with a candidate
   * whose `structure` is absent and whose `volume` is present.
   */
  async function buildVolumeCandidate(source, settings, operation, candidate, check) {
    const data = await plugin.builders.data.rawData({ data: source.map, label: source.id },
      { ref: candidate.rootRef, state: { isGhost: true } });
    check();
    state.replacementPhase = 'parsing';
    const parsed = await buildTransitionCell(plugin.state.data.build().to(data)
      .apply(StateTransforms.Data.ParseCcp4), check);
    check();
    const volume = await buildTransitionCell(plugin.state.data.build().to(parsed)
      .apply(StateTransforms.Volume.VolumeFromCcp4, { entryId: source.id }), check);
    check();
    if (!volume?.obj?.data?.grid) throw failure('empty_experience_stage', 'The density map parsed to no grid.');
    candidate.volume = volume;
    if (operation) await checkpoint(operation, 'after_parse');
    state.replacementPhase = 'representation';
    // Measure the density before drawing it. The grid cell's own
    // sphere frames the empty box the filament was deposited in (585 A); the
    // thresholded voxels frame the filament inside it (307 A). One scan: the
    // index bbox seats the measured screen-space fit, the centroid and
    // principal axis paint the radial key, and an empty answer refuses here —
    // a contour above the map's own maximum meshes nothing to frame.
    const grid = volume.obj.data.grid;
    const scan = measureIsoExtent(grid.cells, source.contour);
    if (!scan) throw failure('empty_experience_stage', 'No density in this map reaches the lesson contour.');
    candidate.isoExtent = volumeIsoExtentOf(grid, scan, source.contour);
    // Built once, at the absolute contour the lesson was authored at, and never
    // rebuilt: chapters on this tier change placement, clipping and fog only.
    // Painted by the radial theme around the measured axis —
    // wall teal inside the cutoff, EB3 amber outside it — at the same gloss
    // the atomic surfaces wear in immersion. A registry that refused the theme
    // keeps the uniform grey and says so, rather than refusing the tier.
    // A late `registerVolumeRadialColorTheme` is still the right
    // call — a plugin rebuilt under a recovered context has an empty registry —
    // but it is now a real membership test, and `volumeThemeRegistered` holds
    // the answer for the ring and the snapshot.
    volumeThemeRegistered = registerVolumeRadialColorTheme(plugin);
    const themed = volumeThemeRegistered;
    const immersiveMaterial = xrRepresentationMaterial({ presenting: canvas.xr.isPresenting.value,
      representation: VOLUME_REPRESENTATION });
    const representationParams = createVolumeRepresentationParams(plugin, volume.obj.data, {
      type: VOLUME_REPRESENTATION,
      typeParams: { ...volumeIsosurfaceParams({ contour: source.contour }),
        ...(immersiveMaterial ? { material: immersiveMaterial } : {}) },
      ...volumeColorSelection({ isoExtent: candidate.isoExtent, registered: themed,
        fallbackColor: Color(colorNumber(VOLUME_UNIFORM_COLOR)) }),
    });
    candidate.representation = asViewerRepresentation(await buildTransitionCell(plugin.state.data.build().to(volume)
      .apply(StateTransforms.Representation.VolumeRepresentation3D, representationParams,
        { state: { isHidden: true } }), check));
    check();
    if (!candidate.representation) throw failure('missing_representation', 'Mol* did not create the isosurface.');
    candidate.representation.checkValid();
    // Measure the mesh, do not repeat the lesson's promise.
    //
    // Recording `triangles: 0` here is the one
    // value `isosurfaceForBudget` refuses, and the value that makes
    // `quest2FramebufferScale` fall back to the atom ladder — and a density
    // tier's atom count is zero, so a 178,236-triangle mesh would have bought
    // the LIGHT framebuffer. `representationTriangles` reads the count out of
    // the geometry Mol* actually built, which is the number the demo index
    // promises and the number every rule in `xr-render-budget.mjs` keys on.
    candidate.triangles = representationTriangles(candidate.representation);
    // What the framing will be solved from, on the same record
    // as the size. `isoRadius` is the density's own Angstroms against the
    // grid cell's 585, so the before and after are read off this line rather
    // than off a screenshot.
    // Measure the paint the same way the size is measured. A
    // record can carry `themed:true` and still draw cream, because `themed` is
    // only what Mol* was ASKED for; `volumeThemePaint` reads the colour texture
    // Mol* actually filled, so the two can disagree and the ring will say so.
    candidate.paint = volumeThemePaint(candidate.representation);
    recordCost('volume-build', { id: source.id, contour: source.contour,
      bytes: source.map.byteLength, triangles: candidate.triangles,
      isoRadius: Math.round((candidate.isoExtent?.radius ?? 0) * 10) / 10,
      isoVoxels: candidate.isoExtent?.voxels ?? 0,
      themed: candidate.paint.themed, asked: themed, colorType: candidate.paint.colorType,
      wall: candidate.paint.wall, crown: candidate.paint.crown, other: candidate.paint.other,
      gloss: immersiveMaterial !== null });
    if (!candidate.paint.themed) {
      recordCost('volume-theme-fallback', { theme: VOLUME_RADIAL_COLOR_THEME,
        reason: volumeColorFallbackReason({ isoExtent: candidate.isoExtent, registered: themed })
          ?? 'theme_dropped_by_molstar',
        colorType: candidate.paint.colorType, uniform: candidate.paint.uniform });
    }
    await prepareUploads(candidate.representation, check);
    if (operation) await checkpoint(operation, 'after_representation');
    return candidate;
  }

  async function buildCandidate(source, settings, operation) {
    const candidate = { rootRef: crypto.randomUUID(), source, visible: settings.visible, selectionKeys: [], lastPick: null };
    candidateRecords.add(candidate);
    if (operation) operation.candidate = candidate;
    const check = () => operation ? assertLoad(operation) : assertContext({ recovering: true });
    check();
    if (source.map) return await buildVolumeCandidate(source, settings, operation, candidate, check);
    const data = await plugin.builders.data.rawData({ data: source.cif, label: source.id },
      { ref: candidate.rootRef, state: { isGhost: true } });
    check();
    const parseBegan = now();
    state.replacementPhase = 'parsing';
    // The same transforms as Mol*'s mmCIF provider, on the yielding runtime.
    const cif = plugin.state.data.build().to(data)
      .apply(StateTransforms.Data.ParseCif, undefined, { state: { isGhost: true } });
    const trajectory = await buildTransitionCell(cif.apply(StateTransforms.Model.TrajectoryFromMmCif), check);
    if ((cif.selector.obj?.data.blocks.length ?? 0) > 1) plugin.state.data.updateCellState(cif.ref, { isGhost: false });
    check();
    trajectory.checkValid();
    if (operation) await checkpoint(operation, 'after_parse');
    let modelIndex = -1;
    for (let i = 0; i < trajectory.obj.data.frameCount; i += 1) {
      const frame = trajectory.obj.data.getFrameAtIndex(i);
      const model = canvas.xr.isPresenting.value && Task.is(frame)
        ? await runTransitionTask(frame, transitionGuard(check)) : await Task.resolveInContext(frame);
      check();
      if (model.modelNum === settings.modelNumber) {
        if (modelIndex !== -1) throw failure('ambiguous_model', 'The CIF repeats the requested source model number.');
        modelIndex = i;
      }
    }
    if (modelIndex === -1) throw failure('missing_model', 'The CIF does not contain the requested model.');
    const model = await buildTransitionCell(plugin.state.data.build().to(trajectory)
      .apply(StateTransforms.Model.ModelFromTrajectory, { modelIndex }), check);
    check();
    model.checkValid();
    if (settings.assemblyId !== 'asymmetric_unit'
        && !ModelSymmetry.Provider.get(model.obj.data)?.assemblies.some(assembly => assembly.id === settings.assemblyId)) {
      throw failure('missing_assembly', 'The requested assembly is not defined in this model.');
    }
    const structureType = settings.assemblyId === 'asymmetric_unit'
      ? { name: 'model', params: {} }
      : { name: 'assembly', params: { id: settings.assemblyId } };
    candidate.structure = await buildTransitionCell(plugin.state.data.build().to(model)
      .apply(StateTransforms.Model.StructureFromModel, { type: structureType }), check);
    check();
    candidate.structure.checkValid();
    candidate.selection = canvas.xr.isPresenting.value
      ? await createSelectionAdapterAsync(candidate.structure.obj.data, source.catalog, { check: transitionGuard(check) })
      : createSelectionAdapter(candidate.structure.obj.data, source.catalog);
    check();
    candidate.selectionKeys = selectedKeys(settings.selectionKeys, candidate.selection);
    if (settings.initialInspection) {
      candidate.coordinateFrame = settings.initialInspection.coordinateFrame;
      candidate.visibility = settings.initialInspection.visibilityPatch
        ? resolveVisibility(emptyVisibility(), settings.initialInspection.visibilityPatch, availableChains(candidate.selection.rows))
        : normalizeVisibility(settings.initialInspection.visibility);
      if (settings.initialInspection.frameVisibleFigureOnce) {
        const hidden = new Set(hiddenRowKeys(candidate.selection.rows, candidate.visibility, candidate.selectionKeys));
        const keys = candidate.selection.rows.filter(row => row.atomSites?.length && !hidden.has(row.key)).map(row => row.key);
        const target = keys.length ? StructureElement.Loci.getBoundingSphere(candidate.selection.toLoci(keys)) : undefined;
        if (target?.radius > 0) candidate.initialFigureFrame = { target,
          fitted: { desktop: settings.initialInspection.preserveFigureFrame === true, xr: settings.initialInspection.preserveFigureFrame === true } };
      }
    }
    if (!plugin.representation.structure.registry.get(settings.representation).isApplicable(candidate.structure.obj.data)) {
      throw failure('unsupported_representation', 'This representation has no supported geometry for the loaded structure.');
    }
    recordCost('source-load-cost', { phase: 'parse-model-selection', elapsedMs: now() - parseBegan });
    const representationBegan = now();
    state.replacementPhase = 'representation';
    const visibleExpression = experienceVisibilityExpression(MolScriptBuilder, settings.visible, candidate.structure.obj.data);
    const representationSource = visibleExpression
      ? await plugin.builders.structure.tryCreateComponentFromExpression(candidate.structure, visibleExpression, 'experience-visible', { label: 'Experience stage' })
      : candidate.structure;
    check();
    if (!representationSource?.obj?.data?.elementCount) throw failure('empty_experience_stage', 'The requested assembly stage contains no atoms.');
    // A structure loaded while the wearer is already in the headset must not
    // be built at desktop tessellation and then rebuilt: that is two builds
    // and a visible stall inside immersion. Off a headset this is null and the
    // build is unchanged.
    const initialXrQuality = xrRepresentationQuality({ presenting: canvas.xr.isPresenting.value,
      representation: settings.representation });
    const initialXrMaterial = xrRepresentationMaterial({ presenting: canvas.xr.isPresenting.value,
      representation: settings.representation });
    candidate.companionState = settings.companionState;
    const initialGeometry = settings.companionState ? comparisonGeometry(candidate)[1]
      : geometryFor(settings.representation, representationSource.obj.data);
    candidate.geometryBudget = geometryBudgetReceipt(initialGeometry);
    const initialTypeParams = { ...(settings.initialInspection ? { alpha: 0 } : {}), ...(initialXrQuality ? { quality: initialXrQuality } : {}),
      ...(initialXrMaterial ? { material: initialXrMaterial } : {}), ...initialGeometry.typeParams,
      ...(canvas.xr.isPresenting.value && ['molecular-surface', 'gaussian-surface'].includes(settings.representation)
        ? { smoothColors: { name: 'off', params: {} } } : {}),
      ...xrBallAndStickParams({ representation: settings.representation, presenting: canvas.xr.isPresenting.value,
        atoms: representationSource.obj.data.elementCount, level: initialGeometry.level }) };
    // Use the same root chain palette on initial load and later appearance changes.
    const initialXrColor = xrColorParams({ presenting: canvas.xr.isPresenting.value,
      representation: settings.representation, color: 'chain-id' });
    const representationBuilder = plugin.state.data.build();
    candidate.representation = asViewerRepresentation(plugin.builders.structure.representation.buildRepresentation(representationBuilder, representationSource, {
      type: settings.representation, color: 'chain-id',
      ...(Object.keys(initialTypeParams).length > 0 ? { typeParams: initialTypeParams } : {}),
      ...(initialXrColor ? { colorParams: initialXrColor } : {}),
    }, { initialState: { isHidden: true } }));
    await commitRepresentationUpdate(representationBuilder, check);
    check();
    if (!candidate.representation) throw failure('missing_representation', 'Mol* did not create the representation.');
    candidate.representation.checkValid();
    recordCost('source-load-cost', { phase: 'representation', elapsedMs: now() - representationBegan });
    const uploadBegan = now();
    await prepareUploads(candidate.representation, check);
    recordCost('source-load-cost', { phase: 'upload', elapsedMs: now() - uploadBegan });
    const actual = liveScene(candidate);
    if (actual.modelNumber !== settings.modelNumber || actual.assemblyId !== settings.assemblyId) {
      throw failure('structure_mismatch', 'The constructed structure differs from the requested model or assembly.');
    }
    if (operation) await checkpoint(operation, 'after_representation');
    return candidate;
  }

  /**
   * The bounds of whatever is loaded, atoms or density.
   *
   * Every placement in this file is solved from one bounding sphere — the
   * entry seat, the source-transition anchor that holds the room placement
   * across a grow, and the lesson framing. A volume's sphere comes from its
   * grid's own cell rather than from a molecular boundary, and without this the
   * grow into the density tier fails closed at `transitionBounds` and drops the
   * wearer's placement.
   */
  function recordBoundingSphere(record) {
    // Placement is saved in source radii around the source centre. An
    // animation envelope is a framing target, never a new coordinate system:
    // installing or clearing a clip must not move an unchanged placement.
    const molecular = record?.structure?.obj?.data?.boundary?.sphere;
    if (molecular) return molecular;
    // Frame the density, not the grid cell. The cell's own
    // sphere is the whole 675 A box the map was deposited in (585 A radius);
    // the measured isosurface sphere is the 443 A filament inside it (307 A).
    // Framing the cell seats the structure at eighteen per cent of the lens.
    // The corners ride along as `extrema`, which is the
    // shape `focusSelection` reads for its measured screen-space fit; every
    // other reader takes `center` and `radius` and never sees them.
    const iso = record?.isoExtent ?? volumeIsoExtent;
    if (iso && Array.isArray(iso.center) && iso.center.length === 3
      && Number.isFinite(iso.radius) && iso.radius > 0) {
      return { center: Vec3.create(iso.center[0], iso.center[1], iso.center[2]),
        radius: iso.radius, ...(Array.isArray(iso.corners) ? { extrema: iso.corners } : {}) };
    }
    const grid = record?.volume?.obj?.data?.grid;
    return grid ? Grid.getBoundingSphere(grid) : undefined;
  }

  /**
   * The bounds of whatever this viewer currently has loaded.
   *
   * Every room placement in this file is solved from this one sphere, so it is
   * the single place that knows a scene can be a density map. A volume's
   * sphere is its measured isosurface extent, falling back to the grid cell
   * only for a record built before the measurement existed.
   */
  function loadedSphere() {
    return recordBoundingSphere({ structure, volume });
  }

  function transitionBounds(record, visible) {
    const sphere = recordBoundingSphere(record);
    if (!sphere?.center || !Number.isFinite(sphere.radius) || sphere.radius <= 0) {
      throw failure('source_transition_bounds', 'The source has no finite molecular bounds for an XR transition.');
    }
    const shown = catalogVisibleBounds(record.source?.catalog, visible ?? record.visible);
    return { base: { center: Array.from(sphere.center), radius: sphere.radius },
      visible: shown ? { center: [...shown.center], radius: shown.radius } : { center: Array.from(sphere.center), radius: sphere.radius } };
  }

  function setSourceCoordinateFrame(frame, expectedSource) {
    assertReady();
    if (liveScene().sourceSha256 !== expectedSource) throw failure('source_changed', 'The lesson coordinate frame belongs to a different source.');
    if (frame !== undefined && (typeof frame !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/iu.test(frame)))
      throw failure('invalid_coordinate_frame', 'The lesson coordinate frame is invalid.');
    sourceCoordinateFrame = frame;
  }

  function transitionRoomAnchor(previous, candidate, settings) {
    if (!settings.preserveRoomPlacement || !previous || !inspectionState) return undefined;
    const prior = transitionBounds(previous);
    const next = transitionBounds(candidate, settings.visible);
    const anchor = preserveSourceTransitionAnchor({ priorBase: prior.base, priorVisible: prior.visible,
      priorPlacement: inspectionSnapshot().placement, priorCameraScale: canvas.camera.scale,
      nextBase: next.base, nextVisible: next.visible,
      priorCoordinateFrame: previous.coordinateFrame, nextCoordinateFrame: candidate.coordinateFrame });
    if (previous.coordinateFrame && previous.coordinateFrame === candidate.coordinateFrame && candidate.initialFigureFrame)
      candidate.initialFigureFrame.fitted.xr = true;
    if (anchor.cameraOffset) {
      try { globalThis.__stereofoldDiagnostics?.record?.('source-anchor', { anchor: 'rebased',
        reason: 'Preserving the room position requires a new numerical reference frame.' }); } catch { /* Advisory. */ }
    }
    return anchor;
  }

  function setXrCameraScale(anchor) {
    if (!anchor || !canvas.xr.isPresenting.value) return;
    const oldScale = canvas.camera.scale;
    if (!Number.isFinite(oldScale) || oldScale <= 0 || !Number.isFinite(anchor.cameraScale) || anchor.cameraScale <= 0) {
      throw failure('source_transition_scale', 'The XR transition has no finite scene scale.');
    }
    const factor = oldScale / anchor.cameraScale;
    const state = canvas.camera.getSnapshot();
    const offset = anchor.cameraOffset ?? [0, 0, 0];
    // Camera.scale participates in Mol*'s XR reference-space transform. Scale
    // position and target inversely before its next XR frame so the reference
    // frame and tracked head pose remain unchanged while source size changes.
    // A source-origin rebase shifts both camera endpoints with the molecule;
    // it changes neither the tracked eye matrices nor the viewing direction.
    canvas.camera.scale = anchor.cameraScale;
    canvas.camera.setState({ position: state.position.map((value, axis) => value * factor + offset[axis]),
      target: state.target.map((value, axis) => value * factor + offset[axis]) }, 0);
  }

  async function showCandidate(candidate, previous, settings, operation) {
    assertLoad(operation);
    const drawBegan = now();
    state.replacementPhase = 'candidate_draw';
    const retained = [previous?.representation, previous?.companionRecord?.representation,
      ...(previous?.styleLayers ?? []).map(layer => layer.representation)].filter(ref => ref?.obj);
    retainedRepresentationCount = retained.length;
    // Keep the old drawing attached until the candidate has produced its first
    // accepted frame. Camera fitting below uses candidate-only bounds, so the
    // outgoing structure cannot pull the new source's view out of frame.
    styleLayers = [];
    // A lesson/recovered scene has not installed its layers yet. Its base is
    // staged transparent, then receives its authoritative mask and appearance
    // after adoption, before the load's final accepted frame.
    if (settings.initialInspection) canvas.setProps({ renderer: {
      backgroundColor: Color(colorNumber(settings.initialInspection.appearance.background)) } });
    plugin.state.data.updateCellState(candidate.representation.ref, { isHidden: false });
    markRecord(candidate, candidate.selectionKeys);

    const candidateGeometrySphere = () => {
      const objects = candidate.representation?.obj?.data?.repr?.renderObjects ?? [];
      const spheres = objects.filter(object => object.state.visible && object.values.drawCount.ref.value)
        .map(object => object.values.boundingSphere?.ref.value)
        .filter(sphere => sphere && Number.isFinite(sphere.radius) && sphere.radius > 0);
      if (spheres.length) {
        const helper = new BoundaryHelper('98');
        helper.reset(); for (const sphere of spheres) helper.includeSphere(sphere);
        helper.finishedIncludeStep(); for (const sphere of spheres) helper.radiusSphere(sphere);
        return helper.getSphere();
      }
      return recordBoundingSphere(candidate);
    };
    canvas.commit(!canvas.xr.isPresenting.value);
    // In XR the camera IS the room frame, so a swap that
    // preserves the room anchor must not touch it.
    //
    // `onHeadFrame` (viewer.mjs:782) builds `roomFromRender` by decomposing
    // `canvas.camera.view`, so the camera's position and rotation are the
    // room<->render mapping every placement is solved in. `requestCameraReset`
    // re-fits the camera to the NEW structure's radius, which for a tier six
    // times larger backs it metres away from where the previous tier's frame
    // stood. `transitionRoomAnchor` expresses its placement in the OLD frame and
    // `setXrCameraScale` only compensates `camera.scale`, so the reset moved the
    // molecule bodily and pushed it far enough away to shrink: the wall ended
    // as a speck near the ceiling. Keeping the camera makes
    // `preserveSourceTransitionAnchor`'s arithmetic exact again.
    if (settings.preserveRoomPlacement) { /* The room anchor owns the frame. */ }
    else if (settings.camera) canvas.camera.setState(settings.camera, 0);
    else if (candidate.initialFigureFrame && !settings.initialInspection.preserveFigureFrame) {
      plugin.managers.camera.focusSphere(candidate.initialFigureFrame.target, { durationMs: 0, extraRadius: 0, minRadius: 0 });
    }
    else if (settings.visible) {
      // Fit the drawn subset, while keeping the full assembly available for
      // canonical sequence/selection identity. An explicit XR camera wins above.
      const catalogBounds = catalogVisibleBounds(candidate.source.catalog, settings.visible);
      const bounds = catalogBounds ?? candidateGeometrySphere();
      if (!bounds?.center || !Number.isFinite(bounds.radius) || bounds.radius <= 0)
        throw failure('source_transition_bounds', 'The selected source stage has no finite bounds for camera fitting.');
      if (catalogBounds?.extent) {
        // Present an elongated assembly from its side, instead of aiming
        // down its long axis and reducing a filament to a small end-on dot.
        const axes = [0, 1, 2].sort((a, b) => catalogBounds.extent[a] - catalogBounds.extent[b]);
        const direction = Vec3.create(.14, .14, .14), up = Vec3.create(0, 0, 0);
        direction[axes[0]] = 1; up[axes[2]] = 1;
        Vec3.normalize(direction, direction);
        const camera = canvas.camera.getInvariantFocus(bounds.center, bounds.radius + Math.max(4, bounds.radius * .08), up, direction);
        plugin.managers.camera.focusSnapshot(camera, { durationMs: 0 });
      } else plugin.managers.camera.focusSphere(bounds, { durationMs: 0, extraRadius: Math.max(4, bounds.radius * .12), minRadius: 1 });
    } else {
      const bounds = candidateGeometrySphere();
      if (!bounds?.center || !Number.isFinite(bounds.radius) || bounds.radius <= 0)
        throw failure('source_transition_bounds', 'The source has no finite bounds for camera fitting.');
      // Match Mol*'s ordinary scene reset, but focus only the incoming source.
      plugin.managers.camera.focusSphere(bounds, { durationMs: 0, extraRadius: 0, minRadius: 0 });
    }
    canvas.commit(!canvas.xr.isPresenting.value);
    await waitForFrame(candidate);
    assertLoad(operation);
    try { globalThis.__stereofoldDiagnostics?.record?.('first-pixel', { stage: 'headset-first-frame', at: Date.now() }); } catch { /* Timing must not interrupt drawing. */ }
    recordCost('source-load-cost', { phase: 'first-frame', elapsedMs: now() - drawBegan });
    operation.transition?.firstFrame();
    for (const ref of retained) canvas.remove(ref.obj.data.repr);
    retainedRepresentationCount = 0;
    canvas.commit(!canvas.xr.isPresenting.value);
    await waitForFrame(candidate);
    assertLoad(operation);
    operation.transition?.oldRemoved();
    await checkpoint(operation, 'after_candidate_draw');
  }

  async function restoreRecord(previous, { recovering = false } = {}) {
    if (previous.renderQualityCheckpoint) restoreRenderQualityCheckpoint(previous.renderQualityCheckpoint);
    assertContext({ recovering });
    let restored = previous;
    // Cleanup normally keeps the original representation intact. Rebuild only
    // if a context event interrupted deletion after the candidate's first draw.
    if (!previous.representation?.cell?.obj || previous.representation.cell.status !== 'ok'
        || !plugin.state.data.cells.has(previous.rootRef)) {
      await deleteRecord(previous);
      // A failure after cleanup has already deleted the outgoing subtree. Build
      // it again before adding its representation; a stale cell object alone is
      // not a live Mol* state-tree record.
      restored = await buildCandidate(previous.source, { ...previous.inspection, visible: previous.visible });
      restored.inspection = previous.inspection;
      restored.initialFigureFrame = previous.initialFigureFrame;
      restored.styles = previous.styles; restored.visibility = previous.visibility;
      restored.lastPick = previous.lastPick; restored.lessonSelection = previous.lessonSelection;
    }
    assertContext({ recovering });
    // A density tier's isosurface is rebuilt by
    // `buildVolumeCandidate` at the lesson's own contour and uniform colour, so
    // there is nothing to reconcile against a saved appearance — and
    // `createStructureRepresentationParams` below would be handed no structure.
    const params = restored.volume ? undefined : restored.representation.cell.params.values;
    if (params && (params.type.name !== previous.inspection.representation || params.colorTheme.name !== previous.inspection.color)) {
      await restored.representation.update(createStructureRepresentationParams(plugin, restored.structure.obj.data,
        { type: previous.inspection.representation, color: previous.inspection.color,
          colorParams: xrColorParams({ color: previous.inspection.color }) })).commit({ revertOnError: true });
      assertContext({ recovering });
    }
    restored.selectionKeys = [...previous.inspection.selectionKeys];
    adopt(restored);
    if (previous.lesson) restoreRetainedLessonState(previous.lesson);
    if (typeof measurementLines !== 'undefined') await measurementLines.install(previous.measurements);
    if(previous.companionRecord) await restoreCompanion(previous.companionRecord.companionState, { deferReveal: false });
    if(companionRecord?.representation?.obj) canvas.add(companionRecord.representation.obj.data.repr);
    for (const layer of styleLayers) if (layer.representation?.obj) canvas.add(layer.representation.obj.data.repr);
    plugin.state.data.updateCellState(restored.representation.ref, { isHidden: false });
    canvas.add(restored.representation.obj.data.repr);
    markSelection(restored.selectionKeys);
    if (previous.desktopPreview) restoreRetainedDesktopPreview(previous.desktopPreview);
    canvas.camera.setState(cameraSnapshot(previous.inspection.camera), 0);
    // Canvas3D queues removals independently of Mol* state-cell deletion.
    // Finish restoring external geometry and drain retired candidate objects
    // before the figure snapshots its surroundings across asynchronous builds.
    canvas.commit(true);
    if (previous.lesson) {
      // Source adoption retired the old figure cells. Rebuild against the
      // restored Mol* structure only once GPU recovery permits drawing.
      if (JSON.stringify(lessonFigure.definition()) !== JSON.stringify(previous.lesson.figure))
        await lessonFigure.install(previous.lesson.figure);
      applyInspectionTransform();
      canvas.commit(true);
    }
    await waitForFrame(restored, { recovering });
    assertContext({ recovering });
    return restored;
  }

  async function rollbackLoad(operation, error) {
    state.replacementPhase = 'rollback';
    retainedRepresentationCount = 0;
    const previous = operation.previous;
    // A failed XR source transition must restore the prior unit conversion
    // before drawing the retained record; otherwise its camera frame would be
    // scaled for a source that never became active.
    if (Number.isFinite(operation.cameraScale) && operation.cameraScale > 0) canvas.camera.scale = operation.cameraScale;
    const lost = state.contextLossCount !== operation.contextLossCount || canvas.webgl.isContextLost;
    const record = { code: error.code ?? 'load_failed', message: error.message ?? String(error),
      phase: operation.failedPhase, generation: operation.generation, recovered: false,
      candidateRemoved: false, recoveryPending: false };
    state.lastLoadFailure = record;
    if (state.status === 'disposed') return;
    await deleteRecord(operation.candidate);
    operation.candidate = undefined;
    record.candidateRemoved = true;
    adopt(previous);
    // Adoption retires the outgoing source's Reset target. A failed replacement
    // restores that target, which may differ from the wearer's current placement.
    // Do not carry it into a different XR session entered during the load.
    const entryCheckpoint = operation.roomSeatCheckpoint;
    if (entryCheckpoint && typeof roomEntry !== 'undefined' && roomEntry === entryCheckpoint.entry) {
      if (entryCheckpoint.seat) roomEntry.seat = structuredClone(entryCheckpoint.seat);
      else delete roomEntry.seat;
      entryRoomPoint = entryCheckpoint.point ? [...entryCheckpoint.point] : null;
      placementNote = entryCheckpoint.note;
      pendingRoomSeat = entryCheckpoint.pending;
      latestSeatStandoffMeters = entryCheckpoint.standoff;
      latestPlateSeat = entryCheckpoint.plateSeat;
    }
    // Inspection state is CPU-owned. Restore it even when the GPU is lost:
    // recovery redraws the retained source using this appearance, placement,
    // payload and history, rather than the candidate's reset defaults.
    if (previous && inspectionState && operation.inspectionCheckpoint) inspectionState.restoreCheckpoint(operation.inspectionCheckpoint);
    if (previous?.lesson) restoreRetainedLessonState(previous.lesson);
    if (lost) {
      recoveryRecord = previous;
      record.recoveryPending = true;
      state.status = 'context_lost';
      state.error = 'The molecular WebGL context was lost; the retained scene needs a recovery draw.';
      return;
    }
    state.status = 'loading';
    if (previous) {
      // Rebuilding either retained structure must use the outgoing scene budget.
      await restoreRecord(previous);
      if (inspectionState && operation.inspectionCheckpoint) {
        stylesState = normalizeStyles(previous.styles); visibilityState = normalizeVisibility(previous.visibility);
        await applyInspectionAppearance();
        canvas.commit(true);
        // Appearance may retire the restored base selector. Keep the source
        // identity, but prove the replacement that the viewer now owns.
        await waitForFrame({ ...previous, representation });
      }
      record.rollbackDrawCount = state.drawCount;
    } else {
      canvas.commit(true);
    }
    record.recovered = true;
    state.status = previous ? 'ready' : 'empty';
    state.error = null;
    removeFrameCover();
  }

  async function load(fixture, options = {}) {
    const loadBegan = now();
    let loadCommittedAt, loadFrameAt;
    assertContext();
    if (busy || appearanceWork) throw failure('viewer_busy', 'A molecular change is still rendering.');
    const priorGeneration = state.generation, priorRevision = state.revision;
    const { source, settings } = await checkedFixture(fixture, {
      modelNumber: 1, assemblyId: '1', representation: 'cartoon', selectionKeys: [], ...options,
    });
    if (settings.initialInspection && !source.map) {
      settings.initialInspection.appearance = normalizeAppearance(settings.initialInspection.appearance ?? {},
        normalizeAppearance({ representation: settings.representation }));
      if (settings.initialInspection.visibility !== undefined)
        settings.initialInspection.visibility = normalizeVisibility(settings.initialInspection.visibility);
    } else delete settings.initialInspection;
    assertContext();
    if (state.generation !== priorGeneration || state.revision !== priorRevision) {
      throw failure('viewer_changed', 'The molecular scene changed while the fixture was being checked.');
    }
    if (busy || appearanceWork) throw failure('viewer_busy', 'A molecular change is still rendering.');
    if (interactionActive()) throw failure('interaction_active', 'Release the molecular drag before replacing its scene.');
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    const previous = retainCurrent();
    // Adoption clears the temporary preview camera; retain its ownership only
    // for source rollback (including rollback completed after context recovery).
    if (previous && typeof desktopPreviewCamera !== 'undefined' && desktopPreviewCamera) previous.desktopPreview = {
      camera: detached(desktopPreviewCamera), limit: detached(desktopPreviewMaxDistance),
      maxDistance: canvas.props?.trackball?.maxDistance,
      session: currentXrSession(), entry: typeof roomEntry === 'undefined' ? undefined : roomEntry,
    };
    const work = beginWork(previous);
    const operation = { previous, inspectionCheckpoint: inspectionState?.checkpoint(), cameraScale: canvas.camera.scale, generation: ++state.generation, contextLossCount: state.contextLossCount,
      anchorAtStart: typeof roomAnchor !== 'undefined' ? roomAnchor : undefined, sessionAtStart: currentXrSession(),
      roomSeatCheckpoint: typeof roomEntry !== 'undefined' && roomEntry ? {
        entry: roomEntry, seat: roomEntry.seat ? structuredClone(roomEntry.seat) : undefined,
        point: entryRoomPoint ? [...entryRoomPoint] : null, note: placementNote,
        pending: pendingRoomSeat, standoff: latestSeatStandoffMeters, plateSeat: latestPlateSeat,
      } : undefined,
      done: work.done, failAt: nextTest.failAt, pauseAt: nextTest.pauseAt, cancelled: null, candidate: undefined };
    operation.transition = beginSceneTransition({ session: currentXrSession(), operation: 'source' });
    nextTest.failAt = nextTest.pauseAt = null;
    activeLoad = operation;
    busy = true;
    if (inspectionState) { motionMutationPaused = true; syncPresentationMotion(); }
    state.status = 'loading';
    state.replacementPhase = 'staging';
    try {
      coverCurrentFrame();
      // Labels are children of the outgoing root. Remove them before staging
      // so candidate frames never combine two source structures.
      if (inspectionState) { await removeInspectionLabels(); await removeLigandOverlay(); await removeComponentLabels(); }
      const candidate = await buildCandidate(source, settings, operation);
      const sourceAnchor = transitionRoomAnchor(previous, candidate, settings);
      let committedRoomSeat;
      companionRecord = undefined;
      await showCandidate(candidate, previous, settings, operation);
      assertLoad(operation);
      // Retain the outgoing state-tree subtree until the new inspection state,
      // including an XR room anchor, has rendered. A failure in that narrow
      // window can then restore the existing record without rebuilding a
      // deleted Mol* selector.
      if (typeof desktopPreviewMaxDistance !== 'undefined') releaseDesktopPreviewLimit();
      desktopPreviewCamera = undefined;
      adopt(candidate);
      // Adoption queues the outgoing animation's removal. A same-source
      // reload retains its figure, whose rebuild snapshots external geometry;
      // finish that removal and its canvas commit before taking the snapshot.
      await molecularAnimation.settled();
      assertLoad(operation);
      if (inspectionState) {
        inspectionLabel = undefined; // Its old component was part of the replaced subtree.
        ligandOverlay = undefined;   // And so was the ligand overlay's.
        inspectionState.reset(settings.initialInspection?.appearance ?? { representation: settings.representation });
        if (sourceAnchor) {
          setXrCameraScale(sourceAnchor);
          if (settings.seatForEntry && !sourceAnchor.preservesCoordinateFrame) {
            // A new structure starts from the entry orientation, as a fresh
            // load does, and then takes the entry seat.
            inspectionState.place({ ...sourceAnchor.placement, rotation: inspectionSnapshot().placement.rotation }, 'source-transition');
            committedRoomSeat = seatSwappedSource(sourceAnchor, { deferAnchor: true });
          } else {
            inspectionState.place(sourceAnchor.placement, 'source-transition');
            // The anchor carries the previous tier's orientation
            // across unchanged (`source-transition-anchor.mjs:67`), which is how
            // a tier whose coordinate file runs along a different axis arrived
            // looking like a camera cut. The next framing owes a turn.
            pendingGrowthTurn = !sourceAnchor.preservesCoordinateFrame;
          }
          if (operation) await checkpoint(operation, 'after_room_anchor');
        }
        await applyInspectionAppearance({ depth: !settings.camera });
        loadCommittedAt = now();
        canvas.commit(!canvas.xr.isPresenting.value);
        await waitForFrame();
        loadFrameAt = now();
        orientationReference = cameraSnapshot(canvas.camera.getSnapshot());
      }
      state.replacementPhase = 'cleanup';
      await deleteRecord(previous);
      assertLoad(operation);
      operation.candidate = undefined;
      state.revision += 1;
      state.loadCount += 1;
      state.mutationCounts.load += 1;
      if (!sourceAnchor?.preservesCoordinateFrame) releaseWearerPlacement('source-load');
      recordRenderCost('load', loadBegan, loadCommittedAt, ['source', 'appearance', 'selection', 'labels'], 'rendered', loadFrameAt);
      operation.transition.finish();
      state.status = 'ready';
      state.error = null;
      if (inspectionState) { motionToolPaused = false; motionAngle = 0; }
      state.replacementPhase = 'idle';
      busy = false;
      removeFrameCover();
      const result = snapshot();
      emit(onMutation, result);
      // applied() releases the previous native anchor and spends automatic
      // settling. Publish only after the replacement has drawn and committed;
      // a failed load must leave the retained source's anchor intact.
      if (committedRoomSeat && operation.anchorAtStart && operation.anchorAtStart === roomAnchor
        && operation.roomSeatCheckpoint?.entry === roomEntry && operation.sessionAtStart === currentXrSession()) {
        void roomAnchor.applied({ roomPoint: committedRoomSeat.roomPoint })?.catch?.(() => {});
      }
      return result;
    } catch (error) {
      operation.transition.finish('failed', error);
      recordRenderCost('load', loadBegan, undefined, ['source'], 'failed');
      operation.failedPhase = state.replacementPhase;
      try { await rollbackLoad(operation, error); }
      catch (rollbackError) {
        if (state.status !== 'disposed') {
          state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
          state.error = `Replacement failed: ${error.message}; restoration failed: ${rollbackError.message}`;
          state.lastLoadFailure = { ...state.lastLoadFailure, recovered: false, rollbackError: rollbackError.message };
        }
        throw failure('rollback_failed', `Replacement failed: ${error.message}; restoration failed: ${rollbackError.message}`);
      }
      throw error;
    } finally {
      busy = false;
      if (activeLoad === operation) activeLoad = undefined;
      state.testPausedAt = null;
      if (!['context_lost', 'recovering', 'error', 'disposed'].includes(state.status)) state.replacementPhase = 'idle';
      work.finish();
      if (inspectionState) { motionMutationPaused = false; syncPresentationMotion(); }
    }
  }

  async function cancelLoad() {
    assertContext();
    const operation = activeLoad;
    if (!operation) return { cancelled: false, snapshot: snapshot() };
    operation.cancelled = failure('load_cancelled', 'The scene replacement was cancelled.');
    operation.releasePause?.();
    for (const settle of [...frameWaiters]) settle(operation.cancelled);
    await operation.done;
    assertContext();
    return { cancelled: true, snapshot: snapshot() };
  }

  async function setRepresentation(value) {
    assertReady();
    const liveRepresentation = findCurrentStructureRepresentation();
    if (liveRepresentation) representation = asViewerRepresentation(liveRepresentation);
    const name = inspectionState ? inspectionRepresentationName(value) : representationName(value);
    // A density tier draws one isosurface and nothing else, so
    // there is no structure representation to switch to and no structure to
    // test a provider against. Asking the structure registry about a map would
    // throw before the refusal below could be read.
    if (volume) throw failure('unsupported_representation', 'This scene is a density map; its isosurface is the only representation it has.');
    const provider = plugin.representation.structure.registry.get(name);
    if (!provider.isApplicable(structure.obj.data)) {
      throw failure('unsupported_representation', 'This representation has no supported geometry for the loaded structure.');
    }
    if (inspectionState) return configureInspection({ representation: name });
    return mutate('representation', async () => {
      const camera = canvas.camera.getSnapshot();
      const params = createStructureRepresentationParams(plugin, structure.obj.data, { type: name, color: 'chain-id',
        colorParams: xrColorParams({ color: 'chain-id' }) });
      await representation.update(params).commit({ revertOnError: true });
      assertContext();
      markSelection(state.selectionKeys);
      await paintSelectionOverlay();
      canvas.camera.setState(camera, 0);
    });
  }

  // Reuse only layers observed after a successful selection frame. Canonical
  // membership is still validated on every request, including no-ops.
  let settledSelectionLayers;
  // The `selectionSignature` of a selection the lesson made, while it stands.
  // Applied lesson-key colours replace the mark on the rows they cover.
  let lessonSelection;
  function inspectionLayersIntact() {
    const cell = plugin.state.data.cells.get(representation?.ref);
    if (!cell?.obj || cell.status !== 'ok' || cell.state?.isHidden) return false;
    const appearance = inspectionSnapshot().appearance;
    const params = cell.params?.values;
    if (!volume && (params?.type?.name !== builtRepresentation
      || params?.colorTheme?.name !== appearance.color
      || params?.type?.params?.alpha !== appearance.opacity)) return false;
    if (!volume && appearance.color === 'uniform'
      && params?.colorTheme?.params?.value !== colorNumber(appearance.uniformColor)) return false;
    if (styleLayers.some(layer => !plugin.state.data.cells.get(layer.representation?.ref)?.obj)) return false;
    const selected = new Set(state.selectionKeys);
    const labelsExpected = appearance.labels && (selection?.rows ?? []).some(row =>
      selected.has(row.key) && row.coordinateState === 'resolved' && row.atomSites.length);
    const labelCell = plugin.state.data.cells.get(inspectionLabel?.representation?.ref);
    if (labelsExpected && (!labelCell?.obj || labelCell.status !== 'ok' || labelCell.state?.isHidden)) return false;
    if (!labelsExpected && labelCell?.obj) return false;
    for (const label of inspectionLabel?.extraRepresentations ?? []) {
      const cell = plugin.state.data.cells.get(label.ref);
      if (!cell?.obj || cell.status !== 'ok' || cell.state?.isHidden) return false;
    }
    const plan = currentEmphasisPlan();
    if (componentLabelsWanted() && componentLabelPlateParts(plan).length) {
      const refs = componentLabels.refs();
      if (!refs.length || !componentLabels.active()) return false;
      for (const ref of refs) {
        if (!plugin.state.data.cells.get(ref)?.obj) return false;
        const text = ['', '-0', '-1'].map(suffix => plugin.state.data.cells.get(`${ref}${suffix}-backing`));
        if (!text.some(cell => cell?.obj && cell.status === 'ok' && !cell.state?.isHidden)) return false;
      }
    }
    if (plan?.colours.some(part => part.keys.length)
      && !plugin.state.data.cells.get(`${representationLayerRef(representation, EMPHASIS_LAYER_REF)}-colour`)?.obj) return false;
    if ((plan?.faded.length || hiddenSceneKeys().length || stylesState.length)
      && !plugin.state.data.cells.get(representationLayerRef(representation, SCENE_VISIBILITY_LAYER_REF))?.obj) return false;
    // A selection the wearer cannot see is a layer that needs
    // rebuilding, exactly as a missing lesson key is. Before this the scene
    // read as intact while the molecule carried no mark at all.
    if (currentSelectionPlan()?.keys.length
      && !plugin.state.data.cells.get(`${representationLayerRef(representation, EMPHASIS_LAYER_REF)}-colour`)?.obj) return false;
    return true;
  }
  function selectionLayerStamp() {
    const refs = [representation?.ref, inspectionLabel?.representation?.ref,
      ...(inspectionLabel?.extraRepresentations ?? []).map(label => label.ref),
      ...styleLayers.map(layer => layer.representation?.ref),
      representationLayerRef(representation, EMPHASIS_LAYER_REF), `${representationLayerRef(representation, EMPHASIS_LAYER_REF)}-colour`, `${EMPHASIS_LAYER_REF}-ligand`, `${EMPHASIS_LAYER_REF}-ligand-colour`,
      representationLayerRef(representation, SCENE_VISIBILITY_LAYER_REF), `${SCENE_VISIBILITY_LAYER_REF}-ligand`,
      ...componentLabels.refs().flatMap(ref => [ref, `${ref}-leader`,
        ...['', '-0', '-1'].flatMap(suffix => [`${ref}${suffix}-text`, `${ref}${suffix}-backing`, `${ref}${suffix}-key`])])].filter(Boolean);
    return [state.generation, structure?.obj, volume?.obj,
      JSON.stringify([state.selectionKeys, inspectionState?.snapshot().appearance,
        inspectionState?.snapshot().placement, emphasisState, stylesState, visibilityState, lessonResting.labelsEnabled()]),
      ...refs.flatMap(ref => { const cell = plugin.state.data.cells.get(ref);
        return [ref, cell?.obj, cell?.transform, cell?.state?.isHidden]; }),
      ...canvas.getRenderObjects().flatMap(object => [object, object.values.tMarker?.ref.version,
        object.values.markerStatus?.ref.version])];
  }
  function selectionLayersUnchanged(keys) {
    if (keys.length !== state.selectionKeys.length || keys.some((key, i) => key !== state.selectionKeys[i])) return false;
    if (!inspectionState || !settledSelectionLayers) return false;
    const stamp = selectionLayerStamp();
    return stamp.length === settledSelectionLayers.length && stamp.every((value, i) => value === settledSelectionLayers[i]);
  }
  async function select(keys, action = 'selection', { lesson = false } = {}) {
    assertReady();
    const chosen = selectedKeys(keys);
    const owner = lesson ? selectionSignature(chosen) : undefined;
    const unchanged = owner === lessonSelection && selectionLayersUnchanged(chosen);
    const operation = async () => {
      if (unchanged) return;
      if (inspectionState) { syncInspectionPayload(); inspectionState.recordPayload(null, action); }
      lessonSelection = owner;
      markSelection(chosen);
      await paintSelectionOverlay();
      if (inspectionState) await rebuildInspectionLabels();
      await rebuildComponentLabels();
      inspectionState?.setPayload(inspectionPayload());
    };
    const result = inspectionState
      ? await inspectionMutation(operation, { operationKind: action, changedLayers: unchanged ? [] : ['selection', 'labels'] })
      : await mutate(action, operation, { operationKind: action, changedLayers: unchanged ? [] : ['selection', 'labels'] });
    if (!unchanged) settledSelectionLayers = inspectionState && inspectionLayersIntact() ? selectionLayerStamp() : undefined;
    return result;
  }

  async function focus(keys) {
    assertReady();
    const chosen = selectedKeys(keys);
    const loci = selection.toLoci(modelledFocusKeys(chosen));
    const focusMutation = () => mutate('focus', () => {
      // Stock focus uses the selected atoms' bounding sphere. It preserves
      // orientation and adds its documented 4 Å padding with a 1 Å minimum.
      plugin.managers.camera.focusLoci(loci, { durationMs: 0, optimizeDirection: false });
      if (inspectionState) {
        const camera = canvas.camera.getSnapshot();
        const transform = placementTransform(inspectionState.snapshot().placement);
        const point = Vec3.transformMat4(Vec3(), camera.position, transform);
        const target = Vec3.transformMat4(Vec3(), camera.target, transform);
        const up = Vec3.transformDirection(Vec3(), camera.up, transform);
        canvas.camera.setState({ position: Array.from(point), target: Array.from(target), up: Array.from(up),
          radius: camera.radius * inspectionState.snapshot().placement.scale }, 0);
      }
    });
    if (!inspectionState) return focusMutation();
    await inspectionMutation(() => {
      syncInspectionPayload(); inspectionState.recordPayload(null, 'focus');
      const placement = inspectionSnapshot().placement;
      const sphere = molecularAnimation.selectionSphere(loci);
      const transformed = { center: Vec3.transformMat4(Vec3(), sphere.center, presentationTransform()),
        radius: sphere.radius * placement.scale };
      // Focus the transformed sphere directly. `focusLoci` schedules an
      // untransformed reset, which would overwrite a transformed target.
      plugin.managers.camera.focusSphere(transformed, { durationMs: 0,
        extraRadius: 4 * placement.scale, minRadius: placement.scale });
    });
    // The camera manager applies the focus snapshot on the admitted draw.
    inspectionState.setPayload(inspectionPayload());
    return snapshot();
  }

  /**
   * Bring a region into view without moving the wearer.
   *
   * A headset has no camera to set, and the head pose is not this code's to
   * write. So the structure travels instead: `focus-placement.mjs` solves for
   * the placement that puts the target sphere in front of the wearer at the
   * asked-for angle, the travel runs as the same transient a held grip
   * produces, and `bakeGrab` commits the last frame as one placement. A panel
   * with no wearer falls through to the stock camera focus above.
   */
  /**
   * "show me chain B" and "focus on residues 840 to 860" as keys.
   *
   * The letters and numbers a wearer speaks are author identifiers, which are
   * what a paper and a Mol* label both use, so the author chain and the author
   * residue number are matched first. A target this structure does not contain
   * is a named failure, not a silent nothing: the wearer hears which one.
   */
  // Lesson paint, labels and framing repeatedly resolve the same named parts.
  // Selection rows belong to one immutable source/model/assembly binding.
  let spokenSelectionCache;
  function spokenSelectionKeys({ chain, residues } = {}) {
    if (!chain && !residues) return undefined;
    const sourceRows = selection?.rows;
    if (spokenSelectionCache?.rows !== sourceRows)
      spokenSelectionCache = { rows: sourceRows, targets: new Map() };
    const cacheKey = JSON.stringify([chain, residues]);
    const cached = spokenSelectionCache?.targets.get(cacheKey);
    if (cached) return cached.slice();
    const [first, last] = residues ?? [];
    const rows = (sourceRows ?? []).filter(row => {
      const id = row.identity;
      if (chain && id.authorChain !== chain && id.labelChain !== chain) return false;
      return !residues || (Number.isInteger(id.authorResidue) && id.authorResidue >= first && id.authorResidue <= last);
    });
    if (rows.length) {
      const keys = rows.map(row => row.key);
      if (spokenSelectionCache.targets.size >= 128) spokenSelectionCache.targets.clear();
      spokenSelectionCache.targets.set(cacheKey, keys);
      return keys.slice();
    }
    throw Error(residues
      ? `Nothing at residues ${first} to ${last}${chain ? ` on chain ${chain}` : ''} here.`
      : `There is no chain ${chain} in this structure.`);
  }

  /** Which spoken noun a selection row belongs to. Polymer is neither. */
  function visibilityGroupOf(row) {
    if (row.entityType === 'water') return 'water';
    return row.entityType === 'non-polymer' || row.entityType === 'branched' ? 'ligand' : undefined;
  }

  /** Spoken group edits use the same saved visibility as scene commands. */
  async function setGroupVisible(group, visible) {
    assertReady();
    if (!['water', 'ligand'].includes(group)) throw Error('Only the water and the ligands can be hidden.');
    const [noun, verb] = group === 'water' ? ['water', 'is'] : ['ligands', 'are'];
    const hidden = visibilityState.hiddenClasses.includes(group);
    if (visible && !hidden) throw Error(`The ${noun} ${verb} already showing.`);
    if (!visible && hidden) throw Error(`The ${noun} ${verb} already hidden.`);
    if (!visible && !(selection?.rows ?? []).some(row => visibilityGroupOf(row) === group)) throw Error(`This structure has no ${noun}.`);
    return setSceneVisibility(resolveVisibility(visibilityState, { op: visible ? 'show' : 'hide', classes: [group] }, visibilityChains()));
  }

  /**
   * The chain identities this loaded structure actually has.
   *
   * The pair, not the letter. An assembly holds the same label chain several
   * times and only the copy id tells them apart, which is why the command
   * carries both and why a request naming one this structure does not have is
   * refused here with the list rather than quietly hiding nothing.
   */
  function visibilityChains() {
    return availableChains(selection?.rows ?? []);
  }

  /**
   * "hide chain B", as one admitted, saved, undoable change.
   *
   * The argument is the WHOLE hidden set after the edit, not the edit: the host
   * folds hide/show/only/reset against the chains the model has and sends the
   * result, exactly as it expands a lesson part name into the whole colour key
   * for `emphasize`. So this panel needs no memory of what was hidden a moment
   * ago, a named view restores by replay, and an undo is one more of these
   * carrying the earlier set.
   *
   * One render covers all four consequences: the atoms go, the selection
   * highlight over them goes, their residue labels go, and a name plate whose
   * part is entirely hidden goes. The saved state is rolled back if the paint
   * fails, so a refused hide leaves the panel describing the picture on screen.
   */
  async function setSceneVisibility(next) {
    assertReady();
    if (volume) throw Error('This scene is a density map, which is one isosurface with no chains or components in it. Nothing in it can be hidden separately.');
    if (!selection) throw Error('This panel has no residue catalog, so it cannot hide part of the structure.');
    const wanted = normalizeVisibility(next);
    const chains = visibilityChains();
    // `resolveVisibility` owns the refusal wording, and running the set back
    // through it as a `hide` is how this panel gets the same sentence the host
    // would have given rather than a second one written here.
    if (wanted.hiddenChains.length) resolveVisibility(emptyVisibility(), { op: 'hide', chains: wanted.hiddenChains }, chains);
    if (sameVisibility(wanted, visibilityState)) return snapshot();
    const previous = visibilityState;
    try {
      await inspectionMutation(async () => {
        syncInspectionPayload(); inspectionState.recordPayload(null, 'visibility');
        visibilityState = wanted;
        markSelection(state.selectionKeys);
        // Visibility changes the selection's overpaint only when a selection
        // exists. An unselected reveal keeps its colour key and updates the
        // composed transparency mask without clearing and repainting colours.
        if (state.selectionKeys.length) await paintSelectionOverlay();
        else await paintVisibilityLayers();
        await rebuildInspectionLabels();
      });
    } catch (error) { visibilityState = previous; throw error; }
    await rebuildComponentLabels(undefined, undefined, { force: true });
    return snapshot();
  }

  /** What the wearer would be told is hidden, in the words both ends use. */
  function describeSceneVisibility() {
    return describeVisibility(visibilityState, visibilityChains());
  }

  /**
   * Make a lesson chapter point at a real part of the molecule.
   *
   * Before this, an immersive chapter could only restate a whole-structure
   * representation, colour and opacity, so "here is the guide RNA" was a global
   * recolour and the wearer was left to find the guide RNA themselves. Two
   * things fix that, and both are layers over the existing representation
   * rather than a rebuild, because a rebuild costs seconds on a Quest 2 while a
   * layer lands in the next frame:
   *
   * - `parts` is the lesson's colour key, overpainted per part. A lesson passes
   *   the same key in every chapter, so the wearer learns one mapping (grey
   *   protein, orange guide RNA, and so on) instead of a new palette per scene.
   * - `focus` names the one part that stays opaque. Every other part, and any
   *   row the key does not name, drops to `contextOpacity` — faint, but still
   *   there, so the emphasised part keeps its position in the whole complex.
   *   Omit `focus` and the whole key shows at full strength, which is what a
   *   recap chapter wants.
   *
   * Later layers win, so a key may list a sub-range after the chain that
   * contains it (the PAM inside the non-target strand) and the sub-range keeps
   * its own colour. Both layers hang off one state ref each and are reversed by
   * deleting them, so an empty call restores the plain structure exactly.
   */
  /**
   * What a chapter's scene actually cost, on the headset log.
   *
   * A lesson that misses its twenty-second bound says which operation stalled
   * and nothing about why. These two records are the why: milliseconds per
   * phase, and the layer and row counts that produced them. There is no console
   * in a headset, so a number that is not recorded is a number nobody will ever
   * have. Counts and durations only — no wearer data, no coordinates.
   */
  const now = () => { try { return performance.now(); } catch { return Date.now(); } };
  function recordCost(kind, detail) {
    let record;
    try { record = globalThis.__stereofoldDiagnostics?.record; } catch { return; }
    if (typeof record !== 'function') return;
    try { record(kind, detail); } catch { /* A diagnostics failure never costs a chapter. */ }
  }

  function recordRenderCost(kind, began, committedAt, changedLayers, outcome = 'rendered', frameAt = now()) {
    try {
      if (typeof globalThis.__stereofoldDiagnostics?.record !== 'function') return;
      recordCost('render-operation-cost', { operation: kind, outcome, totalMs: Math.round(now() - began),
        commitToFrameMs: committedAt === undefined ? null : Math.round(frameAt - committedAt),
        atomSites: structureAtomSites(plugin), selectionSize: state.selectionKeys.length,
        representationCount: canvas.reprCount.value,
        labelCount: componentLabelRepresentations().length + (inspectionLabel ? 1 : 0),
        changedLayers: changedLayers.slice(0, 8) });
    } catch { /* Diagnostics never affect rendering or receipts. */ }
  }

  /**
   * The two layers themselves, without the queue.
   *
   * This is called from inside two different admitted
   * operations — `emphasize` below, which owns the queue itself, and an
   * appearance rebuild, which is already inside one — so it must not take the
   * mutation queue of its own or the second caller would wait on itself.
   */
  async function paintEmphasisLayers(plan, { transparency = true, recovering = false } = {}) {
    const began = now();
    // One update per COLOUR, not one per authored part.
    //
    // `mergeEmphasisColourLayers` collapses the key into disjoint sets, one per
    // colour, which draws the identical picture. The wall tier's fourteen named
    // chains are two colours, so this is two layers instead of fourteen — and a
    // layer is a bundle-to-loci conversion plus a pass over the overpaint
    // buffer of a 40,908-atom representation, per layer, on a Quest 2.
    const colourLayers = mergeEmphasisColourLayers(plan.colours);
    // The colour rule applies to whatever is drawn, so it is
    // painted onto every representation of the molecule rather than onto the
    // structure's own. A bundle carries unit-local element indices, and the
    // overlay's units hold a SUBSET of the structure's elements, so each loci
    // is remapped onto the target's own structure before the bundle is taken —
    // otherwise index 4 of the ligand component is a different atom from index
    // 4 of the structure and the overlay would come up painted at random.
    //
    // And only onto representations the state tree still has.
    // A state builder addressed to a deleted ref THROWS, which used to end the
    // wall lesson one chapter from the end: an
    // appearance that tears the ligand overlay down and then repaints the
    // chapter's key asked the builder for the overlay it had just removed. A
    // representation that is gone loses its colour; before this it cost the
    // wearer the chapter.
    dropDeadOverlayRefs();
    const { targets, missing } = liveEmphasisTargets(
      [{ repr: representation, suffix: '', data: structure?.obj?.data },
        ...(ligandOverlay?.representation
          ? [{ repr: ligandOverlay.representation, suffix: '-ligand', data: ligandOverlay.component?.obj?.data }] : []),
        ...styleLayerTargets()],
      ref => Boolean(plugin.state.data.cells.get(ref)));
    if (missing.length) recordCost('emphasis-target-missing', { missing });
    const bundleFor = (keys, data) => {
      const loci = selection.toLoci(keys);
      const mapped = data ? StructureElement.Loci.remap(loci, data) : loci;
      return StructureElement.Loci.isEmpty(mapped) ? undefined : StructureElement.Bundle.fromLoci(mapped);
    };
    // Keep live colour decorators through chapter changes. Mol* compares their
    // complete overpaint on update, so an unchanged key does not clear and
    // repaint every cartoon mesh. Transparency still follows its own path.
    const primaryEmphasisRef = representationLayerRef(representation, EMPHASIS_LAYER_REF);
    const colourRefs = new Set(targets.filter(({ repr }) => repr?.ref).map(({ suffix }) =>
      `${representationLayerRef(representation, EMPHASIS_LAYER_REF, suffix)}-colour`));
    for (const ref of [primaryEmphasisRef, `${primaryEmphasisRef}-colour`,
      `${EMPHASIS_LAYER_REF}-ligand`, `${EMPHASIS_LAYER_REF}-ligand-colour`,
      ...styleLayerTargets().flatMap(({suffix}) => [`${EMPHASIS_LAYER_REF}${suffix}`, `${EMPHASIS_LAYER_REF}${suffix}-colour`])]) {
      if (colourRefs.has(ref)) continue;
      if (plugin.state.data.cells.get(ref)) await plugin.build().delete(ref).commit();
    }
    const cleared = now();
    // The wearer's own selection is the last layer of this same
    // overpaint, so it wins on a residue the key also names and is repainted by
    // every rebuild that repaints the key.
    const selectionPlan = currentSelectionPlan();
    for (const { repr, suffix, data } of targets) {
      if (!repr?.ref) continue;
      const layers = composeOverpaintLayers(
        colourLayers.map(part => ({ bundle: bundleFor(part.keys, data),
          color: Color(Number.parseInt(part.color.slice(1), 16)), clear: false }))
          .filter(layer => layer.bundle),
        selectionOverpaintLayer({ plan: selectionPlan, bundleFor, data,
          color: value => Color(Number.parseInt(String(value).slice(1), 16)) }));
      const ref = `${representationLayerRef(representation, EMPHASIS_LAYER_REF, suffix)}-colour`;
      const cell = plugin.state.data.cells.get(ref), live = repr.obj?.data?.repr;
      const decorator = cell?.obj?.data;
      // A retained cell alone proves nothing after a workbench edit, geometry
      // rebuild or context recovery. Recreate unless it still owns this exact
      // representation's paint at this geometry version and source.
      const reusable = cell?.status === 'ok'
        && cell.transform?.transformer === StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle
        && live && decorator?.repr === live
        && decorator.info?.structure === repr.obj.data.sourceData
        && decorator.info?.geometryVersion === live.geometryVersion
        && decorator.state?.overpaint === live.state.overpaint;
      if (cell && (!layers.length || !reusable)) await plugin.build().delete(ref).commit();
      if (layers.length && reusable) {
        await plugin.build().to(ref).update({ layers }).commit();
      } else if (layers.length) {
        await plugin.build().to(repr.ref)
          .apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle,
            { layers }, { ref }).commit();
      }
    }
    const painted = now();
    for (const { repr, suffix, data } of targets) {
      if (!transparency || !repr?.ref || !plan.faded.length) continue;
      const bundle = bundleFor(plan.faded, data);
      if (bundle) {
        await plugin.build().to(repr.ref)
          .apply(StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle,
            { layers: [{ bundle, value: plan.transparency }] }, { ref: representationLayerRef(representation, EMPHASIS_LAYER_REF, suffix) }).commit();
      }
    }
    recordCost('emphasis-cost', { parts: plan.colours.length, layers: colourLayers.length,
      lit: plan.lit.length, faded: plan.faded.length,
      clearMs: Math.round(cleared - began), colourMs: Math.round(painted - cleared),
      fadeMs: Math.round(now() - painted), totalMs: Math.round(now() - began) });
    assertContext({ recovering });
  }

  /**
   * The selection, drawn on the molecule.
   *
   * An eleven-residue selection changed the plate count and left the 1CRN
   * cartoon uniformly orange. `markSelection`
   * below still runs the Mol* marker pass, which is what the flat viewer and
   * the workbench read; the immersive frame does not resolve that pass, so the
   * wearer saw nothing.
   *
   * The mark is an overpaint layer instead, and it rides inside the SAME
   * overpaint the lesson key is painted with: one representation carries one
   * overpaint decorator, and a second of the same kind would replace it rather
   * than add to it. So painting the selection is painting the emphasis, with
   * the selection layer last. Everything that already repaints the key after a
   * rebuild — the agent's appearance command, a render-quality change, the
   * menu's representation rows, a staged swap, a theme-only recolour — repaints
   * the selection with it, for free and for the same reason.
   */
  async function paintSelectionOverlay() {
    if (!selection || !structure) return;
    const plan = currentEmphasisPlan() ?? { colours: [], faded: [], lit: [], transparency: 0 };
    await paintEmphasisLayers(plan, { transparency: false });
    // Mol* has one transparency state per representation. Compose the context
    // fade, scoped-style mask and hidden rows in one final pass, with hidden
    // rows last, so selecting or repainting a key cannot reveal them.
    await paintVisibilityLayers(plan);
  }
  function currentSelectionPlan(keys = state.selectionKeys) {
    if (!selection || !structure) return undefined;
    return selectionPaintPlan({ selectionKeys: keys, hiddenKeys: hiddenSceneKeys(keys),
      appearance: inspectionSnapshot().appearance,
      lessonColorKeys: typeof emphasisOrigin !== 'undefined' && emphasisOrigin !== 'command'
        ? currentEmphasisPlan()?.colours.flatMap(part => part.keys) ?? [] : [],
      lessonSelection: typeof lessonSelection === 'undefined' ? undefined : lessonSelection });
  }
  /**
   * The rows the saved hidden set takes off the screen.
   *
   * Resolved from the catalog rows rather than stored, so a class — "the water"
   * — means whatever water this structure has, and the saved scene stays a list
   * of identities rather than thousands of residue keys.
   */
  function hiddenSceneKeys(keys = state.selectionKeys) {
    if (!selection) return [];
    return hiddenRowKeys(selection.rows ?? [], visibilityState, keys);
  }

  /** Whether a row is currently off the screen, for the label and mark paths. */
  function hiddenSceneKeySet(keys = state.selectionKeys) {
    return new Set(hiddenSceneKeys(keys));
  }

  /**
   * Whether a figure plate's target is drawn: some of its rows are not hidden,
   * and they are not faded below the default context opacity, unless one of
   * the figure's own solid layers draws them. Track visibility is separate.
   */
  function figurePlateGate(figure, plan = currentEmphasisPlan()) {
    const rows = selection?.rows;
    if (!rows?.length) return () => true;
    const hidden = hiddenSceneKeySet();
    const faint = plan?.faded?.length && plan.transparency > 1 - DEFAULT_CONTEXT_OPACITY + 1e-12 ? new Set(plan.faded) : undefined;
    const solid = (figure?.layers ?? []).filter(layer => (layer.opacity ?? 1) >= DEFAULT_CONTEXT_OPACITY);
    return target => {
      let named = false;
      for (const row of rows) {
        if (!figureTargetMatchesRow(target, row)) continue;
        named = true;
        if (hidden.has(row.key)) continue;
        if (!faint?.has(row.key) || solid.some(layer => figureTargetMatchesRow(layer.target, row))) return true;
      }
      // A target the catalog cannot name is not evidence of a hidden part.
      return !named;
    };
  }

  /**
   * The rows a static scene hides so it draws one state: the copies its
   * chapter animation hides at t=0. The installed animation shows them by its
   * own clock, and its bodies drop this mask.
   */
  let staticMaskCache;
  function staticMaskKeys() {
    const definition = lessonFigure.animationContext?.(), data = structure?.obj?.data;
    if (!definition?.tracks?.length || !data || !selection?.fromLoci) return [];
    if (staticMaskCache?.definition === definition && staticMaskCache.data === data) return staticMaskCache.keys;
    const keys = [];
    for (const track of definition.tracks) if (!evaluateTrackVisibility(track, 0))
      keys.push(...(selection.fromLoci(selectAnimationTrack(data, track)) ?? []));
    staticMaskCache = { definition, data, keys: [...new Set(keys)] };
    return staticMaskCache.keys;
  }
  /** The masked rows a body must still show; the wearer's own hides stay. */
  function staticMaskLoci() {
    const hidden = hiddenSceneKeySet(), keys = staticMaskKeys().filter(key => !hidden.has(key));
    return keys.length && selection ? selection.toLoci(keys) : undefined;
  }
  let paintedStaticMask = '';
  /** Repaint only when the chapter animation changed which copies are masked. */
  async function syncStaticMask() {
    if (staticMaskKeys().join('\n') !== paintedStaticMask) await paintVisibilityLayers();
  }
  /** Plates follow a visibility or fade change, static or attached. */
  function refreshPlateVisibility(plan) {
    if (typeof lessonFigure === 'undefined') return;
    lessonFigure.applyVisibility(plan);
    if (molecularAnimation.snapshot()) molecularAnimation.apply();
  }

  /**
   * Draw the hidden set, on the SAME layer machinery emphasis
   * uses and without touching the representation itself.
   *
   * A full-transparency layer over the hidden rows is Mol*'s per-element way to
   * take atoms off the screen: the representation, its ref, its geometry and
   * every other layer hanging off it are left exactly as they were, so showing
   * again is deleting one cell and the picture that comes back is the picture
   * that was there — which is what "restored exactly on show" has to mean for a
   * receipt comparison to pass. Rebuilding the representation into hidden and
   * visible components would cost a Quest 2 seconds per hide, drop the emphasis
   * layers, and change the ref every other layer is addressed to.
   *
   * It paints onto every representation of the molecule, the ligand overlay
   * included, for the reason `paintEmphasisLayers` does: the overlay's units
   * hold a SUBSET of the structure's elements, so a bundle taken against the
   * structure names different atoms there and the loci is remapped first.
   *
   * Called from inside an already-admitted mutation, never taking the queue of
   * its own, so an appearance rebuild can repaint the hidden set without
   * waiting on itself.
   */
  async function paintVisibilityLayers(emphasisPlan, { recovering = false } = {}) {
    if (!selection) return;
    const keys = hiddenSceneKeys(), mask = typeof staticMaskKeys === 'function' ? staticMaskKeys() : [];
    if (typeof syncStaticMask === 'function') paintedStaticMask = mask.join('\n');
    // Styled residues are drawn by their component. Mask their base geometry
    // so an opaque cartoon cannot shine through a translucent scoped style.
    const styled = [...new Set(stylesState.flatMap(style => style.selectionKeys))];
    const fade = emphasisPlan ?? currentEmphasisPlan();
    dropDeadOverlayRefs();
    const { targets } = liveEmphasisTargets(
      [{ repr: representation, suffix: '', data: structure?.obj?.data },
        ...(ligandOverlay?.representation
          ? [{ repr: ligandOverlay.representation, suffix: '-ligand', data: ligandOverlay.component?.obj?.data }] : []),
        ...styleLayerTargets()],
      ref => Boolean(plugin.state.data.cells.get(ref)));
    for (const suffix of ['', '-ligand', ...styleLayerTargets().map(target => target.suffix)]) {
      const ref = representationLayerRef(representation, SCENE_VISIBILITY_LAYER_REF, suffix);
      if (plugin.state.data.cells.get(ref)) await plugin.build().delete(ref).commit();
    }
    const plates = () => { if (typeof refreshPlateVisibility === 'function') refreshPlateVisibility(fade); };
    if (!keys.length && !styled.length && !fade?.faded?.length && !mask.length) { plates(); return; }
    for (const { repr, suffix, data } of targets) {
      if (!repr?.ref) continue;
      const hidden = suffix === '' || suffix === '-ligand' ? [...new Set([...keys, ...styled, ...mask])] : [...new Set([...keys, ...mask])];
      const layers = [];
      const add = (keys, value) => {
        if (!keys?.length) return;
        const loci = selection.toLoci(keys);
        const mapped = data ? StructureElement.Loci.remap(loci, data) : loci;
        if (!StructureElement.Loci.isEmpty(mapped)) layers.push({bundle: StructureElement.Bundle.fromLoci(mapped),value});
      };
      // Mol* replaces a representation's transparency state. Keep the fade and
      // full masks in this final state, with hidden rows taking precedence.
      add(fade?.faded, fade?.transparency);
      add(hidden, 1);
      if (!layers.length) continue;
      await plugin.build().to(repr.ref)
        .apply(StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle,
          { layers }, { ref: representationLayerRef(representation, SCENE_VISIBILITY_LAYER_REF, suffix) }).commit();
    }
    assertContext({ recovering });
    plates();
  }

  /**
   * The live emphasis as a render plan, including the empty one.
   *
   * An empty plan is not nothing: painting it deletes both layers, which is how
   * a structure that is meant to be plain stops wearing the last chapter's
   * colours after a rebuild.
   */
  function currentEmphasisPlan() {
    if (!selection) return undefined;
    return planLessonEmphasis({ parts: emphasisState.parts, focus: emphasisState.focus,
      alsoLit: emphasisState.alsoLit, strandShades: emphasisState.strandShades,
      contextOpacity: paintedContextOpacity(emphasisState.contextOpacity) }, spokenSelectionKeys,
      (selection.rows ?? []).map(row => row.key));
  }

  /**
   * The ghost strength this session actually paints.
   *
   * The saved emphasis keeps what the chapter AUTHORED, because that is the
   * lesson's own word for it and a scene saved in passthrough must not teach a
   * desktop panel a passthrough number. The floor is applied here, at paint
   * time, so entering and leaving passthrough repaints at the right strength
   * without rewriting the lesson.
   */
  function paintedContextOpacity(contextOpacity) {
    let blend = null;
    try { blend = canvas.xr.isPresenting.value ? (immersiveSession?.environmentBlendMode?.() ?? null) : null; }
    catch { blend = null; }
    return contextOpacityForBlendMode(contextOpacity, blend);
  }

  /**
   * A part the loaded structure cannot answer for, on the log.
   *
   * A chapter that silently lit everything is the wall-tier defect this guards
   * against, and the only way to tell it apart from a chapter that MEANT to light
   * everything is a record saying which parts went missing. Chain ids and part
   * ids are lesson vocabulary, not wearer data, so they are safe to record.
   */
  function recordEmphasisResolution(plan) {
    if (!plan?.unresolved?.length) return;
    let record;
    try { record = globalThis.__stereofoldDiagnostics?.record; } catch { return; }
    if (typeof record !== 'function') return;
    try {
      record('lesson-emphasis-chain', {
        missing: plan.unresolved.map(part => part.id),
        chains: plan.unresolved.map(part => part.chain ?? ''),
        fallback: plan.fallback ?? 'none',
        reason: plan.unresolved[0]?.reason ?? '',
      });
    } catch { /* A diagnostics failure never costs the wearer a chapter. */ }
  }

  /**
   * `origin` says who this key belongs to, and only that.
   *
   * A lesson chapter passes 'lesson'; every other caller — the agent's
   * `emphasize` command, the wearer's "show me the guide RNA" — leaves the
   * default, because they asked for this key themselves and a tour stopping is
   * no reason to take it off them. The saved scene records the origin, so a
   * restore can tell a resting paint from a named key.
   */
  async function emphasize({ parts = [], focus, alsoLit, contextOpacity = DEFAULT_CONTEXT_OPACITY, framing, strandShades = false, origin = 'command', labelTransaction = false } = {}) {
    if (framing && !labelTransaction && typeof componentLabels.transaction === 'function') {
      return componentLabels.transaction(() => emphasize({ parts, focus, alsoLit, contextOpacity, framing,
        strandShades, origin, labelTransaction: true }));
    }
    assertReady();
    if (origin === 'lesson' && parts.length) {
      talkCaption?.set({ outcome: '', sending: false });
      await immersiveSession?.clearStatus?.();
    }
// A chapter emphasis on a density tier paints nothing, and
    // does so quietly.
    //
    // An isosurface at one absolute contour is one mesh with no chains,
    // residues or ligands in it, so there is no part of it to light and no part
    // to fade. Falling through would resolve every named part against an empty
    // row list, log the whole key as missing on every chapter of the tier
    // (`emphasis-target-missing`, `lesson-emphasis-chain`), and then throw in
    // `bundleFor` on a `selection` that does not exist. The chapter is not
    // broken by this: its placement, its clipping, its fog and its narration
    // all still run, and those are what carry a density chapter.
    //
    // The crowns chapter is deliberately NOT a contour or colour
    // split. A second crown-only representation would double the per-frame
    // vertex cost of the largest mesh the Quest 2 holds, and a transparency
    // layer has no volume form — neither fits the budget. So the whole map
    // stays lit and the amber key is the highlight; the chapter says so.
    if (volume) {
      emphasisOrigin = origin === 'lesson' ? 'lesson' : origin === 'resting' ? 'resting' : 'command';
      emphasisState = normalizeEmphasisState({ parts, focus, alsoLit, contextOpacity, strandShades });
      // A density tier paints no key, so no plate may survive the chapter that
      // asked for one on the atomic tier before it.
      await rebuildComponentLabels();
      lessonKey.remember(emphasisState);
      recordCost('volume-emphasis-skipped', { parts: parts.length, focus: emphasisState.focus.length });
      // The framing is not emphasis and is not skipped: a density chapter is
      // placed in the room exactly like a chapter whose subject is a whole
      // structure, which is the branch below this one takes too.
      return framing
        ? await focusSelection({ framing, wholeStructure: true, enclosure: LESSON_MAX_ENCLOSURE,
          elevationDegrees: LESSON_ELEVATION_DEGREES, liftEmphasis: false })
        : snapshot();
    }
    const plan = planLessonEmphasis({ parts, focus, alsoLit, strandShades,
      contextOpacity: paintedContextOpacity(contextOpacity) },
      spokenSelectionKeys, (selection?.rows ?? []).map(row => row.key));
    // Before the paint, so a chapter whose key went missing is on
    // the log even if the paint itself then fails.
    recordEmphasisResolution(plan);
    // What the wearer is looking at, as a value the
    // saved scene can carry. Recorded from the request rather than the layers,
    // because the layers are row keys for this one loaded structure and the
    // request is the lesson's own words for the same thing.
    const nextEmphasis = normalizeEmphasisState({ parts, focus, alsoLit, contextOpacity, strandShades });
    // Before the mutation, not after it. `mutate` emits `onMutation` from
    // inside itself, the tour player reads that as a takeover, and a takeover
    // asks this viewer whether the live key is the lesson's to remove. An
    // agent's or a wearer's `emphasize` is a mutation like any other, so
    // recording who asked afterwards would answer that question with the
    // PREVIOUS chapter's provenance and delete the key that was just asked for.
    //
    // And put back on rejection, because a paint that never
    // landed asked for nothing. `emphasisState` below is only reached when the
    // mutation resolves, so without this the pair drifts apart: the molecule
    // keeps wearing the key the wearer asked for by name while this viewer
    // records it as the lesson's, and the next takeover or hydrate repaints
    // over it. The tour player's `dropLessonEmphasis` swallows exactly this
    // rejection, so nothing downstream would have noticed.
    const previousOrigin = emphasisOrigin;
    emphasisOrigin = origin === 'lesson' ? 'lesson' : origin === 'resting' ? 'resting' : 'command';
    const previousEmphasis = emphasisState;
    try { await mutate('representation', async () => {
      await paintEmphasisLayers(plan, { transparency: false });
      await paintVisibilityLayers(plan);
      // The rendered observer must snapshot the key just painted. The plate
      // still reads its prior committed subject until mutate admits the draw.
      emphasisState = nextEmphasis;
    }, { lessonCheckpoint: { origin: previousOrigin } }); }
    catch (error) { emphasisOrigin = previousOrigin; emphasisState = previousEmphasis; throw error; }
    // The plates name the key that was just painted, which the
    // tour player applies AFTER the appearance configure above — so without
    // this a chapter change would leave the previous chapter's names on the
    // new key until the next rebuild. An empty key takes every plate down.
    await rebuildComponentLabels(framing ? 'emphasis' : origin === 'lesson' ? 'scene' : undefined);
    // Whoever asked for this key, the wearer has now seen it, so
    // its names are theirs to say. An empty one is a clear and is ignored here:
    // that is precisely the case this memory exists to survive.
    lessonKey.remember(nextEmphasis);
    const litKeys = plan.lit;
    recordManipulation('lesson-emphasis', { parts: plan.colours.length, faded: plan.faded.length, focus: nextEmphasis.focus.length,
      // The two numbers that tell "this chapter lights everything
      // on purpose" apart from "this chapter lost its key".
      ...(plan.unresolved.length ? { missing: plan.unresolved.length } : {}),
      ...(plan.fallback ? { fallback: plan.fallback } : {}),
      ghost: Number(plan.transparency.toFixed(3)) });
    // The wearer owns the camera in XR, so "frame it" is a placement of the
    // molecule, not a camera move. focusSelection already knows that.
    //
    // A lesson frames a part inside a complex it must keep in
    // view, so it never frames tighter than LESSON_MIN_TARGET_FRACTION of the
    // structure. Chapter 6 shows why. Its focus
    // was two single alanines, a sphere of 16 A inside an 89 A complex, and
    // framing that at thirty degrees scaled the whole structure to a 1.8 m
    // radius at 1.2 m: the wearer was half a metre INSIDE the molecule and the
    // frame was every colour of the key at once. An agent's own
    // `focus_selection` keeps the tight framing it was built for; only the
    // lesson path is bounded.
    // A chapter that emphasises nothing still gets framed, and
    // what it frames is the whole complex. Chapter one is the reference frame a
    // wearer learns the colour key from, and until now it was the one chapter
    // that was never placed at all: it sat wherever the entry seat had left it,
    // at whatever size the authored `placement.scale` happened to give.
    if (framing) {
      // A chapter may frame; it may not fight the wearer.
      //
      // A wearer has to stay able to move the structure during a demo.
      // A lesson chapter frames once, on arrival. Anything
      // that repaints the SAME chapter's key — a representation rebuild, a
      // re-visit of the step, an autoplay re-render — used to frame again and
      // snap the molecule out of the wearer's hands. The key itself says which
      // chapter this is, so a new key is a new chapter and a repeat is not.
      if (origin === 'lesson') {
        const key = JSON.stringify([nextEmphasis.parts.map(part => part.id ?? part), nextEmphasis.focus, framing]);
        if (key !== lastLessonChapterKey) { lastLessonChapterKey = key; wearerPlacement.chapterStart(); }
      }
      if (origin === 'lesson' && wearerPlacement.holdsPlacement()) {
        // Not an error and not a silence: the chapter is on screen with its
        // colours, standing where the wearer put it.
        recordManipulation('wearer-placement', { event: 'framing-held', ...wearerPlacement.state() });
        return snapshot();
      }
      // `liftEmphasis: false` is not an optimisation: the keys below are the
      // ones this call just lit, so asking the framing to lift them out of the
      // fade would call back into here and never stop.
      // And level, not eight degrees up. A lesson chapter is
      // framed for a wearer who is sitting through it, so its subject belongs on
      // the wearer's own convergence centre; an elevated framing puts every
      // chapter 12 to 19 per cent of a lens height above it.
      // A chapter whose subject IS the whole structure frames the
      // whole structure, rather than selecting every row and solving a bounding
      // sphere around all of them. "Light the whole wall" is twelve parts and
      // every polymer row of the tier, and pushing five thousand row keys
      // through the selection and the sphere solver to arrive back at the
      // structure's own boundary is work with a known answer. The threshold is
      // a share rather than equality because a polymer key that covers every
      // chain still leaves the ligand and water rows out.
      const rowCount = selection?.rows?.length ?? 0;
      const framesWholeStructure = rowCount > 0 && litKeys.length >= rowCount * WHOLE_STRUCTURE_ROW_SHARE;
      return litKeys.length && !framesWholeStructure
        ? focusSelection({ selectionKeys: litKeys, framing, minTargetFraction: LESSON_MIN_TARGET_FRACTION,
          elevationDegrees: LESSON_ELEVATION_DEGREES, liftEmphasis: false,
          marksSelection: emphasisOrigin === 'command', lessonSelection: false })
        // And it frames it as CLOSE as a lesson ever frames
        // anything, which is not what sixty degrees of it comes to.
        //
        // Every other chapter floors its target at LESSON_MIN_TARGET_FRACTION
        // of the structure, so the structure itself ends up at an enclosure of
        // LESSON_MAX_ENCLOSURE — radius.85 of the distance, about eighty
        // degrees across. This branch framed the same sphere at the sixty the
        // chapter asked for, so the one chapter whose subject is the whole tier
        // was the smallest thing a wearer saw: the lit subject of the dimer's
        // chapter 1 measured 48 degrees wide and the wall's, which takes this
        // branch, 31. A tier has to fill the view and a wall has to feel
        // room-sized, so the whole structure gets the same enclosure the parts
        // already put it at.
        : focusSelection({ framing, wholeStructure: true, enclosure: LESSON_MAX_ENCLOSURE,
          elevationDegrees: LESSON_ELEVATION_DEGREES, liftEmphasis: false });
    }
    return snapshot();
  }

  /**
   * Take the lesson's fade off, but only if it is the
   * lesson's to take.
   *
   * A lesson chapter fades everything but the part it is teaching. When a
   * takeover or a source change stops that lesson, nothing was left to own the
   * fade, and the wearer was handed a structure at twelve per cent opacity with
   * the last chapter's colours on it and no lesson running to explain them. The
   * grab, the agent's focus, the quality change and the workbench sync all end
   * here. A key an agent or the wearer asked for by name is untouched: they
   * asked for it, and stopping a lesson is not an answer to that request.
   * Releasing now returns to the first chapter's loaded key
   * and optional plates; a viewer with no resting lesson still returns plain.
   * The rule itself lives in `lesson-resting.mjs`, where the hydrate and the
   * restore read the same notion of whose key the molecule is wearing.
   */
  async function clearLessonEmphasis() {
    return lessonResting.clear();
  }

  /**
   * Install or remove the visual baseline of the loaded lesson.
   *
   * Sent on every hydrate, with a lesson or with nothing. `undefined` is a full
   * clear: no baseline, no plate flag, no plates, and the resting paint taken
   * back off if this viewer was the one that applied it.
   *
   * The caller supplies only the first chapter. `componentLabels` is opt-in:
   * absent is false, so lessons that never authored plates keep drawing exactly
   * as they did. Framing and placement remain tour actions; attachment only
   * paints the part key and builds its plates.
   */
  async function setLessonRestingState(value, options) {
    assertReady();
    return lessonResting.install(value, options);
  }

  async function installMolecularChapter(value, chapterId, { frame = true, context, framing = 'fill', installFigure = false, figure, toolbarReady } = {}) {
    if (!value && !molecularAnimation.snapshot()) return Promise.resolve(snapshot());
    const began = now();
    let result = await inspectionMutation(async () => {
      // Retire the previous plates before installing motion. Building the new
      // figure here made text and ligand layers block the first moving bodies.
      // A restart retires the plates the running chapter still poses, so stop
      // posing them and let its queued work land first. A teardown keeps the
      // chapter's animation as its static t=0 scene.
      if (installFigure) {
        molecularAnimation.halt();
        try { await molecularAnimation.settled(); await lessonFigure.install(undefined, { animation: value }); }
        catch (error) { molecularAnimation.resume(); throw error; }
      } else if (value) lessonFigure.setAnimation?.(value);
      // The template draws while bodies build: mask the copies hidden at t=0.
      if (value && typeof syncStaticMask === 'function') await syncStaticMask();
      // Body construction overlaps the caption; reveal waits for its bounds.
      await molecularAnimation.install(value, chapterId, { beforeReveal: toolbarReady });
      // A chapter with no motion of its own draws every copy its figure names.
      // Going back to an animated chapter and on to a still one stages the
      // still figure while the old motion runs; its t=0 state must not stay.
      if (!value && chapterId !== undefined) lessonFigure.setAnimation?.(undefined);
      if (!value && typeof syncStaticMask === 'function') await syncStaticMask();
      applyInspectionTransform();
    }, { animationInstalled: true });
    recordCost('animated-chapter-stage', { stage: 'bodies-drawn', elapsedMs: now() - began });
    // Authored emphasis/figure framing ran before the new body transforms
    // existed. Refit its subject against every animated pose, including on a
    // cached return or restart. Live edits and wearer placement still win.
    const refit = async () => {
      if (!frame || !value || wearerPlacement?.holdsPlacement()) return;
      const keys = new Set(emphasisOrigin === 'lesson' && emphasisState.focus.length
        ? currentEmphasisPlan().lit : []);
      const figureFocus = (installFigure ? figure : lessonFigure.definition())?.focus;
      if (figureFocus) for (const row of selection.rows)
        if (figureFocus.some(target => figureTargetMatchesRow(target, row))) keys.add(row.key);
      const target = molecularAnimation.framingEnvelope(keys.size ? selection.toLoci([...keys]) : undefined);
      if (target) result = await focusSelection({ framing, liftEmphasis: false, durationMs: 0, elevationDegrees: 0,
        motionFrame: { target, previousScale: context?.source === structure.obj.data ? context.previousScale : undefined,
          ...(context?.growToFit === true ? { growToFit: true } : {}) } });
    };
    await refit();
    if (installFigure && figure) {
      const figureAt = now();
      result = await inspectionMutation(async () => {
        // Motion keeps ticking while layers and plates build offscreen. The
        // refresh poses them and applies variant masks in one synchronous
        // handoff, so no frame can expose static duplicate head plates.
        // The figure snapshots its surroundings, so the new bodies, tethers
        // and the old bodies' removal must already be in the scene.
        await molecularAnimation.settled();
        await lessonFigure.install(figure, { deferReveal: true, animation: value });
        recordCost('animated-chapter-stage', { stage: 'figure-built', ...lessonFigure.snapshot()?.preparation });
        await molecularAnimation.refresh();
        lessonFigure.animationInstalled();
        applyInspectionTransform();
      }, { animationInstalled: true });
      recordCost('animated-chapter-stage', { stage: 'figure-drawn', elapsedMs: now() - figureAt });
      // The figure's plates, and the travel of those riding a moving body,
      // joined the chapter's field only now. Frame it again so its card and
      // menu make room for them too; where they already do, nothing moves.
      await refit();
    }
    return result;
  }

  async function setLessonFigure(value, { frame = false } = {}) {
    assertReady();
    // A verified empty clear changes no pixels or saved state. Keep normal
    // admission above, and let the registry prove that this exact source has
    // no figure, queued retirement or animation masks still needing a draw.
    if (value === undefined && lessonFigure.isEmptyFor?.(structure)) return snapshot();
    const began = now();
    recordCost('lesson-figure-stage', { stage: 'install', outcome: 'started' });
    await inspectionMutation(async () => {
      // A figure set during running motion belongs to that motion: stage it
      // hidden, then attach its plates to their bodies in one handoff.
      const live = molecularAnimation.poseSample()?.definition;
      await lessonFigure.install(value, live ? { deferReveal: true, animation: live } : { animation: undefined });
      if (live) { await molecularAnimation.refresh(); lessonFigure.animationInstalled(); }
      if (typeof syncStaticMask === 'function') await syncStaticMask();
      applyInspectionTransform();
    });
    recordCost('lesson-figure-stage', { stage: 'install', outcome: 'completed', elapsedMs: Math.round(now() - began) });
    recordCost('lesson-figure', { ...lessonFigure.snapshot(), cleared: !value, sourceSha256: state.sourceSha256 });
    if (value && frame && !wearerPlacement.holdsPlacement()) {
      const entryFrame = typeof initialFigureFrame === 'undefined' || value.focus ? undefined : initialFigureFrame;
      const mode = canvas.xr.isPresenting.value ? 'xr' : 'desktop';
      // Only the initial figure of a source-owned interchangeable composite
      // solves a seat. Re-entry, Back and future figure swaps keep its view.
      if (entryFrame?.fitted[mode]) return snapshot();
      const keys = value.focus ? selection.rows.filter(row => value.focus.some(target => figureTargetMatchesRow(target, row))).map(row => row.key) : [];
      const framedAt = now();
      recordCost('lesson-figure-stage', { stage: 'framing', outcome: 'started' });
      await focusSelection({ selectionKeys: keys, wholeStructure: !value.focus, framing: 'fill',
        ...(entryFrame ? { motionFrame: { target: entryFrame.target } } : {}),
        minTargetFraction: value.focus ? .15 : 0, liftEmphasis: false, elevationDegrees: 0, lessonSelection: true });
      if (entryFrame && !wearerPlacement.holdsPlacement()) entryFrame.fitted[mode] = true;
      recordCost('lesson-figure-stage', { stage: 'framing', outcome: 'completed', elapsedMs: Math.round(now() - framedAt) });
      // Framing uses selection for its target, but contact labels own the readout.
      const clearedAt = now();
      recordCost('lesson-figure-stage', { stage: 'clear-selection', outcome: 'started' });
      await select([]);
      recordCost('lesson-figure-stage', { stage: 'clear-selection', outcome: 'completed', elapsedMs: Math.round(now() - clearedAt) });
    }
    return snapshot();
  }

  /**
   * Nothing framed is ever left inside the fade.
   *
   * "Show me chain B" during a chapter that has faded chain B used to select
   * it, fly the whole complex into frame around it, and show the wearer a
   * twelve per cent ghost — the one thing they had just asked to see was the
   * one thing they could not see. The colour key stays either way, because the
   * wearer has learned it and a request to look at something is not a request
   * to repaint the molecule:
   *
   * - the rows belong to a part the key names, and that part becomes the focus,
   *   so the fade moves onto everything else exactly as a chapter would do it;
   * - they do not, and the fade lifts entirely — the whole key at full strength,
   *   which is what a recap chapter looks like — rather than guessing at a part.
   */
  async function liftFocusOutOfFade(keys) {
    // Nothing is faded unless something is focused, so there is nothing to lift.
    if (!emphasisState.focus.length || !keys.length || !selection) return;
    const id = emphasisFocusForKeys(emphasisState.parts, spokenSelectionKeys, keys);
    if (id && emphasisState.focus.length === 1 && emphasisState.focus[0] === id) return;
    // The default origin, deliberately: somebody asked to be shown this, and a
    // lesson that stops because they asked must not answer by taking the key
    // off the molecule they are now looking at.
    await emphasize({ parts: emphasisState.parts, ...(id ? { focus: [id] } : {}),
      strandShades: emphasisState.strandShades, contextOpacity: emphasisState.contextOpacity });
  }

  /**
   * Write down where the structure ended up relative to the
   * glass, and where it would have ended up without the rule.
   *
   * A share is of the lens's width; a metre is from the wearer's eye. `pierced`
   * counts the panel's own drawn points the structure is in front of, which is
   * the pixel overlap a wearer-view capture shows, and it is measured on both
   * plans from the same plate geometry so one run carries a before and an
   * after. Nothing here changes anything.
   */
  function recordStandoff({ framing, plan, plates, captions = [], eye, plateRange, turn }) {
    const rule = plan?.standoff;
    if (!rule) return;
    const round = value => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
    const face = (state, sphere) => ({ distance: round(state.distanceMetres), nearest: round(state.nearestMetres),
      farthest: round(state.farthestMetres), radius: round(state.radiusMetres), depth: round(state.depthMetres),
      subjectLens: round(state.subjectFraction), assemblyLens: round(state.assemblyFraction),
      // The projected rectangle's own shares, which are the ones
      // a wearer-view capture can be measured against.
      subjectRise: round(state.subjectRise), assemblyWide: round(state.assemblyWide),
      assemblyTall: round(state.assemblyTall),
      pierced: occludedPlateShare({ points: plates, origin: eye, sphere }).occluded });
    // The two rectangles, in lens fractions, and what it cost to
    // separate them. `overlap: false` is the proof that the structure is no
    // longer sitting in the caption's corner.
    const rect = value => (value ? { left: round(value.left), right: round(value.right),
      bottom: round(value.bottom), top: round(value.top) } : null);
    globalThis.__stereofoldDiagnostics?.record?.('plate-standoff', {
      framing, plates: plates.length, limited: rule.limited, clears: rule.clears,
      measured: rule.measured === true,
      // Which distance this seat came from — `angular` is the
      // preferred 1.2 m where the fit's own share of the lens projects exactly,
      // `standoff-floor` is the plate rule pushing the structure back. The
      // record is bounded (`MAX_DETAIL_KEYS`), so related frame evidence
      // added here rides inside `frame`.
      seat: rule.seatReason ?? null,
      granted: round(rule.grantedStandoffMetres), reachLimited: rule.reachLimited === true,
      frame: rule.frame ? { subject: rect(rule.frame.subject), plate: rect(rule.frame.plate),
        // The rectangle the dodge actually avoided, how many
        // points it was read from, the step that won, and whether the subject
        // came out centred. `plate` beside it is still the whole panel.
        caption: rect(rule.frame.caption), captions: captions.length,
        move: rule.frame.move ?? null, centred: rule.frame.centred === true,
        axis: rule.frame.axis, shrink: round(rule.frame.shrink), overlap: rule.frame.overlap,
        // The subject's lens share before the dodge, and the
        // off-axis widening in it, so `limited` and `subjectLens` can be read
        // against each other.
        fitted: round(rule.frame.fitted), spread: round(rule.frame.spread),
        // The menu column the ghost was checked against, and
        // the projected shares the wearer sees. Same depth as `caption`.
        // The strand's own verdict rides inside `menu`: whether
        // the ghost still crosses the column, and whether no strand sits over a
        // button. Both are scalars, so the page sanitiser and the Mac schema
        // carry them unchanged.
        // `menu.overlap` false is the proof a density map is off
        // the menu column, and `share.wide` is what a capture measures against
        // the 0.55 volume ceiling. Both ride beside the other frame fields.
        menu: rule.frame.menu ? { rect: rect(rule.frame.menu.rect),
          move: rule.frame.menu.move ?? null, cleared: rule.frame.menu.cleared === true,
          overlap: rule.frame.menu.overlap === true,
          ghost: rule.frame.menu.ghost ? { crossed: rule.frame.menu.ghost.crossed === true,
            cleared: rule.frame.menu.ghost.cleared === true,
            // The ghost RECTANGLE sat over a button, which is
            // what a capture shows and what eight corners kept missing.
            covered: rule.frame.menu.ghost.covered === true } : null } : null,
        share: rule.frame.share ? { whole: round(rule.frame.share.whole),
          lit: round(rule.frame.share.lit), wide: round(rule.frame.share.wide),
          tall: round(rule.frame.share.tall) } : null,
        // The final rotated projection the wearer is drawn,
        // beside the share that was granted, so a ring line reading
        // `share.lit: 0.408` next to `drawn.lit: 0.208` names the gap instead
        // of hiding it. `granted` is the whole share before the final cut and
        // `gain` the lit gain the second pass divided by.
        drawn: rule.frame.drawn ? { lit: round(rule.frame.drawn.lit), whole: round(rule.frame.drawn.whole),
          litRise: round(rule.frame.drawn.litRise), wholeRise: round(rule.frame.drawn.wholeRise),
          granted: round(rule.frame.drawn.granted.whole), gain: round(rule.frame.drawn.gain.lit) } : null,
        // The turn a grown tier landed with, so the next
        // hardware run can prove the growth step from the ring alone rather
        // than by measuring silhouettes in a screenshot. `delta` is the turn
        // from the PREVIOUS tier's pose — bounded by the easing above, never a
        // cut — `ms` how long it was travelled over, and `across`/`was` the
        // share of the subject's own length that reaches the lens after and
        // before it. A framing that is not a growth landing records null.
        growth: turn ? { delta: round(turn.deltaDegrees), ms: turn.turned ? turn.durationMs : 0,
          tilt: round(turn.tiltDegrees), roll: round(turn.rollDegrees),
          // The wall azimuth this landing twisted by, so the
          // ring says which face the sheet landed on without a screenshot.
          azimuth: round(turn.azimuthDegrees ?? 0), turned: turn.turned === true,
          across: round(turn.after), was: round(turn.before), elongation: round(turn.elongation),
          lit: round(rule.frame.share?.lit) } : null } : null,
      plateNear: round(rule.plateNearMetres), plateFar: round(plateRange?.far),
      floor: round(rule.floorMetres), minDistance: round(rule.minDistanceMetres),
      after: face(rule.assembly, { centre: rule.assembly.centre, radius: rule.assembly.radiusMetres }),
      before: face(rule.before, { centre: rule.before.centre, radius: rule.before.radiusMetres }) });
  }

  // A chapter's source basis remains fixed. Count what is drawn now (at t=0
  // before the clock runs): the posed moving bodies, the drawn geometry and
  // the physical plate extents. A hidden state copy adds neither its body, its
  // plate nor its track travel. A still illustrated chapter, or one whose
  // moving bodies are all hidden, has a field only on request (`still`), for
  // menu admission and relocation; it is marked `still` and never walks out,
  // because counting each still plate's stand-off walked a labelled scene out
  // to 8 m. The walk-out fits ask for moving fields alone.
  function chapterFieldBounds(atScale = inspectionSnapshot().placement.scale, { still = false, drawn = false, allDrawn = drawn } = {}) {
    // While the tour paints a chapter, motion drawn for another chapter (the
    // outgoing one's, kept until this one installs) is not this chapter's field.
    const painting = typeof paintingChapter === 'undefined' ? undefined : paintingChapter;
    const outgoing = painting !== undefined && typeof molecularAnimation !== 'undefined'
      && molecularAnimation.snapshot?.()?.chapterId !== painting;
    const animated = outgoing || typeof molecularAnimation === 'undefined' ? undefined : molecularAnimation.fieldEnvelope?.();
    const illustrated = !animated && still && ((typeof lessonFigure !== 'undefined' && lessonFigure.snapshot())
      || (typeof componentLabels !== 'undefined' && componentLabels.active() && emphasisOrigin === 'lesson'));
    // A chapter's framing measures its drawn subject even before its motion
    // or figure is installed (`drawn`).
    if (!animated && !illustrated && !drawn) return undefined;
    const sphere = loadedSphere();
    if (!sphere) return undefined;
    const transform = presentationTransform(), inverse = Mat4.invert(Mat4(), transform);
    const currentScale = Mat4.getMaxScaleOnAxis(transform);
    // A moving body counts where the chapter opens (the motion sphere below),
    // not where the clock has carried it, so each menu draw sees one field.
    const moving = new Set(animated ? molecularAnimation.movingRepresentations?.() ?? [] : []);
    // GPU density meshes advertise the entire grid cell as their bounding
    // sphere. Use the measured contour that focusSelection already frames;
    // empty grid corners must not push the chapter away from its glass.
    const spheres = typeof volume !== 'undefined' && volume
      ? [{ center: Array.from(sphere.center), radius: sphere.radius, kind: 'drawn' }]
      : visibleChapterSpheres(scientificRepresentations(true).filter(repr => !moving.has(repr))
        .flatMap(repr => repr.renderObjects ?? []), transform, { minimumAlpha: allDrawn ? 0 : .2 }).map(sphere => ({ ...sphere, kind: 'drawn' }));
    if (animated) spheres.unshift({ center: Array.from(animated.center), radius: animated.radius, kind: 'motion' });
    const annotations = new Set([...(typeof lessonFigure === 'undefined' ? [] : lessonFigure.annotations?.() ?? []),
      ...(typeof molecularAnimation === 'undefined' ? [] : molecularAnimation.representations?.() ?? []),
      ...(typeof componentLabelRepresentations === 'function' ? componentLabelRepresentations() : [])]);
    for (const repr of annotations) for (const object of repr.renderObjects ?? []) {
      if (object.type !== 'text' || object.state?.alphaFactor === 0) continue;
      const plate = annotationFieldBounds(repr, object, canvas.camera.scale, currentScale);
      const reach = plate.radius / Math.min(currentScale, atScale);
      const eyeMatrix = latestRoomPlacementPose?.labelViews?.[0]?.transform.matrix;
      const renderOffset = eyeMatrix ? Vec3.transformMat4(Vec3(), plate.offset, eyeMatrix)
        .map((v, i) => v - eyeMatrix[12 + i]) : plate.offset;
      const positions = object.values.aPosition?.ref.value, matrices = object.values.aTransform?.ref.value;
      if (!positions || !matrices) continue;
      // Mol* keeps spare capacity in a text buffer. Its unused tail reads as
      // an anchor at the structure's origin, and each label drew a second,
      // invisible plate there that the menu then had to clear.
      const vertices = renderedMeshVertexCount(object, positions);
      const anchors = new Set();
      for (let instance = 0; instance < (object.values.instanceCount?.ref.value ?? 1); instance++) {
        const matrix = matrices.slice(instance * 16, instance * 16 + 16);
        for (let i = 0; i < vertices * 3; i += 3) {
          const point = Array.from(positions.slice(i, i + 3)), key = `${instance}:${point.join(',')}`;
          if (anchors.has(key)) continue;
          anchors.add(key);
          const local = Vec3.transformMat4(Vec3(), Vec3.transformMat4(Vec3(), point, matrix), inverse);
          // Follow this anchor's own track, not the assembly plus the widest plate.
          const travel = molecularAnimation.annotationEnvelope?.(repr, local);
          if (travel === null || (object.state?.visible === false && !travel)) continue;
          // A plate is measured as drawn for this eye: a quad facing it,
          // pushed along the ray toward it. A still one stands at its
          // anchor. One in a moving chapter is carried along its anchor's
          // path, a few pieces in order, each pushed along its own ray and
          // widened (`sweep`) by the piece and by how far its anchor may
          // face round its selection; a sphere round the plate, its push and
          // the ends of its travel stood half a step above and below it.
          // The eye pose is in room metres; the anchor is in render units.
          if (eyeMatrix && plate.half) {
            const eye = Vec3.scale(Vec3(), Vec3.create(eyeMatrix[12], eyeMatrix[13], eyeMatrix[14]), 1 / canvas.camera.scale);
            const quad = [0, 1].map(axis => [0, 1, 2].map(i => eyeMatrix[axis * 4 + i] * plate.half[axis]));
            const size = Math.min(currentScale, atScale), half = Math.hypot(...plate.half) / size;
            for (const along of animated ? travel?.path ?? [travel ?? { center: local, radius: 0 }] : [{ center: local, radius: 0 }]) {
              const anchor = animated ? Vec3.transformMat4(Vec3(), Vec3.create(...along.center), transform) : Vec3.transformMat4(Vec3(), point, matrix);
              const toward = Vec3.sub(Vec3(), eye, anchor), depth = Vec3.magnitude(toward);
              Vec3.scale(toward, toward, 1 / depth);
              // Within a piece the ray turns by at most its radius over its depth.
              const sweep = animated ? along.radius + ((plate.anchorReach ?? 0) + 2) / size
                + plate.push * Math.min(1, along.radius * currentScale / depth) / size : 0;
              spheres.push({ center: Array.from(along.center), radius: half + sweep, kind: 'plate',
                renderOffset: renderOffset.map((v, i) => v + toward[i] * plate.push), quad, push: plate.push, toward: Array.from(toward),
                ...(sweep > 0 ? { sweep } : {}) });
            }
            continue;
          }
          for (const along of travel?.path ?? [travel ?? { center: local, radius: 0 }])
            spheres.push({ center: Array.from(along.center), radius: along.radius + reach, renderOffset, kind: 'plate' });
        }
      }
    }
    // Each plate keeps its own anchor travel and eye-facing offset.
    if (!spheres.length) return undefined;
    const center = Array.from(spheres[0].center);
    // A drawn chapter holds a ball per atom, too many to spread as arguments.
    const radius = spheres.reduce((most, bound) => Math.max(most, Vec3.distance(center, bound.center) + bound.radius), -Infinity);
    return { center, radius, spheres, ...(animated ? {} : { still: true }) };
  }

  // What the chapter field counted, in room metres, for the record ring.
  function chapterFieldSummary(bounds) {
    const scale = inspectionSnapshot().placement.scale, cameraScale = canvas.camera.scale;
    const metres = value => Math.round(value * scale * cameraScale * 1000) / 1000;
    const summary = { radius: metres(bounds.radius) };
    for (const sphere of bounds.spheres ?? []) {
      const entry = summary[sphere.kind ?? 'other'] ??= { count: 0, largest: 0 };
      entry.count += 1; entry.largest = Math.max(entry.largest, metres(sphere.radius));
    }
    return summary;
  }

  async function clearChapterMenu({ points, glass, statusGlass = [], currentPoints = points, currentGlass = glass, isCurrent, relocationCandidates = () => [], chapterCardCandidates = () => [], lesson = false }) {
    if (!canvas.xr.isPresenting.value || !latestRoomPlacementPose || !isCurrent()) return;
    // The live grab transform differs from the saved pose. A chapter preview
    // redraws the toolbar during that grab too: refusing this shared path
    // rolled back the next chapter and stopped autoplay. Keep its menu seat
    // without claiming clearance until the hand releases the structure.
    if (interactionActive()) return { unmeasured: true };
    const bounds = chapterFieldBounds(undefined, { still: true, drawn: true });
    if (!bounds) return;
    let statusBounds;
    const statusField = () => statusBounds ??= chapterFieldBounds(undefined, { still: true, drawn: true, allDrawn: true }) ?? bounds;
    const sphere = loadedSphere(), before = inspectionSnapshot().placement, held = wearerPlacement.holdsPlacement();
    // A field that stays where it is, still or held, is measured as seen. So
    // is a lesson's: its level move searches seats rather than solving the
    // box, and each motion sphere is cleared by its own silhouette, which
    // the box overstated by a third and set the chapter back that much more.
    const options = { placement: before, bounds, center: sphere.center, radius: sphere.radius,
      cameraScale: canvas.camera.scale, ...latestRoomPlacementPose,
      views: latestRoomPlacementPose.labelViews, menuPoints: points, menuGlass: glass, exact: held || bounds.still === true || lesson };
    // Each drawn plate of the glass must clear each part of the chapter.
    const clears = (menuPoints, views = options.views, menuGlass) => fitChapterField({ ...options, views, menuPoints, menuGlass,
      keepPlacement: true, allowOffscreen: true });
    const inView = (menuPoints, menuGlass) => menuGlassInView({ views: options.views, menuPoints, menuGlass,
      renderFromRoom: options.renderFromRoom });
    const fullyInView = (menuPoints, menuGlass) => menuGlassInView({ views: options.views, menuPoints, menuGlass,
      renderFromRoom: options.renderFromRoom, fully: true });
    // Entry fits the actual mesh. A coarser sphere around a ribbon segment
    // can cross the menu even when every drawn vertex clears it (4HHB).
    // Reuse the entry proof for an unlabelled, static plain structure before
    // its conservative chapter envelope can hide otherwise clear controls.
    if (!lesson && typeof roomEntry !== 'undefined' && roomEntry?.seat && bounds.still
      && !inspectionLabel && bounds.spheres?.every(part => part.kind === 'drawn')) {
      const transform = presentationTransform();
      const geometry = resetEntryGeometry({ objects: scientificRepresentations(true).flatMap(repr => repr.renderObjects)
        .filter(object => object.type !== 'text'), fromPlacement: transform, toPlacement: transform,
        views: options.views, cameraScale: canvas.camera.scale, renderFromRoom: options.renderFromRoom });
      const plates = glass ?? [points];
      const complete = plates.flat(); complete.plates = plates;
      if (geometry && resetEntryLateralBreakdown({ geometry, points: complete, clearance: 0 })?.separated
        && (!statusGlass.length || resetEntryLateralBreakdown({ geometry, points: statusGlass, clearance: 0 })?.separated)
        && fullyInView(complete, plates)
        && !glassPlatesOverlapInViews({ plates, views: options.views, renderFromRoom: options.renderFromRoom })) return;
    }
    // No seat is admitted where one of its plates covers another in either eye.
    const apart = seat => !glassPlatesOverlapInViews({ plates: seat.glass, views: options.views, renderFromRoom: options.renderFromRoom });
    const clearsStatus = (points, views = options.views) => !points?.length || !!fitChapterField({ ...options, bounds: statusField(),
      views, menuPoints: points, menuGlass: [points], keepPlacement: true, allowOffscreen: true });
    const seen = inView(currentPoints, currentGlass);
    if (clears(points, undefined, glass) && clearsStatus(statusGlass) && (!seen || fullyInView(points, glass))
      && !glassPlatesOverlapInViews({ plates: glass, views: options.views, renderFromRoom: options.renderFromRoom })) return;
    // Every newly chosen side seat must be wholly in both current eyes,
    // even when the old room seat has left the wearer's gaze.
    const statusVariants = seats => [...seats, ...seats.filter(seat => seat.statusless).map(seat =>
      ({ ...seat, ...seat.statusless, id: `${seat.id}-statusless`, statusGlass: [], statusless: undefined, statusAside: true }))];
    const candidates = statusVariants(relocationCandidates(latestRoomPlacementPose)).filter(seat => fullyInView(seat.points, seat.glass) && apart(seat));
    // The held structure owns its pose. Fold the controls and prove the
    // independent card in both the turned measurement eyes and current eyes.
    const cards = statusVariants(chapterCardCandidates(latestRoomPlacementPose)).filter(seat => fullyInView(seat.points, seat.glass) && apart(seat));
    const relocates = seat => clears(seat.points, seat.views, seat.glass) && clearsStatus(seat.statusGlass, seat.views);
    const seatsCard = seat => relocates(seat) && clears(seat.points, options.views, seat.glass) && clearsStatus(seat.statusGlass);
    // Keep full caption lines in a centred card: top, else bottom. Narrow
    // corner cards are a last fallback after both complete card bands fail.
    const below = seat => seat.band === 'bottom' || seat.constants?.chapterCardBelow === true;
    const order = lesson ? [false, true].flatMap(beside => [false, true].flatMap(bottom => [false, true].flatMap(aside => [
      ...candidates.filter(seat => (seat.beside === true) === beside && below(seat) === bottom && (seat.statusAside === true) === aside).map(seat => [seat, false]),
      ...cards.filter(seat => (seat.beside === true) === beside && below(seat) === bottom && (seat.statusAside === true) === aside).map(seat => [seat, true])])))
      : [...candidates.map(seat => [seat, false]), ...cards.map(seat => [seat, true])];
    const [found, card] = order.find(([seat, card]) => card ? seatsCard(seat) : relocates(seat)) ?? [];
    if (found && !card) {
      recordManipulation('chapter-field', { reason: 'menu-relocated', seat: found.id, parked: found.parked === true });
      return { menuRelocation: found };
    }
    if (found) {
      recordManipulation('chapter-field', { reason: 'chapter-card-seated', seat: found.id,
        yaw: found.yaw, band: found.band, held });
      return { chapterCardSeat: found };
    }
    // Only after every glass seat fails, take the shortest molecular move, and
    // only a nearby one (`fitChapterField` caps it at 1.5 entry stand-offs).
    // The wearer's placement never moves for the menu, a still chapter keeps
    // its authored seat, and menu admission must not silently reframe an
    // existing close-up.
    // One move per animated chapter. A later draw in it (a status line, a
    // dim, a card page) relocates or folds the menu and never moves the
    // molecule again, so a step sent meanwhile finds the view it read.
    const opened = typeof molecularAnimation === 'undefined' ? undefined : molecularAnimation.snapshot?.()?.chapterId;
    const latched = typeof menuClearanceMovedFor !== 'undefined';
    const moved = opened !== undefined && latched && menuClearanceMovedFor === opened;
    // In a lesson the move is only for the card's own seats with the compact
    // menu, and it is level: sideways away from the menu or back, never up.
    // Glass that is not a card seat (an expanded grid, the menu while the
    // lesson's first chapter loads) folds or stays; it never moves the chapter.
    // Of the card seats, the move is searched for the first whole column and
    // the first compact Menu of each card, band and side; the others differ
    // only in where the control rises beside the same card.
    const side = seat => Math.sign(seat.constants?.rightMeters ?? 0);
    const movingCards = cards.filter(seat => !seat.statusless);
    const seats = lesson ? movingCards.filter((seat, index) => seat.stableLesson || movingCards.findIndex(other => below(other) === below(seat)
      && (other.compact === true) === (seat.compact === true) && (other.beside === true) === (seat.beside === true)
      && side(other) === side(seat)) === index) : [{ points }, ...candidates];
    // Nor past the distance its framing keeps its size at.
    const sizeBound = (typeof chapterSizeBound === 'undefined' ? null : chapterSizeBound)?.maxDistance ?? Infinity;
    let fitted, menuRelocation, cardSeat;
    if (!held && !bounds.still && !moved) for (const seat of seats) {
      let fit;
      try { fit = fitChapterField({ ...options, menuPoints: seat.points, menuGlass: seat.glass ?? glass, views: seat.views ?? options.views,
        allowOffscreen: true, clearanceOnly: true, exact: lesson, standoff: latestSeatStandoffMeters ?? undefined,
        ...(lesson ? { level: true, maxMove: fitted?.field.moveCost, maxDistance: sizeBound } : {}) }); }
      catch { continue; } // An invalid projection or out-of-range seat is not a clearance proof.
      const cost = fit => fit.field.moveCost ?? fit.field.moveMetres;
      if (!fitted || cost(fit) < cost(fitted)) {
        fitted = fit;
        if (lesson) cardSeat = seat; else menuRelocation = seat.id === undefined ? undefined : seat;
      }
    }
    // A lesson chapter has its one try, found or not: a card page or status
    // line drawn later in it keeps the view the wearer has.
    if (lesson && seats.length && !held && !bounds.still && !moved && !fitted && latched && opened !== undefined) menuClearanceMovedFor = opened;
    if (!fitted) {
      // Nothing clears and nothing nearby may move. Outside a lesson no glass
      // that covers the chapter is admitted: the menu folds, or hides when it
      // is already folded (B/Y brings it back), and the placement stays. A
      // lesson keeps its card and compact menu anyway, at the card's top seat
      // with the control where it covers least: a caption and a Menu that
      // touch a moving part beat having neither. A menu redraw never fails a
      // chapter. Glass no eye can measure (behind the wearer) is left as it
      // is: drawn glass stays, hidden glass stays hidden.
      // This fallback is synchronous. All candidates and the diagnostic
      // breakdown see the same field, so project it once per measured eye.
      // Nothing is retained for the next draw, pose or placement.
      const scorers = new Map();
      const obstruction = (query, field = bounds) => {
        let score = scorers.get(field);
        if (!score) scorers.set(field, score = createMenuObstructionScorer({ ...options, bounds: field }));
        return score(query);
      };
      const { area: overlap, part, plate, box, menu } = obstruction(options);
      const round = values => values?.map(v => Math.round(v * 1e3) / 1e3);
      const covers = (seat, field = bounds) => obstruction({ menuPoints: seat.points,
        menuGlass: seat.glass, views: seat.views ?? options.views }, field).area;
      // Glass over a name plate puts text on text, for the whole chapter where the
      // plate stands still and wherever a moving one passes, which no render
      // order keeps readable: a seat whose glass crosses none wins. Next keep
      // the status clear of the molecule, retaining complete lesson glass.
      // Other menus may use their one-line or status-aside variants. Then the
      // full caption card, the top band, the compact menu, the most status
      // lines, and the least covered.
      const named = { ...bounds, spheres: (bounds.spheres ?? []).filter(sphere => sphere.kind === 'plate' && sphere.quad) };
      const statusCovers = seat => (seat.statusGlass?.length ? covers({ ...seat, points: seat.statusGlass, glass: [seat.statusGlass] }, statusField()) : 0) > 0;
      const rank = seat => (seat.band === 'bottom' ? 2 : 0) + (seat.compact && !seat.beside ? 0 : 1);
      const earlier = (a, b) => { const i = a.findIndex((v, k) => v !== b[k]); return i >= 0 && a[i] < b[i]; };
      // A lesson card of the title and one paged caption line is offered
      // here only: wherever a full card clears, or a level move makes room
      // for one, the caption stays whole.
      const shortCards = lesson ? statusVariants(chapterCardCandidates({ ...latestRoomPlacementPose, shortCard: true }))
        .filter(seat => seat.shortCard && fullyInView(seat.points, seat.glass) && apart(seat)) : [];
      let kept;
      if (lesson) for (const seat of [...cards, ...shortCards]) {
        const status = statusCovers(seat);
        for (const [shown, lines] of [[seat, seat.statusAside ? 2 : seat.glance ? 1 : 0]]) {
          // A shared blocked caption can dominate the maximum overlap of
          // every seat. Rank the lesson controls on their own, so that tie
          // never admits a menu over faint context when another seat clears.
          const controls = shown.stableLesson && shown.glass?.[1];
          const controlCover = controls ? covers({ ...shown, points: controls, glass: [controls] }) : 0;
          const order = [named.spheres.length && covers(shown, named) > 0 ? 1 : 0, shown === seat && status ? 1 : 0, controlCover,
            shown.shortCard ? 1 : 0, rank(shown), lines, covers(shown)];
          if (!kept || earlier(order, kept.order)) kept = { seat: shown, order };
        }
      }
      recordManipulation('chapter-field', { reason: kept ? 'chapter-card-kept' : Number.isFinite(overlap) ? 'menu-obstructed' : 'menu-unmeasured', held,
        ...(kept ? { seat: kept.seat.id, band: kept.seat.band, crossesPlates: kept.order[0] === 1,
          status: kept.seat.statusAside ? 'aside' : !kept.seat.statusGlass?.length ? 'none' : kept.seat.glance ? 'one' : 'three',
          controlsCovered: Math.round(kept.order[2] * 1e4) / 1e4,
          ...(kept.seat.shortCard ? { shortCard: true } : {}),
          covered: Number.isFinite(kept.order[6]) ? Math.round(kept.order[6] * 1e4) / 1e4 : null } : {}),
        ...(moved ? { moved: true } : {}),
        still: bounds.still === true, overlap: Number.isFinite(overlap) ? Math.round(overlap * 1e4) / 1e4 : null,
        // The worst pair, in screen units: which part of the field, which plate.
        ...(Number.isFinite(overlap) && part !== undefined ? { blocker: { kind: (bounds.spheres ?? [bounds])[part]?.kind ?? null, part, plate,
          box: round(box), menu: round(menu) } } : {}),
        // Each seat this draw tested (a lesson's are its card seats), measured
        // by each of its own plates alone, card/menu/status, with the kind of
        // part its worst plate meets: `id band:card/menu/status:kind`. A worst
        // pair alone named the card every seat shares and hid the seat's own.
        seats: (lesson ? cards : candidates).map(seat => {
          const areas = (seat.glass?.length ? seat.glass : [seat.points]).map(plate =>
            obstruction({ menuPoints: plate, menuGlass: [plate], views: seat.views ?? options.views }));
          const worst = areas.reduce((a, b) => b.area > a.area ? b : a, { area: 0 });
          return `${seat.id}${seat.band ? ` ${seat.band}` : ''}:`
            + areas.map(({ area }) => Number.isFinite(area) ? Math.round(area * 1e4) / 1e4 : 'unmeasured').join('/')
            + (worst.area > 0 ? `:${(bounds.spheres ?? [bounds])[worst.part]?.kind ?? 'field'}` : '');
        }),
        bounds: chapterFieldSummary(bounds) });
      if (kept) return { chapterCardSeat: kept.seat, kept: true };
      return Number.isFinite(overlap) ? { obstructed: true } : { unmeasured: true };
    }
    if (!isCurrent()) return;
    if (fitted === before) return cardSeat ? { chapterCardSeat: cardSeat } : undefined;
    const apply = () => {
      inspectionState.place({ translation: fitted.translation, scale: fitted.scale }, 'menu-clearance');
      if (latched) menuClearanceMovedFor = opened ?? null;
      applyInspectionTransform();
      const seat = menuRelocation ?? cardSeat;
      recordManipulation('chapter-field', { reason: 'menu', ...fitted.field, ...(seat ? { seat: seat.id } : {}),
        ...(lesson ? { level: true } : {}), bounds: chapterFieldSummary(bounds) });
    };
    // A chapter may already own the surrounding mutation. Otherwise this
    // wearer menu press gets the ordinary drawn-and-saved mutation boundary.
    if (busy) apply();
    else await inspectionMutation(apply, { animationInstalled: true, mutationOrigin: 'automatic-clearance' });
    return cardSeat ? { chapterCardSeat: cardSeat } : menuRelocation ? { menuRelocation } : undefined;
  }

  function modelledFocusKeys(keys) {
    const { modelledKeys } = focusResidues(selection.rows, keys);
    if (!modelledKeys.length) throw failure('missing_coordinates', 'None of the requested residues has modelled coordinates.');
    return modelledKeys;
  }

  async function focusSelection({ selectionKeys, framing = 'context', minTargetFraction = 0, wholeStructure = false,
    enclosure, elevationDegrees, liftEmphasis = true, marksSelection = true, durationMs = LESSON_FRAMING_TRAVEL_MS, motionFrame,
    lessonSelection = false } = {}) {
    assertReady();
    if (typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0 && wearerPlacement.holdsPlacement()) return snapshot();
    const began = now();
    const stage = name => recordCost('focus-stage', { stage: name, elapsedMs: Math.round(now() - began) });
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    const focusOwner = focusPivotRequest = {};
    stage('selection-start');
    const named = !wholeStructure && Array.isArray(selectionKeys) && selectionKeys.length > 0;
    // `wholeStructure` ignores whatever the previous scene left selected, so an
    // opening or a recap frame is the complex and never the last chapter's part.
    const chosen = wholeStructure || motionFrame ? [] : selectedKeys(named ? selectionKeys : [...state.selectionKeys]);
    // Refuse before changing selection or emphasis, so a failed focus leaves
    // the page on the saved scene and the next edit keeps its revision binding.
    const modelled = chosen.length ? modelledFocusKeys(chosen) : [];
    // Before the selection and long before the travel: the wearer must never
    // see the fade lift after the structure has already flown into place.
    if (liftEmphasis) await liftFocusOutOfFade(chosen);
    // A lesson chapter frames its lit parts without selecting them. The
    // selection mark paints over the chapter's key, and the next chapter, which
    // selected nothing, wore it.
    if (named && marksSelection) await select(chosen, 'selection', { lesson: lessonSelection });
    stage('selection-completed');
    // The loaded scene's bounds, whether it is atoms or density.
    // Without the volume half the `filament` tier falls through to
    // `fitInspection`, which is a desktop camera fit, and the wearer's chapter
    // is never placed in the room at all.
    const sphere = recordBoundingSphere({ structure, volume });
    if (!inspectionState || !enableXr || !canvas.xr.isPresenting.value) {
      stage('desktop-framing-start');
      let result;
      if (motionFrame) {
        await inspectionMutation(() => {
          syncInspectionPayload(); inspectionState.recordPayload(null, 'animation-focus');
          plugin.managers.camera.focusSphere(transformSphere(motionFrame.target, presentationTransform()),
            { durationMs: 0, extraRadius: 0, minRadius: 0 });
        });
        inspectionState.setPayload(inspectionPayload());
        result = snapshot();
      } else result = await (chosen.length ? focus(chosen) : fitInspection());
      stage('desktop-framing-completed');
      return result;
    }
    // Tracking loss is not a desktop view. A camera fit here changes the
    // room-to-render transform, moving both the molecule and the room menu.
    if (sphere && (performance.now() - latestHeadSample >= 1500 || !latestRoomPlacementPose)) {
      await awaitFreshFocusTracking(focusOwner);
      assertReady();
    }
    if (!sphere || performance.now() - latestHeadSample >= 1500 || !latestRoomPlacementPose) {
      recordCost('focus-tracking', { outcome: 'refused', reason: 'final_guard',
        sampleAgeMs: Math.max(0, Math.round(performance.now() - latestHeadSample)), roomPose: Boolean(latestRoomPlacementPose), sphere: Boolean(sphere) });
      throw Error('Wait for headset tracking before framing the chapter.');
    }
    const envelope = (typeof molecularAnimation === 'undefined' ? undefined : molecularAnimation.envelope?.()) ?? sphere;
    const target = motionFrame?.target ?? (modelled.length ? molecularAnimation.selectionSphere(selection.toLoci(modelled)) : envelope);
    const focusPivot = { owner: focusOwner, source: sourceRecord, subject: visibleStage, targetCenter: Array.from(target.center) };
    const from = inspectionSnapshot().placement;
    /**
     * The one framing that is allowed to turn the structure.
     *
     * It is spent here whether or not a turn comes back, because the tier has
     * now been framed and a later chapter of the same lesson is not a landing.
     * `subjectPoints` is the lit subject's own extrema when it has them, so a
     * tier that lights one strand is turned by that strand's axis rather than
     * by the assembly's.
     */
    const owedTurn = pendingGrowthTurn;
    pendingGrowthTurn = false;
    const turnPoints = Array.isArray(target.extrema) && target.extrema.length ? target.extrema
      : (Array.isArray(sphere.extrema) ? sphere.extrema : undefined);
    // A landing that frames the whole structure is a sheet-like
    // tier (the wall) as well as a filament, so it lands with the wall azimuth:
    // the quarter-twist about the landed long axis that presents the sheet's
    // broad face — protofilament axis across the lens, lateral neighbours
    // beside each other — instead of the arrival twist the shortest arc would
    // otherwise keep. A part chapter (a strand) keeps the plain oblique turn.
    const turn = owedTurn && turnPoints
      ? obliqueGrowthTurn({ headInRoom: latestRoomPlacementPose.headInRoom,
        renderFromRoom: latestRoomPlacementPose.renderFromRoom, placement: from,
        points: turnPoints, centre: Array.from(target.center),
        ...(wholeStructure ? { azimuthDegrees: GROWTH_WALL_AZIMUTH_DEGREES } : {}) })
      : undefined;
    // The framing is solved in the pose the tier is about to stand in, so the
    // lens band, the caption dodge and the menu clearance are all measured on
    // the silhouette the wearer will actually see rather than on the old one.
    const unturn = !turn?.turned && !motionFrame && typeof frozenTurnDegrees === 'function' ? frozenTurnDegrees(from) : 0;
    const posed = turn?.turned ? { ...from, rotation: turn.rotation }
      : unturn ? { ...from, rotation: rotationDegreesZYX(Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), -unturn * Math.PI / 180, Vec3.create(0, 1, 0)),
        rotationFromPlacement(from))) } : from;
    // A chapter that turns is seated for everything its turn sweeps, not only
    // its t=0 pose: the drawn extent turned through the turn about its pivot,
    // so no part of it swings behind the glass or past the wearer mid-turn.
    // The presentation spin turns about the stage centre, a lesson orbit about
    // the drawn centre (`headsetTurnPivot`).
    const chapterTurn = typeof paintingTurn === 'undefined' ? undefined : paintingTurn;
    const turnPivot = chapterTurn && Array.from(chapterTurn.continuous ? pivotCenter() : drawnCenter());
    const swept = points => chapterTurn ? turnSweptPoints(points, chapterTurn, { pivot: turnPivot, rotation: posed.rotation }) : points;
    // A framing is solved from the target's radius, so a floor under that
    // radius is a ceiling on the scale the whole structure is placed at.
    // A labelled lesson needs space around the whole assembly, including
    // faded context. Bound its target by that assembly and cap the enclosure
    // before travelling; packing cannot invent a band in a lens-filling seat.
    const labelledLesson = !motionFrame && componentLabels.active() && emphasisOrigin === 'lesson';
    if (labelledLesson) minTargetFraction = Math.max(minTargetFraction, 1);
    const targetRadius = Math.max(target.radius, sphere.radius * minTargetFraction);
    if (labelledLesson) enclosure = Math.min(enclosure ?? Math.tan(Math.PI / 12), .4);
    // The plates are UI and must always read, so the framing is
    // solved against the glass that is actually in front of the wearer.
    const plates = immersiveSession?.platePoints?.() ?? [];
    // The caption card on its own. The depth stand-off is
    // solved against every plate; the screen-space seat is solved against this
    // one, so the subject may cross a dimmed menu button but never the line the
    // wearer is being read.
    const captions = immersiveSession?.captionPoints?.() ?? [];
    // Frame against actual glass; label layout reserves the full status block.
    const menus = immersiveSession?.drawnMenuPoints?.() ?? [];
    // One drawn-point set per menu button row, so the ghost
    // strand is checked against buttons rather than the whole column.
    const menuRowSets = immersiveSession?.menuRows?.() ?? [];
    const offeredSeats = wearerPlacement.holdsPlacement() ? [] : immersiveSession?.chapterCardSeats?.(latestRoomPlacementPose) ?? [];
    const jointLessonGlass = !volume && offeredSeats.some(seat => seat.stableLesson);
    const eye = [latestRoomPlacementPose.headInRoom[12], latestRoomPlacementPose.headInRoom[13],
      latestRoomPlacementPose.headInRoom[14]];
    const plateRange = pointRange(plates, eye);
    // The plan moved by a chapter-field fit, re-measured where its target now stands.
    const refitted = (plan, fitted) => {
      const delta = fitted.translation.map((v, i) => (v - plan.translation[i]) * sphere.radius * plan.cameraScale);
      const roomFromRender = Mat4.invert(Mat4(), latestRoomPlacementPose.renderFromRoom);
      const roomDelta = Vec3.transformMat4(Vec3(), delta, roomFromRender).map((v, i) => v - roomFromRender[12 + i]);
      const targetRoom = plan.targetRoom.map((v, i) => v + roomDelta[i]);
      const distance = Vec3.distance(targetRoom, eye);
      const local = Vec3.transformMat4(Vec3(), targetRoom, Mat4.invert(Mat4(), latestRoomPlacementPose.headInRoom));
      const enclosure = targetRadius * plan.scale * plan.cameraScale / distance;
      return { ...plan, translation: fitted.translation, field: fitted.field, targetRoom, distance, enclosure,
        targetLens: [local[0] / -local[2] / Math.tan(42 * Math.PI / 180), local[1] / -local[2]],
        angleDegrees: 2 * Math.atan(enclosure) * 180 / Math.PI };
    };
    const solve = (sweep, turning = Boolean(chapterTurn)) => (motionFrame ? motionFocusPlacement : focusPlacement)({ ...latestRoomPlacementPose,
      ...(motionFrame ? { previousScale: motionFrame.previousScale, growToFit: motionFrame.growToFit } : {}), cameraScale: canvas.camera.scale, center: sphere.center,
      radius: sphere.radius, assemblyRadius: Math.max(sphere.radius, Vec3.distance(sphere.center, envelope.center) + envelope.radius),
      placement: posed, targetCenter: target.center, targetRadius, framing,
      // A boundary's `extrema` are the extreme points Mol* kept
      // along a fixed set of directions, so they are the cheapest honest answer
      // to "what rectangle does this fill from here". Without them the framing
      // falls back to the bounding spheres, which measure a dimer
      // at its length and draw it at its width.
      ...(Array.isArray(target.extrema) ? { subjectPoints: sweep(target.extrema) } : {}),
      ...(Array.isArray(envelope.extrema) ? { assemblyPoints: sweep(envelope.extrema) } : {}),
      // The caption and the menu, so the subject can be seated out from behind
      // them rather than merely behind them.
      ...(!motionFrame && plates.length ? { platePoints: plates,
        // Choose the chapter's natural level frame first. The complete glass
        // is fitted together below, once, against its own plates. Dodging the
        // outgoing status/card union here lowered and shrank later chapters
        // before that clearance pass could choose a better menu seat.
        captionPoints: jointLessonGlass ? [] : captions, menuPoints: jointLessonGlass ? [] : menus,
        menuRows: jointLessonGlass ? [] : menuRowSets } : {}),
      sweptTurn: turning, wholeStructure, minExtentFraction: minTargetFraction,
      // The density tier's whole-map ceiling (0.55 of the lens)
      // instead of the atomic whole-structure one (0.70). This is the branch
      // that records the frame shares for a volume chapter — the `xr-focus`
      // and `plate-standoff` records below fire for it exactly as for atoms.
      ...(volume ? { wholeSubjectCeiling: VOLUME_WHOLE_LENS_CEILING } : {}),
      // The menu half of the volume seat. Empty when the menu is
      // hidden, and then the caption-only seat stands — there is no glass to
      // keep clear of.
      ...(volume && menus.length ? { menuPoints: menus, avoidMenu: true } : {}),
      ...(!motionFrame && Number.isFinite(plateRange?.near) ? { plateNearMetres: plateRange.near } : {}),
      ...(Number.isFinite(enclosure) ? { enclosure } : {}),
      ...(Number.isFinite(elevationDegrees) ? { elevationDegrees } : {}),
      ...(owedTurn ? { subjectCeiling: SUBJECT_LENS_CEILING } : {}) });
    let plan = solve(swept);
    // A spin chapter that frames one part as a close-up the wearer stands
    // inside holds still. Its spin turns the whole structure about the stage
    // centre, so it would carry the framed part out of view and the rest of
    // the structure through the wearer; seating it for that spin instead put
    // CRISPR's nuclease close-up three metres away. Every other spin chapter,
    // a whole structure included, keeps turning, seated for its whole turn.
    const still = chapterTurn?.continuous && named && !motionFrame ? solve(points => points, false) : undefined;
    const holdsStill = Boolean(still && [plan, still].some(option => option.standoff?.limited === 'inside-out'));
    if (holdsStill) plan = still;
    if (typeof turnHeldFor !== 'undefined') turnHeldFor = holdsStill ? paintingChapter : null;
    const fieldBounds = typeof chapterFieldBounds === 'function' ? chapterFieldBounds(plan.scale) : undefined;
    // Animated framing already fits its complete motion at a reading distance.
    // Plate/menu admission relocates the glass after that pose is drawn. A
    // field walks out only within the room and stand-off limits; past them it
    // keeps this frame, and the glass moves or hides once the travel lands.
    let glassYields = false;
    if (fieldBounds && !motionFrame) {
      let fitted = {};
      try {
        fitted = fitChapterField({ placement: { ...posed, scale: plan.scale, translation: plan.translation },
          bounds: fieldBounds, center: sphere.center, radius: sphere.radius, cameraScale: plan.cameraScale,
          ...latestRoomPlacementPose, views: latestRoomPlacementPose.labelViews, menuPoints: plates,
          standoff: (typeof latestSeatStandoffMeters === 'undefined' ? null : latestSeatStandoffMeters) ?? undefined });
      } catch (error) {
        if (error?.code !== 'FIELD_OUT_OF_REACH') throw error;
        glassYields = true;
        recordManipulation('chapter-field', { reason: 'out-of-reach', fit: 'chapter' });
      }
      if (fitted.field) {
        plan = refitted(plan, fitted);
        recordManipulation('chapter-field', { reason: 'chapter', ...fitted.field });
      }
    }
    // A lesson chapter's first seat makes room for its glass. Unless the
    // wearer has placed the molecule, the chapter is framed clear of its card
    // in the top band (else the bottom one) and of the menu column beside it,
    // so the card never has to cover the chapter and nothing moves the
    // chapter after it lands. This is the chapter's framing, so a still
    // chapter takes it too. Its size is kept: a quarter narrower at most than
    // its framing without glass, and a motion chapter never narrower than
    // `MOTION_MIN_DEGREES`. Past that, the card's other band comes first; only
    // a still chapter is then set back farther.
    chapterSizeBound = null;
    const cardSeats = [...offeredSeats, ...offeredSeats.filter(seat => seat.statusless).map(seat =>
      ({ ...seat, ...seat.statusless, id: `${seat.id}-statusless`, statusGlass: [], statusless: undefined, statusAside: true }))]
      .filter(seat => menuGlassInView({ views: latestRoomPlacementPose.labelViews, renderFromRoom: latestRoomPlacementPose.renderFromRoom,
        menuPoints: seat.points, menuGlass: seat.glass, fully: true }));
    const roomBounds = cardSeats.length && typeof chapterFieldBounds === 'function' ? chapterFieldBounds(plan.scale, { still: true, drawn: true }) : undefined;
    if (roomBounds) {
      const field = { placement: { ...posed, scale: plan.scale, translation: plan.translation }, bounds: roomBounds,
        center: sphere.center, radius: sphere.radius, cameraScale: plan.cameraScale, ...latestRoomPlacementPose,
        views: latestRoomPlacementPose.labelViews, exact: true };
      let statusBounds;
      const statusField = () => statusBounds ??= chapterFieldBounds(plan.scale, { still: true, drawn: true, allDrawn: true }) ?? roomBounds;
      const framed = chapterFieldDistance(field);
      const halfWidth = targetRadius * plan.scale * plan.cameraScale / (plan.distance ?? framed);
      const floor = motionFrame ? Math.max(1, halfWidth / Math.tan(MOTION_MIN_DEGREES * Math.PI / 360)) : Infinity;
      chapterSizeBound = { maxDistance: framed * Math.min(1 / GLASS_MIN_SIZE_SHARE, floor) };
      // The top band first. In a band, a seat that already clears the
      // chapter takes it as framed. Else the seat the shortest move clears,
      // the whole column before the compact Menu control when that costs no
      // more. Only the first whole column and the first compact Menu on each
      // side are searched: the other compact seats differ in where the
      // control rises beside the same card. `meter` counts the seats and the
      // parts the solve tested, for the record.
      const meter = { positions: 0, tests: 0 }, kept = new Map();
      const side = seat => Math.sign(seat.constants?.rightMeters ?? 0);
      const glassFor = seat => ({ ...field, menuPoints: seat.points, menuGlass: seat.glass, views: seat.views ?? field.views,
        allowOffscreen: true, meter });
      const keeps = seat => kept.get(seat) ?? kept.set(seat, !!fitChapterField({ ...glassFor(seat), keepPlacement: true })
        && (!seat.statusGlass?.length || !!fitChapterField({ ...glassFor(seat), bounds: statusField(),
          menuPoints: seat.statusGlass, menuGlass: [seat.statusGlass], keepPlacement: true }))).get(seat);
      const solve = maxDistance => {
        // A density map keeps its framing if either caption band clears.
        // Do not retreat for the top card while a bottom card already fits.
        if (volume) {
          const seat = cardSeats.find(keeps);
          if (seat) return { seat, cost: 0 };
        }
        for (const beside of [false, true]) for (const band of ['top', 'bottom']) {
          const seats = cardSeats.filter(seat => (seat.beside === true) === beside && (seat.band === 'bottom' ? 'bottom' : 'top') === band)
            .sort((a, b) => (a.statusAside === true) - (b.statusAside === true)
              || (a.compact === true) - (b.compact === true));
          const seat = seats.find(keeps);
          if (seat) return { seat, cost: 0 };
          let best;
          const movable = seats.filter(seat => !seat.statusless);
          for (const seat of movable.filter((seat, index) => seat.stableLesson || movable.findIndex(other =>
            (other.compact === true) === (seat.compact === true) && side(other) === side(seat)) === index)) {
            try {
              const fit = fitChapterField({ ...glassFor(seat), clearanceOnly: true, level: true, maxDistance,
                standoff: latestSeatStandoffMeters ?? undefined, maxMove: best?.cost });
              if (!best || fit.field.moveCost < best.cost) best = { seat, cost: fit.field.moveCost, fit };
            } catch { continue; } // No level move within the reach and the size clears this seat.
          }
          if (best) return best;
        }
      };
      let found = solve(chapterSizeBound.maxDistance) ?? (motionFrame ? undefined : solve(Infinity));
      if (!found && volume && wholeStructure) {
        // An end-on contour can fill the lens before its enclosing sphere
        // fits beside any card. Every glass seat and permitted move has been
        // tried. Keep the nearest chapter seat and find the largest contour
        // that actually clears the complete glass in both eyes.
        let largest;
        for (const seat of cardSeats) {
          const fits = scale => fitChapterField({ ...glassFor(seat),
            placement: { ...field.placement, scale }, keepPlacement: true });
          let low = clampPlacementScale(0), high = plan.scale;
          if (!fits(low)) continue;
          for (let i = 0; i < 24; i++) {
            const mid = (low + high) / 2;
            if (fits(mid)) low = mid; else high = mid;
          }
          if (!largest || low > largest.scale) largest = { seat, scale: low };
        }
        if (largest) {
          const previousScale = plan.scale;
          plan = refitted({ ...plan, scale: largest.scale }, { translation: plan.translation });
          found = { seat: largest.seat, cost: 0 };
          recordManipulation('chapter-field', { reason: 'contour-glass-fit', previousScale, scale: plan.scale });
        }
      }
      if (found?.fit) {
        // Re-measuring a moving name plate at the landed pose can change
        // the bounded search by a millimetre. Keep that already-clear pose
        // when it is within the solve's precision, proved with today's quad.
        const delta = Vec3.distance(from.translation, found.fit.translation) * sphere.radius * plan.cameraScale;
        if (motionFrame && delta < .002 && Math.abs(from.scale - plan.scale) < 1e-9
          && from.rotation.every((v, i) => Math.abs(v - posed.rotation[i]) < 1e-9)
          && fitChapterField({ ...glassFor(found.seat), placement: from, keepPlacement: true })) {
          found.fit = { ...found.fit, translation: from.translation,
            field: { ...found.fit.field, moveCost: 0, distance: chapterFieldDistance({ ...field, placement: from }) } };
          found.cost = 0;
        }
        plan = refitted(plan, found.fit);
      }
      recordManipulation('chapter-field', { reason: found ? 'chapter-glass' : 'chapter-glass-blocked', ...(found ? {
        seat: found.seat.id, band: found.seat.band, compact: found.seat.compact === true,
        ...(found.seat.statusAside ? { status: 'aside' } : {}),
        ...(found.fit ? { moveCost: Math.round(found.cost * 1e3) / 1e3, distance: Math.round(found.fit.field.distance * 1e3) / 1e3 } : {}) } : {}),
        framed: Math.round(framed * 1e3) / 1e3, maxDistance: Math.round(chapterSizeBound.maxDistance * 1e3) / 1e3,
        steps: meter.positions, tests: meter.tests });
    }
    stage('placement-solved');
    if (motionFrame) recordManipulation('animation-framing', { target, ...plan.motionScale, scale: plan.scale, distance: plan.distance });
    // The plan was solved in the pose before the turn (`frozenTurnDegrees`).
    // A turn still showing is not frozen on top of it: the travel starts from
    // the angle on screen and turns back the short way round.
    const shown = !turn?.turned && !motionFrame && typeof takeTurnForFraming === 'function' ? takeTurnForFraming() : 0;
    const unwind = shown || unturn ? { from: shown, by: ((-unturn - shown) % 360 + 540) % 360 - 180 } : undefined;
    await setInspectionMotion({ paused: true });
    stage('motion-paused');
    focusPivot.placement = JSON.stringify(inspectionState.placement());
    if (focusPivotRequest !== focusOwner || sourceRecord !== focusPivot.source || visibleStage !== focusPivot.subject) return snapshot();
    // A structure too big for the placement floor is framed by
    // lowering the XR scene scale instead, and the plan's translation is solved
    // in that scale. It has to be the live one before the travel starts, or
    // every offset the travel bakes lands in the old room frame. The wearer's
    // pose and the room-locked menu are untouched: `setXrCameraScale`
    // compensates the camera so the reference frame stands still, and
    // `presentation-scene.mjs` re-reads `camera.scale` on its own frame.
    if (plan.usedCameraScale) {
      setXrCameraScale({ cameraScale: plan.cameraScale });
      // The far plane is metres divided by this scale, so it is now wrong.
      lastDepthMinFar = 0; applyImmersiveDepth();
    }
    // The turn rides the SAME easing as the travel, on the same
    // transient the grip uses, so the tier turns, travels and resizes as one
    // move over six-tenths of a second to a second. `bakeGrab` composes
    // `grabRotation` onto the saved rotation exactly as a released grip does,
    // which is why nothing below has to be told the structure turned.
    stage('travel-start');
    await focusTravel({ from, to: plan, radius: sphere.radius, frame: scheduleViewFrame,
      // Cubic easing peaks at three times the average speed. Bound that peak
      // by FRAMING_UNWIND_DEGREES_PER_SECOND so the turn back never whips round.
      durationMs: turn?.turned ? turn.durationMs : ((typeof durationMs === 'number' && durationMs >= 0)
        ? (unwind && durationMs > 0 ? Math.max(durationMs, Math.abs(unwind.by) * 3000 / FRAMING_UNWIND_DEGREES_PER_SECOND) : durationMs) : undefined),
      step: (offset, scale, eased) => {
        if (focusPivotRequest !== focusOwner || sourceRecord !== focusPivot.source || visibleStage !== focusPivot.subject
          || JSON.stringify(inspectionState.placement()) !== focusPivot.placement) return;
        grabOffset = Vec3.create(...offset); grabScale = scale;
        if (turn?.turned) grabRotation = Mat4.fromRotation(Mat4(), turn.angleRadians * eased, Vec3.create(...turn.axis));
        else if (unwind) grabRotation = Mat4.fromRotation(Mat4(), (unwind.from + unwind.by * eased) * Math.PI / 180, Vec3.create(0, 1, 0));
        applyInspectionTransform();
      } });
    stage('travel-completed');
    if (!await bakeGrab({ gesture: 'focus' }, { focusPivot })) return snapshot();
    stage('placement-settled');
    if (glassYields && typeof clearFieldGlass === 'function') await clearFieldGlass(chapterFieldBounds());
    // `angleDegrees` is the angle the target ACTUALLY subtends
    // for the wearer, which is the number a framing is judged by and the one no
    // capture can be measured for without it. `elevation` says whether this was
    // a lesson frame (level) or a one-off focus (lifted).
    recordManipulation('xr-focus', { framing: plan.framing, residues: chosen.length, scale: plan.scale,
      // Elevation is the request; these are the seat after every avoidance
      // pass, in tracked room metres and the level head's lens fractions.
      basis: 'head', eyeRoom: eye, targetRoom: plan.targetRoom, targetLens: plan.targetLens,
      angleDegrees: Math.round(plan.angleDegrees * 10) / 10, elevation: elevationDegrees ?? null,
      // The presentation turn this framing turned back, in degrees.
      ...(unwind ? { turnedBack: Math.round(unwind.by * 10) / 10 } : {}), ...(holdsStill ? { turnHeld: true } : {}),
      // The three numbers that say how big the wearer's view of
      // this actually is. `enclosure` is the framed sphere's radius over its
      // distance AFTER the plate standoff has had its say, `distance` the
      // metres it landed at, and `sceneScale` the XR scene scale it was solved
      // in — the escape above shows up as a scale that differs from the one the
      // frame before it recorded.
      enclosure: Math.round(plan.enclosure * 1000) / 1000,
      distanceMetres: Math.round(plan.distance * 1000) / 1000,
      sceneScale: Number(plan.cameraScale.toPrecision(6)) });
    // The one record that says whether the structure is in
    // front of the plates. Every number is metres from the eye or a share of
    // the lens width, `before` is the same framing without the rule, and
    // `pierced` is the plate geometry the structure would draw over -- which
    // is the pixel overlap the wearer-view captures show, measured.
    // The final field proof supersedes the earlier caption/menu heuristic.
    if (!plan.field) recordStandoff({ framing: plan.framing, plan, plates, captions, eye, plateRange, turn });
    return snapshot();
  }

  async function setCamera(value) {
    assertReady();
    const next = cameraSnapshot(value);
    // An explicit camera write outranks a chapter's turn, and
    // the scene about to be saved names this camera. The next tick pins again.
    lessonMotionHold.release();
    if (inspectionState) return inspectionMutation(() => {
      syncInspectionPayload(); inspectionState.recordPayload({ selectionKeys: [...state.selectionKeys], camera: next }, 'camera'); canvas.camera.setState(next, 0);
    });
    return mutate('camera', () => canvas.camera.setState(next, 0));
  }

  async function applyInspection(value) {
    assertReady();
    const input = detached(value);
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'selectionKeys') || !Object.hasOwn(input, 'camera')) {
      throw failure('invalid_inspection', 'An inspection requires selectionKeys and a complete camera snapshot.');
    }
    const chosen = selectedKeys(input.selectionKeys);
    const nextCamera = cameraSnapshot(input.camera);
    lessonMotionHold.release();
    // Both values are checked before the first change. They apply in one
    // synchronous operation and share one revision and rendered-frame result.
    if (inspectionState) return inspectionMutation(async () => {
      syncInspectionPayload(); inspectionState.recordPayload({ selectionKeys: chosen, camera: nextCamera }, 'apply-inspection');
      lessonSelection = undefined;
      markSelection(chosen); canvas.camera.setState(nextCamera, 0); await rebuildInspectionLabels();
      await rebuildComponentLabels();
    });
    return mutate('inspection', () => { lessonSelection = undefined; markSelection(chosen); canvas.camera.setState(nextCamera, 0); });
  }

  // Both transient capture refusals — a held grip and
  // stale head tracking — share one coded, actionable sentence. The command
  // path maps `capture_refused` to a refusal receipt instead of a generic
  // render failure, so the caller knows to hold still, release and retry.
  // Inline Object.assign keeps this closure free of module helpers: the
  // intent test re-evaluates this exact source with stubs.
  function captureNamedViewIntent() {
    assertReady();
    if (interactionActive()) throw Object.assign(new Error('Hold still and release the grip, then save again.'), { code: 'capture_refused' });
    const source = completeInspectionCapture(), bounds = loadedSphere();
    if (volume || !bounds) throw Error('Named inspection angle requires a molecular structure.');
    const common = { source, center: Array.from(bounds.center), radius: bounds.radius, moleculeTransform: presentationTransform() };
    if (canvas.xr.isPresenting.value) {
      if (!latestRoomPlacementPose || performance.now() - latestHeadSample >= 1500)
        throw Object.assign(new Error('Hold still and release the grip, then save again.'), { code: 'capture_refused' });
      return captureXrNamedViewIntent({ ...common, ...latestRoomPlacementPose, cameraScale: canvas.camera.scale,
        projectionMatrices: latestRoomPlacementPose.labelViews.map(view => Array.from(view.projectionMatrix)) });
    }
    return captureDesktopNamedViewIntent({ ...common, camera: cameraSnapshot(canvas.camera.getSnapshot()) });
  }

  function sceneForNamedView(scene, intent) {
    assertReady();
    const source = completeInspectionCapture();
    validateNamedViewIntent(intent, source);
    validateNamedViewIntent(intent, scene);
    // Restoring in XR never writes a tracked eye or re-seats a physical head.
    if (canvas.xr.isPresenting.value) return detached(scene);
    const bounds = loadedSphere();
    if (volume || !bounds) throw Error('Named inspection angle requires a molecular structure.');
    const currentCamera = canvas.camera.getSnapshot();
    const camera = desktopCameraForNamedView({ intent, source, center: Array.from(bounds.center), radius: bounds.radius,
      moleculeTransform: placementTransform(scene.inspection.placement),
      camera: { ...scene.camera, mode: currentCamera.mode, fov: currentCamera.fov },
      aspect: canvas.camera.viewport.width / canvas.camera.viewport.height });
    return { ...detached(scene), camera };
  }

  function completeInspectionCapture(options) {
    assertReady();
    const scene = liveScene();
    if (scene.modelNumber === null || scene.assemblyId === null) throw failure('unsupported_scene', 'The current structure has no unique source identity.');
    // Emphasis rides inside `inspection` rather than as a
    // seventh scene field, because it is part of how the molecule looks and
    // every reader of a saved scene — the panel, the receipt comparison, the
    // Mol* handoff — already reads that object whole.
    const figure = lessonFigure.definition?.();
    const figureAnimation = lessonFigure.animationContext?.();
    const compose = animation => {
      const capture = { sourceSha256: scene.sourceSha256, modelNumber: scene.modelNumber, assemblyId: scene.assemblyId,
      selectionKeys: [...state.selectionKeys],
      // A chapter's turn is presentation, so a capture taken
      // while it runs reports the camera the scene was saved with. Without
      // this the panel's own heartbeat comparison read every tick as an
      // unsaved edit and the agent's commands were refused for the whole tour.
      camera: cameraSnapshot(lessonMotionHold.presented(desktopPreviewCamera ?? scene.camera, scene)),
      inspection: { ...inspectionSnapshot(), emphasis: savedEmphasis(), ...savedVisibility(),
        ...(typeof lessonSelection !== 'undefined' ? { lessonSelection } : {}),
        ...(figure ? { lessonFigure: figure } : {}),
      ...(typeof measurementLines !== 'undefined' && measurementLines.count() ? {measurementLines:measurementLines.definition()} : {}),
        // Only a clockless chapter needs its own copy; a running clip carries it.
        ...(figureAnimation && !animation ? { lessonFigureAnimation: figureAnimation } : {}),
        ...(animation ? { animation } : {}),
        ...(lessonPlayback ? { lessonPlayback } : {}) } };
      if (options?.omitHistory) { delete capture.inspection.history; delete capture.inspection.savedViews; }
      return capture;
    };
    // Heartbeats need exact serialized equality, not a mutable scene. Avoid
    // copying every animation keyframe twice just to encode and discard it.
    return options?.serialize ? molecularAnimation.serializeCapture(compose)
      : detached(compose(molecularAnimation.capture()));
  }

  /**
   * The painted key AND who asked for it.
   *
   * Provenance used to live only in `emphasisOrigin`, which is page lifetime,
   * and a reload is a new page. The saved scene is restored inside `loadSource`
   * — the hydrate's `built` phase — and the lesson baseline is only installed
   * later, in `placed`, so on every reload `noteRestoredKey` was asked whose
   * key this is while there was no baseline to compare it against. It answered
   * 'command' for the lesson's own starting key, the baseline paint stood down,
   * and the shipped telomerase lesson came back from every reload with none of
   * its ten name plates. The origin travels with the key so that question has
   * an answer before the baseline arrives.
   *
   * 'command' is written as absence, which is exactly what every scene saved
   * before this says and how a reader with no word for provenance must read
   * one. The capture is otherwise unchanged, so the panel's re-capture
   * comparison still sees the same bytes for the same viewer.
   */
  function savedEmphasis() {
    return emphasisOrigin === 'command' ? emphasisState : { ...emphasisState, origin: emphasisOrigin };
  }

  /**
   * The hidden set, and only when something is hidden.
   *
   * "Nothing is hidden" is written as the ABSENT field, which is what every
   * scene saved before this change says and what a reader with no word for
   * visibility must be able to read. It keeps the bytes of an ordinary scene
   * exactly the bytes they were, so every receipt comparison and saved view
   * written before this still matches; the host refuses an explicitly empty one
   * for the same reason, because two spellings of the same picture would be
   * read as a render that did not match the request.
   */
  function savedStyles() {
    return stylesState.length ? { styles: normalizeStyles(stylesState) } : {};
  }

  function styleLayerTargets() {
    return styleLayers.map((layer, index) => ({ repr: layer.representation,
      suffix: `-style-${index}`, data: layer.component.obj.data }));
  }

  /** Budget the actual residue component, before deleting or building geometry. */
  function styleLayerDefinitions(styles = stylesState, appearance = inspectionSnapshot().appearance) {
    return styles.map(style => {
      const keys = selectedKeys(style.selectionKeys);
      const loci = selection.toLoci(keys);
      if (StructureElement.Loci.isEmpty(loci)) return null;
      const data = StructureElement.Loci.toStructure(loci);
      const { selectionKeys: _, ...patch } = style;
      const look = normalizeAppearance(patch, appearance);
      if (!plugin.representation.structure.registry.get(look.representation).isApplicable(data)) {
        // A colour or opacity edit keeps the scene's representation, and where
        // that draws nothing the base draws nothing either. "Color chain A red"
        // after a tour left chain A's waters as a layer of their own under a
        // cartoon, and refusing them failed the whole edit on 4HHB.
        if (patch.representation === undefined) return null;
        throw Error('This representation does not apply to the selected residues.');
      }
      return { keys, loci, look, data };
    }).filter(Boolean);
  }

  function styleLayerPlans(styles = stylesState) {
    const plans = styleLayerDefinitions(styles);
    const geometry = sceneGeometry(plans);
    const offset = companionRecord ? 2 : 1;
    return plans.map((plan, index) => ({ ...plan, geometry: geometry[offset + index] }));
  }

  async function rebuildStyleLayers(plans = styleLayerPlans()) {
    for (const layer of styleLayers) {
      if (plugin.state.data.cells.has(layer.component.ref)) await plugin.build().delete(layer.component.ref).commit();
    }
    styleLayers = [];
    for (const [index, plan] of plans.entries()) {
      const { loci, look, geometry } = plan;
      const query = { label: `Style (${plan.keys.length} residues)`, referencesCurrent: true,
        getSelection: async () => StructureSelection.Singletons(loci.structure, StructureElement.Loci.toStructure(loci)) };
      const component = await plugin.builders.structure.tryCreateComponentFromSelection(structure, query,
        `stereofold-scoped-style-${index}`, { label: query.label, tags: ['stereofold-scoped-style'] });
      if (!component) throw Error('The scoped residue component could not be built.');
      const layer = { component };
      styleLayers.push(layer);
      const quality = xrRepresentationQuality({ presenting: canvas.xr.isPresenting.value, representation: look.representation });
      const material = xrRepresentationMaterial({ presenting: canvas.xr.isPresenting.value, representation: look.representation });
      layer.representation = await plugin.builders.structure.representation.addRepresentation(component, {
        type: look.representation, color: look.color,
        colorParams: look.color === 'uniform' ? { value: Color(colorNumber(look.uniformColor)) }
          : xrColorParams({ color: look.color }),
        typeParams: { alpha: look.opacity, ...(quality ? { quality } : {}), ...(material ? { material } : {}), ...geometry.typeParams,
          ...(canvas.xr.isPresenting.value && ['molecular-surface', 'gaussian-surface'].includes(look.representation)
            ? { smoothColors: { name: 'off', params: {} } } : {}),
          ...xrBallAndStickParams({ representation: look.representation, presenting: canvas.xr.isPresenting.value,
            atoms: plan.data.elementCount, level: geometry.level }) },
      }, { initialState: { isHidden: Boolean(canvas.xr.isPresenting.value) } });
      if (!layer.representation?.obj) throw Error('The scoped representation could not be built.');
      appliedGeometryBudget = geometryBudgetReceipt(geometry) ?? appliedGeometryBudget;
    }
  }

  async function setSceneStyles(value) {
    if (typeof supersedePlacementFit === 'function') await supersedePlacementFit();
    assertReady();
    if (volume) throw Error('A density map has no residues to style.');
    const wanted = normalizeStyles(value);
    styleLayerPlans(wanted); // Admission before any live state or geometry changes.
    const previous = stylesState;
    try {
      return await inspectionMutation(async () => {
        syncInspectionPayload();
        inspectionState.recordPayload(null, 'styles');
        stylesState = wanted;
        appliedGeometryBudget = undefined;
        // A layer can lower the shared detail tier of both structures. Rebuild
        // all participants using the same final scene budget before the receipt.
        await applyInspectionAppearance();
      });
    } catch (error) { stylesState = previous; throw error; }
  }

  function savedVisibility() {
    return visibilityIsEmpty(visibilityState) ? {} : { visibility: normalizeVisibility(visibilityState) };
  }

  function validInspectionCapture(value) {
    const input = detached(value);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 6
      || !Object.hasOwn(input, 'sourceSha256') || !Object.hasOwn(input, 'modelNumber') || !Object.hasOwn(input, 'assemblyId')
      || !Object.hasOwn(input, 'selectionKeys') || !Object.hasOwn(input, 'camera') || !Object.hasOwn(input, 'inspection')) {
      throw failure('invalid_inspection_capture', 'A complete rich inspection capture is required.');
    }
    const scene = liveScene();
    if (input.sourceSha256 !== scene.sourceSha256 || input.modelNumber !== scene.modelNumber || input.assemblyId !== scene.assemblyId) {
      throw failure('inspection_identity_mismatch', 'A rich inspection can only be restored to its exact source, model and assembly.');
    }
    const keys = selectedKeys(input.selectionKeys);
    const camera = cameraSnapshot(input.camera);
    if (!input.inspection?.appearance || !input.inspection?.placement) throw failure('invalid_inspection_capture', 'The rich inspection state is incomplete.');
    if (input.inspection.lessonSelection !== undefined && input.inspection.lessonSelection !== selectionSignature(keys))
      throw failure('invalid_inspection_capture', 'Lesson selection ownership must match the saved selection keys.');
    input.inspection.styles = normalizeStyles(input.inspection.styles);
    for (const style of input.inspection.styles) selectedKeys(style.selectionKeys);
    if (!input.inspection.styles.length) delete input.inspection.styles;
    // Validation happens before the first renderer or state mutation.
    const clean = createInspectionState();
    clean.replace(input.inspection);
    return { keys, camera, inspection: input.inspection };
  }

  async function configureInspection(patch, { signal, preservePlacement = false, sceneRepresentation = false } = {}) {
    if (typeof supersedePlacementFit === 'function') await supersedePlacementFit();
    const check = () => { assertContext(); signal?.throwIfAborted(); };
    check();
    const ownGeneration = signal ? state.generation : undefined;
    let retainedRollback = false;
    assertReady();
    const liveRepresentation = findCurrentStructureRepresentation();
    if (liveRepresentation) representation = asViewerRepresentation(liveRepresentation);
    // A chapter's appearance may ask for per-part name plates
    // with `componentLabels`. That flag is lesson intent, not saved-scene
    // state, so it is read onto the viewer here and stripped before the
    // inspection state validates — its appearance shape is exact and a lesson
    // flag is not part of it. Absent leaves the live value alone, so chapters
    // that say nothing about plates keep whatever the wearer already has.
    const { componentLabels, ...appearancePatch } = patch ?? {};
    const previousFigure = typeof lessonFigure === 'undefined' ? undefined : lessonFigure.definition?.();
    const nextFigure = sceneRepresentation && previousFigure && Object.hasOwn(appearancePatch, 'representation')
      ? withFigureRepresentation(previousFigure, appearancePatch.representation) : previousFigure;
    const figureChanged = JSON.stringify(nextFigure) !== JSON.stringify(previousFigure);
    // Validate before the renderer is touched, then commit history only after
    // mutate has admitted the idle canvas.
    const next = normalizeAppearance(appearancePatch, inspectionSnapshot().appearance);
    if (!volume && Object.hasOwn(appearancePatch, 'representation')) geometryFor(next.representation, structure?.obj?.data, nextFigure);
    // Every chapter of a density lesson comes through here, and
    // this check was the next thing after the swap to reach for a structure that
    // does not exist. A chapter on this tier changes opacity, background,
    // clipping, fog and placement; `applyVolumeAppearance` is what applies it,
    // and the isosurface it rebuilds is not in the structure registry at all.
    if (!volume && !plugin.representation.structure.registry.get(next.representation).isApplicable(structure.obj.data)) {
      throw failure('unsupported_representation', 'This representation has no supported geometry for the loaded structure.');
    }
    // A chapter commonly repeats the same cartoon look while changing only its
    // placement or emphasis. Mol* still rebuilds its representation for that
    // no-op update, and the capture-free Quest run showed that cost at every
    // transition. `componentLabels` is presentation intent rather than part
    // of Appearance, so it must be considered separately: toggling it still
    // settles the live labels, while repeating its existing value is free.
    const appearanceUnchanged = sameAppearance(next, inspectionSnapshot().appearance)
      && (volume || inspectionLayersIntact());
    const labelsBefore = lessonResting.labelsEnabled();
    const labelsChanged = typeof componentLabels === 'boolean' && componentLabels !== labelsBefore;
    // A failed change must not leave its plate flag behind for the recovery
    // redraw, which would then draw the plates the failed command asked for.
    const rollback = async () => {
      lessonResting.setLabelsEnabled(labelsBefore);
      if (figureChanged) await lessonFigure.install(previousFigure);
    };
    if (appearanceUnchanged && !figureChanged) {
      if (labelsChanged) {
        // The label intent changes visible state. Keep it inside the same
        // mutation admission and rendered receipt as every other inspection
        // command: a tour cannot race it while an earlier command is busy.
        return inspectionMutation(async () => {
          lessonResting.setLabelsEnabled(componentLabels);
          await rebuildComponentLabels();
        }, { rollback });
      }
      return snapshot();
    }
    const themeOnly = !volume && !labelsChanged && !figureChanged && colorOnlyAppearanceChange(inspectionSnapshot().appearance, next)
      && inspectionLayersIntact();
    const changesDepth = Object.hasOwn(patch ?? {}, 'clipping') || Object.hasOwn(patch ?? {}, 'fog');
    if (typeof componentLabels === 'boolean') lessonResting.setLabelsEnabled(componentLabels);
    return inspectionMutation(async () => {
      check();
      syncInspectionPayload(); inspectionState.configure(appearancePatch, 'configure');
      if (figureChanged) await lessonFigure.install(nextFigure);
      if (themeOnly) await applyInspectionColorTheme();
      else await applyInspectionAppearance({ signal, depth: changesDepth, check,
        // Canvas colour changes have no new silhouette to fit. In particular,
        // changing a closeup's background must retain its framing.
        preservePlacement: preservePlacement || Object.keys(appearancePatch).every(key => ['background', 'highlightColor'].includes(key)),
        onRetainedRollback: () => { retainedRollback = true; } });
      check();
    }, { rollback, lessonCheckpoint: { labels: labelsBefore },
      recoverRetained: () => signal?.aborted === true && retainedRollback && state.generation === ownGeneration });
  }
  async function applyCompoundInspection(change, { preservePlacement = false, sceneRepresentation = false } = {}) {
    if (typeof supersedePlacementFit === 'function') await supersedePlacementFit();
    assertReady();
    const ops = compoundOps(change);
    const patches = Object.fromEntries(ops.map(op => [op.kind, op.patch]));
    const current = inspectionSnapshot();
    const placementIntent = typeof placementIntentCheckpoint === 'function' ? placementIntentCheckpoint() : undefined;
    const appearance = normalizeAppearance(patches.appearance ?? {}, current.appearance);
    const previousFigure = typeof lessonFigure === 'undefined' ? undefined : lessonFigure.definition?.();
    const nextFigure = sceneRepresentation && previousFigure && Object.hasOwn(patches.appearance ?? {}, 'representation')
      ? withFigureRepresentation(previousFigure, appearance.representation) : previousFigure;
    const figureChanged = JSON.stringify(nextFigure) !== JSON.stringify(previousFigure);
    const placement = normalizePlacement(patches.placement ?? {}, current.placement);
    const keys = selectedKeys(patches.selection?.selectionKeys ?? state.selectionKeys);
    const nextEmphasis = patches.emphasis ? normalizeEmphasisState(patches.emphasis) : emphasisState;
    const nextStyles = patches.styles ? normalizeStyles(patches.styles.styles) : stylesState;
    const nextVisibility = patches.visibility ? normalizeVisibility(patches.visibility) : visibilityState;
    const nextCompanion = patches['companion-structure'] ? foldCompanion(current.companionStructure, patches['companion-structure']) : current.companionStructure;
    if (!volume && !plugin.representation.structure.registry.get(appearance.representation).isApplicable(structure.obj.data)) {
      throw failure('unsupported_representation', 'This representation has no supported geometry for the loaded structure.');
    }
    const plan = !volume && patches.emphasis ? planLessonEmphasis({ ...nextEmphasis,
      contextOpacity: paintedContextOpacity(nextEmphasis.contextOpacity) }, spokenSelectionKeys,
      (selection?.rows ?? []).map(row => row.key)) : undefined;
    const appearanceChanged = figureChanged || !sameAppearance(appearance, current.appearance) || !inspectionLayersIntact()
      || Boolean(patches.styles || patches['companion-structure']);
    const selectionChanged = !selectionLayersUnchanged(keys) || Boolean(patches.selection && typeof lessonSelection !== 'undefined');
    const placementChanged = JSON.stringify(placement) !== JSON.stringify(current.placement);
    if (placementChanged && !preservePlacement && typeof awaitPlacementViews === 'function' && canvas.xr?.isPresenting?.value
      && typeof immersiveSession !== 'undefined' && immersiveSession?.platePoints?.()?.length)
      await awaitPlacementViews();
    const clearedPlacement = placementChanged && !appearanceChanged && !preservePlacement
      ? await clearHeldPlatePlacement(placement, { keepWearer: true, allowOffscreen: true }) : placement;
    let placementAdjusted = clearedPlacement.scale !== placement.scale
      || clearedPlacement.translation.some((value, axis) => value !== placement.translation[axis]);
    const before = completeInspectionCapture();
    const checkpoint = inspectionState.checkpoint();
    const previousEmphasis = emphasisState, previousOrigin = emphasisOrigin;
    const previousStyles = stylesState, previousVisibility = visibilityState;
    const changesDepth = appearanceChanged && (Object.hasOwn(patches.appearance ?? {}, 'clipping')
      || Object.hasOwn(patches.appearance ?? {}, 'fog'));
    inspectionState.beginGroup('agent-compound');
    try {
      const result = await inspectionMutation(async () => {
        syncInspectionPayload();
        if (appearanceChanged) inspectionState.configure(patches.appearance ?? {}, 'configure');
        if (placementChanged) { cancelXrPlacementFollowup(); invalidateGesturePivot(); inspectionState.place(clearedPlacement, 'place'); }
        if (selectionChanged || patches.emphasis || patches.styles || patches.visibility || patches.measurement) inspectionState.recordPayload(null, 'selection');
        stylesState = nextStyles; visibilityState = nextVisibility;
        if (patches['companion-structure']) inspectionState.setCompanion(nextCompanion);
        if (patches.emphasis) { emphasisState = nextEmphasis; emphasisOrigin = 'command'; }
        if (selectionChanged) {
          if (patches.selection) lessonSelection = undefined;
          if (appearanceChanged) state.selectionKeys = [...keys];
          else markSelection(keys);
        }
        if (patches['companion-structure']) await restoreCompanion(nextCompanion);
        if (figureChanged) await lessonFigure.install(nextFigure);
        // Build the final geometry before painting the final key. The ordinary
        // appearance path still preserves its existing emphasis automatically.
        if (appearanceChanged) await applyInspectionAppearance({ labels: false, componentLabels: false,
          emphasis: !patches.emphasis, explicitPlacement: Object.hasOwn(patches, 'placement'), preservePlacement });
        if (plan) {
          recordEmphasisResolution(plan);
          await paintEmphasisLayers(plan, { transparency: false });
          await paintVisibilityLayers(plan);
        } else if (!appearanceChanged && selectionChanged) await paintSelectionOverlay();
        else if (!appearanceChanged && (stylesState.length || patches.visibility)) await paintVisibilityLayers();
        if (patches.visibility) markSelection(keys);
        const fittedPlacement = inspectionSnapshot().placement;
        placementAdjusted ||= fittedPlacement.scale !== placement.scale
          || fittedPlacement.translation.some((value, axis) => value !== placement.translation[axis]);
        applyInspectionTransform();
        if (appearanceChanged || selectionChanged || placementChanged || patches.visibility) await rebuildInspectionLabels();
        await rebuildComponentLabels(placementChanged ? 'emphasis+placement' : undefined);
        if (patches.measurement) await measurementLines.install(patches.measurement.lines);
        inspectionState.setPayload(inspectionPayload());
        inspectionState.endGroup();
      }, { operationKind: 'compound', changedLayers: ops.map(op => op.kind), ownsRecovery: true, afterCommit: changesDepth ? () => {
        // Depth percentages need the final committed bounds, before the sole
        // frame wait, just as they do in the ordinary appearance path.
        canvas.setProps({ cameraClipping: { radius: appearance.clipping, far: true },
          cameraFog: appearance.fog ? { name: 'on', params: { intensity: appearance.fog } } : { name: 'off', params: {} } });
        if (canvas.xr.isPresenting.value) { lastDepthMinFar = 0; applyImmersiveDepth(); }
      } : undefined });
      if (patches.emphasis) lessonKey.remember(nextEmphasis);
      // An explicit agent pose is the user's room intent, like a hand placement.
      // Keep it only after the compound rendered; a refused edit owns no hold.
      if (placementChanged && canvas.xr?.isPresenting?.value && typeof settlePlacementIntent === 'function')
        settlePlacementIntent(placementIntent, { agent: !preservePlacement, history: preservePlacement });
      if (placementChanged && canvas.xr?.isPresenting?.value && !preservePlacement)
        void Promise.resolve(immersiveSession?.toolbarAction?.({ kind: 'recenter-menu', reason: 'placement' })).catch(() => {});
      settledSelectionLayers = inspectionLayersIntact() ? selectionLayerStamp() : undefined;
      if (placementAdjusted) recordManipulation('outcome', { status: 'adjusted', action: 'compound',
        reason: 'Moved or resized the structure to clear the held menu and reply plate.' });
      return result;
    } catch (error) {
      inspectionState.endGroup();
      emphasisState = previousEmphasis; emphasisOrigin = previousOrigin;
      stylesState = previousStyles; visibilityState = previousVisibility;
      inspectionState.restoreCheckpoint(checkpoint);
      // A failed renderer must redraw the captured scene before the queue can
      // accept another command. A lost context retains its recovery refusal.
      if (state.status === 'error' && !canvas.webgl.isContextLost) {
        state.status = 'ready'; state.error = null;
        try { await restoreInspection(before, { preserveCamera: true, restorePlacement: true, preservePreviewCamera: true }); }
        finally { inspectionState.restoreCheckpoint(checkpoint); }
      }
      throw error;
    } finally { inspectionState.endGroup(); }
  }
  // Constant-size fit evidence for host receipts, in metres in the tracked head basis.
  let lastPlacementFitEvidence;
  function placementFitEvidence() { return lastPlacementFitEvidence; }
  function capturePlacementFitEvidence(pose, sphere) {
    if (!canvas.xr?.isPresenting?.value || !pose || !sphere) return undefined;
    const headFromScene = Mat4.mul(Mat4(), Mat4.invert(Mat4(), pose.headInRoom), Mat4.invert(Mat4(), pose.renderFromRoom));
    return { metersPerRadius: sphere.radius * canvas.camera.scale,
      centerMeters: Array.from(sphere.center, value => value * canvas.camera.scale),
      headFromScene: Array.from(headFromScene) };
  }
  /**
   * Whether an authored chapter translation stands in front of the wearer:
   * within 45° of where the head points, measured across the floor, and
   * inside a room. Without a fresh head reading nothing faces the wearer.
   */
  function authoredSeatFaces(translation) {
    const pose = latestRoomPlacementPose, sphere = loadedSphere();
    if (!pose || !sphere || performance.now() - latestHeadSample >= 1500) return false;
    const render = Vec3.create(...Array.from(sphere.center, (value, axis) =>
      (value + translation[axis] * sphere.radius) * canvas.camera.scale));
    const room = Vec3.transformMat4(Vec3(), render, Mat4.invert(Mat4(), pose.renderFromRoom));
    const head = pose.headInRoom, toward = [room[0] - head[12], room[2] - head[14]], forward = [-head[8], -head[10]];
    const facing = (toward[0] * forward[0] + toward[1] * forward[1]) / (Math.hypot(...toward) * Math.hypot(...forward));
    return facing >= Math.SQRT1_2 && Math.hypot(room[0] - head[12], room[1] - head[13], room[2] - head[14]) <= XR_ROOM_MAX_METRES;
  }

  /**
   * The glass yields to a field that stayed at its seat: the drawn menu moves
   * to a seat that clears the field, or hides (B/Y brings it back) outside a
   * lesson. The molecule stays where it is.
   */
  async function clearFieldGlass(bounds) {
    const pose = latestRoomPlacementPose, sphere = loadedSphere();
    const session = typeof immersiveSession === 'undefined' ? undefined : immersiveSession;
    const points = session?.platePoints?.() ?? [];
    if (!bounds || !pose?.labelViews?.length || !sphere || !points.length) return;
    const options = { placement: inspectionSnapshot().placement, bounds, center: sphere.center, radius: sphere.radius,
      cameraScale: canvas.camera.scale, ...pose, views: pose.labelViews, keepPlacement: true, allowOffscreen: true, exact: true };
    if (fitChapterField({ ...options, menuPoints: points, menuGlass: session?.glassPlates?.() })) return;
    const seat = (session?.toolbarRelocationCandidates?.(pose) ?? []).find(candidate => candidate.hide
      || fitChapterField({ ...options, menuPoints: candidate.points, menuGlass: candidate.glass, views: candidate.views ?? options.views }));
    if (!seat || !session?.relocateToolbar) return;
    // A newer menu change refuses this seat; the next menu draw checks again.
    // A lesson's glass refuses to hide and stays drawn (`kept`).
    let relocation;
    try { relocation = await session.relocateToolbar(seat); } catch {}
    recordManipulation('chapter-field', { reason: relocation?.kept ? 'menu-kept' : seat.hide ? 'menu-hidden' : 'menu-moved', seat: seat.id,
      bounds: chapterFieldSummary(bounds) });
  }

  function clearHeldPlatePlacement(requested, { hidden, keepWearer = false, keepClearSeat = false, allowOffscreen = false,
    recoverVisible = typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0 && !keepWearer, signal, isCurrent, kind = 'appearance',
    announce = true, menuRetry = false, fitDeadline = now() + 30000 } = {}) {
    const originalRequested = requested;
    const generation = state.generation, source = sourceRecord;
    const checkOwner = () => {
      if (signal?.aborted || isCurrent?.() === false || state.generation !== generation || sourceRecord !== source)
        throw Object.assign(Error('The placement check was superseded.'), { code: 'FIT_CANCELLED' });
    };
    checkOwner();
    const pose = typeof latestRoomPlacementPose === 'undefined' ? null : latestRoomPlacementPose;
    if (!canvas.xr?.isPresenting?.value) return requested;
    // Publishing progress starts an asynchronous plate rebuild. Measure after
    // dispatching it; one menu-only retry below can measure its drawn result.
    // Do not dispatch another caption rebuild during that retry.
    if (announce && kind !== 'appearance-recovery' && !menuRetry)
      try { talkCaption?.set({ progress: 'Checking the structure against the menu…' }); } catch {}
    const clearUnownedProgress = () => {
      // Early completion/refusal never creates a worker. Clear its caption
      // only when no other pending fit still owns the shared progress line.
      if (announce && ![...placementViewWaiters].some(check => check.fitKind))
        try { talkCaption?.set({ progress: '' }); } catch {}
    };
    const points = typeof immersiveSession === 'undefined' ? [] : immersiveSession?.platePoints?.() ?? [];
    if (!points.length && !recoverVisible) { clearUnownedProgress(); return requested; }
    if (!(pose?.labelViews?.length === 2 || (pose?.labelViews?.length === 1 && pose?.labelViews[0]?.eye === 'none'))) {
      clearUnownedProgress();
      throw Error('Cannot place the structure until both eye views and the held menu are measurable. Try again in a moment.');
    }
    const sphere = loadedSphere();
    if (!sphere) {
      clearUnownedProgress();
      throw Error('Cannot place the structure until its geometry is measurable. Try again in a moment.');
    }
    const figure = typeof lessonFigure === 'undefined' ? null : lessonFigure.snapshot();
    const fieldBounds = typeof chapterFieldBounds === 'function' ? chapterFieldBounds(requested.scale) : undefined;
    // A field nobody holds may walk to a nearby seat beside the glass. Past the
    // room and stand-off limits it keeps the requested seat, and the worker
    // below moves or hides the glass instead.
    let glassYields = false;
    if (fieldBounds && !keepWearer) {
      try {
        const fitted = fitChapterField({ placement: requested, bounds: fieldBounds, center: sphere.center,
          radius: sphere.radius, cameraScale: canvas.camera.scale, ...pose, views: pose.labelViews, menuPoints: points,
          standoff: (typeof latestSeatStandoffMeters === 'undefined' ? null : latestSeatStandoffMeters) ?? undefined });
        if (fitted.field) requested = normalizePlacement({ translation: fitted.translation, scale: fitted.scale }, requested);
      } catch (error) {
        if (error?.code !== 'FIELD_OUT_OF_REACH') throw error;
        glassYields = true;
        recordManipulation('chapter-field', { reason: 'out-of-reach', fit: kind });
      }
    }
    const geometry = {
      // The figure replaces the nearly transparent source representation as
      // the illustrated subject. Explicit context layers remain visible but
      // do not turn a ligand closeup into a full-protein clearance solve.
      objects: (figure ? [...lessonFigure.placement(),
        ...(inspectionSnapshot().appearance?.opacity > .2
          ? [representation?.obj?.data?.repr, ligandOverlay?.representation?.obj?.data?.repr] : []),
        companionRecord?.representation?.obj?.data?.repr].filter(Boolean)
        : scientificRepresentations(true)).flatMap(repr => repr.renderObjects)
        .filter(object => object.type !== 'text').map(object => (Array.isArray(hidden) ? hidden : [hidden]).some(repr => repr?.renderObjects?.includes(object))
          ? { ...object, state: { ...object.state, visible: true } } : object), fromPlacement: presentationTransform(),
      toPlacement: placementTransform(requested), views: pose.labelViews };
    if (fieldBounds) geometry.objects.push(framingEnvelopeObject(fieldBounds, presentationTransform()));
    // A lesson can restore its intentionally invisible source template before
    // installing the opening figure. Zero alpha has no silhouette to clear;
    // it is different from visible geometry whose buffers are not measurable.
    if (geometry.objects.length && geometry.objects.every(object => object.values?.alpha?.ref?.value === 0)) {
      clearUnownedProgress();
      return originalRequested;
    }
    // A wearer-owned room pose is intentional even when they are looking
    // elsewhere. Appearance/chapter edits prove clearance at that pose without
    // silently dragging it back into the current field of view.
    const intentionalRoomPose = keepWearer && typeof wearerPlacement !== 'undefined'
      && wearerPlacement?.holdsPlacement?.() === true;
    const menuCandidates = recoverVisible || allowOffscreen || intentionalRoomPose || glassYields
      ? immersiveSession?.toolbarRelocationCandidates?.(pose) ?? [] : [];
    const options = { seat: requested, fit: true, restoreSaved: keepWearer, keepClearSeat, recoverVisible,
      preferMenuRelocation: typeof chapterInteractionDepth !== 'undefined' && chapterInteractionDepth > 0 && !keepWearer,
      allowOffscreen: allowOffscreen || intentionalRoomPose || (glassYields && !recoverVisible), points,
      menuCandidates: menuCandidates.map(({ id, points, views, hide }) => ({ id, points, hide, ...(views ? { views } : {}) })),
      headInRoom: pose.headInRoom, renderFromRoom: pose.renderFromRoom,
      cameraScale: canvas.camera.scale, center: sphere.center, radius: sphere.radius };
    const accept = fitted => {
      if (!fitted) throw Error('This appearance cannot clear the menu in both eyes. Move the structure or press Reset, then try again.');
      if (keepWearer && (JSON.stringify(fitted.translation) !== JSON.stringify(originalRequested.translation)
        || fitted.scale !== originalRequested.scale))
        throw Error('This appearance would cover the menu at your placement. Move the structure or press Reset, then try again.');
      if (typeof capturePlacementFitEvidence === 'function') {
        // The production solver already proves clearance against both eyes
        // and the held glass. The host's coarse receipt consistency envelope
        // is not a second geometry proof and must not veto that result here.
        // Staleness and wearer ownership are checked before accepting it.
        lastPlacementFitEvidence = capturePlacementFitEvidence(pose, sphere);
      }
      return fitted.scale !== requested.scale || fitted.translation.some((value, axis) => value !== requested.translation[axis])
        ? normalizePlacement({ translation: fitted.translation, scale: fitted.scale }, requested)
        : requested;
    };
    const session = canvas.webgl.xr?.session, menu = JSON.stringify(points);
    const initialPlacement = JSON.stringify(inspectionSnapshot().placement);
    const initialTransform = JSON.stringify(presentationTransform());
    const cameraScale = canvas.camera.scale;
    const wearerAtStart = wearerPlacement?.holdsPlacement();
    const proof = kind === 'retained-pose' ? {} : undefined;
    const checked = fitAppearanceInWorker({ ...options, geometry }, { waiters: placementViewWaiters, signal, kind,
      timeoutMs: Math.max(1, fitDeadline - now()),
      isPresenting: () => canvas.xr.isPresenting.value }).then(async fitted => {
      checkOwner();
      const changed = { session: !canvas.xr.isPresenting.value || canvas.webgl.xr?.session !== session };
      if (!changed.session) Object.assign(changed, {
        menu: JSON.stringify(immersiveSession?.platePoints?.() ?? []) !== menu,
        placement: JSON.stringify(inspectionSnapshot().placement) !== initialPlacement,
        transform: JSON.stringify(presentationTransform()) !== initialTransform,
        cameraScale: canvas.camera.scale !== cameraScale,
        wearer: !keepWearer && wearerPlacement?.holdsPlacement() !== wearerAtStart });
      if (Object.values(changed).some(Boolean)) {
        // Our progress/status plate can finish rebuilding after dispatch. Never
        // accept the old clearance proof: retry once against fresh drawn glass,
        // only while every non-menu owner remains unchanged. Both workers share
        // the original 30-second deadline. Recovery has its own bounded proof.
        if ((kind === 'appearance' || kind === 'appearance-recovery') && changed.menu && !menuRetry && now() < fitDeadline
          && !canvas.webgl.isContextLost && state.status !== 'disposed'
          && Object.entries(changed).every(([key, value]) => key === 'menu' || !value)) {
          recordManipulation('appearance-fit', { outcome: 'retry-menu', kind, changed });
          return clearHeldPlatePlacement(originalRequested, { hidden, keepWearer, keepClearSeat, allowOffscreen, recoverVisible,
            signal, isCurrent, kind, announce, menuRetry: true, fitDeadline });
        }
        recordManipulation('appearance-fit', { outcome: 'stale', kind, changed });
        throw Object.assign(Error('The menu, placement or session changed while fitting. Kept the previous appearance.'), { code: 'FIT_STALE' });
      }
      const accepted = accept(fitted);
      if (fitted.menuRelocation !== undefined) {
        const candidate = menuCandidates.find(value => value.id === fitted.menuRelocation);
        if (!candidate || !immersiveSession?.relocateToolbar) throw Error('The menu could not apply its checked seat. Kept the previous placement.');
        const relocation = await immersiveSession.relocateToolbar({ ...candidate, recovery: fitted.menuRecovery === true });
        if (signal?.aborted || isCurrent?.() === false || state.generation !== generation || sourceRecord !== source
          || !canvas.xr.isPresenting.value || canvas.webgl.xr?.session !== session
          || JSON.stringify(inspectionSnapshot().placement) !== initialPlacement
          || JSON.stringify(presentationTransform()) !== initialTransform || canvas.camera.scale !== cameraScale) {
          await relocation?.rollback?.();
          throw Object.assign(Error('The placement or session changed while moving the menu. Kept the previous appearance.'), { code: 'FIT_STALE' });
        }
      }
      if (announce && ![...placementViewWaiters].some(check => check.fitKind))
        try { talkCaption?.set({ progress: '' }); } catch {}
      return accepted;
    }).catch(async error => {
      // A superseded owner cannot retry, publish refusal captions or touch the
      // new gesture's clearance proof. Real failures retain the recovery path.
      checkOwner();
      // A retained check must eventually prove the current pose or leave a
      // visible recovery instruction. Wait for the newer same-kind owner so
      // retries cannot cancel each other in a loop. Session teardown never retries.
      if (kind === 'retained-pose' && (error.code === 'FIT_CANCELLED' || error.code === 'FIT_STALE')
        && canvas.xr.isPresenting.value && state.status !== 'disposed' && !signal?.aborted) {
        const newer = latestRetainedProof !== proof ? latestRetainedProof : undefined;
        if (newer) {
          const outcome = await newer.settled;
          checkOwner();
          if (canvas.xr.isPresenting.value && state.status !== 'disposed'
            && JSON.stringify(inspectionSnapshot().placement) === outcome.pose) {
            if (outcome.error) error = outcome.error;
            else return outcome.value;
          } else if (canvas.xr.isPresenting.value && state.status !== 'disposed') {
            return clearHeldPlatePlacement(inspectionSnapshot().placement, { hidden, keepWearer: true, signal, isCurrent, kind, announce });
          }
        } else if (canvas.xr.isPresenting.value && state.status !== 'disposed') {
          return clearHeldPlatePlacement(inspectionSnapshot().placement, { hidden, keepWearer: true, signal, isCurrent, kind, announce });
        }
      }
      if (canvas.xr.isPresenting.value) {
        if (kind === 'appearance-recovery') {
          const reason = String(error?.message ?? error).replace(/\s*Kept the previous appearance\.?$/u, '');
          const nextStep = canvas.webgl.isContextLost
            ? ' The structure remains hidden until the graphics context recovers.'
            : ' The structure remains hidden. Press Reset or Fit to show it.';
          const recoveryError = Object.assign(new Error(`${reason}${nextStep}`), error);
          recoveryError.message = `${reason}${nextStep}`;
          error = recoveryError;
        }
        if (announce) try { talkCaption?.set({ progress: '', outcome: error.message
          + (kind === 'retained-pose' && typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden
            ? ' Press Reset or Fit to show the structure.' : ''), holdMs: 6000 }); } catch {}
        if (kind === 'appearance' || kind === 'retained-pose') error.fitRefusal = true;
      } else {
        // XR teardown has already returned the retained scene to the desktop.
        if (announce) try { talkCaption?.set({ progress: '', outcome: '' }); } catch {}
      }
      throw error;
    });
    if (proof) {
      proof.settled = checked.then(value => ({ value, pose: JSON.stringify(inspectionSnapshot().placement) }),
        error => ({ error, pose: JSON.stringify(inspectionSnapshot().placement) }));
      latestRetainedProof = proof;
    }
    return checked;
  }

  async function placeInspection(patch, action = 'place', { wearer = false, preservePlacement = false } = {}) {
    if (typeof supersedePlacementFit === 'function') await supersedePlacementFit();
    assertReady();
    normalizePlacement(patch, inspectionSnapshot().placement);
    if (action === 'tour-placement' && wearerPlacement.holdsPlacement()) return snapshot();
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    const placementIntent = typeof placementIntentCheckpoint === 'function' ? placementIntentCheckpoint() : undefined;
    let before, placementAdjusted = false;
    const result = await inspectionMutation(async () => {
      syncInspectionPayload();
      before = inspectionSnapshot().placement;
      // Nobody holds the molecule here (a hold returned above), so the
      // chapter's authored seat applies, as on the desktop: [0, 0, 0] stands
      // at reading distance ahead of where the wearer entered. A seat that no
      // longer faces the wearer, after a Reset facing elsewhere, keeps the
      // current centre through the size and rotation change.
      if (action === 'tour-placement' && canvas.xr?.isPresenting?.value && (typeof authoredSeatFaces !== 'function'
        || !authoredSeatFaces(normalizePlacement(patch, before).translation)))
        patch = { ...patch, translation: before.translation };
      const requested = normalizePlacement(patch, before);
      if (!wearer && !preservePlacement && action !== 'entry-seat' && typeof awaitPlacementViews === 'function'
        && canvas.xr?.isPresenting?.value && typeof immersiveSession !== 'undefined'
        && immersiveSession?.platePoints?.()?.length) await awaitPlacementViews();
      // Entry already passed the stereo solver against the upcoming toolbar.
      // The panel may not have drawn its points yet on the first XR frame.
      const explicitRoomPlacement = action === 'place';
      const cleared = preservePlacement ? requested : wearer || explicitRoomPlacement ? await clearHeldPlatePlacement(requested, {
        keepWearer: true, allowOffscreen: true, kind: 'wearer-placement',
      }) : action === 'entry-seat' ? requested : await Promise.resolve().then(() => clearHeldPlatePlacement(requested, {
        // A figure chapter may deliberately frame a ligand within ghosted
        // context. Keep that requested pose if the actual silhouette clears
        // both eyes; collisions still take the ordinary fitting path.
        // Outside XR the check returns synchronously; keep one rejection path.
        keepClearSeat: typeof lessonFigure !== 'undefined' && Boolean(lessonFigure.snapshot()),
        recoverVisible: action === 'tour-placement',
      })).catch(error => {
        if (action === 'tour-placement' && wearerPlacement.holdsPlacement()
          && ['FIT_STALE', 'FIT_CANCELLED'].includes(error.code)) return requested;
        throw error;
      });
      if (action === 'tour-placement' && wearerPlacement.holdsPlacement()) return;
      // A refused solve must leave the currently visible scene intact.
      if (typeof hideRetainedPose === 'function' && canvas.xr?.isPresenting?.value) hideRetainedPose();
      placementAdjusted = cleared.scale !== requested.scale
        || cleared.translation.some((value, axis) => value !== requested.translation[axis]);
      patch = cleared;
      inspectionState.place(patch, action);
      if (action === 'place' && !preservePlacement && !canvas.xr?.isPresenting?.value
        && typeof takeWearerPlacement === 'function') takeWearerPlacement('desktop-placement');
      applyInspectionTransform();
      if (typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden) {
        showRetainedPose();
      }
    }, action === 'entry-seat' ? { mutationOrigin: 'xr-entry' } : undefined);
    // Accept the whole requested pose or refuse its menu collision. Later
    // appearance edits must not fit this intentional pose back into the gaze.
    if (canvas.xr?.isPresenting?.value && typeof settlePlacementIntent === 'function')
      settlePlacementIntent(placementIntent, { agent: !wearer && !preservePlacement && action === 'place', history: preservePlacement });
    if (placementAdjusted) recordManipulation('outcome', { status: 'adjusted', action,
      reason: 'Moved or resized the structure to clear the held menu and reply plate.' });
    // Focus framing and tour placement share one settled solve.
    // Placement changes the silhouette even when names and loci are the
    // same, and billboard glyphs do not ride aTransform, so a scale leaves
    // their sizing stale. The mutation waits for the rendered placement;
    // re-solve ONCE after it instead of repainting the old offsets or waiting
    // for a later menu press. The same numbers, not the same object, say
    // nothing changed: a clamped or repeated action asks for nothing, and a
    // held grab never comes through here. The label owner serializes and
    // coalesces requests; there is no motion-frame solve.
    const after = inspectionSnapshot().placement;
    const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b)
      && a.length === b.length && a.every((value, i) => value === b[i]));
    if (!['scale', 'translation', 'rotation'].every(key => same(before[key], after[key]))) {
      const relayout = async () => {
        if (componentLabels.active()) await componentLabels.relayout('placement');
      };
      // Hold menu callbacks until the final glass is drawn. Consume its delayed
      // notification in this transaction so placement and reseating solve once.
      if (canvas.xr?.isPresenting?.value && !wearer && !preservePlacement && action === 'place' && immersiveSession?.toolbarAction) {
        await componentLabels.transaction(async () => {
          await Promise.resolve(immersiveSession.toolbarAction({ kind: 'recenter-menu', reason: 'placement' })).catch(() => {});
          immersiveSession?.flushMenuLayout?.();
          await relayout();
        }).catch(error => console.error(error));
      } else await relayout().catch(error => console.error(error));
    }
    return result;
  }
  async function fitInspection() {
    assertReady();
    if (canvas.xr?.isPresenting?.value)
      return focusSelection({ wholeStructure: true, liftEmphasis: false });
    await inspectionMutation(() => {
      syncInspectionPayload(); inspectionState.recordPayload(null, 'fit');
      if (typeof releaseWearerPlacement === 'function') releaseWearerPlacement('fit');
      const envelope = molecularAnimation.envelope();
      if (envelope) plugin.managers.camera.focusSphere(transformSphere(envelope, presentationTransform()),
        {durationMs:0, extraRadius:0, minRadius:0});
      else {
        // Text culling spheres grow with CSS-pixel label sizing. Fitting that
        // aggregate can progressively shrink the molecule on repeated Fit.
        // Committed molecular bounds already include placement transforms and
        // the comparison; density keeps its existing isosurface reset path.
        const sphere = volume ? undefined : molecularBounds(true, true);
        if (sphere?.radius > 0 && Number.isFinite(sphere.radius) && sphere.center.every(Number.isFinite))
          plugin.managers.camera.focusSphere(sphere, {durationMs:0, extraRadius:0, minRadius:0});
        else canvas.requestCameraReset({ durationMs: 0 });
      }
    });
    // requestCameraReset settles on the rendered frame, so record the camera
    // after mutate's frame admission rather than the pre-reset camera.
    inspectionState.setPayload(inspectionPayload());
    return snapshot();
  }
  async function resetOrientation() {
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    // In XR this is the same reset as the compact row and controller hold:
    // move the structure and menu, never rotate the tracked room's camera.
    if (canvas.xr.isPresenting.value) return runFaceAction('recenter-structure');
    assertReady();
    return inspectionMutation(() => {
      syncInspectionPayload(); inspectionState.recordPayload(null, 'reset-orientation');
      releaseWearerPlacement('reset-orientation');
      const camera = canvas.camera.getSnapshot();
      const reference = orientationReference ?? cameraSnapshot(camera);
      const referenceDirection = Vec3.sub(Vec3(), reference.position, reference.target);
      const distance = Vec3.magnitude(Vec3.sub(Vec3(), camera.position, camera.target));
      Vec3.normalize(referenceDirection, referenceDirection);
      const position = Vec3.scaleAndAdd(Vec3(), camera.target, referenceDirection, distance);
      canvas.camera.setState({ position: Array.from(position), up: [...reference.up] }, 0);
      inspectionState.setPayload(inspectionPayload());
    });
  }
  /**
   * The agent's route to the wearer's own Reset.
   *
   * It is `runFaceAction('recenter-structure')` and nothing else, so an agent
   * answering "I can't see it" gets the seat, the menu re-seat, the "View
   * reset." caption and the refusal while a hand holds the structure that a
   * held B or Y gets. A flat page has no wearer to seat anything in front of,
   * and a Mac camera move is not what was asked for, so it refuses instead.
   */
  async function recenterInspection() {
    // The workspace queue already orders whole chapters and agent edits.
    // A background menu clearance can still own a render outside that queue.
    // Join its bounded draw before Reset reads or changes the current seat.
    while (typeof activeWork !== 'undefined' && activeWork) await activeWork.done;
    if (!canvas.xr.isPresenting.value) {
      throw failure('not_presenting', 'The headset is not in VR, so there is no room to recentre the structure in. Enter VR first.');
    }
    return runFaceAction('recenter-structure');
  }
  async function orbit(axis, degrees) {
    if (!['x', 'y', 'z'].includes(axis) || !Number.isFinite(degrees)) throw failure('invalid_orbit', 'Orbit needs x, y or z and finite degrees.');
    assertReady();
    const normalized = ((degrees % 360) + 540) % 360 - 180;
    if (!Number.isFinite(normalized)) throw failure('invalid_orbit', 'Orbit degrees cannot be normalized.');
    const current = canvas.camera.getSnapshot();
    const unit = axis === 'x' ? Vec3.create(1, 0, 0) : axis === 'y' ? Vec3.create(0, 1, 0) : Vec3.create(0, 0, 1);
    const rotation = Mat4.fromRotation(Mat4(), normalized * Math.PI / 180, unit);
    // In a headset the whole camera turns rigidly about the drawn molecule's
    // presented centre, as a chapter turn does, so a rotate the agent asks for
    // spins the molecule in place instead of sweeping it around the wearer.
    // The flat page turns about the target, which stays where it is.
    const pivot = canvas.xr.isPresenting.value ? Vec3.create(...headsetTurnPivot()) : undefined;
    const centre = pivot ?? current.target;
    const direction = Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), current.position, centre), rotation);
    const target = pivot ? Array.from(Vec3.add(Vec3(), pivot, Vec3.transformMat4(Vec3(), Vec3.sub(Vec3(), current.target, pivot), rotation)))
      : current.target;
    const up = Vec3.transformDirection(Vec3(), current.up, rotation);
    const next = cameraSnapshot({ ...current, position: Array.from(Vec3.add(Vec3(), centre, direction)), target, up: Array.from(up) });
    const result = await inspectionMutation(() => {
      syncInspectionPayload(); inspectionState.recordPayload(null, 'orbit');
      canvas.camera.setState(next, 0);
      inspectionState.setPayload(inspectionPayload());
    });
    if (typeof frozenTurn !== 'undefined') frozenTurn = undefined;
    return result;
  }
  async function dolly(factor) {
    if (!Number.isFinite(factor) || factor <= 0) throw failure('invalid_dolly', 'Dolly needs a positive finite factor.');
    assertReady();
    const current = canvas.camera.getSnapshot();
    const direction = Vec3.scale(Vec3(), Vec3.sub(Vec3(), current.position, current.target), factor);
    if (Vec3.magnitude(direction) <= 0.001) throw failure('invalid_dolly', 'Dolly would place the camera inside its target.');
    const next = cameraSnapshot({ ...current, ...(canvas.xr.isPresenting.value
      ? lessonCameraMove(current, { kind: 'dolly', factor }, { dollyPivot: headsetTurnPivot() })
      : { position: Array.from(Vec3.add(Vec3(), current.target, direction)) }) });
    return inspectionMutation(() => {
      syncInspectionPayload(); inspectionState.recordPayload(null, 'dolly');
      canvas.camera.setState(next, 0);
      inspectionState.setPayload(inspectionPayload());
    });
  }
  /**
   * The lesson's own chapter turn.
   *
   * A chapter's orbit/dolly ticks used to arrive through `orbit`/`dolly` —
   * admitted inspection mutations. Each tick committed a revision, recorded an
   * undo step and emitted `onMutation`, which the tour player read as the
   * wearer grabbing the structure: on a Quest 2 the wall
   * lesson interrupted its own opening chapter 0.2 s in with
   * `workspace-takeover`, stripped its colour key and sat still until the
   * driver timed out. A
   * chapter's turn is presentation, so it applies here instead: the camera
   * moves, a draw is requested, and nothing else happens — no mutation, no
   * revision, no payload, no undo step, and crucially no `bakeGrab`, no
   * `takeWearerPlacement`, no `wearer-placement` record and no path that
   * reaches the tour as a takeover. A held grip outranks automatic motion,
   * so a tick that lands mid-grab no-ops rather than fighting the hand. The
   * placement hold stays in force: in XR an orbit (including turntable ticks)
   * may turn about the drawn centre while preserving the held seat and size;
   * a dolly still yields. Desktop keeps its existing hold behavior.
   * Molecular body animation has its own independent clock.
   */
  async function applyLessonMotion(move) {
    assertReady();
    const norm = normalizeLessonMotion(move);
    if (!norm) throw failure('invalid_lesson_motion', 'A lesson motion needs an orbit (axis x, y or z, finite degrees) or a positive dolly factor.');
    if ((typeof wearerPlacement !== 'undefined' && wearerPlacement.holdsPlacement()
        && !(canvas.xr.isPresenting.value && norm.kind === 'orbit'))
      || !lessonMotionApplies({ ready: true, interactionActive: interactionActive(), contextLost: canvas.webgl.isContextLost })) {
      return { ...snapshot(), lessonMotionApplied: false };
    }
    const current = canvas.camera.getSnapshot();
    // Pin the saved camera before the first tick moves it.
    const scene = liveScene();
    lessonMotionHold.hold(cameraSnapshot(scene.camera), scene);
    const pivot = canvas.xr.isPresenting.value ? headsetTurnPivot() : undefined;
    const next = lessonCameraMove({ position: current.position, target: current.target, up: current.up }, norm,
      { pivot, ...(norm.kind === 'dolly' && pivot ? { dollyPivot: pivot } : {}) });
    canvas.camera.setState(cameraSnapshot({ ...current, position: next.position, target: next.target, up: next.up }), 0);
    canvas.requestDraw();
    return { ...snapshot(), lessonMotionApplied: true };
  }
  /**
   * The render-space point a headset turn pivots about: a chapter's turn and
   * the agent's or toolbar's `orbit` alike.
   *
   * In a headset `camera.view` maps render space into the room, so an orbit
   * about `camera.target` turns the room about the structure's model centre.
   * The entry seat and the wearer's own moves translate the presented molecule
   * away from that point, and the turn then carried it on a circle around the
   * wearer: hemoglobin's "Slow orbit" slid sideways and ended 0.8 m from the
   * eyes. The drawn molecule's centre, `drawnCenter()` through
   * `presentationTransform()`, keeps its room position through the turn, so
   * the molecule turns in place wherever the wearer or the seat put it. The
   * flat page has no room and keeps its orbit about the target.
   */
  function headsetTurnPivot() {
    return Array.from(Vec3.transformMat4(Vec3(), drawnCenter(), presentationTransform()));
  }
  /**
   * The model-space centre of what is on screen now.
   *
   * `pivotCenter` follows the stage alone. The agent or the wearer can also
   * hide a chain or a class, or show only the selection, and an animated
   * chapter moves and hides whole bodies, so the stage centre can be an empty
   * point well away from anything drawn. A turn about it swings the part that
   * is left around that point: hide chain B from hemoglobin's alpha-beta dimer
   * mid-turn, and chain A circled the dimer's empty middle instead of turning
   * in place. This is the centre of the rows still drawn instead, with each
   * animated body at its current pose and a body its track hides now left out.
   *
   * A tick neither scans atoms nor rebuilds anything. The rows are measured
   * once per change of rows, stage, hidden set, styles, opacity or shown selection
   * (`createDrawnSubsetCache`); an animated subset is measured once per body
   * and then only re-posed (`drawnSphere`). With nothing hidden and nothing
   * animated it is `pivotCenter()` itself.
   */
  function drawnCenter() {
    const animated = Boolean(molecularAnimation.snapshot());
    const { hiddenChains, hiddenClasses, showOnlySelection } = visibilityState;
    const opacity = representation?.obj?.data?.repr?.props?.alpha ?? 1;
    const mask = animated ? undefined : staticMaskKeys();
    const hiddenKeys = mask?.length ? mask : undefined;
    if (!selection || volume || (!animated && !hiddenKeys && !hiddenChains.length && !hiddenClasses.length && !showOnlySelection && !stylesState.length && opacity > 0)) return pivotCenter();
    const subset = cachedDrawnSubset({ rows: selection.rows, visible: visibleStage, visibility: visibilityState, selectionKeys: state.selectionKeys, styles: stylesState, opacity, hiddenKeys });
    if (!subset) return pivotCenter();
    if (animated) {
      if (drawnSubsetLoci?.keys !== subset.keys || drawnSubsetLoci.selection !== selection)
        drawnSubsetLoci = { keys: subset.keys, selection, loci: selection.toLoci([...subset.keys]) };
      const sphere = molecularAnimation.drawnSphere(drawnSubsetLoci.loci);
      if (sphere) return sphere.center;
    }
    return Vec3.create(...subset.center);
  }
  /**
   * The chapter's turn ends, so its last pose becomes saved.
   *
   * The camera equivalent of `bakeGrab`, and deliberately not a mutation: a
   * committed inspection change reaches the tour player's `notifyMutation` as
   * the wearer taking the workspace over, which is the very interruption
   * `applyLessonMotion` exists to avoid. Releasing the pin is enough — the
   * panel's next heartbeat sees the live camera differ from the saved scene
   * and pushes exactly one save for the whole chapter.
   */
  function bakeLessonMotion() {
    const baked = lessonMotionHold.bake();
    if (baked) canvas.requestDraw();
    return baked;
  }
  async function undoInspection() {
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    assertReady();
    if (!inspectionSnapshot().history.undoCount) return snapshot();
    const placementIntent = typeof placementIntentCheckpoint === 'function' ? placementIntentCheckpoint() : undefined;
    const result = await inspectionMutation(async () => {
      syncInspectionPayload(); inspectionState.undo(); restoreInspectionPayload();
      if (typeof lessonFigure !== 'undefined' && (lessonFigure.definition?.() || inspectionState.payload()?.lessonFigure))
        await lessonFigure.install(inspectionState.payload()?.lessonFigure);
      if (typeof measurementLines !== 'undefined') await measurementLines.install(inspectionState.payload()?.measurementLines);
      await restoreCompanion(inspectionSnapshot().companionStructure);
      await applyInspectionAppearance({ preservePlacement: true }); applyInspectionTransform();
    });
    if (typeof settlePlacementIntent === 'function') settlePlacementIntent(placementIntent, { history: true });
    return result;
  }
  async function redoInspection() {
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    assertReady();
    if (!inspectionSnapshot().history.redoCount) return snapshot();
    const placementIntent = typeof placementIntentCheckpoint === 'function' ? placementIntentCheckpoint() : undefined;
    const result = await inspectionMutation(async () => {
      syncInspectionPayload(); inspectionState.redo(); restoreInspectionPayload();
      if (typeof lessonFigure !== 'undefined' && (lessonFigure.definition?.() || inspectionState.payload()?.lessonFigure))
        await lessonFigure.install(inspectionState.payload()?.lessonFigure);
      if (typeof measurementLines !== 'undefined') await measurementLines.install(inspectionState.payload()?.measurementLines);
      await restoreCompanion(inspectionSnapshot().companionStructure);
      await applyInspectionAppearance({ preservePlacement: true }); applyInspectionTransform();
    });
    if (typeof settlePlacementIntent === 'function') settlePlacementIntent(placementIntent, { history: true });
    return result;
  }
  async function saveInspectionView(name) {
    assertReady();
    syncInspectionPayload();
    return inspectionState.save(name, { camera: cameraSnapshot(canvas.camera.getSnapshot()), selectionKeys: [...state.selectionKeys] }).savedView;
  }
  async function restoreInspectionView(id) {
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    assertReady(); const saved = inspectionState.saved(id);
    const selected = selectedKeys(saved.payload?.selectionKeys ?? state.selectionKeys);
    const camera = saved.payload?.camera ? cameraSnapshot(saved.payload.camera) : undefined;
    if (camera) lessonMotionHold.release();
    return inspectionMutation(async () => {
      syncInspectionPayload(); inspectionState.restoreSaved(id);
      stylesState = normalizeStyles(saved.state.payload?.styles);
      visibilityState = normalizeVisibility(saved.state.payload?.visibility);
      if (typeof lessonFigure !== 'undefined' && (lessonFigure.definition?.() || saved.state.payload?.lessonFigure))
        await lessonFigure.install(saved.state.payload?.lessonFigure);
      if (typeof measurementLines !== 'undefined') await measurementLines.install(saved.state.payload?.measurementLines);
      await restoreCompanion(inspectionSnapshot().companionStructure);
      lessonSelection = saved.payload?.lessonSelection ?? saved.state.payload?.lessonSelection;
      markSelection(selected); if (camera) canvas.camera.setState(camera, 0);
      await applyInspectionAppearance(); applyInspectionTransform(); inspectionState.setPayload(inspectionPayload());
    });
  }
  async function hoverInspection(keys) {
    assertReady(); const chosen = selectedKeys(keys); const loci = selection.toLoci(chosen);
    canvas.mark({ repr: representation.obj.data.repr, loci: EveryLoci }, MarkerAction.RemoveHighlight);
    canvas.mark({ repr: representation.obj.data.repr, loci }, MarkerAction.Highlight);
    canvas.setProps({ renderer: { highlightColor: Color(0x58dcc9), selectColor: Color(colorNumber(inspectionSnapshot().appearance.highlightColor)) },
      marking: { highlightEdgeColor: Color(0x58dcc9), selectEdgeColor: Color(colorNumber(inspectionSnapshot().appearance.highlightColor)) } });
    canvas.commit(true);
    await waitForFrame();
    return snapshot();
  }
  // Local navigation rollback owns this token. It never enters a saved scene
  // or host payload, and contains the base render frame, not tracked eye poses.
  function captureXrRecoveryFrame() {
    assertReady();
    if (!canvas.xr.isPresenting.value || !canvas.xr.session) return undefined;
    const scene = liveScene(), token = Object.freeze({});
    xrRecoveryFrames.set(token, { session: canvas.xr.session, contextLossCount: state.contextLossCount,
      sourceSha256: scene.sourceSha256, modelNumber: scene.modelNumber, assemblyId: scene.assemblyId,
      cameraScale: canvas.camera.scale, camera: cameraSnapshot(canvas.camera.getSnapshot()) });
    return token;
  }

  function restoreXrRecoveryFrame(token) {
    const frame = xrRecoveryFrames.get(token);
    if (!frame) throw failure('invalid_xr_recovery_frame', 'The XR recovery frame does not belong to this viewer.');
    // A wearer may leave XR or enter a new session while a chapter fails.
    // The old reference frame must never be replayed into that new session.
    if (!canvas.xr.isPresenting.value || canvas.xr.session !== frame.session) return false;
    assertContext();
    const scene = liveScene();
    if (state.contextLossCount !== frame.contextLossCount || scene.sourceSha256 !== frame.sourceSha256
      || scene.modelNumber !== frame.modelNumber || scene.assemblyId !== frame.assemblyId) {
      throw failure('invalid_xr_recovery_frame', 'The XR recovery frame no longer matches the retained source and context.');
    }
    if (!Number.isFinite(frame.cameraScale) || frame.cameraScale <= 0) {
      throw failure('invalid_xr_recovery_frame', 'The retained XR frame has no finite scene scale.');
    }
    canvas.camera.scale = frame.cameraScale;
    canvas.camera.setState(frame.camera, 0);
    lastDepthMinFar = 0; applyImmersiveDepth();
    return true;
  }

  async function restoreInspection(value, { preserveCamera = false, preservePlacement = false,
    restorePlacement = false, preservePreviewCamera = false, xrRecoveryFrame } = {}) {
    assertReady(); const next = validInspectionCapture(value);
    // The workspace has already admitted this peer update on its serialized
    // queue. Recheck the current capture here, then acknowledge status-only
    // changes without rebuilding molecular geometry or labels. Chapter,
    // baseline, visual and explicit recovery changes use the full restore.
    if (lessonPlayback && next.inspection.lessonPlayback && canRestoreLessonPlaybackMetadata(
      completeInspectionCapture(), value, { preservePlacement, restorePlacement, preservePreviewCamera, xrRecoveryFrame })) {
      if (await molecularAnimation.restore(next.inspection.animation)) await waitForFrame();
      lessonPlayback = detached(next.inspection.lessonPlayback);
      return snapshot();
    }
    // A cached tour scene carries the placement its own framing
    // baked, from a head pose the wearer no longer has. Replaying it over a
    // structure the wearer has since moved is the teleport behind "why does it
    // keep changing the position", so once they have placed it themselves the
    // live placement survives every restore until they ask for the seat back.
    // A deliberate named-view restore may restore object placement. Passive
    // shared updates and tour chapters still respect the wearer's placement.
    const chapterPlacement = !restorePlacement && preserveCamera && Boolean(next.inspection.lessonPlayback);
    if (!restorePlacement && wearerPlacement.holdsPlacement()) preserveCamera = true;
    const heldPlacement = !restorePlacement && wearerPlacement.holdsPlacement();
    if (heldPlacement && !preservePlacement) recordManipulation('wearer-placement', { event: 'restore-held', ...wearerPlacement.state() });
    // Peer and cached chapters carry placement in another view/room. Keep
    // this room's anchor; local authored framing uses the current head pose.
    const placement = preservePlacement || heldPlacement || chapterPlacement ? inspectionSnapshot().placement : undefined;
    // What the saved scene had hidden, believed BEFORE the
    // appearance rebuild below, for the same reason as the emphasis below: the
    // rebuild repaints whatever this viewer thinks is hidden, so believing the
    // restored set first makes the restore one paint instead of two and the
    // wearer never sees the previous scene's chains flash back on. A capture
    // with no visibility field has nothing hidden, which is what every scene
    // saved before this change says and what a restore of one must mean.
    const restoredVisibility = normalizeVisibility(next.inspection.visibility);
    normalizeStyles(next.inspection.styles); // Validate before recording the old scene.
    // Both are validated before the emphasis below changes, so a refusal
    // here leaves nothing to roll back.
    // A restore used to repaint the representation and
    // leave whatever colour key happened to be live on top of it, so a scene
    // reached a second time came back wearing another chapter's emphasis. A
    // capture that names its emphasis now restores it; one saved before this
    // existed names none and the layers are left exactly as they were, which is
    // what every caller written before this expected.
    const restoredEmphasis = next.inspection.emphasis;
    let rollback, lessonCheckpoint;
    // Set before the appearance rebuild below rather than painted after it: the
    // rebuild repaints whatever key this viewer believes it is wearing, so
    // believing the restored one first makes the restore one repaint instead of
    // two — the old chapter's colours are never drawn at all.
    if (restoredEmphasis) {
      // A failed restore puts these back before its recovery redraw, and the
      // lesson key is remembered only once the restore has drawn.
      const previousEmphasis = emphasisState, previousOrigin = emphasisOrigin, labelsBefore = lessonResting.labelsEnabled();
      lessonCheckpoint = { emphasis: detached(previousEmphasis), origin: previousOrigin, labels: labelsBefore };
      rollback = () => { emphasisState = previousEmphasis; emphasisOrigin = previousOrigin; lessonResting.setLabelsEnabled(labelsBefore); };
      emphasisState = normalizeEmphasisState(restoredEmphasis);
      // Reload restores the scene before installing its resting baseline, so
      // use the saved origin as well as the normalized key. This also restores
      // baseline labels when Done returns to the starting view.
      const restoredOrigin = lessonResting.noteRestoredKey(emphasisState, restoredEmphasis.origin);
      // A validated saved lesson cursor restores its chapter ownership too. Converting
      // this to 'resting' made a following panel differ from the saved scene,
      // forcing a geometry restore for every later status-only peer update.
      // Plain scenes and Done's baseline retain the resting-state decision.
      emphasisOrigin = next.inspection.lessonPlayback && restoredEmphasis.origin === 'lesson'
        ? 'lesson' : restoredOrigin ?? emphasisOrigin;
    }
    // A restored scene names the camera the panel will save,
    // so a chapter's pin cannot outlive it. The next tick pins from here.
    lessonMotionHold.release();
    const previousFigure = lessonFigure.definition?.(), previousPlayback = lessonPlayback;
    const previousSelectionOwner = typeof lessonSelection === 'undefined' ? undefined : lessonSelection;
    const previousMeasurements=typeof measurementLines === 'undefined' ? [] : measurementLines.definition();
    const previousAnimation = molecularAnimation.checkpoint();
    const previousFigureAnimation = lessonFigure.animationContext?.();
    // A saved-camera restore releases the temporary flat preview before its
    // appearance draw. Recovery must retain both the displayed fit and the
    // original scientific camera, just as a failed source replacement does.
    const desktopPreviewCheckpoint = !preserveCamera && typeof desktopPreviewCamera !== 'undefined' && desktopPreviewCamera ? {
      camera: detached(desktopPreviewCamera), limit: detached(desktopPreviewMaxDistance),
      maxDistance: canvas.props?.trackball?.maxDistance,
      session: currentXrSession(), entry: typeof roomEntry === 'undefined' ? undefined : roomEntry,
    } : undefined;
    const rollbackEmphasis = rollback;
    rollback = async () => {
      rollbackEmphasis?.(); lessonPlayback = previousPlayback; lessonSelection = previousSelectionOwner;
      if (typeof measurementLines !== 'undefined') await measurementLines.install(previousMeasurements);
      // A replacement animation must stop posing before the previous figure
      // is staged against the scene; the restore below reinstalls the old one.
      if (molecularAnimation.supersededBy(previousAnimation)) molecularAnimation.halt();
      try {
        await molecularAnimation.settled();
        await lessonFigure.install(previousFigure, { animation: previousFigureAnimation });
        await molecularAnimation.restore(previousAnimation, true);
      } finally { molecularAnimation.resume(); }
    };
    const result = await inspectionMutation(async () => {
      syncInspectionPayload();
      if (!placement) invalidateGesturePivot();
      inspectionState.replace(placement ? { ...next.inspection, placement } : next.inspection, 'restore');
      visibilityState = restoredVisibility;
      stylesState = normalizeStyles(next.inspection.styles);
      await restoreCompanion(next.inspection.companionStructure);
      // A saved scene with another animation, or none, replaces the running
      // one below. Stop it posing the figure about to be retired, and let its
      // queued work land before the saved figure snapshots its surroundings.
      if (molecularAnimation.supersededBy(next.inspection.animation)) molecularAnimation.halt();
      await molecularAnimation.settled();
      // Restore the actual saved layers, without chapter framing or narration.
      // An absent graph is a plain scene and clears any previous chapter graph.
      // Its plates and masked state copies show the saved animation's t=0
      // state until that animation is installed below.
      await lessonFigure.install(next.inspection.lessonFigure, { animation: next.inspection.lessonFigureAnimation ?? next.inspection.animation?.definition });
      if (typeof measurementLines !== 'undefined') await measurementLines.install(next.inspection.measurementLines);
      lessonPlayback = next.inspection.lessonPlayback ? detached(next.inspection.lessonPlayback) : undefined;
      lessonSelection = next.inspection.lessonSelection;
      markSelection(next.keys);
      // XR tracking supplies the live view. Replaying a desktop camera into
      // it makes a tour scene feel like an unexpected head teleport. The
      // complete camera remains in `next` for desktop restore/save contracts.
      if (!restorePlacement && wearerPlacement.holdsPlacement()) preserveCamera = true;
      if (!preserveCamera) {
        if (typeof desktopPreviewMaxDistance !== 'undefined') releaseDesktopPreviewLimit();
        desktopPreviewCamera = undefined; canvas.camera.setState(next.camera, 0);
      }
      await applyInspectionAppearance({ preservePlacement: Boolean(placement) });
      if (typeof syncStaticMask === 'function') await syncStaticMask();
      await molecularAnimation.restore(next.inspection.animation);
      applyInspectionTransform();
      // A named desktop view has an intentional camera. The automatic preview
      // fit is for normal shared/tour restores and would erase that angle.
      if (!preservePreviewCamera && !preserveCamera) fitDesktopPreview();
      if (xrRecoveryFrame) restoreXrRecoveryFrame(xrRecoveryFrame);
      inspectionState.setPayload(inspectionPayload());
    }, { rollback, lessonCheckpoint, desktopPreviewCheckpoint });
    // A restored chapter teaches its key exactly as a live one
    // does, so re-entering VR onto a saved scene arrives with the nouns.
    if (restoredEmphasis) lessonKey.remember(emphasisState);
    return result;
  }

  async function restoreTourSeat({ recenter = false, restart = false } = {}) {
    // Both player endings arrive here after the baseline and resting rows.
    // Do not enqueue a toolbar action from inside Done's own action chain.
    await immersiveSession?.refreshToolbar?.({ restoreTourSeat: true, recenter, restartTourSeat: restart });
    labelMeasurementGate.invalidate();
    if (componentLabelsWanted() || componentLabels.active()) {
      menuResolveReason = 'seat';
      await componentLabels.relayout('seat');
    }
  }

  /** Restore before the host saves/acknowledges Done. The XR camera remains
   * tracked. Keep an already-clear saved mesh exactly; an overlap uses the
   * bounded clearance fit before the resting menu renders. A missing saved
   * pose uses entry fitting. Report adjustments after every draw succeeds.
   */
  async function restoreJourneySeat({ scene } = {}) {
    let pose = false;
    try { pose = Boolean(scene && cameraSnapshot(scene.camera)); } catch { pose = false; }
    const immersive = canvas.xr.isPresenting.value;
    let entry, fitted = false;
    let placementRestored = pose;
    // What the clearance solver was handed on this Done, kept for the
    // `journey-seat` record emitted once the restored panel has been drawn.
    // Filled as the decision is taken; it never takes part in the decision.
    let seatInputs;
    if (immersive && latestRoomPlacementPose) {
      const sphere = loadedSphere();
      const before = sphere && inspectionSnapshot().placement;
      // Done replaces the chapter panel with its saved seat. Measure that
      // upcoming glass; the outgoing panel cannot constrain the restored view.
      // One build of that panel: its points go to the solver and its content to
      // the record, so the two can never describe different glass.
      let preview, geometry;
      const savedReading = {};
      if (pose && before) {
        preview = immersiveSession?.toolbarPlacementPreview?.({ ...latestRoomPlacementPose, restoreTourSeat: true });
        geometry = { objects: typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden ? retainedFitObjects()
          : scientificRepresentations().flatMap(repr => repr.renderObjects).filter(object => object.type !== 'text'),
          fromPlacement: presentationTransform(), toPlacement: placementTransform(before),
          views: latestRoomPlacementPose.labelViews };
      }
      const points = pose && before ? (preview?.points
        ?? immersiveSession?.toolbarPlacementPoints?.({ ...latestRoomPlacementPose, restoreTourSeat: true })
        ?? immersiveSession?.platePoints?.() ?? []) : [];
      savedReading.points = points;
      seatInputs = { sphere, before, geometry, preview, savedReading,
        cameraScale: canvas.camera.scale, roomPose: latestRoomPlacementPose };
      const entryPlacementCandidate = before;
      // Same session/source provenance check as Reset. A modified or wearer-
      // held saved pose keeps the ordinary saved-view recovery policy.
      const retainFreeFieldSeat = Boolean(canvas.xr.isPresenting.value && roomEntry?.seat && entryPlacementCandidate
        && typeof wearerPlacement !== 'undefined' && !wearerPlacement.holdsPlacement()
        && Number.isFinite(entryPlacementCandidate.scale) && entryPlacementCandidate.scale === roomEntry.seat.scale
        && ['rotation', 'translation'].every(key => entryPlacementCandidate[key]?.length === 3
          && entryPlacementCandidate[key].every((value, axis) => Number.isFinite(value) && value === roomEntry.seat[key]?.[axis])));
      let cleared;
      try {
        cleared = pose && before && resetViewPlacement({ seat: before, bounded: true, fit: true, restoreSaved: true,
          retainFreeFieldSeat,
          geometry, savedReading, points,
          ...latestRoomPlacementPose, cameraScale: canvas.camera.scale,
          center: sphere.center, radius: sphere.radius });
      } catch (error) {
        recordJourneySeat({ ...seatInputs, pose, immersive, fitted, placementRestored,
          failureReason: error?.message ?? String(error) });
        throw error;
      }
      seatInputs.cleared = cleared;
      if (cleared) {
        placementRestored = Math.abs(cleared.scale - before.scale) <= 1e-3
          && cleared.translation.every((v, i) => Math.abs(v - before.translation[i]) <= 1e-3);
        if (cleared !== before) await placeInspection({ translation: cleared.translation, scale: cleared.scale }, 'journey-end');
        else if (typeof retainedPoseHidden !== 'undefined' && retainedPoseHidden) showRetainedPose(true);
        // Save the restored target; Reset can fit it against its own glass. Adoption
        // deletes the prior source's seat; the next frame must not replace it
        // with the post-Done dodge or keep the final chapter's seat.
        entry = structuredClone(before);
      } else {
        await seatStructureForEntry({ bounded: true });
        entry = structuredClone(inspectionSnapshot().placement);
        fitted = true;
        placementRestored = false;
      }
    } else if (!pose && !immersive) { await fitInspection(); fitted = true; }
    await restoreTourSeat({ recenter: fitted });
    recordJourneySeat({ ...seatInputs, pose, immersive, fitted, placementRestored });
    // Publish Reset's target only after all required rendering succeeded.
    if (entry && roomEntry) {
      roomEntry.seat = entry;
      const sphere = loadedSphere();
      entryRoomPoint = applyMatrix4(sphere.center.map((value, axis) =>
        (value + entry.translation[axis] * sphere.radius) * canvas.camera.scale),
        Mat4.invert(Mat4(), latestRoomPlacementPose.renderFromRoom));
    }
    // Done returns ownership to the restored seat only after its draws succeed.
    releaseWearerPlacement('entry-seat');
    return { placementRestored, fitted };
  }

  /**
   * One `journey-seat` record per Done, after the restored panel has
   * been drawn.
   *
   * Defect 110 is a model-driven Done that restores the pre-tour view and then
   * halves it, and three in-memory fixes for it passed their tests and failed
   * on the headset. This is the reading the next fix is owed: the glass the
   * clearance solver measured, the subject it measured against, the panel that
   * was actually drawn afterwards, and the branch Done took. It changes
   * nothing and, because a Done that fails to report is far better than a Done
   * that throws, every step of it is inside this one catch.
   */
  function recordJourneySeat(inputs) {
    if (!globalThis.__stereofoldDiagnostics?.record) return;
    try {
      globalThis.__stereofoldDiagnostics.record('journey-seat', journeySeatDetail({ ...inputs,
        committed: {
          rows: immersiveSession?.toolbarRows?.() ?? [],
          readout: immersiveSession?.toolbarReadoutText?.() ?? [],
          collapsed: immersiveSession?.isMenuCollapsed?.() ?? null,
          head: immersiveSession?.toolbarHead?.() ?? null,
          layout: immersiveSession?.toolbarLayout?.() ?? null,
          menuPoints: immersiveSession?.drawnMenuPoints?.() ?? [],
          platePoints: immersiveSession?.platePoints?.() ?? [],
        } }));
    } catch { /* A Done that cannot be described is still a Done. */ }
  }

  function setSpatialTour(value) {
    detachSpatialTour?.(); detachSpatialTour = undefined;
    if (value != null && (typeof value !== 'object' || typeof value.getState !== 'function')) {
      throw new TypeError('Spatial tours need a stateful tour controller.');
    }
    spatialTour = value;
    // A notification is advisory: clearance may refuse while a hand holds
    // the molecule. Keep the drawn glass and let the next notification retry.
    if (typeof value?.subscribe === 'function') {
      detachSpatialTour = value.subscribe(() => { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); });
    }
    void immersiveSession?.refreshToolbar?.()?.catch?.(() => {});
  }

  function setVoiceInteraction(value) {
    detachVoiceInteraction?.(); detachVoiceInteraction = undefined;
    if (value != null && (typeof value !== 'object' || typeof value.toggle !== 'function' || typeof value.state !== 'function')) {
      throw new TypeError('Voice controls need a stateful interaction controller.');
    }
    // The X button plays the last reply again, so the one path an
    // audible reply takes is wrapped to remember it.
    voiceInteraction = value ? rememberSpokenReply(value) : value;
    // Voice notifications use the same best-effort redraw as tour updates.
    if (typeof value?.subscribe === 'function') {
      detachVoiceInteraction = value.subscribe(() => { void immersiveSession?.refreshToolbar?.()?.catch?.(() => {}); });
    }
    void immersiveSession?.refreshToolbar?.()?.catch?.(() => {});
  }

  function pickPoint(key) {
    assertReady();
    selectedKeys([key]);
    const row = selection.rows.find(row => row.key === key);
    if (!row.atomSites.length) throw failure('missing_coordinates', 'This sequence position has no atom to point at.');
    const rect = element.getBoundingClientRect();
    const ratio = canvas.webgl.pixelRatio;
    const transform = inspectionState ? presentationTransform() : undefined;
    const candidates = row.atomSites.map(atom => {
      const coordinate = transform ? Vec3.transformMat4(Vec3(), atom.assemblyCoordinatesAngstrom, transform) : atom.assemblyCoordinatesAngstrom;
      return { atom, point: canvas.camera.project(Vec4(), coordinate) };
    })
      .filter(({ point }) => Array.from(point).every(Number.isFinite) && point[2] >= 0 && point[2] <= 1 && point[3] > 0)
      .sort((a, b) => a.point[2] - b.point[2]);
    for (const { atom, point } of candidates) {
      const localX = point[0] / ratio;
      const localY = (canvas.webgl.gl.drawingBufferHeight - point[1]) / ratio;
      if (localX < 0 || localY < 0 || localX >= rect.width || localY >= rect.height) continue;
      const picked = canvas.identify(Vec2.create(localX, localY));
      if (!picked) continue;
      const loci = canvas.getLoci(picked.id).loci;
      if (loci.kind !== 'element-loci' && loci.kind !== 'bond-loci') continue;
      const keys = selection.fromLoci(loci);
      if (keys.length === 1 && keys[0] === key) {
        // This only locates a visible point. The browser test must send a real
        // mouse event and observe the independent click handler below.
        return { x: rect.left + localX, y: rect.top + localY, key, atomKey: atom.key };
      }
    }
    throw failure('not_visible', 'No visible atom point for this residue passes the current Mol* pick buffer.');
  }

  /**
   * Confirm a headset pick on the hand that made it.
   *
   * The caption is the toolbar's own one-line plate, which push-to-talk
   * registers for the session; outside immersion there is no sink and this
   * costs nothing.
   */
  function reportHeadsetPick(keys) {
    if (!canvas.xr.isPresenting.value) return;
    if (performance.now() - lastTriggerAt < 500) pulseController(xrInputSourceFor(lastTriggerHand), PICK_PULSE);
    const identity = selection.rows.find(row => row.key === keys[0])?.identity;
    const caption = residueCaption(identity);
    if (caption) showHeadsetCaption(caption);
    recordManipulation('xr-pick', { keys: keys.length, caption: caption ?? null, hand: lastTriggerHand ?? null });
  }

  function dispatchPresentationPick(event) {
    // A Quest trigger reaches Mol* as `ButtonsType.Flag.Trigger`, which is 32
    // (`mol-util/input/input-observer.js:428`), not the desktop primary 1.
    // Testing for 1 alone dropped every headset press on the structure.
    if (state.status !== 'ready' || busy || !isPickButton(event.button)) return;
    if (canvas.xr.isPresenting.value && (xrInputBlind || xrDeferredBake || xrInputRelease.blocksPick(lastTriggerHand))) return;
    // A trigger held to push or yaw the structure is not a
    // selection. Without this the residue under the ray changed on every push.
    const pickHand = xrManipulation?.pickAmbiguous?.() ? undefined : lastTriggerHand;
    if (xrManipulation?.consumesPick?.(pickHand) || stickModifiers?.engagedWithin?.(undefined, pickHand)) { recordManipulation('xr-pick', { outcome: 'modifier' }); return; }
    const loci = event.current?.loci;
    if (!loci || (loci.kind !== 'element-loci' && loci.kind !== 'bond-loci')) return;
    let keys;
    try { keys = selectedKeys(selection.fromLoci(loci)); }
    catch (error) { state.lastPick = { status: 'rejected', error: error.message }; return; }
    if (!keys.length) return;
    const observed = { status: 'rendering', selectionKeys: [...keys], position: event.position ? Array.from(event.position) : null };
    state.lastPick = observed;
    const applyPick = select(keys, 'pick');
    applyPick.then(result => {
      state.lastPick = { ...observed, status: 'rendered', revision: result.revision, drawCount: result.drawCount };
      reportHeadsetPick(keys);
      emit(onSelection, [...keys], snapshot());
    }).catch(error => { state.lastPick = { ...observed, status: 'failed', error: error.message }; });
  }

  function flushPendingPresentationPick() {
    const pending = pendingPresentationPick;
    pendingPresentationPick = undefined;
    if (!pending || pending.sourceSha256 !== state.sourceSha256 || pending.generation !== state.generation
        || state.status !== 'ready' || busy) return;
    dispatchPresentationPick(pending.event);
  }

  const pickSubscription = canvas.interaction.click.subscribe(event => {
    if (canvas.xr.isPresenting.value && (xrInputBlind || xrDeferredBake || xrInputRelease.blocksPick(lastTriggerHand))) return;
    // A spatial-toolbar gesture owns input through its release frame. Bound
    // the release drain so a cancelled/non-picking gesture cannot swallow a
    // later residue click. It never changes the saved scientific selection.
    if (canvas.xr.isPresenting.value && (spatialInputOwners.size || performance.now() < spatialReleaseUntil)) return;
    // And the same for a trigger that is holding the stick
    // modifier, before the click can be deferred past the modifier's own life.
    const pickHand = xrManipulation?.pickAmbiguous?.() ? undefined : lastTriggerHand;
    if (canvas.xr.isPresenting.value && (xrManipulation?.consumesPick?.(pickHand) || stickModifiers?.engagedWithin?.(undefined, pickHand))) return;
    if (presentationFreeze) {
      // The renderer has stopped on the exact pose the user saw. Defer the
      // Mol* click until that pose is baked and its frame is acknowledged.
      pendingPresentationPick = {
        sourceSha256: state.sourceSha256,
        generation: state.generation,
        event: { button: event.button, current: event.current,
          position: event.position ? Array.from(event.position) : undefined },
      };
      return;
    }
    dispatchPresentationPick(event);
  });

  function contextLost() {
    if (state.status === 'disposed') return;
    if (typeof molecularAnimation !== 'undefined') void molecularAnimation.forget().catch(error => console.error(error));
    spatialInputOwners.clear();spatialOwnedHands.clear();manualXrInputHeld = false;spatialReleaseUntil = 0;latestHeadContext = null;
    // An outcome is presentation-only. End its session and release its shape
    // before the retained molecular state is rebuilt after context recovery.
    void immersiveSession?.end().catch(() => {});
    pendingPresentationPick = undefined;
    const pendingLoss = typeof pendingContextLoss === 'undefined' ? undefined : pendingContextLoss;
    recoveryRecord = activeWork ? activeWork.previous
      : pendingLoss?.epoch === state.contextLossCount ? pendingLoss.previous : retainCurrent();
    pendingContextLoss = undefined;
    motionContextPaused = true;
    syncPresentationMotion();
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    state.contextLossCount += 1;
    state.generation += 1;
    state.status = 'context_lost';
    state.error = 'The molecular WebGL context was lost.';
    if (activeLoad) {
      activeLoad.cancelled = failure('context_lost', state.error);
      activeLoad.releasePause?.();
    }
    for (const settle of [...frameWaiters]) settle(failure('context_lost', state.error));
  }
  element.addEventListener('webglcontextlost', contextLost);

  function contextRestored() {
    if (state.status === 'disposed') return;
    const epoch = state.contextLossCount;
    const pending = activeWork?.done;
    state.status = 'recovering';
    const recovery = (async () => {
      await pending;
      if (state.status === 'disposed' || epoch !== state.contextLossCount) return;
      // Loss ends XR while canResumeDesktop deliberately refuses to restart
      // its clock. Join adapter teardown before taking that clock back here.
      await immersiveSession?.end();
      if (state.status === 'disposed' || epoch !== state.contextLossCount) return;
      assertContext({ recovering: true });
      if (canvas.xr.isPresenting.value || canvas.webgl.xr.session) {
        throw failure('context_recovery_xr_active', 'The headset display has not finished closing for graphics recovery.');
      }
      if (plugin.animationLoop.isAnimating === false) plugin.animationLoop.start();
      canvas.requestResize();
      state.status = 'recovering';
      busy = true;
      // A GL loss leaves state-tree cells intact. Delete the retained label
      // component before restoring and rebuilding its selected-residue layer.
      if (inspectionState) { await removeInspectionLabels(); await removeLigandOverlay(); await removeComponentLabels(); }
      for (const candidate of [...candidateRecords]) await deleteRecord(candidate);
      if (recoveryRecord) {
        const restored = await restoreRecord(recoveryRecord, { recovering: true });
        if (inspectionState) {
          await applyInspectionAppearance({ recovering: true });
          canvas.commit(true);
          // A staged appearance owns a new selector after its old cell retires.
          await waitForFrame({ ...restored, representation }, { recovering: true });
        }
      }
      if (state.status === 'disposed' || epoch !== state.contextLossCount) return;
      assertContext({ recovering: true });
      state.contextRestorationCount += 1;
      state.status = recoveryRecord ? 'ready' : 'empty';
      state.error = null;
      state.replacementPhase = 'idle';
      if (state.lastLoadFailure?.recoveryPending) {
        state.lastLoadFailure = { ...state.lastLoadFailure, recovered: true,
          recoveryPending: false, rollbackDrawCount: state.drawCount };
      }
      busy = false;
      motionContextPaused = false;
      syncPresentationMotion();
      removeFrameCover();
      emit(onMutation, snapshot());
    })();
    recoveryPromise = recovery;
    // Keep the rejecting promise for the explicit test waiter; the event path
    // records failures without creating an unhandled Promise rejection.
    recovery.catch(error => {
      if (state.status === 'disposed' || epoch !== state.contextLossCount) return;
      busy = false;
      state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
      state.error = `Context recovery failed: ${error.message}`;
      state.contextRecoveryError = error.message;
    });
  }
  const restoredSubscription = canvas.webgl.contextRestored.subscribe(contextRestored);

  function dispose() {
    if (disposePromise) return disposePromise;
    const final = snapshot();
    const pending = activeWork?.done;
    const pendingRecovery = recoveryPromise;
    cancelXrPlacementFollowup(); invalidateGesturePivot();
    state.status = 'disposed';
    rejectPlacementViews('The viewer was disposed before placement could be measured.');
    state.generation += 1;
    busy = false;
    // A viewer being torn down is not a page that should be sent
    // to Mol* a moment later.
    workbenchHandoff?.cancel();
    stopPresentationMotion();
    if (typeof molecularAnimation !== 'undefined') void molecularAnimation.forget().catch(error => console.error(error));
    if (activeLoad) {
      activeLoad.cancelled = failure('viewer_disposed', 'The viewer has been disposed.');
      activeLoad.releasePause?.();
    }
    disposedSnapshot = { ...final, ...state, ready: false, representationCount: 0, renderObjectCount: 0,
      markerCount: 0, selectedMarkerCount: 0, highlightedMarkerCount: 0, selectionLociElementCount: 0,
      interactionActive: false, frameCoverVisible: false, frameCoverBytes: 0, cleanupPending: true };
    for (const settle of [...frameWaiters]) settle(failure('viewer_disposed', 'The viewer has been disposed.'));
    plugin.animationLoop.stop({ noDraw: true });
    drawSubscription.unsubscribe();
    annotationRenderSubscription.unsubscribe();
    annotationStateSubscription.unsubscribe();
    pickSubscription.unsubscribe();
    restoredSubscription.unsubscribe();
    for (const subscription of interactionSubscriptions) subscription.unsubscribe();
    reducedMotionQuery?.removeEventListener?.('change', reducedMotionChange);
    detachSpatialTour?.(); detachSpatialTour = undefined; spatialTour = undefined;
    detachVoiceInteraction?.(); detachVoiceInteraction = undefined; voiceInteraction = undefined;
    detachSpatialMenuHook?.(); detachSpatialMenuHook = undefined;
    detachSpatialAimHook?.(); detachSpatialAimHook = undefined;
    document.removeEventListener('visibilitychange', visibilityChange);
    element.removeEventListener('mousedown', mouseDown, true);
    element.removeEventListener('touchstart', touchChange, true);
    element.removeEventListener('wheel', wheelInput, true);
    element.removeEventListener('keydown', keyInput, true);
    window.removeEventListener('mouseup', mouseUp, true);
    window.removeEventListener('touchend', touchChange, true);
    window.removeEventListener('touchcancel', touchChange, true);
    window.removeEventListener('blur', endInteraction, true);
    element.removeEventListener('webglcontextlost', contextLost);
    try { globalThis.removeEventListener?.(GROWTH_CAPTION_EVENT, onHostGrowthCaption); } catch { /* Already detached. */ }
    removeFrameCover();
    disposePromise = (async () => {
      await pending;
      await pendingRecovery?.catch(() => {});
      let cleanupError;
      try {
        await immersiveSession?.dispose();
        if (xrPreview) disposedSnapshot.xrPreviewCleanup = await xrPreview.dispose();
        await removeInspectionLabels();
        await removeLigandOverlay();
        await removeComponentLabels();
        await lessonFigure.forget();
        if (typeof measurementLines !== 'undefined') await measurementLines.install([]);
        plugin.animationLoop.stop({ noDraw: true });
        await plugin.clear();
      }
      catch (error) { cleanupError = error; }
      finally {
        plugin.dispose();
        state.contextDisposed = true;
        disposedSnapshot = { ...disposedSnapshot, contextDisposed: true, cleanupPending: false,
          candidatePresent: false, candidateCount: 0, pendingFrameWaits: 0, stateCellCount: 0, replacementPhase: 'disposed',
          testPausedAt: null, ...(cleanupError ? { disposalError: cleanupError.message } : {}) };
        sourceRecord = dataRoot = structure = representation = selection = visibleStage = recoveryRecord = pendingContextLoss = activeLoad = undefined;
        candidateRecords.clear();
        plugin = canvas = undefined;
      }
      if (cleanupError) throw cleanupError;
      return snapshot();
    })();
    return disposePromise;
  }

  const testHooks = enableTestHooks ? Object.freeze({
    async attachXrPreview(install) {
      assertReady();
      if (xrPreview || typeof install !== 'function' || interactionActive()) {
        throw failure('invalid_xr_attachment', 'Attach one explicit XR preview to an idle lab viewer.');
      }
      // The test driver supplies the shared, pinned preview. Normal viewer
      // instances expose no hook and never install an emulation runtime.
      xrPreview = await install({ plugin, Mat4, version: PLUGIN_VERSION, snapshot });
      if (typeof xrPreview?.dispose !== 'function' || typeof xrPreview?.snapshot !== 'function') {
        throw failure('invalid_xr_attachment', 'The preview must expose its observation and cleanup.');
      }
      return xrPreview.snapshot();
    },
    failNextLoadAt(point) {
      assertContext();
      if (busy || !LOAD_CHECKPOINTS.has(point)) throw failure('invalid_test_hook', 'Choose an idle viewer and a declared load checkpoint.');
      nextTest.failAt = point;
    },
    pauseNextLoadAt(point) {
      assertContext();
      if (busy || !LOAD_CHECKPOINTS.has(point)) throw failure('invalid_test_hook', 'Choose an idle viewer and a declared load checkpoint.');
      nextTest.pauseAt = point;
    },
    resumeLoad() {
      const release = activeLoad?.releasePause;
      release?.();
      return { resumed: Boolean(release) };
    },
    loseContext() {
      assertContext();
      lossExtension ??= canvas.webgl.gl.getExtension('WEBGL_lose_context');
      if (!lossExtension) return { supported: false };
      lossExtension.loseContext();
      return { supported: true };
    },
    restoreContext() {
      if (state.status === 'disposed') throw failure('viewer_disposed', 'The viewer has been disposed.');
      if (!lossExtension) return { supported: false };
      lossExtension.restoreContext();
      return { supported: true };
    },
    async waitForContextRecovery() {
      if (!recoveryPromise) throw failure('recovery_not_started', 'The browser has not emitted context restoration.');
      await recoveryPromise;
      return snapshot();
    },
  }) : undefined;

  const inspection = inspectionState ? Object.freeze({
    batchComponentLabels: operation => componentLabels.transaction(operation),
    compound: applyCompoundInspection,
    supportsConcurrentPlayback: true, runChapter,
    preservesFigureFrame: () => Boolean(initialFigureFrame),
    setSourceCoordinateFrame,
    // Typed voice controls use the same session entry range as hands and menu.
    clampWearerScale: value => clampPlacementScale(value,
      canvas.xr.isPresenting.value ? roomEntry?.seat?.scale : undefined, inspectionState.placement().scale),
    // New-source chapter entry uses the same solver as entering XR, without
    // Reset's wearer stop or menu/orientation reset.
    seatForEntry: () => seatStructureForEntry({ chapter: true }),
    configure: configureInspection, placementFitEvidence, place: placeInspection, fit: fitInspection, resetOrientation, recenter: recenterInspection, orbit, dolly,
    undo: undoInspection, redo: redoInspection, saveView: saveInspectionView, restoreView: restoreInspectionView,
    hover: hoverInspection, capture: completeInspectionCapture,
    serializeCapture: options => completeInspectionCapture({ ...options, serialize: true }),
    restore: restoreInspection, captureXrRecoveryFrame,
    captureNamedViewIntent, sceneForNamedView,
    emphasize,
    /**
     * "hide chain B", as the panel's own primitive.
     *
     * It takes the whole hidden set after the edit, which is what the host
     * sends and what a saved scene carries, so the same call serves an agent
     * command, an undo and a named-view restore. `visibility` reads back what
     * is hidden now, `visibilityChains` what may be named, and `describe` the
     * one sentence both ends say about it.
     */
    setCompanion,
    registerComparisonSources: sources => {
      const keep=new Set((sources??[]).map(source=>`${source.sha256}:${source.catalog.assemblyId}`));
      const visit=value=>{
        if(!value || typeof value!=='object') return;
        if(value.companionStructure) keep.add(`${value.companionStructure.sourceSha256}:${value.companionStructure.assemblyId}`);
        for(const child of Object.values(value)) if(child && typeof child==='object') visit(child);
      };
      visit(inspectionState.checkpoint());
      for(const key of comparisonSources.keys()) if(!keep.has(key)) comparisonSources.delete(key);
      for (const source of sources ?? []) comparisonSources.set(`${source.sha256}:${source.catalog.assemblyId}`,source);
    },
    setVisibility: setSceneVisibility,
    setStyles: setSceneStyles,
    styles: () => normalizeStyles(stylesState),
    visibility: () => normalizeVisibility(visibilityState),
    visibilityChains,
    describeVisibility: describeSceneVisibility,
    /**
     * The edits of one request, grouped so they leave one thing
     * to undo. `beginOperation` returns the checkpoint to roll back to if an
     * edit part way through fails; `endOperation` closes the group and is safe
     * to call when none is open.
     */
    beginOperation: (action = 'compound') => { const checkpoint = inspectionState.checkpoint(); inspectionState.beginGroup(action); return checkpoint; },
    endOperation: () => inspectionState.endGroup(),
    // Only the owning workspace transaction uses this after a replacement
    // draws. Collapse its undo entries while retaining the live appearance:
    // resetting current would make configure skip the correction's geometry.
    rebaseOperation: checkpoint => { inspectionState.endGroup(); inspectionState.rebaseHistory(checkpoint); },
    rollbackOperation: async checkpoint => {
      inspectionState.endGroup(); inspectionState.restoreCheckpoint(checkpoint);
      return inspectionMutation(async () => {
        restoreInspectionPayload();
        if (typeof lessonFigure !== 'undefined' && (lessonFigure.definition?.() || inspectionState.payload()?.lessonFigure))
          await lessonFigure.install(inspectionState.payload()?.lessonFigure);
        if (typeof measurementLines !== 'undefined') await measurementLines.install(inspectionState.payload()?.measurementLines);
        await restoreCompanion(inspectionSnapshot().companionStructure);
        await applyInspectionAppearance(); applyInspectionTransform();
      });
    },
    /**
     * The lesson's own chapter turn — see `applyLessonMotion`
     * above. On this entry a chapter tick never reads as a workspace mutation,
     * never bakes a placement and never takes the wearer's hold.
     */
    applyLessonMotion,
    /**
     * Commit a finished chapter's turn as the saved camera.
     * Returns whether there was a pinned camera to let go of.
     */
    bakeLessonMotion,
    /** Whether a chapter's turn is pinning the saved camera. */
    lessonMotionHolding: () => lessonMotionHold.holding(),
    /**
     * The tour starts painting chapter `chapterId`, or ends (undefined).
     * Meanwhile framing and menu clearance leave out motion drawn for any
     * other chapter, such as the outgoing one's. `turn` is the turn the
     * chapter will play in the headset (render-space `axis`, the molecule's
     * signed `degrees`, `continuous` for the presentation spin), and its
     * framing is solved for everything that turn sweeps.
     */
    chapterPainting(chapterId, { turn } = {}) {
      paintingChapter = chapterId ?? undefined;
      if (chapterId !== undefined) turnHeldFor = null;
      paintingTurn = chapterId !== undefined && turn?.axis?.length === 3 && Number.isFinite(turn.degrees)
        ? { axis: [...turn.axis], degrees: turn.degrees, continuous: turn.continuous === true } : undefined;
      if (chapterId !== undefined) menuClearanceMovedFor = null;
    },
    /** Whether chapter `chapterId` was framed as a close-up that holds its spin still. */
    holdsTurnStill: chapterId => chapterId !== undefined && turnHeldFor === chapterId,
    /**
     * Whether the wearer's own placement outranks an authored
     * one right now.
     *
     * The tour player asks before it writes a chapter's stored `placement`: a
     * changed authored framing releases ownership on entry, while ordinary
     * chapters and subsequent repaints retain it. `state()` is the same
     * answer with the reason and the chapter on it, for a diagnostic reader.
     */
    beginChapterFraming,
    holdsWearerPlacement: () => wearerPlacement.holdsPlacement(),
    wearerPlacement: () => wearerPlacement.state(),
    /**
     * The one call a stopped lesson makes on its way out.
     * It is a no-op unless a lesson chapter is what put the key there.
     */
    clearLessonEmphasis,
    restoreTourSeat,
    /** The journey's own ending. Fit when no pose, clear, re-seat. */
    restoreJourneySeat,
    /** First-chapter paint and plates owned by lesson attachment. */
    setLessonRestingState,
    setLessonFigure,
    async setMeasurementLines(lines) {
      assertReady();
      const previous=measurementLines.definition();
      return inspectionMutation(async()=>{
        syncInspectionPayload();
        inspectionState.recordPayload({...inspectionPayload(),measurementLines:lines}, 'measurement');
        if (typeof measurementLines !== 'undefined') await measurementLines.install(lines);
        syncInspectionPayload();
      },{rollback:()=>measurementLines.install(previous)});
    },
    prepareMolecularAnimation: value => molecularAnimation.prepare(value),
    animationFramingContext(value) {
      if (!value || !structure?.obj?.data) return undefined;
      // Placement belongs to the scene, including when a ligand or a tracked
      // chain is hidden. Visibility must never disable the chapter scale cap.
      return { source: structure.obj.data, previousScale: inspectionSnapshot().placement.scale };
    },
    setMolecularAnimation: installMolecularChapter,
    setAnimatedChapter: (value, chapterId, figure, options) =>
      installMolecularChapter(value, chapterId, {...options, figure, installFigure:true}),
    controlMolecularAnimation: patch => molecularAnimation.control(patch),
    async applyMolecularAnimationControl(patch, target) {
      const before = molecularAnimation.snapshot();
      if (!before) throw Error('This chapter has no animation.');
      if (target && (before.id !== target.id || before.chapterId !== target.chapterId))
        throw Error('The animated chapter changed. Ask again.');
      // Explicit Play replays a finished clip. Keep absolute seeks and the
      // tour/restore clock controls independent of this wearer action.
      if (patch.state === 'play' && patch.seekSeconds === undefined
          && !(patch.loop ?? before.loop) && before.timeSeconds >= before.durationSeconds)
        patch = { ...patch, restart: true };
      molecularAnimation.control(patch);
      const revision = molecularAnimation.revision();
      const rendered = await waitForFrame(undefined, {onDraw: () => {
        const sample = molecularAnimation.snapshot();
        if (!sample || sample.id !== before.id || sample.chapterId !== before.chapterId)
          throw Error('The animated chapter changed before it rendered.');
        if (revision !== molecularAnimation.revision()) throw Error('The animation control changed before it rendered.');
        return sample;
      }});
      if (revision !== molecularAnimation.revision()) throw Error('The animation control changed before acknowledgement.');
      molecularAnimation.publish(rendered);
      return rendered;
    },
    checkpointMolecularAnimation: () => molecularAnimation.checkpoint(),
    /**
     * Redraw a viewer that a failed change left in `error`, for a page that
     * finds its panel wedged with nothing else running. Draws the restored
     * checkpoint as a failed change does, and reports ready only once drawn.
     */
    async recover() {
      if (state.status !== 'error') return snapshot();
      if (busy || appearanceWork || canvas.webgl.isContextLost) throw failure('viewer_busy', 'A molecular change is still rendering.');
      if (representation?.cell?.status !== 'ok' || plugin.state.data.cells.get(representation.ref) !== representation.cell)
        throw failure('viewer_failed', state.error ?? 'The viewer failed.');
      const failed = state.error;
      state.status = 'mutating'; busy = true;
      try {
        await redrawRestoredScene();
        state.status = 'ready'; state.error = null;
      } catch (error) {
        if (!error?.recoverablePlacement && !['disposed', 'context_lost', 'recovering'].includes(state.status)) {
          state.status = canvas.webgl.isContextLost ? 'context_lost' : 'error';
          state.error = `${failed}; recovery failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        throw error;
      } finally { busy = false; }
      return snapshot();
    },
    async restoreMolecularAnimation(checkpoint) {
      await molecularAnimation.restore(checkpoint, true);
      const revision = molecularAnimation.revision();
      await waitForFrame(undefined, {onDraw: () => {
        const sample = molecularAnimation.snapshot();
        if (revision !== molecularAnimation.revision() || (checkpoint
          ? !sample || sample.id !== checkpoint.playback.id || sample.chapterId !== checkpoint.playback.chapterId
            || sample.speed !== checkpoint.playback.speed || sample.loop !== checkpoint.playback.loop
            || (checkpoint.playback.state === 'paused' && (sample.state !== 'paused' || sample.timeSeconds !== checkpoint.playback.timeSeconds))
          : sample !== null)) throw Error('The animation changed during rollback.');
      }});
    },
    setLessonPlayback(value) { lessonPlayback = value ? detached(value) : undefined; },
    /** The colour key and focus now on the structure. */
    emphasis: () => detached(emphasisState),
    captureStructureViewerImportTarget: (selectedAtomIds = []) => {
      assertReady();
      if (!Array.isArray(selectedAtomIds) || selectedAtomIds.length > 200000
          || selectedAtomIds.some(id => typeof id !== 'string' || id.length > 512)) {
        throw failure('scene_import_target_unavailable', 'Scene import needs a bounded list of exact selected atom IDs.');
      }
      const data = structure?.obj?.data, sphere = data?.boundary?.sphere;
      const live = liveScene();
      if (!sourceRecord?.sha256 || !Number.isSafeInteger(live.modelNumber) || typeof live.assemblyId !== 'string'
          || !sphere || !(sphere.radius > 0) || !selection?.sourceAtomIdToSelectionKey) {
        throw failure('scene_import_target_unavailable', 'The loaded molecular structure has no complete scene-import boundary.');
      }
      return {
        sourceSha256: sourceRecord.sha256, modelNumber: live.modelNumber, assemblyId: live.assemblyId,
        molecularCenterAngstrom: Array.from(sphere.center), molecularRadiusAngstrom: sphere.radius,
        cameraBaseline: cameraSnapshot(canvas.camera.getSnapshot()),
        atomIdToSelectionKey: selection.sourceAtomIdToSelectionKey(selectedAtomIds),
      };
    },
    getMotion: () => detached(inspectionMotionSnapshot()), setMotion: setInspectionMotion,
    // One lever, three levels, reached identically from the
    // spatial menu row, the voice grammar and the agent's render-quality change.
    setRenderQuality, renderQuality: renderQualityLevel,
  }) : undefined;
  return Object.freeze({ plugin, load, cancelLoad, prepareHostLoad, capture, snapshot, setRepresentation, synchronizeRepresentationFromPlugin, select, focus, focusSelection, setCamera, applyInspection, pickPoint, dispose,
    readiness: () => ({ ready: state.status === 'ready' && !busy && !appearanceWork, interactionActive: interactionActive() }),
    ...(inspection ? { inspection } : {}), ...(immersiveSession ? { xr: Object.freeze({ ...immersiveSession, setSpatialTour, setVoiceInteraction, getSubject: spatialSubject, onPresentationChange,
      refreshSequence: () => {
        const sequence = sequenceNavigation.snapshot();
        if (!sequence.open || sequence.version === sequenceRefreshVersion) return;
        sequenceRefreshVersion = sequence.version;
        return immersiveSession.refreshToolbar().catch(() => {});
      },
      placeInRoom: target => runSpatialAction({ kind: 'room-placement', target }, () => placeRoomTarget(target)),
      spatialContext: () => canvas.xr.isPresenting.value && performance.now() - latestHeadSample < 1500 ? detached(latestHeadContext) : null,
    }) } : {}), ...(testHooks ? { testHooks } : {}) });
}
