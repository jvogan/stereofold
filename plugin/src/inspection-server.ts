// @ts-ignore Shared JavaScript selection policy.
import { focusResidues } from '../../lab/browser-roundtrip/focus-residues.mjs';
import { InspectionEditAdmission } from './inspection-edit-admission.js';
import { readInlineHtml } from './inline-html.js';
import { comparisonRadius } from './inspection-comparison.js';
import { missingVoiceRegion, observeVoiceRefusal, voiceValidationSentence } from './inspection-refusal-caption.js';
import { inspectionRefusalCaption, isInspectionBookkeepingTool } from './inspection-refusal-caption.js';
import { INSPECTION_FAILURE_CODES, MAX_INSPECTION_FAILURE_REASON_CHARS } from './inspection-failure-receipt.js';
import { SourceRenderWait, type SourceRenderReceipt } from './source-render-wait.js';
import { SOURCE_DESCRIPTION, assertStructureSourceRequest, type StructureSourceRequest, type StructureSelection, type ResolvedStructureSource } from './structure-sources.js';
import { growthOperation, inspectionOperationInventory, visualEdit } from './inspection-operations.js';
import type { OperationContract } from './inspection-contract.js';
import { assertInspectionBudget, INSPECTION_SIZE_GUIDE, MAX_INSPECTION_CHUNK_BYTES, MAX_INSPECTION_HYDRATION_BYTES, MAX_STRUCTURE_SOURCE_BYTES, STRUCTURE_SOURCE_SIZE_LABEL } from './inspection-limits.js';
import { MAX_INSPECTION_CATALOG_COMPRESSED_BYTES } from './inspection-catalog-codec.js';
import { createHash, randomUUID } from 'node:crypto';
import { readStampedBuildId } from './build-identity.js';
import { registerAppResource, registerAppTool as registerHostTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createAssistantOwnership, handoverLine, normalizeAssistantLabel } from './assistant-ownership.js';
import { LocalSceneService } from './scene-service.js';
import { headsetHostCommand, loopbackListenDenied } from './headset-host-guidance.js';
import { registerInspectionVoiceTools, type VoiceIntentAcknowledgement } from './inspection-voice.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getStructureInputSchema, sessionIdSchema } from './schemas.js';
import { inspectInputSchema, syncInspectionSchema, validateScene, INSPECTION_RESOURCE_URI, PRIVATE_INSPECTION_META_KEY, type InspectionScene,
  geometryBudgetReceiptSchema, inspectionBindingSchema, inspectionStateSchema, updateInspectionSchema, pollInspectionSchema, completeInspectionSchema, pushToTalkSchema, expectedInspection, commandIdSchema,
  inspectExperienceSchema, navigateExperienceSchema, acknowledgeExperienceStepSchema, replaceInspectionSourceSchema, growStructureSchema,
  companionHeadsetSchema, companionLaunchSchema, companionLaunchModeSchema, focusSelectionSchema, emphasizeSchema,
  type CompanionHeadset, type CompanionLaunchMode,
  assembleReadiness, formatReadiness, pairedSessionHeadset, visionProStatus, readinessSchema, type ReadinessFacts, inspectionModelContextSchema,
  type InspectionModelContext, type InspectionReadinessSummary,
  continueSessionSchema, switchAssistantSchema,
  requestPointingSchema, requestReferentSchema, type InspectionChange, type InspectionCompoundOp,
  availableChains, describeVisibility, resolveVisibility, visibilityIsEmpty, VISIBILITY_COMPONENT_CLASSES, MAX_HIDDEN_CHAINS,
  absentClassNote, absentVisibilityClasses, componentClassesPresent, visibilityHidesEverything,
  type InspectionVisibility, type VisibilityRequestPatch,
  type RequestReferent, IMPLICIT_BINDING_FIELDS, withImplicitBinding, commandWaitSchema, COMMAND_WAIT_CEILING_MS, SOURCE_RENDER_WAIT_CEILING_MS,
  focusSelectionRequestSchema, replaceInspectionSourceRequestSchema, inspectionJson } from './inspection-contract.js';
// One implementation of "which part did they mean",
// shared with the headset page's own spoken grammar.
// @ts-ignore Shared JavaScript science module.
import { resolveEmphasisPartId, DEFAULT_CONTEXT_OPACITY } from '../../lab/browser-roundtrip/lesson-emphasis.mjs';
import { inspectionResidueKeys, inspectionResiduePage } from './inspection-residues.js';
import { inspectionSourcePdbId, extractInspectionCatalogBytes } from './inspection-catalog.js';
import { InspectionCommands, UtteranceBindingError, tourCommandSentence, wearerKeptSentence, wearerPausedNote, wearerStateText,
  wearerUnknownNote, type InspectionBinding, type WearerPage, type WearerPause } from './inspection-commands.js';
import { InspectionViews, MAX_INSPECTION_VIEWS } from './inspection-views.js';
// The captured referent, the shared undo history, and the change
// that takes one operation back.
import { captureRequestReferent, createRequestReferentStore, createReferentKeyStore, isReferentPronoun, referentSelection, validateRequestReferent, referentAppliedTo, bindVisibilitySelection,
  SceneHistory, undoChangeFor, redoChangeFor, resolveScopedAppearance, type SceneHistorySurface } from './inspection-operation.js';
import { compoundConfirmation, scopedStyleConfirmation, NOTHING_TO_UNDO, UNDO_CONFIRMATION } from './inspection-operation-words.js';
import { DEMO_INDEX_PATH, DEMO_TIER_BY_DEVICE, demoCoordinatePath, createGrowthCaptionMailbox, growthConfirmation, growthStageOfLesson,
  growthStages, readGrowthIndex, resolveGrowthTarget, stageSize, QUEST2_ATOM_SITE_CEILING } from './molecular-growth.js';
import { ensureGrowthCoordinates, growthRecoveryCommand } from './growth-coordinates.js';
import { PANEL_BUSY_MESSAGE } from './command-in-flight.js';
import { InspectionCompanionHttp } from './inspection-companion-http.js';
import { SourceRetargetQueue } from './source-retarget-queue.js';
import { InspectorPanelHost } from './inspector-panel-host.js';
import { markHostOpenedUrl } from './renderer-tab.js';
import { createHeadsetCaptionQueue, estimateHeadsetSpeechSeconds, type HeadsetCaptionRejection,
  type HeadsetCaptionScopeMismatch, type HeadsetCaptionScopeMiss,
  normalizeHeadsetCaption, sayToHeadsetSchema, splitHeadsetSpeech,
  HEADSET_CAPTION_DEFAULT_HOLD_SECONDS, HEADSET_CAPTION_DELIVERY_WAIT_MS, HEADSET_REPLY_MAX_CHARS, HEADSET_REPLY_MAX_SECONDS,
  HEADSET_REPLY_MAX_WORDS, HEADSET_REPLY_RENDER_BUDGET_MS, HEADSET_SPEECH_LIMIT,
  HEADSET_SPEECH_MAX_CHARS, HEADSET_SPEECH_MAX_SECONDS, HEADSET_SPEECH_MAX_WORDS, type SayToHeadsetInput, type HeadsetCaption } from './headset-captions.js';
import type { ReplyAudioSynthesizer } from './headset-reply-audio.js';
import { renderReplySpeech } from './reply-speech-render.js';
import { replyAudioFromEnv } from './headset-voice-provider.js';
import { createHeadsetDiagnosticsStore, readHeadsetLogSchema, formatDiagnosticLine, salvageDiagnosticEntries, READ_HEADSET_LOG_DEFAULT_LIMIT, type ReadHeadsetLogInput } from './headset-diagnostics.js';
import { createHeadsetViewStore, captureHeadsetViewSchema, defaultHeadsetViewPath, headsetViewFrameShape, unlitPageFrame,
  HEADSET_VIEW_DEFAULT_WIDTH, HEADSET_VIEW_MAX_WIDTH, HEADSET_VIEW_WAIT_MS, type CaptureHeadsetViewInput } from './headset-view.js';
import { detailedViewHandoff } from './detailed-view-contract.js';
import { detailedViewImport } from './detailed-view-import.js';
import { detailedViewAddress } from './detailed-view-page.js';
import { detailedViewReturn, detailedViewReturnSchema, stayedInMolstar } from './detailed-view-return.js';
import { detailedSelectionFrom, detailedSelectionSchema, detailedViewSummary, isWearerSurface,
  DETAILED_SELECTION_KEYS_SHOWN, DETAILED_SURFACE, type DetailedSelection } from './detailed-view-session.js';
import { readDetailedViewSnapshotFile } from './detailed-view-file.js';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { captureDeviceView, DEVICE_ADB_TIMEOUT_MS, forceStopHeadsetBrowser, headsetBrowserHealth, resolveAdbTarget, spawnDeviceRunner,
  type DeviceCaptureHooks, type HeadsetBrowserHealth } from './headset-view-device.js';
import { readHeadsetDebugging } from './headset-readiness.js';
// The one press the server sends the headset browser.
import { enterHeadsetVr } from './headset-enter-vr.js';
import { DEVTOOLS_DEFAULT_PORT, DEVTOOLS_PORT_ENV_KEY, devtoolsPort, formatConsoleLine, forwardArguments, nodeDevtoolsTransport, readHeadsetBrowser, summarizeReading, withOwnedDevtoolsForward, type DevtoolsTransport } from './headset-devtools.js';
import { sweepLaunchTabs, sweepRestoredTabs, tabLiveness, type StripSweep } from './headset-tabs.js';
import { describeCertificateWarning, readCertificateWarning, type CertificateWarning } from './headset-certificate.js';
// One size-aware formula for how long a panel gets to draw.
import { panelWaitMs, PANEL_SAVE_WAIT } from '../scripts/panel-wait.js';
import { writeBridgeHeadsetView, type BridgeHeadsetViewInput } from './headset-bridge.js';
import { QuestLink } from './inspection-quest-link.js';
import { LanCompanion, CLIENT_ACTIVE_MS, shareMaxLifetimeMs, listLanAddresses, type ShareNotice } from './inspection-lan.js';
import { attemptLocalOpen, enterVrStep, resolveHeadsetLaunch, launchCompanion, launchFailure, resolveOpener, type LaunchAttempt, type LaunchReport, type LaunchTabs, type Opener, type QuestDevice, type Runner } from './quest-launch.js';
import { readInspectionDensityFile, readInspectionFile } from './inspection-file.js';
import { pushToTalkFromEnv, type PushToTalk } from './push-to-talk.js';
import { pushToTalkAudioSchema, pollVoiceTranscriptsSchema, listenVoiceSchema, LISTEN_VOICE_DEFAULT_SECONDS,
  PTT_POLL_MAX_WAIT_MS, pushToTalkTranscriberFromEnv,
  type PushToTalkTranscriber } from './push-to-talk-transcribe.js';
import { createSpeechSceneReader, MAX_REMEMBERED_ENTRY_CODES } from './speech-vocabulary.js';
import { z } from 'zod';
import { savedLessonPlayback } from './tour-player.js';
import { TOURS } from './tour-catalog.js';
import { tourActionSchema, cameraPose, isRecenterChange, INSPECTION_MODEL_CONTEXT_RESIDUE_LIMIT } from './inspection-contract.js';
import { inspectionCatalogTransport, inspectionCatalogWire, type InspectionCatalogTransport } from './inspection-catalog-codec-server.js';
import { readStructureViewerSceneFiles, sceneImportMatchesSavedScene, structureViewerImportTargetSchema, type StructureViewerSceneFileBundle } from './inspection-scene-file.js';
import { readBoundedJsonFile } from './inspection-scene-file.js';
import { nativeSceneExportSchema, readNativeStructureViewerExports } from './structure-viewer-export-files.js';
import { importStructureViewerScene, preflightInspectionScene, type InspectionScenePreflight } from './inspection-scene-import.js';
import { molecularLessonToTour } from './molecular-lesson-tour.js';
import { parseMolecularLesson, type MolecularLessonManifest } from './molecular-lesson.js';
import { nativeStructureViewerHandoff, SOURCE_ONLY_HANDOFF_DISCLOSURE } from './native-structure-viewer-handoff.js';
import type { VoiceTranscriber } from './inspection-voice.js';
import type { Tour } from './tour-player.js';
import { experienceById, stageForStep, validateExperienceAssembly, CATALOG_ENTRY_CODES, CATALOG_ENTRY_NAMES, MOLECULAR_EXPERIENCES, type MolecularExperience, type MolecularExperienceStage } from './molecular-experience.js';
import { experienceGeometry, chapterBudget, catalogChapterBudget, chapterBudgetNotice, type ExperienceGeometry } from './experience-budget.js';

type Cache = { structureText:string; format:'pdb'|'mmcif'; pdbId?:string; sourceKind?:StructureSourceRequest['kind']; sourceSelection?:StructureSelection };
type SceneImport = { bundle:StructureViewerSceneFileBundle; resolvedScene?:InspectionScene; preflight?:InspectionScenePreflight };
type ExperienceRuntime = { experience:MolecularExperience; revision:number; stepIndex:number; stage:MolecularExperienceStage; sourceSha256?:string; cache?:Cache;
  returnView?:{cache:Cache;attachment:Attachment};
  acknowledgements:Map<string,{revision:number;stepIndex:number;sourceToken:string}> };
type ExperienceCompletion = { token:string; experienceId:string; revision:number; stepIndex:number;
  status:'pending'|'rendered'; savedRevision?:number };
type TransitionTarget = { panelId:string; expiresAt:number };
/**
 * The density map a volume tier is drawn from.
 *
 * It hangs off the attachment rather than off the structure cache for the same
 * reason `customTour` does: an attachment is minted once per source cache and
 * dies with it, so a plain source replacement drops the map automatically and a
 * map can never outlive the coordinates it was opened beside. `sha256` is the
 * digest of exactly these bytes, re-checked on the way out of `/density` and
 * again on the page; `contour` is the absolute level the lesson was authored
 * at, carried so the page never has to infer one.
 */
/**
 * `triangles` is the count the DEMO INDEX records for this
 * map's isosurface, present only where a tier was grown from the index. It is
 * the Mac's declared number, not a measurement: the page measures the mesh it
 * actually built and reports that on its own diagnostics ring.
 */
export type ComparisonAsset = {source:StructureSourceRequest;sources:StructureSourceRequest[];id:string;cif:string;sha256:string;catalog:any};
type DensityAsset = { bytes:Buffer; sha256:string; contour:number; filename:string; triangles?:number };
/**
 * `history` is the shared undo stack.
 *
 * It hangs off the attachment for the same reason the colour key and the
 * density map do: an attachment is minted once per source cache and dies with
 * it, so a scene recorded against one structure can never be restored onto
 * another. Every surface commits through this host, so this is the one place
 * that sees a headset command, a desktop panel's manual edit and an agent tool
 * in the order they actually happened.
 */
type ExperienceRollback = { token:string; panelId:string; cache:Cache; attachment:Attachment;
  experience?:ExperienceRuntime; expectedStateRevision:number; expectedInspectionRevision:number };
type Attachment = { initialSourceAdvisories?:Map<string,SourceRenderReceipt>; sourceFailureReadyAt?:number; experienceCompletion?:ExperienceCompletion; reconciledExperienceId?:string; experienceRollback?:ExperienceRollback; sourceRenderWait?:SourceRenderWait; sourceOperation?:OperationContract; sourceToken:string; catalog:any; transport:InspectionCatalogTransport; revision:number; scene:InspectionScene|null; commands:InspectionCommands; history:SceneHistory; views:InspectionViews; shared?:boolean; sceneImport?:SceneImport; customTour?:Tour; density?:DensityAsset; nativeLocalFile?:{filePath:string;sourceSha256:string}; experience?:ExperienceRuntime; transitionTarget?:TransitionTarget;
  /** Stop retires headset access; a returning desktop still follows the saved scene. */
  followStoppedShare?:boolean;
  /**
   * The leg `return_detailed_view` has handed to a panel, while its receipt is
   * still outstanding. Every leg gets one of these, not only the last: read
   * `stereo_structure.return_detailed_view` below, where an earlier leg with no
   * record was what let a busy panel be read as no panel at all. A queued
   * command is not a rendered one, and the detailed page navigates away on the
   * press that reports nothing left.
   */
  comparisonAssets?:Map<string,ComparisonAsset>;
  sourceContinuation?:{commands:InspectionCommands;previous:InspectionBinding;utteranceId?:string;panelId:string;
    stateRevision:number;modelNumber:number;assemblyId:string;shared?:boolean};
  detailedReturn?:{commandId:string; leg:string};
  /**
   * What the wearer has picked inside the full Mol*
   * viewer, mapped onto this catalog's own residue identities.
   *
   * It is not the saved selection and never becomes one. The saved scene is
   * what a panel has rendered; this is a person pointing at something while
   * they ask about it, so "what is this" has a referent before anything is
   * committed. It hangs off the attachment so it dies with the coordinates it
   * names, exactly like `density` and `customTour`.
   */
  detailedSelection?:DetailedSelection };
/**
 * Everything the headset-launch routes touch outside this process, so a test
 * can prove a launch without opening a browser or shelling out to adb. Left
 * unset, the real desktop opener and the real adb search are used.
 */
type LaunchHooks = { platform?:string; environment?:NodeJS.ProcessEnv; opener?:string; launch?:Opener; run?:Runner; find?:()=>string|undefined; recheckMs?:number; clipboardSpawn?:Parameters<typeof launchCompanion>[0]['clipboardSpawn'] };
/** A slow safety read catches expiry and attachment replacement without receipt events. */
const COMMAND_WAIT_SAFETY_POLL_MS = 1_000;
/** The follow-up a queued command's sentence asks for, which a call that waited has already done. */
const RECEIPT_ADVICE = /\s*(?:Check get_inspection_state with this commandId for its rendered receipt\.|Say that only once the receipt says rendered: check get_inspection_state with this commandId\.)/gu;
type Hooks = { serverEpoch:string; htmlPath:string; open:(input:unknown)=>Promise<any>;
  current:(sessionId:string)=>{structureCache?:Cache; stateRevision:number}; now?:()=>number; pushToTalk?:PushToTalk; transcriber?:PushToTalkTranscriber;
  /** Whether a session is still held, asked without counting as a use of it; the panel host sweeps its page keys with it. */
  live?:(sessionId:string)=>boolean;
  /** Who to tell when the store drops a session, by expiry or for capacity. */
  sessionEnded?:(listener:(sessionId:string)=>void)=>void;
  voice?: { transcribe?: VoiceTranscriber; acknowledge?: (message:string)=>Promise<{wavBase64:string}> };
  /** Test seam; production renders headset reply audio with macOS `say` and ffmpeg. */
  replyAudio?:ReplyAudioSynthesizer;
  /** Test seam for the adb screencap still. Unset, the real `adb` and `ffmpeg` are used. */
  headsetDevice?:DeviceCaptureHooks;
  /** The debugger transport, replaced in tests so nothing opens a socket. */
  headsetDevtools?:DevtoolsTransport;
  /** Where `STEREOFOLD_BRIDGE_DIR` is read from. Unset, this process's environment. */
  environment?:NodeJS.ProcessEnv;
  questLaunch?:LaunchHooks;
  /**
   * The one shared scene on this Mac, if the host made one.
   * Unset, this server keeps a private service that publishes nothing until
   * someone asks to continue a session or opens a companion share.
   */
  scene?:LocalSceneService;
  loopbackListenDenied?:()=>Promise<boolean>;
  resolveComparisonSource?:(source:StructureSourceRequest,signal?:AbortSignal)=>Promise<ResolvedStructureSource>;
  openVerifiedSource?:(input:{sessionId?:string;source:StructureSourceRequest;selection?:StructureSelection;verify:(structureText:string)=>Promise<void>|void;signal?:AbortSignal;beforeCommit?:()=>void;committed?:()=>void})=>Promise<any>;
  restoreSource?:(input:{sessionId:string;expectedCache:Cache;cache:Cache})=>unknown;
  openVerifiedPdb?:(input:{sessionId:string;pdbId:string;verify:(structureText:string)=>Promise<void>|void})=>Promise<any>;
  /** The same atomic replacement for a local file, which a derived growth tier is. */
  openVerifiedLocal?:(input:{sessionId:string;structureText:string;pdbId?:string;verify:(structureText:string)=>Promise<void>|void})=>Promise<any> };
/**
 * The map a lesson declares, read and checked against it.
 *
 * A lesson with `coordinates.kind === 'volume'` draws a density map and nothing
 * else, so it is refused rather than opened without one: the alternative is a
 * wearer in immersion looking at coordinates whose captions describe a map. The
 * digest is the lesson's own, so the level and the bytes are checked against
 * one authored record rather than against each other.
 */
async function readLessonDensity(manifest:MolecularLessonManifest, densityPath:string|undefined):Promise<DensityAsset|undefined> {
  const coordinates=manifest.coordinates;
  if(coordinates?.kind!=='volume') {
    if(densityPath) throw Error('This lesson draws coordinates, not a density map, so it takes no densityPath.');
    return undefined;
  }
  if(!densityPath) throw Error(`This lesson draws the density map ${coordinates.ref}. Supply densityPath with that prepared map.`);
  const {bytes,filename}=await readInspectionDensityFile(densityPath);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(sha256!==coordinates.sha256.toLowerCase())
    throw Error('The density map does not match the digest the lesson records for it.');
  return {bytes,sha256,contour:coordinates.contour,filename};
}
/**
 * How long an agent counts as attached after it last acted.
 *
 * `listen_voice` blocks for up to 25 seconds and `poll_voice_transcripts` for
 * 15, so an agent that is genuinely waiting on the wearer refreshes this well
 * inside the window even when the wearer says nothing at all. Wider than that
 * and a headset would keep promising a listener minutes after the agent had
 * gone; narrower and an ordinary long poll would flicker.
 */
export const AGENT_PRESENCE_WINDOW_MS = 90_000;
/**
 * The shortest gap between two Meta Web Launch sends.
 *
 * The wearer needs time to see the page, press Open once and put the headset
 * on. A minute is long enough for that and for a slow first paint of the
 * companion, and short enough that a genuine retry after a failed launch is not
 * an annoyance.
 */
export const WEB_LAUNCH_DEBOUNCE_MS = 60_000;

/**
 * Build the compact model-facing projection from server-owned inspection
 * values. This deliberately does not expose canonical keys, coordinates or
 * the full readiness diagnostic; the app can publish it on every authoritative
 * tool result without duplicating any molecular or lesson state.
 */
export function createInspectionModelContext(input:{
  selectionKeys:readonly string[];
  catalog:{rows?:ReadonlyArray<{key?:string;identity?:Record<string,unknown>}>};
  lesson?:{id:string;title:string}|null;
  chapter?:{id:string;title:string;index:number;total:number}|null;
  emphasis?:{parts?:ReadonlyArray<{id?:string;label?:string}>;focus?:ReadonlyArray<string>}|null;
  readiness:InspectionReadinessSummary;
}):InspectionModelContext {
  const rowsByKey=new Map((input.catalog.rows??[]).flatMap(row=>row.key ? [[row.key,row] as const] : []));
  const residues=input.selectionKeys.slice(0,INSPECTION_MODEL_CONTEXT_RESIDUE_LIMIT).map((key,index)=>{
    const identity=rowsByKey.get(key)?.identity;
    if(!identity) return `selected residue ${index+1}`;
    const chain=typeof identity.labelChain==='string' && identity.labelChain
      ? identity.labelChain
      : typeof identity.authorChain==='string' && identity.authorChain ? identity.authorChain : '?';
    const sequence=identity.labelSequenceId ?? identity.authorResidue ?? '?';
    const insertion=typeof identity.insertionCode==='string' ? identity.insertionCode : '';
    const component=typeof identity.componentId==='string' && identity.componentId ? `:${identity.componentId}` : '';
    return `${chain}:${String(sequence)}${insertion}${component}`.slice(0,96);
  });
  const parts=input.emphasis?.parts??[];
  const focus=input.emphasis?.focus??[];
  const lit=input.emphasis
    ? (focus.length ? focus.map(id=>parts.find(part=>part.id===id)?.label??id) : parts.map(part=>part.label??part.id??'named part'))
      .filter((label,index,all)=>Boolean(label) && all.indexOf(label)===index).slice(0,8)
    : null;
  return inspectionModelContextSchema.parse({
    selection:{count:Math.min(input.selectionKeys.length,20_000),residues,truncated:input.selectionKeys.length>residues.length},
    lesson:input.lesson ? {...input.lesson,title:input.lesson.title.slice(0,160)} : null,
    chapter:input.chapter ? {...input.chapter,title:input.chapter.title.slice(0,160)} : null,
    emphasis:lit ? {lit} : null,
    readiness:input.readiness,
  });
}

/** A model-facing hint must never turn an otherwise valid tool result into an error. */
export function optionalInspectionModelContext(build:()=>InspectionModelContext):InspectionModelContext|undefined {
  try { return build(); }
  catch { return undefined; }
}
const ui = { resourceUri:INSPECTION_RESOURCE_URI, csp:{resourceDomains:['blob:','data:']}, prefersBorder:false };
const privateUi = { ui:{visibility:['app']} };
/** The longest open_companion waits for a launched headset page to attach and draw. */
const HEADSET_PAGE_WAIT_CEILING_MS = 60_000;
/** Leave time for listener setup and a result before Codex's 60-second MCP deadline. */
const HOST_TOOL_WAIT_CEILING_MS = 40_000;
const OPEN_COMPANION_CALL_CEILING_MS = 45_000;
/** Each refusal of `placement {recenter:true}` names the next step. */
const RECENTER_NEEDS_HEADSET = 'placement {recenter:true} runs the headset\'s own Reset, and this edit would go to the Mac panel, which has no wearer. '
  + 'Open the headset page with open_companion, or ask the person to press Fit molecule on the Mac.';
const RECENTER_NEEDS_VR = 'The headset page is on its flat view, not in VR, so there is no room to recentre the structure in. '
  + 'Enter VR first: manage_companion action="enter-vr" presses Enter VR over a USB debugging cable; without one, ask the wearer to tap Enter VR.';
const RECENTER_WAIT_FOR_VR = 'The headset page has not recently reported visible VR frames, so there is no current view to recentre. '
  + 'Wait for get_inspection_state to report wearer.state "in-vr", then send recenter again.';
/**
 * How a desktop panel takes delivery of the coordinates and
 * the compressed catalog.
 *
 * `transport:'chunked'` replaces both with `{sha256,bytes}` descriptors and the
 * panel pulls the bytes through `get_inspection_bytes`. The headset keeps the
 * inline shape, because its coordinates already come off the LAN `/source`
 * route and its catalog rides one local HTTP body.
 */
const getInspectionInputSchema = getStructureInputSchema.extend({
  transport: z.enum(['inline','chunked']).optional(),
}).strict();
const inspectionBytesInputSchema = z.object({
  sessionId: sessionIdSchema,
  part: z.enum(['source','catalog']),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  byteCount: z.number().int().min(1).max(MAX_INSPECTION_CHUNK_BYTES),
  /** Reads a comparison structure's part instead of the primary's. */
  comparison: z.object({sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),assemblyId:z.string().min(1).max(128)}).strict().optional(),
}).strict();
const inspectionPartDigest = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');
/**
 * The chunked form of one attachment's catalog: always a wire, never the inline
 * object, so the panel has one path rather than a behaviour change at a size
 * threshold. Cached against the transport, which is fixed for the life of an
 * attachment, so the descriptor and every later chunk read the same bytes.
 */
const chunkedCatalogs = new WeakMap<object,{wire:any;bytes:Buffer;sha256:string}>();
/**
 * The source as bytes, digested once per structure cache rather than once per
 * chunk call. The digest is computed here rather than taken from the catalog's
 * own `source.sha256`, so that the panel's check of the descriptor against the
 * catalog stays a real cross-check.
 */
const chunkedSources = new WeakMap<object,{bytes:Buffer;sha256:string}>();
function chunkedText(owner:object, text:string) {
  let entry=chunkedSources.get(owner);
  if(!entry) { const bytes=Buffer.from(text,'utf8'); entry={bytes,sha256:inspectionPartDigest(bytes)}; chunkedSources.set(owner,entry); }
  return entry;
}
const chunkedSource = (cache:any) => chunkedText(cache,cache.structureText);
function chunkedCatalog(transport:any) {
  let entry=chunkedCatalogs.get(transport);
  if(!entry) {
    const {catalogWire}=transport?.catalogWire?transport:inspectionCatalogWire(transport.catalog);
    const {data:encoded,...wire}=catalogWire;
    const bytes=Buffer.from(encoded,'base64');
    entry={wire,bytes,sha256:inspectionPartDigest(bytes)};
    chunkedCatalogs.set(transport,entry);
  }
  return entry;
}
function inspectionCatalogDescriptor(transport:any) {
  const {wire,bytes,sha256}=chunkedCatalog(transport);
  return {catalogWire:wire,catalogBytes:{sha256,bytes:bytes.byteLength}};
}
/**
 * What a hydration or heartbeat carries for one comparison structure: its
 * identity and `{sha256,bytes}` descriptors for the coordinates and the
 * compressed catalog, never the bytes. The panel and the headset page pull
 * both through `get_inspection_bytes` with `{sourceSha256,assemblyId}`, so a
 * comparison needs no inline budget of its own.
 *
 * Both parts are encoded once per asset and kept beside it, so a save, a
 * heartbeat or a budget check does not re-serialise and re-compress the whole
 * catalog. The bounds the chunk client enforces are checked here too, so a
 * comparison this host could not deliver is refused when it is requested, not
 * when the panel tries to read it.
 */
export function comparisonDescriptor(asset:ComparisonAsset) {
  const coordinates=chunkedText(asset,asset.cif);
  if(coordinates.bytes.byteLength>MAX_STRUCTURE_SOURCE_BYTES)
    throw Error(`The comparison source is ${(coordinates.bytes.byteLength/1_000_000).toFixed(1)} MB, over the ${STRUCTURE_SOURCE_SIZE_LABEL} this plugin accepts. ${INSPECTION_SIZE_GUIDE}`);
  const {wire,bytes,sha256}=chunkedCatalog(asset);
  if(bytes.byteLength>MAX_INSPECTION_CATALOG_COMPRESSED_BYTES)
    throw Error(`The comparison catalog is ${(bytes.byteLength/1_000_000).toFixed(1)} MB compressed, over what one browser decodes. ${INSPECTION_SIZE_GUIDE}`);
  return {id:asset.id,sha256:asset.sha256,assemblyId:asset.catalog.assemblyId as string,
    sourceBytes:{sha256:coordinates.sha256,bytes:coordinates.bytes.byteLength},
    catalogWire:wire,catalogBytes:{sha256,bytes:bytes.byteLength}};
}
export function registerInspection(server:McpServer, hooks:Hooks) {
  let hostBuild:string|null=null;
  const hostBuildReady=readStampedBuildId(hooks.htmlPath).then(build=>{hostBuild=build;});
  // A page that sent no build predates the reload, so only the wearer can update it.
  const outdatedPageNote=(pageBuild:string|undefined)=>pageBuild
    ?'The headset page runs an older Stereofold build, so new controls such as recenter may fail. It reloads itself after the wearer leaves VR and local work finishes; the wearer can reload the Stereofold page sooner.'
    :'The headset page runs an older Stereofold build that cannot update itself, so new controls such as recenter fail. Ask the wearer to reload the Stereofold page, or close it and launch again.';
  const handlers = new Map<string,{schema:{parseAsync:(input:unknown)=>Promise<any>};handle:(input:any)=>Promise<any>}>();
  /**
   * Who owns the scene these tools read and change.
   *
   * The service is silent until `continue_session` asks it to share or a Wi-Fi
   * share offers it, so a host that does neither binds no port and writes no
   * file. Once two hosts share one scene, exactly one of them holds the state
   * and the other posts every session-bound call to it, which is why this wraps
   * registration rather than each tool: a proxied session must not find a
   * second, emptier scene here.
   */
  const scene = hooks.scene ?? new LocalSceneService({serverEpoch:hooks.serverEpoch,
    live:(id:string)=>{ try { return Boolean(hooks.current(id)); } catch { return false; } }});
  const assistants = createAssistantOwnership({...(hooks.now?{now:hooks.now}:{})});
  /**
   * Every tool registered here by short name, for the loopback
   * panel host to call the way an MCP Apps host forwards the mounted panel's
   * calls, and the render token of each session's last `inspect`, which is
   * what that panel mounts with.
   */
  const panelHandlers = new Map<string,{schema:{parseAsync:(input:unknown)=>Promise<any>};handle:(input:any)=>Promise<any>}>();
  const lastRenderToken = new Map<string,number>();
  /**
   * Model-facing edits publish a schema whose binding fields are optional, and
   * are typed and handled as the strict one: `fillImplicitBinding` supplies
   * what the caller left out before any other code reads the input. A dictated
   * "color chain A orange" is then one call, not a state read, six copied
   * fields and a second call.
   */
  type FieldSchema = {safeParse:(value:unknown)=>{success:boolean}};
  const implicitBindingShapes = new Map<object,Record<string,FieldSchema>>();
  function implicitBinding<T>(strict:T, relaxed:unknown=withImplicitBinding(strict as any)):T {
    implicitBindingShapes.set(relaxed as object,(strict as any).shape);
    return relaxed as T;
  }
  function failedSourceOwnerReady(data:Awaited<ReturnType<typeof current>>,panelId:string) {
    const a=data.attachment,c=a.sourceContinuation,r=a.sourceRenderWait?.settled();
    return !a.scene && r?.status==='failed' && r.sourceToken===a.sourceToken && r.panelId===panelId
      && c?.panelId===panelId && a.transitionTarget?.panelId===panelId
      && a.sourceFailureReadyAt!==undefined && (hooks.now??Date.now)()-a.sourceFailureReadyAt<10_000
      && !a.commands.hasPending({serverEpoch:hooks.serverEpoch,sourceToken:a.sourceToken,
        stateRevision:data.stateRevision,inspectionRevision:a.revision})
      && a.commands.surfaceOf(panelId)!==undefined;
  }
  async function fillImplicitBinding(input:any, shape:Record<string,FieldSchema>, tool:string, admitted?:InspectionBinding) {
    if(typeof input?.sessionId!=='string') return input;
    const missing=IMPLICIT_BINDING_FIELDS.filter(key=>input[key]===undefined && shape[key] && !shape[key].safeParse(undefined).success);
    if(!missing.length) return input;
    const data=await current(input.sessionId), b=admitted??binding(input.sessionId,data);
    const now:Record<string,unknown>={serverEpoch:b.serverEpoch,sourceToken:b.sourceToken,
      baseStateRevision:b.stateRevision,baseInspectionRevision:b.inspectionRevision};
    const filled={...input};
    for(const key of missing) filled[key]=key==='panelId'?defaultPanelId(input.sessionId,data,tool)
      :key==='commandId'?`auto-${randomUUID().slice(0,8)}`:now[key];
    return filled;
  }
  /**
   * The edits aimed at a paused headset page rather than past it.
   *
   * The first three are saved for the page when their change can be saved;
   * focus_selection and control_tour are refused with the reason. Either way
   * the answer is about the wearer, which a render on this Mac's panel is not.
   */
  const WEARER_FIRST_TOOLS=new Set(['update_inspection','emphasize','undo_last_change','redo_last_change','focus_selection','control_tour']);
  // A transport can retry before the first call has resolved implicit bindings
  // and remembered its receipt. Share that admission, including its render
  // wait, so the retry cannot become a second edit or an unrelated refusal.
  // Entries live only until the call settles; retained receipts handle later retries.
  const editAdmission=new InspectionEditAdmission();
  const editAdmissionSignal=Symbol();
  const admittingToolRequests=new Map<string,{tool:string;fingerprint:string;answer:Promise<any>}>();
  /** The wearer's panel when one is current, else this Mac's, never the detailed viewer. */
  function defaultPanelId(id:string, data:Awaited<ReturnType<typeof current>>, tool='') {
    const b=binding(id,data);
    reconcilePairedPanels(data,b);
    // A paused headset page is the target even when it is behind the saved
    // revision, because it has not yet drawn an edit kept for it, and even
    // when the panel list has dropped it for silence.
    const paused=data.attachment.shared && WEARER_FIRST_TOOLS.has(tool)
      ? data.attachment.commands.pausedWearerPanel(b) : undefined;
    if(paused) return paused;
    const failedPanel=data.attachment.sourceContinuation?.panelId;
    if(tool==='replace_inspection_source' && failedPanel && failedSourceOwnerReady(data,failedPanel)) return failedPanel;
    const panels=data.attachment.commands.summary(b).panels
      .filter(panel=>panel.current && panel.availability!=='unsaved' && panel.surface!=='detailed');
    const wearer=data.attachment.commands.wearerPage(b);
    const panel=panels.find(entry=>entry.panelId===wearer.panelId) ?? panels.find(entry=>isWearerSurface(entry.surface)) ?? panels.find(entry=>entry.surface==='desktop') ?? panels[0];
    // On a headset share the usual cause is a headset page still loading
    // while the Mac tab is behind Meta's Web Launch page. Reconnecting would
    // open Web Launch in front of that tab again.
    if(!panel) throw Error(data.attachment.shared
      ? 'No panel is ready to draw this change. No headset page is ready, and neither is this Mac\'s inspector tab: '
        +'the browser pauses that tab while another tab or window hides it. Try again once the headset shows the structure, '
        +'or ask the user to bring the Stereofold tab on this Mac to the front. If the headset shows no Stereofold page, reconnect it with open_companion.'
      : 'No panel is ready to draw this change. Open the inspector with open_inspector, or reconnect the headset with open_companion, then try again.');
    return panel.panelId;
  }
  /**
   * Follow an admitted command to its receipt inside the call that queued it,
   * so the agent reports a render without a second turn. A committed receipt
   * wakes this wait; a slow read catches expiry or attachment replacement.
   */
  async function awaitCommandReceipt(sessionId:string, answer:any, waitMs:number) {
    const deadline=Date.now()+Math.min(waitMs,HOST_TOOL_WAIT_CEILING_MS);
    const queued=answer.structuredContent.command;
    let receipt=queued, checkedInMsAgo=0;
    try {
      const initial=await current(sessionId);
      let version=0, wake:(()=>void)|undefined;
      const off=initial.attachment.commands.onReceiptChange(queued.commandId,()=>{version++;wake?.();});
      try {
        while((receipt.status==='queued'||receipt.status==='rendering') && Date.now()<deadline) {
          const before=version;
          try {
            // `current` saves this edit if its page paused while it waited.
            const data=await current(sessionId);
            receipt=data.attachment.commands.summary(binding(sessionId,data),queued.commandId).command;
            if(receipt.status==='saved') {
              const at=data.attachment.commands.wearerPage(binding(sessionId,data)).checkedInAt;
              checkedInMsAgo=at===undefined?0:Math.max(0,(hooks.now??Date.now)()-at);
            }
          } catch { break; }
          if(receipt.status!=='queued' && receipt.status!=='rendering') break;
          if(version!==before) continue;
          await new Promise<void>(resolve=>{
            const timer=setTimeout(done,Math.min(COMMAND_WAIT_SAFETY_POLL_MS,Math.max(0,deadline-Date.now())));
            function done() {clearTimeout(timer);wake=undefined;resolve();}
            wake=done;
            if(version!==before) done();
          });
        }
      } finally {off();}
    } catch { /* The queued result still names the command if the session expired. */ }
    // A waiter must return the history and binding after the receipt, rather
    // than the admission state whose Undo/Redo counts preceded the render.
    // Keep a replaced source's original identity with its historical receipt.
    let settledState:Record<string,unknown>|undefined;
    try {
      const data=await current(sessionId);
      if(data.attachment.sourceToken===answer.structuredContent.sourceToken && hooks.serverEpoch===answer.structuredContent.serverEpoch) {
        receipt=data.attachment.commands.summary(binding(sessionId,data),queued.commandId).command;
        settledState=result(sessionId,data).structuredContent;
      }
    } catch { /* An expired session still returns the retained command receipt. */ }
    const text=String(answer.content?.[0]?.text ?? '').replace(`command ${queued.status}`,`command ${receipt.status}`);
    const sentence=receipt.status==='rendered'
      ? text.replace(RECEIPT_ADVICE,'').trim()+' The panel rendered and saved it.'
      : receipt.status==='saved'
        ? wearerKeptSentence({reason:receipt.wearerPaused,checkedInMsAgo})
      : receipt.status==='queued'||receipt.status==='rendering'
        ? `${text} The wait ended before the render did.`
        // A host that shows the model only this text never sees the receipt's
        // detail, and `render_failed` alone left one agent guessing at the cause.
        : `${text.replace(RECEIPT_ADVICE,'').trim()} It did not render: ${receipt.reason ?? receipt.status}.`
          +(receipt.detail?` The panel said: ${receipt.detail}`:'');
    return {...answer,content:[{type:'text' as const,text:sentence},...(answer.content?.slice(1)??[])],
      structuredContent:{...answer.structuredContent,...settledState,command:receipt}};
  }
  const registerAppTool=((target:any,name:string,config:any,handle:(input:any)=>Promise<any>)=>{
    const short=name.replace('stereo_structure.','');
    const original = handle;
    const implicitShape = implicitBindingShapes.get(config?.inputSchema);
    // Every dispatched wearer mutation uses the same refusal path, including
    // source preflight failures that never enter the render-command queue.
    const wearerCommand = config.annotations?.readOnlyHint !== true && !isInspectionBookkeepingTool(short)
      && !/^(?:poll_|attach_|detach_|complete_|acknowledge_|claim_|sync_|submit_|report_|push_to_talk|say_to_headset$)/u.test(short);
    const admit = async (received:any, admissionBinding?:InspectionBinding, active?:AbortSignal, deferReceiptWait=false) => {
      active?.throwIfAborted();
      const callStarted=Date.now();
      // Transport retries name their first command, even after a manual edit,
      // panel reconnect or source swap. Resolve that receipt before filling
      // omitted bindings or interpreting "the selection" against today's view.
      let requestCommands:InspectionCommands|undefined;
      if(implicitShape && WEARER_FIRST_TOOLS.has(short) && received?.change?.kind!=='utterance'
        && typeof received?.sessionId==='string') {
        const data=await current(received.sessionId),b=binding(received.sessionId,data);
        requestCommands=data.attachment.commands;
        const replay=requestCommands.retryToolRequest(short,received,b);
        if(replay) {
          const {command,originalBinding}=replay;
          const sourceNote=originalBinding.sourceToken===b.sourceToken?'':' This receipt belongs to an earlier source.';
          if(!command) return result(received.sessionId,data,{...(short==='redo_last_change'?{redone:false}:replay.outcome),commandId:replay.commandId,
            commandReplay:{originalBinding,currentSource:originalBinding.sourceToken===b.sourceToken}},
            `The original ${short==='redo_last_change'?'redo':'undo'} found no operation to ${short==='redo_last_change'?'reapply':'take back'}. This retry submitted no new change.${sourceNote}`);
          const answer=result(received.sessionId,data,{command,...(short==='undo_last_change'?{undone:true}:short==='redo_last_change'?{redone:true}:{}),
            commandReplay:{originalBinding,currentSource:originalBinding.sourceToken===b.sourceToken}},
            command.status==='rendered'
              ? `The original command rendered and saved at revision ${command.renderedRevision}. This retry submitted no new change; the current scene may have changed.${sourceNote}`
              : `Original command ${command.status}. This retry submitted no new change.${sourceNote} Check get_inspection_state with this commandId for its rendered receipt.`);
          return typeof received.waitForRenderMs==='number' && received.waitForRenderMs>0
            && (command.status==='queued'||command.status==='rendering')
            ? await awaitCommandReceipt(received.sessionId,answer,received.waitForRenderMs) : answer;
        }
      }
      // Filled first, so refusals, the tool itself and a proxied owner all read one whole binding.
      const input=implicitShape?await fillImplicitBinding(received,implicitShape,short,admissionBinding):received;
      active?.throwIfAborted();
      if(active)Object.defineProperty(input,editAdmissionSignal,{value:active,enumerable:true});
      const bindingRefusalOwner=wearerCommand?utteranceBindingRefusalOwner(input):undefined;
      const previousSerial=refusalSerials.get(input?.sessionId) ?? 0;
      const serial = wearerCommand && typeof input?.sessionId === 'string'
        ? previousSerial + 1 : undefined;
      let ownsSerial=false;
      if (serial !== undefined && (!input.utteranceId || replyUtteranceAdmission(input.utteranceId).accepted)) {
        refusalSerials.set(input.sessionId, serial);
        ownsSerial=true;
        while (refusalSerials.size > 32) refusalSerials.delete(refusalSerials.keys().next().value!);
      }
      const replyOrder = newestReply;
      try {
        const answer=await original(input);
        const command=answer?.structuredContent?.command;
        if(command?.commandId) requestCommands?.rememberToolRequest(short,received,command.commandId);
        else if((short==='undo_last_change' && answer?.structuredContent?.undone===false)
          || (short==='redo_last_change' && answer?.structuredContent?.redone===false))
          requestCommands?.rememberToolNoop(short,received,input);
        if(serial!==undefined && (command?.status==='queued'||command?.status==='rendering')) {
          try {
            const data=await current(input.sessionId), commands=data.attachment.commands;
            let pending=commandRefusals.get(commands);
            if(!pending) commandRefusals.set(commands,pending=new Map());
            if((pending.get(command.commandId)?.serial??0)<serial)
              pending.set(command.commandId,{name:short,input:structuredClone(input),serial,replyOrder});
          } catch { /* An expired session cannot turn an admitted command into an error. */ }
        }
        // A source swap has its own render wait with its own budget.
        if(!deferReceiptWait && typeof input?.waitForRenderMs==='number' && input.waitForRenderMs>0 && short!=='replace_inspection_source'
          && (command?.status==='queued'||command?.status==='rendering'))
          return await awaitCommandReceipt(input.sessionId,answer,
            Math.max(0,Math.min(input.waitForRenderMs,OPEN_COMPANION_CALL_CEILING_MS-(Date.now()-callStarted))));
        return answer;
      }
      catch (error) {
        if (serial !== undefined) {
          // A recorded utterance can fail its binding before its transcript is
          // claimed. Explain that refusal for any command kind, while preserving
          // newer turns and leaving ordinary obsolete errors without ownership.
          if (!ownsSerial && error instanceof UtteranceBindingError && bindingRefusalOwner!==undefined
            && utteranceBindingRefusalOwner(input)===bindingRefusalOwner && newestReply===replyOrder
            && (refusalSerials.get(input.sessionId) ?? 0)===previousSerial) {
            refusalSerials.set(input.sessionId,serial);
            ownsSerial=true;
            while (refusalSerials.size > 32) refusalSerials.delete(refusalSerials.keys().next().value!);
          }
          try { await showCommandRefusal(short, input, error, ownsSerial?serial:undefined, replyOrder, false, bindingRefusalOwner); }
          catch { /* Delivery failure must preserve the host's original refusal. */ }
        }
        throw error;
      }
    };
    const ordinaryKinds=new Set(['appearance','placement','selection','styles','visibility','motion','emphasis','focus','render-quality']);
    const ordinaryChange=(change:any):boolean=>ordinaryKinds.has(change?.kind)
      || (change?.kind==='compound' && change.patch.ops.every((op:any)=>ordinaryKinds.has(op.kind)));
    const queuedAdmit=async(received:any,signal?:AbortSignal)=>{
      const implicit=implicitShape && typeof received?.sessionId==='string' && !received.utteranceId
        && ['serverEpoch','sourceToken','baseStateRevision','baseInspectionRevision'].every(key=>received[key]===undefined)
        && (short==='update_inspection'?ordinaryChange(received.change):['emphasize','focus_selection','undo_last_change','redo_last_change'].includes(short));
      if(!implicit) return admit(received);
      // Retained retries must not wait behind the command they are asking about.
      if(typeof received.commandId==='string') {
        const data=await current(received.sessionId);
        if(data.attachment.commands.retryToolRequest(short,received,binding(received.sessionId,data))) return admit(received);
      }
      return editAdmission.enqueue(received.sessionId,async(previous,publish,active,fail)=>{
        const data=await current(received.sessionId),before=binding(received.sessionId,data),commands=data.attachment.commands;
        active.throwIfAborted();
        if(previous===null || (previous && inspectionJson(previous)!==inspectionJson(before)))
          throw Error('The inspection changed outside the queued edits. No queued change was applied. Read get_inspection_state.');
        let answer:any;
        try {answer=await admit(received,before,active,true);} catch(error) {
          // A validation failure does not consume a revision or wedge the lane.
          // Publish the rejection but keep its exact base fence for successors.
          fail(error);return before;
        }
        active.throwIfAborted();
        const command=answer?.structuredContent?.command;
        // Once admitted, preserve the tool's bounded receipt wait even when
        // the admission lane's deadline ends. Never replace a known receipt
        // with a generic admission-timeout error.
        publish(received.waitForRenderMs>0 && (command?.status==='queued'||command?.status==='rendering')
          ? awaitCommandReceipt(received.sessionId,answer,received.waitForRenderMs) : answer);
        if(!command?.commandId)return before;
        let wake:(()=>void)|undefined;
        const off=commands.onReceiptChange(command.commandId,()=>wake?.());
        try {
          while(true) {
            active.throwIfAborted();
            const latest=await current(received.sessionId),now=binding(received.sessionId,latest);
            if(latest.attachment.commands!==commands || now.sourceToken!==before.sourceToken || now.serverEpoch!==before.serverEpoch)return null;
            const summary=commands.summary(now,command.commandId),receipt=summary.command;
            if(!summary.pendingCommand.some(c=>c.commandId===command.commandId)) {
              if(!receipt || receipt.status==='unknown')return null;
              const revision=receipt.status==='rendered' && 'renderedRevision' in receipt?receipt.renderedRevision
                :receipt.status==='saved' && 'savedRevision' in receipt?receipt.savedRevision:before.inspectionRevision;
              return {...before,inspectionRevision:revision??before.inspectionRevision};
            }
            await new Promise<void>(resolve=>{
              const done=()=>{clearTimeout(timer);active.removeEventListener('abort',done);wake=undefined;resolve();};
              const timer=setTimeout(done,COMMAND_WAIT_SAFETY_POLL_MS);wake=done;
              active.addEventListener('abort',done,{once:true});if(active.aborted)done();
            });
          }
        } finally {off();}
      },signal);
    };
    handle=async (received:any,extra?:{signal?:AbortSignal})=>{
      if(!implicitShape || !WEARER_FIRST_TOOLS.has(short) || received?.change?.kind==='utterance'
        || typeof received?.sessionId!=='string' || typeof received?.commandId!=='string') return queuedAdmit(received,extra?.signal);
      const key=JSON.stringify([received.sessionId,received.commandId]),fingerprint=inspectionJson(received);
      const previous=admittingToolRequests.get(key);
      if(previous) {
        if(previous.tool!==short || previous.fingerprint!==fingerprint)
          throw Error('This commandId was already used for a different request.');
        return previous.answer;
      }
      const pending={tool:short,fingerprint,answer:queuedAdmit(received,extra?.signal)};
      admittingToolRequests.set(key,pending);
      try { return await pending.answer; }
      finally { if(admittingToolRequests.get(key)===pending) admittingToolRequests.delete(key); }
    };
    scene.register(short,handle);
    const originalSchema=typeof config?.inputSchema?.parse==='function'?config.inputSchema:z.object(config?.inputSchema ?? {});
    const schema=wearerCommand?observeVoiceRefusal(originalSchema,async(input,error)=>{
      if(typeof input.sessionId!=='string') return;
      const serial=(refusalSerials.get(input.sessionId)??0)+1;
      if(replyUtteranceAdmission(input.utteranceId).accepted) {
        refusalSerials.set(input.sessionId,serial);
        while(refusalSerials.size>32) refusalSerials.delete(refusalSerials.keys().next().value!);
      }
      await showCommandRefusal(short,input,new Error(voiceValidationSentence(short,input,error)),serial,newestReply);
    }):originalSchema;
    panelHandlers.set(short,{schema,handle});
    return registerHostTool(target,name,{...config,inputSchema:schema},(async(input:any,extra:any)=>{
      const forwarded=await scene.forward(short,input);
      if(forwarded) return forwarded.value;
      const answer=await (handle as any)(input,extra);
      // An `inspect` that opens a structure carries no session in, and the only
      // place its identity appears is the result. Read both, or the scene this
      // host would share is the one nobody ever named.
      const opened=typeof input?.sessionId==='string'?input.sessionId
        :typeof answer?.structuredContent?.sessionId==='string'?answer.structuredContent.sessionId:undefined;
      if(opened!==undefined) scene.noteSession(opened);
      if(answer?.structuredContent?.kind==='inspect' && typeof answer.structuredContent.sessionId==='string'
        && Number.isSafeInteger(answer.structuredContent.renderToken))
        lastRenderToken.set(answer.structuredContent.sessionId,answer.structuredContent.renderToken);
      return answer;
    }) as any);
  }) as typeof registerHostTool;
  function privateTool(name:string, config:any, handle:(input:any)=>Promise<any>) {
    registerAppTool(server,name,config,handle);
    handlers.set(name.replace('stereo_structure.',''),panelHandlers.get(name.replace('stereo_structure.',''))!);
  }
  async function savedDetailedHandoff(data:Awaited<ReturnType<typeof current>>) {
    const a=data.attachment;
    if(!a.scene) throw Error('Save the inspection before opening the detailed view.');
    const tier=a.density ? growthStageOfLesson(await readGrowthIndex(),a.customTour?.id) : undefined;
    return detailedViewHandoff({structureText:data.cache.structureText,sourceSha256:a.catalog.source.sha256,
      scene:a.scene,...(data.cache.pdbId?{pdbId:data.cache.pdbId}:{}),
      ...(a.density?{densitySha256:a.density.sha256,tierName:tier?.stage.id || a.customTour?.title || 'density'}:{})});
  }
  // dist/inspector.html sits beside dist/server.mjs, so the packaged viewer
  // bundle is dist/molstar/. The repository fallback is one level up.
  const distRoot=dirname(hooks.htmlPath);
  const sourceRetargets = new SourceRetargetQueue();
  const companion = new InspectionCompanionHttp({htmlPath:hooks.htmlPath,now:hooks.now,
    molstarRoots:{distRoot,packageRoot:resolvePath(distRoot,'..')},
    detailed:async(id,token)=>{
      const data=await current(id);
      if(data.attachment.sourceToken!==token) throw Error('This detailed view belongs to an older structure. Open it again from the panel.');
      if(!data.attachment.scene) throw Error('Save the inspection before opening the detailed view.');
      return savedDetailedHandoff(data);
    },
    source:async(id,token)=>{
      const data=await current(id);
      if(data.attachment.sourceToken!==token) throw Error('This companion belongs to an older structure. Open the current companion from the desktop.');
      return {text:data.cache.structureText,sha256:data.attachment.catalog.source.sha256};
    },
    // The density twin of `source` above, and deliberately the
    // same shape. A session whose loaded tier is atomic has no map, which is
    // not an error: it answers `undefined` and `/density` becomes a 404, so the
    // page asks for a map only when the hydration it just read described one.
    density:async(id,token)=>{
      const data=await current(id);
      if(data.attachment.sourceToken!==token) throw Error('This companion belongs to an older structure. Open the current companion from the desktop.');
      const density=data.attachment.density;
      return density?{bytes:density.bytes,sha256:density.sha256,contour:density.contour}:undefined;
    },
    dispatch:async(id,token,name,args)=>{
      const data=await current(id);
      // A companion heartbeat or hydration may be the first request after a
      // desktop-origin source transition. Let those two read paths observe
      // the current token so the HTTP bearer can be retargeted below; all
      // mutating/apply paths remain source-capability strict.
      const staleRead=(name==='poll_inspection'||name==='get_inspection')
        && (data.attachment.sourceToken!==token || (args.sourceToken!==undefined && args.sourceToken!==data.attachment.sourceToken));
      if(data.attachment.sourceToken!==token && !staleRead) throw Error('This companion belongs to an older structure. Open the current companion from the desktop.');
      if(args.sourceToken!==undefined && args.sourceToken!==token && !staleRead) throw Error('This action belongs to a different structure.');
      const handler=handlers.get(name);
      if(!handler) throw Error('Unsupported companion action.');
      // A page on this route is the wearer's, and it says which of its two
      // pages it is. Anything other than the full Mol* viewer is the companion,
      // so a page that names nothing keeps the surface it always had.
      const input={...args,sessionId:id,
        ...(name==='attach_inspection'?{surface:args.surface===DETAILED_SURFACE?DETAILED_SURFACE:'companion'}:{})};
      const response=await handler.handle(await handler.schema.parseAsync(input));
      const after=await current(id);
      if(after.attachment.sourceToken!==token) {
        const retarget= (staleRead || (name==='navigate_experience' && response?.structuredContent?.experienceTransition?.sourceChanged === true) || ((name==='replace_inspection_source' || name==='grow_structure') && response?.structuredContent?.sourceTransition?.sourceChanged === true))
          && response?.structuredContent?.sourceToken===after.attachment.sourceToken;
        if(!retarget) throw Error('The structure changed during this request. Reconnect from the desktop.');
        // A verified source transition has returned the exact new token. Keep
        // the external HTTPS bookmark and paired capabilities, but swap the
        // loopback bearer underneath them and cut any old-source streams.
        if(lanOwner?.sessionId===id) {
          const owner=lanOwner, nextToken=after.attachment.sourceToken;
          await sourceRetargets.run(owner,token,nextToken,async()=>{
            if(lanOwner!==owner) throw Error('The LAN companion changed during this request. Reconnect from the desktop.');
            const replacement=await companion.retarget(id,token,nextToken);
            if(lanOwner!==owner) throw Error('The LAN companion changed during this request. Reconnect from the desktop.');
            await lan.retarget(replacement.url);
            // A later scientific transition may already own this same share.
            // Never let an earlier handoff put its source token back.
            if(lanOwner===owner && (owner.sourceToken===token || owner.sourceToken===nextToken)) owner.sourceToken=nextToken;
          });
        }
      }
      return response;
    },
  });
  const expectedHostBuild=()=>companion.servedBuildId===undefined?hostBuild:companion.servedBuildId;
  const questLink=new QuestLink();
  const panelLanClients=new Map<string,string>();
  const lan=new LanCompanion({sessionMaxLifetimeMs:shareMaxLifetimeMs(),now:hooks.now,
    onPanelHeartbeat:(clientId,panelId)=>{panelLanClients.set(panelId,clientId);}});
  function reconcilePairedPanels(data:Awaited<ReturnType<typeof current>>, b:InspectionBinding) {
    const clients=new Map(lan.status()?.clients.map(client=>[client.id,client.deviceId??client.id]));
    const devices=new Map<string,string>();
    for(const [panelId,clientId] of panelLanClients) {
      const device=clients.get(clientId);if(device)devices.set(panelId,device);
    }
    data.attachment.commands.retireDuplicatePanels(devices,b);
  }
  /**
   * Where the wearer was when the current request began.
   *
   * A press of the grip or the talk orb opens one of these; the transcript the
   * press produces carries it, and every tool that resolves "this" or "that"
   * is given it back. It holds no coordinates and no scene, only the keys and
   * part name the session already publishes in `get_inspection_state`.
   */
  const referents=createRequestReferentStore({now:hooks.now});
  // The captured canonical keys a referent is too large to carry to
  // a model. They stay here under a digest of themselves and are put back the
  // moment an echoed referent comes home.
  const referentKeys=createReferentKeyStore({now:hooks.now});
  // Short text answers for the wearer, carried on the companion heartbeat.
  // It holds no molecular state and is scoped to nothing, so it is created
  // once per server rather than per session.
  const captions=createHeadsetCaptionQueue({now:hooks.now});
  // The order replies start in is the order the wearer may receive them in.
  // Speech rendering is asynchronous, so completion order cannot own a turn.
  let newestReply=0;
  /**
   * Replies whose caption is queued and whose speech is still rendering.
   *
   * The caption no longer waits on the narration round trip, so an older reply
   * can be on the queue when a newer one starts. The newer call takes the older
   * caption back while no page has it, which is the guarantee the render-first
   * order used to give for free: a superseded answer never reaches the wearer.
   */
  const pendingSpeech=new Map<number,string>();
  /** Superseded captions a page had already taken. Read once, by their own call. */
  const drawnBeforeStale=new Set<string>();
  const refusalSerials=new Map<string,number>();
  /**
   * Refusals a connected wearer panel read and stepped over.
   *
   * `say_to_headset` waits a couple of seconds for a page to take a refusal
   * card. A page that takes nothing and a page that takes everything except
   * this card look the same from the wait alone, which is how a scoped refusal
   * came back "Queued" and was never drawn or dropped
   *. The panel records the miss here, and the
   * caller is answered with the limit that turned the card away.
   */
  const refusalScopeMisses=new Map<string,readonly HeadsetCaptionScopeMismatch[]>();
  const noteRefusalScopeMiss=(miss:HeadsetCaptionScopeMiss)=>{
    refusalScopeMisses.set(miss.captionId,miss.mismatch);
    while(refusalScopeMisses.size>32) refusalScopeMisses.delete(refusalScopeMisses.keys().next().value!);
  };
  // Keep the original request's reply ownership until its queue receipt is
  // terminal. A heartbeat conflict is a returned receipt, not a thrown error.
  const commandRefusals=new WeakMap<InspectionCommands,Map<string,{name:string;input:any;serial:number;replyOrder:number}>>();
  let refusalSequence=0;
  /**
   * The one sentence a refusal is drawn as, wherever the refusal was raised.
   *
   * A request the loopback agent refused before it could become a
   * tool call reaches the wearer through `say_to_headset`'s `refusal` field
   * rather than through the wrapper below, and the two have to read the same
   * or the wearer learns to distrust one of them.
   */
  /**
   * Why a scoped refusal card was never drawn, in the wearer's terms.
   *
   * One sentence per limit, ordered by which one the caller can act on: a
   * refusal aimed at an inspection the headset has left is a different mistake
   * from one the wearer has already overtaken.
   */
  function undrawnRefusalReason(mismatch:readonly HeadsetCaptionScopeMismatch[]) {
    if(mismatch.includes('session'))
      return 'it named an inspection the headset is no longer showing, so the wearer never saw it.';
    if(mismatch.includes('panel'))
      return 'the page it was addressed to is no longer the wearer\u2019s, so the wearer never saw it.';
    if(mismatch.includes('serial'))
      return 'the wearer had already asked for something else, so the older refusal was not drawn over it.';
    return 'the headset had moved to another structure, so the wearer never saw it.';
  }
  /**
   * A REFUSAL THE WEARER HAS ALREADY READ IS NOT NEWS TWICE.
   *
   * When a tool call is refused here, this host captions it for the wearer
   * itself, before the model has heard anything. A model that then reports the
   * same refusal through `say_to_headset` is telling the panel what the panel
   * just said: on a device run "1CRN has no ligands to show only." was drawn by
   * the host and drawn again two seconds later, word for word.
   *
   * So the sentences this host has drawn are remembered briefly, and a
   * reported refusal that reproduces one exactly is not drawn over it. Only an
   * identical sentence for the same command counts: a reply that adds anything
   * — an alternative, a reason, what to try instead — is different text and is
   * drawn, which is the reply the wearer was owed in the first place.
   */
  const DUPLICATE_REFUSAL_WINDOW_MS = 20_000;
  const MAX_REMEMBERED_REFUSAL_CAPTIONS = 16;
  const drawnRefusals:{sessionId:string; tool:string; text:string; captionId:string; at:number}[]=[];
  const rememberDrawnRefusal=(sessionId:string, tool:string, text:string, captionId:string)=>{
    drawnRefusals.push({sessionId,tool,text,captionId,at:(hooks.now??Date.now)()});
    while(drawnRefusals.length>MAX_REMEMBERED_REFUSAL_CAPTIONS) drawnRefusals.shift();
  };
  const refusalAlreadyDrawn=(sessionId:string|undefined, tool:string, text:string)=>{
    if(sessionId===undefined) return undefined;
    const at=(hooks.now??Date.now)();
    return drawnRefusals.find(drawn=>drawn.sessionId===sessionId && drawn.tool===tool && drawn.text===text
      && at-drawn.at<=DUPLICATE_REFUSAL_WINDOW_MS);
  };
  function refusalSentence(name:string, detail:string) {
    const source=name==='replace_inspection_source'||name==='grow_structure'||name.startsWith('inspect');
    const reason=/insecure URLs|embedded credentials/iu.test(detail)?'insecure address':'request refused';
    return {reason,text:`Could not ${source?'load':'apply'} · ${reason}. ${inspectionRefusalCaption(detail)}`};
  }
  async function showCommandRefusal(name:string, input:any, error:unknown, serial:number|undefined, replyOrder:number, queuedConflict=false,
    bindingRefusalOwner?:string) {
    // Model focus errors stay with their caller. A voice request also owes
    // the wearer a sentence, even when no render command could be queued.
    if(name==='focus_selection' && !input.utteranceId && !queuedConflict) return;
    const data=await current(input.sessionId), live=binding(input.sessionId,data);
    const recorded=input.utteranceId?utterancePanels.get(input.utteranceId):undefined;
    // The changed source/revision is the reason this voice request failed.
    // Explain it only to its original live wearer panel and active utterance;
    // request/reply order and the caption's current-source scope still apply.
    const voiceBindingRefusal=error instanceof UtteranceBindingError && recorded?.commands===data.attachment.commands
      && recorded.panelIds.includes(input.panelId) && isWearerSurface(data.attachment.commands.surfaceOf(input.panelId))
      && input.serverEpoch===live.serverEpoch;
    // Keep the binding refusal and its original utterance ID, whether it came
    // from a lifecycle control or a scene edit carrying that ID. Its explanation
    // belongs to the turn current when the command arrived.
    const ownedBindingRefusal=voiceBindingRefusal && bindingRefusalOwner!==undefined
      && utteranceBindingRefusalOwner(input)===bindingRefusalOwner;
    const detail=normalizeHeadsetCaption(error instanceof Error?error.message:String(error));
    const {reason,text}=refusalSentence(name,detail);
    const captionId=randomUUID();
    const stale=serial===undefined || refusalSerials.get(input.sessionId)!==serial || newestReply!==replyOrder
      || (!voiceBindingRefusal && input.sourceToken!==undefined && input.sourceToken!==live.sourceToken)
      || (input.serverEpoch!==undefined && input.serverEpoch!==live.serverEpoch)
      || (!voiceBindingRefusal && !queuedConflict && input.baseStateRevision!==undefined && input.baseStateRevision!==live.stateRevision)
      || (!voiceBindingRefusal && !queuedConflict && input.baseInspectionRevision!==undefined && input.baseInspectionRevision!==live.inspectionRevision)
      || Boolean(input.utteranceId && !ownedBindingRefusal && !replyUtteranceAdmission(input.utteranceId).accepted);
    // The log reports refusal/delivery intent, never a rendered receipt. Keep
    // input sources and host error details out of diagnostics (URLs may carry
    // credentials); the private caption carries the host's complete sentence.
    diagnostics.ingest('host-refusals',[{seq:++refusalSequence,at:Math.round((hooks.now??Date.now)()),kind:'outcome',
      detail:{status:'refused',captionId,tool:name,reason,stale,queued:!stale,drawn:false,seatOutcome:stale?'stale':'pending',
        ...(input.commandId?{commandId:input.commandId}:{}),...(input.utteranceId?{utteranceId:input.utteranceId}:{})}}]);
    if (stale || serial===undefined) return;
    noteConversationAction(input.utteranceId);
    // The wearer is about to read this sentence, so a model that
    // reports the same refusal back has nothing to add to the plate.
    rememberDrawnRefusal(input.sessionId,name,text,captionId);
    captions.say({text,speak:false,holdSeconds:HEADSET_CAPTION_DEFAULT_HOLD_SECONDS,
      ...(input.commandId?{commandId:input.commandId}:{}),...(input.utteranceId?{utteranceId:input.utteranceId}:{})},
      {id:captionId,refusal:{tool:name,reason},refusalScope:{sessionId:input.sessionId,sourceToken:live.sourceToken,serial,
        ...(ownedBindingRefusal?{activeUtteranceId:bindingRefusalOwner}:{}),
        ...(input.panelId && isWearerSurface(data.attachment.commands.surfaceOf(input.panelId))?{panelId:input.panelId}:{})}});
  }
  async function showQueuedCommandConflicts(commands:InspectionCommands,b:InspectionBinding) {
    const pending=commandRefusals.get(commands);
    if(!pending?.size) return;
    const receipts=commands.summary(b).commands;
    for(const [id,request] of pending) {
      const receipt=receipts.find(command=>command.commandId===id);
      if(receipt?.status==='queued'||receipt?.status==='rendering') continue;
      pending.delete(id); // Repeated or concurrent polls must not repeat a refusal.
      if(receipt?.status!=='conflict') continue;
      try {
        // A changed saved revision can be the reason for this conflict. Source,
        // utterance, request serial and reply ownership must still match.
        await showCommandRefusal(request.name,request.input,receipt.reason??'The saved view changed.',
          request.serial,request.replyOrder,true);
      } catch { /* Caption delivery cannot change the command's conflict receipt. */ }
    }
  }
  /**
   * Draw and record a refusal the caller raised, for a request this host never
   * saw as a tool call.
   *
   * An earlier run reported that refusal reporting "covers dispatched mutations with a
   * session ID"; the loopback agent refuses an insecure URL, embedded
   * credentials or an oversized paste in `fillAgentArguments`, before any
   * binding is complete, so the wearer's own request left no record and drew
   * nothing. This is the same
   * delivery `showCommandRefusal` performs, reached from the other side.
   *
   * A session that is named and live scopes the card to that scene and to a
   * freshly allocated refusal serial, so a refusal is dropped by the same rule
   * a dispatched one is. A session that is absent or already gone is not a
   * reason to say nothing: the record is written either way and the card is
   * drawn scoped to its utterance alone.
   */
  async function deliverReportedRefusal(input:SayToHeadsetInput, refusal:{tool:string; sessionId?:string}) {
    const detail=normalizeHeadsetCaption(input.text);
    const {reason,text}=refusalSentence(refusal.tool,detail);
    const captionId=randomUUID();
    let scope:HeadsetCaption['refusalScope']|undefined;
    if(refusal.sessionId!==undefined) {
      try {
        const data=await current(refusal.sessionId);
        binding(refusal.sessionId,data);
        const serial=(refusalSerials.get(refusal.sessionId)??0)+1;
        refusalSerials.set(refusal.sessionId,serial);
        while(refusalSerials.size>32) refusalSerials.delete(refusalSerials.keys().next().value!);
        // No source token. This refusal answers a request that never
        // became a command, so it was never bound to a structure, and a source
        // that rotates between queueing and the next heartbeat is not a reason
        // to leave the wearer with nothing. The session keeps it off a newer
        // scene and the serial keeps it off a newer request.
        scope={sessionId:refusal.sessionId,serial};
      } catch { /* An expired or unknown session still gets its refusal drawn. */ }
    }
    const stale=Boolean(input.utteranceId && !replyUtteranceAdmission(input.utteranceId).accepted);
    // The panel drew this exact sentence for this exact command
    // moments ago, so drawing it again only makes the wearer read it twice.
    const repeated=stale?undefined:refusalAlreadyDrawn(refusal.sessionId,refusal.tool,text);
    const holdSeconds=input.holdSeconds??HEADSET_CAPTION_DEFAULT_HOLD_SECONDS;
    // The same log line a dispatched refusal writes, plus where it was raised.
    // No URL, argument or host error detail reaches diagnostics.
    diagnostics.ingest('host-refusals',[{seq:++refusalSequence,at:Math.round((hooks.now??Date.now)()),kind:'outcome',
      detail:{status:'refused',captionId:repeated?repeated.captionId:captionId,tool:refusal.tool,reason,stale,
        queued:!stale && !repeated,drawn:false,
        seatOutcome:stale?'stale':repeated?'duplicate':'pending',origin:'pre-dispatch',scoped:scope!==undefined,
        ...(repeated?{duplicateOf:repeated.captionId}:{}),
        ...(input.commandId?{commandId:input.commandId}:{}),...(input.utteranceId?{utteranceId:input.utteranceId}:{})}}]);
    const receipt=(outcome:'delivered'|'queued'|'stale'|'undrawn'|'duplicate',captionId:string,why?:string)=>{
      const queued=outcome==='delivered'||outcome==='queued';
      const line=outcome==='delivered'?`Delivered refusal for ${refusal.tool}: ${text}`
        :outcome==='queued'?`Queued refusal for ${refusal.tool}: ${text}`
        :outcome==='stale'?`Dropped stale refusal for ${refusal.tool}: the wearer has moved on to another request.`
        :outcome==='duplicate'?`The panel had already drawn this refusal for ${refusal.tool}, so it was not drawn again: ${text} Say what to do instead, or say nothing.`
        :`Could not draw the refusal for ${refusal.tool}: ${why}`;
      return {content:[{type:'text' as const,text:line}],
        structuredContent:{queued,delivered:outcome==='delivered',captionId,text,spoken:false,speechLimit:HEADSET_SPEECH_LIMIT,
          holdSeconds,audible:false,stale:outcome==='stale',truncated:false,segmentCount:0,
          ...(outcome==='duplicate'?{duplicate:true}:{}),
          ...(why?{undrawnReason:why}:{}),
          refusal:{tool:refusal.tool,reason,scoped:scope!==undefined},
          utteranceBinding:input.utteranceId?(outcome==='stale'?'stale' as const:'active' as const):'unbound' as const,
          ...(input.utteranceId?{utteranceId:input.utteranceId}:{unbound:true})}};
    };
    if(stale) return receipt('stale',captionId);
    // The wearer already has this sentence on the plate. The turn is still
    // this model's: what it owes them now is what to do instead.
    if(repeated) return receipt('duplicate',repeated.captionId,
      'the panel had already drawn this refusal for this command, so the wearer was not shown it twice');
    noteConversationAction(input.utteranceId);
    const caption=captions.say({text,speak:false,holdSeconds,
      ...(input.commandId?{commandId:input.commandId}:{}),...(input.utteranceId?{utteranceId:input.utteranceId}:{})},
      {id:captionId,refusal:{tool:refusal.tool,reason,origin:'pre-dispatch'},...(scope?{refusalScope:scope}:{})});
    const delivered=await captions.waitForDelivery(caption.id,HEADSET_CAPTION_DELIVERY_WAIT_MS);
    if(delivered) return receipt('delivered',caption.id);
    // A wearer page read this card and stepped over it, so waiting
    // longer cannot help. Say which limit turned it away rather than reporting
    // it as queued for a heartbeat that has already been and gone.
    const missed=refusalScopeMisses.get(caption.id);
    if(!missed) return receipt('queued',caption.id);
    refusalScopeMisses.delete(caption.id);
    diagnostics.ingest('host-refusals',[{seq:++refusalSequence,at:Math.round((hooks.now??Date.now)()),kind:'outcome',
      detail:{status:'refused',captionId:caption.id,tool:refusal.tool,reason,stale:false,queued:false,drawn:false,
        seatOutcome:'dropped',origin:'pre-dispatch',scoped:true,scopeMismatch:missed,
        ...(input.commandId?{commandId:input.commandId}:{}),...(input.utteranceId?{utteranceId:input.utteranceId}:{})}}]);
    return receipt('undrawn',caption.id,undrawnRefusalReason(missed));
  }
  // A recording remembers the headset panel it came from. Only when a desktop
  // reader claims its finished transcript does that ID become active there.
  type UtterancePanel = {commands:InspectionCommands; panelIds:string[]; serial:number};
  type ActiveUtterance = {utteranceId:string; commands:InspectionCommands; serial:number};
  const utterancePanels=new Map<string,UtterancePanel>();
  const activeUtterances=new Map<string,ActiveUtterance>();
  let activeUtteranceSerial=0;
  const rememberUtterancePanels=(utteranceId:string, commands:InspectionCommands, panelIds:string[])=>{
    if(utterancePanels.has(utteranceId)) return;
    utterancePanels.set(utteranceId,{commands,panelIds,serial:++activeUtteranceSerial});
    while(utterancePanels.size>64) utterancePanels.delete(utterancePanels.keys().next().value!);
  };
  const noteClaimedUtterances=(entries:readonly any[])=>{
    for(const entry of entries) {
      const target=utterancePanels.get(entry.utteranceId);
      if(!target) continue;
      for(const panelId of target.panelIds) {
        if(!isWearerSurface(target.commands.surfaceOf(panelId))) continue;
        if((activeUtterances.get(panelId)?.serial??0)>target.serial) continue;
        activeUtterances.set(panelId,{utteranceId:entry.utteranceId,commands:target.commands,serial:target.serial});
      }
    }
    while(activeUtterances.size>32) activeUtterances.delete(activeUtterances.keys().next().value!);
  };
  const replyUtteranceAdmission=(utteranceId:string)=>{
    const target=utterancePanels.get(utteranceId);
    // A cancel marks its own utterance superseded by
    // itself, because it drops the pending work that utterance started. That
    // is the cancel's outcome, not a newer request, and the reply that tells
    // the wearer their cancel landed is exactly the reply that belongs to it.
    // Only supersession by some OTHER utterance makes a reply stale.
    const own=target?.commands.utterance(utteranceId)?.supersededBy;
    const supersededBy=own===utteranceId?undefined:own;
    if(supersededBy) return {accepted:false as const,activeUtteranceId:supersededBy};
    const candidates=target?.panelIds.flatMap(panelId=>{
      const active=activeUtterances.get(panelId);
      return active&&isWearerSurface(active.commands.surfaceOf(panelId))?[active]:[];
    })??[];
    if(candidates.some(active=>active.utteranceId===utteranceId))
      return {accepted:true as const,activeUtteranceId:utteranceId};
    const active=[...candidates,...[...activeUtterances.entries()].flatMap(([panelId,value])=>
      isWearerSurface(value.commands.surfaceOf(panelId))?[value]:[])]
      .sort((a,b)=>b.serial-a.serial)[0];
    return {accepted:false as const,activeUtteranceId:active?.utteranceId};
  };
  function utteranceBindingRefusalOwner(input:any):string|undefined {
    if(typeof input?.utteranceId!=='string') return;
    const recorded=utterancePanels.get(input.utteranceId), active=activeUtterances.get(input.panelId);
    if(!recorded || !active || recorded.commands!==active.commands || !recorded.panelIds.includes(input.panelId)
      || !isWearerSurface(recorded.commands.surfaceOf(input.panelId))) return;
    const utterance=recorded.commands.utterance(input.utteranceId);
    if(utterance && !utterance.supersededBy) return active.utteranceId;
  }
  // A host-initiated grow refusal has to reach the page.
  // `say_to_headset` draws the agent's own sentence on the status row; this
  // mailbox is the growth sentence for the caption plate, claimed on the
  // same companion heartbeat so a Mac-side `grow_structure` is not silent
  // on the glass the wearer is reading.
  const growthCaptions=createGrowthCaptionMailbox();
  // Quest Browser lists no speech-synthesis voice, so a caption alone is
  // silent in the headset. The Mac renders the bounded line and sends its clip
  // with the full caption; a host without a voice simply
  // sends the caption, exactly as before.
  const replyAudio:ReplyAudioSynthesizer=hooks.replyAudio ?? replyAudioFromEnv();
  // What the headset itself reports, carried on the same heartbeat. Like the
  // caption queue it holds no molecular state and is scoped to nothing, so it
  // is created once per server rather than per session.
  const diagnostics=createHeadsetDiagnosticsStore({now:hooks.now});
  // One still of what the wearer is looking at, taken on request. Like the
  // caption queue and the diagnostics store it rides the same heartbeat and
  // holds no molecular state, so it is created once per server.
  const headsetView=createHeadsetViewStore({now:hooks.now});
  // Both the headset heartbeat and readiness require recent polling plus an
  // admitted action/reply for a claimed utterance. A printer cannot prove this.
  const presenceNow=hooks.now ?? Date.now;
  let agentListenedAt:number|undefined;
  let agentActedAt:number|undefined;
  let agentActedUtterance:string|undefined;
  const noteAgentListening=()=>{agentListenedAt=presenceNow();};
  const noteConversationAction=(utteranceId:string|undefined)=>{
    if(!utteranceId || utteranceId===agentActedUtterance || !replyUtteranceAdmission(utteranceId).accepted) return;
    agentActedUtterance=utteranceId;
    agentActedAt=presenceNow();
  };
  const agentAttached=()=>agentListenedAt!==undefined && agentActedAt!==undefined
    && presenceNow()-agentListenedAt<=AGENT_PRESENCE_WINDOW_MS
    && presenceNow()-agentActedAt<=AGENT_PRESENCE_WINDOW_MS;
  let lanOwner:{sessionId:string;sourceToken:string;headset:CompanionHeadset}|undefined;
  /** How long one Web Launch send owns this Mac's browser. */
  const launchNow=hooks.now ?? Date.now;
  let lastWebLaunchAt:number|undefined;
  // A listener alone is not a dispatched launch. Bind the dispatch to the
  // actual pairing attempt so expiry, recovery and a new share cannot inherit it.
  let pendingHeadsetLaunch:{url:string;launchId:string;code:string|undefined;expiresAt:string;clipboard:boolean}|undefined;
  /**
   * Put the running LAN companion on the headset. A launch is a convenience on
   * top of an address the wearer can always open by hand, so a failure is
   * reported in the sentence and never turns the connection itself into an
   * error: the page is up either way.
   */
  async function launchToHeadset(mode:CompanionLaunchMode, companionUrl:string, code:string|undefined, headset:CompanionHeadset='auto'):Promise<LaunchReport> {
    const launchShare=lan.status();
    const resolved=await resolveHeadsetLaunch({mode,target:headset,...hooks.questLaunch});
    if(!launchShare || !lan.matchesPairing(code,launchShare.launchId))
      return {mode,opened:false,message:'The pairing attempt changed while checking the headset. Read manage_companion action="status"; keep a paired page, or use action="launch" for the current pairing code.'};
    const {route}=resolved;
    let reservation:number|undefined;
    if(route==='meta-web') {
      // Two Web Launch sends ten seconds apart is what wedged
      // Quest Browser. Meta's page hands the headset a fresh
      // BrowserActivity each time it is pressed, and the first one had not
      // finished resuming, so the input dispatcher kept timing out against the
      // half-dead record and Android raised its "isn't responding" dialog over
      // the wearer every ten seconds for a minute and a half. The agent cannot
      // see that page being pressed, so the only thing it can control is how
      // often this Mac opens it. One send, then wait.
      const sent=launchNow();
      const ago=lastWebLaunchAt===undefined?undefined:sent-lastWebLaunchAt;
      if(ago!==undefined && ago<WEB_LAUNCH_DEBOUNCE_MS) {
        const waited=Math.round(ago/1000), left=Math.ceil((WEB_LAUNCH_DEBOUNCE_MS-ago)/1000);
        const sameLink=pendingHeadsetLaunch?.url===companionUrl && pendingHeadsetLaunch?.launchId===launchShare.launchId
          && pendingHeadsetLaunch?.code===code && lan.matchesPairing(code,pendingHeadsetLaunch.launchId);
        const next=launchShare.clients.length?'A headset has already paired. Wait for its page to attach and follow wearer.note; do not start another pairing while it loads.'
          :sameLink?`Press Open on the page already in your browser once, or wait ${left} s.`
          :`The previous link does not belong to this pairing attempt. Use Manual pairing with the current code, or wait ${left} s and call manage_companion action="launch" with launch="auto".`;
        return {mode,opened:false,message:`Web Launch was sent ${waited} s ago and was not sent again. ${next} Sending it twice in a row wedges Quest Browser and blurs the wearer's session every ten seconds.`};
      }
      lastWebLaunchAt=sent;
      reservation=sent;
    }
    // Use the route already checked above. A test seam or a removable adb
    // install must not be queried twice and change its answer mid-launch.
    const target=headset;
    // An `am start -a VIEW` intent opens a NEW tab every
    // time. Twenty-one identical viewer tabs were open on the Quest 2 on
    // for exactly that reason, one live and twenty frozen. So
    // before the intent goes out, the tabs already there are probed: a live
    // one is kept and the launch is skipped, dead ones are closed. Without a
    // debugger nothing is closed and the text says older tabs may remain.
    // "live" is not "drawing the menu". A tab showing
    // the share-ended plate still answers `__stereofoldMenu.rows()`, so on
    // the sweep kept the wearer's dead tab, skipped the launch and
    // never sent the `#pair=` code the new share needed. Such a tab now ranks
    // `ended`, is closed, and the intent goes out.
    // The launch runs the sweep itself, on the headset it chose, and only once
    // Meta's boundary screen is known not to be up.
    const releaseFailedDispatch=()=>{if(reservation!==undefined && lastWebLaunchAt===reservation)lastWebLaunchAt=undefined;};
    try {
      const report=await launchCompanion({mode,companionUrl,code,target,...hooks.questLaunch,resolved,...(route==='adb'?{tabs:viewerTabs(companionUrl)}:{})});
      // A failed later route must not erase a still-valid earlier link. A
      // clipboard handoff is pending human action, not an automatic dispatch.
      const clipboard=report.target==='apple' && report.handoff==='clipboard';
      if(launchShare.url===companionUrl && lan.matchesPairing(code,launchShare.launchId)
        && (report.opened || report.reason==='attempted' || clipboard))
        pendingHeadsetLaunch={url:companionUrl,launchId:launchShare.launchId,code,expiresAt:launchShare.pairingExpiresAt,clipboard};
      if(report.reason==='failed' || report.reason==='not-macos')releaseFailedDispatch();
      return report;
    }
    catch(error) {releaseFailedDispatch();return {mode,opened:false,reason:'failed',message:`Could not put the page on the headset: ${(error as Error).message} The address and pairing code in this result still work by hand.`}; }
  }
  /**
   * Leave exactly one viewer tab open for this share.
   *
   * Everything here is best effort. Forwarding the debugger port and probing
   * each tab can both fail, and every failure gives the same answer:
   * `probed: false`, which plans a plain launch and says in the tool text that
   * older tabs may still be open. A hygiene step must never be the reason a
   * wearer cannot get a page. The port is forwarded with the adb binary and
   * serial the launch chose, so the sweep reads the headset the intent goes to.
   */
  function viewerTabs(companionUrl:string):LaunchTabs {
    const port=devtoolsPort(captureEnvironment());
    const transport=hooks.headsetDevtools??nodeDevtoolsTransport();
    const expectedOrigin=(()=>{try { return new URL(companionUrl).origin; } catch { return undefined; }})();
    const forward=(device:QuestDevice)=>async()=>{
      try { return (await device.run(device.adb,forwardArguments(device.serial,port))).code===0; } catch { return false; }
    };
    const strip=(swept?:StripSweep)=>swept?{enumerated:swept.enumerated,stranded:swept.stranded.length,closed:swept.closed.length,
      ...(swept.reason?{reason:swept.reason}:{})}:{enumerated:false,stranded:0,closed:0,reason:'the strip was not read after the cold start'};
    return {
      before:async device=>{
        const swept=await sweepLaunchTabs({transport,port,...(expectedOrigin===undefined?{}:{expectedOrigin}),
          // The session this Mac is sharing right now. A viewer tab publishes the
          // session it hydrated on `document.body.dataset.sessionId`, so a tab
          // naming a different one is a page from a share this host has replaced.
          // Nothing is concluded when either side names nothing.
          ...(lanOwner?.sessionId?{expectedSessionId:lanOwner.sessionId}:{}),
          forward:forward(device)});
        return {probed:swept.probed,closed:swept.closed,launch:swept.launch,note:swept.note,
          ...(swept.keep?{keep:swept.keep}:{}),strip:strip(swept.strip),
          tabs:swept.readings.map(reading=>({id:reading.id,liveness:tabLiveness(reading)}))};
      },
      // Nothing on another origin is ever closed, so without one there is nothing to sweep.
      ...(expectedOrigin===undefined?{}:{restored:async(device:QuestDevice)=>{
        const swept=await sweepRestoredTabs({transport,port,expectedOrigin,forward:forward(device)});
        return {probed:swept.answered,closed:swept.closed,launch:true,note:swept.note,
          ...(swept.keep?{keep:swept.keep}:{}),strip:strip(swept.strip),
          tabs:swept.listed.map(id=>({id,liveness:id===swept.keep?'opened':'restored'}))};
      }}),
    };
  }
  /**
   * Whether the headset shows Quest Browser's certificate
   * warning for this share, over the debugger port a launch forwarded.
   *
   * Best effort and read-only. A Mac with no cable, a port nobody forwarded
   * and a headset showing the page all come back as `undefined`, and the
   * caller keeps its own sentence.
   */
  async function headsetCertificateWarning(shareUrl:string,worn?:boolean,fingerprint?:string):Promise<CertificateWarning|undefined> {
    let expectedOrigin:string;
    try { expectedOrigin=new URL(shareUrl).origin; } catch { return undefined; }
    const reading=await readCertificateWarning(hooks.headsetDevtools??nodeDevtoolsTransport(),{port:devtoolsPort(captureEnvironment()),
      expectedOrigin,...(worn===undefined?{}:{worn}),...(fingerprint?{fingerprint}:{})}).catch(()=>undefined);
    return reading?.read?reading.warning:undefined;
  }
  /**
   * Put a page this Mac serves on this Mac's own screen: the detailed view, or
   * the inspector panel. Like a headset launch it is convenience over an
   * address the result prints either way, so a refusal or a failed spawn
   * becomes a sentence rather than an error.
   */
  async function openOnThisMac(url:string):Promise<LaunchAttempt> {
    const seams=hooks.questLaunch??{};
    try { return await attemptLocalOpen({link:url,...(seams.platform?{platform:seams.platform}:{}),
      opener:seams.opener??resolveOpener(seams.environment),...(seams.launch?{launch:seams.launch}:{})}); }
    catch(error) { return {...launchFailure(error),opened:false,link:url}; }
  }
  /**
   * The inspector panel served from this server for a host
   * that mounts none, such as terminal Claude Code. It mounts the page with
   * the same `inspect`-kind result the MCP App would receive, built from the
   * session as it is now, and every call the page makes runs the registered
   * handler for the session its link was opened for.
   */
  const panel=new InspectorPanelHost({htmlPath:hooks.htmlPath,hostScriptPath:resolvePath(distRoot,'inspector-host.js'),
    ...(hooks.live?{live:hooks.live}:{}),
    opened:async id=>{
      const data=await current(id);
      return result(id,data,{kind:'inspect',renderToken:lastRenderToken.get(id) ?? 1,hasStructure:true});
    },
    dispatch:async(id,name,args)=>{
      const handler=panelHandlers.get(name);
      if(!handler) throw Error('Tool unavailable');
      return handler.handle(await handler.schema.parseAsync({...args,sessionId:id}));
    }});
  // A page key lives as long as its session: when the store drops the session
  // the key goes, and the last key to go stops the listener.
  hooks.sessionEnded?.(id=>{void panel.forget(id).catch(()=>undefined);});
  const close=server.close.bind(server);
  server.close=async()=>{editAdmission.close();await scene.close();await lan.close();await questLink.close();await companion.close();await panel.close();await close();};
  const onclose=server.server.onclose;
  server.server.onclose=()=>{editAdmission.close();void scene.close();void lan.close();void questLink.close();void companion.close();void panel.close();onclose?.();};
  // Cache identity changes only on a successful source replacement. A failed
  // fetch preserves the current inspection; replacement (even identical bytes)
  // creates a fresh attachment. Weak ownership follows existing session expiry.
  const attachments = new WeakMap<Cache, Promise<Attachment>>();
  // Named views outlive an individual coordinate cache. Retain their verified
  // comparison assets with the same live session so returning to a source can
  // restore its saved comparison without trusting a new source descriptor.
  // Used command IDs likewise survive cache replacement, without retaining
  // old commands or scenes, so a late retry cannot become a new edit.
  const sessionLibraries=new Map<string,{views:InspectionViews;comparisonAssets:Map<string,ComparisonAsset>;commandIds:Set<string>}>();
  hooks.sessionEnded?.(id=>{sessionLibraries.delete(id);sharedSessions.delete(id);});
  const sourceHandoffs=new WeakMap<Cache,NonNullable<Attachment['sourceContinuation']>>();
  const voiceSourceBySession = new Map<string,string>();
  // A source transition has one short-lived renderer owner. It is the only
  // old-binding panel allowed to hydrate before the first saved scene exists.
  const TRANSITION_TARGET_LEASE_MS=120_000;
  const transitionNow=hooks.now ?? Date.now;
  const setTransitionTarget=(attachment:Attachment,panelId:string)=>{
    attachment.transitionTarget={panelId,expiresAt:transitionNow()+TRANSITION_TARGET_LEASE_MS};
  };
  const transitionTargetFor=(attachment:Attachment,panelId:string,currentBinding:InspectionBinding)=>{
    const target=attachment.transitionTarget;
    if(!target) return false;
    // If the original renderer disappeared before saving, the next polling
    // panel becomes the owner. This bounds a failed transition without ever
    // asking all panels to race the initial scene save.
    if(transitionNow()>=target.expiresAt && attachment.commands.surfaceOf(target.panelId)===undefined) {
      const undo=attachment.experienceRollback;
      if(undo && undo.expectedStateRevision===currentBinding.stateRevision && undo.expectedInspectionRevision===attachment.revision) {
        // Recovery retains the same transaction, after the missing owner and
        // its lease have expired. A live command or an unregistered caller
        // cannot inherit its claim.
        if(attachment.commands.hasPending(currentBinding) || attachment.commands.surfaceOf(panelId)===undefined)return false;
        undo.panelId=panelId;
      }
      setTransitionTarget(attachment,panelId);
    }
    return attachment.transitionTarget?.panelId===panelId;
  };
  /** A source digest is learned from the first accepted public stage, then held stable for this server lifetime. */
  const verifiedExperienceSources = new Map<string,{sha256:string;byteLength:number}>();
  const experienceSessions = new Map<string,ExperienceRuntime>();
  /**
   * A lesson that names a deposited assembly. Mol* builds the assembly from the
   * entry's own operator list, so the asymmetric unit is the only thing that
   * travels and the repeats are instanced rather than shipped. The request is
   * bound to the exact structure cache it opened, so a later `inspect` on the
   * same session never inherits it.
   */
  const assemblyRequests = new Map<string,{assemblyId:string;cache?:unknown}>();
  // Set only around the controlled source replacement tools below. It prevents
  // current() from retiring a companion/LAN owner before its capability can be retargeted.
  const authorizedSourceRetarget = new Map<string,number>();
  const authorizeSourceRetarget=(id:string)=>{
    authorizedSourceRetarget.set(id,(authorizedSourceRetarget.get(id)??0)+1);
    let released=false;
    return ()=>{
      if(released) return;released=true;
      const remaining=(authorizedSourceRetarget.get(id)??1)-1;
      if(remaining) authorizedSourceRetarget.set(id,remaining);else authorizedSourceRetarget.delete(id);
    };
  };
  /**
   * A LEGACY STRUCTURE LOAD MUST NOT END THE WEARER'S SHARE.
   *
   * `stereo_structure.control` with load_pdb, and `stereo_structure.open` with
   * a source, commit a new structure cache straight into the session. The
   * inspection they load into may be the one on a wearer's headset, and a new
   * cache means a new attachment with a new sourceToken, which `current()`
   * reads as an unauthorized retarget of a LAN capability and answers by
   * retiring the listener. That ended a 4HHB share thirteen
   * seconds into a dress rehearsal: the wearer kept the old scene, the plate
   * read "Link to the Mac lost", and the assistant was told hasStructure:true
   * with nothing in the answer about the share.
   *
   * This is the controlled transition `replace_inspection_source` takes,
   * reduced to what a legacy caller can supply. The retarget is authorized, the
   * old command queue, panels and `shared` flag cross to the new attachment,
   * the LAN owner is moved to the new sourceToken so the wearer's page follows
   * the new source on its next heartbeat, and the caller is told in the result
   * which of those happened. No legacy result is ever silent about the share.
   */
  type SharedSourceOutcome={kept:boolean;sourceToken?:string;previousSourceToken?:string;wearerPanelId?:string;note:string};
  const sharedSessions=new Set<string>();
  const markShared=(id:string,attachment:Attachment,value:boolean)=>{
    if(attachment.shared && !value) attachment.followStoppedShare=true;
    attachment.shared=value;
    if(value) sharedSessions.add(id); else { sharedSessions.delete(id); attachment.commands.forgetQuietWearer(); }
  };
  const isSharedSession=(id:string|undefined):boolean =>
    id!==undefined && (lanOwner?.sessionId===id || sharedSessions.has(id));
  async function loadSharedSource<T>(id:string|undefined,
    load:(committed:()=>void)=>Promise<T>):Promise<{value:T;share?:SharedSourceOutcome}> {
    if(!isSharedSession(id)) return {value:await load(()=>{})};
    const sessionId=id!;
    const data=await current(sessionId), prior=data.attachment, b=binding(sessionId,data);
    // The wearer's own page, if one is attached. It is the transition owner: the
    // single old-binding panel allowed to hydrate the new source before any
    // scene has been saved on it.
    const wearerPanelId=prior.commands.summary(b).panels
      .find(panel=>panel.current && isWearerSurface(panel.surface))?.panelId;
    const release=authorizeSourceRetarget(sessionId);
    let handoff:NonNullable<Attachment['sourceContinuation']>|undefined;
    try {
      const value=await load(()=>{
        const session=hooks.current(sessionId);
        if(!session.structureCache || !wearerPanelId) return;
        handoff={commands:prior.commands,previous:b,panelId:wearerPanelId,stateRevision:session.stateRevision,
          modelNumber:prior.catalog.modelNumbers[0],assemblyId:prior.catalog.assemblyId,shared:prior.shared};
        sourceHandoffs.set(session.structureCache,handoff);
      });
      experienceSessions.delete(sessionId);
      let refreshed:Awaited<ReturnType<typeof current>>;
      try { refreshed=await current(sessionId); }
      catch(error) {
        // The new coordinates cannot be catalogued, so there is nothing for the
        // wearer's page to hydrate. Retire the listener here rather than leaving
        // it pointed at a source no page can read, and say so.
        if(lanOwner?.sessionId===sessionId) { lanOwner=undefined; void lan.close().catch(()=>{}); }
        sharedSessions.delete(sessionId);
        return {value,share:{kept:false,previousSourceToken:b.sourceToken,
          note:'The headset share has ended: this structure could not be prepared for a headset page '
            +`(${error instanceof Error?error.message:String(error)}). Reconnect with open_companion before telling the wearer anything.`}};
      }
      // Ready panels and sharing belong to the live session, not to coordinates.
      refreshed.attachment.shared=prior.shared;
      refreshed.attachment.commands=prior.commands;
      // The queue came across from the old source; the budget must not.
      refreshed.attachment.commands.setRenderBudget(renderBudgetMsFor(refreshed));
      if(handoff && refreshed.attachment.sourceContinuation===handoff) {
        // A legacy call names no model or assembly, so the transition's own
        // identity is the new source's defaults, knowable only once catalogued.
        handoff.modelNumber=refreshed.attachment.catalog.modelNumbers[0];
        handoff.assemblyId=refreshed.attachment.catalog.assemblyId;
      }
      const overLan=lanOwner?.sessionId===sessionId;
      if(overLan) lanOwner!.sourceToken=refreshed.attachment.sourceToken;
      return {value,share:{kept:true,sourceToken:refreshed.attachment.sourceToken,previousSourceToken:b.sourceToken,
        ...(wearerPanelId?{wearerPanelId}:{}),
        note:`The headset share was kept and retargeted to this structure${overLan?' over private Wi-Fi':''}. `
          +`Its sourceToken is now ${refreshed.attachment.sourceToken}; use that one, not the token you read before this call. `
          +'The wearer’s page follows the new source on its next heartbeat, so read get_inspection_state for a rendered '
          +'receipt on a current wearer panel before saying they can see it.'}};
    } finally { release(); }
  }
  /**
   * Whether anyone is on the other end of this inspection.
   *
   * `shared` says a share was opened and `readiness.blocking` names what is
   * missing, and a model read a `rendered` receipt past both of
   * them and reported a structure the wearer never saw. This is the same two
   * facts as one sentence the model cannot read as success: whether the private
   * Wi-Fi share has a client, and whether a wearer page is attached to this
   * source. It invents no lifecycle state; it only says what the rendered
   * receipt beside it does and does not mean.
   */
  function wearerLinkFor(id:string,data:Awaited<ReturnType<typeof current>>) {
    const live=lanOwner?.sessionId===id?lan.status():undefined;
    // An open listener and a paired headset are separate facts. Keep `share`
    // as the existing paired-client signal, and expose listener availability.
    const shareOpen=Boolean(live);
    const share=Boolean(live && live.clients.length>0);
    const launchPending=Boolean(live && pendingHeadsetLaunch?.url===live.url
      && pendingHeadsetLaunch.launchId===live.launchId && pendingHeadsetLaunch.expiresAt===live.pairingExpiresAt
      && lan.matchesPairing(pendingHeadsetLaunch.code,pendingHeadsetLaunch.launchId));
    const expired=Boolean(live && presenceNow()>=Date.parse(live.pairingExpiresAt));
    const recovery=!shareOpen?'Reconnect with open_companion.'
      :share?'A headset has paired. Wait for its page to attach; if no page checks in within 60 seconds, read manage_companion action="status" to diagnose it.'
      :launchPending?(pendingHeadsetLaunch!.clipboard?'The Vision Pro link is on the clipboard; its Safari handoff is awaiting pairing.'
        :'A headset launch was dispatched, but delivery is unconfirmed.')
        +' Follow its returned instructions once, then check get_inspection_state every 5–10 seconds until pairing or pairingExpiresAt. While the person completes the prompts, do not resend or start a competing Manual pairing. Recover after a reported failure or expiry.'
      :expired?'No current headset launch is pending. The pairing code has expired. Use manage_companion action="launch" with the chosen route to obtain a fresh code before attempting Manual pairing.'
      :'No current headset launch is pending. Use manage_companion action="launch" with launch="auto", or use Manual pairing with the current address and code; resolve any reported launch failure or headset block before retrying.';
    let panel=false;
    try {
      panel=data.attachment.commands.summary(binding(id,data)).panels
        .some(entry=>entry.current && isWearerSurface(entry.surface));
    } catch { panel=false; }
    const missing=share?'the private Wi-Fi share is open, but no headset page is attached to this source'
      :shareOpen?'the private Wi-Fi share is open, but no headset has paired yet'
      :panel?'the private Wi-Fi share is not open'
        :'the private Wi-Fi share is not open and no headset page is attached';
    // Where the wearer's page is, so an agent waits on this
    // rather than asking a person who would have to take the headset off to
    // answer. A paused page is behind the saved scene by design, which the
    // `linked` sentence would read as a page that is gone.
    let page:WearerPage={state:'no-page'};
    try { page=data.attachment.commands.wearerPage(binding(id,data)); } catch { /* A changed source has no page yet. */ }
    const pageOutdated=Boolean(expectedHostBuild() && page.panelId
      && data.attachment.commands.surfaceOf(page.panelId)==='companion'
      && data.attachment.commands.pageBuildOf(page.panelId)!==expectedHostBuild());
    return {linked:share&&panel,shareOpen,share,panel,state:page.state,
      ...(pageOutdated?{pageOutdated:true}:{}),
      ...(page.checkedInAt===undefined?{}:{checkedInAt:page.checkedInAt}),
      ...(page.pausedBecause?{pausedBecause:page.pausedBecause}:{}),
      note:pageOutdated?outdatedPageNote(data.attachment.commands.pageBuildOf(page.panelId!))
        :page.state==='paused'?wearerPausedNote(page)
        :page.state==='unknown'?wearerUnknownNote()
        :share&&panel
        ?'A wearer page is attached over the open share, so a rendered receipt on that panel is what the wearer sees.'
          +(page.state==='page-open'?' The page is open and waiting for the wearer to press Enter VR.'
            :page.state==='entering-vr'?' The page has started the immersive view and has not drawn a frame the wearer can see yet: '
              +'the view is still starting, or a headset dialog is in front of it.':'')
        :`No wearer is linked to this inspection: ${missing}. A rendered receipt here describes this Mac’s own panel `
          +'and not the wearer’s view, and say_to_headset cannot reach them. '
          +recovery+' Confirm wearer.state is "in-vr" before reporting anything as seen.'};
  }
  const publicExperience = (value:ExperienceRuntime) => ({
    id:value.experience.id, title:value.experience.title, revision:value.revision, stepIndex:value.stepIndex,
    step:value.experience.steps[value.stepIndex], stage:value.stage, stages:value.experience.stages, steps:value.experience.steps,
    sourceSha256:value.sourceSha256, applied:value.acknowledgements.size>0,
  });
  const sourceKey = (stage:MolecularExperienceStage) => `${stage.source.pdbId}:${stage.assembly.assemblyId}:${stage.assembly.activeOperatorIds.join(',')}${stage.source.modelNumber===undefined?'':`:model-${stage.source.modelNumber}`}`;
  const journeyGeometry=new Map<string,{digest:string;modelNumber?:number;counts:ExperienceGeometry}>();
  const journeyChecks=new Map<string,string>();
  async function measureJourneyStage(stage:MolecularExperienceStage,text:string,modelNumber=stage.source.modelNumber) {
    const key=sourceKey(stage),digest=createHash('sha256').update(text,'utf8').digest('hex');
    let measured=journeyGeometry.get(key);
    if(measured?.digest!==digest || measured.modelNumber!==modelNumber) {
      measured={digest,modelNumber,counts:await experienceGeometry(text,stage,modelNumber)};
      journeyGeometry.set(key,measured);
      while(journeyGeometry.size>64) journeyGeometry.delete(journeyGeometry.keys().next().value!);
    }
    journeyChecks.delete(key);
    return measured.counts;
  }
  function journeyChapters(experience:MolecularExperience,deviceClass='quest2') {
    return experience.steps.map((step,index)=>{
      const key=sourceKey(stageForStep(experience,index)),problem=journeyChecks.get(key);
      return problem?{stepIndex:index,title:step.title,status:'refused' as const,message:problem}
        :catalogChapterBudget(experience,index,journeyGeometry.get(key)?.counts,deviceClass);
    });
  }
  function journeyCatalog() {
    return MOLECULAR_EXPERIENCES.map(experience=>{
      const chapters=journeyChapters(experience);
      return {id:experience.id,title:experience.title,summary:experience.summary,steps:experience.steps.length,
        deviceBudget:{deviceClass:'quest2',chapters,notice:chapterBudgetNotice(chapters)},
        sources:experience.stages.map(stage=>({pdbId:stage.source.pdbId,assemblyId:stage.assembly.assemblyId,
          ...(stage.source.modelNumber!==undefined?{modelNumber:stage.source.modelNumber}:{}),stepIndex:experience.steps.findIndex(step=>step.stageId===stage.id)}))};
    });
  }
  const catalogSourceChecks=new WeakMap<Cache,{modelNumber?:number;checked:Promise<void>}>();
  async function journeyCatalogFor(data:Awaited<ReturnType<typeof current>>) {
    const modelNumber=data.attachment.scene?.modelNumber;
    let known=catalogSourceChecks.get(data.cache);
    if(!known || known.modelNumber!==modelNumber) {
      const checked=(async()=>{
        const pdbId=data.cache.pdbId??await inspectionSourcePdbId(data.cache.structureText);
        if(!pdbId)return;
        const stages=MOLECULAR_EXPERIENCES.flatMap(experience=>experience.stages)
          .filter(stage=>stage.source.pdbId===pdbId.toUpperCase() && stage.assembly.assemblyId===data.attachment.catalog.assemblyId);
        for(const stage of stages) {
          try {await measureJourneyStage(stage,data.cache.structureText,stage.source.modelNumber??data.attachment.scene?.modelNumber);}
          catch(error) {journeyChecks.set(sourceKey(stage),`Journey stage ${stage.title} refused: ${(error as Error).message}`);}
        }
      })();
      known={modelNumber,checked};catalogSourceChecks.set(data.cache,known);
    }
    await known.checked;
    return journeyCatalog();
  }
  // Check every declared chapter before starting, using read-only resolution.
  // A bad later stage is disclosed, and only its own navigation is refused.
  async function prepareJourney(experience:MolecularExperience,data:Awaited<ReturnType<typeof current>>) {
    const pdbId=data.cache.pdbId??await inspectionSourcePdbId(data.cache.structureText);
    const texts=new Map<string,string>();
    if(pdbId)texts.set(pdbId.toUpperCase(),data.cache.structureText);
    for(const stage of experience.stages) {
      try {
        let text=texts.get(stage.source.pdbId);
        if(!text) {
          if(!hooks.resolveComparisonSource)throw Error('This host cannot verify the journey source before loading.');
          text=(await hooks.resolveComparisonSource({kind:'pdb',id:stage.source.pdbId})).structureText;
          texts.set(stage.source.pdbId,text);
        }
        await preflightExperienceStage(stage,text);
        await measureJourneyStage(stage,text,stage.source.modelNumber??(stage.source.pdbId===pdbId?.toUpperCase()?data.attachment.scene?.modelNumber:undefined));
      } catch(error) {
        journeyGeometry.delete(sourceKey(stage));
        journeyChecks.set(sourceKey(stage),`Journey stage ${stage.title} refused: ${(error as Error).message}`);
      }
    }
  }
  /**
   * A CONSISTENCY CHECK against what an author wrote
   * down, and never a statement about what a viewer can draw.
   *
   * An authored chapter declares how much content its own source holds. This
   * compares the extracted catalog with that declaration, so a deposit that
   * grew under the demo is caught before the chapter opens. The old sentence
   * called the declaration a budget, which read to a model like the viewer had
   * run out of room; nothing here was measured against any hardware.
   */
  function assertStageMatchesItsDeclaration(stage:MolecularExperienceStage,catalog:any):void {
    const rows=catalog.rows.length, atomSites=catalog.rows.reduce((n:number,row:any)=>n+row.atomSites.length,0);
    if(rows<=stage.assembly.maximumResiduePositions && atomSites<=stage.assembly.maximumAtomSites) return;
    throw Error(`This chapter's source holds more than it declares: ${rows.toLocaleString()} residue positions and `
      +`${atomSites.toLocaleString()} atom sites, against the declared ${stage.assembly.maximumResiduePositions.toLocaleString()} and `
      +`${stage.assembly.maximumAtomSites.toLocaleString()}.`);
  }
  async function preflightExperienceStage(stage:MolecularExperienceStage, structureText:string) {
    const digest=createHash('sha256').update(structureText,'utf8').digest('hex');
    const known=verifiedExperienceSources.get(stage.source.pdbId);
    if(known && known.sha256!==digest) throw Error(`Public experience source ${stage.source.pdbId} changed during this server session.`);
    const catalog:any=await extractInspectionCatalogBytes(structureText,{assemblyId:stage.assembly.assemblyId});
    validateExperienceAssembly(stage,catalog);
    if(stage.source.modelNumber!==undefined && !catalog.modelNumbers.includes(stage.source.modelNumber))
      throw Error(`Journey needs model ${stage.source.modelNumber}; this source does not contain it.`);
    assertStageMatchesItsDeclaration(stage,catalog);
    verifiedExperienceSources.set(stage.source.pdbId,{sha256:digest,byteLength:Buffer.byteLength(structureText,'utf8')});
    return {digest};
  }
  async function current(id:string) {
    const cache = hooks.current(id).structureCache;
    if (!cache) throw Error('Open a structure before inspecting it.');
    if (cache.format !== 'mmcif') throw Error('The inspector requires mmCIF coordinates. Use a PDB ID or mmCIF file; pasted PDB remains available in stereo_structure.open.');
    let experience=experienceSessions.get(id);
    // A normal `inspect`/`open` replacement must never inherit an experience
    // assembly or the previous step's provenance by accident.
    if(experience?.cache && experience.cache!==cache) { experienceSessions.delete(id); experience=undefined; }
    if(experience && !experience.cache) experience.cache=cache;
    let assemblyRequest=assemblyRequests.get(id);
    if(assemblyRequest?.cache && assemblyRequest.cache!==cache) { assemblyRequests.delete(id); assemblyRequest=undefined; }
    if(assemblyRequest && !assemblyRequest.cache) assemblyRequest.cache=cache;
    let pending = attachments.get(cache);
    if (!pending) {
      pending = (async () => {
        let catalog:any;
        const requestedAssemblyId=experience?.stage.assembly.assemblyId ?? assemblyRequest?.assemblyId ?? cache.sourceSelection?.assemblyId;
        try { catalog=await extractInspectionCatalogBytes(cache.structureText,requestedAssemblyId ? {assemblyId:requestedAssemblyId} : undefined); }
        catch(error) {
          // A named assembly that the entry does not declare is a caller
          // mistake with a precise cause; every other failure is unreadable
          // coordinates and keeps the message it always had.
          const detail=error instanceof Error?error.message:'';
          if(requestedAssemblyId && /^Assembly /u.test(detail)) throw Error(`${detail} Open the entry without an assembly, or name one it declares.`);
          throw Error('The structure could not be read as supported mmCIF. Use a PDB ID or a complete mmCIF coordinate file.');
        }
        if(experience) {
          const digest=createHash('sha256').update(cache.structureText,'utf8').digest('hex');
          const known=verifiedExperienceSources.get(experience.stage.source.pdbId);
          if(known && known.sha256!==digest) throw Error(`Public experience source ${experience.stage.source.pdbId} changed during this server session.`);
          verifiedExperienceSources.set(experience.stage.source.pdbId,{sha256:digest,byteLength:Buffer.byteLength(cache.structureText,'utf8')});
          experience.sourceSha256=digest;
          validateExperienceAssembly(experience.stage,catalog);
        }
        const transport=inspectionCatalogTransport(catalog);
        // The former 20,000-residue-position default,
        // the 30,000 a named assembly got instead, and the 200,000 atom sites
        // kept one hydration response small. No viewer and no host was ever
        // measured at any of the three. Chunked hydration removed the reason
        // for those limits, and they were still
        // refusing GroEL-sized assemblies on a desktop that has no measured
        // ceiling at all.
        //
        // What bounds this process now is byte policy that names itself as
        // policy: MAX_STRUCTURE_SOURCE_BYTES on the way in, and the 64 MiB
        // decode and 256 MiB factored-canonical bounds in
        // inspection-catalog-codec.ts, which are memory bounds for the machine
        // doing the decoding. The one measured hardware ceiling,
        // QUEST2_ATOM_SITE_CEILING, still refuses a tier on the one path that
        // knows the paired device class.
        //
        // An authored chapter keeps its own declaration, because that is the
        // author's statement about the demo's content rather than anything a
        // viewer was measured to refuse.
        if(experience) assertStageMatchesItsDeclaration(experience.stage,catalog);
        const handoff=sourceHandoffs.get(cache);
        if(hooks.current(id).structureCache!==cache) throw Error('The source changed while preparing inspection. Reopen the latest session.');
        let library=sessionLibraries.get(id);
        if(!library) {
          library={views:new InspectionViews(),comparisonAssets:new Map(),commandIds:new Set()};
          sessionLibraries.set(id,library);
        }
        const attachment:Attachment={ sourceToken:randomUUID(),catalog,transport,revision:0,scene:null,commands:handoff?.commands??new InspectionCommands(hooks.now,library.commandIds),
          ...(handoff?{shared:handoff.shared,sourceContinuation:handoff,sourceRenderWait:new SourceRenderWait(),
            transitionTarget:{panelId:handoff.panelId,expiresAt:transitionNow()+TRANSITION_TARGET_LEASE_MS}}:{}),
          history:new SceneHistory(hooks.now ?? Date.now),views:library.views,comparisonAssets:library.comparisonAssets,...(experience?{experience}:{}) };
        // The queue states the same budget the state publishes, so a
        // receipt and `get_inspection_state` never disagree about how long this
        // host is prepared to wait for this source. A handed-off queue is told
        // again here, because the source it now serves is a different size.
        attachment.commands.setRenderBudget(renderBudgetForCatalog(catalog));
        pruneComparisonAssets(attachment);
        return attachment;
      })();
      attachments.set(cache,pending);
      pending.catch(() => attachments.delete(cache));
    }
    const attachment = await pending;
    attachment.commands.setRenderBudget(renderBudgetForCatalog(attachment.catalog));
    const latest = hooks.current(id);
    if (latest.structureCache !== cache) throw Error('The source changed while preparing inspection. Reopen the latest session.');
    const previousVoiceSource=voiceSourceBySession.get(id);
    if(previousVoiceSource && previousVoiceSource!==attachment.sourceToken && voice) {
      voice.intents.clear({sessionId:id,sourceToken:previousVoiceSource});
      voice.playbacks.clear({sessionId:id,sourceToken:previousVoiceSource});
    }
    voiceSourceBySession.set(id,attachment.sourceToken);
    // A LAN token is scoped to the exact source capability. Source replacement
    // makes the loopback callback reject, but the LAN listener itself must also
    // retire instead of leaving a stale pairing/viewer endpoint until expiry.
    if (lanOwner?.sessionId === id && lanOwner.sourceToken !== attachment.sourceToken && !authorizedSourceRetarget.has(id)) {
      lanOwner = undefined;
      // current() can be called from a request already being served by this
      // LAN listener. Awaiting server.close() there can wait on the same
      // response that cannot finish until current() returns.
      void lan.close().catch(() => {});
    }
    const data={ cache, attachment, stateRevision:latest.stateRevision };
    // An edit queued for a headset page that has since paused is
    // saved before any call reads or changes the inspection. The first call
    // after the page froze may come long after the queue's deadline, and it
    // may be another edit or the page's own first beat after waking, so no
    // one tool can be relied on to do it.
    keepQueuedForWearer(id,data);
    return data;
  }
  /**
   * The one named-view listing policy, used everywhere a
   * library is reported (inspection state, tool list/delete answers, save
   * receipts, hydration). Every session entry is listed with its source
   * identity, never silently filtered to the current source: panels and agents
   * label entries saved on another structure, model or assembly instead, and
   * restore/delete still refuse a foreign entry with an explicit error, so a
   * view is never silently reused across sources.
   */
  function namedViewsPayload(data:Awaited<ReturnType<typeof current>>) {
    return {scope:'live-session' as const,maximum:MAX_INSPECTION_VIEWS,entries:data.attachment.views.list()};
  }
  // `text` replaces the default sentence for a call whose outcome the agent
  // has to relay in words, such as whether the page actually reached the
  // headset. Every other caller keeps the state sentence it always had.
  function releaseFinishedHistoryClaims(id:string,data:Awaited<ReturnType<typeof current>>) {
    const pending=new Set(data.attachment.commands.summary(binding(id,data)).pendingCommand.map(command=>command.commandId));
    data.attachment.history.releaseFinishedClaims(commandId=>pending.has(commandId));
  }
  function pruneComparisonAssets(a:Attachment,keep?:InspectionScene) {
    const scenes=[keep,a.scene,...a.history.retainedEntries().flatMap(entry=>[entry.before,entry.after]),
      ...a.views.list().map(view=>a.views.restore(view.id,view).supportedScene)];
    const keys=new Set(scenes.map(scene=>scene?.inspection.companionStructure).filter(Boolean)
      .map(value=>`${value!.sourceSha256}:${value!.assemblyId}`));
    for(const [key,asset] of a.comparisonAssets??[]) {
      if(!keys.has(key)) { a.comparisonAssets!.delete(key); continue; }
      const descriptors=new Set(scenes.map(scene=>scene?.inspection.companionStructure)
        .filter(value=>value && `${value.sourceSha256}:${value.assemblyId}`===key).map(value=>JSON.stringify(value!.source)));
      asset.sources=[...descriptors].map(value=>JSON.parse(value));
    }
  }
  function validateComparisonScene(a:Attachment,scene:InspectionScene):void {
    const value=scene.inspection.companionStructure;
    if(!value) return;
    const asset=a.comparisonAssets?.get(`${value.sourceSha256}:${value.assemblyId}`);
    if(!asset || !asset.catalog.modelNumbers.includes(value.modelNumber))
      throw Error('The comparison source, model or assembly was not verified in this session.');
    if(!asset.sources.some(source=>JSON.stringify(value.source)===JSON.stringify(source)))
      throw Error('The comparison source descriptor does not match its verified coordinates.');
  }
  const comparisonTransport=comparisonDescriptor;
  function comparisonPayloads(a:Attachment, ...values:unknown[]) {
    const hashes=new Set<string>();
    const visit=(value:any)=>{
      if(!value || typeof value!=='object') return;
      if(value.source && value.sourceSha256 && value.placement && value.appearance) hashes.add(`${value.sourceSha256}:${value.assemblyId}`);
      for(const child of Object.values(value)) if(child && typeof child==='object') visit(child);
    };
    values.forEach(visit);
    return [...hashes].map(hash=>{
      const asset=a.comparisonAssets?.get(hash);
      if(!asset) throw Error('The comparison coordinates are unavailable in this session.');
      return comparisonTransport(asset);
    });
  }
  /**
   * How long THIS host will wait for a panel to load and
   * save the source it is holding, stated so no caller has to invent a number.
   *
   * It is `panelWaitMs(atomSites, PANEL_SAVE_WAIT)`: the same size-aware
   * formula `quest-share.ts` already sizes its own panel wait with, so the
   * host, the share and the agent CLI all mean one thing by "the budget".
   * 4,779 atom sites — 4HHB, the structure a wearer asked for —
   * comes to 130 s. The agent CLI used to cap its wait at 25-30 s and report a
   * timeout while the headset was rendering correctly.
   *
   * Cached per catalog: the count is a reduce over every residue row and the
   * state is polled several times a second.
   */
  const renderBudgets=new WeakMap<object,number>();
  function renderBudgetForCatalog(catalog:{rows?:{atomSites?:unknown[]}[]}|undefined):number {
    if(!catalog||!Array.isArray(catalog.rows)) return panelWaitMs(undefined,PANEL_SAVE_WAIT);
    const cached=renderBudgets.get(catalog);
    if(cached!==undefined) return cached;
    let atomSites=0;
    for(const row of catalog.rows) atomSites+=Array.isArray(row?.atomSites)?row.atomSites.length:0;
    const budget=panelWaitMs(atomSites,PANEL_SAVE_WAIT);
    renderBudgets.set(catalog,budget);
    return budget;
  }
  function renderBudgetMsFor(data:Awaited<ReturnType<typeof current>>):number {
    return renderBudgetForCatalog(data.attachment.catalog as {rows?:{atomSites?:unknown[]}[]}|undefined);
  }
  /** Initial loading has no replacement operation. Keep its advisory tied to
   * the panel that actually saved/attached, choosing the same current surface
   * priority as ordinary implicit edits. A replacement wait always takes over. */
  function initialSourceAdvisory(id:string,data:Awaited<ReturnType<typeof current>>) {
    const a=data.attachment, receipts=a.initialSourceAdvisories;
    if(a.sourceRenderWait || !receipts?.size)return undefined;
    const b=binding(id,data), all=a.commands.summary(b).panels;
    const registered=new Set(all.map(panel=>panel.panelId));
    for(const [panelId,receipt] of receipts)
      if(!registered.has(panelId) || receipt.sourceToken!==b.sourceToken)receipts.delete(panelId);
    const panels=all.filter(panel=>panel.current && panel.availability!=='unsaved' && panel.surface!==DETAILED_SURFACE);
    const wearer=a.commands.wearerPage(b);
    const selected=panels.find(panel=>panel.panelId===wearer.panelId) ?? panels.find(panel=>isWearerSurface(panel.surface))
      ?? panels.find(panel=>panel.surface==='desktop') ?? panels[0];
    return selected?receipts.get(selected.panelId):undefined;
  }
  function result(id:string, data:Awaited<ReturnType<typeof current>>, extra:Record<string,unknown> = {}, text?:string) {
    const hasProvidedModelContext=Object.prototype.hasOwnProperty.call(extra,'modelContext');
    const {modelContext:providedModelContext,...publicExtra}=extra;
    const modelContext=hasProvidedModelContext
      ? providedModelContext as InspectionModelContext|undefined
      : optionalInspectionModelContext(()=>inspectionModelContextFor(id,data));
    const wearer=wearerLinkFor(id,data);
    const settledRender=data.attachment.sourceRenderWait?.settled() ?? initialSourceAdvisory(id,data);
    const sourceKind=data.cache.sourceKind??(data.cache.pdbId?'pdb':'pasted');
    const history=data.attachment.history;
    const historyBusy=data.attachment.commands.hasPending(binding(id,data));
    releaseFinishedHistoryClaims(id,data);
    // Some hosts hand the model only this sentence, never structuredContent, so
    // the facts an agent has to report (source, token, wearer, receipt) are in it.
    // The same hosts cannot copy a binding out of structuredContent either, and
    // every change tool asks for one (Claude Science read "a
    // one-line prose summary" and could not form a placement patch), so the
    // sentence also carries what those tools need copied.
    const panelsForText=Array.isArray((extra as {panels?:unknown}).panels)
      ? (extra as {panels:{panelId?:string;surface?:string;availability?:string;current?:boolean}[]}).panels : [];
    const bindingLine=` Binding for changes: sessionId ${id}, serverEpoch ${hooks.serverEpoch}, `
      +`baseStateRevision ${data.stateRevision}, baseInspectionRevision ${data.attachment.revision}`
      +(panelsForText.length
        ? `; panels: ${panelsForText.map(panel=>`${panel.surface??'panel'} panelId ${panel.panelId??'unknown'} (${panel.availability??'unknown'}${panel.current?', current':''})`).join(', ')}.`
        : '; no panel is mounted, so nothing can render a change.');
    const stateLine=`Stereofold inspection state: source ${sourceKind}${data.cache.pdbId?` ${data.cache.pdbId}`:''}, sourceToken ${data.attachment.sourceToken}, `
      +`scene ${data.attachment.scene?'saved':'none'}, wearer ${wearer.linked?'linked':'not linked'} (${wearerStateText(wearer,(hooks.now??Date.now)())}), `
      +`render receipt ${settledRender?.status??'not settled'}.`+bindingLine
      +(wearer.shareOpen && !wearer.share?' The private Wi-Fi share is open; no headset has paired yet.':'')
      +(wearer.pageOutdated?` ${wearer.note}`:'')
      +(settledRender?.status==='rendered' && settledRender.geometryBudget?` ${settledRender.geometryBudget.message}`:'');
    return { content:[{type:'text' as const,text:text ?? (extra.kind==='inspect'
      ? 'Stereofold session opened. The panel still needs to load and render the structure. Check get_inspection_state for hasScene and a current ready panel before reporting it as visible.'
      : stateLine)}], structuredContent:{kind:'inspection',sourceGeometryBudget:true,rendererContext:true,sessionId:id,serverEpoch:hooks.serverEpoch,
      stateRevision:data.stateRevision,inspectionRevision:data.attachment.revision,sourceToken:data.attachment.sourceToken,shared:Boolean(data.attachment.shared),hasScene:Boolean(data.attachment.scene),
      // Read this before reporting any receipt beside it as seen.
      wearer,
      ...(data.attachment.sourceContinuation && failedSourceOwnerReady(data,data.attachment.sourceContinuation.panelId)
        ? {sourceRecovery:{panelId:data.attachment.sourceContinuation.panelId,ready:true}} : {}),
      ...(modelContext?{modelContext}:{}),
      // The host's own wait budget for this source, so an
      // agent following a render never has to invent a cap of its own.
      renderBudgetMs:renderBudgetMsFor(data),
      // The selected initial advisory or source replacement's own proof,
      // kept readable after its initiating call returns. A caller whose host wait
      // ran out follows `get_inspection_state` to the same receipt rather than
      // deciding for itself that a settled scene counts as a render.
      ...(settledRender
        ?{sourceRenderReceipt:{...settledRender,rendered:settledRender.status==='rendered',renderBudgetMs:renderBudgetMsFor(data)}}:{}),
      sourceKind:data.cache.sourceKind??(data.cache.pdbId?'pdb':'pasted'),
      sourceSelection:{modelNumber:data.attachment.scene?.modelNumber??data.cache.sourceSelection?.modelNumber??data.attachment.catalog.modelNumbers[0],assemblyId:data.attachment.catalog.assemblyId},
      // The host knows whether the page's own origin serves the
      // full Mol* viewer, so the headset's "Open in Mol*" press needs no probe
      // of its own. A probe failure used to read as "not served here" and sent
      // the viewer to a Mac monitor the wearer could not see.
      detailedViewAvailable:companion.servesDetailedView,
      ...(data.attachment.experienceCompletion?{experienceCompletion:data.attachment.experienceCompletion}:{}),
      namedViews:namedViewsPayload(data),
      history:{undoCount:history.size(),redoCount:history.redoSize(),
        canUndo:!historyBusy && Boolean(history.last()),canRedo:!historyBusy && Boolean(history.lastRedo())},
      ...(data.attachment.experience?{experience:{id:data.attachment.experience.experience.id,revision:data.attachment.experience.revision,
        stepIndex:data.attachment.experience.stepIndex,stageId:data.attachment.experience.stage.id,applied:data.attachment.experience.acknowledgements.size>0}}:{}),...publicExtra} };
  }
  function binding(id:string,data:Awaited<ReturnType<typeof current>>) {
    const latest=hooks.current(id);
    if(latest.structureCache!==data.cache) throw Error('The source changed. Reopen the current inspection.');
    data.stateRevision=latest.stateRevision;
    return {serverEpoch:hooks.serverEpoch,sourceToken:data.attachment.sourceToken,stateRevision:data.stateRevision,inspectionRevision:data.attachment.revision};
  }
  const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const mutation={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
  const toursFor=(attachment:Attachment):readonly Tour[] => attachment.customTour ? [...TOURS,attachment.customTour] : TOURS;
  /**
   * The loaded lesson's colour key, once.
   *
   * A lesson repeats the same key in every chapter so the wearer learns one
   * mapping; this is that key with the repeats collapsed, and it is what makes
   * "show me the guide RNA" answerable — an agent can read the names the wearer
   * is being taught instead of guessing a chain letter.
   */
  const lessonEmphasisParts=(tour?:Tour) => {
    const seen=new Map<string,any>();
    for(const step of tour?.steps??[]) for(const part of (step as any).emphasis?.parts??[]) {
      if(seen.has(part.id)) continue;
      seen.set(part.id,{id:part.id,label:part.label,color:part.color,
        ...(part.chain?{chain:part.chain}:{}),
        ...(part.residues?{residues:{from:part.residues.from,to:part.residues.to}}:{})});
    }
    return [...seen.values()];
  };
  function compactReadinessFor(id:string,data:Awaited<ReturnType<typeof current>>):InspectionReadinessSummary {
    const readiness=assembleReadiness({...cachedReadinessFacts(data,id),headset:panelHeadsetCheck?.value??{checked:false}});
    return {ready:readiness.ready,blocking:readiness.blocking,scope:'headset-microphone-session'};
  }
  function inspectionModelContextFor(id:string,data:Awaited<ReturnType<typeof current>>,panelId?:string,
    readiness?:InspectionReadinessSummary):InspectionModelContext {
    const b=binding(id,data), panels=data.attachment.commands.summary(b).panels;
    const panel=panelId ? panels.find(candidate=>candidate.panelId===panelId) : panels.find(candidate=>candidate.current);
    const heartbeat=panel?.tour ?? undefined;
    const tours=[...toursFor(data.attachment),...MOLECULAR_EXPERIENCES];
    const selected=heartbeat?.selectedId ? tours.find(tour=>tour.id===heartbeat.selectedId) : undefined;
    // A panel heartbeat describes the displayed chapter; a loaded definition
    // is only a fallback before the panel has reported any tour state.
    const lesson=heartbeat ? (heartbeat.active ? selected : undefined) : data.attachment.customTour;
    const step=lesson && heartbeat && heartbeat.step>=0 && heartbeat.step<lesson.steps.length ? lesson.steps[heartbeat.step] : undefined;
    const detailed=detailedViewSummary({panels,selection:data.attachment.detailedSelection,now:(hooks.now??Date.now)()});
    const livePick=detailed?.current && detailed.selection && !detailed.selection.stale
      && (!panelId || panelId===detailed.selection.panelId);
    return createInspectionModelContext({
      selectionKeys:livePick ? data.attachment.detailedSelection!.keys : data.attachment.scene?.selectionKeys??[],
      catalog:data.attachment.catalog,
      lesson:lesson ? {id:lesson.id,title:lesson.title} : null,
      chapter:lesson && step && heartbeat ? {id:step.id,title:step.title,index:heartbeat.step+1,total:lesson.steps.length} : null,
      emphasis:data.attachment.scene?.inspection.emphasis,
      readiness:readiness??compactReadinessFor(id,data),
    });
  }
  /**
   * Turn the part names a caller wrote into the lesson's key.
   *
   * "this" and "that" are answered from the referent the request started with,
   * so a delayed answer lights the part the person was on when they asked
   * rather than whatever is lit now. Every other name resolves exactly as
   * `emphasize` has always resolved one.
   */
  function emphasisPatchFor(attachment:Attachment, names:readonly string[], context:number|undefined, referent?:RequestReferent) {
    const key=lessonEmphasisParts(attachment.customTour);
    if(names.length && !key.length)
      throw Error('This inspection has no lesson colour key, so it has no named parts to emphasise. Open a lesson with inspect_lesson first.');
    const focus=names.map(name=>{
      if(isReferentPronoun(name)) {
        if(!referent) throw Error(`"${name}" needs the referent this request started with. Pass the referent listen_voice returned, or name a part from lesson.parts.`);
        if(referent.sourceToken!==attachment.sourceToken)
          throw Error('That request was captured on a different structure. Read get_inspection_state and ask again.');
        if(!referent.partId && (referent.selectionKeys.length || referent.residueKey))
          throw Error('That request captured canonical residues, not a named lesson part. Selection-only emphasis is unsupported; use focus_selection with the captured referent or explicitly name a lesson part.');
        if(!referent.partId) throw Error(`Nothing was pointed at or lit when that request began, so "${name}" names no part. Use one of lesson.parts.`);
        if(!key.some(part=>part.id===referent.partId))
          throw Error('The part that request began on is not in this lesson’s colour key. Use one of lesson.parts.');
        return referent.partId;
      }
      const id=resolveEmphasisPartId(key,name);
      if(!id) throw Error(`This lesson does not name a part called "${name}". Read get_inspection_state and use one of lesson.parts.`);
      return id;
    });
    // Clearing drops the key with the focus: an empty emphasis is the plain
    // structure, not an unlit colour key.
    return {key,focus,patch:{parts:focus.length?key:[],focus,contextOpacity:context??DEFAULT_CONTEXT_OPACITY}};
  }
  /** The chain identities of the saved model, which is what a caller may name. */
  function visibilityChainsOf(attachment:Attachment):{labelChain:string;copyId:string}[] {
    const scene=attachment.scene;
    return scene ? availableChains(attachment.catalog.rows,scene.modelNumber) : [];
  }
  /**
   * The component classes the saved model actually holds.
   *
   * The same question the chains above answer, asked of water, ligands, ions
   * and the polymer, and answered from the catalog this session opened rather
   * than from the four names a request may spell.
   */
  function visibilityClassesOf(attachment:Attachment):string[] {
    const scene=attachment.scene;
    return scene ? componentClassesPresent(attachment.catalog.rows,scene.modelNumber) : [];
  }
  /** Every visibility patch in one request, whether it arrived alone or in a compound. */
  function visibilityPatchesOf(change:any):any[] {
    if(change?.kind==='visibility') return [change.patch];
    if(change?.kind==='compound') return change.patch.ops.filter((op:any)=>op.kind==='visibility').map((op:any)=>op.patch);
    return [];
  }
  /**
   * Whether a request asks for an intersection — `only` naming both
   * a chain and a class. That and an absent class are the two cases the
   * structure's own name is read for, because both can end in a refusal the
   * wearer should hear the file named in.
   */
  function namesVisibilityIntersection(change:any):boolean {
    return visibilityPatchesOf(change).some((patch:any)=>patch?.op==='only' && patch.chains?.length && patch.classes?.length);
  }
  /**
   * Which classes a visibility request named that this structure has none of.
   *
   * Read for the reply rather than for the decision: `resolveVisibility` refuses
   * or drops them on its own, and this is how the wearer is told which half of a
   * request naming some of each was not there to change.
   */
  function absentVisibilityClassesIn(attachment:Attachment, change:any):string[] {
    const patches=visibilityPatchesOf(change);
    if(!patches.length || !attachment.scene || attachment.density) return [];
    const present=visibilityClassesOf(attachment), named=new Set<string>();
    // `only` is read here too. A request naming one class this file
    // holds and one it does not keeps the first and drops the second, and the
    // reply has to say which half was never there — the same sentence hide and
    // show have carried since then.
    for(const patch of patches)
      if(patch.op==='hide' || patch.op==='show' || patch.op==='only')
        for(const name of absentVisibilityClasses(patch.classes,present)) named.add(name);
    return VISIBILITY_COMPONENT_CLASSES.filter((name:string)=>named.has(name));
  }
  /**
   * What a refusal calls this structure: its deposited code where there is one.
   *
   * "1CRN has no water to hide." names the file the wearer is looking at, which
   * is the difference between a limit they can act on and a flat no. Reading the
   * code out of pasted coordinates costs a parse, so it is only read once
   * something really is absent.
   */
  async function structureNameFor(data:{cache:Cache}):Promise<string|undefined> {
    if(data.cache.pdbId) return data.cache.pdbId.toUpperCase();
    try { return await inspectionSourcePdbId(data.cache.structureText); } catch { return undefined; }
  }
  /**
   * Turn "hide chain B" into the hidden set the panel renders.
   *
   * The request says what to change; the change says what the picture is. That
   * is the same shape the emphasis op has, and for the same reason: the panel
   * then needs no memory of what was hidden a moment ago, one undo entry
   * carries the whole earlier set, and a named view restores by replay.
   *
   * An identity this model does not have is refused HERE rather than sent on.
   * A panel asked to hide a chain it cannot find has no picture to answer with,
   * so the command would sit queued and come back `unconfirmed` — the wearer
   * waits through a render that was never possible and is then told nothing
   * useful. The refusal names what there is instead.
   */
  function visibilityPatchFor(attachment:Attachment, patch:VisibilityRequestPatch, structure?:string):InspectionVisibility {
    if(!attachment.scene) throw Error('Load and save the intended inspection before hiding part of it.');
    if(attachment.density) throw Error('This session is drawing a density map, which is one isosurface with no chains or components in it. Nothing in it can be hidden separately.');
    // A class this structure has none of is refused on the same
    // terms as a chain it does not have, rather than queued as a picture the
    // panel would answer by changing nothing.
    const resolved=resolveVisibility(attachment.scene.inspection.visibility,patch,visibilityChainsOf(attachment),
      {classes:visibilityClassesOf(attachment),...(structure?{structure}:{})}) as InspectionVisibility;
    // A request that asks to SHOW something never saves a scene with
    // nothing on the screen. `only` is a complement, so "only the ligand" on a
    // file with no ligand, or "only the ligands of chain C" where chain C holds
    // none, computes a hidden set that covers every row — a blank panel under an
    // `Applied` receipt. `resolveVisibility` refuses the absent class by name;
    // this catches the intersection that empties a scene without any class being
    // absent. An explicit hide is left alone: a wearer who says "hide the
    // polymer" on a polymer and nothing else asked for the empty screen, was
    // told what was hidden, and has one undo back.
    if(patch.op==='only' && visibilityHidesEverything(attachment.catalog.rows,resolved,attachment.scene.modelNumber))
      throw Error(`${structure||'This structure'} has nothing that is both of those, so showing only it would leave the panel empty. `
        +'Name one of them on its own, or use op="reset" to bring everything back.');
    return resolved;
  }
  /**
   * One request's ops, resolved into the change the panel runs.
   *
   * Only the emphasis and visibility ops are written differently from the
   * change they become: a caller names lesson parts, or names what to hide and
   * show, and the server expands each into the whole colour key and the whole
   * hidden set, exactly as `emphasize` and a lone visibility change do. So
   * composing a compound never means retyping a chain letter or restating what
   * was already hidden. The other three arrive already in their final shape.
   */
  function resolveCompound(attachment:Attachment, change:any, referent?:RequestReferent, scope?:'scene', structure?:string):InspectionChange {
    let carried=attachment.scene!;
    const ops=change.patch.ops.flatMap((op:any):InspectionCompoundOp[] => {
      const resolved:InspectionChange=op.kind==='emphasis'
      ? {kind:'emphasis',patch:emphasisPatchFor(attachment,op.parts,op.context,referent).patch}
      : op.kind==='visibility' ? {kind:'visibility',patch:visibilityPatchFor(attachment,op.patch,structure)} as InspectionCompoundOp
      : op.kind==='selection' && op.patch.residues ? {kind:'selection',patch:{selectionKeys:regionKeys(attachment,op.patch.residues)}}
      : resolveScopedAppearance(op,carried,referent,scope,op.kind==='appearance'&&op.residues?regionKeys(attachment,op.residues):undefined);
      carried=expectedInspection(carried,resolved);
      return resolved.kind==='compound'?resolved.patch.ops:[resolved as InspectionCompoundOp];
    });
    const folded=foldStyles(ops);
    return folded.length===1?folded[0] as InspectionChange:{kind:'compound',patch:{ops:folded}};
  }
  /**
   * Several region styles in one request become the one styles edit a panel
   * renders. Each was built on the scene the one before it left, so the last
   * already holds every layer; it takes the union of the keys they styled.
   */
  function foldStyles(ops:InspectionCompoundOp[]):InspectionCompoundOp[] {
    const styles=ops.filter((op):op is Extract<InspectionCompoundOp,{kind:'styles'}>=>op.kind==='styles');
    if(styles.length<2) return ops;
    const last=styles[styles.length-1];
    const selectionKeys=[...new Set(styles.flatMap(op=>op.patch.selectionKeys??[]))];
    const folded:InspectionCompoundOp={kind:'styles',patch:{styles:last.patch.styles,...(selectionKeys.length?{selectionKeys}:{})}};
    return ops.filter(op=>op.kind!=='styles' || op===last).map(op=>op===last?folded:op);
  }
  /** The canonical keys a caller's region names, refused by name when it names none. */
  function regionKeys(attachment:Attachment, residues:Record<string,unknown>):string[] {
    const keys=inspectionResidueKeys(attachment.catalog,attachment.scene,residues as any);
    if(!keys.length) throw Error(`No residue in this model matches ${Object.entries(residues)
      .map(([field,value])=>`${field} ${Array.isArray(value)?value.join('–'):value}`).join(', ')}. `
      +'Read visibilityTargets or get_inspection_state with residues to see what it has.');
    return keys;
  }
  const namesRegion=(change:any)=>(change.kind==='compound'?change.patch.ops:[change])
    .some((op:any)=>op.residues!==undefined || (op.kind==='selection' && op.patch?.residues!==undefined));
  /**
   * Style layers as a model reads them: counted, and named by chain and
   * component, never as the key list. A chain-wide style is thousands of
   * characters of keys, and echoing them in every state read cost more than the
   * edit that made them. The saved scene and the page keep the keys.
   */
  function modelStyles(styles:readonly {selectionKeys:readonly string[]}[], catalog:{rows:readonly {key:string;identity:{labelChain:string;componentId:string}}[]}) {
    const rows=new Map(catalog.rows.map(row=>[row.key,row.identity]));
    return styles.map(({selectionKeys,...style})=>{
      const identities=selectionKeys.flatMap(key=>rows.get(key) ?? []);
      const labelChains=[...new Set(identities.map(identity=>identity.labelChain))];
      const componentIds=[...new Set(identities.map(identity=>identity.componentId))];
      return {...style,residueCount:selectionKeys.length,labelChains:labelChains.slice(0,16),
        ...(componentIds.length<=8?{componentIds}:{})};
    });
  }
  /** Which surface a queued command is being rendered by, for the history. */
  const surfaceOfPanel=(attachment:Attachment,panelId:string):SceneHistorySurface =>
    attachment.commands.surfaceOf(panelId) ?? 'unknown';
  /** The byte budget a panel's rendered scene is held to, for a scene saved without one. */
  const hydrationCheck=(a:Attachment)=>(scene:InspectionScene)=>{
    assertInspectionBudget({scene,comparisonSources:comparisonPayloads(a,scene)},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
  };
  type KeptEdit={command:{commandId:string;panelId:string;savedRevision?:number;utteranceId?:string};scene:InspectionScene;
    pause:{reason:WearerPause;checkedInMsAgo:number}};
  /**
   * Commit an edit saved for a paused headset page.
   *
   * The command is already recorded as `saved`. This makes the saved scene hold
   * it, in the order `complete_inspection` commits a rendered one: scene and
   * revision, then the utterance binding, then the shared history, so undo
   * takes it back like any other edit. The page follows the new revision the
   * first time it checks in awake, the way it follows an edit made on the Mac.
   *
   * No panel render stands between this commit and the request, so nothing
   * else would catch a revision that moved while the tool call was waiting.
   * `b` is therefore the live binding (`keepLive`), read in the same
   * synchronous step as the commit, never one read before an await.
   */
  function commitKept(data:Awaited<ReturnType<typeof current>>,b:InspectionBinding,kept:KeptEdit) {
    const a=data.attachment, before=a.scene;
    a.scene=kept.scene; a.revision=kept.command.savedRevision!;
    a.commands.continueUtterance(kept.command.utteranceId,kept.command.panelId,b,{...b,inspectionRevision:a.revision});
    if(a.history.isUndo(kept.command.commandId)) a.history.settleUndo(kept.command.commandId,true);
    else if(a.history.isRedo(kept.command.commandId)) a.history.settleRedo(kept.command.commandId,true);
    else if(before) a.history.record({origin:'command',surface:'companion',
      label:a.commands.changeKindOf(kept.command.commandId) ?? 'command',before,after:kept.scene});
  }
  /** Save an edit queued just before its headset page paused. See `keepQueuedForPausedWearer`. */
  function keepQueuedForWearer(sessionId:string,data:Awaited<ReturnType<typeof current>>) {
    try {
      const b=binding(sessionId,data), kept=data.attachment.commands.keepQueuedForPausedWearer(b,hydrationCheck(data.attachment));
      if(kept) commitKept(data,b,kept);
    } catch { /* A read or a heartbeat never fails because a queued edit could not be kept. */ }
  }
  /**
   * Save an edit for a paused headset page against the live
   * binding, and commit it in the same synchronous step.
   *
   * A tool reads its binding when it starts and may wait before it gets here,
   * as `update_inspection` does to name a structure. Another agent's saved
   * edit or a Mac panel's `sync_inspection` can commit in that wait, and a
   * saved revision taken from the earlier binding would reuse that revision or
   * roll it back. The request's own base revisions are compared with the live
   * ones instead, the way `sync_inspection` checks at its commit, so a stale
   * request is refused.
   */
  function keepLive(sessionId:string,data:Awaited<ReturnType<typeof current>>,input:Parameters<InspectionCommands['keepForPausedWearer']>[0],
    tool:string) {
    (input as any)[editAdmissionSignal]?.throwIfAborted();
    const live=binding(sessionId,data);
    const kept=data.attachment.commands.keepForPausedWearer(input,live,data.attachment.scene,tool,hydrationCheck(data.attachment));
    if(kept) commitKept(data,live,kept);
    return kept;
  }
  /**
   * Queue the change that takes the last operation back.
   *
   * The history is the shared scene's, so this answers the same way whether it
   * was reached by the headset phrase, the desktop panel or an agent tool, and
   * it takes back an operation from any of the three. The entry is held, not
   * dropped, until the panel confirms the render: an undo that never lands
   * must leave the same thing still there to undo.
   */
  async function queueUndo(input:{sessionId:string;serverEpoch:string;sourceToken:string;
    baseStateRevision:number;baseInspectionRevision:number;panelId:string;commandId:string;utteranceId?:string}) {
    const data=await current(input.sessionId), b=binding(input.sessionId,data), a=data.attachment;
    (input as any)[editAdmissionSignal]?.throwIfAborted();
    if(!a.scene) throw Error('Load and save the intended inspection before undoing anything.');
    releaseFinishedHistoryClaims(input.sessionId,data);
    if(a.commands.hasPending(b)) throw Error('An inspection command is already in progress. Check its status first.');
    const entry=a.history.last();
    if(!entry) return {data,undone:false as const,message:NOTHING_TO_UNDO};
    const change=undoChangeFor(entry);
    validateScene(expectedInspection(a.scene,change),a.catalog,a.density);
    const request={serverEpoch:input.serverEpoch,sourceToken:input.sourceToken,
      baseStateRevision:input.baseStateRevision,baseInspectionRevision:input.baseInspectionRevision,
      panelId:input.panelId,commandId:input.commandId,...(input.utteranceId?{utteranceId:input.utteranceId}:{}),change};
    // An undo for a paused headset page is saved like any edit.
    // It is claimed before the commit, so the commit settles the undo rather
    // than recording a new operation. Anything but a save releases the claim.
    a.history.claimUndo(input.commandId,entry);
    let kept:ReturnType<typeof keepLive>;
    try { kept=keepLive(input.sessionId,data,request,'update_inspection'); }
    finally { if(!kept) a.history.settleUndo(input.commandId,false); }
    if(kept) return {data,undone:true as const,message:UNDO_CONFIRMATION,command:kept.command,entry,change,kept};
    const command=a.commands.enqueue(request,b,a.scene);
    a.history.claimUndo(input.commandId,entry);
    return {data,undone:true as const,message:UNDO_CONFIRMATION,command,entry,change,kept:undefined};
  }
  /** Reapply the most recently undone shared operation through the same render lease. */
  async function queueRedo(input:{sessionId:string;serverEpoch:string;sourceToken:string;
    baseStateRevision:number;baseInspectionRevision:number;panelId:string;commandId:string;utteranceId?:string}) {
    const data=await current(input.sessionId), b=binding(input.sessionId,data), a=data.attachment;
    (input as any)[editAdmissionSignal]?.throwIfAborted();
    if(!a.scene) throw Error('Load and save the intended inspection before redoing anything.');
    releaseFinishedHistoryClaims(input.sessionId,data);
    if(a.commands.hasPending(b)) throw Error('An inspection command is already in progress. Check its status first.');
    const entry=a.history.lastRedo();
    if(!entry) return {data,redone:false as const,message:'Nothing to redo.'};
    const change=redoChangeFor(entry);
    validateScene(expectedInspection(a.scene,change),a.catalog,a.density);
    const request={serverEpoch:input.serverEpoch,sourceToken:input.sourceToken,
      baseStateRevision:input.baseStateRevision,baseInspectionRevision:input.baseInspectionRevision,
      panelId:input.panelId,commandId:input.commandId,...(input.utteranceId?{utteranceId:input.utteranceId}:{}),change};
    a.history.claimRedo(input.commandId,entry);
    let kept:ReturnType<typeof keepLive>;
    try { kept=keepLive(input.sessionId,data,request,'redo_last_change'); }
    finally { if(!kept) a.history.settleRedo(input.commandId,false); }
    if(kept) return {data,redone:true as const,message:'Change redone.',command:kept.command,entry,change,kept};
    const command=a.commands.enqueue(request,b,a.scene,'redo_last_change');
    a.history.claimRedo(input.commandId,entry);
    return {data,redone:true as const,message:'Change redone.',command,entry,change,kept:undefined};
  }
  // Assigned before any request can be served; keeping the declaration here
  // lets the model-visible state report bounded voice mailbox counts without
  // exposing transcripts or audio.
  let voice!: ReturnType<typeof registerInspectionVoiceTools>;
  registerAppTool(server,'stereo_structure.get_inspection_state',{
    title:'Read the current molecular inspection',
    description:'Read appearance, saved styles, placement, selection, visibility, panels and receipts without mounting a panel. With commandId, only rendered means drawn and saved at renderedRevision; queued/rendering are pending, cancelled/superseded were dropped, unconfirmed may have drawn without saving, and saved waits for a paused page to wake. Newer edits may have passed that revision. Edits fill omitted bindings automatically: no preflight read is needed. Read visibilityTargets and lesson.parts to resolve region names; residues pages canonical identities and keys (limit 128); never invent keys. tours lists available IDs; includeExperienceCatalog adds chapters and budgets. wearer.linked requires a paired headset page attached to this structure; otherwise rendered describes the desktop. shareOpen means a private Wi-Fi listener, not delivery or a pending launch. Follow wearer.note and launch outcome. If no launch was sent, use manage_companion action=launch, launch=auto, or Manual pairing; call open_companion again only when sharing is closed. wearer.state is no-page, page-open, entering-vr, in-vr, paused or unknown; only in-vr establishes immersive rendering. checkedInAt is epoch ms. For Web Launch/Safari, check every 5–10 seconds until pairing or pairingExpiresAt; never start competing pairing while prompts are pending. After pairing or adb dispatch, allow 60 seconds for progress, then use manage_companion action=status for recovery. Recover human handoffs after failure/expiry; do not poll indefinitely or claim unconfirmed delivery. Head position/view direction is transient molecule-local data: use only when stale=false; it is neither saved camera state nor gaze tracking. detailedView identifies the full Mol* viewer; its selection answers what-is-this. That panel accepts appearance, selection and emphasize only.',
    inputSchema:inspectionStateSchema,annotations:readOnly,_meta:{},
  },async({sessionId,commandId,residues,includeExperienceCatalog})=>{
    await hostBuildReady;
    // `current` saves an edit still queued for a page that has
    // since gone quiet, so this read never shows it expiring.
    const data=await current(sessionId);
    const b=binding(sessionId,data), scene=data.attachment.scene;
    const commandSummary=data.attachment.commands.summary(b,commandId);
    const sourceWait=data.attachment.sourceRenderWait;
    if(commandId && sourceWait?.commandId===commandId) {
      const receipt=sourceWait.settled();
      const ready=receipt?.status==='rendered' && data.attachment.commands.readyPanel(receipt.panelId,b);
      Object.assign(commandSummary,{command:{commandId,...(receipt??{sourceToken:b.sourceToken}),
        status:receipt?.status==='failed'?'failed':ready?'rendered':receipt?'unconfirmed':'rendering',rendered:Boolean(ready)}});
    }
    await showQueuedCommandConflicts(data.attachment.commands,b);
    // The wearer is in the full Mol* viewer and has
    // pointed at something. `detailedView` is how "what is this" and "explain
    // this part" get a referent while they are over there.
    const detailedView=detailedViewSummary({panels:commandSummary.panels,
      selection:data.attachment.detailedSelection,now:(hooks.now??Date.now)()});
    const detailedResidues=detailedView?.selection && scene
      ? inspectionResiduePage(data.attachment.catalog,{...scene,selectionKeys:data.attachment.detailedSelection!.keys},
        {selectedOnly:true,offset:0,limit:DETAILED_SELECTION_KEYS_SHOWN})
      : undefined;
    return result(sessionId,data,{operationInventory:inspectionOperationInventory,sourceOperation:data.attachment.sourceOperation??null,hasScene:Boolean(scene),view:scene?{modelNumber:scene.modelNumber,assemblyId:scene.assemblyId,
      selectedResidueCount:scene.selectionKeys.length,
      /**
       * The framing the panel saved, beside the placement it saved.
       *
       * Without it a run can read what the molecule's room transform is and
       * nothing about where the view is pointed, so "Done put the wearer back
       * where they were" was unfalsifiable from the state alone — every earlier run
       * capture read `cameraPose` as absent. Pose only: radius, fog and the
       * depth bounds belong to the renderer, exactly as `cameraPose` says.
       */
      cameraPose:cameraPose(scene.camera),...scene.inspection,
      ...(scene.inspection.styles?{styles:modelStyles(scene.inspection.styles,data.attachment.catalog)}:{}),
       ...(scene.inspection.companionStructure?{companionStructure:{...scene.inspection.companionStructure,
         source:scene.inspection.companionStructure.source.kind==='pasted'?{kind:'pasted'}:scene.inspection.companionStructure.source,
         residueCount:data.attachment.comparisonAssets?.get(`${scene.inspection.companionStructure.sourceSha256}:${scene.inspection.companionStructure.assemblyId}`)?.catalog.rows
           .filter((row:any)=>row.identity.modelNumber===scene.inspection.companionStructure!.modelNumber).length,
         alignment:'side-by-side',selectionScope:'primary-only'}}:{})}:null,
      /**
       * What the wearer is actually looking at on a density
       * tier, in the unit that tier is measured in.
       *
       * Without this the state reads as the seed structure alone — 43,066 atom
       * sites and 5,800 catalog rows — while the headset draws a map and no
       * atom of that structure. `view` above now carries the map's own model
       * and assembly, because the scene does; this carries the rest of its
       * identity. The residue page and the catalog stay the seed structure's:
       * the session genuinely opens beside those coordinates, every residue
       * query is answered from them, and they are what the contract's
       * `selectionKeys` are canonical against.
       */
      ...(data.attachment.density?{density:{sha256:data.attachment.density.sha256,
        bytes:data.attachment.density.bytes.byteLength,contour:data.attachment.density.contour,
        ...(data.attachment.density.triangles!==undefined?{triangles:data.attachment.density.triangles}:{})}}:{}),
      ...commandSummary,
      ...(detailedView?{detailedView:{...detailedView,
        ...(detailedView.selection&&detailedResidues?{selection:{...detailedView.selection,residues:detailedResidues.rows}}:{})}}:{}),
      tours:[...toursFor(data.attachment),...MOLECULAR_EXPERIENCES].map(t=>({id:t.id,title:t.title,scenes:t.steps.length})),
      // The named parts of the loaded lesson, and what
      // the panel is emphasising right now (which rides in `view` with the rest
      // of the saved inspection). Together they are the difference between an
      // agent that can say "he is looking at the guide RNA, faded to 12%" and
      // one that reports a plain structure because emphasis was a rendering
      // layer nothing described.
      lesson:data.attachment.customTour && commandSummary.panels.find(panel=>panel.current)?.tour?.active!==false
        ? {id:data.attachment.customTour.id,title:data.attachment.customTour.title,
          parts:lessonEmphasisParts(data.attachment.customTour)}
        : null,
      /**
       * What a hide request may name, so nobody has to guess.
       *
       * Chain letters repeat across the copies of an assembly, so the identity
       * a command carries is the label chain WITH its copy id. Those pairs are
       * already on every residue row, but a caller who only wants to hide a
       * chain should not have to page the residue table to find one. The list
       * is bounded: past the bound the residue page is the route, and a caller
       * that guessed instead is refused with the reason.
       *
       * `view.visibility` beside this is what is hidden right now, because it
       * rides in the saved scene with the rest of the inspection.
       *
       * `classes` is what THIS structure holds, not the four names a
       * request may spell. On one device session it listed all four for crambin, a model
       * with no water in it at all, and the model asked to hide the water on
       * that authority; the wearer was then told it had been hidden. Read this
       * and a class the file has none of is never named in the first place.
       */
      ...(scene&&!data.attachment.density?(()=>{const chains=availableChains(data.attachment.catalog.rows,scene.modelNumber);
        return {visibilityTargets:{classes:visibilityClassesOf(data.attachment),maxHiddenChains:MAX_HIDDEN_CHAINS,
          chainCount:chains.length,...(chains.length<=2*MAX_HIDDEN_CHAINS?{chains}:{})}};})():{}),
      ...(includeExperienceCatalog?{experienceCatalog:await journeyCatalogFor(data)}:{}),
      voice:{pendingIntents:voice.intents.size({sessionId,sourceToken:data.attachment.sourceToken}),pendingPlayback:voice.playbacks.size({sessionId,sourceToken:data.attachment.sourceToken}),lastPlaybackAcknowledgement:voice.playbacks.lastAcknowledgement({sessionId,sourceToken:data.attachment.sourceToken})},
      ...(residues ? {residues:inspectionResiduePage(data.attachment.catalog,scene,residues)} : {})});
  });
  registerAppTool(server,'stereo_structure.control_tour',{
    title:'Control a tour in the intended desktop or headset panel',
    description:'Start an installed lesson or experience, or use next, back, play, pause, done or menu on one current ready panel. Read get_inspection_state for the available tour IDs; the binding fields and commandId are optional. start requires tourId; add autoplay:false to hold the first rendered chapter for spoken guidance. Omitted autoplay starts timed playback. Add narration:false on start to disable scripted chapter speech for this lesson while host live voice provides guidance; ordinary replies stay available. Both options apply only to start. Done restores the pre-tour view. An experience may load its declared source and assembly; its command becomes rendered only after the panel saves and acknowledges that step. Ordinary lesson commands keep source-scoped scene receipts. Pass waitForRenderMs to get the receipt in this call; queued is not rendered. The wearer starts headset view in Quest Browser or Safari on Apple Vision Pro.',
    inputSchema:implicitBinding(inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:updateInspectionSchema.shape.commandId,utteranceId:updateInspectionSchema.shape.utteranceId,actionPostedAt:updateInspectionSchema.shape.actionPostedAt,...tourActionSchema.shape,waitForRenderMs:commandWaitSchema})),
    annotations:mutation,_meta:{},
  },async input=>{
    const {action,tourId,autoplay,narration,...request}=input;
    const patch=tourActionSchema.parse({action,...(tourId?{tourId}:{}),...(autoplay!==undefined?{autoplay}:{}),...(narration!==undefined?{narration}:{})});
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    if(action==='start' && !toursFor(data.attachment).some(tour=>tour.id===tourId) && !experienceById(tourId!)) throw Error('This tour is not available in the current inspection.');
    // Read the panel's tour before the command changes it, so
    // the sentence can say what this press does rather than that it is queued.
    const tour=data.attachment.commands.tourStateOf(input.panelId);
    const selected=action==='start' && tourId?experienceById(tourId):undefined;
    const commandRequest={...request,change:{kind:'tour' as const,patch}};
    const retry=data.attachment.commands.retryUpdate(commandRequest,b);
    if(selected && !retry) {
      // Validate target authority before spending time resolving other sources.
      const summary=data.attachment.commands.summary(b),panel=summary.panels.find(panel=>panel.panelId===input.panelId);
      if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken || input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==b.inspectionRevision)
        throw Error('Read get_inspection_state and use its current saved revisions before changing the inspection.');
      if(!panel?.current || panel.availability==='unsaved' || summary.pendingCommand.length)
        throw Error('The requested experience panel is unavailable, dirty, stale, or rendering another command.');
      await prepareJourney(selected,data);
      const latest=await current(input.sessionId);
      if(latest.cache!==data.cache || latest.stateRevision!==data.stateRevision || latest.attachment.revision!==b.inspectionRevision)
        throw Error('A newer inspection superseded this journey request.');
    }
    const command=retry??data.attachment.commands.enqueue(commandRequest,b,data.attachment.scene,'control_tour');
    noteConversationAction(input.utteranceId);
    return result(input.sessionId,data,{command,tourBefore:tour??null,...(selected?{journeyBudget:journeyChapters(selected)}:{})},
      [tourCommandSentence(action,tour),selected?chapterBudgetNotice(journeyChapters(selected)):''].filter(Boolean).join(' '));
  });
  registerAppTool(server,'stereo_structure.update_inspection',{
    title:'Change the open molecular inspection',
    description:'Change how the open structure looks: color, style, opacity, visibility, selection, placement, spin and detail. One request is one call: {sessionId, change, waitForRenderMs:10000}. serverEpoch, sourceToken, baseStateRevision, baseInspectionRevision, panelId and commandId are optional; left out, the host uses the current revisions, the headset panel when one is attached (else this Mac\'s panel) and a new commandId. Send them to have edits on a stale view refused. Name parts with residues, never keys: {labelChain:"A"}, {authorChain:"A"}, {componentId:"HEM"}, {classes:["ligand"]} (ligand, water, ion, polymer), authorResidueRange:[10,40] or labelSequenceRange, combined as needed. Color or restyle a region: {kind:"appearance",residues:{labelChain:"A"},patch:{color:"uniform",uniformColor:"#ff8800"}}; a region patch takes representation (cartoon, ball-and-stick, molecular-surface, spacefill, or sticks, surface, spheres), color, uniformColor, opacity 0-1 or clear:true. Without residues the patch styles the whole scene and also takes background, highlightColor, labels, clipping and fog. Select: {kind:"selection",patch:{residues:{componentId:"HEM"}}}; selectionKeys:[] clears. Hide: {kind:"visibility",patch:{op:"hide",chains:["B"],classes:["water"]}}; op is hide, show, only or reset. Other kinds: placement {translation,rotation,scale}, or {recenter:true} if the wearer can\'t see it, motion {state:"spin"|"stop"}, render-quality {level:"fast"|"balanced"|"best"}. Edits asked for together go in one {kind:"compound",patch:{ops:[2-7 edits]}}: one render and one undo. Only region styles may repeat ("chain A orange, chain B blue"). Only command.status "rendered" means drawn and saved; if the wait ends first, read get_inspection_state with the commandId. "saved" means kept for a paused headset page, not drawn yet. wearer.linked=false: the render was this Mac\'s panel. For a voice request echo its utteranceId and pass the listen_voice referent unchanged, without residues. This never moves the viewpoint; focus_selection frames a region.',
    inputSchema:implicitBinding(updateInspectionSchema),annotations:mutation,_meta:{},
  },async input=>{
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    if(input.change.kind==='utterance') {
      const a=data.attachment,continuation=a.sourceContinuation;
      const handoff=continuation && continuation.panelId===a.transitionTarget?.panelId
        && transitionNow()<a.transitionTarget.expiresAt && continuation.previous.serverEpoch===b.serverEpoch
        && continuation.stateRevision===b.stateRevision && b.inspectionRevision<=1
        && (!a.scene || (a.scene.modelNumber===continuation.modelNumber && a.scene.assemblyId===continuation.assemblyId))
        ?continuation:undefined;
      const lifecycle=a.commands.controlUtterance(input as any,b,handoff?{
        panelId:handoff.panelId,previous:handoff.previous,controlled:(action,utteranceId)=>{
          if(action==='correct') handoff.utteranceId=utteranceId;
          else delete a.sourceContinuation;
        },
      }:undefined);
      noteConversationAction(input.utteranceId);
      return result(input.sessionId,data,{lifecycle},'Utterance '+input.change.patch.action+' recorded. Earlier pending commands are listed in lifecycle.commands; this does not undo a completed change or confirm a render.');
    }
    // A named region resolves to canonical keys against the saved model before
    // any rule below reads the change: a lone selection here, styles and
    // compound ops where they are built.
    if(namesRegion(input.change)) {
      if(!data.attachment.scene) throw Error('Load and save the intended inspection before naming residues.');
      if(input.referent) throw Error('Name a region with residues, or pass the captured referent, not both.');
      if(input.change.kind==='selection' && input.change.patch.residues)
        input={...input,change:{kind:'selection',patch:{selectionKeys:regionKeys(data.attachment,input.change.patch.residues)}}};
    }
    const {referent:echoed,referentScope,...request}=input;
    // The captured keys come back before anything is validated, so
    // every referent rule below sees the whole capture rather than the sample
    // the model was handed. `requestIdentity` keeps the echoed form, which is
    // what an exact retry sends again.
    const referent=referentKeys.expand(echoed,data.attachment.sourceToken);
    validateRequestReferent(referent,data.attachment.sourceToken,data.attachment.scene,data.attachment.catalog,data.attachment.density);
    const retry=data.attachment.commands.retryUpdate(input,b);
    if(retry) return result(input.sessionId,data,{command:retry},
      `Inspection command ${retry.status}. Check get_inspection_state with this commandId for its rendered receipt.`);
    const change:any=input.change;
    const visibilitySelection=(change.kind==='compound'?change.patch.ops:[change])
      .some((op:any)=>op.kind==='visibility' && op.patch.selection===true);
    if(change.kind==='tour' && change.patch.action==='start' && !toursFor(data.attachment).some(tour=>tour.id===change.patch.tourId) && !experienceById(change.patch.tourId!)) throw Error('This tour is not available in the current inspection.');
    // The headset's Reset needs a wearer in VR. The Mac panel
    // has nobody to put the structure in front of, and a headset page on its
    // flat view has no room to seat it in, so both are refused before anything
    // is queued, with the step that would make it work. A stale page has no
    // current frame to place the structure against.
    if(isRecenterChange(change)) {
      await hostBuildReady;
      const target=data.attachment.commands.summary(b).panels.find(panel=>panel.panelId===input.panelId);
      if(target?.surface!=='companion') throw Error(RECENTER_NEEDS_HEADSET);
      if(expectedHostBuild() && data.attachment.commands.pageBuildOf(input.panelId)!==expectedHostBuild())
        throw Error(`Not sent: ${outdatedPageNote(data.attachment.commands.pageBuildOf(input.panelId))}`);
      if(target.xrStartup && !target.xrStartup.stale && target.xrStartup.presenting===false) throw Error(RECENTER_NEEDS_VR);
      if(!target.xrStartup || target.xrStartup.stale || target.xrStartup.presenting!==true
        || target.xrStartup.sessionVisibility!=='visible' || target.xrStartup.visible===false
        || data.attachment.commands.wearerPage(b).state!=='in-vr') throw Error(RECENTER_WAIT_FOR_VR);
    }
    // Which classes this request names that the structure has none
    // of, read before anything resolves so the refusal can name the file the
    // wearer is looking at. Nothing absent means nothing to read.
    const absentClasses=absentVisibilityClassesIn(data.attachment,change);
    const absentStructure=absentClasses.length||namesVisibilityIntersection(change)?await structureNameFor(data):undefined;
    // The caller's compound becomes the panel's compound here,
    // with the lesson colour key expanded and every op checked as one picture.
    if(change.kind==='compound') {
      if(!data.attachment.scene) throw Error('Load and save the intended inspection before changing several things at once.');
      request.change=resolveCompound(data.attachment,change,referent,referentScope,absentStructure) as any;
      validateScene(expectedInspection(data.attachment.scene,request.change as any),data.attachment.catalog,data.attachment.density);
    }
    if(change.kind==='appearance') {
      if(!data.attachment.scene) throw Error('Load and save the intended inspection before changing appearance.');
      request.change=resolveScopedAppearance(change,data.attachment.scene,referent,referentScope,
        change.residues?regionKeys(data.attachment,change.residues):undefined) as any;
      validateScene(expectedInspection(data.attachment.scene,request.change as InspectionChange),data.attachment.catalog,data.attachment.density);
    }
    if(input.change.kind==='selection') {
      if(!data.attachment.scene) throw Error('Load and save the intended inspection before selecting residues.');
      validateScene(expectedInspection(data.attachment.scene,input.change as InspectionChange),data.attachment.catalog,data.attachment.density);
    }
    // The caller's hide/show/only/reset becomes the panel's
    // whole hidden set here, resolved against the chains this model has, and
    // the resulting scene is validated before anything is queued.
    let visibilityBefore:InspectionVisibility|undefined, visibilityAfter:InspectionVisibility|undefined;
    if(change.kind==='visibility') {
      visibilityBefore=data.attachment.scene?.inspection.visibility;
      visibilityAfter=visibilityPatchFor(data.attachment,change.patch,absentStructure);
      request.change={kind:'visibility',patch:visibilityAfter} as any;
      validateScene(expectedInspection(data.attachment.scene!,request.change as any),data.attachment.catalog,data.attachment.density);
    }
    if(referent && visibilitySelection && (request.change.kind==='compound' || request.change.kind==='visibility')) {
      request.change=bindVisibilitySelection(request.change as Extract<InspectionChange,{kind:'compound'|'visibility'}>,referent) as any;
      validateScene(expectedInspection(data.attachment.scene!,request.change as any),data.attachment.catalog,data.attachment.density);
    }
    if(change.kind==='companion-structure') validateScene(expectedInspection(data.attachment.scene!,request.change as any),data.attachment.catalog,data.attachment.density);
    const queued={...request,requestIdentity:input,referent,appliedTo:referentAppliedTo(request.change as InspectionChange,referent,
      data.attachment.scene!,data.attachment.catalog,referentScope,visibilitySelection)} as any;
    // A paused headset page gets the edit saved, not queued,
    // against the binding as it is now: naming the structure above can wait.
    const kept=keepLive(input.sessionId,data,queued,'update_inspection');
    const command=kept?.command ?? data.attachment.commands.enqueue(queued,b,data.attachment.scene);
    // Only a queued command counts as the agent acting on the wearer's scene:
    // a rejected one is no agent at the wheel.
    noteConversationAction(input.utteranceId);
    const resolvedOps=(request.change as any).kind==='compound'?(request.change as any).patch.ops:undefined;
    // The sentence the model repeats to the wearer, built from
    // the same describer the page uses, so "Hidden chain B (copy 1)" is one
    // wording rather than two that drift.
    const chains=visibilityAfter?visibilityChainsOf(data.attachment):undefined;
    // A request naming some classes this structure has and some it
    // does not is answered on both halves in the one reply. What was hidden is
    // what `describeVisibility` says; what was never there is said beside it, so
    // the wearer is never told a class was hidden that the file has none of.
    const absentNote=absentClasses.length?` ${absentClassNote(absentClasses,absentStructure)}`:'';
    const response=result(input.sessionId,data,{command,
      ...(visibilityAfter?{visibility:{...(visibilityIsEmpty(visibilityAfter)?{}:{hidden:visibilityAfter}),
        ...(absentClasses.length?{absent:absentClasses}:{}),
        was:describeVisibility(visibilityBefore,chains),now:describeVisibility(visibilityAfter,chains)}}:{}),
      ...((request.change as any).kind==='styles'?{style:{confirmation:scopedStyleConfirmation((request.change as any).patch)}}:{}),
      ...(resolvedOps?{compound:{ops:resolvedOps.map((op:any)=>op.kind),confirmation:compoundConfirmation(resolvedOps),
        ...(absentClasses.length?{absent:absentClasses}:{})}}:{})});
    response.content[0].text=kept
      ? wearerKeptSentence(kept.pause)+absentNote
      : resolvedOps
      ? `Inspection command ${command.status} as one change over ${resolvedOps.length} edits. `
        + `One render and one undo entry. If the change renders on a connected headset, its confirmation is ${compoundConfirmation(resolvedOps)}${absentNote} `
        + 'Check get_inspection_state with this commandId for its rendered receipt.'
      : visibilityAfter
      ? `Visibility command ${command.status}. ${describeVisibility(visibilityAfter,chains)}${absentNote} `
        + 'Say that only once the receipt says rendered: check get_inspection_state with this commandId.'
      : `Inspection command ${command.status}. Check get_inspection_state with this commandId for its rendered receipt.`;
    return response;
  });
  registerAppTool(server,'stereo_structure.focus_selection',{
    title:'Bring one region into view in the intended panel',
    description:'Select a region and bring it into view in one call: what to use for "zoom to the PAM", "show me the hemes" or "highlight residue 840". One request is one call: {sessionId, residues:{componentId:"HEM"}, waitForRenderMs:10000}. The binding fields and commandId are optional; left out, the host uses the current revisions and the headset panel when one is attached. Name the region with residues (labelChain, authorChain, componentId, classes, authorResidueRange, labelSequenceRange), with selectionKeys you already hold, or with neither to frame what is selected now. framing="context" (default) keeps the surroundings in frame; "fill" holds the region close. This is not camera control and returns no coordinates: a headset panel moves the molecule\'s saved placement so the region sits in front of the wearer, never the wearer\'s head, and a desktop panel uses the viewer\'s own focus. The selection becomes exactly the region; appearance and tours are untouched. The modelled residues are framed; command.focus reports how many requested residues lack coordinates. A region with no modelled residues is refused. For a voice request pass the captured referent unchanged: an explicit region must match it, and with no region it wins over the live selection. Only command.status "rendered" means drawn; if the wait ends first, read get_inspection_state with the commandId.',
    inputSchema:implicitBinding(focusSelectionSchema,focusSelectionRequestSchema),annotations:mutation,_meta:{},
  },async input=>{
    const data=await current(input.sessionId), b=binding(input.sessionId,data), scene=data.attachment.scene;
    if(!scene) throw Error('Load and save the intended inspection before bringing a region into view.');
    // The keys held back from the model come home before validation.
    const referent=referentKeys.expand(input.referent,data.attachment.sourceToken);
    validateRequestReferent(referent,data.attachment.sourceToken,scene,data.attachment.catalog,data.attachment.density);
    // Naming no region means "the one they were looking at". A
    // request that carries a referent gets the selection as it was when the
    // request began, so a slow answer never frames a newer selection.
    const selectionKeys=input.selectionKeys ?? (input.residues
      ? inspectionResidueKeys(data.attachment.catalog,scene,input.residues)
      : referent?.residueKey?[referent.residueKey]:[...referentSelection(referent,data.attachment.sourceToken,scene.selectionKeys)]);
    if(selectionKeys.length===0) throw Error(input.residues
      ? input.utteranceId?missingVoiceRegion(data.attachment.catalog,scene.modelNumber,input.residues,data.cache.pdbId??await inspectionSourcePdbId(data.cache.structureText))
        : 'No residue in the saved model matches that region. Read get_inspection_state with residues to see what this model has.'
      : 'Nothing is selected, so there is no region to bring into view. Name residues or selectionKeys.');
    const change={kind:'focus' as const,patch:{selectionKeys,framing:input.framing}};
    validateScene(expectedInspection(scene,change),data.attachment.catalog,data.attachment.density);
    const {selectionKeys:_keys,residues:_residues,framing:_framing,referent:_referent,...request}=input;
    (input as any)[editAdmissionSignal]?.throwIfAborted();
    const {modelledKeys,missingCoordinateCount}=focusResidues(data.attachment.catalog.rows,selectionKeys);
    const focus={residueCount:selectionKeys.length,modelledResidueCount:modelledKeys.length,missingCoordinateCount};
    const command=data.attachment.commands.enqueue({...request,change,referent,focus,
      appliedTo:referentAppliedTo(change,referent,scene,data.attachment.catalog)},b,scene,'focus_selection');
    noteConversationAction(input.utteranceId);
    const response=result(input.sessionId,data,{command,focus:{framing:input.framing,residueCount:selectionKeys.length}});
    response.content[0].text=`Focus command ${command.status} over ${selectionKeys.length} residue${selectionKeys.length===1?'':'s'}, framed for ${input.framing}. `
      +(missingCoordinateCount?`${missingCoordinateCount} requested residue${missingCoordinateCount===1?' has':'s have'} no coordinates; framing uses the ${modelledKeys.length} modelled residues. `:'')
      +'Check get_inspection_state with this commandId for its rendered receipt.';
    return response;
  });
  registerAppTool(server,'stereo_structure.emphasize',{
    title:'Light named parts of the loaded lesson',
    description:'Light one or more named parts of the loaded lesson and fade everything else, which is what to use for “show him the guide RNA again”, “point out the PAM” or “put the colour key back”. Name parts exactly as the lesson names them: read get_inspection_state and use lesson.parts, whose ids and labels both resolve here. The panel paints the lesson’s whole colour key and holds the named parts at full strength while every other part, and anything the key does not name, drops to context opacity — faint but still drawn, so the part keeps its place inside the complex. Pass parts as an empty list to clear the emphasis and leave the plain structure. context sets how faint the rest goes, 0 to 1, default 0.12; there is no reason to change it unless the wearer says the context is too dark or too loud. Every supplied referent is validated against its source, model, assembly and canonical keys. Pronouns require its captured lesson part; arbitrary selection-only emphasis is unsupported and refuses. Receipt appliedTo names the resolved canonical focused keys (or scene:true when clearing) and capturedAt; only status=rendered confirms application. This moves nothing: the selection, the molecule’s placement and the viewpoint are all untouched, and the wearer hears the part’s own name. The binding fields and commandId are optional; left out, the host uses the current revisions and the headset panel when one is attached. Pass waitForRenderMs:10000 to get the receipt in this call: only status "rendered" means drawn, and view.emphasis in get_inspection_state says what the panel shows.',
    inputSchema:implicitBinding(emphasizeSchema),annotations:mutation,_meta:{},
  },async input=>{
    // Emphasis is the agent visibly repainting the wearer's molecule, so the
    // headset may keep saying "Sent to Claude" for free speech, exactly as a
    // spin or a quality change does.
    const data=await current(input.sessionId), b=binding(input.sessionId,data), scene=data.attachment.scene;
    if(!scene) throw Error('Load and save the intended inspection before emphasising a part.');
    // The keys held back from the model come home before validation.
    const referent=referentKeys.expand(input.referent,data.attachment.sourceToken);
    validateRequestReferent(referent,data.attachment.sourceToken,scene,data.attachment.catalog,data.attachment.density);
    // "this" and "that" resolve from the referent the request
    // started with, and every other name resolves as it always did.
    const {key,focus,patch}=emphasisPatchFor(data.attachment,input.parts,input.context,referent);
    const change={kind:'emphasis' as const,patch};
    validateScene(expectedInspection(scene,change),data.attachment.catalog,data.attachment.density);
    const {parts:_parts,context:_context,referent:_referent,...request}=input;
    const queued={...request,change,referent,appliedTo:referentAppliedTo(change,referent,scene,data.attachment.catalog)};
    // A paused headset page gets the edit saved, not queued.
    const kept=keepLive(input.sessionId,data,queued,'emphasize');
    const command=kept?.command ?? data.attachment.commands.enqueue(queued,b,scene,'emphasize');
    noteConversationAction(input.utteranceId);
    const named=focus.map(id=>key.find(part=>part.id===id)?.label??id);
    const response=result(input.sessionId,data,{command,emphasis:{focus,contextOpacity:patch.contextOpacity,parts:patch.parts.length}});
    if(kept) { response.content[0].text=wearerKeptSentence(kept.pause); return response; }
    response.content[0].text=(named.length
      ?`Emphasis command ${command.status}: ${named.join(' and ')} held at full strength, everything else faded to ${Math.round(patch.contextOpacity*100)}%. `
      :`Emphasis command ${command.status}: the colour key is cleared and the plain structure comes back. `)
      +'Check get_inspection_state with this commandId for its rendered receipt.';
    return response;
  });
  registerAppTool(server,'stereo_structure.undo_last_change',{
    title:'Take back the last change to this inspection',
    description:'Undo the most recent operation on this inspection, whoever made it: a change you sent, a change the wearer asked for in the headset, or an edit made by hand in a panel. The history belongs to the shared scene on this Mac rather than to one browser tab, so one call takes back the last thing that happened in the session and a second call takes back the one before it. It restores only what that operation moved: representation, colour, opacity and labels, the molecule’s placement, the residue selection, the lesson colour key, the styles on selected residues, and what was hidden — a chain or component class taken off the screen comes back exactly as it was, with its labels and its highlight. It never restores a viewpoint, because the view belongs to whoever is looking through it. A compound change comes back in one undo, not one per edit. One call: {sessionId, waitForRenderMs:10000}; the binding fields and commandId are optional and default to the current values. undone=false with nothing queued means there is nothing left to take back. Only command.status "rendered" means the undo was drawn, and the history entry is dropped only then, or at once when status "saved" keeps the undo for a paused headset page.',
    inputSchema:implicitBinding(inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),waitForRenderMs:commandWaitSchema})),
    annotations:mutation,_meta:{},
  },async input=>{
    const outcome=await queueUndo(input);
    if(!outcome.undone) return result(input.sessionId,outcome.data,{undone:false,commandId:input.commandId},
      'There is no operation left to take back in this inspection.');
    noteConversationAction(input.utteranceId);
    return result(input.sessionId,outcome.data,{undone:true,command:outcome.command,
      undid:{origin:outcome.entry.origin,surface:outcome.entry.surface,change:outcome.entry.label},
      restores:outcome.change.kind==='compound'?outcome.change.patch.ops.map(op=>op.kind):[outcome.change.kind]},
      outcome.kept
        ? `Undo saved: took back the last ${outcome.entry.label} change from the ${outcome.entry.surface} surface. ${wearerKeptSentence(outcome.kept.pause)}`
        : `Undo command ${outcome.command.status}: taking back the last ${outcome.entry.label} change from the ${outcome.entry.surface} surface. `
          +`If the change renders on a connected headset, its confirmation is ${UNDO_CONFIRMATION} Check get_inspection_state with this commandId for its rendered receipt.`);
  });
  registerAppTool(server,'stereo_structure.redo_last_change',{
    title:'Reapply the last undone change to this inspection',
    description:'Redo the most recently undone operation in the shared scene, whether it originated with an agent, desktop panel or headset. Restores only the scene fields that operation changed and preserves the viewpoint. A new scientific edit clears redo; camera-only saves preserve it. Inputs and rendered/saved receipt meanings match undo_last_change. redone=false means no operation is available. The redo entry is consumed only after a confirmed render or a save for a paused headset page.',
    inputSchema:implicitBinding(inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),waitForRenderMs:commandWaitSchema})),
    annotations:mutation,_meta:{},
  },async input=>{
    const outcome=await queueRedo(input);
    if(!outcome.redone) return result(input.sessionId,outcome.data,{redone:false,commandId:input.commandId},'Nothing to redo.');
    noteConversationAction(input.utteranceId);
    return result(input.sessionId,outcome.data,{redone:true,command:outcome.command,
      redid:{origin:outcome.entry.origin,surface:outcome.entry.surface,change:outcome.entry.label},
      restores:outcome.change.kind==='compound'?outcome.change.patch.ops.map(op=>op.kind):[outcome.change.kind]},
      outcome.kept
        ? `Redo saved: reapplied the last ${outcome.entry.label} change from the ${outcome.entry.surface} surface. ${wearerKeptSentence(outcome.kept.pause)}`
        : `Redo command ${outcome.command.status}: reapplying the last ${outcome.entry.label} change from the ${outcome.entry.surface} surface. Check get_inspection_state with this commandId for its rendered receipt.`);
  });
  // The paired headset uses the same validated handlers as the model tools.
  for(const name of ['undo_last_change','redo_last_change']) handlers.set(name,panelHandlers.get(name)!);
  const namedViewAction=z.discriminatedUnion('action',[
    inspectionStateSchema.extend({action:z.literal('list')}),
    inspectionBindingSchema.extend({action:z.literal('save'),panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),
      name:z.string().min(1).max(80),replaceViewId:z.string().uuid().optional()}),
    inspectionBindingSchema.extend({action:z.literal('restore'),panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),viewId:z.string().uuid()}),
    inspectionBindingSchema.extend({action:z.literal('delete'),viewId:z.string().uuid(),viewRevision:z.number().int().positive()}),
    inspectionBindingSchema.extend({action:z.literal('return-to-desktop'),panelId:z.string().uuid(),commandId:commandIdSchema,utteranceId:commandIdSchema.optional(),viewId:z.string().uuid()}),
  ]);
  // The MCP SDK publishes a union root as an empty object, which gave a model
  // no field names for this tool. So the tool publishes one flat object with
  // every field the actions use, as openInputSchema does in schemas.ts, while
  // the union alone validates. The root has no fields of its own and admits
  // any key, so every issue a caller gets back is the union's, as before, and
  // `list` keeps accepting the state-query fields it ignores. z.toJSONSchema
  // copies the root's metadata into its output, so tools/list shows
  // namedViewFields. The handler parses through the union again, so it gets
  // the same input it always did.
  const namedViewFields=z.object({action:z.enum(['list','save','restore','delete','return-to-desktop']),
    ...inspectionBindingSchema.partial().shape,sessionId:inspectionBindingSchema.shape.sessionId,
    panelId:z.string().uuid().optional(),commandId:commandIdSchema.optional(),utteranceId:commandIdSchema.optional(),
    name:z.string().min(1).max(80).optional(),replaceViewId:z.string().uuid().optional(),
    viewId:z.string().uuid().optional(),viewRevision:z.number().int().positive().optional()}).strict();
  const namedViewInput=z.object({}).loose().superRefine((value,context)=>{
    const parsed=namedViewAction.safeParse(value);
    if(!parsed.success) for(const issue of parsed.error.issues) context.addIssue({...issue});
  }).meta(z.toJSONSchema(namedViewFields,{target:'draft-7',io:'input'}));
  registerAppTool(server,'stereo_structure.manage_inspection_view',{
    title:'Save and restore named inspection views',
    description:'Manage up to sixteen named views in this live Stereofold session. list reads every entry with its name, semantic summary and source identity, including entries saved on another structure, model or assembly: label those by source and never restore one silently, because restore of a foreign entry is refused. save asks the explicitly named current ready panel to capture its settled scientific scene; it never copies whichever panel wrote last. restore sends one saved scientific scene to the explicitly named panel and confirms appearance, scoped styles, placement, selection and emphasis from its rendered receipt. delete requires the listed viewRevision. Duplicate names require replaceViewId. Views end with this live server session. A save can privately capture an object-relative angle; return-to-desktop requires that angle and targets the exact current ready desktop panel. Save and restore results are queued; check get_inspection_state with commandId before saying they completed. restore sends one saved scientific scene to the explicitly named panel and confirms appearance, placement, selection, emphasis and what was hidden from its rendered receipt — a view saved with a chain or a component class hidden comes back with exactly that hidden again.',
    inputSchema:namedViewInput,annotations:{...mutation,destructiveHint:true},_meta:{},
  },async raw=>{
    const input=namedViewAction.parse(raw);
    const data=await current(input.sessionId),a=data.attachment,b=binding(input.sessionId,data);
    const source=a.scene?{sourceSha256:a.scene.sourceSha256,modelNumber:a.scene.modelNumber,assemblyId:a.scene.assemblyId}:undefined;
    if(input.action==='list') return result(input.sessionId,data,{namedViews:namedViewsPayload(data)});
    if(input.serverEpoch!==b.serverEpoch||input.sourceToken!==b.sourceToken||input.baseStateRevision!==b.stateRevision
      ||input.baseInspectionRevision!==b.inspectionRevision) throw Error('The inspection changed. Read get_inspection_state and try again.');
    if(!a.scene) throw Error('Load and save the intended inspection before managing named views.');
    if(input.action==='delete') {
      if(a.commands.hasPending(b)) throw Error('A named-view render is in progress. Check its command receipt before deleting a view.');
      const deleted=a.views.delete({viewId:input.viewId,viewRevision:input.viewRevision,source:source!});
      return result(input.sessionId,data,{deleted,viewId:input.viewId,namedViews:namedViewsPayload(data)});
    }
    if(input.action==='save'&&!a.commands.hasCommand(input.commandId))
      a.views.assertCanSave({name:input.name,scene:a.scene,...(input.replaceViewId?{replaceViewId:input.replaceViewId}:{})});
    const change=input.action==='save'
      ? {kind:'save-view' as const,patch:{name:input.name,...(input.replaceViewId?{replaceViewId:input.replaceViewId}:{})}}
      : (()=>{const view=a.views.restore(input.viewId,source!);
          if(input.action==='return-to-desktop') {
            if(!view.namedViewIntent) throw Error('That named view has no object-relative viewing angle. Save it again from an active view first.');
            a.commands.assertDesktopTarget(input.panelId,b);
          }
          return {kind:'restore-view' as const,
          patch:{viewId:input.viewId,scene:view.supportedScene,...(view.namedViewIntent?{namedViewIntent:view.namedViewIntent}:{})}};})();
    const command=a.commands.enqueueView({...input,change},b,a.scene);
    return result(input.sessionId,data,{command,viewAction:input.action,...(input.action==='save'?{name:input.name}:{viewId:input.viewId})},
      `${input.action==='save'?'Save':'Restore'} named-view command ${command.status}. Check get_inspection_state with this commandId for its rendered receipt.`);
  });
  // privateTool, not registerAppTool: the headset's "Open in Mol*" row reaches
  // this tool over the companion /tool route, which dispatches only names in
  // the handlers map. Registered plainly it answered "Unsupported companion
  // action" to every press from VR, with no seamless switch to Mol*.
  // _meta:{} keeps it model-visible.
  privateTool('stereo_structure.open_detailed_view',{
    title:'Open this inspection in the full Mol* viewer',
    description:'Open the exact structure and saved scene now in the cinematic panel in the complete Mol* viewer, served from this Mac on loopback with the full control tree, measurement, component and export panels. It carries the coordinates, model, assembly, representation, color theme, opacity, background, camera, the residue selection and the label layer over it; it does not carry the placement transform, tour or immersive state, and it is a copy rather than a live link, so later panel changes do not follow it. First read get_inspection_state and copy its sessionId, serverEpoch, sourceToken, stateRevision as baseStateRevision and inspectionRevision as baseInspectionRevision. Returns a loopback address whose fragment is the page key: give the user the whole address, and where the host cannot open links the user pastes it into a browser on this Mac. Pass open:true to have this Mac open that address in its default browser itself, which is the way to show the viewer from a panel that cannot follow a link; the result then says whether the browser process started, and the address is still printed for a second look. Opening is macOS only and never fails the call. To bring work back, the user chooses Download State with the .molj format in that viewer and you call import_detailed_view. This is not Codex Molecular Structure Viewer and needs no other plugin.',
    inputSchema:inspectionBindingSchema.extend({open:z.boolean().optional()}),annotations:{...mutation,openWorldHint:true},_meta:{},
  },async input=>{
    const data=await current(input.sessionId),b=binding(input.sessionId,data);
    if(!data.attachment.scene || input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken
      || input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==b.inspectionRevision)
      throw Error('Load and save the intended panel, then read its current inspection state before opening the detailed view.');
    const handoff=await savedDetailedHandoff(data);
    const link=await companion.openDetailed(input.sessionId,b.sourceToken);
    /**
     * This call answered
     * with `http://127.0.0.1:<port>/detailed#<key>` while a headset was paired.
     * That address is the Mac's own loopback. Nothing in the headset can reach
     * it, so an agent handed it had nothing to give the wearer and the driver
     * had nothing to open — the whole reason the handoff had no way back from
     * the Mac at all.
     *
     * The address the headset can reach is the LAN share's own origin, which
     * proxies the same three detailed-view routes with no bearer in the URL:
     * the wearer's tab already holds the page key in its own storage from
     * `/viewer`, which is why this address carries no fragment and must not.
     *
     * Both are reported, each named for the screen it belongs to. `url` is the
     * one to act on, so it is the LAN address whenever a headset is paired, and
     * `open:true` still opens the loopback copy on this Mac, because that is
     * the only one a Mac browser reaches without a certificate prompt.
     */
    const share=lanOwner?.sessionId===input.sessionId?lan.status():undefined;
    const address=detailedViewAddress({loopbackUrl:link.url,...(share?{share}:{})});
    const headsetUrl=address.headsetUrl;
    // The listener starts asynchronously, so a source replaced meanwhile must
    // not be handed an address bound to the previous capability.
    if(binding(input.sessionId,data).sourceToken!==b.sourceToken)
      throw Error('The structure changed while opening the detailed view. Try again.');
    markShared(input.sessionId,data.attachment,true);
    // The opener runs only after the address exists and is bound to this
    // source, so a browser is never handed a link the call goes on to refuse.
    const attempt=input.open===true?await openOnThisMac(link.url):undefined;
    const response=result(input.sessionId,data,{detailedView:{...address,port:link.port,snapshotId:handoff.snapshotId,
      opened:attempt?.opened===true,...(attempt?{openReason:attempt.reason,...(attempt.reason==='failed'?{openDetail:attempt.detail,openCode:attempt.code}:{})}:{}),
      // The emphasis travels in the handoff and is drawn
      // there. The detailed page rebuilds each part of the key as one Mol*
      // component in the part's own colour, at the lesson's own focus opacity,
      // rather than as the panel's overpaint and transparency layers — that is
      // what the full viewer's control tree can then recolour, hide and focus.
      // A part whose chain or residue range is not in these coordinates is not
      // painted and is named in the page's own sentence instead, so
      // "emphasis-colours" is carried without promising every part of every key.
      carried:['coordinates','model','assembly','representation','color','opacity','background','camera','selection','labels','emphasis-colours'],
      notCarried:['placement','tour','immersive'],
      ...(data.attachment.scene.inspection.emphasis?.focus.length
        ? {emphasis:{focus:data.attachment.scene.inspection.emphasis.focus,repainted:true}}
        : {})}});
    const opening=attempt===undefined?'Open the whole address including the part after the # sign, which is this page key. '
      :attempt.reason==='started'?'Browser started for the detailed view on your Mac. The whole address, including the part after the # sign, opens it again. '
      :attempt.reason==='attempted'?'Launch attempted for the detailed view. If no browser appears, open the whole address yourself, including the part after the # sign. '
      :attempt.reason==='not-macos'?'Opening it for you works only on macOS, so open the whole address yourself, including the part after the # sign, which is this page key. '
      :`Could not open your Mac browser (${attempt.detail}); open the whole address yourself, including the part after the # sign, which is this page key. `;
    response.content[0].text=(headsetUrl
      ?`Full Mol* viewer for this inspection, on the address the headset can reach: ${headsetUrl}\n`
        +`The wearer's own way there is the Open in Mol* row in the spatial menu, which sends their tab to this same page; `
        +`their tab already holds the page key, so this address carries none. On this Mac the same viewer is ${link.url}. `
        +`To bring the wearer back, call recall_headset and follow detailedRecallReceipt to "returned". `
      :`Full Mol* viewer for this inspection: ${link.url}\n`)+`${opening}`
      +`Snapshot ${handoff.snapshotId}. The residue selection and its labels open highlighted there; placement and tour state stay in the panel. `
      +`To bring detailed work back, save Download State as .molj there and call import_detailed_view with its absolute path.`;
    return response;
  });
  registerAppTool(server,'stereo_structure.import_detailed_view',{
    title:'Bring a full Mol* viewer state back into the panel',
    description:'Read a Mol* state file the user saved with Download State in the full viewer and apply the part the cinematic panel can render: representation, color theme, uniform color, opacity, background and the camera pose. Supply the absolute path of a .molj or .json file; a .molx archive is refused because it is a zip, so ask for the .molj format instead. A panel renders one command at a time, so appearance comes back first and the framing on the next call: when the result says cameraPending, wait for the receipt and call this again with the same file and a new commandId, and repeat until the result says nothing was queued. Extra representations, components, measurements, volumes, extensions and the selection are read but not applied, and the result lists exactly what was dropped; the panel keeps its own selection, placement, labels and tour. First read get_inspection_state and copy sessionId, serverEpoch, sourceToken, stateRevision as baseStateRevision, inspectionRevision as baseInspectionRevision and an intended current ready panelId, then choose a new commandId. The result is queued, not rendered: check get_inspection_state with that commandId before reporting a visible change.',
    inputSchema:inspectionBindingSchema.extend({panelId:z.string().uuid(),commandId:commandIdSchema,filePath:z.string().min(1).max(4096)}).strict(),
    annotations:mutation,_meta:{},
  },async input=>{
    const data=await current(input.sessionId),b=binding(input.sessionId,data);
    if(!data.attachment.scene) throw Error('Load and save the intended inspection before importing a detailed view.');
    const projected=detailedViewImport(await readDetailedViewSnapshotFile(input.filePath),data.attachment.scene);
    const before=data.attachment.scene.inspection.appearance, after=projected.scene.inspection.appearance;
    const patch=Object.fromEntries(Object.entries(after).filter(([key,value])=>(before as any)[key]!==value));
    // A panel renders one command at a time, so appearance and framing cannot
    // ride together. Appearance goes first because it is the larger visible
    // change, and the camera follows on the next call, by which point the
    // appearance already matches. Both legs are idempotent: calling until the
    // result says nothing was queued lands the whole saved state.
    const framing=JSON.stringify(cameraPose(projected.scene.camera))!==JSON.stringify(cameraPose(data.attachment.scene.camera));
    const notApplied=[...projected.dropped];
    const dropped=notApplied.length?` Not applied: ${notApplied.join('; ')}.`:'';
    if(Object.keys(patch).length===0 && !framing) {
      const unchanged=result(input.sessionId,data,{detailedImport:{applied:[],dropped:notApplied,changed:false,cameraPending:false}});
      unchanged.content[0].text=`That saved Mol* state matches what the panel is already showing, so nothing was queued.${dropped}`;
      return unchanged;
    }
    const change=Object.keys(patch).length
      ?{kind:'appearance',patch}
      :{kind:'camera',patch:{camera:projected.scene.camera}};
    const applied=change.kind==='camera'?['camera']:Object.keys(patch);
    const cameraPending=framing && change.kind!=='camera';
    const command=data.attachment.commands.enqueue({...input,change} as any,b,data.attachment.scene,'import_detailed_view');
    const response=result(input.sessionId,data,{command,detailedImport:{applied,dropped:notApplied,changed:true,cameraPending}});
    response.content[0].text=`Inspection command ${command.status} from the saved Mol* state. Applied: ${applied.join(', ')}.${dropped}`
      +(cameraPending?' The detailed framing is still to come: once this renders, call import_detailed_view again with the same file and a new commandId to restore the camera.':'')
      +' Check get_inspection_state with this commandId for its rendered receipt.';
    return response;
  });
  /**
   * The one-press way back from the full Mol* viewer.
   *
   * `import_detailed_view` above is the file route and stays exactly as it is:
   * an agent with a saved `.molj` path uses it. This is what the detailed page
   * itself presses. It needs no path, no download and no revisions from the
   * caller, because the page cannot know them — it holds the same page key the
   * companion holds and nothing else, and the server derives the binding it is
   * already authorized for from that.
   *
   * Two destinations, decided here rather than by the page. A panel that is
   * attached and current gets a command, so a Mac panel visibly changes while
   * the viewer is still open. With no panel attached — the headset case, where
   * the wearer's own tab left for this viewer — the projection is saved
   * straight onto the session, and the page the wearer returns to loads it.
   *
   * One press, one leg. A panel renders one command at a time, so the result
   * says what is left and the page presses on with it; the wearer sees
   * "Applying 2 of 3" rather than a second errand.
   *
   * No leg is applied when it is queued, and a panel that
   * cannot take one right now is not a room with nobody in it.
   *
   * This used to answer `legs[0]` applied and `legs.slice(1)` remaining at the
   * moment of the enqueue, and hold only the final leg for its receipt. The
   * reasoning for the earlier legs was that the page presses again and the next
   * answer is derived from the scene the panel actually committed. That is only
   * true of a panel that has finished. A panel that is still DRAWING the leg it
   * was just handed reports `busy`, the search for a destination took ready
   * panels only, and so the next press found no target at all: it fell through
   * to the no-panel path, saved the whole projection on the session, and
   * answered `applied: [appearance, camera], remaining: []` before either had a
   * receipt. `applyReturn` exited on that, the page said "Sent camera back to
   * Stereofold" and clicked Back, and the wearer landed on the headset page
   * holding the old framing with the queued command now stale against a
   * revision that had moved under it.
   *
   * So every leg stays in `remaining` until its own `complete_inspection`
   * receipt says `rendered`, and a busy panel is a destination to wait for
   * rather than an absent one. That costs one more press per leg, in a loop
   * that already waits 1.2 s between presses and whose bound has the room for
   * it; a panel that never frees up ends at the same honest file fallback.
   */
  privateTool('stereo_structure.return_detailed_view',{
    title:'Return the full Mol* viewer state to the panel',
    description:'App-only. The detailed page posts its own pruned Mol* state and the residues selected there; the server projects what the panel can render, then either queues one change on the current panel or saves it when no panel is attached.',
    inputSchema:detailedViewReturnSchema.extend({sessionId:sessionIdSchema}).strict(),annotations:mutation,_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), a=data.attachment, b=binding(input.sessionId,data);
    if(!a.scene) throw Error('Save the inspection before returning a detailed view.');
    const {sessionId:_sessionId,...payload}=input;
    const projected=detailedViewReturn(payload,a.scene,a.catalog);
    const scene=validateScene(projected.scene,a.catalog,a.density);
    assertInspectionBudget({scene,comparisonSources:comparisonPayloads(a,scene)},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    const stayed=stayedInMolstar(projected.dropped);
    const appearance=Object.fromEntries(Object.entries(scene.inspection.appearance)
      .filter(([field,value])=>(a.scene!.inspection.appearance as any)[field]!==value));
    const selection=JSON.stringify(scene.selectionKeys)!==JSON.stringify(a.scene.selectionKeys);
    const framing=JSON.stringify(cameraPose(scene.camera))!==JSON.stringify(cameraPose(a.scene.camera));
    const legs=[...(Object.keys(appearance).length?['appearance']:[]),...(selection?['selection']:[]),...(framing?['camera']:[])];
    // Where this return belongs, and whether that place can take it right now.
    //
    // A current panel is the destination whether or not it can be written to
    // this instant, so only the absence of one — the headset case, where the
    // wearer's own tab is the page that left for the viewer — makes the
    // projection something to save straight onto the session. Reading "no READY
    // panel" as "no panel" is what let a busy panel be mistaken for an empty
    // room and the whole return be committed behind its back.
    //
    // `busy` is a panel between frames, not a panel that is gone: `enqueue`
    // holds a command for one and it is delivered on the first unblurred
    // heartbeat, so a busy panel is still a target. `unsaved`
    // is local scene work the server does not have, and writing over it would
    // take that work with it, so it can only be waited out.
    // The page pressing Return is a panel now, so it has
    // to be left out of its own destinations. Sending the full viewer's state
    // back to the full viewer would render it there, receipt it, and leave the
    // headset panel holding the view the wearer had just left.
    const attached=a.commands.summary(b).panels.filter(panel=>panel.current&&panel.surface!==DETAILED_SURFACE);
    // The desktop panel is preferred: in the headset case the wearer's own page
    // is the one that left.
    const pick=(list:typeof attached)=>list.find(panel=>panel.surface==='desktop')??list[0];
    const target=pick(attached.filter(panel=>panel.availability==='ready'))
      ??pick(attached.filter(panel=>panel.availability==='busy'));
    const answer=(applied:string[],remaining:string[],mode:'panel'|'saved',command?:unknown,note?:string)=>{
      const response=result(input.sessionId,data,{detailedReturn:{operation:visualEdit(legs,'return_detailed_view'),applied,remaining,stayed,mode,
        selectedResidues:scene.selectionKeys.length,...(command?{command}:{})}});
      response.content[0].text=(applied.length
        ?`Returned ${applied.join(', ')} from the full Mol* viewer${mode==='panel'?' to the panel':''}.`
        :remaining.length
          ?note??'The panel has the change and has not rendered it yet.'
          :'The full Mol* viewer state already matches the panel, so nothing changed.')
        +(remaining.length?` Still to come: ${remaining.join(', ')}; press Return again.`:'')
        +(stayed.length?` Stayed in Mol*: ${stayed.join(' ')}`:'');
      return response;
    };
    // The leg the previous press handed over, settled against its own receipt.
    // Still queued or rendering is still remaining — and the panel would refuse
    // a second command anyway. Rendered is the one moment it can be called
    // applied. Anything else (rejected, expired, conflicted, evicted) leaves the
    // scene untouched, so the leg is simply derived again below and re-sent.
    //
    // What is named as remaining is the whole derived list, not just the leg in
    // flight: the saved scene has not moved, so every leg this return still
    // owes is still in it, and the page's "Applying 2 of 3" counts them.
    const outstanding=a.detailedReturn;
    let settled:string[]=[];
    if(outstanding) {
      const status=(a.commands.summary(b,outstanding.commandId).command as {status?:string}|undefined)?.status;
      if(status==='queued' || status==='rendering')
        return answer([],legs.includes(outstanding.leg)?legs:[outstanding.leg,...legs],'panel');
      a.detailedReturn=undefined;
      if(status==='rendered') settled=[outstanding.leg];
    }
    if(!legs.length) return answer(settled,[],attached.length?'panel':'saved');
    if(!target) {
      // A panel with unsaved work is a destination that exists and cannot be
      // written to. Waiting is the only honest answer: saving over it would
      // discard the wearer's own work, and the page's bounded loop turns this
      // into the file fallback if the panel never frees up.
      if(attached.length) return answer(settled,legs,'panel',undefined,
        'The panel has unsaved local work of its own, so nothing was queued on it.');
      if(a.revision===Number.MAX_SAFE_INTEGER) throw Error('Inspection revision exhausted; open a new session.');
      a.scene=scene; a.revision++;
      return answer([...settled,...legs],[],'saved');
    }
    const change=Object.keys(appearance).length?{kind:'appearance' as const,patch:appearance}
      :selection?{kind:'selection' as const,patch:{selectionKeys:scene.selectionKeys}}
        :{kind:'camera' as const,patch:{camera:scene.camera}};
    const commandId=randomUUID();
    const command=a.commands.enqueue({sessionId:input.sessionId,serverEpoch:b.serverEpoch,sourceToken:b.sourceToken,
      baseStateRevision:b.stateRevision,baseInspectionRevision:b.inspectionRevision,panelId:target.panelId,
      commandId,change} as any,b,a.scene,'return_detailed_view');
    // EVERY leg is held for its own receipt, not only the last one. An earlier
    // leg used to be named applied at the moment of the enqueue, on the
    // reasoning that the page presses again either way and the next answer is
    // derived from the scene the panel committed. It is not, if the panel is
    // still drawing that leg when the next press arrives: the search for a
    // destination found nothing ready, the no-panel path saved the whole
    // projection on the session, and `remaining: []` told the page a return it
    // had not finished was done. One record per leg is what makes the busy
    // panel a wait rather than an empty room.
    a.detailedReturn={commandId,leg:legs[0]};
    return answer(settled,legs,'panel',command);
  });
  /**
   * The agent's rescue, and the page that answers it.
   *
   * The hand-off is the one place in the product where the wearer can put
   * themselves out of everybody's reach. Their tab leaves for the full Mol*
   * viewer, the companion panel detaches, and from that moment `say_to_headset`
   * has no page to deliver to, `update_inspection` has no panel, and
   * `choosePanel` can only answer "press Back to headset view" — advice for a
   * person who cannot find that control. Nothing on the Mac could move them.
   *
   * Two halves, one mailbox on `InspectionCommands`. `recall_headset` leaves a
   * sentence; the detailed page polls `poll_detailed_view` on the bearer it
   * already holds, shows it and navigates home, arming the same one-tap
   * re-entry hint its Back control arms. A wearer who is not in the viewer
   * costs nothing: the mailbox is dropped the moment a companion attaches.
   */
  registerAppTool(server,'stereo_structure.recall_headset',{
    title:'Bring the headset wearer back from the full Mol* viewer',
    description:'Send the headset tab back from the full Mol* viewer to the companion page it came from, with one short sentence shown as it leaves. Use it when get_inspection_state reports companionInDetailedView true and the wearer needs to be back — they asked to come back, they cannot find the control, or a queued command has nowhere to render. The page polls about every two seconds and navigates on the sentence, landing already paired on the same session and scene with a one-tap return to VR armed, so nothing is retyped and no code is re-entered. text is 1-160 characters and is read on the Mol* page, not spoken: that page is the stock Mol* viewer and has no audio route, so say anything the wearer must hear with say_to_headset once they are back. queued is always true; taken=false means the tab had not polled yet, not that it refused. The wearer can still be somewhere else entirely, so confirm with get_inspection_state that a companion panel has attached again before reporting them back.',
    inputSchema:z.object({sessionId:sessionIdSchema,
      text:z.string().trim().min(1).max(160).optional()}).strict(),annotations:mutation,_meta:{},
  },async input=>{
    const data=await current(input.sessionId), a=data.attachment;
    const text=input.text??'Coming back to the headset.';
    const {away,recallId}=a.commands.recallFromDetailedView(text);
    const response=result(input.sessionId,data,{detailedRecall:{queued:true,away,text,recallId,status:'queued'}});
    response.content[0].text=(away
      ?'The headset is in the full Mol* viewer; it will read this and come back within a couple of seconds: '
      :'No headset is reported to be in the full Mol* viewer right now, so this waits for one that is: ')
      +text+` Recall ${recallId}. Read get_inspection_state for detailedRecallReceipt: status "read" is the wearer's Mol* tab `
      +'having taken this sentence and left, and "returned" is their companion page attached again with one-tap re-entry to VR armed. '
      +'Only "returned" means they are back and reachable; "queued" after ten minutes becomes "expired" and nothing read it.';
    return response;
  });
  privateTool('stereo_structure.poll_detailed_view',{
    title:'Ask whether the Mac wants this Mol* tab back',
    description:'App-only. The detailed Mol* page polls this on the page key it already holds and navigates home on a recall.',
    inputSchema:z.object({sessionId:sessionIdSchema}).strict(),annotations:mutation,_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId);
    const recall=data.attachment.commands.takeDetailedViewRecall();
    return result(input.sessionId,data,{detailedRecall:recall?{recall:true,text:recall.text}:{recall:false}});
  });
  /**
   * What the wearer is pointing at in the full viewer.
   *
   * The gap this closes is the plainest one in the whole handoff. Somebody
   * stands inside a structure, clicks a residue in Mol*, and says "what is
   * this". Until now the host had no answer, because the only selection it
   * knew was the one saved in the panel the wearer had walked away from.
   *
   * The page sends the same residue descriptors the Return press sends, and
   * they are mapped by the same mapper, so a pick that comes home as a
   * selection and a pick that comes here as a question are one thing. Nothing
   * is committed: the saved scene does not move, no revision is spent, and an
   * agent that wants the pick made permanent sends an ordinary selection
   * command for it.
   */
  privateTool('stereo_structure.report_detailed_selection',{
    title:'Report what is selected in the full Mol* viewer',
    description:'App-only. The detailed page posts the residues the person has selected in Mol* whenever that selection changes; the server maps them onto its canonical residue keys and reports them on get_inspection_state as detailedView.selection. Nothing is saved and no revision is spent.',
    inputSchema:detailedSelectionSchema,annotations:{...mutation,idempotentHint:true},_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), a=data.attachment;
    if(a.commands.surfaceOf(input.panelId)!==DETAILED_SURFACE)
      throw Error('Only an attached full Mol* viewer page can report its selection.');
    if(!a.scene) throw Error('Save the inspection before reporting a detailed selection.');
    a.detailedSelection=detailedSelectionFrom(a.catalog,a.scene.modelNumber,input,(hooks.now??Date.now)());
    return result(input.sessionId,data,{detailedSelection:{selectedResidues:a.detailedSelection.keys.length,
      unmatched:a.detailedSelection.unmatched,truncated:a.detailedSelection.truncated}});
  });
  privateTool('stereo_structure.report_source_failure',{
    title:'Report a refused source load',description:'App-only terminal refusal from the selected source-replacement renderer. It never claims the new source was drawn.',
    inputSchema:inspectionBindingSchema.extend({panelId:z.string().uuid(),previousSourceToken:z.string().uuid(),
      failure:z.enum(INSPECTION_FAILURE_CODES),failureReason:z.string().min(1).max(MAX_INSPECTION_FAILURE_REASON_CHARS)}),
    annotations:mutation,_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId),b=binding(input.sessionId,data),a=data.attachment;
    const continuation=a.sourceContinuation;
    if(!continuation || input.panelId!==continuation.panelId || input.panelId!==a.transitionTarget?.panelId
      || input.previousSourceToken!==continuation.previous.sourceToken
      || input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken
      || input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==b.inspectionRevision
      || !a.sourceRenderWait || a.sourceRenderWait.settled()?.status==='rendered')
      throw Error('This refusal does not belong to the current source replacement.');
    const existing=a.sourceRenderWait.settled();
    // A retry can fail differently. The first terminal receipt stays immutable,
    // but an authenticated repeat from the same source owner remains acknowledged.
    if(!existing) a.sourceRenderWait.complete({status:'failed',panelId:input.panelId,sourceToken:b.sourceToken,
      inspectionRevision:b.inspectionRevision,failedAt:(hooks.now??Date.now)(),failure:input.failure,failureReason:input.failureReason});
    return result(input.sessionId,data,{},existing?.status==='failed'?existing.failureReason:input.failureReason);
  });
  privateTool('stereo_structure.attach_inspection',{
    title:'Attach an inspection panel',description:'App-only registration after rendering and saving. A mounted instance gets a new server-issued panel ID; its verified journey or source-replacement save can retain that ID through a source change. surface names the desktop, companion, or detailed page.',
    inputSchema:inspectionBindingSchema.extend({surface:z.enum(['desktop','companion',DETAILED_SURFACE]).optional(),replacesPanelId:z.string().uuid().optional(),pageBuild:z.string().length(64).optional(),
      journeySave:syncInspectionSchema.shape.journeySave,tourCommand:syncInspectionSchema.shape.tourCommand,
      geometryBudget:geometryBudgetReceiptSchema.optional()}),annotations:mutation,_meta:privateUi,
  },async input=>{
    await hostBuildReady;
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    if(!data.attachment.scene) throw Error('Save the initial rendered inspection before attaching.');
    const undo=data.attachment.experienceRollback;
    if(input.journeySave) {
      if(!undo || undo.token!==input.journeySave.rollbackToken || undo.panelId!==input.journeySave.panelId
        || input.replacesPanelId!==undo.panelId || undo.expectedStateRevision!==b.stateRevision
        || undo.expectedInspectionRevision!==b.inspectionRevision
        || (input.tourCommand ? input.tourCommand.panelId!==undo.panelId : data.attachment.commands.hasPending(b)))
        throw Error('This attachment does not belong to the current saved journey transition.');
      if(input.tourCommand)data.attachment.commands.assertTourTransition(input.tourCommand,b);
    }
    const continuation=data.attachment.sourceContinuation;
    const savedSource=continuation && data.attachment.commands.surfaceOf(continuation.panelId)!==undefined
      && input.replacesPanelId===continuation.panelId
      && input.replacesPanelId===data.attachment.transitionTarget?.panelId
      && b.serverEpoch===continuation.previous.serverEpoch && b.stateRevision===continuation.stateRevision
      && b.inspectionRevision===1 && data.attachment.scene.modelNumber===continuation.modelNumber
      && data.attachment.scene.assemblyId===continuation.assemblyId;
    // The source handoff is consumed once. A later mounting instance naming
    // that same old ID gets its own capability without retiring the retained
    // renderer or taking its utterance and rendered receipt.
    const consumedSource=data.attachment.sourceRenderWait?.settled()?.status==='rendered' && !input.journeySave && input.replacesPanelId!==undefined
      && input.replacesPanelId===data.attachment.sourceRenderWait?.settled()?.panelId;
    // A reconnect naming the still-current owner may resume an interrupted
    // chapter. Keep that verified panel and return its existing save claim;
    // an ordinary follower receives neither the identity nor the claim.
    const resumeJourney=!input.journeySave && !input.tourCommand && !consumedSource && undo
      && input.replacesPanelId===undo.panelId && undo.expectedStateRevision===b.stateRevision
      && undo.expectedInspectionRevision===b.inspectionRevision
      && data.attachment.commands.readyPanel(undo.panelId,b) && !data.attachment.commands.hasPending(b);
    const panelId=data.attachment.commands.attach(consumedSource?{...input,replacesPanelId:undefined}:input,b,
      Boolean(input.journeySave || savedSource || resumeJourney));
    // Correlate the attached ID with the selected transition owner only after
    // the rendered scene has saved and attach passed.
    if(!consumedSource && input.replacesPanelId && input.replacesPanelId===data.attachment.transitionTarget?.panelId) {
      const continuation=data.attachment.sourceContinuation;
      if(continuation && input.replacesPanelId===continuation.panelId && b.stateRevision===continuation.stateRevision
        && b.inspectionRevision===1 && data.attachment.scene.modelNumber===continuation.modelNumber
        && data.attachment.scene.assemblyId===continuation.assemblyId) {
        const advanced=data.attachment.commands.continueUtterance(continuation.utteranceId,continuation.panelId,continuation.previous,b,panelId);
        const followUtterancePanels=(utteranceId:string)=>{
          const remembered=utterancePanels.get(utteranceId);
          if(remembered) remembered.panelIds=remembered.panelIds.map(id=>id===continuation.panelId?panelId:id);
          const active=activeUtterances.get(continuation.panelId);
          if(active?.utteranceId===utteranceId) {activeUtterances.delete(continuation.panelId);activeUtterances.set(panelId,active);}
        };
        if(advanced && continuation.utteranceId) followUtterancePanels(continuation.utteranceId);
        // The wearer spoke again while this swap was
        // still loading. Those words were recorded against the source that is
        // now gone, and without this they can neither cancel, correct nor be
        // echoed. Their conversational binding follows the render; a bound
        // edit's referent keys are still checked against the new structure.
        for(const utteranceId of data.attachment.commands.continueSwapUtterances(continuation.panelId,continuation.previous,b,panelId,
          data.attachment.commands.utteranceSequenceOf(continuation.utteranceId)))
          followUtterancePanels(utteranceId);
      }
      delete data.attachment.sourceContinuation;
      // The same two facts a command receipt files at its render —
      // when the panel proved it, and the revision it proved it on.
      data.attachment.sourceRenderWait?.complete({status:'rendered',panelId,
        sourceToken:b.sourceToken,inspectionRevision:b.inspectionRevision,
        renderedAt:(hooks.now??Date.now)(),renderedRevision:b.inspectionRevision,
        ...(input.geometryBudget?{geometryBudget:input.geometryBudget}:{})});
    }
    // An ordinary first load has no transition target or wait. Capture only
    // a validated post-save attachment, never a failed/stale attach or a
    // replacement follower. Per-panel proof keeps a desktop tab from
    // overwriting the selected headset's advisory.
    if(!data.attachment.sourceRenderWait && !data.attachment.sourceContinuation && !data.attachment.transitionTarget
      && input.geometryBudget && input.surface!==DETAILED_SURFACE) {
      const receipts=data.attachment.initialSourceAdvisories??=new Map();
      receipts.set(panelId,{status:'rendered',panelId,sourceToken:b.sourceToken,inspectionRevision:b.inspectionRevision,
        renderedAt:(hooks.now??Date.now)(),renderedRevision:b.inspectionRevision,geometryBudget:input.geometryBudget});
    }
    const readiness=await panelReadiness(data,input.sessionId);
    const build=expectedHostBuild();
    const attached=result(input.sessionId,data,{panelId,...(input.surface==='companion' && build && input.pageBuild!==build?{outdatedHostBuild:build}:{}),...(readiness?{readiness}:{})});
    return resumeJourney?{...attached,_meta:{[PRIVATE_INSPECTION_META_KEY]:{journeySave:{panelId,rollbackToken:undo!.token}}}}:attached;
  });
  privateTool('stereo_structure.poll_inspection',{
    title:'Receive a targeted inspection command',description:'App-only panel heartbeat and one-time command claim. Dirty/busy panels do not execute; deliveries and claim tokens stay private.',
    inputSchema:pollInspectionSchema,annotations:mutation,_meta:privateUi,
  },async input=>{
    await hostBuildReady;
    const data=await current(input.sessionId);
    let b=binding(input.sessionId,data);
    const a=data.attachment;
    // Late beats cannot reactivate a journey, including after reconnection
    // retires its completion token. A pending Done still owns its restoration.
    const endedId=a.experienceCompletion?.status==='rendered' ? a.experienceCompletion.experienceId
      : !a.experience && a.experienceCompletion?.status!=='pending' ? a.reconciledExperienceId : undefined;
    if(endedId && (input.tourState?.selectedId===endedId || input.experience?.experienceId===endedId)) {
      input={...input,tourState:{step:-1,total:0,active:false,autoplay:false,navigating:false}};
      // The same lateness rule for the journey chapter this beat
      // carries. A page still reporting the lesson it just finished must not
      // keep it alive as the lesson a stop could be forgiven across.
      delete (input as {experience?:unknown}).experience;
    }
    const continuation=a.sourceContinuation, failed=a.sourceRenderWait?.settled();
    if(continuation && input.panelId===continuation.panelId) {
      // Only an idle, clean renderer with the original source capability can
      // offer recovery. Any busy/manual heartbeat revokes this narrow lease.
      const previous=continuation.previous;
      a.sourceFailureReadyAt=failed?.status==='failed' && input.sourceFailureToken===a.sourceToken
        && input.serverEpoch===previous.serverEpoch && input.sourceToken===previous.sourceToken
        && input.baseStateRevision===previous.stateRevision && input.baseInspectionRevision===previous.inspectionRevision
        && input.availability!=='busy' && a.commands.surfaceOf(input.panelId)!==undefined
          ? (hooks.now??Date.now)() : undefined;
      a.commands.holdSourceRecovery(input.panelId,a.sourceFailureReadyAt===undefined?undefined:a.sourceFailureReadyAt+10_000);
    }
    const {delivery,...state}=a.commands.poll(input,b) as any;
    reconcilePairedPanels(data,b);
    if(delivery) {
      const historyAction=a.history.isUndo(delivery.commandId)?'undo':a.history.isRedo(delivery.commandId)?'redo':undefined;
      if(historyAction) delivery.historyAction=historyAction;
    }
    // This beat may be the page saying it is hidden while an edit
    // is still queued for it. Keep that edit, and read the revision it made.
    if(!delivery) { keepQueuedForWearer(input.sessionId,data); b=binding(input.sessionId,data); }
    await showQueuedCommandConflicts(a.commands,b);
    const voicePlayback=voice.playbacks.next({sessionId:input.sessionId,sourceToken:b.sourceToken,panelId:input.panelId});
    // A reply from `say_to_headset` rides this same heartbeat, and it goes to
    // the wearer's own page: the companion, which draws it beside the talk
    // orb, or the full Mol* viewer, which draws it on its own caption line and
    // plays the clip that rides with it. That is what lets a question asked in
    // the full viewer be answered in the full viewer.
    //
    // A desktop panel is still offered nothing: it would take the reply and
    // draw none of it.
    const wearerSurface=a.commands.surfaceOf(input.panelId);
    const wearerPage=wearerSurface==='companion'||wearerSurface===DETAILED_SURFACE;
    const headsetCaptionRejections:HeadsetCaptionRejection[]=[];
    const headsetCaption=wearerPage?captions.claim(input.panelId,{
      activeUtteranceId:activeUtterances.get(input.panelId)?.utteranceId,
      sessionId:input.sessionId,sourceToken:b.sourceToken,refusalSerial:refusalSerials.get(input.sessionId),
      onStale:receipt=>headsetCaptionRejections.push(receipt),
      onScopeMiss:noteRefusalScopeMiss,
    }):undefined;
    const growthCaption=wearerSurface==='companion'?growthCaptions.claim(input.panelId):undefined;
    // The headset's log rides the return leg of its own heartbeat. The page
    // keeps sending an entry until the sequence it is acknowledged at moves
    // past it, so a dropped beat costs a repeat rather than the entry.
    const diagnosticsAck=input.diagnostics?diagnostics.ingest(input.panelId,salvageDiagnosticEntries(input.diagnostics.entries)).ack:undefined;
    // `capture_headset_view` arms a request here. Only a companion page draws
    // an immersive frame, so only a companion panel is offered one.
    const headsetViewRequest=wearerSurface==='companion' && input.serverEpoch===b.serverEpoch && input.sourceToken===b.sourceToken
      ?headsetView.claim(input.panelId,{sessionId:input.sessionId,sourceToken:b.sourceToken,serverEpoch:b.serverEpoch}):undefined;
    const returningDesktop=a.followStoppedShare && wearerSurface==='desktop' && state.attached===true && input.availability==='ready';
    const canFollow=(a.shared || returningDesktop) && input.serverEpoch===b.serverEpoch && input.sourceToken===b.sourceToken
      && input.baseStateRevision===b.stateRevision && input.baseInspectionRevision<b.inspectionRevision;
    const readiness=await panelReadiness(data,input.sessionId);
    const build=expectedHostBuild();
    const transitionTarget=transitionTargetFor(a,input.panelId,b),undo=a.experienceRollback;
    const journeySave=transitionTarget && state.attached===true && undo && undo.panelId===input.panelId
      && undo.expectedStateRevision===b.stateRevision && undo.expectedInspectionRevision===b.inspectionRevision
      && !a.commands.hasPending(b)?{panelId:input.panelId,rollbackToken:undo.token}:undefined;
    return {...result(input.sessionId,data,{...state,outcome:a.commands.latestOutcome(b,input.panelId),
      ...(wearerSurface==='companion' && build && input.pageBuild!==build?{outdatedHostBuild:build}:{}),...(readiness?{readiness}:{})}),
      _meta:{[PRIVATE_INSPECTION_META_KEY]:{delivery,comparisonSources:comparisonPayloads(a,delivery,canFollow?a.scene:undefined),transitionTarget,
        ...(journeySave?{journeySave}:{}),
        // The one field that tells a wearer anyone is
        // there. It is always present, so a page can tell "no agent" from an
        // older host that does not report at all.
        agentAttached:agentAttached(),
        ...(canFollow?{scene:a.scene}:{}),
        ...(voicePlayback ? {voicePlayback}:{}),
        ...(headsetCaption ? {headsetCaption}:{}),
        ...(headsetCaptionRejections.length ? {headsetCaptionRejections}:{}),
        ...(growthCaption ? {growthCaption}:{}),
        ...(diagnosticsAck!==undefined ? {diagnosticsAck}:{}),
        ...(headsetViewRequest ? {headsetViewRequest}:{}),
      }}};
  });
  async function validateVoiceBinding(input:any) {
    const data=await current(input.sessionId), now=binding(input.sessionId,data);
    if(input.serverEpoch!==now.serverEpoch || input.sourceToken!==now.sourceToken || input.baseStateRevision!==now.stateRevision
      || input.baseInspectionRevision!==now.inspectionRevision || !data.attachment.commands.readyPanel(input.panelId,now))
      throw Error('The voice request belongs to a changed or unavailable view. Try again when the scene is ready.');
  }
  async function validateCompanionVoiceBinding(input:any) {
    await validateVoiceBinding(input);
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    const panel=data.attachment.commands.summary(b).panels.find(panel=>panel.panelId===input.panelId);
    // The wearer has two pages, the companion and the
    // full Mol* viewer, and speaks from whichever they are on. A desktop panel
    // is still refused: its microphone is not in the headset.
    if(!isWearerSurface(panel?.surface)) throw Error('Voice capture and headset replies require a current headset page.');
  }
  /**
   * What a spoken line actually needs.
   *
   * `validateVoiceBinding` is the gate for voice capture, which does change the
   * scene: it demands the exact current revisions, a `ready` panel and no
   * command in flight. Narration changes nothing that is saved, and the page
   * asks for it precisely when those three are false — a tour step has just
   * bumped the saved revision, or the remote command being confirmed is still
   * `rendering`. That refused every page-originated line as a 409
   * and the wearer heard nothing for the whole tour. Identity still holds: the
   * epoch and source token must be current, and the target must be the
   * companion surface, so a line about a replaced structure is still refused.
   */
  async function validateNarrationVoiceBinding(input:any) {
    const data=await current(input.sessionId), now=binding(input.sessionId,data);
    if(input.serverEpoch!==now.serverEpoch || input.sourceToken!==now.sourceToken)
      throw Error('The spoken line belongs to a replaced source. Read get_inspection_state.');
    const panel=data.attachment.commands.summary(now).panels.find(panel=>panel.panelId===input.panelId);
    if(!isWearerSurface(panel?.surface)) throw Error('Headset speech requires a current headset page.');
  }
  voice=registerInspectionVoiceTools(privateTool,{validate:validateVoiceBinding,validateCompanion:validateCompanionVoiceBinding,
    validateNarration:validateNarrationVoiceBinding,now:hooks.now,privateMeta:privateUi,
    /**
     * "undo that", executed here rather than in the page.
     *
     * The history it reads belongs to the shared scene, so this phrase takes
     * back the last operation whether the wearer made it, a desktop panel made
     * it, or an agent tool did. The restoring command is queued against the
     * wearer's own panel and rendered on its next heartbeat, exactly like any
     * other command; all the page does is say the line.
     */
    undo:async request=>{
      const commandId=`undo-${randomUUID()}`;
      const outcome=await queueUndo({...request,commandId});
      return {message:outcome.message};
    },
    /**
     * A free-spoken request leaves for the desktop agent with
     * what the wearer meant by "this" already on it. This runs before the
     * seconds of transcription, so it names where they were when they spoke.
     */
    captureReferent:async request=>{
      const data=await current(request.sessionId);
      if(data.attachment.sourceToken!==request.sourceToken) return undefined;
      return referentKeys.compact(referents.capture(request.sessionId,captureRequestReferent({
        sourceToken:data.attachment.sourceToken,scene:data.attachment.scene,at:(hooks.now??Date.now)()})));
    },
    ...hooks.voice});
  type DesktopVoiceClaimReceipt=VoiceIntentAcknowledgement & {sessionId:string;sourceToken:string;createdAt:number};
  const voiceDesktopClaims=new Map<string,DesktopVoiceClaimReceipt>();
  const voiceNow=hooks.now ?? Date.now;
  const VOICE_CLAIM_TTL_MS=60_000;
  const pruneVoiceDesktopClaims=()=>{
    const cutoff=voiceNow()-VOICE_CLAIM_TTL_MS;
    for(const [id,value] of voiceDesktopClaims) if(value.createdAt<=cutoff) voiceDesktopClaims.delete(id);
    while(voiceDesktopClaims.size>16) voiceDesktopClaims.delete(voiceDesktopClaims.keys().next().value!);
  };
  privateTool('stereo_structure.claim_voice_intent',{
    title:'Receive a spoken request for the desktop agent',description:'App-only current desktop host claim for a user-spoken request outside the fast command set. A claim is attempted once; do not automatically resend after ambiguous host delivery.',
    inputSchema:inspectionBindingSchema.extend({panelId:z.string().uuid()}),annotations:mutation,_meta:privateUi,
  },async input=>{
    await validateVoiceBinding(input);
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    const panel=data.attachment.commands.summary(b).panels.find(p=>p.panelId===input.panelId);
    if(panel?.surface!=='desktop')throw Error('Only the current desktop host may receive spoken requests.');
    const claim=voice.intents.claim({sessionId:input.sessionId,sourceToken:input.sourceToken,desktopPanelId:input.panelId});
    if(claim) {
      // The queue alone retains transcript text. This map only binds a desktop
      // acknowledgement to its one-time claim receipt.
      pruneVoiceDesktopClaims();
      voiceDesktopClaims.set(claim.intent.id,{intentId:claim.intent.id,claimToken:claim.claimToken,desktopPanelId:claim.desktopPanelId,
        sessionId:claim.intent.sessionId,sourceToken:claim.intent.sourceToken,createdAt:voiceNow()});
      pruneVoiceDesktopClaims();
    }
    return {structuredContent:{pending:!!claim},_meta:{[PRIVATE_INSPECTION_META_KEY]:{voiceIntent:claim}}};
  });
  privateTool('stereo_structure.acknowledge_voice_intent',{
    title:'Record a spoken request handoff',description:'App-only acknowledgement of one desktop voice claim. Delivery status never implies the requested scientific action completed.',
    inputSchema:inspectionBindingSchema.extend({panelId:z.string().uuid(),intentId:z.string().uuid(),claimToken:z.string().uuid()}),annotations:mutation,_meta:privateUi,
  },async input=>{
    await validateVoiceBinding(input);
    const claim=voiceDesktopClaims.get(input.intentId);
    if(!claim || claim.desktopPanelId!==input.panelId || claim.claimToken!==input.claimToken || claim.sessionId!==input.sessionId || claim.sourceToken!==input.sourceToken)throw Error('Unknown voice request claim.');
    voiceDesktopClaims.delete(input.intentId);
    return {structuredContent:{acknowledged:voice.intents.acknowledge(claim)}};
  });
  privateTool('stereo_structure.acknowledge_voice_playback',{
    title:'Confirm spoken headset playback',description:'App-only receipt after the target companion finishes playing the requested OAuth voice response.',
    inputSchema:inspectionBindingSchema.extend({panelId:z.string().uuid(),playbackId:z.string().uuid()}),annotations:mutation,_meta:privateUi,
  },async input=>{
    await validateVoiceBinding(input);
    return {structuredContent:{played:voice.playbacks.acknowledge(input.playbackId,{sessionId:input.sessionId,sourceToken:input.sourceToken,panelId:input.panelId})}};
  });
  // This legacy grip edge can run only the user's exported local command and
  // carries no audio itself. Authenticated microphone capture uses the
  // separate source-bound voice_command route registered above.
  const pushToTalk = hooks.pushToTalk ?? pushToTalkFromEnv();
  privateTool('stereo_structure.push_to_talk',{
    title:'Signal a headset push-to-talk grip',description:'App-only edge report from an immersive companion. state=down when the wearer squeezes the bound controller grip and state=up when they release it. Each event runs at most one shell command the user exported on this machine, in STEREOFOLD_PTT_DOWN and STEREOFOLD_PTT_UP; this repository ships neither. No request field reaches a command and this edge itself contains no audio. Authenticated microphone capture, when the wearer grants browser permission, uses the separate voice_command route. A host started without --ptt records nothing and reports disabled. The down edge also captures what the wearer meant by "this" at that moment: the selected residues, plus the part named in the optional pointing field. It comes back as referent, so a request answered seconds later still acts on what they were on when they started speaking.',
    inputSchema:pushToTalkSchema,annotations:{...mutation,idempotentHint:false},_meta:privateUi,
  },async input=>{
    // Resolve the session first so an expired capability never runs anything.
    const data=await current(input.sessionId);
    // The grip going down IS the start of the request, so this
    // is where what the wearer meant by "this" is read. The release ends it,
    // so the next press captures where they are then rather than where they
    // were. Neither edge changes anything the wearer can see.
    const referent=input.state==='down'?referentKeys.compact(referents.capture(input.sessionId,captureRequestReferent({
      sourceToken:data.attachment.sourceToken,scene:data.attachment.scene,
      ...(input.pointing?{pointing:input.pointing}:{}),at:(hooks.now??Date.now)()}))):undefined;
    const outcome=await pushToTalk.handle(input.state,input.sessionId);
    return {content:[{type:'text' as const,text:outcome.message}],
      structuredContent:{sessionId:input.sessionId,...outcome,...(referent?{referent}:{})}};
  });
  // Version 2 of push-to-talk: the grip streams the headset microphone here in
  // one-second Opus chunks, whisper-cpp transcribes them on this Mac, and the
  // text is delivered as text. Nothing on this route synthesizes a keystroke.
  const transcriber = hooks.transcriber ?? pushToTalkTranscriberFromEnv();
  // Every finished transcript carries the referent its own press
  // opened with, so an agent reading `listen_voice` gets the words and what
  // the person meant by "this" in the same answer.
  // In the compact form, so a tour-sized selection never turns the
  // wearer's sentence into a result no model client will deliver.
  transcriber.useReferents?.(sessionId=>{
    const referent=referents.read(sessionId);
    return referent?referentKeys.compact(referent):undefined;
  });
  const readSpeechScene = createSpeechSceneReader();
  /**
   * The entry codes the recognizer is primed with, newest first.
   *
   * The shipped catalog is fixed; what this session has actually loaded is not,
   * and a wearer who has been in 1CRN once is likely to ask for it again. The
   * list is codes only — four characters each, no coordinates, no path, nothing
   * about the wearer — and it is bounded so a long session cannot grow it
   * without limit. The normaliser proposes only codes that appear here, so a
   * word it heard can never become an entry nobody could open.
   */
  const recentEntryCodes: string[] = [];
  const rememberEntryCode = (id: unknown) => {
    if (typeof id !== 'string' || !/^[1-9][A-Za-z0-9]{3}$/u.test(id)) return;
    const code = id.toUpperCase();
    const at = recentEntryCodes.indexOf(code);
    if (at >= 0) recentEntryCodes.splice(at, 1);
    recentEntryCodes.unshift(code);
    recentEntryCodes.length = Math.min(recentEntryCodes.length, MAX_REMEMBERED_ENTRY_CODES);
  };
  privateTool('stereo_structure.push_to_talk_audio',{
    title:'Stream headset microphone audio for local transcription',description:'App-only audio chunk from an immersive companion while the wearer holds the push-to-talk grip. Each call carries one base64 Opus chunk of one utterance, identified by utteranceId and ordered by seq; the call with final=true closes the utterance. The audio is assembled, decoded and transcribed on this machine, by Apple\'s on-device recognizer or by whisper-cpp, and then deleted; no audio leaves the Mac and no keystroke is synthesized. The final call returns the transcript. A host with no transcriber turned on reports disabled: the standalone launcher turns it on with --ptt, and every other host sets STEREOFOLD_PTT_TRANSCRIBE=1 in the MCP server environment.',
    inputSchema:pushToTalkAudioSchema,annotations:{...mutation,idempotentHint:false},_meta:privateUi,
  },async input=>{
    // Resolve the session first so an expired capability never reaches a file.
    const data=await current(input.sessionId);
    const utterancePanelIds=input.seq===0
      ? data.attachment.commands.summary(binding(input.sessionId,data)).panels
        .filter(panel=>panel.current&&isWearerSurface(panel.surface)&&(!input.panelId||panel.panelId===input.panelId))
        .map(panel=>panel.panelId)
      : undefined;
    if(input.seq===0&&input.panelId&&utterancePanelIds?.length!==1)
      throw Error('That utterance did not come from a current headset panel.');
    // The talk orb sends no grip edge, so its first chunk is the
    // start of the request. A press that did send a down edge already has its
    // referent and keeps it: this is the same press, reported twice.
    if(input.seq===0) referents.capture(input.sessionId,captureRequestReferent({
      sourceToken:data.attachment.sourceToken,scene:data.attachment.scene,at:(hooks.now??Date.now)()}));
    if(input.seq===0) {
      data.attachment.commands.beginUtterance(input.utteranceId,utterancePanelIds??[],binding(input.sessionId,data));
      rememberUtterancePanels(input.utteranceId,data.attachment.commands,utterancePanelIds??[]);
    }
    if(input.seq===0) rememberEntryCode(data.cache.pdbId);
    const speechScene=input.seq===0 ? readSpeechScene({
      source:data.cache,catalog:data.attachment.catalog,scene:data.attachment.scene,density:data.attachment.density,
      entryCodes:[...recentEntryCodes,...CATALOG_ENTRY_CODES],
      entryNames:CATALOG_ENTRY_NAMES.map(entry=>({entryCode:entry.entryCode,spellings:[...entry.spellings]})),
      journeyTitles:[...TOURS.map(tour=>tour.title),...MOLECULAR_EXPERIENCES.map(journey=>journey.title),
        ...(data.attachment.customTour?[data.attachment.customTour.title]:[])],
    }) : undefined;
    const outcome=await transcriber.accept(input,speechScene);
    if(input.seq===0&&outcome.accepted&&utterancePanelIds?.length)
      rememberUtterancePanels(input.utteranceId,data.attachment.commands,utterancePanelIds);
    // The words are out; the next press captures where the wearer is then.
    if(input.final) referents.release(input.sessionId);
    return {content:[{type:'text' as const,text:outcome.message}],structuredContent:{sessionId:input.sessionId,...outcome}};
  });
  /**
   * One utterance, one assistant, one action.
   *
   * The transcript queue is a broadcast log, which is exactly right for a log
   * and exactly wrong for two assistants sharing one wearer: both hold a
   * cursor, both are handed the same sentence, and the molecule gets painted
   * twice. These three helpers are the claim that was missing. While nobody has
   * attached an assistant they do nothing at all, so a Mac running one host
   * reads the queue the way it always did.
   */
  const attachedNames=()=>assistants.list().attached.map(entry=>entry.label).join(', ');
  function callerLabel(assistant?:string):string|undefined {
    if(!assistants.engaged()) return undefined;
    // An attached host names itself in the forwarded call; the owner answers to
    // the name it gave `continue_session`. Only a host that shared no name at
    // all, on a Mac where two already have, has to be asked.
    if(assistant!==undefined&&assistant!=='') return assistant;
    if(scene.label!==undefined) return scene.label;
    if(assistants.size===1) return assistants.active()?.label;
    throw Error(`Two assistants share this scene, so say which one is listening. Attached now: ${attachedNames()}.`);
  }
  const holdsFloor=(caller:string|undefined)=>caller===undefined
    || assistants.active()?.label.toLowerCase()===caller.toLowerCase();
  function claimHeard(caller:string|undefined, entries:readonly any[], cursor:number) {
    if(caller===undefined) {
      noteClaimedUtterances(entries);
      return {transcripts:[...entries],cursor,active:undefined as string|undefined,handover:undefined as any};
    }
    const claim=assistants.claim({assistant:caller,
      utterances:entries.map(entry=>({id:entry.utteranceId,text:entry.text,cursor:entry.cursor}))});
    const keep=new Set(claim.delivered.map(utterance=>utterance.id));
    const transcripts=entries.filter(entry=>keep.has(entry.utteranceId));
    noteClaimedUtterances(transcripts);
    return {transcripts,cursor:claim.cursor ?? cursor,
      active:claim.active?.label,handover:claim.handover};
  }
  /** What a host that does not hold the floor is told, without a wait. */
  const notListening=()=>{
    const active=assistants.active()?.label;
    return {text:active?`${active} is listening to the wearer now.`:'No assistant is listening to the wearer.',
      cursor:transcriber.transcripts.cursor,active:active??null};
  };
  const pollVoiceTranscripts=async(input:{sessionId:string;after?:number;waitMs?:number;assistant?:string})=>{
    await current(input.sessionId);
    const caller=callerLabel(input.assistant);
    if(!holdsFloor(caller)) {
      const quiet=notListening();
      return {content:[{type:'text' as const,text:quiet.text}],
        structuredContent:{sessionId:input.sessionId,cursor:quiet.cursor,transcripts:[],active:quiet.active,listening:false}};
    }
    noteAgentListening();
    const {cursor,entries}=await transcriber.transcripts.since(input.after ?? 0,{waitMs:input.waitMs});
    const claim=claimHeard(caller,entries,cursor);
    return {content:[{type:'text' as const,text:claim.transcripts.length?claim.transcripts.map(entry=>entry.text).join(' • ')
      :claim.handover?claim.handover.spoken:'Nothing new was said.'}],
      structuredContent:{sessionId:input.sessionId,cursor:claim.cursor,transcripts:claim.transcripts.map(entry=>({...entry,sequence:utterancePanels.get(entry.utteranceId)?.commands.utterance(entry.utteranceId)?.sequence??entry.sequence??entry.cursor})),
        ...(caller===undefined?{}:{active:claim.active??null,listening:true}),
        ...(claim.handover?{handover:claim.handover}:{})}};
  };
  privateTool('stereo_structure.poll_voice_transcripts',{
    title:'Read what the headset wearer has said',description:'App-only long poll over locally transcribed push-to-talk utterances. Pass the cursor from the previous answer to receive only what is new; the call waits up to fifteen seconds for the wearer to speak before answering with an empty list. This route is never exposed to the companion or the private Wi-Fi listener, so transcripts stay on the desktop host. Each record carries receivedAt, when the last audio chunk landed and before any recognizer ran, transcribedAt, the Unix-millisecond stamp for the recognizer\'s text being accepted, and recognizerMs, how long recognition took. When two assistants share one scene through continue_session, only the listening one receives an utterance, and each utterance is handed out once.',
    inputSchema:pollVoiceTranscriptsSchema,annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false},_meta:privateUi,
  },async input=>await pollVoiceTranscripts(input));
  scene.register('scene.poll_voice_transcripts',async(input:any)=>await pollVoiceTranscripts({
    sessionId:String(input?.sessionId??''),
    ...(typeof input?.after==='number'?{after:input.after}:{}),
    ...(typeof input?.waitMs==='number'?{waitMs:input.waitMs}:{}),
    ...(typeof input?.assistant==='string'?{assistant:input.assistant}:{})}));
  // The one voice route a model may call. `poll_voice_transcripts` above stays
  // app-only so the companion page can never read the queue; this one is
  // registered without app visibility and without a session, and is deliberately
  // absent from both network allowlists, so it answers the desktop MCP client
  // and nothing that reaches this Mac over Wi-Fi.
  const listenClock=hooks.now ?? Date.now;
  registerAppTool(server,'stereo_structure.listen_voice',{
    title:'Listen to the headset wearer',
    description:'Wait for the headset wearer to speak and return what they said. Use Talk in the headset menu, or hold A or X on Quest controllers, to speak. Talk sends microphone audio through this Mac to OpenAI for transcription using the configured OAuth voice route. Holding A or X uses the separate local Apple on-device recognizer or whisper-cpp route; that route keeps audio on this Mac. Preserve the user\'s chosen voice route. Blocks for up to timeoutSeconds (1-25, default 20) and returns as soon as an utterance is ready; timedOut=true means nobody spoke, not that voice is broken. Pass the cursor and epoch from the previous answer to receive only new speech; leave them out to start from what is still held. Each utterance has text, a scene-checked normalizedText with normalizationRules, utteranceId, sequence and, when the person pointed, a referent: what "this" meant when they started speaking. Speech is a request, not a confirmed instruction. Act on it with update_inspection, focus_selection or emphasize, echo its utteranceId, and pass referent back unchanged. Never report a change until its receipt says rendered. To correct or cancel an earlier request, send update_inspection with change kind "utterance" before the replacement. Every call is a model turn, so loop on it only while the wearer is talking to you; a person who dictates to you directly needs none of it. Each call keeps the headset\'s sessions from expiring, even while nobody wears it. When the private Wi-Fi share is 15 minutes or less from closing, or has run out of time, the answer carries share {state, reason, at} and says what to do. Times: at is when the last audio reached this Mac, transcribedAt when recognition finished, recognizerMs how long recognition took. at to transcribedAt is recognition; the rest is delivery. sequence is assigned when recording starts, so completion order is not request order.',
    inputSchema:listenVoiceSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:false},_meta:{},
  },async(input:{timeoutSeconds?:number;cursor?:number;epoch?:string;assistant?:string})=>await listenVoice(input));
  async function listenVoice({timeoutSeconds,cursor,epoch,assistant}:{timeoutSeconds?:number;cursor?:number;epoch?:string;assistant?:string}) {
    // An agent waiting here is still using the sessions this headset shows,
    // even while the wearer has it off and no page polls them.
    for(const id of new Set([lanOwner?.sessionId,...sharedSessions])) if(id) try { hooks.current(id); } catch { /* Already gone. */ }
    const queue=transcriber.transcripts, queueEpoch=queue.epoch ?? hooks.serverEpoch;
    const caller=callerLabel(assistant);
    // A host that does not hold the floor never waits. It is
    // told who does, at once, so it cannot sit on a long poll for speech that
    // was never going to be handed to it.
    if(!holdsFloor(caller)) {
      const quiet=notListening();
      return {content:[{type:'text' as const,text:quiet.text}],
        structuredContent:{transcripts:[],cursor:quiet.cursor,epoch:queueEpoch,timedOut:false,active:quiet.active,listening:false}};
    }
    noteAgentListening();
    const deadline=listenClock()+(timeoutSeconds ?? LISTEN_VOICE_DEFAULT_SECONDS)*1_000;
    // A cursor from another queue, or past this one's head, was counted before
    // this server restarted; honouring it would skip that many new utterances.
    const restarted=cursor!==undefined && ((epoch!==undefined && epoch!==queueEpoch) || cursor>queue.cursor);
    let after=restarted ? 0 : cursor ?? 0;
    // The queue's own wait is capped below the tool's ceiling, so a long
    // window is several bounded waits rather than one unbounded one. The cursor
    // moves with every claim, so a batch this caller may not act on is read
    // once rather than spun on until the window closes.
    let claim=claimHeard(undefined,[],after);
    for(;;) {
      const answer=await queue.since(after,{waitMs:Math.min(Math.max(deadline-listenClock(),0),PTT_POLL_MAX_WAIT_MS)});
      claim=claimHeard(caller,answer.entries,answer.cursor);
      after=claim.cursor;
      if(claim.transcripts.length||claim.handover||listenClock()>=deadline) break;
    }
    // The referent rides beside the words. Pass it back on the
    // tool that acts on them and "this part" stays the part they meant when
    // they started speaking, however long the answer took.
    const transcripts=claim.transcripts.map(entry=>({utteranceId:entry.utteranceId,sequence:utterancePanels.get(entry.utteranceId)?.commands.utterance(entry.utteranceId)?.sequence??entry.sequence??entry.cursor,utteranceSequence:utterancePanels.get(entry.utteranceId)?.commands.utterance(entry.utteranceId)?.sequence,text:entry.text,normalizedText:entry.normalizedText??entry.text,normalizationRules:entry.normalizationRules??[],at:entry.receivedAt,durationMs:entry.durationMs,
      // `at` is still the last audio chunk landing. These two say
      // when the words existed and what recognition cost, so a reader stops
      // charging the recognizer's run to delivery.
      ...(entry.transcribedAt===undefined?{}:{transcribedAt:entry.transcribedAt}),
      ...(entry.recognizerMs===undefined?{}:{recognizerMs:entry.recognizerMs}),
      ...(entry.referent?{referent:entry.referent}:{})}));
    const heard=transcripts.length?transcripts.map(entry=>entry.text).join(' • ')
      :claim.handover?claim.handover.spoken
        :transcriber.ready&&transcriber.enabled?'The wearer said nothing in that window.'
          :'Nothing was heard, and this host has no local transcriber configured, so nothing can be heard. Restart the standalone launcher with --ptt, or set STEREOFOLD_PTT_TRANSCRIBE=1 in the MCP server environment and restart the host; the startup line on stderr names whatever is still missing.';
    // The agent spends its time here, so this is where it learns the share is
    // about to end, or has ended, while there is still something to do about it.
    const share=lan.notice();
    const text=[heard,
      ...(restarted?['The voice queue restarted since that cursor, so this answer starts from the oldest utterance it holds.']:[]),
      ...(share?[shareNoticeText(share)]:[])].join('\n');
    return {content:[{type:'text' as const,text}],
      structuredContent:{transcripts,cursor:claim.cursor,epoch:queueEpoch,timedOut:transcripts.length===0&&claim.handover===undefined,
        ...(caller===undefined?{}:{active:claim.active??null,listening:true}),
        ...(claim.handover?{handover:claim.handover}:{}),
        ...(share?{share}:{})}};
  }
  /** The share's end in this Mac's clock time, and what to do about it. */
  function shareNoticeText({state,reason,at}:ShareNotice) {
    const time=new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const reopen='open_companion with connection="lan" for a new share and follow its returned pairing instructions.';
    if(state==='closed') return `The private Wi-Fi share closed at ${time} ${reason==='ceiling'?'at its time limit':'after the headset stopped calling this Mac'}. Call ${reopen}`;
    return reason==='ceiling'
      ? `The private Wi-Fi share reaches its time limit at ${time}, and opening it again before then keeps that limit. Warn the wearer now, and after ${time} call ${reopen}`
      : `The headset has stopped calling this Mac, so the private Wi-Fi share closes at ${time} unless it calls again before then.`;
  }
  scene.register('scene.listen_voice',async(input:any)=>await listenVoice({
    ...(typeof input?.timeoutSeconds==='number'?{timeoutSeconds:input.timeoutSeconds}:{}),
    ...(typeof input?.cursor==='number'?{cursor:input.cursor}:{}),
    ...(typeof input?.epoch==='string'?{epoch:input.epoch}:{}),
    ...(typeof input?.assistant==='string'?{assistant:input.assistant}:{})}));
  /**
   * "Continue this session", and who is listening.
   *
   * The ownership register lives with the scene, never with the host asking
   * about it, so both hosts read one answer. An attached host reaches it the
   * same way it reaches everything else: over the loopback route.
   */
  scene.register('scene.assistants',async()=>assistants.list());
  scene.register('scene.attach_assistant',async(input:any)=>{
    assistants.attach({label:normalizeAssistantLabel(String(input?.label??''))});
    return assistants.list();
  });
  const readAssistants=async()=>scene.role==='attached'
    ? await scene.call('scene.assistants',{}) as ReturnType<typeof assistants.list>
    : assistants.list();
  const joinAssistants=async(label:string)=>scene.role==='attached'
    ? await scene.call('scene.attach_assistant',{label}) as ReturnType<typeof assistants.list>
    : (assistants.attach({label}),assistants.list());
  /** The one reading that proves a scene continued rather than a copy opened. */
  async function continuationOf(sessionId:string) {
    const state:any=scene.proxies(sessionId)
      ? await scene.call('get_inspection_state',{sessionId})
      : await scene.dispatch('get_inspection_state',{sessionId});
    const content=state?.structuredContent ?? {};
    const view=content.view ?? null;
    const panels:any[]=Array.isArray(content.panels)?content.panels:[];
    const showing=panels.find(panel=>panel.current&&panel.tour)??panels.find(panel=>panel.tour);
    return {sourceToken:content.sourceToken??null,stateRevision:content.stateRevision??null,
      inspectionRevision:content.inspectionRevision??null,hasScene:Boolean(content.hasScene),
      selectedResidueCount:view?.selectedResidueCount??0,
      emphasis:view?.emphasis??null,placement:view?.placement??null,appearance:view?.appearance??null,
      lesson:content.lesson?{id:content.lesson.id,title:content.lesson.title}:null,
      tour:showing?.tour??null,panels:panels.length};
  }
  registerHostTool(server,'stereo_structure.continue_session',{
    title:'Continue the molecular session already open on this Mac',
    description:'Call this when joining or reusing a molecular session from another host, including its headset connection. Pass assistant="Codex" from Codex or assistant="Claude" from Claude. If role=owner or role=attached, reuse its sessionId for the current scene and edits. Use replace_inspection_source only when the user requests a different structure; keep its headset connection. If role=none with retry=true, the recorded owner is still running: retry continue_session after 5 seconds and preserve that scene. After 60 seconds without recovery, inspect recordPath and its recorded process; preserve a live Stereofold owner. Only create a new scene when that owner is confirmed closed or stale, or the user requests one. For kind=external-owner-unavailable, follow its host recovery instructions. Only when role=none has no retry or external-owner recovery condition, or the user requests a new session, call inspect, then open_companion with {connection:"lan",headset:"meta",launch:"auto",waitForHeadsetMs:20000} for Meta Quest or {connection:"lan",headset:"apple",launch:"auto"} for Apple Vision Pro. A later host joins the same scene, selection and placement through this call; the headset viewpoint remains on the headset. The first attached assistant listens to the wearer; switch_assistant hands that role over.',
    inputSchema:continueSessionSchema,annotations:mutation,_meta:{},
  },async(input:any)=>{
    const label=input?.assistant?normalizeAssistantLabel(String(input.assistant)):undefined;
    const unavailable=async(reason:string,retry?:boolean)=>{
      const command=headsetHostCommand();
      const recordPath=scene.path;
      const socketPath=(hooks.environment??process.env).STEREOFOLD_SCENE_SOCKET;
      const route=`Owner record: ${recordPath}. Scene socket: ${socketPath||'STEREOFOLD_SCENE_SOCKET is unset'}.`;
      const next=retry
        ?`The recorded headset host is running but not answering yet; call continue_session again shortly. If it has exited, start a new one in a Mac terminal with ${command}.`
        :`The headset host is not running or cannot be reached from this sandbox. Start it in a Mac terminal with ${command}, keep it running, then call continue_session again.`;
      return {content:[{type:'text' as const,text:`${next} (role=none): ${reason}. ${route} Grant the sandbox read access to the record directory and Unix-socket access to the socket directory.`}],
        structuredContent:{kind:'external-owner-unavailable',role:'none' as const,reason,command,recordPath,socketPath:socketPath??null,...(retry?{retry:true}:{}),assistants:await readAssistants()}};
    };
    let shared;
    try { shared=await scene.share(label?{assistant:label}:{}); }
    catch (error) {
      // A saved local scene can make share try to publish before the sandbox
      // probe below runs. Keep other owner and record failures visible.
      if ((error as NodeJS.ErrnoException).code==='EPERM'
        && await (hooks.loopbackListenDenied ?? loopbackListenDenied)()) {
        return await unavailable('this sandbox cannot publish its local scene on loopback');
      }
      throw error;
    }
    if(shared.role==='none'||!shared.sessionId) {
      const reason=shared.reason??'no scene service is recorded on this Mac';
      if(await (hooks.loopbackListenDenied ?? loopbackListenDenied)()) {
        return await unavailable(reason,shared.retry);
      }
      // An owner that still runs may only be slow, and a structure opened here
      // now would become a second scene when this host took over.
      const next=shared.retry
        ?' Its process is still running, so call continue_session again in a moment. After 60 seconds, inspect the owner record at '+scene.path+' and its process; preserve a live Stereofold host. Open a structure here only if that scene has closed or the record is confirmed stale.'
        :' Open a structure here first.';
      return {content:[{type:'text' as const,text:`There is no open scene to continue (role=none): ${reason}.${next}`}],
        structuredContent:{kind:'scene-continuation',role:'none' as const,reason,...(shared.retry?{retry:true,recordPath:scene.path}:{}),assistants:await readAssistants()}};
    }
    const sessionId=shared.sessionId;
    const ownership=label?await joinAssistants(label):await readAssistants();
    const view=await continuationOf(sessionId);
    const listening=ownership.active?`${ownership.active} is listening to the wearer.`:'No assistant is listening yet.';
    // Some hosts hand the model only this text, never structuredContent, so the
    // role and the sessionId the description promises are spelled out here too.
    const where=`(role=${shared.role}, sessionId ${sessionId})`;
    const text=shared.role==='attached'
      ? `Joined the scene already open on this Mac ${where}. ${listening}`
      : shared.tookOver
        ? `Took over the shared scene from a host that had stopped ${where}. ${listening}`
        : `This Mac now shares one scene ${where}. ${listening}`;
    return {content:[{type:'text' as const,text}],
      structuredContent:{kind:'scene-continuation',role:shared.role,sessionId,sceneId:shared.sceneId,
        ...(shared.tookOver?{tookOver:true}:{}),scene:view,assistants:ownership}};
  });
  registerAppTool(server,'stereo_structure.switch_assistant',{
    title:'Hand the wearer’s voice to another assistant',
    description:'Hand the floor to another assistant attached to this shared scene, or read who holds it. Exactly one attached assistant receives what the wearer says, and each utterance is delivered once, so a handover is what lets the other host act without both of them acting. Pass to with the name that assistant attached under, such as "Codex"; omit to only to read the current holder. The wearer can do the same thing out loud by saying "switch to Codex", which is consumed as a handover rather than acted on as a request. Nothing about the scene changes: the renderer, the selection and the lesson position stay exactly as they are, and a host that has been quiet keeps the floor until someone hands it over or the shared scene ends.',
    inputSchema:switchAssistantSchema,annotations:mutation,_meta:{},
  },async input=>{
    await current(input.sessionId);
    if(input.to===undefined) {
      const list=assistants.list();
      return {content:[{type:'text' as const,text:list.active?`${list.active} is listening to the wearer.`:'No assistant is listening yet.'}],
        structuredContent:{kind:'assistant-ownership',sessionId:input.sessionId,...list}};
    }
    const moved=assistants.handOver(input.to,{by:'tool'});
    return {content:[{type:'text' as const,text:moved.changed?moved.spoken:`${moved.to} was already listening.`}],
      structuredContent:{kind:'assistant-ownership',sessionId:input.sessionId,spoken:handoverLine(moved.to),
        handover:{from:moved.from,to:moved.to,by:'tool' as const,changed:moved.changed},...assistants.list()}};
  });
  // The reply half of the conversation, and the only one that works on every
  // host. `speak_to_headset` needs the host's OAuth voice hook; this one needs
  // nothing but the companion heartbeat, so it answers under Claude Code and
  // Claude Science too. Like `listen_voice` it is registered without app
  // visibility and without a session, and it is deliberately absent from both
  // network allowlists, so the headset can receive a reply but never write one.
  registerAppTool(server,'stereo_structure.say_to_headset',{
    title:'Say a reply to the headset wearer',
    description:'Show and speak a reply to the person wearing the paired headset: the text is drawn as a caption and, unless speak is false, spoken. Use it after acting on a request, as a short spoken answer rather than a report. text is 1-1200 characters and at most 200 words; a longer reply is refused, so send the rest in a second call. A long answer is spoken as consecutive segments of at most 240 characters, 36 words and 15 seconds, split at its own sentences; nothing is cut. Pass the request\'s utteranceId when there is one: it is refused once a newer utterance has been claimed on that panel. Without it the reply is unbound. holdSeconds (2-15, default 6) is how long the last caption stays up. Read the receipt before telling anyone the wearer got it. delivered=true means a headset page took the caption. queued=true alone is not delivery. audible=true means audio was prepared, not that anyone heard it; audible=false or spokenVia="none" means the reply was a caption only. stale=true means a newer reply or utterance replaced this one before it was spoken. wearer.linked=false means no headset page is attached, so nobody read or heard it. Set refusal={tool,sessionId} only to show a refusal card for a request your own surface turned down before any tool call, such as an insecure URL; never for an answer. A tool call this host refused is already on the wearer\'s screen: an identical refusal within twenty seconds comes back duplicate=true and is not drawn again. After a refusal, say what you will do instead, or nothing.',
    inputSchema:sayToHeadsetSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},_meta:{},
  },async(input:SayToHeadsetInput)=>{
    /**
     * A refusal raised before the request could become a tool call.
     *
     * It takes the refusal path, not the reply path: it is never spoken, it
     * does not claim a reply turn, and it writes the same `outcome` record
     * `read_headset_log` already shows for a refused mutation. Without this a
     * wearer who asked the loop for an insecure URL saw nothing at all, while
     * the same request typed at a menu row drew a card
     */
    if(input.refusal) return await deliverReportedRefusal(input,input.refusal);
    /**
     * Whether this reply had anywhere to go.
     *
     * `queued:true, delivered:false` was read as success while the
     * share had already ended, so the wearer heard nothing and was told they had
     *. This says the same two facts in one field: whether a page
     * took the reply, and whether a private Wi-Fi share with a paired client
     * still exists for one to take it on the next heartbeat.
     */
    const replyWearerLink=(tookIt:boolean)=>{
      const live=lanOwner?lan.status():undefined;
      const share=Boolean(live && live.clients.length>0);
      return {linked:tookIt||share,share,
        note:tookIt?'A connected page took this reply.'
          :share?'No page has taken this reply yet; the private Wi-Fi share is open, so one can take it on the next heartbeat.'
            :'No wearer is linked: no page took this reply and no private Wi-Fi share has a paired client, so nothing here '
              +'says the wearer read or heard it. Reconnect with open_companion before reporting it as delivered.'};
    };
    const order=++newestReply;
    for (const [id,serial] of refusalSerials) refusalSerials.set(id,serial+1);
    const replyId=randomUUID();
    const fullText=normalizeHeadsetCaption(input.text);
    const speaking=input.speak!==false;
    // The whole answer, as the consecutive segments the wearer will hear. A
    // reply that fits one segment yields exactly one, so a short answer takes
    // the path it always took.
    const lines=speaking?splitHeadsetSpeech(fullText):[];
    const spokenText=lines.join(' ');
    const holdSeconds=input.holdSeconds??HEADSET_CAPTION_DEFAULT_HOLD_SECONDS;
    const tenths=(value:number)=>Math.round(value*10)/10;
    const limitLine=` Reply limit: ${HEADSET_REPLY_MAX_CHARS} characters and ${HEADSET_REPLY_MAX_WORDS} words, `
      +`about ${HEADSET_REPLY_MAX_SECONDS} seconds spoken; each segment is capped at `
      +`${HEADSET_SPEECH_MAX_CHARS} characters, ${HEADSET_SPEECH_MAX_WORDS} complete words and ${HEADSET_SPEECH_MAX_SECONDS} seconds of prepared audio.`;
    const staleReceipt=(activeUtteranceId:string|undefined,reason:string)=>({
      content:[{type:'text' as const,text:`Refused stale utterance reply ${input.utteranceId}: active utterance ${activeUtteranceId??'none'}. ${reason}`}],
      structuredContent:{queued:false,delivered:false,captionId:replyId,text:fullText,spoken:false,speechLimit:HEADSET_SPEECH_LIMIT,
        holdSeconds,audible:false,stale:true,segmentCount:lines.length,wearer:replyWearerLink(false),
        utteranceBinding:'stale' as const,utteranceId:input.utteranceId,activeUtteranceId:activeUtteranceId??null,
        truncated:false,
        ...(speaking?{spokenText}:{})}});
    const admission=input.utteranceId?replyUtteranceAdmission(input.utteranceId):undefined;
    if(admission&&!admission.accepted)
      return staleReceipt(admission.activeUtteranceId,'The reply was not prepared, shown or spoken.');
    const stillCurrent=()=>order===newestReply
      &&(!input.utteranceId||replyUtteranceAdmission(input.utteranceId).accepted);
    noteConversationAction(input.utteranceId);
    /**
     * The caption is queued before a word of it has been rendered.
     *
     * Speech is a round trip to the narration helper. On a device session the
     * pass one 115-character segment took 5.6-5.9 s, and because the render
     * stood in front of the queue the wearer read nothing for six seconds,
     * while a scoped refusal, which is never spoken, was on the plate in a
     * tenth of one. The words go out now and the clips catch up:
     * they are hung on the same entry when they arrive before a page takes it,
     * and sent as their own spoken copy when they do not.
     */
    const retired=captions.retiring();
    // What this reply cuts short, read before it takes the caption row away.
    const superseded=captions.interrupted();
    const caption=captions.say({...input,text:fullText},{id:replyId,
      ...(lines.length?{segments:lines.map((line,index)=>({index,text:line,
        seconds:estimateHeadsetSpeechSeconds(line)}))}:{})});
    // An older reply still waiting on its own speech answered a turn that is
    // over. Take it back while no page has it; once a page does, the wearer has
    // read it and the only honest receipt is one that says so.
    for(const [olderOrder,olderId] of pendingSpeech) {
      if(olderOrder>=order) continue;
      pendingSpeech.delete(olderOrder);
      if(!captions.withdraw(olderId)) drawnBeforeStale.add(olderId);
      while(drawnBeforeStale.size>32) drawnBeforeStale.delete(drawnBeforeStale.values().next().value!);
    }
    pendingSpeech.set(order,replyId);
    // The companion heartbeat runs about once a second, so a short bounded
    // wait turns a blind send into a reported delivery without a new channel.
    // It starts here rather than after the render, because the caption a page
    // takes is already on the queue.
    const queuedAt=Math.round((hooks.now??Date.now)());
    let captionDrawnMs:number|undefined;
    const deliveryWait=captions.waitForDelivery(caption.id,HEADSET_CAPTION_DELIVERY_WAIT_MS)
      .then(taken=>{
        if(taken&&captionDrawnMs===undefined) captionDrawnMs=Math.max(0,Math.round((hooks.now??Date.now)())-queuedAt);
        return taken;
      });
    /**
     * The segments are rendered together, and the opening of the
     * answer is handed over the moment it exists.
     *
     * Rendering still runs once per segment, so every clip stays inside the
     * encoder ceiling, and a segment still fails to `undefined` rather than to
     * an error: a reply the wearer can read beats no reply at all. What
     * changed is that the calls overlap. Each one costs about 4.0 s of fixed
     * setup on this Mac before it produces a sample, so running them one after
     * another charged the wearer that 4 s again for every sentence. Measured
     * end to end through this route, a 435-character answer in three segments
     * took 18.3 s to finish rendering and 7.7 s to reach its first clip; the
     * same answer with the calls overlapped finished in 6.1-6.4 s across three
     * runs. A reply that fits one segment has nothing to overlap and is
     * unchanged at about 5 s.
     *
     * `onReady` hands each leading run to the caption while no page has taken
     * it, so a page that beats between the opening segment and the last one
     * gets the opening rather than silence. `attachSpeech` refuses once a page
     * has the entry, and `handedOff` is how many segments were on the entry at
     * the last attach that succeeded: whatever a page took, it took that many,
     * and the rest is what still has to be sent. Without that count the
     * spoken copy would carry the whole answer again and the wearer would hear
     * the opening twice.
     */
    const speechStartedAt=Math.round((hooks.now??Date.now)());
    let handedOff=0;
    const render=await renderReplySpeech({lines,
      synthesize:line=>replyAudio.synthesize(line),
      budgetMs:HEADSET_REPLY_RENDER_BUDGET_MS,stillCurrent,now:()=>(hooks.now??Date.now)(),
      onReady:ready=>{
        // The final attach below carries the whole answer; a partial one is
        // only worth making while there is still something left to render.
        if(ready.length>=lines.length) return;
        if(captions.attachSpeech(caption.id,ready)) handedOff=ready.length;
      }});
    const segments=render.segments;
    const budgetSpent=render.budgetSpent;
    pendingSpeech.delete(order);
    const speechReadyMs=Math.max(0,Math.round((hooks.now??Date.now)())-speechStartedAt);
    // When the wearer could first have heard something, on the same clock as
    // `speechReadyMs`, so a device pass can read the gap between the opening
    // of an answer and the end of it.
    const firstAudioMs=render.firstAudioMs;
    // A reply the wearer has moved past is taken off the queue unspoken. Say
    // which it was: withdrawn before any page saw it, or already read.
    const wasDrawn=()=>{
      if(drawnBeforeStale.delete(replyId)) return true;
      return !captions.withdraw(replyId);
    };
    const staleSentence=(reason:string)=>wasDrawn()
      ?`${reason} It had already been drawn, so it stays on the plate until the newer reply replaces it, but it is never spoken.`
      :`${reason} It was taken off the queue before any page saw it.`;
    const currentAdmission=input.utteranceId?replyUtteranceAdmission(input.utteranceId):undefined;
    if(currentAdmission&&!currentAdmission.accepted)
      return staleReceipt(currentAdmission.activeUtteranceId,
        staleSentence('A newer claimed utterance became active before speech was ready.'));
    // A later call owns the newer turn even when its shorter synthesis finished
    // first. Keep this reply in the receipt, but never speak it on a page.
    if(order!==newestReply) {
      const drawn=wasDrawn();
      return {content:[{type:'text' as const,text:`Dropped stale reply: ${fullText} `
        +staleSentence('A newer reply started before speech was ready.')}],
        structuredContent:{queued:false,delivered:false,captionId:replyId,text:fullText,spoken:false,speechLimit:HEADSET_SPEECH_LIMIT,
          holdSeconds,audible:false,stale:true,segmentCount:lines.length,drawn,speechReadyMs,wearer:replyWearerLink(drawn),
          firstAudioMs:firstAudioMs??null,abandonedSegments:render.abandoned,
          utteranceBinding:input.utteranceId?'active' as const:'unbound' as const,
          ...(input.utteranceId?{utteranceId:input.utteranceId,activeUtteranceId:input.utteranceId}:{unbound:true}),
          truncated:false,
          ...(speaking?{spokenText}:{})}};
    }
    // Where the sound ended up. `caption` when the clips reached the entry the
    // wearer reads, `voice` when a page had already taken that entry and the
    // spoken copy follows it, `none` when this Mac rendered nothing.
    const audible=segments.some(segment=>segment.audio);
    // A successful attach means no page has this entry, so nothing on it was
    // heard and the whole answer is on the caption the wearer reads.
    const attached=audible&&captions.attachSpeech(caption.id,segments);
    // What a page that already took the entry has not been given. Renumbered
    // from zero, because a page plays the segments of an entry in the order
    // that entry lists them.
    const remaining=attached?[]:segments.slice(handedOff)
      .map((segment,index)=>({...segment,index}));
    const spokenVia=!audible?'none' as const
      :attached||!remaining.some(segment=>segment.audio)?'caption' as const
      :'voice' as const;
    const voiceCaptionId=spokenVia==='voice'
      ?captions.say({...input,text:remaining.map(segment=>segment.text).join(' ')},
        {segments:remaining,voiceFor:caption.id}).id
      :undefined;
    const delivered=await deliveryWait;
    const deliveryAdmission=input.utteranceId?replyUtteranceAdmission(input.utteranceId):undefined;
    if(!delivered&&deliveryAdmission&&!deliveryAdmission.accepted)
      return staleReceipt(deliveryAdmission.activeUtteranceId,'The queued reply became stale before headset delivery.');
    const audibleSegments=segments.filter(segment=>segment.audio).length;
    const preparedAudio=segments.find(segment=>segment.audio)?.audio;
    const measuredSegments=segments.filter(segment=>segment.audio?.seconds!==undefined).length;
    const totalSeconds=tenths(segments.reduce((sum,segment)=>sum+(segment.seconds??0),0));
    const audioBytes=segments.reduce((sum,segment)=>sum+(segment.audio?.bytes??0),0);
    const durations=!segments.length?'none' as const
      :measuredSegments===segments.length?'measured' as const
      :measuredSegments?'mixed' as const:'estimated' as const;
    const spokenAs=segments.length>1
      ?` Spoken as ${segments.length} segments back to back, ${durations==='measured'?'':'about '}${totalSeconds} seconds in total, with the caption advancing on each one.`
      :'';
    const partlySilent=segments.length&&audibleSegments<segments.length
      ?` ${segments.length-audibleSegments} of ${segments.length} segments carry no prepared audio${budgetSpent?' because the render budget ran out':''}; their text is still drawn.`
      :'';
    const cutShort=superseded
      ?` This reply supersedes ${superseded.captionId}: the page drops ${superseded.droppedSegments} of its ${superseded.segments} segments, unheard.`
      :'';
    const retiredCard=retired
      ?` It retires the ${retired.kind} card ${retired.captionId} ${retired.shownMs} ms into its ${retired.holdMs} ms hold.`
      :'';
    const drawnText=captionDrawnMs===undefined?''
      :` A page took the caption ${captionDrawnMs} ms after it was queued; its speech was ready at ${speechReadyMs} ms.`;
    // Reported whether or not a page has been seen, because how soon an answer
    // starts is the number this route is judged on and it is true either way.
    const openingText=firstAudioMs===undefined||firstAudioMs===speechReadyMs?''
      :` The first segment was playable at ${firstAudioMs} ms.`;
    const spokenLater=spokenVia==='voice'
      ?` A page had already taken the caption, so the spoken copy follows as ${voiceCaptionId}.`
      :'';
    const bindingText=input.utteranceId?` Bound to active utterance ${input.utteranceId}.`:' This reply was unbound to an utterance.';
    const wearer=replyWearerLink(delivered);
    const text=(delivered?`Delivered reply to the companion: ${caption.text}`
      :wearer.share?`Queued for the headset: ${caption.text} No connected companion page has taken it yet; it will be shown on the next heartbeat.`
        :`Queued, but nothing took it: ${caption.text} ${wearer.note}`)
      +drawnText+openingText+spokenAs+partlySilent+spokenLater+cutShort+retiredCard+limitLine+bindingText;
    return {content:[{type:'text' as const,text}],
      structuredContent:{queued:true,delivered,captionId:caption.id,text:caption.text,spoken:caption.speak,speechLimit:HEADSET_SPEECH_LIMIT,holdSeconds:caption.holdSeconds,
        audible:audibleSegments>0,stale:false,truncated:false,wearer,
        segmentCount:segments.length,audibleSegments,totalSeconds,durations,
        segments:segments.map(segment=>({index:segment.index,chars:segment.text.length,
          seconds:segment.seconds??0,audible:Boolean(segment.audio),
          duration:segment.audio?.seconds!==undefined?'measured' as const:'estimated' as const})),
        captionDrawnMs:captionDrawnMs??null,speechReadyMs,firstAudioMs:firstAudioMs??null,spokenVia,
        ...(voiceCaptionId?{voiceCaptionId}:{}),
        utteranceBinding:input.utteranceId?'active' as const:'unbound' as const,
        ...(input.utteranceId?{utteranceId:input.utteranceId,activeUtteranceId:input.utteranceId}:{unbound:true}),
        ...(superseded?{supersedes:superseded}:{}),
        ...(retired?{retired}:{}),
        ...(caption.speak?{spokenText:caption.speechText}:{}),
        ...(preparedAudio?{audioBytes,audioFormat:preparedAudio.format}:{})}};
  });
  // The headset's own log. Like `listen_voice` and `say_to_headset` this is a
  // model-side tool with no session binding and no app visibility, and it is
  // absent from both network allowlists, so the paired page can write entries
  // on its heartbeat but can never read the log back.
  registerAppTool(server,'stereo_structure.read_headset_log',{
    title:'Read the paired headset\u2019s log',
    description:'Read what actually happened inside the paired headset: session start facts (user agent, XR mode, enabled features, controller or hand profiles and handedness, device class, framebuffer scale and target frame rate), every select and squeeze with which hand made it and whether the toolbar or the talk orb claimed it, microphone permission and which audio recording formats the headset browser accepts, uncaught page errors, XR frame callback errors, and a rolling frame-rate estimate. Entries arrive on the companion heartbeat, so a headset that is not connected returns nothing rather than an error. Pass sinceSequence from the previous answer to read only what is new, limit (1-500, default 100) to bound one page, and kind to read one event type. Use it when the wearer reports that voice, a control or the display did not work and the page shows nothing on this Mac. No coordinates, tokens or pairing material appear in the log.',
    inputSchema:readHeadsetLogSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{},
  },async(input:ReadHeadsetLogInput)=>{
    const page=diagnostics.read(input);
    const summary=diagnostics.summary();
    const text=page.entries.length
      ? `${page.entries.length} headset ${page.entries.length===1?'entry':'entries'}${page.more?' (more waiting; call again with the returned cursor)':''}.\n${page.entries.map(formatDiagnosticLine).join('\n')}`
      : summary.entries>0
        ? 'No headset entries after that sequence. The headset is reporting; nothing new has happened.'
        : 'The headset has reported nothing. Open the companion on the headset and enter immersion, then read again.';
    return {content:[{type:'text' as const,text}],
      structuredContent:{entries:page.entries,cursor:page.cursor,more:page.more,limit:input.limit ?? READ_HEADSET_LOG_DEFAULT_LIMIT,summary}};
  });
  // The page's half of `capture_headset_view`. It is the one route in this
  // file that carries pixels from the headset to this Mac, so it is bound to
  // the current source and to a companion panel, and it answers only a request
  // this Mac armed. The image is held in memory for the waiting agent and is
  // written to disk only where that agent asks for a file.
  async function validateHeadsetViewPanel(input:any) {
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken)
      throw Error('The capture belongs to a changed view. Ask for another one.');
    if(data.attachment.commands.surfaceOf(input.panelId)!=='companion')
      throw Error('Only the current companion page can answer a headset capture.');
  }
  privateTool('stereo_structure.submit_headset_view',{
    title:'Deliver one headset snapshot',description:'App-only answer to a capture this Mac requested on the companion heartbeat. Carries one base64 JPEG of a single downscaled eye, or a failure reason. Nothing is accepted without a matching outstanding request from the current companion panel.',
    inputSchema:inspectionBindingSchema.extend({panelId:z.string().uuid(),...headsetViewFrameShape}),annotations:{...mutation,idempotentHint:false},_meta:privateUi,
  },async input=>{
    await validateHeadsetViewPanel(input);
    const outcome=headsetView.submit(input.sessionId,input.panelId,input as any);
    return {structuredContent:{accepted:outcome.ok,...(outcome.ok?{bytes:outcome.frame.bytes,width:outcome.frame.width,height:outcome.frame.height}:{})}};
  });
  // What the wearer is actually looking at. Like `listen_voice`, `say_to_headset`
  // and `read_headset_log` this is a model-side tool with optional page-session binding
  // and no app visibility, and it is deliberately absent from both network
  // allowlists: the headset can be asked for a view but can never ask for one.
  const captureNow=hooks.now ?? Date.now;
  const captureEnvironment=()=>hooks.environment ?? process.env;
  const deviceHooks:DeviceCaptureHooks=hooks.headsetDevice ?? {
    run:spawnDeviceRunner,
    get env() { return captureEnvironment(); },
  };
  /**
   * Whether Android is showing its "isn't responding" dialog
   * over Quest Browser.
   *
   * The wearer sees that as the whole world dimming for three seconds every ten
   * and nothing else, and the agent used to see it as blurred captures, paused
   * tours and refused commands with no cause attached. One adb round trip names
   * it. A Mac without adb gets `unknown` here and says nothing about it, which
   * is the same silence it keeps about every other cable-only ability.
   */
  const browserHealth=()=>headsetBrowserHealth({hooks:deviceHooks});
  /**
   * Tell the wearer, in the headset, what is about to happen.
   *
   * It is the same queue and the same rendered clip `say_to_headset` uses, so a
   * recovery sounds like every other spoken reply. Nothing here waits for
   * delivery: a browser that is about to be stopped may take the caption or may
   * not, and a recovery must not hang on that either way.
   */
  async function sayToWearer(text:string) {
    let audio;
    try { audio=await replyAudio.synthesize(normalizeHeadsetCaption(text)); }
    catch { /* A caption with no sound still beats a world that goes away unannounced. */ }
    try { captions.say({text},{...(audio?{audio}:{})}); } catch { /* An unsayable line never costs the recovery. */ }
  }
  const browserHealthLine=(health:HeadsetBrowserHealth)=>health.browser==='anr'
    ? `Quest Browser is showing an ANR dialog${health.since?` (Android declared it at ${health.since} on the headset's clock)`:''}: the wearer's view dims every ten seconds and the session cannot run. Clear it with manage_companion action="recover-browser".`
    : health.browser==='ok' ? 'Android reports no Quest Browser ANR dialog. This check does not confirm a connected Stereofold page or immersive rendering.' : undefined;
  /**
   * Put the still in the Claude Science bridge as well, when one is configured.
   *
   * Claude Science cannot open a loopback connection, so it reads a directory
   * instead. Until now every revision in that directory came from the IWER
   * harness; this makes the physical headset a producer for it. The write is
   * best effort by design: an unwritable bridge must never cost the agent the
   * image it just asked for, so a failure is reported beside the capture rather
   * than thrown.
   */
  async function publishHeadsetView(still:Omit<BridgeHeadsetViewInput,'at'> & {at:number}):Promise<Record<string,unknown>|undefined> {
    const directory=captureEnvironment().STEREOFOLD_BRIDGE_DIR;
    if(!directory || !isAbsolute(directory)) return undefined;
    try {
      const record=await writeBridgeHeadsetView(directory,{...still,at:new Date(still.at).toISOString()});
      return {directory,file:record.file,mediaType:record.mediaType,source:record.source,sha256:record.sha256};
    } catch(error) {
      return {directory,error:(error instanceof Error?error.message:String(error)).slice(0,200)};
    }
  }
  registerAppTool(server,'stereo_structure.capture_headset_view',{
    title:'See what the headset wearer sees',
    description:'Save one headset still on this Mac to check the structure, spatial menu or tour. source="auto" (default) tries the page, then the device. Pass sessionId to limit the page request to that inspection and its current source; without it, the first companion page may answer. Page results name the actual session, panel and source. A device still is the physical display and is not session-bound, including an auto fallback. page: the companion page posts one downscaled left eye from the live immersive frame. It needs a page in immersion and costs the wearer about a millisecond of one frame. A page frame without proof of its flat-colour check, or one found flat, is never reported as captured; auto then asks the device. maxWidth 160-640 (default 480); quality 0.3-0.95 (default 0.6); waitMs 500-10000 (default 4000) before falling back. device: reads the headset\'s composited display over adb, both eyes with the room, the spatial menu and system UI. It is silent, sends no input, costs no frames and works outside immersion. It needs Developer Mode, one USB pairing and adb on this Mac, and takes about 1 s over USB or 4.5 s over Wi-Fi. maxWidth up to 2048 (default 1600; menu text is unreadable below about 1000). savePath must be an absolute .jpg, .jpeg or .png path; the saved extension changes if needed to match the actual JPEG or PNG bytes, and the result gives the real path and MIME type. Without a path the file goes to the system temporary directory. A headset out of immersion, a Mac with no adb, or a headset asleep or off the wearer\'s head returns a plain explanation rather than an error. The result names the source that made the image. A device capture also reports browser: "anr" means Quest Browser\'s "isn\'t responding" dialog is up, which dims the view every ten seconds and pauses tours; manage_companion action="recover-browser" clears it. "unknown" means this Mac has no debugging cable. The image stays on this Mac and carries no coordinates, tokens or pairing material.',
    inputSchema:captureHeadsetViewSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},_meta:{},
  },async(input:CaptureHeadsetViewInput)=>{
    await hostBuildReady;
    const savePath=input.savePath;
    if(savePath!==undefined && (!isAbsolute(savePath) || !/\.(?:jpe?g|png)$/iu.test(savePath)))
      throw Error('savePath must be an absolute path ending in .jpg, .jpeg or .png.');
    const wanted=input.source ?? 'auto';
    const captured=async(bytes:Buffer,mimeType:'image/jpeg'|'image/png',source:'page'|'device',
      shape:{width:number;height:number;views:{eye:'left'|'right'|'none';x:number;y:number;width:number;height:number}[]},extra:Record<string,unknown>)=>{
      const at=captureNow();
      const path=savePath ? savePath.replace(/\.(?:jpe?g|png)$/iu, mimeType==='image/png'?'.png':'.jpg')
        : defaultHeadsetViewPath(tmpdir(),at,(...parts)=>resolvePath(...parts),mimeType);
      await mkdir(dirname(path),{recursive:true});
      await writeFile(path,bytes);
      const published=await publishHeadsetView({bytes,mediaType:mimeType,source,at,...shape});
      return {path,at,published,structured:{captured:true,path,source,mimeType,bytes:bytes.byteLength,
        width:shape.width,height:shape.height,...extra,...(published?{bridge:published}:{})}};
    };

    let pageReason:string|undefined;
    if(wanted!=='device') {
      // The device frame is a whole 3664-wide stereo panel and stays legible
      // only well above the page's ceiling, so one `maxWidth` serves both and
      // the page's own limit is applied here rather than at the schema.
      // Freeze the requested source before any page can claim the request.
      // A source swap must not silently retarget an in-flight capture.
      const requestedView=input.sessionId!==undefined
        ?binding(input.sessionId,await current(input.sessionId)):undefined;
      const request=headsetView.request({...(requestedView?{view:{sessionId:input.sessionId!,
        sourceToken:requestedView.sourceToken,serverEpoch:requestedView.serverEpoch}}:{}),
        ...(input.maxWidth!==undefined?{maxWidth:Math.min(input.maxWidth,HEADSET_VIEW_MAX_WIDTH)}:{}),...(input.quality!==undefined?{quality:input.quality}:{})});
      const outcome=await headsetView.waitFor(request.id,input.waitMs ?? HEADSET_VIEW_WAIT_MS);
      // Replacement cancels this observation, including auto fallback. An
      // older caller must not start a second device capture beside the new one.
      if(outcome && !outcome.ok && outcome.code==='capture_superseded') return {
        content:[{type:'text' as const,text:outcome.reason}],
        structuredContent:{captured:false,source:'page',reason:outcome.code,detail:outcome.reason},
      };
      // A page frame of one flat colour is never `captured`. On
      // 2026-09-24, and twice on 2026-09-28, the page returned a black eye
      // while adb showed the structure in front of the wearer. See
      // `unlitPageFrame`. The device, which composites the room and both eyes,
      // is asked instead. The centre probe is reported, never decisive.
      const unlit=outcome?.ok?unlitPageFrame(outcome.frame):undefined;
      if(outcome?.ok && !unlit) {
        const frame=outcome.frame;
        const view={eye:frame.eye,x:0,y:0,width:frame.width,height:frame.height};
        const done=await captured(frame.data,'image/jpeg','page',{width:frame.width,height:frame.height,views:[view]},
          {sessionBound:true,sessionId:frame.sessionId,panelId:frame.panelId,sourceToken:frame.sourceToken,serverEpoch:frame.serverEpoch,
            eye:frame.eye,frameMs:frame.frameMs,readPath:frame.path,directReadable:frame.directReadable,
            ...(frame.probeLit!==undefined?{probeLit:frame.probeLit}:{}),framebuffer:frame.framebuffer,capturedAt:frame.capturedAt});
        const centre=frame.directReadable && frame.probeLit===false?' Its centre pixel read empty, so the structure is off the centre of the left eye.':'';
        return {content:[{type:'text' as const,text:`Headset ${frame.eye} eye, ${frame.width}x${frame.height}, ${frame.bytes} bytes, saved to ${done.path} as image/jpeg.${savePath && done.path!==savePath?' The requested extension was changed to match the JPEG bytes.':''} The page spent ${frame.frameMs} ms inside the immersive frame taking it.${centre}${done.published?' Published to the Claude Science bridge.':''}`},
          {type:'image' as const,data:frame.data.toString('base64'),mimeType:'image/jpeg' as const}],
          structuredContent:done.structured};
      }
      let outdatedFrame:string|undefined;
      if(unlit && !unlit.color && outcome?.ok && expectedHostBuild()) {
        try {
          const commands=(await current(outcome.frame.sessionId)).attachment.commands, sent=commands.pageBuildOf(outcome.frame.panelId);
          if(commands.surfaceOf(outcome.frame.panelId)==='companion' && sent!==expectedHostBuild()) outdatedFrame=outdatedPageNote(sent);
        } catch { /* The panel changed before this capture finished. */ }
      }
      pageReason=unlit ? unlit.reason+(outdatedFrame?`. ${outdatedFrame}`:'')
        : outcome && !outcome.ok ? outcome.reason : 'no companion page answered within the wait';
      if(wanted==='page') return {content:[{type:'text' as const,text:unlit
        ? `The page's frame was not saved as the wearer's view: ${pageReason.replace(/[.!?]+$/u,'')}. ${unlit.color?'Either the structure is outside the wearer\'s left eye, or the page read the frame before drawing it. ':''}Ask again with source "device" to see what the wearer sees.`
        : `The page could not take a snapshot: ${pageReason}. Open the companion page on the headset and enter immersion, then ask again.`}],
        structuredContent:{captured:false,source:'page',reason:unlit?unlit.color?'unlit_frame':'frame_unverified':outcome?'capture_failed':'no_answer',detail:pageReason,
          ...(unlit?{flatColor:unlit.color}:{}),...(outcome?.ok && outcome.frame.probeLit!==undefined?{probeLit:outcome.frame.probeLit}:{})}};
    }

    // The headset's own composited display buffer, over a debugging
    // connection. It shows the passthrough room, both eyes and the system UI
    // that the page's WebGL read cannot see, so it is also the answer when the
    // wearer is not in immersion at all.
    // The same cable can say why the picture looks like that.
    // A blurred or dimmed frame and a wedged browser are indistinguishable in
    // pixels, so the reason is read alongside the frame rather than guessed
    // from it. `unknown` is carried too, so a caller can tell "the browser is
    // fine" from "this Mac cannot ask".
    const device=await captureDeviceView({...(input.maxWidth!==undefined?{maxWidth:input.maxWidth}:{}),hooks:deviceHooks});
    const health=await browserHealth();
    const healthLine=browserHealthLine(health);
    const browser={browser:health.browser,...(health.since?{since:health.since}:{}),
      ...(health.evidence.length?{evidence:health.evidence}:{}),...(health.reason?{reason:health.reason}:{})};
    if(!device.ok) {
      const text=pageReason
        ? `Neither source produced a still. The page said: ${pageReason}. The device said: ${device.reason}`
        : `The device could not take a still: ${device.reason}`;
      return {content:[{type:'text' as const,text:health.browser==='anr'?`${text} ${healthLine}`:text}],
        structuredContent:{captured:false,source:'device',reason:'device_unavailable',detail:device.reason,browser,
          ...(pageReason?{pageDetail:pageReason}:{})}};
    }
    const done=await captured(device.bytes,device.mimeType,'device',
      {width:device.width,height:device.height,views:[{eye:'none',x:0,y:0,width:device.width,height:device.height}]},
      // The serial is deliberately left out: over Wi-Fi adb it is the headset's
      // address on the local network, and nothing here needs it.
      {sessionBound:false,eye:'none',deviceMs:device.ms,deviceWire:device.wire,browser,...(pageReason?{pageDetail:pageReason}:{})});
    return {content:[{type:'text' as const,text:`Headset display buffer, both eyes with passthrough, ${device.width}x${device.height}, ${device.bytes.byteLength} bytes, saved to ${done.path} as ${device.mimeType} in ${device.ms} ms.${savePath && done.path!==savePath?' The requested extension was changed to match the image bytes.':''}${pageReason?` The in-page capture was tried first and said: ${pageReason}.`:''}${health.browser==='anr'?` ${healthLine}`:''}${done.published?' Published to the Claude Science bridge.':''}`},
      {type:'image' as const,data:device.bytes.toString('base64'),mimeType:device.mimeType}],
      structuredContent:done.structured};
  });
  // Why the page did what it did, which neither a still nor a command receipt
  // can say. Like `capture_headset_view` this is a model-side tool with no
  // session binding and no app visibility, and it is absent from both network
  // allowlists: the Mac can question the headset's browser, never the reverse.
  registerAppTool(server,'stereo_structure.read_headset_browser',{
    title:'Read the headset browser\'s own state and console',
    description:'Ask Quest Browser\'s debugger what the page is actually doing, over the same adb cable the device capture uses. Returns the page it is on, whether the document is visible, whether WebXR is available, whether an immersive session is running and in which blend mode, the last tour, voice and toolbar diagnostics the page recorded, which debug hooks are installed, and the console: everything the page has logged since it loaded, plus uncaught exceptions and the network and security failures the page never logged itself, which is where a blocked mixed-content fetch or a refused certificate on the LAN host shows up. Use it when a still shows something wrong and you need the reason, when the wearer says a control did nothing, or when a command was refused and you cannot tell whether the page ever saw it. It reads and never writes: it does not navigate, click, reload, speak, or call any page hook that changes what the wearer sees, and it costs the wearer no frames. It needs Developer Mode, one USB pairing, adb on this Mac, and `adb forward tcp:<port> localabstract:chrome_devtools_remote` already run; without those it returns a plain sentence naming what was missing rather than an error. One limit is worth knowing: Quest Browser freezes every tab that is not the one the wearer is looking at, and a frozen tab accepts the connection and then answers nothing, so this reports the visible tab or says the tab is asleep. Quest Browser\'s certificate warning in front of the share is reported as certificateWarning, with the steps for the person. target names one tab by id or by part of its address when the wearer has more than one open. consoleMs (200-5000, default 1200) is how long to collect the replayed console backlog. Page addresses, pairing fragments, page keys, bearer tokens and inline data URIs are redacted out of everything this returns.',
    inputSchema:{
      target:z.string().min(1).max(200).optional().describe('One tab, by debugger id or by part of its address. Omitted, the Stereofold tab the wearer is looking at.'),
      consoleMs:z.number().int().min(200).max(5_000).optional().describe('How long to collect the replayed console backlog, in milliseconds. Default 1200.'),
      port:z.number().int().min(1).max(65_535).optional().describe(`The forwarded loopback port. Default ${DEVTOOLS_PORT_ENV_KEY} or ${DEVTOOLS_DEFAULT_PORT}.`),
    },
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:false},_meta:{},
  },async(input:{target?:string;consoleMs?:number;port?:number})=>{
    const port=input.port ?? devtoolsPort(captureEnvironment());
    const transport=hooks.headsetDevtools ?? nodeDevtoolsTransport();
    // The certificate warning carries no Stereofold title,
    // so the page picker never chooses its tab. It is looked for on its own,
    // fenced to this Mac's share when one is open.
    const share=lan.status();
    const shareOrigin=(()=>{try { return share?new URL(share.url).origin:undefined; } catch { return undefined; }})();
    const certificateOf=async()=>{
      const found=await readCertificateWarning(transport,{port,...(shareOrigin?{expectedOrigin:shareOrigin}:{}),
        ...(share?.fingerprint?{fingerprint:share.fingerprint}:{})}).catch(()=>undefined);
      return found?.read?found.warning:undefined;
    };
    let reading;
    try {
      reading=await readHeadsetBrowser(transport,
        {port,...(input.target?{wanted:input.target}:{}),...(input.consoleMs!==undefined?{consoleMs:input.consoleMs}:{})});
    } catch(error) {
      // Every way this fails is an ordinary state a reader fixes in seconds —
      // the cable out, Developer Mode off, the tunnel not forwarded, the tab
      // backgrounded — so it is a sentence, not a thrown tool error.
      const reason=(error instanceof Error?error.message:String(error)).slice(0,400);
      const certificate=await certificateOf();
      if(certificate) return {content:[{type:'text' as const,text:describeCertificateWarning(certificate)}],
        structuredContent:{read:false,port,reason,certificateWarning:certificate}};
      return {content:[{type:'text' as const,text:`The headset browser could not be read: ${reason} Check that the headset is attached, Developer Mode is on, and \`adb forward tcp:${port} localabstract:chrome_devtools_remote\` has been run.`}],
        structuredContent:{read:false,port,reason}};
    }
    const certificate=await certificateOf();
    const lines=reading.console.map(formatConsoleLine);
    const text=[...(certificate?[describeCertificateWarning(certificate)]:[]),summarizeReading(reading),
      `Tab ${reading.target.id}: ${reading.target.url}`,
      ...(reading.stateReason?[`The page threw while reporting its state: ${reading.stateReason}`]:[]),
      ...(lines.length?['','Console:',...lines.map(line=>line.slice(0,600))]:[])].join('\n');
    return {content:[{type:'text' as const,text}],
      structuredContent:{read:true,port,target:reading.target,state:reading.state,
        ...(reading.stateReason?{stateReason:reading.stateReason}:{}),console:reading.console,
        ...(certificate?{certificateWarning:certificate}:{})}};
  });
  privateTool('stereo_structure.detach_inspection',{
    title:'Detach an inspection panel',description:'App-only retirement of one panel capability. Pending commands are never retargeted. Idle panels expire after ten seconds without a heartbeat; a claimed render has a bounded two-minute completion window. reason "detailed-view" says this headset page is sending its own tab to the full Mol* viewer, and reason "loading" says it is about to load a structure and will register again once that has rendered and saved, so a later command can name where the wearer went or what the page is doing instead of printing desktop instructions. reason "hidden" is a desktop tab the browser hid; it detaches only a desktop panel of a session shared with a headset, and otherwise answers detached false.',
    inputSchema:pollInspectionSchema.omit({availability:true,spatialContext:true,xrStartup:true})
      .extend({reason:z.enum(['detailed-view','loading','hidden']).optional()}),annotations:{...mutation,idempotentHint:true},_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    // A hidden Mac tab cannot draw, so on a headset share it leaves the panel
    // list rather than being offered edits for its heartbeat grace. A Mac-only
    // session keeps the grace. See `stepAsideWhileHidden` in inspector.ts.
    if(input.reason==='hidden') {
      const {reason:_hidden,...plain}=input;
      const detached=data.attachment.shared===true && data.attachment.commands.surfaceOf(input.panelId)==='desktop'
        && data.attachment.commands.detach(plain,b);
      return result(input.sessionId,data,{detached});
    }
    return result(input.sessionId,data,{detached:data.attachment.commands.detach(input as typeof input & {reason?:'detailed-view'|'loading'},b)});
  });
  privateTool('stereo_structure.complete_inspection',{
    title:'Confirm a rendered inspection command',description:'App-only receipt after the shared renderer produces a frame. Commits only the claimed change at its expected revisions. A lost receipt can be retried; an expired or stale claim is never replayed.',
    inputSchema:completeInspectionSchema,annotations:{...mutation,idempotentHint:true},_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), b=binding(input.sessionId,data), a=data.attachment;
    if(input.phase==='admit') return result(input.sessionId,data,a.commands.admit(input,b));
    if(input.phase==='settled') return result(input.sessionId,data,a.commands.settled(input.tourCommand??input));
    if(input.tourCommand)return result(input.sessionId,data,a.commands.failTourTransition(input.tourCommand,b,input.failure!,input.failureReason));
    const scene=input.scene?validateScene(input.scene,a.catalog,a.density):undefined;
    if(scene) { validateComparisonScene(a,scene); savedLessonPlayback(scene,toursFor(a)); }
    if(scene) assertInspectionBudget({scene,comparisonSources:comparisonPayloads(a,scene)},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    const before=a.scene;
    const surface=surfaceOfPanel(a,input.panelId);
    const viewChange=a.commands.viewChangeOf(input.commandId);
    if(input.namedViewIntent&&viewChange?.kind!=='save-view') throw Error('Only a named-view capture may return an object-relative view intent.');
    if(scene&&viewChange?.kind==='save-view') a.views.assertCanCommit({commandId:input.commandId,name:viewChange.patch.name,
      ...(viewChange.patch.replaceViewId?{replaceViewId:viewChange.patch.replaceViewId}:{}),scene,
      ...(input.namedViewIntent?{namedViewIntent:input.namedViewIntent}:{})});
    const {scene:committed,capturedScene,replacement,...receipt}=a.commands.complete({...input,scene},b,a.catalog);
    let savedView;
    if(capturedScene&&viewChange?.kind==='save-view') savedView=a.views.save({commandId:input.commandId,name:viewChange.patch.name,
      ...(viewChange.patch.replaceViewId?{replaceViewId:viewChange.patch.replaceViewId}:{}),scene:capturedScene,
      ...(input.namedViewIntent?{namedViewIntent:input.namedViewIntent}:{}),inspectionRevision:a.revision});
    if(committed) {
      a.scene=committed;a.revision=receipt.command.renderedRevision!;
      a.commands.continueUtterance(receipt.command.utteranceId,input.panelId,b,{...b,inspectionRevision:a.revision});
    }
    if(receipt.command.status==='rendered' && input.tourState && a.commands.changeKindOf(input.commandId)==='tour')a.commands.reportTourState(input.panelId,input.tourState);
    // The shared history learns every rendered operation here,
    // whichever surface rendered it. An undo is not itself recorded: it drops
    // the entry it took back instead, so "undo that" twice walks backwards
    // rather than toggling one change on and off.
    if(a.history.isUndo(input.commandId)) a.history.settleUndo(input.commandId,Boolean(committed));
    else if(a.history.isRedo(input.commandId)) a.history.settleRedo(input.commandId,Boolean(committed));
    else if(committed && before) a.history.record({origin:'command',surface,
      label:a.commands.changeKindOf(input.commandId) ?? 'command',before,after:committed});
    return {...result(input.sessionId,data,{...receipt,...(savedView?{savedView:a.views.list().find(view=>view.id===savedView.id)}:{}),
      namedViews:namedViewsPayload(data)}),...(replacement?{_meta:{[PRIVATE_INSPECTION_META_KEY]:{replacement:{...replacement,
        ...(a.history.isUndo(replacement.commandId)?{historyAction:'undo'}:a.history.isRedo(replacement.commandId)?{historyAction:'redo'}:{})}}}}:{})};
  });
  registerAppResource(server,'Stereofold Inspector',INSPECTION_RESOURCE_URI,{_meta:{ui}},async()=>({contents:[{
    uri:INSPECTION_RESOURCE_URI,mimeType:RESOURCE_MIME_TYPE,text:await readInlineHtml(hooks.htmlPath),_meta:{ui},
  }]}));
  registerAppTool(server,'stereo_structure.inspect_file',{
    title:'Inspect a local mmCIF file',
    description:'Open an explicitly chosen local .cif or .mmcif file in the focused Stereofold inspector without copying coordinates through the conversation. Supply an absolute path accessible to this MCP server. For a host artifact, first resolve or export that artifact to a local file. This opens the exact coordinates, not the full live scene of another viewer; layers, annotations and camera in a separate Structure Viewer are not imported.',
    inputSchema:z.object({filePath:z.string().min(1).max(4096)}).strict(),annotations:mutation,_meta:{ui},
  },async({filePath})=>{
    if(!hooks.openVerifiedSource) throw Error('This host cannot atomically open a verified local source.');
    const selection:StructureSelection={};
    const opened=await hooks.openVerifiedSource({source:{kind:'file',path:filePath},selection,verify:text=>verifySourceSelection(text,selection)});
    const id=opened.structuredContent.sessionId,data=await current(id),structureText=data.cache.structureText;
    const sourceSha256=createHash('sha256').update(structureText,'utf8').digest('hex');
    if(data.cache.structureText!==structureText || data.attachment.catalog.source.sha256!==sourceSha256)
      throw Error('The local inspection file changed while opening.');
    data.attachment.nativeLocalFile={filePath,sourceSha256};
    return result(id,data,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true});
  });
  registerAppTool(server,'stereo_structure.inspect_scene',{
    title:'Check or open a Structure Viewer scene snapshot',
    description:'Hand off actual local Structure Viewer scene-json and selection-mmcif exports. Preferred: nativeExports with expectedRevision and the exact exportSelection:{kind:"all",objectId} used upstream; native .provenance.json sidecars are read automatically (optional explicit sidecar paths). No authored provenance file is needed. Host first reads structure.get_state and exports both artifacts from that same session with expectedRevision and the explicit all-object selection. Native metadata binds artifact digests/revision/identity policy, but does not authenticate session, object or selection scope. Legacy provenancePath remains supported. mode:check returns compatibility and explicit matching-scene/structure-only choices without opening; native input defaults to check. mode:matching-scene opens the supported single-object layer subset, including the default polymer and ligand pair, pending parsed structure/camera/selection checks. mode:structure-only deliberately opens coordinates without scene styling, camera, selections, layers or annotations. Unsupported scenes never automatically fall back. One-shot snapshot, no live synchronization; coordinate exports omit explicit bonds and bond order.',
    inputSchema:z.object({scenePath:z.string().min(1).max(4096),coordinatePath:z.string().min(1).max(4096),
      provenancePath:z.string().min(1).max(4096).optional(),nativeExports:nativeSceneExportSchema.optional(),
      mode:z.enum(['check','matching-scene','structure-only']).optional(),
    }).strict().refine(input=>Boolean(input.provenancePath)!==Boolean(input.nativeExports),'Supply exactly one of nativeExports or legacy provenancePath.'),
    annotations:mutation,_meta:{ui},
  },async input=>{
    const native=input.nativeExports?await readNativeStructureViewerExports({...input,nativeExports:input.nativeExports}):undefined;
    const bundle=native?native.bundle:await readStructureViewerSceneFiles({...input,provenancePath:input.provenancePath!});
    const sceneJson=native?native.sceneJson:bundle!.sceneJson;
    const coordinateText=native?native.coordinateText:bundle!.coordinate.text;
    const coordinateSha256=native?native.coordinateSha256:bundle!.coordinate.sha256;
    const preflight=preflightInspectionScene(sceneJson);
    if(native?.compatibilityIssues.length){
      preflight.supported=false;preflight.outcome='structure-only alternative';
      preflight.unsupportedFeatures.push(...native.compatibilityIssues);
      preflight.message='Matching scene is unsupported:\n'+preflight.unsupportedFeatures.map(reason=>'- '+reason).join('\n')+'\nStructure-only alternative: explicitly choose mode:structure-only to open coordinates without the scene.';
    }
    const choices=[{mode:'matching-scene',available:preflight.supported,provisional:true},
      {mode:'structure-only',available:true,disclosure:'Coordinates only; scene camera, style, placement, selections, annotations, maps and layers do not transfer. Explicit bonds and bond order are absent from coordinate exports.'}];
    const disclosure=native?.disclosure??'Legacy local declaration checked; no upstream receipt or live session is authenticated.';
    const mode=input.mode??(native?'check':'matching-scene');
    if(mode==='check'||mode==='matching-scene'&&!preflight.supported)
      return {content:[{type:'text' as const,text:preflight.message+'\n'+disclosure+'\nNo inspection session was opened.'}],
        structuredContent:{kind:'scene-preflight',imported:false,preflight,choices,provenanceStatus:'declared-local',disclosure}};
    if(mode==='matching-scene') {
      if(!bundle) throw Error('Matching scene has no validated coordinate identity.');
      assertInspectionBudget({sceneImport:{sceneJson:bundle.sceneJson,declaration:bundle.declaration}},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    }
    const opened=await hooks.open({structureText:coordinateText});
    const id=opened.structuredContent.sessionId;
    const data=await current(id);
    if(data.cache.structureText!==coordinateText || data.attachment.catalog.source.sha256!==coordinateSha256)
      throw Error('The imported coordinate artifact changed while opening or does not match the loaded catalog.');
    if(mode==='matching-scene') data.attachment.sceneImport={bundle:bundle!};
    return result(id,data,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true,
      handoffMode:mode,provenanceStatus:'declared-local',preflight,choices,disclosure},
      (mode==='matching-scene'?preflight.message:'Structure-only handoff: coordinates opened; no upstream scene was imported.')+' '+disclosure+' The panel still needs to load, verify and render. Check get_inspection_state before reporting it as visible.');
  });
  registerAppTool(server,'stereo_structure.inspect_lesson',{
    title:'Open a local molecular lesson',
    description:'Open a local mmCIF file with a bounded molecular lesson JSON in the Stereofold inspector and optional Quest companion. Every chapter requires explicit immersive intentions; standard-viewer desktop plans instead use the separate local planner and native structure.apply_scene tools. An optional provenance.sourceSha256 must match these exact coordinates. Optional assemblyId names a biological assembly the entry itself declares, such as "1": Mol* then builds that assembly from the entry\u2019s own operator list, so a deposited asymmetric unit becomes the complete assembly without shipping an expanded coordinate file. Omit it for the asymmetric unit. Source references remain authored metadata, not authenticated export receipts or a live link to another viewer.',
    inputSchema:z.object({filePath:z.string().min(1).max(4096),lessonPath:z.string().min(1).max(4096),
      densityPath:z.string().min(1).max(4096).optional(),
      assemblyId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional()}).strict(),
    annotations:mutation,_meta:{ui},
  },async input=>{
    const {structureText}=await readInspectionFile(input.filePath);
    const lessonManifest=parseMolecularLesson(await readBoundedJsonFile(input.lessonPath));
    const sourceSha256=createHash('sha256').update(structureText,'utf8').digest('hex');
    const density=await readLessonDensity(lessonManifest,input.densityPath);
    // A volume lesson's provenance names the MAP, because the map is what it
    // draws; an atomic lesson's names the coordinates. Checking the wrong one
    // would pass every lesson and protect neither.
    const provenanceSha256=density?density.sha256:sourceSha256;
    if(lessonManifest.provenance.sourceSha256 && lessonManifest.provenance.sourceSha256!==provenanceSha256)
      throw Error(density
        ?'The lesson provenance sourceSha256 does not match the exact local density bytes.'
        :'The lesson provenance sourceSha256 does not match the exact local coordinate bytes.');
    const lesson=molecularLessonToTour(lessonManifest);
    const opened=await hooks.open({structureText}), id=opened.structuredContent.sessionId;
    // The session is brand new and its id has not been returned to anyone, so
    // this is the only place that can bind an assembly to it.
    if(input.assemblyId) assemblyRequests.set(id,{assemblyId:input.assemblyId});
    let data:Awaited<ReturnType<typeof current>>;
    try { data=await current(id); } catch(error) { assemblyRequests.delete(id); throw error; }
    if(data.cache.structureText!==structureText) throw Error('The lesson structure changed while opening.');
    if(input.assemblyId && data.attachment.catalog.assemblyId!==input.assemblyId)
      throw Error('The inspector did not build the requested assembly.');
    assertInspectionBudget({customTour:lesson},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    data.attachment.customTour=lesson;
    // The map rides on the attachment exactly as the lesson does, and dies with
    // the same source cache, so a later plain `inspect` can never inherit it.
    if(density) data.attachment.density=density;
    return result(id,data,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true,customTourId:lesson.id,
      assemblyId:data.attachment.catalog.assemblyId,
      ...(density?{density:{bytes:density.bytes.byteLength,sha256:density.sha256,contour:density.contour}}:{}),
      atomSites:data.attachment.catalog.rows.reduce((total:number,row:any)=>total+row.atomSites.length,0)});
  });
  type CompanionWork={sourceToken:string;options:string;stage:'rendering'|'connecting';cancelled:boolean;closedByManager:boolean;settled:boolean;drawn?:string;
    expiry?:ReturnType<typeof setTimeout>;work:Promise<{answer?:any;error?:unknown}>};
  const pendingCompanionWork=new Map<string,CompanionWork>();
  /** How an agent learns the wearer is in VR without asking someone in a headset. */
  const WEARER_WAIT='read get_inspection_state until wearer.state is "in-vr" before calling anything shown. '
    +'For a handoff with human steps, check every 5–10 seconds until pairing or pairingExpiresAt; allow time for the person to complete the prompts without resending or starting a competing Manual pairing. '
    +'After pairing, or for the adb route, allow up to 60 seconds for page progress, then read manage_companion action="status" and follow its recovery steps. '
    +'Do not poll indefinitely or repeat a completed open_companion to resend a launch. If the code has expired, use manage_companion action="launch" for a fresh one. '
    +'Do not ask the person, who would have to take the headset off to answer.';
  function forgetCompanionWork(id:string,closedByManager=false) {
    const task=pendingCompanionWork.get(id);
    if(task) {task.cancelled=true;task.closedByManager=closedByManager;if(task.expiry) clearTimeout(task.expiry);pendingCompanionWork.delete(id);}
  }
  hooks.sessionEnded?.(id=>forgetCompanionWork(id));
  registerAppTool(server,'stereo_structure.open_companion',{
    title:'Connect this inspection to a browser or headset',
    description:'Share the session already open on the laptop by passing its sessionId here. When joining another host\'s session, call continue_session first and reuse its sessionId; replace its source only for a requested different structure. If no session exists, or the user explicitly wants a new or separate session, call inspect and pass the new sessionId here. For Meta Quest use {connection:"lan",headset:"meta",launch:"auto",waitForHeadsetMs:20000}; auto uses an authorized USB or remembered Wi-Fi Quest when discovery succeeds, otherwise Meta Web Launch; for Apple Vision Pro use {connection:"lan",headset:"apple",launch:"auto"}. The first call opens a Mac inspector when needed. A current authenticated headset page on the same share is reused without another launch, including a paused page; headsetPage.reused carries its actual state. Use manage_companion action="launch" for an explicit fresh launch. If drawing, sharing, or launching takes longer than this call can wait, sharePending is returned: call open_companion again with the same arguments. The same operation continues, including the draw\'s full render budget. A saved scene is shared over private Wi-Fi HTTPS; the result includes the LAN address, pairing details and launch outcome. With launch="adb", waitForHeadsetMs:20000 can confirm whether the headset page drew. For adb, allow 60 seconds for page progress. For Web Launch or Safari handoff, check state every 5–10 seconds until pairing or pairingExpiresAt; do not send a competing pairing while human prompts are pending. After a reported failure or expiry, diagnose with manage_companion action="status" and follow recovery instructions. With Web Launch the wearer presses Open. If headsetPage.certificateWarning is present, give its instruction before any Enter VR step. launch="none" only prints the address; launch requires connection="lan". The binding fields are optional; left out, the host uses current values.',
    inputSchema:implicitBinding(inspectionBindingSchema.extend({connection:z.enum(['loopback','lan','https']).default('loopback'),
      lanHost:z.string().max(64).optional(),lanPort:z.number().int().min(1024).max(65535).optional(),
      launch:companionLaunchSchema,headset:companionHeadsetSchema,
      waitForSceneMs:z.number().int().min(0).max(SOURCE_RENDER_WAIT_CEILING_MS).optional()
        .describe('How long this call waits for the draw, capped at 40 seconds. The draw keeps its own render budget; retry with the same arguments after sharePending.'),
      waitForHeadsetMs:z.number().int().min(0).max(HEADSET_PAGE_WAIT_CEILING_MS).optional()
        .describe('After a launch, wait up to this many ms for the headset page to attach and draw, so the answer says whether it did. 20000 covers a cable launch.')})),
    annotations:{...mutation,openWorldHint:true},_meta:{},
  },async input=>{
    const callStarted=Date.now();
    let data=await current(input.sessionId),b=binding(input.sessionId,data);
    const options=JSON.stringify([input.connection,input.headset,input.launch,input.lanHost??'',input.lanPort??null]);
    const pending=pendingCompanionWork.get(input.sessionId);
    const resuming=pending?.sourceToken===b.sourceToken && (pending.options===options || !pending.settled);
    const savedBeforeRetry=Boolean(resuming && data.attachment.scene);
    if(resuming && pending.options!==options)
      throw Error('An earlier open_companion request is still finishing with different connection options. Call again when it is done.');
    if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken
      || (!resuming && (input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==b.inspectionRevision)))
      throw Error('Load and save the intended panel, then read its current inspection state before connecting.');
    // Only the LAN companion has an address a headset can reach and a one-time
    // code to carry. Loopback is this Mac alone, and the relay already returns
    // its own launch link because its capability cannot ride in a fragment.
    if(input.launch!=='none' && input.connection!=='lan')
      throw Error('launch is only available with connection="lan". Connect over private Wi-Fi first.');
    if(input.headset!=='auto' && input.connection!=='lan')
      throw Error('A named headset needs a LAN connection. Use connection="lan", headset="meta", launch="web" for Meta Quest, or connection="lan", headset="apple", launch="auto" for Apple Vision Pro.');
    // The headset loads the saved scene, so a session nothing has drawn yet
    // gets one drawn here first. The page's save moves the revisions on from
    // the binding checked above, and only the source must still be the same.
    let task=pending;
    if(!resuming) {
      if(pending) forgetCompanionWork(input.sessionId);
      task={sourceToken:b.sourceToken,options,stage:data.attachment.scene?'connecting':'rendering',cancelled:false,closedByManager:false,settled:false,work:Promise.resolve({})};
      const active=task;
      const ensureActive=async()=>{
        if(active.cancelled) throw Error('The companion connection was closed while it was starting. Call open_companion again to reconnect.');
        const live=await current(input.sessionId);
        if(active.cancelled || binding(input.sessionId,live).sourceToken!==active.sourceToken)
          throw Error('The companion connection was closed or the structure changed while connecting. Call open_companion again.');
      };
      task.work=(async()=>{
        let drawn:string|undefined;
        if(!data.attachment.scene) {
          drawn=await renderSceneOnThisMac(input.sessionId,renderBudgetMsFor(data),renderBudgetMsFor(data));
          await ensureActive();
          active.drawn=drawn;
          data=await current(input.sessionId);
          const saved=binding(input.sessionId,data);
          if(saved.serverEpoch!==b.serverEpoch || saved.sourceToken!==b.sourceToken || !data.attachment.scene)
            throw Error('The structure changed while connecting. Try again.');
          b=saved;
        }
        active.stage='connecting';
        const answer=(extra:Record<string,unknown>,text?:string)=>{
          if(active.cancelled) throw Error('The companion connection was closed while it was starting. Call open_companion again to reconnect.');
          const response=result(input.sessionId,data,extra,text);
          if(drawn) response.content[0].text=`${drawn} ${response.content[0].text}`;
          return response;
        };
        const link=await companion.open(input.sessionId,b.sourceToken);
        await ensureActive();
        // This asynchronous listener setup applies to loopback as well as LAN and
        // tunnel connections, so every return path must reject a replaced source.
        if(binding(input.sessionId,data).sourceToken!==b.sourceToken)
          throw Error('The structure changed while connecting. Try again.');
        if(input.connection==='lan') {
          // The LAN listener is one host-wide resource. Letting a second session
          // reuse it would clear the first session's paired clients and move
          // ownership, after which manage_companion refuses that session and it can
          // no longer close or revoke the listener it started.
          if(lanOwner && lanOwner.sessionId!==input.sessionId) {
            if(lan.status()) throw Error('A different inspection session owns this Mac’s LAN companion. Stop its sharing from that session with manage_companion action="close", or wait for it to expire, before connecting this one.');
            lanOwner=undefined;
          }
          await questLink.close();
          await ensureActive();
          const previousHeadset=lanOwner?.sessionId===input.sessionId?lanOwner.headset:undefined;
          const previousShare=lanOwner?.sessionId===input.sessionId && lanOwner.sourceToken===b.sourceToken?lan.status():undefined;
          const local=await lan.open({url:link.url,host:input.lanHost,port:input.lanPort});
          try {await ensureActive();} catch(error) {if(!active.closedByManager) await lan.close();throw error;}
          lanOwner={sessionId:input.sessionId,sourceToken:b.sourceToken,
            headset:input.headset==='auto'?previousHeadset??'auto':input.headset};
          markShared(input.sessionId,data.attachment,true);
          // Offering this scene lets another assistant's continue_session join this
          // session instead of opening a second share on this port. Offering never
          // attaches and never replaces a live owner, and the share stands whatever
          // it does.
          scene.noteSession(input.sessionId);
          await scene.offer().catch(()=>false);
          await ensureActive();
          if(input.launch==='none') return answer({companion:{...local,connection:'lan'}});
          // Reuse the page that actually polled through this same LAN share.
          // A merely attached panel, an old source or a paired device without a
          // current page cannot establish this. A paused page retains its tab
          // and placement; sending another launch creates a competing tab.
          data=await current(input.sessionId);
          await ensureActive();
          b=binding(input.sessionId,data);
          const reusedPage=data.attachment.commands.wearerPage(b);
          const live=lan.status();
          const pageClient=live?.clients.find(client=>client.id===panelLanClients.get(reusedPage.panelId??''));
          const families=[pageClient?.deviceClass,
            reusedPage.panelId?reportedPanelDeviceClass(new Set([reusedPage.panelId])):undefined]
            .map(device=>device==='vision-pro'?'apple':device==='quest2'||device==='quest3'||device==='quest-pro'?'meta':undefined)
            .filter(family=>family!==undefined);
          // A requested or attempted launch is not proof of where this page is.
          // Named targets require positive evidence from this paired page, and
          // conflicting browser/session evidence must fall through to launch.
          const targetMatches=input.headset==='auto' || families.length>0 && families.every(family=>family===input.headset);
          const reusable=previousShare?.url===local.url && live && reusedPage.panelId
            && targetMatches
            && reusedPage.state!=='unknown' && reusedPage.state!=='no-page'
            && data.attachment.commands.summary(b).panels.some(panel=>panel.panelId===reusedPage.panelId
              && panel.surface==='companion' && panel.current
              && (panel.availability==='ready' || panel.availability==='busy' && reusedPage.state==='paused'))
            && (!expectedHostBuild() || data.attachment.commands.pageBuildOf(reusedPage.panelId)===expectedHostBuild())
            && pageClient && previousShare.clients.some(previous=>previous.id===pageClient.id)
            && presenceNow()-Date.parse(pageClient.lastUsedAt)<CLIENT_ACTIVE_MS;
          if(reusable) {
            const stateNote=reusedPage.state==='in-vr'?'It is presenting the immersive view and drawing frames.'
              :reusedPage.state==='paused'?wearerPausedNote(reusedPage)
              :reusedPage.state==='entering-vr'?`It has started immersion; ${WEARER_WAIT}`
              :`It is waiting for Enter VR. Tell the person once to tap Enter VR, then ${WEARER_WAIT}`;
            return answer({companion:{...local,connection:'lan'},
              launch:{mode:input.launch,opened:false,reused:true,message:'The current headset page was reused; no launch was sent.'},
              headsetPage:{drew:reusedPage.state!=='paused',reused:true,waitedMs:0,...reusedPage}},
              `The current headset page was reused; no launch was sent. ${stateNote}`);
          }
          // A headset page already attached before this launch proves nothing
          // about it, unless the launch kept that live tab instead of opening one.
          const known=new Set(data.attachment.commands.summary(b).panels.filter(panel=>panel.surface==='companion').map(panel=>panel.panelId));
          // The launched link carries the code in its fragment, but the link put
          // back in the result is the code-free one: the code already appears once
          // here as companion.pairingCode and must not be repeated.
          const launched=await launchToHeadset(input.launch,local.url,local.pairingCode,lanOwner.headset);
          await ensureActive();
          // A started Web Launch and a Vision Pro handoff list the
          // person's steps; the agent relays them once and then waits on the
          // wearer's state.
          if(!input.waitForHeadsetMs || launched.route!=='adb' || launched.blocked || launched.reason==='failed')
            return answer({companion:{...local,connection:'lan'},launch:launched},
              (launched.link && launched.reason==='started') || launched.target==='apple'
                ?`${launched.message} Relay these steps once, then ${WEARER_WAIT}`:launched.message);
          // Waiting here saves the agent a poll and a model turn after every launch.
          const started=Date.now(), kept=launched.tabHygiene?.launch===false;
          const pageWaitMs=Math.min(input.waitForHeadsetMs,HEADSET_PAGE_WAIT_CEILING_MS);
          // The wait ends when the page is open. A page attaches only
          // after it has drawn the scene, and one that is busy for a moment is
          // still open; entering VR is the wearer's step, read from wearer.state.
          const drew=pageWaitMs>0 && await awaitPanels(input.sessionId,pageWaitMs,panels=>panels.some(panel=>panel.surface==='companion'
            && panel.current && panel.availability!=='unsaved' && (kept || !known.has(panel.panelId))));
          await ensureActive();
          const seconds=((Date.now()-started)/1000).toFixed(1), waitedMs=Date.now()-started;
          // A page that never drew may be behind Quest
          // Browser's certificate warning, which only the person can pass. The
          // warning's steps then come first, and the launch sentence loses its
          // Enter VR step, because the page with that button has not loaded.
          const worn=launched.headset?.worn;
          const certificate=drew||launched.headset===undefined?undefined:await headsetCertificateWarning(local.url,worn,local.fingerprint);
          await ensureActive();
          data=await current(input.sessionId);
          // Attaching is what the page did, and all this answer
          // knows. Whether anyone sees the view is for wearer.state to say.
          const page=data.attachment.commands.wearerPage(binding(input.sessionId,data));
          const opened=`The headset page attached ${seconds} s after the launch. `
            +(page.state==='in-vr'?'It is presenting the immersive view and drawing frames.'
              :page.state==='entering-vr'?`It has started the immersive view and has not drawn a frame the wearer can see yet; ${WEARER_WAIT}`
              :page.state==='paused'?wearerPausedNote(page)
              :`It is waiting for Enter VR. Tell the person once to tap Enter VR, then ${WEARER_WAIT}`);
          return answer({companion:{...local,connection:'lan'},launch:launched,headsetPage:{drew,waitedMs,...(certificate?{certificateWarning:certificate}:{})}},
            certificate?`${describeCertificateWarning(certificate)} ${launched.message.replace(` · ${enterVrStep(worn)}.`,'.')} `
              +`The headset page did not attach and draw within ${seconds} s. Once the user has chosen Proceed, read get_inspection_state for wearer.state before calling anything shown.`
            :`${launched.message} `+(drew?opened
              :`The headset page did not attach and draw within ${seconds} s. Check that the headset is awake, on this Mac's Wi-Fi, and showing the page in its browser; `
                +'companion.url and companion.pairingCode in this result still work by hand. Read get_inspection_state for wearer.state before calling anything shown.'));
        }
        if(input.connection==='https') {
          // Choosing another transport must retire this session's own LAN listener.
          // Left running it keeps a private HTTPS port open under an owner that is
          // no longer sharing over it.
          if(lanOwner?.sessionId===input.sessionId) {await lan.close();lanOwner=undefined;}
          await ensureActive();
          const secure=await questLink.open(link);
          // Source replacement while the relay starts must not publish a stale link.
          try {
            await ensureActive();
          } catch(error) {await questLink.close();throw error;}
          markShared(input.sessionId,data.attachment,true);
          // The relay bearer travels inside this query value, so opening the launch
          // link shows it to Meta. That is Meta's contract, not a choice here: the
          // wearer opens this link in a desktop browser and Meta's servers run the
          // device-selection flow and forward the exact target string to the
          // headset, so a fragment would never leave the desktop browser and the
          // headset would receive a URL with no capability. The tokenized relay URL
          // is returned separately as companion.url for a headset that can be
          // handed the address directly, and the relay link expires on its own.
          const launch=new URL('https://www.oculus.com/open_url/');launch.searchParams.set('url',secure.url);
          return answer({companion:{...secure,connection:'https',webLaunchUrl:launch.href}});
        }
        // Loopback is also a transport switch: retire this session's LAN listener.
        if(lanOwner?.sessionId===input.sessionId) {await lan.close();lanOwner=undefined;}
        await ensureActive();
        markShared(input.sessionId,data.attachment,true);
        // Discovery uses the scene service's local bearer and owner checks;
        // it does not depend on the companion transport or grant page access.
        scene.noteSession(input.sessionId);
        await scene.offer().catch(()=>false);
        await ensureActive();
        return answer({companion:{...link,connection:'loopback',adbReverse:`adb reverse tcp:${link.port} tcp:${link.port}`}});
      })().then(answer=>({answer}),error=>({error}));
      pendingCompanionWork.set(input.sessionId,task);
      void task.work.then(()=>{
        active.settled=true;
        if(pendingCompanionWork.get(input.sessionId)!==active) return;
        active.expiry=setTimeout(()=>{if(pendingCompanionWork.get(input.sessionId)===active) pendingCompanionWork.delete(input.sessionId);},120_000);
        active.expiry.unref?.();
      });
    }
    const callWaitMs=task!.stage==='rendering'
      ?Math.min(OPEN_COMPANION_CALL_CEILING_MS,HOST_TOOL_WAIT_CEILING_MS,input.waitForSceneMs??HOST_TOOL_WAIT_CEILING_MS)
      :OPEN_COMPANION_CALL_CEILING_MS;
    const remaining=Math.max(0,callWaitMs-(Date.now()-callStarted));
    let timer:ReturnType<typeof setTimeout>|undefined;
    const outcome=await Promise.race([task!.work,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),remaining);})]);
    if(timer) clearTimeout(timer);
    if(task!.cancelled) throw Error('The companion connection was closed while it was starting. Call open_companion again to reconnect.');
    if(!outcome) return result(input.sessionId,data,{sharePending:{status:task!.stage,waitedMs:Date.now()-callStarted,
      renderBudgetMs:renderBudgetMsFor(data),nextCall:'open_companion'}},
      task!.stage==='rendering'
        ?'This pending result is normal. The Mac inspector is still drawing and saving this scene. Call open_companion again with the same arguments; it will use this draw instead of starting another. Nothing has been shared with the headset yet.'
        :'This pending result is normal. The companion share or headset launch is still starting. Call open_companion again with the same arguments; it will use this operation instead of starting another.');
    if(pendingCompanionWork.get(input.sessionId)===task) {if(task!.expiry) clearTimeout(task!.expiry);pendingCompanionWork.delete(input.sessionId);}
    if(outcome.error) throw outcome.error;
    if(savedBeforeRetry && task!.drawn && outcome.answer?.content?.[0]?.text?.startsWith(`${task!.drawn} `))
      outcome.answer.content[0].text=outcome.answer.content[0].text.slice(task!.drawn.length+1);
    return outcome.answer;
  });
  /**
   * Gather the six things, without asking anything twice.
   *
   * Every fact here is already held by this process or one cheap call away.
   * The point is not new information, it is that no one route reported all of
   * it: the panel state lived in `get_inspection_state`, the pairing in
   * `manage_companion`, the microphone and the reply voice only in a startup
   * line on stderr that a headset wearer never sees, and the agent's own
   * presence nowhere at all.
   */
  const PANEL_HEADSET_CHECK_MS=10_000;
  let panelHeadsetCheck:{at:number;value:ReadinessFacts['headset']}|undefined;
  let panelHeadsetChecking:Promise<ReadinessFacts['headset']>|undefined;
  async function headsetReadiness(check:'fresh'|'cached'):Promise<ReadinessFacts['headset']> {
    const at=presenceNow();
    if(check==='cached' && panelHeadsetCheck && at-panelHeadsetCheck.at<PANEL_HEADSET_CHECK_MS)
      return panelHeadsetCheck.value;
    const read=()=>readHeadsetDebugging({env:captureEnvironment(),
      ...(deviceHooks.exists?{exists:deviceHooks.exists}:{}),run:deviceHooks.run});
    if(check==='cached') {
      // A heartbeat never waits for adb: the cable check can take seconds, and
      // this runs on the return path of a poll that may already have claimed a
      // command. Start one check, answer with the last value meanwhile.
      if(!panelHeadsetChecking) {
        const pending=read();
        panelHeadsetChecking=pending;
        pending.then(value=>{panelHeadsetCheck={at:presenceNow(),value};},()=>{})
          .finally(()=>{if(panelHeadsetChecking===pending) panelHeadsetChecking=undefined;});
      }
      return panelHeadsetCheck?.value ?? {checked:false};
    }
    const value=await read();
    panelHeadsetCheck={at:presenceNow(),value};
    return value;
  }
  /** Readiness for a panel response: never lets a heartbeat fail. */
  async function panelReadiness(data:Awaited<ReturnType<typeof current>>,sessionId:string) {
    try { return assembleReadiness(await readinessFacts(data,sessionId,false,'cached')); }
    catch { return undefined; }
  }
  async function readinessFacts(data:Awaited<ReturnType<typeof current>>,sessionId:string,speechCheck:boolean,headsetCheck:'fresh'|'cached'='fresh'):Promise<ReadinessFacts> {
    // The reply voice is the one capability that cannot be proved by reading a
    // path: the OAuth route is a network call. So it is proved only when the
    // caller says it is about to depend on it, and reported as unproved
    // otherwise rather than as working.
    let dryRun:'passed'|'failed'|'skipped'='skipped';
    let replyDetail=replyAudio.describe();
    if(speechCheck && replyAudio.enabled && replyAudio.ready) {
      try { dryRun=await replyAudio.synthesize('Ready')?'passed':'failed'; }
      catch(error) { dryRun='failed'; replyDetail=error instanceof Error?error.message:'the reply voice route threw.'; }
    }
    // The panel receives this on its existing heartbeat. Cache only the cable
    // check so a configured headset does not turn that heartbeat into one new
    // process every second. An explicit get_readiness call still checks now.
    const facts=cachedReadinessFacts(data,sessionId);
    const headset=visionProStatus(facts.share)?{checked:false}:await headsetReadiness(headsetCheck);
    return {...facts,replies:{...facts.replies,detail:replyDetail,dryRun},headset};
  }
  /** Synchronous host facts shared by compact state and full readiness; never spawns a probe. */
  function cachedReadinessFacts(data:Awaited<ReturnType<typeof current>>,sessionId:string):Omit<ReadinessFacts,'headset'> {
    const b=binding(sessionId,data),summary=data.attachment.commands.summary(b);
    const live=lanOwner?.sessionId===sessionId?lan.status():undefined;
    const expiredAt=live?undefined:lan.expiredAt();
    const at=presenceNow();
    const share=lanShareFacts(sessionId,summary.panels,live,at);
    return {
      hasScene:Boolean(data.attachment.scene),
      panels:summary.panels.map((panel:any)=>({surface:panel.surface,availability:panel.availability,current:panel.current})),
      ...(share?{share}:{}),
      ...(expiredAt?{shareExpiredAt:expiredAt}:{}),
      agentAttached:agentAttached(),
      ...(agentListenedAt===undefined?{}:{listenAgeMs:Math.max(0,at-agentListenedAt)}),
      ...(agentActedAt===undefined?{}:{actionAgeMs:Math.max(0,at-agentActedAt)}),
      listenWindowMs:AGENT_PRESENCE_WINDOW_MS,
      transcription:{enabled:transcriber.enabled,ready:transcriber.ready,route:transcriber.route,
        detail:transcriber.readinessDetail?.()??transcriber.describe(),missing:transcriber.missing(),captureObserved:transcriber.captureObserved?.(sessionId)??false},
      replies:{enabled:replyAudio.enabled,ready:replyAudio.ready,detail:replyAudio.describe(),dryRun:'skipped'},
      checkedAt:new Date(at).toISOString(),
    };
  }

  function reportedPanelDeviceClass(relevantPanels:ReadonlySet<string>):string|null|undefined {
    let reported:string|undefined;
    if(relevantPanels.size) {
      let cursor=0,latestEvent: {kind:string;detail:Record<string,unknown>}|undefined;
      for(;;) {
        const page=diagnostics.read({sinceSequence:cursor,limit:500});
        for(const entry of page.entries) if(relevantPanels.has(entry.clientId) && (entry.kind==='session-start'||entry.kind==='session-end')) latestEvent=entry;
        if(!page.more || page.cursor===cursor) break;
        cursor=page.cursor;
      }
      // Ended XR evidence must not fall back to a pairing User-Agent or mask
      // another current peer that is still presenting.
      if(latestEvent?.kind==='session-end') return null;
      if(latestEvent?.kind==='session-start' && typeof latestEvent.detail.deviceClass==='string') reported=latestEvent.detail.deviceClass;
    }
    return reported;
  }

  function lanShareFacts(sessionId:string,panels:ReadonlyArray<{panelId:string;surface:string;current:boolean}>,
    live:ReturnType<typeof lan.status>,at=presenceNow()):ReadinessFacts['share'] {
    if(!live || lanOwner?.sessionId!==sessionId) return undefined;
    const currentPanels=new Set(panels.filter(panel=>panel.current&&panel.surface==='companion').map(panel=>panel.panelId));
    const pairedIds=new Set(live.clients.map(client=>client.id));
    for(const [panelId,clientId] of panelLanClients) if(!pairedIds.has(clientId)) panelLanClients.delete(panelId);
    const peers=[...live.clients].sort((a,b)=>b.lastUsedAt.localeCompare(a.lastUsedAt)||b.createdAt.localeCompare(a.createdAt))
      .map(client=>{
        const pairedPanels=[...panelLanClients].filter(([,clientId])=>clientId===client.id).map(([id])=>id);
        const currentPairedPanels=pairedPanels.filter(id=>currentPanels.has(id));
        const relevantPanels=new Set(currentPairedPanels.length?currentPairedPanels:pairedPanels.slice(-1));
        return {client,reported:reportedPanelDeviceClass(relevantPanels),
          connected:Boolean(currentPairedPanels.length&&at-Date.parse(client.lastUsedAt)<CLIENT_ACTIVE_MS)};
      });
    const latest=peers.find(peer=>peer.connected&&peer.reported!==null)??peers[0];
    const headset=latest&&latest.reported!==null?pairedSessionHeadset(lanOwner.headset,[latest.client],latest.reported):undefined;
    const connected=latest?.connected??false;
    return {expiresAt:live.sessionExpiresAt,pairedDevices:live.clients.length,
      headsetsPaired:Math.max(live.clients.filter(client=>client.deviceClass!=='unknown'&&client.deviceClass!=='hand-only').length,headset?1:0),
      target:lanOwner.headset,connected,...(headset?{headset}:{})};
  }

  type PanelSummary=ReturnType<Awaited<ReturnType<typeof current>>['attachment']['commands']['summary']>['panels'][number];
  /** Whether `check` passes for this session within the wait, read every 250 ms. */
  async function awaitPanels(sessionId:string, waitMs:number, check:(panels:PanelSummary[],data:Awaited<ReturnType<typeof current>>)=>boolean) {
    const deadline=Date.now()+waitMs;
    for(;;) {
      try {
        const data=await current(sessionId);
        if(check(data.attachment.commands.summary(binding(sessionId,data)).panels,data)) return true;
      } catch { /* A session still hydrating reads as not yet saved. */ }
      if(Date.now()>=deadline) return false;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  /** Whether a page saved this session's scene and a desktop panel is current and ready, within the wait. */
  async function awaitSavedScene(sessionId:string, waitMs:number) {
    return awaitPanels(sessionId,waitMs,(panels,data)=>Boolean(data.attachment.scene)
      && panels.some(panel=>panel.current && panel.availability==='ready' && panel.surface==='desktop'));
  }
  /**
   * When a panel last fetched this session's coordinates. A host that mounts
   * its own panel (Codex's inline one) or a tab opened earlier fetches them
   * before it saves, so open_companion waits for that panel instead of putting
   * a second renderer in this Mac's browser.
   */
  const panelHydratedAt=new Map<string,number>();
  function notePanelHydration(sessionId:string) {
    panelHydratedAt.delete(sessionId);
    panelHydratedAt.set(sessionId,Date.now());
    while(panelHydratedAt.size>64) panelHydratedAt.delete(panelHydratedAt.keys().next().value!);
  }
  /** Serve the inspector for a session and, when asked, open it in this Mac's browser. */
  async function openInspectorTab(sessionId:string, open:boolean) {
    const link=await panel.open(sessionId);
    // The launched address carries the host-opened stamp, so the tab closes
    // itself once this server is gone; the printed one is the plain address.
    const attempt=open?await openOnThisMac(markHostOpenedUrl(link.url)):undefined;
    return {link,attempt};
  }
  /**
   * Draw and save a session's scene on this Mac so open_companion can share
   * it in the same call. A host that mounts no panel of its own, such as
   * terminal Claude Code, otherwise needed open_inspector, a poll and a second
   * open_companion before the headset could load anything. Returns the
   * sentence for the answer; throws with what to do when nothing saved the
   * scene in time.
   */
  async function renderSceneOnThisMac(sessionId:string, waitMs:number, loadingMs:number):Promise<string> {
    const started=Date.now(), hydrated=panelHydratedAt.get(sessionId);
    const elapsed=()=>`${((Date.now()-started)/1000).toFixed(1)} s`;
    const budget='The draw reached its render budget';
    const saved=()=>awaitPanels(sessionId,waitMs,(_panels,data)=>Boolean(data.attachment.scene));
    // A panel that fetched the coordinates within this structure's render
    // budget is taken to be still drawing it.
    if(hydrated!==undefined && started-hydrated<loadingMs) {
      if(!await saved())
        throw Error(`The panel loading this session did not save the scene within ${Math.round(waitMs/1000)} s, so nothing was shared. `
          +`Keep that panel open, or call open_inspector to draw it in this Mac's browser, then call open_companion again. ${budget}.`);
      return `The panel already loading this session drew and saved the scene in ${elapsed()}.`;
    }
    const {link,attempt}=await openInspectorTab(sessionId,true);
    const byHand=`open ${link.url} in a browser on this Mac, including the part after the # sign, leave that tab open, and call open_companion again`;
    if(attempt && !attempt.opened && (attempt.reason==='failed'||attempt.reason==='not-macos'))
      throw Error(`No scene is saved yet, and this Mac's browser could not open the inspector to draw one`
        +`${attempt.reason==='failed'?` (${attempt.detail})`:''}. Nothing was shared. To connect, ${byHand}.`);
    if(!await saved())
      throw Error(`No panel drew and saved the scene within ${Math.round(waitMs/1000)} s, so nothing was shared. To connect, ${byHand}. ${budget}.`);
    return `No scene was saved, so the inspector opened in this Mac's browser (${link.url}) and drew and saved it in ${elapsed()}; leave that tab open.`;
  }
  const openInspectorSchema=z.object({sessionId:sessionIdSchema,
    open:z.boolean().optional().describe('Open the address in this Mac\'s default browser. Default true; false only returns the address.'),
    waitForSceneMs:z.number().int().min(0).max(SOURCE_RENDER_WAIT_CEILING_MS).optional()
      .describe('Wait for a saved scene and a current ready desktop panel. Each call waits at most 40000 ms even if a larger value is requested. Without a wait, read readiness and poll get_inspection_state.')});
  registerAppTool(server,'stereo_structure.open_inspector',{
    title:'Render the inspector panel in a browser on this Mac',
    description:'Serve the inspector panel for one session from this Mac on loopback and open it in the default browser. This is for a host that mounts no MCP App panel of its own, such as terminal Claude Code: without a rendered panel no scene is saved, get_readiness reports structure missing, and open_detailed_view refuses the session. open_companion opens this panel itself when no scene is saved, so a headset request needs only inspect then open_companion. First open the structure with inspect, inspect_file, inspect_lesson, inspect_scene or inspect_experience and pass the returned sessionId. The page mounts the same inspector an MCP Apps host mounts and reaches this server over loopback, so it renders the structure, saves the scene through sync_inspection and appears in get_inspection_state as a desktop panel. Pass waitForSceneMs:40000 and the answer says whether the scene was saved and a desktop panel is ready; without it, poll get_inspection_state for hasScene true and a current ready panel before connecting a headset or opening the detailed view. Returns a loopback address whose fragment is the page key: give the user the whole address, and where nothing opened the user pastes it into a browser on this Mac. open defaults to true and works on macOS only; a failed launch is reported in the result and never fails the call. Calling it again for the same session returns the same address. The tab must stay open while the session runs. Its page key lives as long as the session: when the session expires or this server stops, the key is forgotten, the loopback listener closes and the tab closes itself.',
    inputSchema:openInspectorSchema,annotations:{...mutation,openWorldHint:true},_meta:{},
  },async input=>{
    // Refuses an unknown or expired session before a page key is made for it.
    await current(input.sessionId);
    const {link,attempt}=await openInspectorTab(input.sessionId,input.open!==false);
    const opening=attempt===undefined?'Open the whole address in a browser on this Mac, including the part after the # sign, which is this page key. '
      :attempt.reason==='started'?'Browser started on your Mac. The whole address, including the part after the # sign, opens it again. '
      :attempt.reason==='attempted'?'Launch attempted. If no browser appears, open the whole address yourself, including the part after the # sign. '
      :attempt.reason==='not-macos'?'Opening it for you works only on macOS, so open the whole address yourself, including the part after the # sign, which is this page key. '
      :`Could not open your Mac browser (${attempt.detail}); open the whole address yourself, including the part after the # sign, which is this page key. `;
    const launchFailed=attempt?.reason==='failed' || attempt?.reason==='not-macos';
    const waitMs=launchFailed?0:Math.min(input.waitForSceneMs??0,HOST_TOOL_WAIT_CEILING_MS);
    const waited=waitMs>0?await awaitSavedScene(input.sessionId,waitMs):undefined;
    // Read after the wait: a result built from the state before it said
    // hasScene false beside a sentence saying the scene was saved, and an
    // agent believed the structured field and polled.
    const data=await current(input.sessionId);
    const summary=data.attachment.commands.summary(binding(input.sessionId,data));
    const desktopPanels=summary.panels.filter(panel=>panel.surface==='desktop');
    const sceneSaved=Boolean(data.attachment.scene);
    const ready=sceneSaved && desktopPanels.some(panel=>panel.current && panel.availability==='ready');
    const hydratedAt=panelHydratedAt.get(input.sessionId);
    const hydrationObserved=hydratedAt!==undefined && Date.now()-hydratedAt<renderBudgetMsFor(data);
    // Hydration is only a recent request for this session, possibly from
    // another surface/source. Browser spawn and hydration do not prove a
    // desktop renderer. An attached but blocked/stale page is not progress.
    const viewerObserved=desktopPanels.length>0;
    const renderingObserved=summary.pendingCommand.some(command=>command.status==='rendering'
      && desktopPanels.some(panel=>panel.panelId===command.panelId && panel.current && panel.availability==='busy'
        && panel.availabilityCause==='busy' && !panel.xrStartup?.reloadRequired && !panel.xrStartup?.errorName
        && panel.xrStartup?.visible!==false));
    const readiness={status:ready?'ready':renderingObserved?'loading':viewerObserved?'viewer_not_ready':launchFailed?'launch_failed':'no_viewer_observed',
      ready,sceneSaved,viewerObserved,hydrationObserved,renderingObserved,waitMs,timedOut:waited===false};
    const poll='Keep the tab open and read get_inspection_state for hasScene true and a current ready desktop panel.';
    const next=launchFailed&&!ready
      ? `Browser launch failed; readiness was checked without waiting. ${sceneSaved?'The scene is saved, but no current ready desktop panel was observed.':'The scene is not saved.'} ${poll}`
      :waitMs===0
      ? 'Poll get_inspection_state for hasScene true and a current ready desktop panel; open_companion and open_detailed_view then admit this session.'
      :ready
        ? 'The page drew and saved the scene, and a desktop panel is ready: open_companion and open_detailed_view admit this session now.'
        :sceneSaved
          ? `The scene is saved, but no current ready desktop panel was observed within ${waitMs/1000} s. ${poll}`
          :viewerObserved
            ? `The scene was not saved within ${waitMs/1000} s. An attached desktop panel has not reported a saved scene and readiness. ${poll}`
            :`No connected desktop viewer was observed within ${waitMs/1000} s; the scene is not saved. ${hydrationObserved?'A recent hydration request for this session was observed, which does not confirm a desktop viewer. ':''}${poll}`;
    return result(input.sessionId,data,{inspector:{url:link.url,port:link.port,
      opened:attempt?.opened===true,...(attempt?{openReason:attempt.reason,...(attempt.reason==='failed'?{openDetail:attempt.detail,openCode:attempt.code}:{})}:{}),
      readiness,...((input.waitForSceneMs??0)>0?{sceneSaved}:{})}},
      `Inspector panel for this session: ${link.url}\n${opening}Leave that tab open: it is the renderer. ${next}`);
  });
  registerAppTool(server,'stereo_structure.get_readiness',{
    title:'Check headset microphone readiness',
    description:'Read this host\'s readiness for an optional headset-microphone conversation as six capabilities, each ok, missing or not-checked, with an actionable next step. structure means a saved scene and current ready panel; share means an open private Wi-Fi listener with a paired client; agent requires recent listening and a processed conversation request, since polling alone cannot answer. transcription requires an enabled recognizer and an observed transcript in this session; configured but unobserved capture is not-checked and blocks voice readiness. replies reports the configured spoken-answer route; speechCheck=true attempts one short clip through that provider, including an OAuth network request when selected. Generated audio does not confirm headset playback. A current paired browser page establishes its connection regardless of optional debugging tools. Otherwise headset checks an authorized Quest debugging transport using discovered adb; an absent or failed debugging connection does not establish that the headset is off or unreachable. This status check does not enable or reconnect debugging. Check wearer.state separately for immersive rendering. ready is true when blocking is empty. The same text is printed by setup-doctor.ts and headset-drive.ts. Reading this does not count as listening. Debugging diagnostics may name the selected device or authorized endpoint; no pairing code, token or device key is returned. This does not assess the host app’s independent live voice session. Missing headset-microphone prerequisites do not block host voice, manual controls or text.',
    inputSchema:readinessSchema,annotations:{...readOnly,openWorldHint:true},_meta:{},
  },async({sessionId,speechCheck}:{sessionId:string;speechCheck?:boolean})=>{
    // Reading readiness cannot itself establish conversation presence.
    const data=await current(sessionId);
    const readiness=assembleReadiness(await readinessFacts(data,sessionId,speechCheck===true));
    const modelContext=optionalInspectionModelContext(()=>inspectionModelContextFor(
      sessionId,data,undefined,{ready:readiness.ready,blocking:readiness.blocking,scope:'headset-microphone-session'}));
    return result(sessionId,data,{readiness,modelContext},formatReadiness(readiness));
  });
  registerAppTool(server,'stereo_structure.manage_companion',{
    title:'Manage private Wi-Fi sharing',
    description:'Read or manage private Wi-Fi sharing. For "Stop sharing", use action="close" to close the listener and disconnect paired devices; shareClosed:true confirms completion. action="status" reports the share, page and Android ANR check separately. action="launch" reuses the open LAN address and remembered headset choice. launch="auto" first tries an authorized Quest connection, including remembered Wi-Fi. Set headset="apple" for Vision Pro. Apple gets the HTTPS address and one Safari instruction. An unknown headset gets generic manual pairing when no authorized Quest is found. Set headset="meta" and launch="web" for Meta Web Launch. Set launch="adb" for an authorized cable. Web Launch is limited to one send a minute. action="recover-browser" is only for a reachable Meta Quest Browser. action="enter-vr" presses Enter VR on the single page from this session\'s active LAN share over authorized USB or Wi-Fi debugging, then waits until it presents. Open the share first; without authorized debugging, or with more than one matching tab, ask the wearer to tap Enter VR. The first entry on a new address raises Quest Browser\'s Allow VR prompt, which only the wearer can answer. action="recover-pairing" with launchId consumes a reported pairing failure once and returns a fresh code for the Mac launcher; it sends no notification. serverEpoch and sourceToken are optional; left out, the host uses the current values.',
    inputSchema:implicitBinding(inspectionBindingSchema.pick({sessionId:true,serverEpoch:true,sourceToken:true}).extend({action:z.enum(['status','revoke','close','forget','launch','recover-browser','recover-pairing','enter-vr']),clientId:z.string().min(1).max(128).optional(),deviceId:z.string().min(1).max(128).optional(),launch:companionLaunchModeSchema.optional(),headset:companionHeadsetSchema,
      launchId:z.string().regex(/^[a-f0-9]{32}$/).optional(),
      force:z.boolean().optional().describe('Restart Quest Browser even when it is answering. Only for a browser that is visibly stuck without an ANR dialog.')})),
    annotations:{...mutation,openWorldHint:true},_meta:{},
  },async input=>{
    const data=await current(input.sessionId),b=binding(input.sessionId,data);
    if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken) throw Error('Read the current inspection state before managing its connection.');
    if(lanOwner && (lanOwner.sessionId!==input.sessionId)) {
      if(input.action!=='status') throw Error('The LAN connection belongs to a different inspection.');
      return result(input.sessionId,data,{lan:null,addresses:listLanAddresses(),rememberedDevices:await lan.rememberedDevices()});
    }
    // Stopping this session's own sharing also lifts the save gate. Left set,
    // `shared` keeps returning busy to a manual desktop save for as long as a
    // command stays pending, with no companion left to render it.
    if(input.action==='close') {
      forgetCompanionWork(input.sessionId,true);
      const owned=lanOwner?.sessionId===input.sessionId;
      await lan.close();lanOwner=undefined;
      if(owned)markShared(input.sessionId,data.attachment,false);
      return result(input.sessionId,data,{lan:null,shareClosed:true,rememberedDevices:await lan.rememberedDevices()},
        'Sharing stopped. The private Wi-Fi listener is closed and paired devices are disconnected.');
    }
    else if(input.action==='revoke') {if(!input.clientId) throw Error('Choose the paired client to revoke.');await lan.revoke(input.clientId);}
    // Forgetting a headset is a Mac-wide decision about a stored key, so it
    // works whether or not this session currently runs the listener.
    else if(input.action==='forget') {if(!input.deviceId) throw Error('Choose the remembered headset to forget, or "all".');await lan.forgetDevices(input.deviceId);}
    else if(input.action==='recover-pairing') {
      if (lanOwner?.sessionId !== input.sessionId || !input.launchId) throw Error('Choose the failed launch on this inspection.');
      const code = await lan.recoverPairing(input.launchId);
      if(code) pendingHeadsetLaunch=undefined;
      return result(input.sessionId,data,{...(code ? { pairingCode: code } : {})});
    }
    else if(input.action==='recover-browser') {
      // The one thing the wearer had to do by hand.
      // Android's "com.oculus.browser isn't responding" dialog
      // grabs focus every ten seconds, which drops the immersive session to
      // visible-blurred, pauses the tour and refuses agent commands; only
      // pressing "Close app" ended it, and the wearer could not see why. The
      // dialog dies with the process record it names, so stopping the browser
      // clears it, and the page comes back over the same cable rather than
      // through Meta's Web Launch page, which is what wedged it in the first
      // place.
      const health=await browserHealth();
      if(health.browser==='unknown')
        throw Error(`This Mac cannot reach the headset over a debugging cable, so it cannot restart Quest Browser. ${health.reason ?? ''} Ask the wearer to press "Close app" on the dialog instead.`.trim());
      if(health.browser==='ok' && input.force!==true)
        throw Error('Android reports no Quest Browser ANR dialog, so the browser was left alone. If it is visibly stuck, pass force:true to restart it; this takes the wearer out of immersion.');
      const live=lanOwner?.sessionId===input.sessionId?lan.status():undefined;
      if(!live) throw Error('This inspection is not sharing over private Wi-Fi, so there would be nothing to reopen. Call open_companion with connection="lan" first.');
      // The wearer is about to watch the world go away, so say why before it
      // does rather than after. Neither line is a report; both are under a
      // dozen words because the wearer is wearing the speaker.
      await sayToWearer('Restarting the headset browser.');
      const stopped=await forceStopHeadsetBrowser({hooks:deviceHooks});
      if(!stopped.ok) throw Error(`Could not restart Quest Browser: ${stopped.reason} Ask the wearer to press "Close app" on the dialog.`);
      const code=await lan.pairingCode();
      // adb, never Web Launch: a second Web Launch send is the cause this is
      // recovering from.
      const launched=await launchToHeadset('adb',live.url,code,'meta');
      // A restarted Quest Browser has forgotten the
      // person's Proceed, so the reopened page can stop at the certificate
      // warning. Its steps then replace "tap Enter VR".
      const certificate=launched.opened?await headsetCertificateWarning(live.url,launched.headset?.worn,live.fingerprint):undefined;
      if(launched.opened && !certificate) await sayToWearer('Back. Tap Enter VR.');
      const after=await browserHealth();
      const text=launched.opened
        ? `${certificate?`${describeCertificateWarning(certificate)} `:''}Stopped Quest Browser${health.browser==='anr'?' and cleared its ANR dialog':''}, then reopened the companion over the cable. `
          +(certificate?launched.message.replace(` · ${enterVrStep(launched.headset?.worn)}.`,'.'):`${launched.message} The wearer taps Enter VR once.`)
        : `Stopped Quest Browser${health.browser==='anr'?' and cleared its ANR dialog':''}, but could not reopen the page: ${launched.message} Open the printed address on the headset.`;
      return result(input.sessionId,data,{lan:lan.status()??null,addresses:listLanAddresses(),
        recovery:{stopped:true,relaunched:launched.opened,before:health,after},launch:launched,...(code?{pairingCode:code}:{}),
        ...(certificate?{certificateWarning:certificate}:{})},text);
    }
    else if(input.action==='enter-vr') {
      // A wearer on the flat page sees no molecule, and
      // before this the agent could only ask them, which meant taking the
      // headset off to answer. The press itself is in headset-enter-vr.ts. The
      // The debugger route belongs to this call and is removed after the press.
      const environment=deviceHooks.env ?? captureEnvironment();
      const share=lanOwner?.sessionId===input.sessionId?lan.status():undefined;
      const expectedOrigin=(()=>{try { return share?new URL(share.url).origin:undefined; } catch { return undefined; }})();
      if(!expectedOrigin) {
        const entered=await enterHeadsetVr(hooks.headsetDevtools??nodeDevtoolsTransport(),{port:0});
        return result(input.sessionId,data,{enterVr:entered},entered.text);
      }
      const device=await resolveAdbTarget({env:environment,...(deviceHooks.exists?{exists:deviceHooks.exists}:{}),run:deviceHooks.run});
      if(!device.ok) return result(input.sessionId,data,{enterVr:{entered:false,pressed:false,state:'no-debugger',adb:device.reason}},
        'No debugging cable reaches the headset browser from this Mac, so ask the wearer to tap Enter VR on the page.');
      const forwarded=await withOwnedDevtoolsForward({adb:device.adb,serial:device.serial,
        run:async(adb,args)=>{const answer=await deviceHooks.run(adb,args,{timeout:DEVICE_ADB_TIMEOUT_MS,env:environment,maxBuffer:64*1024});
          return {code:(answer as typeof answer & {code?:number}).code ?? 0};},
        action:port=>enterHeadsetVr(hooks.headsetDevtools??nodeDevtoolsTransport(),{port,expectedOrigin})});
      if(!forwarded.ok) return result(input.sessionId,data,{enterVr:{entered:false,pressed:false,state:'no-debugger',adb:forwarded.reason}},
        `${forwarded.reason} Ask the wearer to tap Enter VR on the page.`);
      const entered=forwarded.value;
      return result(input.sessionId,data,{enterVr:{...entered,port:forwarded.port,
        adb:forwarded.cleanupWarning??'forwarded and removed'}},`${entered.text}${forwarded.cleanupWarning?` ${forwarded.cleanupWarning}`:''}`);
    }
    else if(input.action==='launch') {
      if(!input.launch) throw Error('Choose auto, web, or adb. Auto checks the headset route.');
      // Relaunching is only meaningful for a listener that is already up. This
      // deliberately does not start one: open_companion owns that decision,
      // along with the address and port it binds.
      const live=lanOwner?.sessionId===input.sessionId?lan.status():undefined;
      const code=live?await lan.pairingCode():undefined;
      if(!live) throw Error('This inspection is not sharing over private Wi-Fi. Call open_companion with connection="lan" first.');
      if(input.headset!=='auto' && lanOwner?.sessionId===input.sessionId) lanOwner.headset=input.headset;
      const launched=await launchToHeadset(input.launch,live.url,code,lanOwner!.headset);
      // A relaunch lists the same headset steps as open_companion, so the agent
      // relays them once and waits on the wearer's state the same way.
      return result(input.sessionId,data,{lan:lan.status()??null,addresses:listLanAddresses(),rememberedDevices:await lan.rememberedDevices(),
        launch:launched,...(code?{pairingCode:code}:{})},
        (launched.link && launched.reason==='started') || launched.target==='apple'
          ?`${launched.message} Relay these steps once, then ${WEARER_WAIT}`:launched.message);
    }
    // A share that ran out of time looks to the wearer like a dead press with
    // no reason, so status is where the agent learns what to say and do.
    const liveLan=lan.status(), lanExpiredAt=liveLan?undefined:lan.expiredAt();
    // And so is a wedged browser. It is read only where adb is
    // configured, and `unknown` is left out of the sentence entirely: a Mac
    // with no cable should not be told the browser might be broken.
    const panels=data.attachment.commands.summary(binding(input.sessionId,data)).panels;
    const appleStatus=input.action==='status'?visionProStatus(lanShareFacts(input.sessionId,panels,liveLan)):undefined;
    const health=input.action==='status' && !appleStatus?await browserHealth():undefined;
    const status=result(input.sessionId,data,{lan:liveLan??null,panels,addresses:listLanAddresses(),rememberedDevices:await lan.rememberedDevices(),
      diagnostics:diagnostics.summary(),...(lanExpiredAt?{lanExpiredAt}:{}),
      ...(health?{browser:{check:'android-anr',browser:health.browser,...(health.since?{since:health.since}:{}),
        ...(health.evidence.length?{evidence:health.evidence}:{}),...(health.reason?{reason:health.reason}:{})}}:{})});
    const notes=[!liveLan?'The private Wi-Fi share is closed.':undefined,
      lanExpiredAt?`The LAN share expired at ${new Date(lanExpiredAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}; run open_companion to reopen it and follow its returned pairing instructions.`:undefined,
      appleStatus,health?browserHealthLine(health):undefined].filter(Boolean);
    if(notes.length)status.content[0].text+=` ${notes.join(' ')}`;
    return status;
  });
  /**
   * Check that the source reads as mmCIF and holds the requested model and
   * assembly, fill in the model and assembly it resolved to, and return the
   * catalog it extracted so a caller that needs one does not extract again.
   */
  async function verifySourceSelection(structureText:string,selection:StructureSelection) {
    const catalog:any=await extractInspectionCatalogBytes(structureText,selection.assemblyId?{assemblyId:selection.assemblyId}:undefined);
    // REMOVED, the 20,000-residue-position and
    // 200,000-atom-site refusal that used to sit here. It was never measured
    // and it spoke for every surface, including the desktop.
    //
    // The transport call stays and its result is deliberately unused: it throws
    // for a catalog past this Mac's 64 MiB decode policy, so a source this
    // machine could not deliver is refused before the session opens instead of
    // at hydration.
    inspectionCatalogTransport(catalog);
    if(selection.modelNumber!==undefined && !catalog.modelNumbers.includes(selection.modelNumber))
      throw Error(`Model ${selection.modelNumber} is unavailable. Choose a deposited model: ${catalog.modelNumbers.join(', ')}.`);
    selection.modelNumber??=catalog.modelNumbers[0];
    selection.assemblyId=catalog.assemblyId;
    return catalog;
  }
  registerAppTool(server,'stereo_structure.inspect',{
    title:'Inspect a molecular structure',
    description:SOURCE_DESCRIPTION+' Open the molecular inspection workspace using exactly one source, legacy pdbId or pasted mmCIF structureText, or only sessionId to reopen. Use modelNumber and assemblyId to select explicitly; omitted model uses the first deposited model and omitted assembly uses asymmetric_unit. PDB URL content is normalized with Mol*. Legacy stereo/motion/control tools affect the separate stereo viewer, not this workspace. Wait for a rendered panel receipt before confirming visibility. Save sessionId for later calls.',
    inputSchema:inspectInputSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},_meta:{ui},
  },async input=>{
    if(input.structureText && (!/^data_\S*/im.test(input.structureText.trimStart()) || !/_atom_site\./i.test(input.structureText)))
      throw Error('The inspector requires mmCIF text. Use a PDB ID or open pasted PDB in the stereo viewer.');
    if(input.sessionId) {
      const opened=await hooks.open({sessionId:input.sessionId}),data=await current(input.sessionId);
      return result(input.sessionId,data,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true});
    }
    if(!hooks.openVerifiedSource) throw Error('This host cannot atomically open a verified structure source.');
    const selection:StructureSelection={modelNumber:input.modelNumber,assemblyId:input.assemblyId};
    const source:StructureSourceRequest=input.source??(input.pdbId?{kind:'pdb',id:input.pdbId}:{kind:'pasted',text:input.structureText!,format:'mmcif'});
    const opened=await hooks.openVerifiedSource({source,selection,verify:text=>verifySourceSelection(text,selection)});
    const id=opened.structuredContent.sessionId,data=await current(id);
    return result(id,data,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true});
  });
  registerAppTool(server,'stereo_structure.list_experiences',{
    title:'List source-verified molecular experiences',
    description:'List installed multi-source experience definitions. An experience may replace coordinates and assembly; it is distinct from ordinary single-source tours.',
    inputSchema:z.object({}).strict(),annotations:readOnly,_meta:{},
  },async()=>{
    return {content:[{type:'text' as const,text:'Installed molecular experiences.'}],structuredContent:{experiences:MOLECULAR_EXPERIENCES.map(experience=>({
      id:experience.id,title:experience.title,summary:experience.summary,steps:experience.steps.length,
      stages:experience.stages.map(stage=>({id:stage.id,title:stage.title,pdbId:stage.source.pdbId,assemblyId:stage.assembly.assemblyId})),
    }))}};
  });
  privateTool('stereo_structure.replace_inspection_source',{
    title:'Replace or compare the current inspection source',
    description:'Load a different structure into the open session and keep the headset connected: {sessionId,pdbId:"1CRN",waitForRenderMs:10000}. Binding fields are optional and use current values. mode="replace" resets appearance; mode="compare" adds a saved, undoable structure beside the current one. waitForRenderMs waits at most 40 seconds in this call while the full render budget continues. Report it as shown only when sourceRenderStatus.rendered is true; otherwise read get_inspection_state for sourceRenderReceipt until renderWait.budgetMs is spent. Compare returns a commandId: wait for its status "rendered". Name the structure with pdbId or source for AlphaFold, URLs, files and pasted coordinates. Downloads are capped at 64 MiB. PDB inspection needs declared polymer SEQRES; coordinate-only PDB files open with open.',
    inputSchema:implicitBinding(replaceInspectionSourceSchema,replaceInspectionSourceRequestSchema),annotations:{...mutation,destructiveHint:true,openWorldHint:true},_meta:{},
  },async input=>{
    const callStarted=Date.now();
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken || input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==b.inspectionRevision)
      throw Error('Read the current inspection state before replacing its source.');
    // What was asked for is settled before who could draw it. An
    // insecure URL, embedded credentials, an oversized paste or an unreadable
    // one is refused by name whatever the panel is doing; the readiness refusal
    // below is kept for requests this surface would otherwise have honoured
    assertStructureSourceRequest(input.source??{kind:'pdb',id:input.pdbId!});
    const recoveringSource=input.mode!=='compare' && failedSourceOwnerReady(data,input.panelId);
    if(!data.attachment.commands.readyPanel(input.panelId,b) && !recoveringSource) throw Error(PANEL_BUSY_MESSAGE);
    const prior=data.attachment;
    const recoveryContinuation=recoveringSource?prior.sourceContinuation:undefined;
    const carriedUtteranceId=recoveryContinuation?.utteranceId;
    if(recoveringSource && input.utteranceId!==undefined && input.utteranceId!==carriedUtteranceId)
      throw Error(carriedUtteranceId
        ?'This recovery belongs to the pending wearer request. Correct or cancel that request before retrying with another utterance.'
        :'This recovery has no spoken request to continue. Finish the replacement first, then submit the new utterance against the rendered source.');
    const sourceOperationInput=recoveringSource && carriedUtteranceId
      ?{...input,utteranceId:carriedUtteranceId}:input;
    const sourceOperation=data.attachment.commands.beginSourceOperation(sourceOperationInput,b,
      recoveringSource && carriedUtteranceId && recoveryContinuation
        ?{utteranceId:carriedUtteranceId,binding:recoveryContinuation.previous}:undefined);
    try {
      if(input.mode==='compare') {
        if(!data.attachment.scene) throw Error('Save the primary inspection before comparing structures.');
        const source:StructureSourceRequest=input.source??{kind:'pdb',id:input.pdbId!};
        const selection:StructureSelection={modelNumber:input.modelNumber,assemblyId:input.assemblyId};
        const resolved=await hooks.resolveComparisonSource!(source,sourceOperation.signal);
        const catalog:any=await verifySourceSelection(resolved.structureText,selection);
        const primary=data.attachment.scene;
        const [r1,r2]=await Promise.all([
          comparisonRadius(data.cache.structureText,primary.modelNumber,primary.assemblyId),
          comparisonRadius(resolved.structureText,selection.modelNumber!,selection.assemblyId!),
        ]);
        const patch={source,sourceSha256:catalog.source.sha256,modelNumber:selection.modelNumber!,assemblyId:selection.assemblyId!,
          placement:{translation:[(r1+r2)/r1,0,0],rotation:[0,0,0],scale:1},
          appearance:{representation:catalog.rows.some((row:any)=>row.entityType==='polymer')?'cartoon':'ball-and-stick',color:'uniform',uniformColor:'#e6a04b',opacity:1}};
        const change={kind:'companion-structure',patch} as InspectionChange;
        const expected=expectedInspection(primary,change);
        validateScene(expected,data.attachment.catalog,data.attachment.density);
        const asset={source,sources:[source],id:source.kind==='pdb'?source.id.toUpperCase():resolved.accession??'comparison',
          cif:resolved.structureText,sha256:catalog.source.sha256,catalog};
        assertInspectionBudget({scene:expected,comparisonSources:[comparisonTransport(asset)]},
          MAX_INSPECTION_HYDRATION_BYTES,'Comparison hydration');
        const latest=await current(input.sessionId),live=binding(input.sessionId,latest);
        sourceOperation.assertCurrent();
        if(live.sourceToken!==b.sourceToken || live.stateRevision!==b.stateRevision || live.inspectionRevision!==b.inspectionRevision)
          throw Error('The inspection changed while preparing the comparison. Read its state and try again.');
        if(!latest.attachment.commands.readyPanel(input.panelId,live)) throw Error(PANEL_BUSY_MESSAGE);
        const command=latest.attachment.commands.enqueue({...input,commandId:input.commandId??randomUUID(),change} as any,live,primary);
        const assetKey=`${asset.sha256}:${catalog.assemblyId}`;
        const previousAsset=latest.attachment.comparisonAssets?.get(assetKey);
        if(previousAsset) asset.sources=[...previousAsset.sources,source];
        (latest.attachment.comparisonAssets??=new Map()).set(assetKey,asset);
        pruneComparisonAssets(latest.attachment,expected);
        return result(input.sessionId,latest,{command,comparison:{alignment:'side-by-side',
          ...(input.align==='superpose'?{reason:'Superposition was not performed; the structures are side by side.'}:{}),
          confirmation:`Now comparing ${data.cache.pdbId??'the primary structure'} with ${asset.id}.`}},
          `Comparison command ${command.status}. Check get_inspection_state with commandId before reporting the structures visible. Alignment: side-by-side.`);
      }
      if(!hooks.openVerifiedSource) throw Error('This host cannot atomically open a verified structure source.');
      const releaseRetarget=authorizeSourceRetarget(input.sessionId);
      let committedCache:Cache|undefined;
      try {
        const selection:StructureSelection={modelNumber:input.modelNumber,assemblyId:input.assemblyId};
        const source:StructureSourceRequest=input.source??{kind:'pdb',id:input.pdbId!};
        const opened=await hooks.openVerifiedSource({sessionId:input.sessionId,source,selection,signal:sourceOperation.signal,
          beforeCommit:()=>{
            sourceOperation.assertCurrent();
            const live=binding(input.sessionId,data);
            if(live.sourceToken!==b.sourceToken || live.stateRevision!==b.stateRevision || live.inspectionRevision!==b.inspectionRevision)
              throw Error('The inspection changed before committing its source. Read its state and try again.');
            if(recoveringSource && (prior.sourceContinuation!==recoveryContinuation
              || recoveryContinuation?.utteranceId!==carriedUtteranceId
              || !failedSourceOwnerReady(data,input.panelId))) throw Error(PANEL_BUSY_MESSAGE);
          },
          committed:()=>{
            const session=hooks.current(input.sessionId);
            committedCache=session.structureCache;
            sourceHandoffs.set(session.structureCache!,{commands:prior.commands,
              previous:recoveringSource?recoveryContinuation!.previous:b,panelId:input.panelId,
              ...(sourceOperation.utteranceId?{utteranceId:sourceOperation.utteranceId}:{}),stateRevision:session.stateRevision,
              modelNumber:selection.modelNumber!,assemblyId:selection.assemblyId!,shared:prior.shared});
            sourceOperation.release();
          },verify:async text=>{
          await verifySourceSelection(text,selection);
          sourceOperation.assertCurrent();
          // Revalidate panel/revision ownership after asynchronous fetching and parsing.
          const latest=await current(input.sessionId),live=binding(input.sessionId,latest);
          if(live.sourceToken!==b.sourceToken || live.stateRevision!==b.stateRevision || live.inspectionRevision!==b.inspectionRevision)
            throw Error('The inspection changed while preparing its source. Read the current state and try again.');
          if(!latest.attachment.commands.readyPanel(input.panelId,live)
            && !(recoveringSource && latest.attachment===data.attachment && prior.sourceContinuation===recoveryContinuation
              && recoveryContinuation?.utteranceId===carriedUtteranceId && failedSourceOwnerReady(latest,input.panelId)))
            throw Error(PANEL_BUSY_MESSAGE);
        }});
        experienceSessions.delete(input.sessionId);
        const refreshed=await current(input.sessionId);
        if(refreshed.cache!==committedCache) throw Error('A newer source superseded this transition before its panel could be retargeted.');
        // Ready panels and sharing belong to the live session, not coordinates.
        refreshed.attachment.shared=prior.shared; refreshed.attachment.commands=prior.commands;
        // The queue came across from the old source; the budget must not.
        refreshed.attachment.commands.setRenderBudget(renderBudgetMsFor(refreshed));
        const sourceRenderWait=refreshed.attachment.sourceRenderWait??=new SourceRenderWait();
        sourceRenderWait.commandId=sourceOperation.commandId;
        setTransitionTarget(refreshed.attachment,input.panelId);
        if(lanOwner && lanOwner.sessionId===input.sessionId) lanOwner.sourceToken=refreshed.attachment.sourceToken;
        // Retargeting is complete before the optional wait; never extend the
        // source-retarget authorization window while waiting on a renderer.
        releaseRetarget();
        // The caller asks, the host decides how long.
        //
        // The budget is this host's own `panelWaitMs` for the source that was
        // just committed, so it is sized to the structure the panel now has to
        // draw rather than to whatever the caller guessed. A caller asking for
        // less than the budget still gets what it asked for: waiting less is
        // always the caller's right. Asking for more is clamped, and the
        // budget is stated back either way so a caller that timed out knows
        // how long the host thinks this load is worth.
        const budgetMs=renderBudgetMsFor(refreshed);
        const askedMs=input.waitForRenderMs??0;
        const waitedForMs=Math.max(0,Math.min(askedMs,budgetMs,HOST_TOOL_WAIT_CEILING_MS,
          OPEN_COMPANION_CALL_CEILING_MS-(Date.now()-callStarted)));
        const preparationElapsedMs=Date.now()-callStarted;
        const preparationUsedWaitBudget=askedMs>0 && waitedForMs===0;
        const receipt=await sourceRenderWait.wait(waitedForMs);
        const elapsedMs=Date.now()-callStarted;
        const latest=await current(input.sessionId);
        const sameSource=latest.attachment===refreshed.attachment;
        const ready=receipt?.status==='rendered' && sameSource && latest.attachment.commands.readyPanel(receipt.panelId,binding(input.sessionId,latest));
        const reset='Appearance resets to the new source defaults, including representation and colors.';
        const budgetLine=`This host budgets ${Math.round(budgetMs/1000)} s for this source to load, draw and save; keep reading get_inspection_state for its sourceRenderReceipt until that budget is spent.`;
        const unwaitedLine=`No render wait was asked for, so nothing here says the wearer saw it. ${budgetLine}`;
        const reason=!sameSource?'The source changed again before rendering could be confirmed.'
          :receipt?.status==='failed'?receipt.failureReason
          :receipt&&!ready?'The panel rendered and saved, but is no longer current and ready. Read the current inspection state before continuing.'
            :preparationUsedWaitBudget?`Host preparation used the call wait budget (${preparationElapsedMs} ms; ${elapsedMs} ms elapsed). Rendering continues. Poll get_inspection_state with commandId "${sourceOperation.commandId}" for the source render receipt. ${budgetLine}`
            :askedMs?`Timed out after ${waitedForMs} ms waiting for the selected panel to render, save and reattach. No current ready rendered receipt was observed. ${budgetLine}`
              :unwaitedLine;
        /**
         * One receipt, and the sentence beside it says no more.
         *
         * A replacement used to answer with `sourceRenderReceipt` only when the
         * caller had asked for a wait, and with nothing a receipt reader
         * recognised even then, so the converse loop reported `rendered: false`
         * under the words "The selected panel rendered and saved the new
         * source" on all four swaps of the device run. `rendered` is
         * now the same boolean the sentence is chosen from, and a replacement
         * that was never waited on says so in its own status rather than going
         * quiet.
         */
        const renderReceipt=receipt?.status==='failed' && sameSource
          ? {...receipt,rendered:false,renderBudgetMs:budgetMs,askedMs,waitedForMs,reason}
          :ready&&receipt
          ? {...receipt,commandId:sourceOperation.commandId,elapsedMs,rendered:true,renderBudgetMs:budgetMs,askedMs,waitedForMs}
          : {rendered:false,commandId:sourceOperation.commandId,elapsedMs,preparationElapsedMs,renderBudgetMs:budgetMs,askedMs,waitedForMs,panelId:input.panelId,reason,
            status:!sameSource?'superseded':receipt?'unconfirmed':preparationUsedWaitBudget?'rendering':askedMs?'timed_out':'unwaited'};
        if(!sameSource) return result(input.sessionId,latest,{sourceTransition:{sourceChanged:false,superseded:true},
          sourceRenderReceipt:null,sourceRenderStatus:renderReceipt,
          renderWait:{timedOut:!receipt,reason,budgetMs,waitedForMs,askedMs}},reason);
        return result(input.sessionId,latest,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true,
          appearanceReset:true,
          sourceRenderReceipt:ready || receipt?.status==='failed'?receipt:null,sourceRenderStatus:renderReceipt,
          commandId:sourceOperation.commandId,
          renderWait:{timedOut:Boolean(askedMs)&&!receipt&&!preparationUsedWaitBudget,reason:ready?null:reason,budgetMs,waitedForMs,askedMs},
          sourceTransition:{sourceChanged:true,...(source.kind==='pdb'?{pdbId:source.id.toUpperCase()}:{kind:source.kind})}},
          ready?`The selected panel rendered and saved the new source. ${reset}${receipt?.status==='rendered' && receipt.geometryBudget?` ${receipt.geometryBudget.message}`:''}`
            :receipt?.status==='failed'?`The selected panel could not load the new source: ${reason}`
            :askedMs?`${reason} ${reset}`
              :`Stereofold session opened. The panel still needs to load and render the structure. Check get_inspection_state for hasScene and a current ready panel before reporting it as visible. ${reset}`);
      } finally { releaseRetarget(); }
    } finally { sourceOperation.release(); }
  });
  privateTool('stereo_structure.grow_structure',{
    title:'Grow or shrink the staged lesson without leaving the headset',
    description:'Step one tier up or down a staged demo in the session the wearer is already in, which is what to use for "grow it", "add tubulin", "build the wall", "cap it" and "shrink it". The loaded lesson names the tier, so pass stage="next" to grow, "back" to shrink, or the exact tier id (the microtubule-growth demo has monomer, dimer, protofilament, wall, tube and tip). The coordinates and the authored lesson are both replaced together and the same immersive session, placement and scale are kept, so the structure appears to form where it already is rather than reopening. Every tier is deposited coordinates the demo index records with its digest; nothing is generated. device is the paired headset class and decides what is allowed: a quest2 headset is refused anything over '+QUEST2_ATOM_SITE_CEILING.toLocaleString()+' atom sites, and the refusal comes back with a short spoken line to read out rather than an attempt that would drop the session with the headset on. First read get_inspection_state and copy sessionId, serverEpoch, sourceToken, stateRevision as baseStateRevision, inspectionRevision as baseInspectionRevision, and a current ready panelId. An accepted request is still pending rendering. Read get_inspection_state again for the new lesson and parts, and wait until sourceRenderReceipt has status="rendered", rendered=true, the current sourceToken and ready replacement panelId, and renderedRevision no greater than the current inspectionRevision. The receipt appears only after that renderer saves and attaches the new source.',
    inputSchema:growStructureSchema,annotations:{...mutation,destructiveHint:true},_meta:{},
  },async input=>{
    const data=await current(input.sessionId), b=binding(input.sessionId,data);
    if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken || input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==b.inspectionRevision)
      throw Error('Read the current inspection state before growing the structure.');
    // The tier is settled before the panel is. A wearer who asks for
    // a tier this headset class cannot hold hears that ceiling named, at a
    // moment when the panel happens to be busy as much as at any other; only a
    // tier this session would have grown waits on the panel below.
    const index=await readGrowthIndex();
    const here=growthStageOfLesson(index,data.attachment.customTour?.id);
    if(!here) throw Error('This session is not playing a staged lesson, so there is no tier to grow from. Open one with inspect_lesson, for example plugin/demos/microtubule-growth/monomer.json.');
    const tier=DEMO_TIER_BY_DEVICE[input.device??'unknown']??'quest2';
    const resolution=resolveGrowthTarget(growthStages(index),here,input.stage,tier);
    if(resolution.refused) {
      // The Mac is the caller, so the spoken line would otherwise never
      // leave this return. Queue it for the companion heartbeat; the page
      // arms the caption-plate overlay from that notice the same way it
      // arms one from a wearer-asked grow.
      growthCaptions.offer({spoken:resolution.spoken,refused:true,from:here.stage.id});
      return result(input.sessionId,data,{grow:{refused:true,from:here.stage.id,spoken:resolution.spoken,deviceTier:tier}},`${resolution.reason} Say this in the headset: "${resolution.spoken}"`);
    }
    const target=resolution.target;
    if(!data.attachment.commands.readyPanel(input.panelId,b)) throw Error(PANEL_BUSY_MESSAGE);
    if(!hooks.openVerifiedLocal) throw Error('This host cannot atomically open a verified local source.');
    // Read and check both halves before anything is replaced: a tier whose
    // coordinates are missing must leave the loaded one exactly as it was.
    /**
     * A volume tier's `coordinates.file` is a MAP, not an mmCIF.
     *
     * A density tier has no atoms of its own, so there is nothing for the
     * source cache to hold and nothing for the catalog to be built from. It
     * opens beside the related deposited reference model — the structure the
     * index records under `coordinates.volume.structure` — and the map is what
     * the page is given to draw. The coordinates are still read, digested and
     * budgeted exactly as an atomic tier's are; the map is checked the same way
     * on top of them.
     */
    const volume=target.stage.coordinates.volume;
    const structureFile=volume?volume.structure.file:target.stage.coordinates.file;
    const structureSha256=volume?volume.structure.sha256:target.stage.coordinates.sha256;
    // A fresh Mac has warmed no tier at all, so the grow fetches the one the
    // wearer asked for rather than telling them to go and run the launcher.
    // The digest the index records is checked before and after, and the wearer
    // hears one short line while the download runs.
    const ensured=await ensureGrowthCoordinates({
      demo:target.demo,stageId:target.stage.id,file:structureFile,sha256:structureSha256,
      download:volume?volume.structure.download:target.stage.coordinates.download,
      ...(volume?{}:(target.stage.coordinates.derivation?{derivation:target.stage.coordinates.derivation}:{})),
    },{announce:notice=>{
      growthCaptions.offer({spoken:notice.spoken,refused:false,from:here.stage.id});
      console.error(notice.printed);
    }});
    const coordinates=ensured.path;
    const {structureText}=await readInspectionFile(coordinates);
    const sourceSha256=createHash('sha256').update(structureText,'utf8').digest('hex');
    if(sourceSha256!==structureSha256)
      throw Error(`The cached ${structureFile} does not match the digest the demo index records for the ${target.stage.id} tier.`);
    const lessonManifest=parseMolecularLesson(await readBoundedJsonFile(resolvePath(dirname(DEMO_INDEX_PATH),target.lessonPath)));
    // The map is the one half a session will not fetch. Its download is a
    // 164 MB gzipped deposit that has to be mean-downsampled before anything
    // can draw it, so the launcher prepares it and this says which command.
    const density=volume?await readLessonDensity(lessonManifest,demoCoordinatePath(target.stage.coordinates.file)).catch((error:unknown)=>{
      const detail=error instanceof Error?error.message:'';
      throw Error(`The ${target.stage.id} density map is not usable from the demo cache (${target.stage.coordinates.file}). ${detail} Run ${growthRecoveryCommand(target.demo,target.stage.id)} on this Mac, then grow.`);
    }):undefined;
    // The index and the lesson are two records of the same map, and a grow is
    // the one moment they are both in hand. Disagreeing about the bytes means
    // one of them is describing a map the wearer is not about to see.
    if(density && (density.sha256!==target.stage.coordinates.sha256 || density.bytes.byteLength!==target.stage.coordinates.bytes))
      throw Error(`The cached ${target.stage.coordinates.file} does not match the digest the demo index records for the ${target.stage.id} tier.`);
    const provenanceSha256=density?density.sha256:sourceSha256;
    if(lessonManifest.provenance.sourceSha256 && lessonManifest.provenance.sourceSha256!==provenanceSha256)
      throw Error(`The ${target.stage.id} lesson provenance does not match those exact ${density?'density':'coordinate'} bytes.`);
    const lesson=molecularLessonToTour(lessonManifest);
    const prior=data.attachment, priorAssembly=assemblyRequests.get(input.sessionId);
    const releaseRetarget=authorizeSourceRetarget(input.sessionId);
    try {
      const opened=await hooks.openVerifiedLocal({sessionId:input.sessionId,structureText,
        ...(target.stage.pdbId?{pdbId:target.stage.pdbId}:{}),verify:async text=>{
          const catalog:any=await extractInspectionCatalogBytes(text,target.stage.coordinates.assemblyId?{assemblyId:target.stage.coordinates.assemblyId}:undefined);
          const atomSites=catalog.rows.reduce((total:number,row:any)=>total+row.atomSites.length,0);
          // A density tier is measured in triangles, and `stageSize` is the one
          // place that decides which unit a tier is counted in. Checking a
          // volume against an atom-site number would compare 43,066 reference
          // atoms with the index's honest 0 and refuse the tier outright.
          const size=stageSize(target.stage);
          if(volume) {
            if(atomSites!==volume.structure.atomSites)
              throw Error(`The ${target.stage.id} tier opens beside ${atomSites.toLocaleString()} atom sites, not the ${volume.structure.atomSites.toLocaleString()} the index records.`);
          } else if(atomSites!==target.stage.coordinates.atomSites)
            throw Error(`The ${target.stage.id} tier renders ${atomSites.toLocaleString()} atom sites, not the ${target.stage.coordinates.atomSites.toLocaleString()} the index records.`);
          if(tier==='quest2' && size.count>size.ceiling) throw Error('That tier is past what this headset holds.');
          if(tier==='quest2' && atomSites>QUEST2_ATOM_SITE_CEILING) throw Error('That tier is past what this headset holds.');
        }});
      // The new source mints a fresh attachment, so the requested assembly has
      // to be installed before the catalog is rebuilt, exactly as inspect_lesson
      // does on a first open.
      if(target.stage.coordinates.assemblyId) assemblyRequests.set(input.sessionId,{assemblyId:target.stage.coordinates.assemblyId});
      else assemblyRequests.delete(input.sessionId);
      let refreshed:Awaited<ReturnType<typeof current>>;
      try { refreshed=await current(input.sessionId); }
      catch(error) { if(priorAssembly) assemblyRequests.set(input.sessionId,priorAssembly); else assemblyRequests.delete(input.sessionId); throw error; }
      if(target.stage.coordinates.assemblyId && refreshed.attachment.catalog.assemblyId!==target.stage.coordinates.assemblyId)
        throw Error('The inspector did not build the assembly this tier declares.');
      assertInspectionBudget({customTour:lesson},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
      // Ready panels and sharing belong to the live session, not to coordinates.
      // The lesson is the half a plain source replacement drops, and carrying it
      // is the whole point: the tier keeps its captions, narration and colour key.
      refreshed.attachment.shared=prior.shared; refreshed.attachment.commands=prior.commands;
      refreshed.attachment.customTour=lesson;
      refreshed.attachment.sourceOperation=growthOperation(target,ensured.fetchedAt,presenceNow());
      // The map is attached to the new source cache before any panel can
      // hydrate against it, so the first hydration after the swap is the one
      // that carries it. A tier without a map leaves the field unset, which is
      // how shrinking back out of a density tier drops it.
      if(density) refreshed.attachment.density={...density,
        ...(Number.isFinite(target.stage.coordinates.volume?.triangles)?{triangles:target.stage.coordinates.volume!.triangles}:{})};
      experienceSessions.delete(input.sessionId);
      refreshed.attachment.sourceRenderWait=new SourceRenderWait();
      setTransitionTarget(refreshed.attachment,input.panelId);
      if(lanOwner && lanOwner.sessionId===input.sessionId) lanOwner.sourceToken=refreshed.attachment.sourceToken;
      const grew=target.index>here.index, spoken=growthConfirmation(target,grew);
      const size=stageSize(target.stage);
      return result(input.sessionId,refreshed,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true,
        operation:refreshed.attachment.sourceOperation,
        sourceTransition:{sourceChanged:true,...(target.stage.pdbId?{pdbId:target.stage.pdbId}:{})},
        grow:{refused:false,from:here.stage.id,to:target.stage.id,demo:target.demo,grew,deviceTier:tier,
          atomSites:target.stage.coordinates.atomSites,size:{count:size.count,unit:size.unit},
          ...(density?{density:{bytes:density.bytes.byteLength,sha256:density.sha256,contour:density.contour}}:{}),
          lessonId:lesson.id,spoken}},
        `Requested ${target.stage.title} from ${here.stage.title}: ${size.count.toLocaleString()} ${size.unit}. Rendering is pending; read get_inspection_state until sourceRenderReceipt reports rendered for the current sourceToken and ready replacement panel, with renderedRevision no greater than the current inspectionRevision. Say this in the headset: "${spoken}"`);
    } finally { releaseRetarget(); }
  });
  registerAppTool(server,'stereo_structure.inspect_experience',{
    title:'Open a source-verified molecular experience',
    description:'Open the first step of an installed multi-source experience. The experience records public PDB provenance, declared assemblies, and bounded rendering budgets; later steps use navigate_experience rather than ordinary tour controls.',
    inputSchema:inspectExperienceSchema,annotations:{...mutation,destructiveHint:true,openWorldHint:true},_meta:{ui},
  },async({experienceId})=>{
    const experience=experienceById(experienceId);
    if(!experience) throw Error('This molecular experience is not installed.');
    const stage=stageForStep(experience,0);
    // The first open owns a fresh session, so no prior source can be damaged.
    // `current` parses the exact requested assembly before the inspector mounts.
    const opened=await hooks.open({pdbId:stage.source.pdbId});
    const id=opened.structuredContent.sessionId;
    experienceSessions.set(id,{experience,revision:0,stepIndex:0,stage,acknowledgements:new Map()});
    const data=await current(id);
    return result(id,data,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true,experienceTransition:{sourceChanged:true,sourceKey:sourceKey(stage)}});
  });
  privateTool('stereo_structure.navigate_experience',{
    title:'Navigate a source-verified experience step',
    description:'Prepare one explicit experience step for a current ready panel. A stage change atomically replaces the public coordinate source only after its bytes, requested PDB assembly, entity instances, operator IDs, atom budget and geometry bound validate. Pass device, the paired headset class from manage_companion status, as grow_structure takes it: only a quest2 headset has a measured geometry budget and is refused a chapter over it; omitted, the paired peer\'s class is used, and an unidentified headset is not held to the Quest 2 budget. Hydrate the returned source and apply the declared step before acknowledging it; do not send this through control_tour.',
    inputSchema:navigateExperienceSchema,annotations:{...mutation,destructiveHint:true,openWorldHint:true},_meta:{},
  },async input=>{
    const data=await current(input.sessionId), bindingNow=binding(input.sessionId,data), existing=data.attachment.experience;
    if(input.serverEpoch!==bindingNow.serverEpoch || input.sourceToken!==bindingNow.sourceToken || input.baseStateRevision!==bindingNow.stateRevision
      || input.baseInspectionRevision!==bindingNow.inspectionRevision || input.baseExperienceRevision!==(existing?.revision ?? 0))
      throw Error('Read the current experience state before navigating.');
    if(input.rollbackToken) {
      const undo=data.attachment.experienceRollback;
      if(!undo || undo.token!==input.rollbackToken || undo.panelId!==input.panelId
        || undo.expectedStateRevision!==data.stateRevision || data.attachment.revision!==undo.expectedInspectionRevision
        || existing?.acknowledgements.size || (input.tourCommand ? !data.attachment.commands.assertTourTransition(input.tourCommand,bindingNow) : data.attachment.commands.summary(bindingNow).pendingCommand.length))
        throw Error('A newer scene or request superseded this journey; its previous source cannot be restored.');
      if(!hooks.restoreSource) throw Error('This host cannot restore a failed journey source.');
      const release=authorizeSourceRetarget(input.sessionId);
      try {
        // The host compares cache identity and refuses an in-flight newer source request.
        // No fetch, parsing or asynchronous gap can overwrite a correction here.
        hooks.restoreSource({sessionId:input.sessionId,expectedCache:data.cache,cache:undo.cache});
        delete data.attachment.experienceRollback;
        const restored={...undo.attachment,sourceToken:randomUUID(),experience:undo.experience};
        delete restored.experienceRollback;
        if(undo.experience) experienceSessions.set(input.sessionId,undo.experience);
        else experienceSessions.delete(input.sessionId);
        attachments.set(undo.cache,Promise.resolve(restored));
        const refreshed=await current(input.sessionId);
        if(input.tourCommand){
          data.attachment.commands.advanceTourTransition(input.tourCommand,bindingNow,binding(input.sessionId,refreshed));
          data.attachment.commands.restoringTourTransition(input.tourCommand,binding(input.sessionId,refreshed));
        }
        setTransitionTarget(refreshed.attachment,input.panelId);
        if(lanOwner && lanOwner.sessionId===input.sessionId) lanOwner.sourceToken=refreshed.attachment.sourceToken;
        return result(input.sessionId,refreshed,{experienceTransition:{sourceChanged:true,restored:true}},
          'Previous journey source restored on the host. The panel must render it before confirming visibility.');
      } finally {release();}
    }
    const experience=experienceById(input.experienceId);
    if(!experience) throw Error('This molecular experience is not installed.');
    const commands=data.attachment.commands;
    if(input.tourCommand) {
      if(input.tourCommand.panelId!==input.panelId)throw Error('The journey must start in the panel that claimed the tour command.');
      const patch=commands.beginTourTransition(input.tourCommand,bindingNow);
      const step=existing?.stepIndex;
      const loadedStart=!existing && input.loadedSourceOnly===true && !input.finish && ['play','next','back'].includes(patch.action);
      const valid=loadedStart || (patch.action==='start' ? patch.tourId===input.experienceId && input.stepIndex===0 && !input.finish
        : existing?.experience.id===input.experienceId && (patch.action==='done' ? input.finish && input.stepIndex===step
          : !input.finish && (patch.action==='next' ? input.stepIndex===step!+1 : patch.action==='back' ? input.stepIndex===step!-1
            : patch.action==='restore-start' ? input.stepIndex===0 : ['play','rejoin'].includes(patch.action) && input.stepIndex===step)));
      if(!valid)throw Error('The requested journey step does not match the admitted tour command.');
    } else if(!commands.readyPanel(input.panelId,bindingNow)) throw Error('The requested experience panel is unavailable, dirty, stale, or rendering another command.');
    const panelReady=()=>input.tourCommand ? commands.tourTransitionReady(input.tourCommand,input.panelId,bindingNow) : commands.readyPanel(input.panelId,bindingNow);
    const advance=(target:Awaited<ReturnType<typeof current>>)=>{
      if(input.tourCommand)commands.advanceTourTransition(input.tourCommand,bindingNow,binding(input.sessionId,target));
    };
    if(!hooks.restoreSource) throw Error('This host cannot restore a failed journey source.');
    if(input.finish) {
      if(!existing || existing.experience.id!==input.experienceId || existing.stepIndex!==input.stepIndex)
        throw Error('The current journey changed before Done. Read its current state.');
      const origin=existing.returnView;
      if(!origin?.attachment.scene) throw Error('This journey has no saved pre-tour view to restore.');
      const priorExperience={...existing,acknowledgements:new Map(existing.acknowledgements)};
      const prior={...data.attachment,experience:priorExperience}; delete prior.experienceRollback;
      const token=randomUUID(), rollbackToken=randomUUID();
      const release=authorizeSourceRetarget(input.sessionId);
      try {
        hooks.restoreSource!({sessionId:input.sessionId,expectedCache:data.cache,cache:origin.cache});
        experienceSessions.delete(input.sessionId);
        const restored:Attachment={...origin.attachment,scene:structuredClone(origin.attachment.scene),
          sourceToken:randomUUID(),commands:data.attachment.commands,shared:data.attachment.shared,
          experienceCompletion:{token,experienceId:existing.experience.id,revision:existing.revision,stepIndex:existing.stepIndex,
            status:'pending'}};
        delete restored.experience; delete restored.experienceRollback;
        attachments.set(origin.cache,Promise.resolve(restored));
        const refreshed=await current(input.sessionId);
        restored.experienceRollback={token:rollbackToken,panelId:input.panelId,cache:data.cache,attachment:prior,experience:priorExperience,
          expectedStateRevision:refreshed.stateRevision,expectedInspectionRevision:restored.revision};
        advance(refreshed);
        setTransitionTarget(restored,input.panelId);
        if(lanOwner && lanOwner.sessionId===input.sessionId) lanOwner.sourceToken=restored.sourceToken;
        return result(input.sessionId,refreshed,{experienceTransition:{sourceChanged:true,completionToken:token,rollbackToken,status:'pending'}},
          'Your pre-tour view is prepared. The panel must render and save it before confirming Done.');
      } finally {release();}
    }
    const nextStage=stageForStep(experience,input.stepIndex);
    // The class comes from the paired LAN peer, not from a fixed 'quest2':
    // only the Quest 2 has a measured budget, and a Quest 3 or Vision Pro
    // that was budgeted as a Quest 2 was refused chapters nobody had tested.
    // A headset panel with no identifiable peer is 'unknown',
    // which the budget table leaves unbounded.
    const headsetSurface=commands.summary(bindingNow).panels.find(panel=>panel.panelId===input.panelId)?.surface!=='desktop';
    const pairedClass=(()=>{ const live=lanOwner?.sessionId===input.sessionId?lan.status():undefined;
      const latest=live?.clients.slice().sort((a,b)=>b.lastUsedAt.localeCompare(a.lastUsedAt))[0]; return latest?.deviceClass??'unknown'; })();
    const budgetClass=headsetSurface?(input.device??pairedClass):'desktop';
    const pdbId=data.cache.pdbId ?? await inspectionSourcePdbId(data.cache.structureText);
    // A plain Tour press may use only these exact loaded coordinates. Even a
    // matching journey cannot silently substitute another deposited experiment.
    if(input.loadedSourceOnly && (pdbId?.toUpperCase()!==nextStage.source.pdbId.toUpperCase() || data.attachment.density))
      throw Error(`No journey for ${pdbId || 'this structure'} yet`);
    const sameSource=pdbId?.toUpperCase()===nextStage.source.pdbId.toUpperCase()
      && data.attachment.catalog.assemblyId===nextStage.assembly.assemblyId && !data.attachment.density
      && (nextStage.source.modelNumber===undefined || nextStage.source.modelNumber===data.attachment.scene?.modelNumber);
    if(input.loadedSourceOnly && data.attachment.catalog.assemblyId!==nextStage.assembly.assemblyId) {
      const name=(id:string)=>id==='asymmetric_unit'?'the asymmetric unit':`assembly ${id}`;
      throw Error(`Journey needs ${name(nextStage.assembly.assemblyId)}; you have ${name(data.attachment.catalog.assemblyId)}. Use Tours to explicitly load its assembly.`);
    }
    if(input.loadedSourceOnly && !sameSource)
      throw Error(`Journey needs model ${nextStage.source.modelNumber}; you have model ${data.attachment.scene?.modelNumber}. Use Tours to explicitly load its model.`);
    if(!existing || existing.experience.id!==experience.id) await prepareJourney(experience,data);
    const priorExperience=existing ? {...existing,acknowledgements:new Map(existing.acknowledgements)} : undefined;
    const prior={...data.attachment,experience:priorExperience}; delete prior.experienceRollback;
    // Save a value snapshot before the first chapter, not the mutable active attachment.
    // It stays with the journey across stage/source changes and browser reloads.
    const original={...prior,scene:prior.scene?structuredClone(prior.scene):null};
    delete original.experience; delete original.experienceCompletion; delete original.reconciledExperienceId;
    // Retain the scientific view, not a prior voice/source request or Mol* delivery.
    delete original.sourceContinuation; delete original.sourceOperation; delete original.sourceRenderWait;
    delete original.detailedReturn; delete original.detailedSelection; delete original.transitionTarget;
    const returnView=existing ? existing.returnView : {cache:data.cache,attachment:original};
    const next:ExperienceRuntime={experience,revision:(existing?.revision ?? 0)+1,stepIndex:input.stepIndex,stage:nextStage,acknowledgements:new Map(),returnView};
    const token=randomUUID();
    const installRollback=(target:Awaited<ReturnType<typeof current>>)=>{
      target.attachment.experienceRollback={token,panelId:input.panelId,cache:data.cache,attachment:prior,experience:priorExperience,
        expectedStateRevision:target.stateRevision,expectedInspectionRevision:target.attachment.revision};
      advance(target);
      setTransitionTarget(target.attachment,input.panelId);
    };
    const stillCurrent=()=>{
      if(hooks.current(input.sessionId).structureCache!==data.cache || hooks.current(input.sessionId).stateRevision!==data.stateRevision
        || data.attachment.revision!==bindingNow.inspectionRevision || data.attachment.experience!==existing
        || !panelReady()) throw Error('A newer inspection superseded this journey request.');
    };
    if(sameSource) {
      const known=verifiedExperienceSources.get(nextStage.source.pdbId);
      if(known && known.sha256!==data.attachment.catalog.source.sha256)
        throw Error(`Public experience source ${nextStage.source.pdbId} changed during this server session.`);
      validateExperienceAssembly(nextStage,data.attachment.catalog);
      const counts=await measureJourneyStage(nextStage,data.cache.structureText,nextStage.source.modelNumber??data.attachment.scene?.modelNumber);
      const budget=chapterBudget(experience,input.stepIndex,counts,budgetClass);
      if(budget.status==='refused')throw Error(budget.message);
      stillCurrent();
      next.cache=data.cache;next.sourceSha256=data.attachment.catalog.source.sha256;
      experienceSessions.set(input.sessionId,next);data.attachment.experience=next;delete data.attachment.experienceCompletion;delete data.attachment.reconciledExperienceId;
      installRollback(data);
      return result(input.sessionId,data,{experienceTransition:{sourceChanged:false,sourceKey:sourceKey(nextStage),experienceRevision:next.revision,stepIndex:next.stepIndex,rollbackToken:token}});
    }
    if(!hooks.openVerifiedPdb) throw Error('This host cannot atomically open a verified experience source.');
    const releaseRetarget=authorizeSourceRetarget(input.sessionId);
    try {
      const opened=await hooks.openVerifiedPdb({sessionId:input.sessionId,pdbId:nextStage.source.pdbId,verify:async structureText=>{
        const verified=await preflightExperienceStage(nextStage,structureText);next.sourceSha256=verified.digest;
        const counts=await measureJourneyStage(nextStage,structureText);
        const budget=chapterBudget(experience,input.stepIndex,counts,budgetClass);
        if(budget.status==='refused')throw Error(budget.message);
        stillCurrent();
      }});
      experienceSessions.set(input.sessionId,next);
      const refreshed=await current(input.sessionId);
      refreshed.attachment.shared=prior.shared; refreshed.attachment.commands=prior.commands;
      installRollback(refreshed);
      if(lanOwner && lanOwner.sessionId===input.sessionId) lanOwner.sourceToken=refreshed.attachment.sourceToken;
      return result(input.sessionId,refreshed,{kind:'inspect',renderToken:opened.structuredContent.renderToken,hasStructure:true,
        experienceTransition:{sourceChanged:true,sourceKey:sourceKey(nextStage),experienceRevision:next.revision,stepIndex:next.stepIndex,rollbackToken:token}});
    } finally { releaseRetarget(); }
  });
  privateTool('stereo_structure.acknowledge_experience_step',{
    title:'Acknowledge a rendered experience step',
    description:'App-only acknowledgement after a panel hydrates the exact current experience source, applies the declared full step, and saves its scene. This is not a normal inspection-command receipt and never accepts a stale source token.',
    inputSchema:acknowledgeExperienceStepSchema,annotations:mutation,_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), bindingNow=binding(input.sessionId,data), active=data.attachment.experience;
    // Reconnection can leave only the page's player running. This receipt
    // follows a draw/save of the host's current view, without starting a new
    // journey or reusing its old completion token as proof of a new render.
    if(input.reconcileEnded) {
      if(active || input.completionToken || !experienceById(input.experienceId)
        || input.serverEpoch!==bindingNow.serverEpoch || input.sourceToken!==bindingNow.sourceToken
        || input.baseStateRevision!==bindingNow.stateRevision || input.baseInspectionRevision!==bindingNow.inspectionRevision
        || !data.attachment.commands.readyPanel(input.panelId,bindingNow)
        || !input.tourState || input.tourState.active || input.tourState.navigating || input.tourState.autoplay
        || input.tourState.step!==-1 || input.tourState.total!==0)
        throw Error('The ended journey must reconcile with the current rendered and saved view.');
      data.attachment.reconciledExperienceId=input.experienceId;
      delete data.attachment.experienceCompletion;
      delete data.attachment.experienceRollback;
      data.attachment.commands.reportTourState(input.panelId,input.tourState);
      return result(input.sessionId,data,{experienceAcknowledged:true,experienceReconciled:{status:'rendered'},panelId:input.panelId});
    }
    const ready=()=>input.tourCommand ? data.attachment.commands.tourTransitionReady(input.tourCommand,input.panelId,bindingNow) : data.attachment.commands.readyPanel(input.panelId,bindingNow);
    const confirm=()=>{
      const command=input.tourCommand && !data.attachment.commands.tourTransitionRestoring(input.tourCommand,bindingNow)
        ? data.attachment.commands.completeTourTransition(input.tourCommand,input.panelId,bindingNow) : undefined;
      if(input.tourState)data.attachment.commands.reportTourState(input.panelId,input.tourState);
      return command;
    };
    if(input.completionToken) {
      const completed=data.attachment.experienceCompletion;
      if(active || !completed || completed.token!==input.completionToken || completed.experienceId!==input.experienceId
        || completed.revision!==input.experienceRevision || completed.stepIndex!==input.stepIndex
        || input.serverEpoch!==bindingNow.serverEpoch || input.sourceToken!==bindingNow.sourceToken || input.baseStateRevision!==bindingNow.stateRevision
        || input.baseInspectionRevision!==bindingNow.inspectionRevision || completed.savedRevision!==data.attachment.revision
        || !ready())
        throw Error('The panel did not acknowledge the rendered and saved pre-tour view.');
      completed.status='rendered'; delete data.attachment.experienceRollback;
      return result(input.sessionId,data,{experienceAcknowledged:true,command:confirm(),experienceCompletion:completed,panelId:input.panelId});
    }
    if(!active || active.experience.id!==input.experienceId || active.revision!==input.experienceRevision || active.stepIndex!==input.stepIndex
      || input.serverEpoch!==bindingNow.serverEpoch || input.sourceToken!==bindingNow.sourceToken || input.baseStateRevision!==bindingNow.stateRevision
      || input.baseInspectionRevision!==bindingNow.inspectionRevision || !ready())
      throw Error('The panel did not acknowledge the current saved experience step.');
    delete data.attachment.experienceRollback;
    active.acknowledgements.set(input.panelId,{revision:active.revision,stepIndex:active.stepIndex,sourceToken:bindingNow.sourceToken});
    // This saved revision is a chapter the lesson drew
    // for itself, and a stop spoken before it is still about this scene.
    data.attachment.commands.recordTourRevision(input.panelId,bindingNow);
    return result(input.sessionId,data,{experienceAcknowledged:true,command:confirm(),panelId:input.panelId});
  });
  privateTool('stereo_structure.get_inspection',{
    title:'Hydrate inspection',description:'App-only coordinate and saved-scene hydration for one session. Coordinates are returned only in private metadata. Pass transport="chunked" to receive {sha256,bytes} descriptors for the coordinates and the compressed catalog instead of the bytes themselves, then read them through get_inspection_bytes.',
    inputSchema:getInspectionInputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:privateUi,
  },async({sessionId,transport:wire})=>{
    const data=await current(sessionId);
    notePanelHydration(sessionId);
    const chunked=wire==='chunked';
    const coordinates=chunked
      ? {sourceBytes:{sha256:chunkedSource(data.cache).sha256,bytes:chunkedSource(data.cache).bytes.byteLength}}
      : {structureText:data.cache.structureText};
    const catalogTransport=chunked?inspectionCatalogDescriptor(data.attachment.transport):data.attachment.transport;
    const sceneImport=data.attachment.sceneImport;
    if(sceneImport) assertInspectionBudget({sceneImport:{sceneJson:sceneImport.bundle.sceneJson,declaration:sceneImport.bundle.declaration,resolvedScene:sceneImport.resolvedScene}},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    if(data.attachment.customTour) assertInspectionBudget({customTour:data.attachment.customTour},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    const nativeHandoff=nativeStructureViewerHandoff({sourceSha256:data.attachment.catalog.source.sha256,pdbId:data.cache.pdbId,localFile:data.attachment.nativeLocalFile});
    return {...result(sessionId,data,{},nativeHandoff?SOURCE_ONLY_HANDOFF_DISCLOSURE:undefined),_meta:{[PRIVATE_INSPECTION_META_KEY]:{
      ...result(sessionId,data).structuredContent,...coordinates,format:'mmcif',pdbId:data.cache.pdbId,
      ...(nativeHandoff?{nativeStructureViewerHandoff:nativeHandoff,nativeStructureViewerHandoffDisclosure:SOURCE_ONLY_HANDOFF_DISCLOSURE}:{}),
      ...catalogTransport,scene:data.attachment.scene,comparisonSources:comparisonPayloads(data.attachment,data.attachment.scene),
      ...(data.attachment.experienceRollback?{journeyTransition:{panelId:data.attachment.experienceRollback.panelId,
        status:data.attachment.experienceRollback.expectedStateRevision===data.stateRevision
          && data.attachment.experienceRollback.expectedInspectionRevision===data.attachment.revision?'pending':'superseded'}}:{}),
      ...(data.attachment.sourceContinuation?{sourceReplacement:{panelId:data.attachment.sourceContinuation.panelId,
        previousSourceToken:data.attachment.sourceContinuation.previous.sourceToken}}:{}),
      namedViews:namedViewsPayload(data),
      ...(data.attachment.experience?{experience:{definition:data.attachment.experience.experience,revision:data.attachment.experience.revision,
        stepIndex:data.attachment.experience.stepIndex,stageId:data.attachment.experience.stage.id,sourceKey:sourceKey(data.attachment.experience.stage),applied:data.attachment.experience.acknowledgements.size>0}}:{}),
      experienceCatalog:await journeyCatalogFor(data),
      ...(sceneImport?{sceneImport:{sceneJson:sceneImport.bundle.sceneJson,declaration:sceneImport.bundle.declaration,provenanceStatus:sceneImport.bundle.provenanceStatus,...(sceneImport.resolvedScene?{resolvedScene:sceneImport.resolvedScene}:{})}}:{}),
      ...(data.attachment.customTour?{customTour:data.attachment.customTour}:{}),
    }}};
  });
  /**
   * The coordinates and the compressed catalog, in slices no
   * host has to be guessed about.
   *
   * The byte caps this replaces were invented to keep one `get_inspection`
   * result small, and the only documented ceiling anybody could point at is
   * Claude's: a tool result over about 150,000 characters goes to the code
   * sandbox instead of arriving inline, and app-initiated calls that fetch on
   * demand are the remedy the page names. So the panel fetches on demand, at
   * `MAX_INSPECTION_CHUNK_BYTES` a call, and structure size stops being a
   * transport question.
   *
   * Every chunk carries the digest of the WHOLE part. A source swap between
   * two calls therefore fails the panel's descriptor check rather than
   * assembling half of one structure onto half of another.
   */
  function inspectionPart(data:Awaited<ReturnType<typeof current>>, part:'source'|'catalog',
    comparison?:{sourceSha256:string;assemblyId:string}) {
    if(comparison) {
      // A comparison structure is held per session by its source digest and
      // assembly, the same key `validateComparisonScene` checks a saved scene
      // against. One that was pruned or never verified here is not served.
      const asset=data.attachment.comparisonAssets?.get(`${comparison.sourceSha256}:${comparison.assemblyId}`);
      if(!asset) throw Error('That comparison structure is not held by this session. Read the current comparison descriptors and start again.');
      return part==='source' ? chunkedText(asset,asset.cif) : chunkedCatalog(asset);
    }
    return part==='source' ? chunkedSource(data.cache) : chunkedCatalog(data.attachment.transport);
  }
  privateTool('stereo_structure.get_inspection_bytes',{
    title:'Read one chunk of the inspection bytes',
    description:`App-only chunked read of one session's coordinates (part="source") or compressed structure-and-sequence catalog (part="catalog"). The slice comes back base64-encoded in private metadata, at most ${MAX_INSPECTION_CHUNK_BYTES.toLocaleString('en-US')} bytes a call, beside totalBytes, the sha256 of the whole part, and hasMore. Read the descriptors from get_inspection with transport="chunked" first. Pass comparison {sourceSha256, assemblyId} to read a comparison structure's part, using the descriptors that structure arrived with.`,
    inputSchema:inspectionBytesInputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId);
    const {bytes:whole,sha256}=inspectionPart(data,input.part,input.comparison);
    if(input.offset>whole.byteLength)
      throw Error('That offset is past the end of this inspection part. Read its current descriptor and start again.');
    const slice=whole.subarray(input.offset,Math.min(whole.byteLength,input.offset+input.byteCount));
    const payload={part:input.part,offset:input.offset,byteCount:slice.byteLength,totalBytes:whole.byteLength,
      sha256,hasMore:input.offset+slice.byteLength<whole.byteLength,...(input.comparison?{comparison:input.comparison}:{})};
    return {structuredContent:payload,_meta:{[PRIVATE_INSPECTION_META_KEY]:{...payload,data:slice.toString('base64')}}};
  });
  privateTool('stereo_structure.resolve_scene_import',{
    title:'Resolve a local Structure Viewer scene snapshot',
    description:'App-only verification step for stereo_structure.inspect_scene. The browser supplies the actual loaded model, assembly, camera baseline, molecular boundary and source atom-id map. The server performs the cryptographic and lossless scene-subset checks, then returns the candidate scene for rendering. Declared-local provenance remains unauthenticated.',
    inputSchema:inspectionBindingSchema.extend({target:structureViewerImportTargetSchema}),annotations:mutation,_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), a=data.attachment, b=binding(input.sessionId,data);
    if(input.serverEpoch!==b.serverEpoch || input.sourceToken!==b.sourceToken || input.baseStateRevision!==b.stateRevision || input.baseInspectionRevision!==a.revision)
      return result(input.sessionId,data,{conflict:true});
    const pending=a.sceneImport;
    if(!pending) throw Error('No local Structure Viewer scene import is pending for this session.');
    if(pending.resolvedScene) return result(input.sessionId,data,{scene:pending.resolvedScene,imported:true,provenanceStatus:'declared-local',preflight:pending.preflight},pending.preflight?.message);
    const target={...input.target,catalogRows:a.catalog.rows};
    const preflight=preflightInspectionScene(pending.bundle.sceneJson,{coordinate:pending.bundle.coordinate,target});
    if(!preflight.supported) return result(input.sessionId,data,{imported:false,preflight},preflight.message);
    const imported=importStructureViewerScene({sceneJson:pending.bundle.sceneJson,coordinate:pending.bundle.coordinate,target});
    // The browser supplies the loaded atom map, but the server remains the
    // authority for canonical catalog membership and duplicate selection keys.
    validateScene(imported.scene,a.catalog,a.density);
    pending.resolvedScene=imported.scene;
    pending.preflight=preflight;
    return result(input.sessionId,data,{scene:imported.scene,imported:true,provenanceStatus:'declared-local',preflight},preflight.message);
  });
  privateTool('stereo_structure.sync_inspection',{
    title:'Save current inspection',description:'App-only optimistic full snapshot save after rendering. A stale panel receives conflict=true; its scene is not committed. This is not a distributed render lease or Quest transport.',
    inputSchema:syncInspectionSchema,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:privateUi,
  },async input=>{
    const data=await current(input.sessionId), a=data.attachment;
    // Recheck at the actual synchronous commit boundary. Other calls can run
    // between current() resolving and this continuation resuming.
    const latest=hooks.current(input.sessionId);
    data.stateRevision=latest.stateRevision;
    if(latest.structureCache!==data.cache) return result(input.sessionId,data,{conflict:true});
    const tourBinding=binding(input.sessionId,data);
    if(input.tourCommand)a.commands.assertTourTransition(input.tourCommand,tourBinding);
    const undo=a.experienceRollback;
    if(input.journeySave && (!undo || undo.token!==input.journeySave.rollbackToken || undo.panelId!==input.journeySave.panelId
      || undo.expectedStateRevision!==tourBinding.stateRevision || undo.expectedInspectionRevision!==tourBinding.inspectionRevision
      || (input.tourCommand ? undo.panelId!==input.tourCommand.panelId : a.commands.hasPending(tourBinding))))
      throw Error('This save does not belong to the current journey transition.');
    if(input.serverEpoch===hooks.serverEpoch && input.sourceToken===a.sourceToken && input.baseStateRevision===data.stateRevision
      && input.baseInspectionRevision<=a.revision && JSON.stringify(input.scene)===JSON.stringify(a.scene)) {
      if(a.experienceCompletion?.status==='pending') a.experienceCompletion.savedRevision=a.revision;
      return result(input.sessionId,data,{saved:true});
    }
    if(input.serverEpoch!==hooks.serverEpoch || input.sourceToken!==a.sourceToken || input.baseStateRevision!==data.stateRevision || input.baseInspectionRevision!==a.revision)
      return result(input.sessionId,data,{conflict:true});
    // Shared sessions reserve this revision while one renderer owns a command.
    // A competing manual edit remains visible and retries after that receipt.
    if(a.shared && !input.tourCommand && a.commands.hasPending(binding(input.sessionId,data))) return result(input.sessionId,data,{busy:true});
    const scene=validateScene(input.scene,a.catalog,a.density);
    validateComparisonScene(a,scene); savedLessonPlayback(scene,toursFor(a));
    assertInspectionBudget({scene,comparisonSources:comparisonPayloads(a,scene)},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
    if(JSON.stringify(scene)!==JSON.stringify(a.scene)) {
      if(a.revision===Number.MAX_SAFE_INTEGER) throw Error('Inspection revision exhausted; open a new session.');
      // An edit the person made by hand in a panel is an
      // operation too, and "undo that" has to be able to take it back. Only a
      // save that actually moved one of the four undoable fields counts: a
      // panel writes a scene every time the wearer looks around, and a history
      // of those would answer "undo that" by moving the camera.
      // A save carries no panel id, so the surface is not knowable here; the
      // origin is, and `manual` is what tells an assistant's change apart from
      // the wearer's own.
      if(a.scene) a.history.record({origin:'manual',surface:'unknown',label:'manual',before:a.scene,after:scene});
      a.scene=scene; a.revision++;
      if(a.sceneImport?.resolvedScene && sceneImportMatchesSavedScene(scene,a.sceneImport.resolvedScene)) a.sceneImport=undefined;
    }
    if(input.tourCommand) {
      a.commands.advanceTourTransition(input.tourCommand,tourBinding,binding(input.sessionId,data));
    }
    // Agent and menu navigation both prove ownership of this journey's save.
    // An unrelated save or a newer request still invalidates the boundary.
    const journeyPanel=input.journeySave?.panelId ?? input.tourCommand?.panelId;
    if(undo && journeyPanel===undo.panelId && undo.expectedStateRevision===tourBinding.stateRevision
      && undo.expectedInspectionRevision===tourBinding.inspectionRevision)
      undo.expectedInspectionRevision=a.revision;
    if(a.experienceCompletion?.status==='pending') a.experienceCompletion.savedRevision=a.revision;
    return result(input.sessionId,data,{saved:true});
  });
  /**
   * What the legacy source-bearing tools in `server.ts` need from
   * here. They own the fetch and the session commit; only this file can keep the
   * share across it, so the transition is lent back to them rather than
   * duplicated there.
   */
  return {isSharedSession,loadSharedSource};
}
